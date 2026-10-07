// Runtime wire protocol between AgentRuntime (parent) and the runtime child extension.
// Ported from pi-issue-round's transport protocol (same author, MIT) and made role-agnostic.
import {
  mkdir,
  open,
  readFile,
  rename,
  link,
  unlink,
  lstat,
  realpath,
} from "node:fs/promises";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { randomUUID, createHash } from "node:crypto";

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
export type Labels = Record<string, string | number>;
export type BashPolicy = "unrestricted" | "readonly";
export type Placement = "split-right" | "split-down" | "tab" | "worktree";

export interface DelegatedToolSpec {
  name: string;
  label?: string;
  description: string;
  /** JSON Schema of the tool arguments. */
  parameters: object;
  /** Deterministic requestId `${taskToken}-${name}`: at most one request per task. */
  once?: "per-task";
  /** Child-side wait for the parent response (default 300000 ms); afterwards the outcome is uncertain. */
  timeoutMs?: number;
}

export interface Identity {
  scope: string;
  agentId: string;
  attempt: number;
  nonce: string;
  sessionId: string;
  paneId: string;
}
export interface TaskIdentity extends Identity {
  taskId: string;
  taskToken: string;
}
export interface AgentHandle extends TaskIdentity {
  labels?: Labels;
  cwd: string;
  protocolDir: string;
  sessionPath: string;
  pid: number;
  processIdentity: string;
  terminalId: string;
  tabId: string;
  workspaceId: string;
  shellPid: number;
  shellProcessIdentity?: string;
  tty: string;
  /** Split placement only: the caller pane beside the child (display/focus, not identity). */
  parentPaneId?: string;
  placement?: "split-right" | "split-down";
}
/** "takeover": typed input/user bash/model changes block automatic control (workflow agents).
 * "allowed": the user may drive the child in its pane (interactive generic subagents). */
export type UserInputPolicy = "takeover" | "allowed";
/** "parent": the child never exits by itself (stop/close by the parent).
 * "auto": it exits after a normal (not aborted) settled run, and has `subagent_done`/`caller_ping`.
 * "tool": it exits only through `subagent_done`/`caller_ping` (or the user quitting). */
export type ExitPolicy = "parent" | "auto" | "tool";
export const EXIT_TOOLS: readonly string[] = ["subagent_done", "caller_ping"];
/** Child policy, written by the parent before launch and read by the child extension. */
export interface ChildPolicy {
  /** Allowlist; null = no allowlist (profile children keep their normal tools). */
  tools: string[] | null;
  /** Tools deactivated and blocked even when present in the profile. */
  denyTools: string[];
  bash: BashPolicy;
  question: boolean;
  delegatedTools: DelegatedToolSpec[];
  userInput: UserInputPolicy;
  exit: ExitPolicy;
}
/** Fill the defaults of fields added after 0.2.0, so older boot records keep their meaning. */
export function normalizePolicy(raw: unknown): ChildPolicy | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const p = raw as Partial<ChildPolicy>;
  return {
    tools: p.tools === null ? null : (p.tools as string[]),
    denyTools: p.denyTools ?? [],
    bash: p.bash as BashPolicy,
    question: p.question as boolean,
    delegatedTools: p.delegatedTools as DelegatedToolSpec[],
    userInput: p.userInput ?? "takeover",
    exit: p.exit ?? "parent",
  };
}
export interface DisplaySpec {
  label: string;
  group?: string;
  agentsPanelName?: string;
}
export type Isolation = "isolated" | "profile";
export interface Boot extends Identity {
  labels?: Labels;
  cwd: string;
  protocolDir: string;
  model: string;
  effort: string;
  policy: ChildPolicy;
  isolation?: Isolation;
  /** Exact session file the child must open (seeded or resumed session); absent = new session in sessions/. */
  sessionFile?: string;
  /** Display only (widget rows rebuilt after a cold restart of the parent). */
  display?: DisplaySpec;
  launchedAt?: number;
}
export interface TaskCommand extends TaskIdentity {
  kind: "task";
  prompt: string;
  /** Skills sent as `/skill:<name>` messages before the prompt, in the same run. */
  skills?: string[];
  previousToken: string | null;
}
export interface ChildRecord extends TaskIdentity {
  version: 1;
  recordId: string;
  kind:
    | "accepted"
    | "settled"
    | "request"
    | "response"
    | "shutdown-request"
    | "shutdown-ack"
    | "takeover"
    | "interrupt-request"
    | "interrupt-ack"
    /** The child is waiting for a human answer in its own pane. */
    | "question"
    | "answer"
    /** The child ended itself (exit policy auto/tool): done, help request (ping) or failed run. */
    | "exit";
  at: string;
  reason?: "done" | "ping" | "error";
  message?: string;
  status?: "success" | "error" | "interrupted";
  summary?: string;
  error?: string;
  requestId?: string;
  tool?: string;
  params?: unknown;
  result?: unknown;
  questionId?: string;
  question?: string;
  answer?: string;
}
export interface Ready extends Identity {
  pid: number;
  sessionPath: string;
  cwd: string;
}
export const identityKeys = [
  "scope",
  "agentId",
  "attempt",
  "nonce",
  "sessionId",
  "paneId",
] as const;
export function sameAgent(a: Identity, b: Identity): boolean {
  return identityKeys.every((k) => a[k] === b[k]);
}
export function sameTask(a: TaskIdentity, b: TaskIdentity): boolean {
  return (
    sameAgent(a, b) && a.taskId === b.taskId && a.taskToken === b.taskToken
  );
}
/** Labels are part of the owned identity: a handle with other labels is not this agent. */
export function sameLabels(a: Labels | undefined, b: Labels | undefined): boolean {
  const canonical = (labels: Labels | undefined) =>
    JSON.stringify(Object.entries(labels ?? {}).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  return canonical(a) === canonical(b);
}
export function taskKey(taskId: string): string {
  return createHash("sha256").update(taskId).digest("hex");
}
export function taskFile(dir: string, taskId: string, kind: string): string {
  return join(dir, `${taskKey(taskId)}.${kind}.json`);
}
export function requestFile(
  dir: string,
  requestId: string,
  kind: "request" | "response",
): string {
  return join(dir, `${taskKey(requestId)}.${kind}.json`);
}
/** Deterministic request id of a `once: "per-task"` delegated tool. */
export function onceRequestId(taskToken: string, tool: string): string {
  return `${taskToken}-${tool}`;
}
export const questionFile = "question.json";
export async function json<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
/** Atomic publication, 0600 records. Immutable evidence uses exclusive link, never overwrite. */
export async function publish(
  path: string,
  data: unknown,
  exclusive = true,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = await open(temp, "wx", 0o600);
  try {
    await fd.writeFile(JSON.stringify(data));
    await fd.sync();
  } finally {
    await fd.close();
  }
  try {
    if (exclusive) await link(temp, path);
    else await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export function record(
  task: TaskIdentity,
  kind: ChildRecord["kind"],
  extra: Partial<ChildRecord> = {},
): ChildRecord {
  const identity: TaskIdentity = {
    scope: task.scope,
    agentId: task.agentId,
    attempt: task.attempt,
    nonce: task.nonce,
    sessionId: task.sessionId,
    paneId: task.paneId,
    taskId: task.taskId,
    taskToken: task.taskToken,
  };
  return {
    ...identity,
    version: 1,
    recordId: randomUUID(),
    kind,
    at: new Date().toISOString(),
    ...extra,
  };
}
export function within(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..`) && !isAbsolute(rel));
}
export async function privateDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    throw new Error(
      `Protocol directory must be a private, owned directory: ${path}`,
    );
  return realpath(path);
}
export function validTask(
  record: ChildRecord | undefined,
  task: TaskIdentity,
  kind: ChildRecord["kind"],
): record is ChildRecord {
  return (
    !!record &&
    record.version === 1 &&
    typeof record.recordId === "string" &&
    !!record.recordId &&
    record.kind === kind &&
    sameTask(record, task)
  );
}
/** pi built-in tools: a delegated tool may never shadow one of them. */
export const BUILTIN_TOOLS: readonly string[] = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
];
/** Validate a child policy received from a launch spec or a boot record. */
const TOOL_NAME = /^[A-Za-z0-9_-]+$/;
export function validPolicy(policy: ChildPolicy | undefined): policy is ChildPolicy {
  if (
    !policy ||
    (policy.tools !== null && !Array.isArray(policy.tools)) ||
    !Array.isArray(policy.delegatedTools) ||
    !Array.isArray(policy.denyTools)
  )
    return false;
  const tools = policy.tools ?? [];
  const delegated = policy.delegatedTools.map((d) => d?.name);
  // Exit tools exist only through the exit policy; `question` in `tools` means a profile's own
  // question tool and is ambiguous when the runtime provides one (policy flag).
  const reserved = ["question", ...EXIT_TOOLS];
  return (
    tools.every((t) => typeof t === "string" && TOOL_NAME.test(t)) &&
    policy.denyTools.every((t) => typeof t === "string" && TOOL_NAME.test(t)) &&
    !tools.some((t) => EXIT_TOOLS.includes(t)) &&
    !(policy.question === true && tools.includes("question")) &&
    new Set(delegated).size === delegated.length &&
    delegated.every(
      (name) =>
        !reserved.includes(name) &&
        !BUILTIN_TOOLS.includes(name) &&
        !tools.includes(name),
    ) &&
    (policy.userInput === "takeover" || policy.userInput === "allowed") &&
    (policy.exit === "parent" || policy.exit === "auto" || policy.exit === "tool") &&
    (policy.bash === "unrestricted" || policy.bash === "readonly") &&
    typeof policy.question === "boolean" &&
    Array.isArray(policy.delegatedTools) &&
    policy.delegatedTools.every(
      (d) =>
        !!d &&
        typeof d.name === "string" &&
        /^[A-Za-z0-9_-]+$/.test(d.name) &&
        typeof d.description === "string" &&
        !!d.parameters &&
        typeof d.parameters === "object" &&
        !Array.isArray(d.parameters) &&
        (d.once === undefined || d.once === "per-task") &&
        (d.timeoutMs === undefined ||
          (Number.isSafeInteger(d.timeoutMs) && d.timeoutMs > 0)),
    )
  );
}
/** Tools the runtime itself adds: declared delegated tools, `question`, exit tools. */
export function policyTools(policy: ChildPolicy): string[] {
  return [
    ...policy.delegatedTools.map((d) => d.name),
    ...(policy.question ? ["question"] : []),
    ...(policy.exit === "parent" ? [] : EXIT_TOOLS),
  ];
}
/** Allowlisted tools the child may activate, or null when there is no allowlist. */
export function activeTools(policy: ChildPolicy): string[] | null {
  if (policy.tools === null) return null;
  const tools = new Set([...policy.tools, ...policyTools(policy)]);
  for (const denied of policy.denyTools) tools.delete(denied);
  return [...tools];
}
/** Whether a tool call is allowed by the policy (bash content is checked separately). */
export function toolAllowed(policy: ChildPolicy, tool: string): boolean {
  if (policy.denyTools.includes(tool)) return false;
  const active = activeTools(policy);
  if (active) return active.includes(tool);
  // No allowlist: profile tools (including a profile's own `question`) are allowed; the exit tools
  // exist only through the exit policy.
  return !EXIT_TOOLS.includes(tool) || policyTools(policy).includes(tool);
}
