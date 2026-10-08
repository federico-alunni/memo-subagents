import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { dirname, join } from "node:path";
import {
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  isTerminalAvailable,
  terminalSetupHint,
  interruptPane,
  inspectPane,
  setPaneTask,
} from "./terminal.ts";
import type { CompletionResult } from "./completion.ts";
import { paneSelector } from "./pane-selector.ts";
import { randomBytes, randomUUID } from "node:crypto";
import {
  buildAuthenticatedModelCatalog,
  resolveRuntimePlan,
  wrapPiModelRegistry,
  THINKING_LEVELS,
  type ResolvedRuntimePlan,
  type ThinkingLevel,
} from "./runtime-routing.ts";
import { loadModelConfig, resolveModelDefault, type ModelConfig } from "./model-config.ts";
import {
  createWorktree,
  findWorktreeRecordBySession,
  formatWorktreeLine,
  getWorktreeState,
  loadWorktreeConfig,
  markWorktreeRecordRemoved,
  planWorktree,
  readWorktreeRecords,
  removeWorktree,
  repoToplevel,
  rollbackWorktree,
  samePath,
  worktreeRegistryDir,
  writeWorktreeRecord,
  type WorktreeInfo,
  type WorktreePlan,
  type WorktreeRecord,
  type WorktreeState,
} from "./worktree.ts";

import {
  findLastAssistantMessage,
  findObservedSessionRuntime,
  getNewEntries,
  seedSubagentSessionFile,
} from "./session.ts";
import {
  type SubagentStatusState,
  capStatusLines,
  formatElapsedDuration,
  formatStatusAggregate,
  normalizeStatusName,
  loadStatusConfig,
} from "./status.ts";
import {
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";
import {
  createLifecycle,
  formatLifecycleTransitionLine,
  lifecycleTransition,
  transitionBaseline,
  markCompleted,
  markCompletionDetected,
  markDelivery,
  markFailed,
  markInterruptRequested,
  markProcessRunning,
  observeActivity,
  observePaneInspection,
  projectLifecycle,
  type LifecycleProjection,
  type SubagentLifecycle,
} from "./lifecycle.ts";
import {
  presence,
  presenceActive,
  type PresenceEntry,
} from "./runtime/presence.ts";
import { RuntimeError } from "./runtime/index.ts";
import { validBashAllowEntry } from "./runtime/protocol.ts";
import type { AgentHandle, LaunchSpec, Observation } from "./runtime/index.ts";
import {
  subagentRuntime,
  superviseSubagent,
  type SupervisedOutcome,
} from "./runtime-client.ts";


// Survive /reload: replace presentation timers while keeping active completion
// watchers and their registry alive. Old module closures continue watching the
// children; the reloaded module adopts the shared registry for status/interrupts.
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const RUNTIME_KEY = Symbol.for("pi-subagents/runtime");
// Unsubscribe of the widget's presence listener, replaced on /reload.
const PRESENCE_WIDGET_KEY = Symbol.for("pi-memo-subagents/presence-widget-unsubscribe");

{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
}

function buildSubagentRoutingGuidelines(
  modelCatalog?: string,
  agentCatalog?: string,
): string[] {
  return [
    "Choose the named agent whose description most closely matches the task; do not use one agent as a generic default.",
    "thinking is required unless the named agent declares a thinking default in its frontmatter (shown in the catalog below). Thinking is never inherited from your own level: decide it for each spawn.",
    "Choose thinking by the task's difficulty: minimal/low for bounded mechanical work, medium for ordinary implementation or review, and high+ for architecture, concurrency, security, or hard diagnosis.",
    "Omit model to use the named agent's model default (otherwise your model). Passing model or thinking explicitly overrides agent frontmatter for this spawn; prefer changing thinking before changing models.",
    "When overriding a subagent model, use an exact authenticated provider/model-id from the live catalog below. Do not invent aliases or fuzzy names.",
    agentCatalog ?? "Available named subagent catalog becomes available after session start.",
    modelCatalog ?? "Authenticated subagent model catalog becomes available after session start.",
  ];
}

const subagentRoutingGuidelines = buildSubagentRoutingGuidelines();

const ThinkingLevelSchema = Type.Union(
  THINKING_LEVELS.map((level) => Type.Literal(level)),
  {
    description:
      "Pi thinking level. Required unless the named agent declares a thinking default in its frontmatter; never inherited from the caller. Passing a value explicitly overrides agent frontmatter for this spawn.",
  },
);

const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(
    Type.String({
      description:
        "Agent name to load defaults from the available named subagent catalog. Agent frontmatter can provide model, thinking, tools, skills, and role instructions.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Appended to system prompt (role instructions)" }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Exact authenticated provider/model-id. Omit to use a named agent's model default, then the configured or parent model. Passing a value explicitly overrides agent frontmatter for this spawn.",
    }),
  ),
  thinking: Type.Optional(ThinkingLevelSchema),
  skills: Type.Optional(
    Type.String({ description: "Comma-separated skills (overrides agent default)" }),
  ),
  tools: Type.Optional(
    Type.String({ description: "Comma-separated tools (overrides agent default)" }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
  fork: Type.Optional(
    Type.Boolean({
      description:
        "Force the full-context fork mode for this spawn. The sub-agent inherits the current session conversation, overriding any agent frontmatter session-mode.",
    }),
  ),
  interactive: Type.Optional(
    Type.Boolean({
      description:
        "Mark the subagent as interactive (long-running, user drives the conversation in its own pane). When true, the main session is not woken by status transitions (stalled/recovered) for this subagent. If omitted, falls back to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit` (agents that auto-exit are autonomous and get stall pings; agents that don't are interactive and stay quiet).",
    }),
  ),
  worktree: Type.Optional(
    Type.Boolean({
      description:
        "Run the sub-agent in a fresh, isolated git worktree on a new branch, created from the repository of its working directory. The worktree is kept after completion; its path, branch and commit state are reported in the result. Nothing is merged automatically. Clean up with subagent_worktrees.",
    }),
  ),
  worktreeBranch: Type.Optional(
    Type.String({
      description:
        "Name of the NEW branch for the worktree (requires worktree: true). Must not exist yet. Default: memo/<name>-<id>.",
    }),
  ),
  worktreeBase: Type.Optional(
    Type.String({
      description:
        "Commit-ish the worktree starts from (requires worktree: true). Default: HEAD of the source checkout, resolved to a commit at spawn time.",
    }),
  ),
});

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  denyTools?: string;
  /**
   * Raw `bash` value, validated at launch (`resolveAgentBash`): `full` (default), `readonly` (one plain
   * read-only command per call) or `none` (bash denied).
   */
  bash?: string;
  /** Raw `bash-allow`: comma-separated extra command prefixes on top of `readonly` (e.g. `npm test`). */
  bashAllow?: string;
  spawning?: boolean;
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  /** Parsed only to reject non-pi definitions (pi-memo-subagents launches only pi). */
  cli?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

type AgentSource = "package" | "global" | "project";

interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

/** Tools that are gated by `spawning: false` */
const SPAWNING_TOOLS = new Set([
  "subagent",
  "subagent_interrupt",
  "subagents_list",
  "subagent_resume",
  "subagent_worktrees",
]);

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;

  // spawning: false → deny all spawning tools
  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }

  // bash: none → bash is a denied tool
  if (agentDefs.bash?.trim().toLowerCase() === "none") denied.add("bash");

  // deny-tools: explicit list
  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      denied.add(t);
    }
  }

  return denied;
}

type AgentBashMode = "full" | "readonly" | "none";

/**
 * Bash policy of an agent definition. `bash-allow` without `bash` implies `readonly`; unknown values,
 * `bash-allow` with `full`/`none` and non-plain entries are errors (raised before any worktree or pane).
 */
function resolveAgentBash(agentDefs: AgentDefaults | null): { mode: AgentBashMode; allow: string[] } {
  const raw = agentDefs?.bash?.trim().toLowerCase();
  const isMode = (value: string): value is AgentBashMode =>
    value === "full" || value === "readonly" || value === "none";
  if (raw !== undefined && !isMode(raw))
    throw new Error(
      `Unsupported \`bash: ${agentDefs?.bash}\` in the agent definition: use full (default), readonly or none.`,
    );
  const allow = splitList(agentDefs?.bashAllow).map((entry) => entry.split(/[ \t]+/).join(" "));
  if (agentDefs?.bashAllow !== undefined && allow.length === 0)
    throw new Error("`bash-allow` in the agent definition lists no command.");
  const mode: AgentBashMode = raw !== undefined && isMode(raw) ? raw : allow.length > 0 ? "readonly" : "full";
  if (allow.length > 0 && mode !== "readonly")
    throw new Error(
      `\`bash-allow\` adds commands on top of \`bash: readonly\` and cannot be used with \`bash: ${mode}\`.`,
    );
  const invalid = allow.filter((entry) => !validBashAllowEntry(entry));
  if (invalid.length > 0)
    throw new Error(
      `Invalid \`bash-allow\` entries (plain words only, no pipes, redirections, quotes, globs, $ or #): ${invalid.join(", ")}`,
    );
  return { mode, allow };
}

/** Only pi agents are offered to the model; a definition with another `cli` would be rejected at spawn. */
function isPiAgent(agent: AgentDefaults): boolean {
  const cli = agent.cli?.trim().toLowerCase();
  return !cli || cli === "pi";
}

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!match) return undefined;
  const value = match[1].trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    denyTools: getFrontmatterValue(frontmatter, "deny-tools"),
    bash: getFrontmatterValue(frontmatter, "bash"),
    bashAllow: getFrontmatterValue(frontmatter, "bash-allow"),
    spawning: parseOptionalBoolean(getFrontmatterValue(frontmatter, "spawning")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

function discoverAgentDefinitions(): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
    { path: join(process.cwd(), ".pi", "agents"), source: "project" },
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      try {
        const parsed = parseAgentDefinition(
          readFileSync(join(dir, file), "utf8"),
          file.replace(/\.md$/, ""),
        );
        if (!parsed) continue;
        agents.set(parsed.name, { ...parsed, source });
      } catch {
        // Skip unreadable or racy entries rather than aborting discovery
        // for every other agent definition.
      }
    }
  }

  return [...agents.values()];
}

function buildAvailableAgentCatalog(
  agents: ListedAgentDefinition[],
  limit = 24,
  config: ModelConfig = modelConfig,
): string {
  const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name));
  const visible = sorted.slice(0, limit);
  const lines = [
    "Available named subagents (choose by role; omit model/thinking to use agent defaults; agents without a thinking default require thinking):",
  ];

  for (const agent of visible) {
    const effectiveModel = resolveModelDefault(agent.name, agent.model, config);
    const defaults = [
      effectiveModel ? `model ${effectiveModel}` : undefined,
      agent.thinking ? `thinking ${agent.thinking}` : undefined,
    ].filter(Boolean);
    const runtime = defaults.length > 0 ? `; defaults: ${defaults.join(", ")}` : "";
    const description = agent.description ? ` — ${agent.description}` : "";
    lines.push(`- ${agent.name} [${agent.source}${runtime}]${description}`);
  }

  if (visible.length === 0) lines.push("- none discovered; use a bare spawn");
  if (sorted.length > visible.length) {
    lines.push(`- … ${sorted.length - visible.length} more named subagents omitted`);
  }

  return lines.join("\n");
}

function resolveSubagentPaths(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd
    ? rawCwd.startsWith("/")
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null;
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

function resolveEffectiveSessionMode(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  if (params.fork) return "fork";
  return agentDefs?.sessionMode ?? "standalone";
}

function resolveLaunchBehavior(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` tool parameter wins.
 *   2. Explicit `interactive` frontmatter field on the agent.
 *   3. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, worker, reviewer) and the parent session should be
 *      woken on stall/recovery transitions. Agents that don't auto-exit are
 *      driven by the user in their own pane (planner, iterate/fork) and
 *      stall pings are noise.
 *
 * When no agent defs exist at all (bare `subagent({ name, task })` call,
 * typical for `/iterate` with `fork: true`), `autoExit` is undefined and the
 * subagent is treated as interactive — matching the intent of iterate.
 */
function resolveEffectiveAutoExit(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  // Named agents preserve their declared behavior. Bare tool calls are
  // autonomous by default, including full-context forks: `fork` controls
  // context inheritance, not whether the child should remain open. Interactive
  // flows such as /iterate opt out explicitly with `interactive: true`.
  if (agentDefs) return agentDefs.autoExit ?? false;
  return params.interactive !== true;
}

function resolveEffectiveInteractive(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  if (params.interactive != null) return params.interactive;
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !resolveEffectiveAutoExit(params, agentDefs);
}

function loadAgentDefaults(agentName: string): AgentDefaults | null {
  // Resolve through the same name-keyed map discoverAgentDefinitions() builds
  // for the tool-guidance catalog, so a name advertised there always resolves
  // to the same definition here — even when an agent's frontmatter `name`
  // differs from its filename.
  return discoverAgentDefinitions().find((agent) => agent.name === agentName) ?? null;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require herdr. ${terminalSetupHint()}`,
      },
    ],
    details: { error: "herdr not available" },
  };
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

const statusConfig = loadStatusConfig();
const modelConfig = loadModelConfig();

function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "errorMessage"
  >,
  name: string,
): string {
  const sessionRef = result.sessionFile
    ? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
    : "";

  if (result.errorMessage) {
    // Auto-retry exhausted or other agent-loop error. The subagent did not
    // produce a usable result — surface the underlying provider/network
    // failure so the orchestrator can decide whether to retry, resume, or
    // change approach instead of silently treating the run as completed.
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. You can retry by spawning a new ` +
      `subagent or resume the session with subagent_resume.${sessionRef}`
    );
  }

  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;
}

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
  /** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
  errorMessage?: string;
  ping?: { name: string; message: string };
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  /** Agent runtime handle (replaced when the pane selector moves the pane). */
  handle?: AgentHandle;
  startTime: number;
  sessionFile: string;
  /** Session entries that existed before a resume: the summary only uses newer ones. */
  entryCountBefore?: number;
  launchScriptFile?: string;
  activityFile?: string;
  activity?: SubagentActivityState;
  activityRead?: {
    ok: boolean;
    reason?: "missing" | "invalid" | "wrong-id";
    error?: string;
  };
  abortController?: AbortController;
  /**
   * Optional legacy status snapshot retained only for hydrating pre-lifecycle
   * runtime entries after /reload. Live observation uses `lifecycle` only.
   */
  statusState?: SubagentStatusState;
  lifecycle: SubagentLifecycle;
  /** Last projected kind used to detect stalled/recovered transitions. */
  lastProjectedKind?: LifecycleProjection["kind"];
  /**
   * When true, status transitions (stalled/recovered) do not wake the parent
   * session via a steer message. The widget still updates locally. Used for
   * long-running agents where the user drives the conversation in the
   * subagent's pane (e.g. planner).
   */
  interactive: boolean;
  /** Parent-resolved model/thinking selection and provenance. */
  runtimePlan: ResolvedRuntimePlan | undefined;
  /** Set when the child runs in a pi-memo-subagents git worktree. */
  worktree?: WorktreeInfo;
}

interface SubagentRuntime {
  runningSubagents: Map<string, RunningSubagent>;
  pi?: ExtensionAPI;
  latestCtx?: ExtensionContext;
  modelCatalog?: string;
  agentCatalog?: string;
}

function createSubagentRuntime(): SubagentRuntime {
  return { runningSubagents: new Map<string, RunningSubagent>() };
}

/** Runtime state preserved across /reload. */
const runtime: SubagentRuntime =
  (globalThis as any)[RUNTIME_KEY] ??
  ((globalThis as any)[RUNTIME_KEY] = createSubagentRuntime());
const runningSubagents = runtime.runningSubagents;

export function shouldPreserveSubagentsOnShutdown(reason: unknown): boolean {
  return reason === "reload";
}

export function cleanupSubagentsForShutdown(
  reason: unknown,
  agents: Map<string, Pick<RunningSubagent, "abortController" | "lifecycle">>,
): void {
  if (shouldPreserveSubagentsOnShutdown(reason)) return;

  for (const agent of agents.values()) {
    if (agent.lifecycle) {
      agent.lifecycle = markDelivery(agent.lifecycle, "suppressed");
    }
    agent.abortController?.abort();
  }
  agents.clear();
}

export function shouldDeliverSubagentCompletion(
  running: Pick<RunningSubagent, "lifecycle">,
): boolean {
  // Authoritative gate: only pending deliveries may be sent.
  // Missing lifecycle (pre-migration fixtures) defaults to pending/true.
  return (running.lifecycle?.delivery ?? "pending") === "pending";
}

export function selectCompletionApi<T>(previous: T, current: T | undefined): T {
  return current ?? previous;
}

// ── Widget management ──

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number, endTime = Date.now()): string {
  const seconds = Math.floor((endTime - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACTIVE_ACCENT = "\x1b[38;2;77;163;255m";
const OPEN_ACCENT = "\x1b[38;2;214;158;46m";
/** A box with at least one agent waiting for the user (question, bash approval, Herdr blocked). */
const ATTENTION_ACCENT = "\x1b[38;2;214;92;214m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(left: string, right: string, width: number, accent = ACTIVE_ACCENT): string {
  if (width <= 0) return "";
  if (width === 1) return `${accent}│${RST}`;

  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);

  // If the status chunk alone is too wide, prefer preserving it in compact form
  // rather than overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${accent}│${RST}${truncRight}${" ".repeat(rightPad)}${accent}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${accent}│${RST}${truncLeft}${" ".repeat(pad)}${right}${accent}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(title: string, info: string, width: number, accent = ACTIVE_ACCENT): string {
  if (width <= 0) return "";
  if (width === 1) return `${accent}╭${RST}`;

  // ╭─ Title ───...─── info ─╮
  // overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${accent}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number, accent = ACTIVE_ACCENT): string {
  if (width <= 0) return "";
  if (width === 1) return `${accent}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${accent}╰${"─".repeat(inner)}╯${RST}`;
}

function formatLifecycleWidgetLabel(
  projection: ReturnType<typeof projectLifecycle>,
  now: number,
): string {
  const duration = projection.stateDurationSince == null
    ? ""
    : ` ${formatElapsedDuration(now - projection.stateDurationSince)}`;
  if (projection.kind === "active") return projection.label
    ? ` active · ${projection.label}${duration} `
    : ` active${duration} `;
  if (projection.kind === "blocked")
    return ` ${formatWaitStatus(projection.reason ?? "herdr", projection.stateDurationSince, now)} `;
  if (projection.kind === "running") return " running… ";
  if (projection.kind === "waiting") return ` waiting${duration} `;
  if (projection.kind === "interrupted") return ` interrupted${duration} `;
  if (projection.kind === "stalled") return ` stalled${duration} `;
  // completed/failed exist as lifecycle projections for delivery bookkeeping,
  // but the row is removed immediately after result delivery — so the only
  // visible terminal handoff label is finalizing.
  if (
    projection.kind === "finalizing" ||
    projection.kind === "completed" ||
    projection.kind === "failed"
  ) {
    return " finalizing… ";
  }
  return " starting… ";
}

const PRESENCE_STATE_LABEL: Record<PresenceEntry["state"], string> = {
  launching: "starting…",
  "launch-uncertain": "⚠ launch uncertain",
  starting: "starting…",
  active: "active",
  settled: "waiting",
  missing: "⚠ pane missing",
  unavailable: "⚠ unavailable",
  changed: "⚠ changed",
  "taken-over": "taken over",
  stopped: "stopped",
};

/**
 * The one wording of "waiting for the user", for both row types (subagent-tool lifecycle rows and
 * runtime presence rows): `❓ question 12s`, `❓ approval 3s`, `blocked 1m` (Herdr only).
 */
function formatWaitStatus(
  kind: "question" | "approval" | "herdr" | "blocked",
  since: number | undefined,
  now: number,
): string {
  const duration = since == null ? "" : ` ${formatElapsedDuration(now - since)}`;
  if (kind === "question" || kind === "approval") return `❓ ${kind}${duration}`;
  return `blocked${duration}`;
}

/** Status text of a runtime row: waiting for the user, else the client annotation, else the state. */
function presenceStatus(entry: PresenceEntry, now: number): string {
  if (entry.attention) return formatWaitStatus(entry.attention.kind, entry.attention.since, now);
  if (entry.questionPending) return "❓ question";
  return entry.status ?? PRESENCE_STATE_LABEL[entry.state] ?? entry.state;
}

type RowCount = "active" | "question" | "open";

function presenceRowCount(entry: PresenceEntry): RowCount {
  if (entry.attention || entry.questionPending) return "question";
  return presenceActive(entry) ? "active" : "open";
}

function lifecycleRowCount(projection: LifecycleProjection): RowCount {
  if (projection.kind === "blocked") return "question";
  return projection.kind === "active" || projection.kind === "starting" || projection.kind === "running"
    ? "active"
    : "open";
}

/** Box header `N active · N question · N open` (zero parts omitted); accent: attention > active > open. */
function widgetHeader(counts: RowCount[]): { info: string; accent: string } {
  const n = (kind: RowCount) => counts.filter((count) => count === kind).length;
  const [active, question, open] = [n("active"), n("question"), n("open")];
  const info = [active && `${active} active`, question && `${question} question`, open && `${open} open`]
    .filter(Boolean)
    .join(" · ") || "0 open";
  const accent = question > 0 ? ATTENTION_ACCENT : active > 0 ? ACTIVE_ACCENT : OPEN_ACCENT;
  return { info, accent };
}

/** One runtime agent row: elapsed, label, model|thinking · status. */
function presenceRowLine(entry: PresenceEntry, width: number, accent: string, now: number): string {
  const elapsed = formatElapsedMMSS(entry.startedAt, now);
  const selected = entry.paneId && paneSelector.state.selected === entry.paneId ? "▶" : " ";
  const left = ` ${selected} ${elapsed}  ${entry.label} `;
  const modelId = entry.model.includes("/") ? entry.model.slice(entry.model.indexOf("/") + 1) : entry.model;
  return borderLine(left, ` ${modelId}|${entry.thinking} · ${presenceStatus(entry, now)} `, width, accent);
}

const SELECTOR_HINT = " /subagent · Ctrl+Alt+X: next agent ";

/** Runtime agents of other clients, one box per display group (e.g. "Issue Round"); `hint` in the last. */
function renderPresenceGroupLines(entries: PresenceEntry[], width: number, hint = false, now = Date.now()): string[] {
  const groups = new Map<string, PresenceEntry[]>();
  for (const entry of entries) {
    if (!entry.group) continue;
    groups.set(entry.group, [...(groups.get(entry.group) ?? []), entry]);
  }
  const lines: string[] = [];
  for (const [group, rows] of groups) {
    const { info, accent } = widgetHeader(rows.map(presenceRowCount));
    lines.push(borderTop(group, info, width, accent));
    for (const row of rows) lines.push(presenceRowLine(row, width, accent, now));
    if (hint && group === [...groups.keys()].at(-1)) lines.push(borderLine(SELECTOR_HINT, "", width, accent));
    lines.push(borderBottom(width, accent));
  }
  return lines;
}

/** The single widget: generic subagents (legacy + ungrouped runtime rows), then one box per runtime group. */
function renderWidgetLines(
  agents: RunningSubagent[],
  entries: PresenceEntry[],
  width: number,
): string[] {
  // Subagent-tool children are rendered from their richer running entry, not their presence row.
  const own = new Set(agents.map((agent) => agent.handle?.protocolDir).filter(Boolean));
  entries = entries.filter((entry) => !own.has(entry.key));
  const ungrouped = entries.filter((entry) => !entry.group);
  const subagentsBox = agents.length > 0 || ungrouped.length > 0;
  return [
    ...(subagentsBox ? renderSubagentWidgetLines(agents, width, ungrouped) : []),
    // The selector hint once: in the Subagents box, else in the last group box.
    ...renderPresenceGroupLines(entries, width, !subagentsBox),
  ];
}

function renderSubagentWidgetLines(
  agents: RunningSubagent[],
  width: number,
  runtimeRows: PresenceEntry[] = [],
): string[] {
  const now = Date.now();
  const rendered = agents.map((agent) => ({ agent, projection: projectLifecycle(ensureLifecycle(agent), now) }));
  const { info, accent } = widgetHeader([
    ...rendered.map(({ projection }) => lifecycleRowCount(projection)),
    ...runtimeRows.map(presenceRowCount),
  ]);

  const lines: string[] = [borderTop("Subagents", info, width, accent)];

  for (const { agent, projection } of rendered) {
    const elapsed = formatElapsedMMSS(agent.startTime, projection.runtimeEndedAt ?? now);
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    const worktreeTag = agent.worktree ? ` ⎇ ${agent.worktree.branch}` : "";
    const selected = paneSelector.state.selected === agent.surface ? "▶" : " ";
    const left = ` ${selected} ${elapsed}  ${agent.name}${agentTag}${worktreeTag} `;
    const runtimeTag = agent.runtimePlan
      ? `${agent.runtimePlan.modelId}|${agent.runtimePlan.thinking} · `
      : "";
    const right = statusConfig.enabled
      ? ` ${runtimeTag}${formatLifecycleWidgetLabel(projection, now).trim()} `
      : ` ${runtimeTag}starting… `;

    lines.push(borderLine(left, right, width, accent));
  }
  for (const row of runtimeRows) lines.push(presenceRowLine(row, width, accent, now));

  lines.push(borderLine(SELECTOR_HINT, "", width, accent));
  lines.push(borderBottom(width, accent));
  return lines;
}

function updateWidget() {
  const latestCtx = runtime.latestCtx;
  if (!latestCtx?.hasUI) return;

  const own = new Set([...runningSubagents.values()].map((agent) => agent.handle?.protocolDir));
  if (runningSubagents.size === 0 && presence().list().every((entry) => own.has(entry.key))) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderWidgetLines(Array.from(runningSubagents.values()), presence().list(), width);
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */


function ensureLifecycle(running: RunningSubagent): SubagentLifecycle {
  if (running.lifecycle) return running.lifecycle;
  let lifecycle = createLifecycle(running.startTime);
  const state = running.statusState;
  if (state?.activityLabel === "interrupted" && state.localOverrideAtMs != null) {
    lifecycle = markInterruptRequested(lifecycle, state.localOverrideAtMs);
  } else if (state?.phase === "done") {
    // Legacy activity "done" means the turn ended, not that completion
    // evidence was recorded. Hydrate as Herdr-style waiting and let the
    // preserved watcher consume sidecar/sentinel evidence.
    const observedAt = state.lastActivityAtMs ?? running.startTime;
    lifecycle = observePaneInspection(
      lifecycle,
      { kind: "present", observedAt, agentStatus: "done" },
      observedAt,
    );
  } else if (state?.phase === "active" || state?.phase === "waiting" || state?.phase === "starting") {
    lifecycle = observeActivity(lifecycle, {
      ok: true,
      activity: {
        version: 1,
        runningChildId: running.id,
        createdAt: running.startTime,
        updatedAt: state.lastActivityAtMs ?? running.startTime,
        sequence: state.lastActivitySequence ?? 0,
        latestEvent: state.latestEvent === "agent_end" ? "agent_end" : "agent_start",
        phase: state.phase,
        agentActive: state.phase === "active",
        turnActive: state.phase === "active",
        providerActive: false,
        toolActive: state.activeScope === "tool",
        ...(state.activeScope ? { activeScope: state.activeScope as any } : {}),
        ...(state.activeSinceMs != null ? { activeSince: state.activeSinceMs } : {}),
        ...(state.waitingSinceMs != null ? { waitingSince: state.waitingSinceMs } : {}),
        ...(state.activityLabel && state.activeScope === "tool" ? { toolName: state.activityLabel } : {}),
      },
    }, state.lastActivityAtMs ?? running.startTime);
  } else if (state?.hasActivitySnapshots === false || running.startTime) {
    // Pre-lifecycle Pi agents without a known phase still get a running process.
    lifecycle = markProcessRunning(lifecycle, running.startTime);
  }
  running.lifecycle = lifecycle;
  return lifecycle;
}

function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  ensureLifecycle(running);

  // Runtime children write their activity in the runtime evidence; legacy entries in the artifact dir.
  const read: ActivityReadResult = running.handle
    ? subagentRuntime().activity(running.handle)
    : running.activityFile
      ? readSubagentActivityFile(running.activityFile, running.id)
      : { ok: false, reason: "missing" };

  running.activityRead = read.ok
    ? { ok: true }
    : { ok: false, reason: read.reason, error: read.error };

  if (read.ok) running.activity = read.activity;
  running.lifecycle = observeActivity(ensureLifecycle(running), read, observedAt);
}

function resolveInterruptTarget(params: { id?: string; name?: string }):
  | { running: RunningSubagent }
  | { error: string } {
  const requestedId = params.id?.trim();
  if (requestedId) {
    const running = runningSubagents.get(requestedId);
    return running ? { running } : { error: `No running subagent with id "${requestedId}".` };
  }

  const requestedName = params.name?.trim();
  if (!requestedName) {
    return { error: "Provide a running subagent id or exact display name." };
  }

  const matches = Array.from(runningSubagents.values()).filter((running) => running.name === requestedName);
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) {
    return { error: `No running subagent named "${requestedName}".` };
  }

  const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
  return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
}

interface SelectorChoice {
  paneId: string;
  name: string;
  label: string;
  running?: RunningSubagent;
}

/** This session's subagents, then other runtime agents shown-able beside the main pane (same workspace). */
function selectorChoices(): SelectorChoice[] {
  const own = Array.from(runningSubagents.values());
  const choices: SelectorChoice[] = own.map((agent) => ({
    paneId: agent.surface,
    name: agent.name,
    running: agent,
    label: `${agent.name} [${agent.id}] · ${projectLifecycle(ensureLifecycle(agent), Date.now()).kind}`,
  }));
  let selectable: Set<string>;
  try {
    selectable = new Set(paneSelector.selectable());
  } catch {
    return choices; // Layout unknown: only this session's subagents.
  }
  for (const entry of presence().list()) {
    if (!entry.paneId || !selectable.has(entry.paneId) || own.some((agent) => agent.surface === entry.paneId))
      continue;
    const status = presenceStatus(entry, Date.now());
    choices.push({
      paneId: entry.paneId,
      name: entry.label,
      label: `${entry.group ? `${entry.group} › ` : ""}${entry.label} · ${status}`,
    });
  }
  return choices;
}

/**
 * Pane selector moves go through the runtime that owns each pane (also another client's, e.g. Issue
 * Round): the observed new tab is kept in the selector's control. Take it over here too.
 */
function syncSelectorHandles(): void {
  for (const running of runningSubagents.values()) {
    const control = paneSelector.state.controls?.get(running.surface);
    if (
      running.handle &&
      control?.handle.protocolDir === running.handle.protocolDir &&
      control.handle.taskToken === running.handle.taskToken
    )
      running.handle = control.handle;
  }
}

/** Runtime children get a correlated interrupt request (the child aborts its current run). */
function interruptSubagentPane(surface: string): void {
  const running = [...runningSubagents.values()].find((agent) => agent.surface === surface);
  if (!running?.handle) {
    interruptPane(surface);
    return;
  }
  // A request, not proof: the run ends as "interrupted" in the child's evidence. A refused request
  // (agent no longer owned) leaves the lifecycle to the supervisor's next observation.
  void subagentRuntime().interrupt(running.handle).catch(() => {});
}

function requestSubagentInterrupt(
  running: RunningSubagent,
  interruptPaneKey: (surface: string) => void = interruptSubagentPane,
): { ok: true } | { error: string } {
  try {
    interruptPaneKey(running.surface);
    return { ok: true };
  } catch (error: any) {
    return {
      error:
        `Failed to interrupt subagent "${running.name}": ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

function handleSubagentInterrupt(
  params: { id?: string; name?: string },
  interruptPaneKey: (surface: string) => void = interruptSubagentPane,
) {
  const resolved = resolveInterruptTarget(params);
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;
  const now = Date.now();
  observeRunningSubagent(running, now);

  const interruption = requestSubagentInterrupt(running, interruptPaneKey);
  if ("error" in interruption) {
    return {
      content: [{ type: "text" as const, text: interruption.error }],
      details: { error: interruption.error, id: running.id, name: running.name },
    };
  }

  running.lifecycle = markInterruptRequested(ensureLifecycle(running), now);
  updateWidget();

  return {
    content: [{ type: "text" as const, text: `Interrupt requested for subagent "${running.name}".` }],
    details: { id: running.id, name: running.name, status: "interrupt_requested" },
  };
}

function startStatusRefresh(pi: ExtensionAPI) {
  if (!statusConfig.enabled || statusInterval) return;

  statusInterval = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
        (globalThis as any)[STATUS_INTERVAL_KEY] = null;
      }
      return;
    }

    const transitionLines: string[] = [];
    const now = Date.now();
    let shouldRefreshWidget = false;

    for (const running of runningSubagents.values()) {
      // Dual-writes lifecycle + statusState for reload hydration; steers use lifecycle only.
      observeRunningSubagent(running, now);
      const projection = projectLifecycle(ensureLifecycle(running), now);
      const transition = lifecycleTransition(running.lastProjectedKind, projection.kind);
      if (running.lastProjectedKind !== projection.kind) {
        shouldRefreshWidget = true;
      }
      // Blocked never steers and keeps the kind seen before it (a stalled child that asks the user
      // is reported recovered only when it moves on).
      running.lastProjectedKind = transitionBaseline(running.lastProjectedKind, projection.kind);

      // Interactive subagents (long-running, user-driven) intentionally don't
      // wake the parent session on stalled/recovered transitions — the user is
      // working in the subagent's pane, and a steer message here would burn an
      // orchestrator turn on a no-op "still waiting" ping. Widget still updates.
      if (transition && !running.interactive) {
        transitionLines.push(
          formatLifecycleTransitionLine(
            normalizeStatusName(running.name),
            projection,
            transition,
            now,
            running.startTime,
            formatElapsedDuration,
          ),
        );
      }
    }

    if (shouldRefreshWidget) updateWidget();

    if (transitionLines.length > 0) {
      const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
      pi.sendMessage(
        {
          customType: "subagent_status",
          content: formatStatusAggregate(transitionLines, statusConfig.lineLimit),
          display: true,
          details: { lines: capped.visibleLines, overflow: capped.overflow },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  }, 1000);

  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

function resolveResumeLaunchBehavior(params: { autoExit?: boolean }): { autoExit: boolean; interactive: boolean } {
  const autoExit = params.autoExit ?? true;
  return { autoExit, interactive: !autoExit };
}

// ── git worktree integration (see worktree.ts, docs/worktrees.md) ──

function getWorktreeRegistryDir(): string {
  return worktreeRegistryDir(getAgentConfigDir());
}

/**
 * `thinking` must be decided for every spawn: passed explicitly or declared by the named agent's
 * frontmatter. The tool never falls back to the caller's level (the runtime still accepts a parent level).
 */
function validateThinkingParam(
  params: { thinking?: string; agent?: string },
  agentDefs: { thinking?: string } | null,
): string | null {
  if (params.thinking != null || agentDefs?.thinking) return null;
  const who = params.agent
    ? `Agent "${params.agent}" declares no thinking default`
    : "A bare spawn has no thinking default";
  return (
    `thinking is required. ${who}, and thinking is never inherited from the caller. ` +
    `Pass thinking (off, minimal, low, medium, high, xhigh, max) chosen for this task: ` +
    `minimal/low for bounded mechanical work, medium for ordinary implementation or review, ` +
    `high+ for architecture, concurrency, security or hard diagnosis.`
  );
}

function validateWorktreeParams(params: {
  worktree?: boolean;
  worktreeBranch?: string;
  worktreeBase?: string;
}): string | null {
  if (params.worktree !== true && (params.worktreeBranch != null || params.worktreeBase != null)) {
    return "worktreeBranch and worktreeBase require worktree: true.";
  }
  return null;
}

interface DirtySourcePromptContext {
  hasUI?: boolean;
  mode?: string;
  ui?: { select?: (title: string, options: string[]) => Promise<string | undefined> };
}

/**
 * Dirty source checkout: warn and ask. Only an interactive TUI asks; print,
 * JSON and RPC modes proceed (the warning still reaches the child and the
 * master). Returns false when the user cancels.
 */
async function confirmDirtyWorktreeSource(
  plan: Pick<WorktreePlan, "repo" | "baseSha" | "sourceDirty" | "sourceUntracked">,
  ctx: DirtySourcePromptContext,
): Promise<boolean> {
  const count = plan.sourceDirty + plan.sourceUntracked;
  if (count === 0) return true;
  if (!ctx.hasUI || (ctx.mode ?? "tui") !== "tui" || typeof ctx.ui?.select !== "function") return true;
  const base7 = plan.baseSha.slice(0, 7);
  const proceed = `Proceed from the last commit (${base7}) without these changes`;
  const cancel = "Cancel (create nothing)";
  const choice = await ctx.ui.select(
    `The source checkout ${plan.repo} has ${count} uncommitted/untracked change(s) that will NOT be included in the worktree (it starts from ${base7}). Proceed?`,
    [proceed, cancel],
  );
  return choice === proceed;
}

function worktreeTaskNote(info: WorktreeInfo): string {
  return [
    `[pi-memo-subagents worktree] You are working in the git worktree ${info.cwd} on the new branch ${info.branch} (base ${info.base.slice(0, 7)}). ` +
      `Commit your work on that branch. Do not modify the original checkout ${info.repo}. Nothing is merged automatically.`,
    ...info.warnings.map((warning) => `Warning: ${warning}`),
  ].join("\n");
}

function worktreeDetails(info: WorktreeInfo, state?: WorktreeState) {
  return {
    id: info.id,
    repo: info.repo,
    path: info.path,
    cwd: info.cwd,
    branch: info.branch,
    base: info.base,
    ...(info.warnings.length > 0 ? { warnings: info.warnings } : {}),
    ...(state
      ? {
          exists: state.exists,
          registered: state.registered,
          ...(state.head ? { head: state.head } : {}),
          ...(state.commitsAhead != null ? { commitsAhead: state.commitsAhead } : {}),
          ...(state.dirty != null ? { dirty: state.dirty } : {}),
          ...(state.untracked != null ? { untracked: state.untracked } : {}),
          ...(state.error ? { error: state.error } : {}),
        }
      : {}),
  };
}

function worktreeLines(info: WorktreeInfo, state?: WorktreeState): string {
  return [
    formatWorktreeLine(info, state),
    ...info.warnings.map((warning) => `Worktree warning: ${warning}`),
  ].join("\n");
}

async function describeWorktreeForResult(info: WorktreeInfo) {
  let state: WorktreeState | undefined;
  try {
    state = await getWorktreeState(info);
  } catch {
    state = undefined;
  }
  return { text: worktreeLines(info, state), details: worktreeDetails(info, state) };
}

/** The `Worktree:` block (with its warnings) inserted into a result message. */
function extractWorktreeBlock(content: string): string | undefined {
  const matches = [...content.matchAll(/\n\nWorktree: [^\n]*(?:\nWorktree warning: [^\n]*)*/g)];
  return matches.at(-1)?.[0];
}

function formatWorktreeBadge(worktree: {
  path?: string;
  branch?: string;
  commitsAhead?: number;
  dirty?: number;
  untracked?: number;
}): string {
  const parts = [`⎇ ${worktree.branch}`];
  if (worktree.commitsAhead != null) parts.push(`${worktree.commitsAhead} ahead`);
  if (worktree.dirty != null || worktree.untracked != null) {
    parts.push((worktree.dirty ?? 0) + (worktree.untracked ?? 0) > 0 ? "dirty" : "clean");
  }
  if (worktree.path) parts.push(worktree.path);
  return parts.join(" · ");
}

/** Insert worktree lines before the trailing Session/Resume reference. */
function insertBeforeSessionRef(text: string, addition: string): string {
  const index = text.lastIndexOf("\n\nSession: ");
  return index === -1
    ? `${text}\n\n${addition}`
    : `${text.slice(0, index)}\n\n${addition}${text.slice(index)}`;
}

function worktreeInfoFromRecord(record: WorktreeRecord): WorktreeInfo {
  return {
    id: record.id,
    name: record.name,
    repo: record.repo,
    sourceCwd: record.sourceCwd,
    path: record.path,
    cwd: record.cwd,
    branch: record.branch,
    base: record.base,
    createdAt: record.createdAt,
    warnings: [],
  };
}

function isWorktreeInUse(path: string): boolean {
  return Array.from(runningSubagents.values()).some(
    (running) => running.worktree && samePath(running.worktree.path, path),
  );
}

interface WorktreeEntry {
  record: WorktreeRecord;
  state: WorktreeState;
  inUse: boolean;
}

/** Registry records (not removed) cross-checked with git, by default for the repo of `cwd`. */
async function listWorktreeEntries(options: { cwd: string; all?: boolean }): Promise<WorktreeEntry[]> {
  let records = readWorktreeRecords(getWorktreeRegistryDir()).filter((record) => !record.removedAt);
  if (!options.all) {
    const top = await repoToplevel(options.cwd);
    if (top) records = records.filter((record) => samePath(record.repo, top) || samePath(record.path, top));
  }
  const entries: WorktreeEntry[] = [];
  for (const record of records) {
    entries.push({ record, state: await getWorktreeState(record), inUse: isWorktreeInUse(record.path) });
  }
  return entries;
}

function formatWorktreeEntry({ record, state, inUse }: WorktreeEntry): string {
  const flags: string[] = [];
  if (!state.exists) flags.push("missing");
  else if (!state.registered) flags.push("not registered");
  else {
    flags.push(`${state.commitsAhead ?? "?"} ahead of ${record.base.slice(0, 7)}`);
    const changes = (state.dirty ?? 0) + (state.untracked ?? 0);
    flags.push(changes > 0 ? `dirty (${state.dirty ?? 0} changed, ${state.untracked ?? 0} untracked)` : "clean");
  }
  if (state.locked) flags.push("locked");
  if (state.operation) flags.push(`${state.operation} in progress`);
  if (inUse) flags.push("in use");
  if (state.error) flags.push(`error: ${state.error}`);
  const agent = record.agent ? ` (${record.agent})` : "";
  return `${record.id.slice(0, 8)} ${record.name}${agent} — ${record.branch} @ ${record.path}: ${flags.join(", ")}`;
}

async function removeWorktreeEntry(options: {
  id?: string;
  path?: string;
  deleteBranch?: boolean;
}): Promise<{ ok: boolean; text: string; details: Record<string, unknown> }> {
  const dir = getWorktreeRegistryDir();
  const records = readWorktreeRecords(dir).filter((record) => !record.removedAt);
  const id = options.id?.trim();
  const path = options.path?.trim();
  if (!id && !path) {
    return { ok: false, text: "Provide the id or path of a pi-memo-subagents worktree.", details: { error: "missing target" } };
  }
  const matches = records.filter((record) =>
    id ? record.id === id || (id.length >= 4 && record.id.startsWith(id)) : samePath(record.path, path!),
  );
  if (matches.length !== 1) {
    const text = matches.length === 0
      ? `No pi-memo-subagents worktree matches ${id ? `id "${id}"` : `path ${path}`}. Only worktrees created by subagent are managed here.`
      : `Ambiguous id "${id}": ${matches.map((record) => record.id).join(", ")}`;
    return { ok: false, text, details: { error: text } };
  }
  const record = matches[0];
  const inUse = isWorktreeInUse(record.path);
  const state = await getWorktreeState(record);
  if (!inUse && !state.exists && !state.registered && !state.error) {
    markWorktreeRecordRemoved(dir, record.id);
    const text = `Worktree ${record.path} no longer exists; registry record forgotten. Branch ${record.branch} was not touched.`;
    return { ok: true, text, details: { id: record.id, path: record.path, removed: false, branchDeleted: false } };
  }
  const result = await removeWorktree(record, { deleteBranch: options.deleteBranch === true, inUse });
  if (result.removed) markWorktreeRecordRemoved(dir, record.id);
  return {
    ok: result.ok,
    text: result.messages.join("\n"),
    details: {
      id: record.id,
      path: record.path,
      branch: record.branch,
      removed: result.removed,
      branchDeleted: result.branchDeleted,
      ...(result.ok ? {} : { error: result.messages[0] }),
    },
  };
}

/**
 * Resolve the worktree a resumed session must run in. Sessions without a
 * registry record resume exactly as before (no cd).
 */
async function resolveResumeWorktree(
  sessionPath: string,
): Promise<{ worktree?: WorktreeInfo; error?: string }> {
  const record = findWorktreeRecordBySession(getWorktreeRegistryDir(), sessionPath);
  if (!record) return {};
  const wrong = `resuming would run in the wrong checkout. Spawn a new subagent instead.`;
  if (record.removedAt) {
    return { error: `The worktree ${record.path} of this session was removed; ${wrong}` };
  }
  const state = await getWorktreeState(record);
  if (!state.exists || !state.registered) {
    return { error: `The worktree ${record.path} of this session no longer exists; ${wrong}` };
  }
  const info = worktreeInfoFromRecord(record);
  if (!existsSync(info.cwd)) info.cwd = info.path;
  return { worktree: info };
}

export const __test__ = {
  borderLine,
  renderSubagentWidgetLines,
  renderWidgetLines,
  renderPresenceGroupLines,
  isPiAgent,
  resolveAgentBash,
  loadAgentDefaults,
  discoverAgentDefinitions,
  buildAvailableAgentCatalog,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveEffectiveAutoExit,
  resolveEffectiveInteractive,
  observeRunningSubagent,
  resolveDenyTools,
  resolveInterruptTarget,
  requestSubagentInterrupt,
  handleSubagentInterrupt,
  resolveResultPresentation,
  resolveResumeLaunchBehavior,
  validateWorktreeParams,
  validateThinkingParam,
  confirmDirtyWorktreeSource,
  insertBeforeSessionRef,
  extractWorktreeBlock,
  formatWorktreeBadge,
  listWorktreeEntries,
  removeWorktreeEntry,
  resolveResumeWorktree,
  runningSubagents,
  formatElapsed,
};

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

/**
 * Launch a subagent: creates the herdr pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
type LaunchContext = Parameters<typeof launchSubagentInner>[1];

interface LaunchState {
  worktree?: WorktreeInfo;
  surface?: string;
}

/**
 * Launch wrapper: when a worktree was created and the launch then fails
 * (pane creation, script), close the new pane and roll the worktree back.
 */
async function launchSubagent(
  params: typeof SubagentParams.static,
  ctx: LaunchContext,
  parentThinking: ThinkingLevel,
  options?: { worktreePlan?: WorktreePlan },
): Promise<RunningSubagent> {
  const state: LaunchState = {};
  try {
    return await launchSubagentInner(params, ctx, parentThinking, options, state);
  } catch (error) {
    if (!state.worktree) throw error;
    // An uncertain launch may have a child running in the worktree: keep it (and the pane) for inspection.
    if (error instanceof RuntimeError && error.code === "launch_uncertain") {
      throw new RuntimeError(
        "launch_uncertain",
        `${error.message} (worktree ${state.worktree.path} and any pane were kept for inspection)`,
        error.evidence,
      );
    }
    const rollback = await rollbackWorktree(state.worktree);
    const note = rollback.errors.length > 0
      ? `worktree rollback incomplete: ${rollback.errors.join("; ")}`
      : `worktree ${state.worktree.path} and branch ${state.worktree.branch} rolled back`;
    throw new Error(`${error instanceof Error ? error.message : String(error)} (${note})`);
  }
}

function slugName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "subagent";
}

function realPathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The cwd recorded in a session header, when it still exists. */
function sessionHeaderCwd(sessionFile: string): string | undefined {
  try {
    const header = JSON.parse(readFileSync(sessionFile, "utf8").split("\n", 1)[0]);
    return typeof header?.cwd === "string" && existsSync(header.cwd) ? header.cwd : undefined;
  } catch {
    return undefined;
  }
}

/** Selector: the runtime's shared pane selector decides (first agent beside the main pane, others in tabs). */
function surfacePlacement(): "auto" | "split-right" | "tab" {
  const mode = surfaceMode();
  return mode === "selector" ? "auto" : mode === "tab" ? "tab" : "split-right";
}

function surfaceMode(): "selector" | "split" | "tab" {
  const mode = process.env.PI_SUBAGENT_SURFACE ?? "selector";
  return mode === "tab" || mode === "split" ? mode : "selector";
}

function splitList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

/** Header-only session file (standalone mode): the child opens exactly this file. */
function writeStandaloneSessionFile(path: string, id: string, cwd: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd }) + "\n",
    "utf8",
  );
}

/** Agent `tools` become the runtime allowlist (exit tools come from the exit policy); denied tools are blocked. */
function subagentToolPolicy(
  tools: string | undefined,
  denySet: Set<string>,
): { tools?: string[]; denyTools: string[] } {
  const allowlist = splitList(tools).filter((tool) => tool !== "caller_ping" && tool !== "subagent_done");
  return {
    ...(allowlist.length > 0 ? { tools: allowlist } : {}),
    denyTools: [...denySet],
  };
}

/** Identity variables read by pi-memo-subagents inside the child (self-spawn guard, denied tools). */
function subagentEnv(options: {
  name: string;
  agent?: string;
  id: string;
  denySet?: Set<string>;
}): Record<string, string> {
  return {
    PI_SUBAGENT_NAME: options.name,
    PI_SUBAGENT_ID: options.id,
    ...(options.agent ? { PI_SUBAGENT_AGENT: options.agent } : {}),
    ...(options.denySet && options.denySet.size > 0 ? { PI_DENY_TOOLS: [...options.denySet].join(",") } : {}),
  };
}

function resolveWorktreePaths(cwd: string) {
  const localAgentDir = join(cwd, ".pi", "agent");
  return {
    effectiveCwd: cwd,
    localAgentDir,
    effectiveAgentDir: existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir(),
  };
}

async function launchSubagentInner(
  params: typeof SubagentParams.static,
  ctx: {
    sessionManager: { getSessionFile(): string | null; getSessionId(): string; getSessionDir(): string };
    cwd: string;
    model?: { provider: string; id: string };
    modelRegistry: {
      find(provider: string, modelId: string): any;
      getAvailable?: () => any[];
      getAll?: () => any[];
      hasConfiguredAuth?: (model: any) => boolean;
    };
  },
  parentThinking: ThinkingLevel,
  options: { worktreePlan?: WorktreePlan } | undefined,
  launchState: LaunchState,
): Promise<RunningSubagent> {
  const startTime = Date.now();
  // A worktree plan reserves the id up front so path/branch names match it.
  const id = options?.worktreePlan?.id ?? randomBytes(12).toString("hex");

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  if (!ctx.model) throw new Error("Subagent launch requires a resolved parent model");
  const runtimePlan = resolveRuntimePlan(
    { model: params.model, thinking: params.thinking },
    {
      model: resolveModelDefault(params.agent, agentDefs?.model, modelConfig),
      thinking: agentDefs?.thinking,
    },
    { provider: ctx.model.provider, modelId: ctx.model.id, thinking: parentThinking },
    wrapPiModelRegistry(ctx.modelRegistry),
  );
  const effectiveAutoExit = resolveEffectiveAutoExit(params, agentDefs);
  const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);

  const resolvedPaths = resolveSubagentPaths(params, agentDefs);

  // Only pi agents: a definition with another cli is refused before any worktree or pane.
  if (agentDefs && !isPiAgent(agentDefs)) {
    throw new Error(
      `Unsupported subagent cli "${agentDefs.cli}": pi-memo-subagents launches only pi subagents. ` +
        "Remove the `cli` field from the agent definition.",
    );
  }
  // Bash policy (full/readonly/none, bash-allow): invalid values are refused before any worktree or pane.
  let bash: ReturnType<typeof resolveAgentBash>;
  try {
    bash = resolveAgentBash(agentDefs);
  } catch (error) {
    throw new Error(`Agent "${params.agent}": ${error instanceof Error ? error.message : String(error)}`);
  }

  // Optional worktree: created after runtime validation and before the pane.
  if (options?.worktreePlan) {
    launchState.worktree = await createWorktree(options.worktreePlan);
  }
  const worktree = launchState.worktree;
  const { effectiveCwd, effectiveAgentDir } = worktree
    ? resolveWorktreePaths(worktree.cwd)
    : resolvedPaths;
  // Real path: the child's session header, its pi cwd and the runtime identity must agree.
  const targetCwdForSession = realPathOr(effectiveCwd ?? ctx.cwd);
  const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);

  // Generate a deterministic session file path for this subagent.
  // This eliminates race conditions when multiple agents launch simultaneously —
  // each agent knows exactly which file is theirs.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  const launchBehavior = resolveLaunchBehavior(params, agentDefs);

  // Every child opens a session file in the normal per-cwd session directory: header only
  // (standalone), with parent lineage, or a full fork of the parent conversation.
  const childSessionId = randomUUID();
  if (launchBehavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: launchBehavior.seededSessionMode,
      parentSessionFile: sessionFile,
      childSessionFile: subagentSessionFile,
      childCwd: targetCwdForSession,
    });
  } else {
    writeStandaloneSessionFile(subagentSessionFile, childSessionId, targetCwdForSession);
  }

  // Build the task message
  // Only full-context fork mode inherits prior conversation state.
  // Blank-session modes need the wrapper instructions in the task.
  const modeHint = effectiveAutoExit
    ? "Complete your task autonomously."
    : "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
  const summaryInstruction = effectiveAutoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.";
  const denySet = resolveDenyTools(agentDefs);
  const identity = agentDefs?.body ?? params.systemPrompt ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = systemPromptMode && identity;
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  const task = worktree ? `${params.task}\n\n${worktreeTaskNote(worktree)}` : params.task;
  const prompt = launchBehavior.taskDelivery === "direct"
    ? task
    : `${roleBlock}\n\n${modeHint}\n\n${task}\n\n${summaryInstruction}`;
  let systemPromptFile: string | undefined;
  if (identityInSystemPrompt && identity) {
    systemPromptFile = join(artifactDir, `context/${slugName(params.name)}-sysprompt-${id}.md`);
    mkdirSync(dirname(systemPromptFile), { recursive: true });
    writeFileSync(systemPromptFile, identity, "utf8");
  }

  const spec: LaunchSpec = {
    scope: sessionId,
    agentId: id,
    attempt: 1,
    taskId: "task-1",
    prompt,
    cwd: targetCwdForSession,
    model: runtimePlan.model,
    thinking: runtimePlan.thinking,
    isolation: "profile",
    agentDir: effectiveAgentDir,
    ...subagentToolPolicy(params.tools ?? agentDefs?.tools, denySet),
    // Read-only memo subagents are user-driven: other plain commands are asked in the child's pane.
    ...(bash.mode === "readonly"
      ? { bash: "readonly" as const, bashAllow: bash.allow, bashAsk: true }
      : {}),
    userInput: "allowed",
    exit: effectiveAutoExit ? "auto" : "tool",
    skills: splitList(params.skills ?? agentDefs?.skills),
    session: { kind: "file", path: subagentSessionFile },
    env: subagentEnv({ name: params.name, agent: params.agent, id, denySet }),
    ...(systemPromptFile
      ? systemPromptMode === "replace"
        ? { systemPrompt: systemPromptFile }
        : { appendSystemPrompt: [systemPromptFile] }
      : {}),
    placement: surfacePlacement(),
    display: { label: params.name },
  };
  const handle = await subagentRuntime().launch(spec);
  launchState.surface = handle.paneId;
  if (params.task) setPaneTask(handle.paneId, params.task);

  const running: RunningSubagent = {
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    surface: handle.paneId,
    handle,
    startTime,
    sessionFile: subagentSessionFile,
    interactive: effectiveInteractive,
    runtimePlan,
    lifecycle: createLifecycle(startTime),
    ...(worktree ? { worktree } : {}),
  };

  runningSubagents.set(id, running);
  if (worktree) {
    try {
      writeWorktreeRecord(getWorktreeRegistryDir(), {
        id: worktree.id,
        name: params.name,
        ...(params.agent ? { agent: params.agent } : {}),
        repo: worktree.repo,
        sourceCwd: worktree.sourceCwd,
        path: worktree.path,
        cwd: worktree.cwd,
        branch: worktree.branch,
        base: worktree.base,
        sessionFile: running.sessionFile,
        parentSession: sessionFile,
        createdAt: worktree.createdAt,
      });
    } catch (error) {
      worktree.warnings.push(
        `Could not write the worktree registry record (${error instanceof Error ? error.message : String(error)}); ` +
          "subagent_resume and subagent_worktrees will not know this worktree.",
      );
    }
  }
  return running;
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface,
 * and removes the entry from runningSubagents.
 */
/** Display-only lifecycle input from one runtime observation (plus Herdr's agent status). */
function observeSubagentObservation(running: RunningSubagent, o: Observation, observedAt = Date.now()) {
  ensureLifecycle(running);
  observeRunningSubagent(running, observedAt);
  if (o.kind === "missing") {
    running.lifecycle = observePaneInspection(running.lifecycle, { kind: "missing", error: o.error }, observedAt);
  } else if (o.kind === "unavailable" && !o.exited) {
    running.lifecycle = observePaneInspection(running.lifecycle, { kind: "unavailable", error: o.error }, observedAt);
  } else if (o.kind !== "unavailable") {
    void inspectPane(running.surface)
      .then((inspection) => {
        if (inspection.kind !== "present") return;
        running.lifecycle = observePaneInspection(running.lifecycle, inspection, Date.now());
        updateWidget();
      })
      .catch(() => {});
  }
  updateWidget();
}

/** Completion record for the lifecycle from the supervised end of a runtime child. */
function completionFromOutcome(outcome: SupervisedOutcome, name: string): CompletionResult {
  const end = outcome.end;
  if (end.kind === "ping") return { reason: "ping", exitCode: 0, ping: { name, message: end.message } };
  if (end.kind === "error") return { reason: "error", exitCode: 1, errorMessage: end.errorMessage };
  if (end.kind === "cancelled") return { reason: "error", exitCode: 1, errorMessage: "Subagent cancelled." };
  if (end.kind === "crashed")
    return { reason: "error", exitCode: 1, errorMessage: "Subagent process exited unexpectedly (no orderly shutdown recorded)" };
  return { reason: "done", exitCode: 0 };
}

/**
 * Supervise a launched subagent through the agent runtime until it ends, extract the summary from its
 * session file and close its pane (never forced).
 */
async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult> {
  const { name, task, startTime, sessionFile } = running;
  if (!running.handle) throw new Error(`Subagent "${name}" has no runtime handle`);

  try {
    const outcome = await superviseSubagent({
      runtime: subagentRuntime(),
      handle: () => running.handle!,
      signal,
      onObservation: (o) => observeSubagentObservation(running, o),
    });
    paneSelector.forget(running.surface);
    const result = completionFromOutcome(outcome, name);
    const detectedAt = Date.now();
    running.lifecycle = markCompletionDetected(running.lifecycle, result, detectedAt);
    updateWidget();
    const elapsed = Math.floor((detectedAt - startTime) / 1000);

    if (outcome.end.kind === "cancelled") {
      running.lifecycle = markFailed(running.lifecycle, "Subagent cancelled.", Date.now(), 1);
      return { name, task, summary: "Subagent cancelled.", exitCode: 1, elapsed, error: "cancelled", sessionFile };
    }

    let summary: string;
    const fallback = result.errorMessage
      ? `Subagent error: ${result.errorMessage}`
      : result.exitCode !== 0
        ? `Sub-agent exited with code ${result.exitCode}`
        : "Sub-agent exited without output";
    if (existsSync(sessionFile)) {
      const allEntries = getNewEntries(sessionFile, running.entryCountBefore ?? 0);
      const observed = findObservedSessionRuntime(getNewEntries(sessionFile, 0));
      if (running.runtimePlan && observed.provider && observed.modelId) {
        const observedModel = `${observed.provider}/${observed.modelId}`;
        const observedThinking = (THINKING_LEVELS as readonly string[]).includes(observed.thinking ?? "")
          ? (observed.thinking as ThinkingLevel)
          : undefined;
        const mismatch = observedModel !== running.runtimePlan.model
          ? `Resolved model ${running.runtimePlan.model} but child reported ${observedModel}`
          : undefined;
        running.runtimePlan = {
          ...running.runtimePlan,
          ...(observedThinking ? { thinking: observedThinking } : {}),
          observed: {
            model: observedModel,
            ...(observedThinking ? { thinking: observedThinking } : {}),
          },
          ...(mismatch ? { runtimeMismatch: mismatch } : {}),
        };
      }
      summary = findLastAssistantMessage(allEntries) ?? fallback;
    } else {
      summary = fallback;
    }
    if (!outcome.closed && outcome.closeError) {
      summary += `\n\n(The subagent pane was left open: ${outcome.closeError})`;
    }

    running.lifecycle = result.exitCode === 0
      ? markCompleted(running.lifecycle, Date.now())
      : markFailed(running.lifecycle, result.errorMessage ?? summary, Date.now(), result.exitCode);

    return {
      name,
      task,
      summary,
      sessionFile,
      exitCode: result.exitCode,
      elapsed,
      ping: result.ping,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    };
  } catch (err: any) {
    paneSelector.forget(running.surface);
    running.lifecycle = markFailed(running.lifecycle, err?.message ?? String(err), Date.now(), 1);
    updateWidget();
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      error: err?.message ?? String(err),
      sessionFile,
    };
  }
}

export default function subagentsExtension(pi: ExtensionAPI) {
  runtime.pi = pi;

  // Unified widget: agents launched by any AgentRuntime client in this process (e.g. issue-round)
  // are shown next to the generic subagents. Display only.
  (globalThis as any)[PRESENCE_WIDGET_KEY]?.();
  (globalThis as any)[PRESENCE_WIDGET_KEY] = presence().subscribe(() => {
    if (presence().list().length > 0) startWidgetRefresh();
    else updateWidget();
  });

  // Capture the UI context for widget updates and restore presentation for
  // subagents whose watchers survived a reload.
  pi.on("session_start", (_event, ctx) => {
    runtime.latestCtx = ctx;
    runtime.modelCatalog = buildAuthenticatedModelCatalog(wrapPiModelRegistry(ctx.modelRegistry));
    runtime.agentCatalog = buildAvailableAgentCatalog(
      discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation && isPiAgent(agent)),
    );
    const refreshedGuidelines = buildSubagentRoutingGuidelines(
      runtime.modelCatalog,
      runtime.agentCatalog,
    );
    subagentRoutingGuidelines.splice(0, subagentRoutingGuidelines.length, ...refreshedGuidelines);
    for (const agent of runningSubagents.values()) {
      paneSelector.state.owned.set(agent.surface, agent.name);
    }
    if (runningSubagents.size > 0) {
      startWidgetRefresh();
      startStatusRefresh(pi);
      updateWidget();
    } else if (presence().list().length > 0) {
      startWidgetRefresh();
    }
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", (event, _ctx) => {
    (globalThis as any)[PRESENCE_WIDGET_KEY]?.();
    (globalThis as any)[PRESENCE_WIDGET_KEY] = null;
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
      (globalThis as any)[STATUS_INTERVAL_KEY] = null;
    }

    cleanupSubagentsForShutdown((event as any).reason, runningSubagents);
  });

  // Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
  const deniedTools = new Set(
    (process.env.PI_SUBAGENT_ID ? process.env.PI_DENY_TOOLS ?? "" : "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const shouldRegister = (name: string) => !deniedTools.has(name);

  // ── subagent tool ──
  if (shouldRegister("subagent"))
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Spawn a sub-agent in a dedicated terminal herdr pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
      promptSnippet:
        "Spawn a sub-agent in a dedicated terminal herdr pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
      promptGuidelines: subagentRoutingGuidelines,
      parameters: SubagentParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        // Prevent self-spawning (e.g. planner spawning another planner)
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        const worktreeParamError = validateWorktreeParams(params);
        if (worktreeParamError) {
          return {
            content: [{ type: "text", text: `Error: ${worktreeParamError}` }],
            details: { error: worktreeParamError },
          };
        }

        const thinkingParamError = validateThinkingParam(
          params,
          params.agent ? loadAgentDefaults(params.agent) : null,
        );
        if (thinkingParamError) {
          return {
            content: [{ type: "text", text: `Error: ${thinkingParamError} No subagent was started.` }],
            details: { error: thinkingParamError },
          };
        }

        // Validate prerequisites
        if (!isTerminalAvailable()) {
          return muxUnavailableResult();
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        // Optional worktree: plan (no side effects) and ask about a dirty source.
        let worktreePlan: WorktreePlan | undefined;
        if (params.worktree === true) {
          try {
            const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
            const sourceCwd = resolveSubagentPaths(params, agentDefs).effectiveCwd ?? ctx.cwd;
            worktreePlan = await planWorktree({
              sourceCwd,
              id: randomBytes(12).toString("hex"),
              name: params.name,
              branch: params.worktreeBranch,
              base: params.worktreeBase,
              config: loadWorktreeConfig(),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: "text", text: `Error: ${message}. No subagent was started.` }],
              details: { error: message },
            };
          }
          if (!(await confirmDirtyWorktreeSource(worktreePlan, ctx as DirtySourcePromptContext))) {
            const message =
              `Cancelled by the user: the source checkout has uncommitted changes. ` +
              `No worktree or subagent was created.`;
            return {
              content: [{ type: "text", text: message }],
              details: { error: "worktree cancelled (dirty source)", worktreeCancelled: true },
            };
          }
        }

        // Launch the subagent (creates pane, sends command)
        const parentThinking = pi.getThinkingLevel();
        if (
          parentThinking !== "off" &&
          parentThinking !== "minimal" &&
          parentThinking !== "low" &&
          parentThinking !== "medium" &&
          parentThinking !== "high" &&
          parentThinking !== "xhigh" &&
          parentThinking !== "max"
        ) {
          throw new Error(`Unsupported parent thinking level: ${parentThinking}`);
        }
        let running: RunningSubagent;
        try {
          running = await launchSubagent(
            params,
            ctx,
            parentThinking,
            worktreePlan ? { worktreePlan } : undefined,
          );
        } catch (error) {
          if (!(error instanceof RuntimeError && error.code === "launch_uncertain")) throw error;
          // The task is already in the child's private task file: the child may still start and run it.
          const paneId = (error.evidence as { paneId?: string } | undefined)?.paneId;
          const message =
            `Launch outcome uncertain for sub-agent "${params.name}": ${error.message}. ` +
            `Do NOT launch it again: the child may still start and run the task` +
            (paneId ? ` in Herdr pane ${paneId}` : "") +
            ` (e.g. waiting for a project trust or startup prompt). Ask the user to check that pane.`;
          return {
            content: [{ type: "text" as const, text: message }],
            details: { error: "launch uncertain", uncertain: true, ...(paneId ? { paneId } : {}) },
          };
        }

        // Create a separate AbortController for the watcher
        // (the tool's signal completes when we return)
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        // Start widget refresh and status supervision when the first agent launches
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget: start watching in background
        watchSubagent(running, watcherAbort.signal)
          .then(async (result) => {
            if (!shouldDeliverSubagentCompletion(running)) {
              running.lifecycle = markDelivery(running.lifecycle, "suppressed");
              runningSubagents.delete(running.id);
              updateWidget();
              return;
            }
            running.lifecycle = markDelivery(running.lifecycle, "delivered");
            runningSubagents.delete(running.id);
            updateWidget();
            const completionApi = selectCompletionApi(pi, runtime.pi);
            // Only worktree children await git state; others deliver synchronously as before.
            const worktreeReport = running.worktree
              ? await describeWorktreeForResult(running.worktree)
              : undefined;

            if (result.ping) {
              // Subagent is requesting help — steer a ping message with session path for resume
              const sessionRef = `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`;
              completionApi.sendMessage(
                {
                  customType: "subagent_ping",
                  content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${worktreeReport ? `\n\n${worktreeReport.text}` : ""}${sessionRef}`,
                  display: true,
                  details: {
                    name: result.ping.name,
                    message: result.ping.message,
                    agent: running.agent,
                    sessionFile: result.sessionFile,
                    ...(worktreeReport ? { worktree: worktreeReport.details } : {}),
                  },
                },
                { triggerTurn: true, deliverAs: "steer" },
              );
              return;
            }

            const basePresentation = resolveResultPresentation(result, running.name);
            const runtimePresentation = running.runtimePlan?.runtimeMismatch
              ? `${basePresentation}\n\nRuntime warning: ${running.runtimePlan.runtimeMismatch}`
              : basePresentation;
            const presentation = worktreeReport
              ? insertBeforeSessionRef(runtimePresentation, worktreeReport.text)
              : runtimePresentation;

            completionApi.sendMessage(
              {
                customType: "subagent_result",
                content: presentation,
                display: true,
                details: {
                  name: running.name,
                  task: running.task,
                  agent: running.agent,
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: result.sessionFile,
                  ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
                  ...(running.runtimePlan ? { runtimePlan: running.runtimePlan } : {}),
                  ...(worktreeReport ? { worktree: worktreeReport.details } : {}),
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((err) => {
            if (!shouldDeliverSubagentCompletion(running)) {
              running.lifecycle = markDelivery(running.lifecycle, "suppressed");
              runningSubagents.delete(running.id);
              updateWidget();
              return;
            }
            running.lifecycle = markDelivery(running.lifecycle, "delivered");
            runningSubagents.delete(running.id);
            updateWidget();
            selectCompletionApi(pi, runtime.pi).sendMessage(
              {
                customType: "subagent_result",
                content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}${running.worktree ? `\n\n${worktreeLines(running.worktree)}` : ""}`,
                display: true,
                details: {
                  name: running.name,
                  task: running.task,
                  error: err?.message,
                  ...(running.worktree ? { worktree: worktreeDetails(running.worktree) } : {}),
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.` +
                (running.worktree ? `\n\n${worktreeLines(running.worktree)}` : ""),
            },
          ],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            model: running.runtimePlan?.model,
            thinking: running.runtimePlan?.thinking,
            runtimePlan: running.runtimePlan,
            ...(running.worktree ? { worktree: worktreeDetails(running.worktree) } : {}),
            status: "started",
          },
        };
      },

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;
        const name = typeof partialArgs.name === "string" && partialArgs.name ? partialArgs.name : "(unnamed)";
        const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
        const agent = typeof partialArgs.agent === "string" && partialArgs.agent
          ? theme.fg("dim", ` (${partialArgs.agent})`)
          : "";
        const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd
          ? theme.fg("dim", ` in ${partialArgs.cwd}`)
          : "";
        const worktreeHint = partialArgs.worktree === true ? theme.fg("dim", " in worktree") : "";
        let text =
          "▸ " +
          theme.fg("toolTitle", theme.bold(name)) +
          agent +
          cwdHint +
          worktreeHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          const runtime = details?.model
            ? ` — ${details.model}${details.thinking ? ` · ${details.thinking}` : ""}`
            : " — started";
          const worktree = details?.worktree?.branch ? ` · ⎇ ${details.worktree.branch}` : "";
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", runtime + worktree),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagent_interrupt tool ──
  if (shouldRegister("subagent_interrupt"))
    pi.registerTool({
      name: "subagent_interrupt",
      label: "Interrupt Subagent",
      description:
        "Send Escape to the active turn of a currently running Pi-backed subagent. " +
        "The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement " +
        "and does not emit a subagent_result solely because of this request.",
      promptSnippet:
        "Send Escape to the active turn of a currently running Pi-backed subagent. " +
        "The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement " +
        "and does not emit a subagent_result solely because of this request.",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Exact running subagent id" })),
        name: Type.Optional(Type.String({ description: "Exact running subagent display name" })),
      }),

      async execute(_toolCallId, params) {
        // Runtime children: the correlated request must be accepted before the interrupt is reported.
        const resolved = resolveInterruptTarget(params);
        if (!("error" in resolved) && resolved.running.handle) {
          try {
            await subagentRuntime().interrupt(resolved.running.handle);
          } catch (error) {
            const message = `Failed to interrupt subagent "${resolved.running.name}": ${error instanceof Error ? error.message : String(error)}`;
            return {
              content: [{ type: "text" as const, text: message }],
              details: { error: message, id: resolved.running.id, name: resolved.running.name },
            };
          }
          return handleSubagentInterrupt(params, () => {});
        }
        return handleSubagentInterrupt(params);
      },

      renderCall(args, theme) {
        const target = args.id ? `${args.id}` : args.name ?? "(unknown)";
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(target)) +
            theme.fg("dim", " — interrupt turn"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        if (details?.status === "interrupt_requested") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? details.id ?? "subagent")) +
              theme.fg("dim", " — interrupt requested"),
            0,
            0,
          );
        }

        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagents_list tool ──
  if (shouldRegister("subagents_list"))
    pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      description:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      promptSnippet:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      parameters: Type.Object({}),

      async execute() {
        const list = discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation && isPiAgent(agent));

        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.model ? ` [${a.model}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    });



  // ── subagent_resume tool ──
  if (shouldRegister("subagent_resume"))
    pi.registerTool({
      name: "subagent_resume",
      label: "Resume Subagent",
      description:
        "Resume a previous sub-agent session in a new herdr pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
        "Use when a sub-agent was cancelled or needs follow-up work.",
      promptSnippet:
        "Resume a previous sub-agent session in a new herdr pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
        "Use when a sub-agent was cancelled or needs follow-up work.",
      parameters: Type.Object({
        sessionPath: Type.String({ description: "Path to the session .jsonl file to resume" }),
        name: Type.Optional(
          Type.String({ description: "Display name for the terminal tab. Default: 'Resume'" }),
        ),
        message: Type.Optional(
          Type.String({
            description: "Optional message to send after resuming (e.g. follow-up instructions)",
          }),
        ),
        autoExit: Type.Optional(
          Type.Boolean({
            description:
              "Whether the resumed session should automatically exit after completing its response. Defaults to true for autonomous follow-up work; set false for interactive resumed sessions.",
          }),
        ),
      }),

      renderCall(args, theme) {
        const name = args.name ?? "Resume";
        const text =
          "▸ " +
          theme.fg("toolTitle", theme.bold(name)) +
          theme.fg("dim", " — resuming session");
        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "Resume";

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        // Fallback
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const name = params.name ?? "Resume";
        const { autoExit, interactive } = resolveResumeLaunchBehavior(params);
        const startTime = Date.now();
        const id = randomBytes(12).toString("hex");

        if (!isTerminalAvailable()) {
          return muxUnavailableResult();
        }

        if (!existsSync(params.sessionPath)) {
          return {
            content: [
              { type: "text", text: `Error: session file not found: ${params.sessionPath}` },
            ],
            details: { error: "session not found" },
          };
        }
        // Never two live children on the same session file.
        const live = [...runningSubagents.values()].find((agent) => agent.sessionFile === params.sessionPath);
        if (live) {
          return {
            content: [
              { type: "text", text: `Error: session is still open in the running subagent "${live.name}".` },
            ],
            details: { error: "session in use", id: live.id },
          };
        }

        // Sessions created in a memo worktree must resume there (or not at all).
        const resumeWorktree = await resolveResumeWorktree(params.sessionPath);
        if (resumeWorktree.error) {
          return {
            content: [{ type: "text", text: `Error: ${resumeWorktree.error}` }],
            details: { error: resumeWorktree.error },
          };
        }
        const worktree = resumeWorktree.worktree;

        // Record entry count before resuming so we can extract new messages
        const entryCountBefore = getNewEntries(params.sessionPath, 0).length;

        // The resumed child keeps the session's own model/thinking (as `pi --session` would) when that
        // model is still available; otherwise the parent's model (pi would fall back too).
        const observed = findObservedSessionRuntime(getNewEntries(params.sessionPath, 0));
        const parentThinking = pi.getThinkingLevel();
        const sessionModel = observed.provider && observed.modelId
          ? ctx.modelRegistry.find(observed.provider, observed.modelId)
          : undefined;
        const sessionModelUsable = !!sessionModel &&
          (ctx.modelRegistry.hasConfiguredAuth?.(sessionModel) ?? true);
        const model = sessionModelUsable
          ? `${observed.provider}/${observed.modelId}`
          : ctx.model
            ? `${ctx.model.provider}/${ctx.model.id}`
            : undefined;
        if (!model) {
          return {
            content: [{ type: "text", text: "Error: cannot determine the model of the resumed session." }],
            details: { error: "unknown model" },
          };
        }
        const thinking = sessionModelUsable && (THINKING_LEVELS as readonly string[]).includes(observed.thinking ?? "")
          ? (observed.thinking as ThinkingLevel)
          : (parentThinking as ThinkingLevel);
        // pi runs a resumed session in its header's cwd: the child must be launched there.
        const resumeCwd = realPathOr(worktree?.cwd ?? sessionHeaderCwd(params.sessionPath) ?? ctx.cwd);
        const localAgentDir = join(resumeCwd, ".pi", "agent");
        let handle: AgentHandle;
        try {
          handle = await subagentRuntime().launch({
            scope: ctx.sessionManager.getSessionId(),
            agentId: id,
            attempt: 1,
            taskId: "task-1",
            prompt: params.message ?? "",
            cwd: resumeCwd,
            model,
            thinking,
            isolation: "profile",
            agentDir: existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir(),
            userInput: "allowed",
            exit: autoExit ? "auto" : "tool",
            session: { kind: "file", path: params.sessionPath },
            env: subagentEnv({ name, id }),
            placement: surfacePlacement(),
            display: { label: name },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: `Error: resume failed: ${message}` }],
            details: { error: message },
          };
        }
        if (params.message) setPaneTask(handle.paneId, params.message);

        // Register as a running subagent for widget tracking
        const running: RunningSubagent = {
          id,
          name,
          task: params.message ?? "resumed session",
          surface: handle.paneId,
          handle,
          startTime,
          sessionFile: params.sessionPath,
          entryCountBefore,
          interactive,
          runtimePlan: undefined,
          lifecycle: createLifecycle(startTime),
          ...(worktree ? { worktree } : {}),
        };
        runningSubagents.set(id, running);
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget watcher
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        watchSubagent(running, watcherAbort.signal)
          .then(async (result) => {
            if (!shouldDeliverSubagentCompletion(running)) {
              running.lifecycle = markDelivery(running.lifecycle, "suppressed");
              runningSubagents.delete(running.id);
              updateWidget();
              return;
            }
            running.lifecycle = markDelivery(running.lifecycle, "delivered");
            runningSubagents.delete(running.id);
            updateWidget();
            const completionApi = selectCompletionApi(pi, runtime.pi);
            const worktreeReport = running.worktree
              ? await describeWorktreeForResult(running.worktree)
              : undefined;

            if (result.ping) {
              const sessionRef = `\n\nSession: ${params.sessionPath}\nResume: pi --session ${params.sessionPath}`;
              completionApi.sendMessage(
                {
                  customType: "subagent_ping",
                  content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${worktreeReport ? `\n\n${worktreeReport.text}` : ""}${sessionRef}`,
                  display: true,
                  details: {
                    name: result.ping.name,
                    message: result.ping.message,
                    sessionFile: params.sessionPath,
                    ...(worktreeReport ? { worktree: worktreeReport.details } : {}),
                  },
                },
                { triggerTurn: true, deliverAs: "steer" },
              );
              return;
            }

            const allEntries = getNewEntries(params.sessionPath, entryCountBefore);
            const summary = findLastAssistantMessage(allEntries) ??
              (result.errorMessage
                ? `Subagent error: ${result.errorMessage}`
                : result.exitCode !== 0
                  ? `Resumed session exited with code ${result.exitCode}`
                  : "Resumed session exited without new output");
            const basePresentation = resolveResultPresentation(
              { ...result, summary, sessionFile: params.sessionPath },
              name,
            );
            const runtimePresentation = running.runtimePlan?.runtimeMismatch
              ? `${basePresentation}\n\nRuntime warning: ${running.runtimePlan.runtimeMismatch}`
              : basePresentation;
            const presentation = worktreeReport
              ? insertBeforeSessionRef(runtimePresentation, worktreeReport.text)
              : runtimePresentation;

            completionApi.sendMessage(
              {
                customType: "subagent_result",
                content: presentation,
                display: true,
                details: {
                  name,
                  task: params.message ?? "resumed session",
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: params.sessionPath,
                  ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
                  ...(running.runtimePlan ? { runtimePlan: running.runtimePlan } : {}),
                  ...(worktreeReport ? { worktree: worktreeReport.details } : {}),
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((err) => {
            if (!shouldDeliverSubagentCompletion(running)) {
              running.lifecycle = markDelivery(running.lifecycle, "suppressed");
              runningSubagents.delete(running.id);
              updateWidget();
              return;
            }
            running.lifecycle = markDelivery(running.lifecycle, "delivered");
            runningSubagents.delete(running.id);
            updateWidget();
            selectCompletionApi(pi, runtime.pi).sendMessage(
              {
                customType: "subagent_result",
                content: `Resume error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        return {
          content: [
            {
              type: "text",
              text: `Session "${name}" resumed.${worktree ? `\n\n${worktreeLines(worktree)}` : ""}`,
            },
          ],
          details: {
            id,
            name,
            sessionPath: params.sessionPath,
            ...(worktree ? { worktree: worktreeDetails(worktree) } : {}),
            status: "started",
          },
        };
      },
    });

  // ── subagent_worktrees tool ──
  if (shouldRegister("subagent_worktrees"))
    pi.registerTool({
      name: "subagent_worktrees",
      label: "Subagent Worktrees",
      description:
        "List or remove git worktrees created by subagent (worktree: true). " +
        "list: registry records cross-checked with git (branch, commits ahead of base, dirty, in use). " +
        "remove: git worktree remove without --force; refuses worktrees that are in use, locked, dirty, have untracked files or an operation in progress. " +
        "deleteBranch uses git branch -d, which keeps unmerged branches. Never merges.",
      promptSnippet:
        "List or remove git worktrees created by subagent (worktree: true). Removal is never forced; deleteBranch uses git branch -d.",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("list"), Type.Literal("remove")], {
          description: "list or remove",
        }),
        id: Type.Optional(Type.String({ description: "remove: worktree id (from list or subagent details.worktree.id; unique prefix allowed)" })),
        path: Type.Optional(Type.String({ description: "remove: worktree path (alternative to id)" })),
        deleteBranch: Type.Optional(
          Type.Boolean({ description: "remove: also delete the branch with git branch -d (kept if not merged). Default false." }),
        ),
        all: Type.Optional(
          Type.Boolean({ description: "list: include every repository (default: only the repository of the current directory)" }),
        ),
      }),

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        if (params.action === "remove") {
          const result = await removeWorktreeEntry(params);
          return { content: [{ type: "text", text: result.text }], details: { action: "remove", ...result.details } };
        }
        const entries = await listWorktreeEntries({ cwd: ctx.cwd, all: params.all });
        const text = entries.length === 0
          ? "No pi-memo-subagents worktrees found."
          : entries.map(formatWorktreeEntry).join("\n");
        return {
          content: [{ type: "text", text }],
          details: {
            action: "list",
            worktrees: entries.map(({ record, state, inUse }) => ({ ...record, state, inUse })),
          },
        };
      },
    });

  pi.registerCommand("subagent-worktrees", {
    description: "List and remove git worktrees created by subagents",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const entries = await listWorktreeEntries({ cwd: ctx.cwd });
      if (entries.length === 0) {
        ctx.ui.notify("No pi-memo-subagents worktrees for this repository", "info");
        return;
      }
      const labels = entries.map(formatWorktreeEntry);
      const selected = await ctx.ui.select("Subagent worktrees", labels);
      if (!selected) return;
      const entry = entries[labels.indexOf(selected)];
      if (!entry) return;
      const keep = "Remove worktree (keep branch)";
      const drop = "Remove worktree and delete branch if merged (git branch -d)";
      const action = await ctx.ui.select(`${entry.record.branch} @ ${entry.record.path}`, [keep, drop, "Cancel"]);
      if (action !== keep && action !== drop) return;
      const confirmed = await ctx.ui.confirm("Remove worktree?", `${entry.record.path}\n(never forced)`);
      if (!confirmed) return;
      const result = await removeWorktreeEntry({ id: entry.record.id, deleteBranch: action === drop });
      ctx.ui.notify(result.text, result.ok ? "info" : "warning");
    },
  });

  // User-only layout selector: no model turn and no changes to child lifecycle. Lists this session's
  // subagents and the other runtime agents of this process beside the main pane (e.g. Issue Round).
  // `cycle`: no menu, show the agent after the visible one (wrapping around; the first when none is visible).
  const selectSubagentView = async (args: string, ctx: ExtensionContext, cycle = false) => {
    if (ctx.mode !== "tui" || !isTerminalAvailable()) {
      ctx.ui.notify("Subagent view requires Pi running interactively inside Herdr", "warning");
      return;
    }
    const choices = selectorChoices();
    if (choices.length === 0) {
      ctx.ui.notify("No open agents to display", "info");
      return;
    }
    try {
      const visible = paneSelector.visible();
      let chosen: SelectorChoice | undefined;
      const query = args.trim();
      if (query) {
        const matches = choices.filter((choice) => choice.running?.id === query || choice.name === query);
        if (matches.length !== 1) {
          ctx.ui.notify("Use /subagent to pick an open agent", "warning");
          return;
        }
        chosen = matches[0];
      } else if (cycle) {
        const current = choices.findIndex((choice) => choice.paneId === visible);
        if (current !== -1 && choices.length === 1) {
          ctx.ui.notify(`${choices[0].label} is the only open agent`, "info");
          return;
        }
        chosen = choices[(current + 1) % choices.length];
      } else {
        const labels = choices.map((choice) => `${choice.paneId === visible ? "▶ " : "  "}${choice.label}`);
        const selected = await ctx.ui.select("Subagents — choose the terminal shown on the right", labels);
        if (!selected) return;
        chosen = choices[labels.indexOf(selected)];
      }
      const stillOpen = chosen?.running
        ? runningSubagents.get(chosen.running.id) === chosen.running
        : !!chosen && paneSelector.state.owned.has(chosen.paneId);
      if (!chosen || !stillOpen) {
        ctx.ui.notify("This agent has already finished", "info");
        return;
      }
      if (chosen.running) paneSelector.state.owned.set(chosen.paneId, chosen.name);
      await paneSelector.select(chosen.paneId);
      syncSelectorHandles();
      updateWidget();
    } catch (error) {
      ctx.ui.notify(`Unable to switch subagent: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };
  pi.registerShortcut("ctrl+alt+x", {
    description: "Cycle the visible subagent terminal",
    handler: (ctx) => selectSubagentView("", ctx, true),
  });

  // /iterate command — fork the session into a subagent
  pi.registerCommand("iterate", {
    description: "Fork session into a subagent for focused work (bugfixes, iteration)",
    handler: async (args, _ctx) => {
      const task = args.trim() || "";
      const toolCall = task
        ? `Use subagent to fork an interactive session. fork: true, interactive: true, name: "Iterate", task: ${JSON.stringify(task)}`
        : `Use subagent to fork an interactive session. fork: true, interactive: true, name: "Iterate", task: "The user wants to do some hands-on work. Help them with whatever they need."`;
      pi.sendUserMessage(toolCall);
    },
  });

  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Choose an open subagent, or spawn one: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        await selectSubagentView("", ctx);
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
        const failed = exitCode !== 0 || !!errorMessage;
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const icon = failed
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
        const status = errorMessage
          ? "failed (provider/agent error)"
          : failed
            ? `failed (exit ${exitCode})`
            : "completed";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";

        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
        const rawContent = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove session ref, worktree block and leading label for display)
        const worktreeBlock = details.worktree ? extractWorktreeBlock(rawContent) : undefined;
        const summary = (worktreeBlock ? rawContent.replace(worktreeBlock, "") : rawContent)
          .replace(/\n\nSession: .+\nResume: .+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
          .replace(
            new RegExp(
              `^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`,
            ),
            "",
          );

        // Build content for the box
        const contentLines = [header];

        if (options.expanded) {
          // Full view: complete summary + session info
          if (summary) {
            for (const line of summary.split("\n")) {
              contentLines.push(line.slice(0, width - 6));
            }
          }
          if (worktreeBlock) {
            contentLines.push("");
            for (const line of worktreeBlock.trim().split("\n")) {
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
          }
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
            contentLines.push(theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`));
          }
        } else {
          // Collapsed: preview + expand hint
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
            }
          }
          if (details.worktree?.branch) {
            contentLines.push(theme.fg("dim", formatWorktreeBadge(details.worktree).slice(0, width - 6)));
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_status message renderer ──
  pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
    const details = message.details as any;
    const lines = Array.isArray(details?.lines) ? details.lines : [];
    const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;

    return {
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [
          `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
          ...lines.map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))),
        ];

        if (overflow > 0) {
          contentLines.push(theme.fg("muted", `+${overflow} more running.`));
        }
        if (!options.expanded) {
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_ping message renderer ──
  pi.registerMessageRenderer("subagent_ping", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "?");
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— needs help")}`;

        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("");
          contentLines.push(details.message ?? "");
          if (details.worktree?.branch) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", formatWorktreeBadge(details.worktree)));
          }
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
          }
        } else {
          const preview = (details.message ?? "").split("\n")[0].slice(0, width - 10);
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });


}
