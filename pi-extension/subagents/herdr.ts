import { execFile, execSync, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  if (process.platform === "win32") {
    try {
      execFileSync("where.exe", [command], { stdio: "ignore" });
      available = true;
    } catch {
      try {
        execSync(`command -v ${command}`, { stdio: "ignore" });
        available = true;
      } catch {
        available = false;
      }
    }
  } else {
    try {
      execSync(`command -v ${command}`, { stdio: "ignore" });
      available = true;
    } catch {
      available = false;
    }
  }

  commandAvailability.set(command, available);
  return available;
}

export function isHerdrAvailable(): boolean {
  return process.env.HERDR_ENV === "1" && hasCommand("herdr");
}

function parseHerdrJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractHerdrPaneId(output: string, context: string): string {
  const parsed = parseHerdrJson(output);
  const paneId = (parsed as { result?: { pane?: { pane_id?: unknown } } })?.result?.pane?.pane_id;
  if (typeof paneId !== "string" || !paneId) {
    throw new Error(`Unexpected herdr ${context} output: ${output.trim() || "(empty)"}`);
  }
  return paneId;
}

function extractHerdrRootPaneId(output: string, context: string): string {
  const parsed = parseHerdrJson(output);
  const paneId = (parsed as { result?: { root_pane?: { pane_id?: unknown } } })?.result?.root_pane
    ?.pane_id;
  if (typeof paneId !== "string" || !paneId) {
    throw new Error(`Unexpected herdr ${context} output: ${output.trim() || "(empty)"}`);
  }
  return paneId;
}

function herdrExec(args: string[]): string {
  return execFileSync("herdr", args, { encoding: "utf8" });
}

async function herdrExecAsync(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("herdr", args, { encoding: "utf8" });
  return stdout;
}

function getHerdrParentPaneId(): string {
  const paneId = process.env.HERDR_PANE_ID;
  if (!paneId) {
    throw new Error("HERDR_PANE_ID not set");
  }
  return paneId;
}

function getHerdrCurrentPaneInfo(): {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
} {
  const paneId = process.env.HERDR_PANE_ID;
  const tabId = process.env.HERDR_TAB_ID;
  const workspaceId = process.env.HERDR_WORKSPACE_ID;

  // Fall back to `herdr pane current` if any identity env var is missing —
  // older herdr versions may not set all three.
  if (!paneId || !tabId || !workspaceId) {
    const output = herdrExec(["pane", "current"]);
    const parsed = parseHerdrJson(output);
    const pane = (parsed as { result?: { pane?: unknown } } | null)?.result?.pane as
      | { pane_id?: string; tab_id?: string; workspace_id?: string }
      | undefined;
    if (!pane?.pane_id || !pane?.tab_id || !pane?.workspace_id) {
      throw new Error(`Unexpected herdr pane current output: ${output.trim() || "(empty)"}`);
    }
    return {
      pane_id: pane.pane_id,
      tab_id: pane.tab_id,
      workspace_id: pane.workspace_id,
    };
  }

  return { pane_id: paneId, tab_id: tabId, workspace_id: workspaceId };
}

function buildTabCreateArgs(name: string, cwd: string, workspaceId: string): string[] {
  return [
    "tab",
    "create",
    "--workspace",
    workspaceId,
    "--label",
    name,
    "--cwd",
    cwd,
    "--no-focus",
  ];
}

export function createHerdrSurface(name: string, cwd: string = process.cwd()): string {
  // Create a new tab per subagent so parallel spawns each get a full tab
  // instead of ever-narrower splits of the parent pane. Target the current
  // workspace explicitly because Herdr's implicit default may be another space.
  const { workspace_id: workspaceId } = getHerdrCurrentPaneInfo();
  const output = herdrExec(buildTabCreateArgs(name, cwd, workspaceId));
  const paneId = extractHerdrRootPaneId(output, "tab create");
  try {
    herdrExec(["pane", "rename", paneId, name]);
  } catch {
    // Optional — pane label is cosmetic.
  }
  return paneId;
}

export function createHerdrSurfaceSplit(
  name: string,
  direction: "right" | "down",
  cwd: string = process.cwd(),
): string {
  const parentPaneId = getHerdrParentPaneId();
  const output = herdrExec([
    "pane",
    "split",
    parentPaneId,
    "--direction",
    direction,
    "--no-focus",
    "--cwd",
    cwd,
  ]);
  const paneId = extractHerdrPaneId(output, "pane split");
  try {
    herdrExec(["pane", "rename", paneId, name]);
  } catch {
    // Optional.
  }
  return paneId;
}

export function readHerdrScreen(surface: string, lines = 50): string {
  // `visible` is reliable for freshly created panes where herdr's `recent`
  // scrollback may not be populated yet.
  return herdrExec(["pane", "read", surface, "--source", "visible", "--lines", String(lines)]);
}

export async function readHerdrScreenAsync(surface: string, lines = 50): Promise<string> {
  return herdrExecAsync(["pane", "read", surface, "--source", "visible", "--lines", String(lines)]);
}

export type { PaneInspection, HerdrAgentStatus } from "./lifecycle.ts";

type PaneInspectionResult =
  | { kind: "present"; agent?: string; agentStatus: "idle" | "working" | "blocked" | "done" | "unknown" }
  | { kind: "missing"; error?: string }
  | { kind: "unavailable"; error: string };

function parsePaneGetOutput(output: string, surface: string): PaneInspectionResult {
  const parsed = parseHerdrJson(output) as
    | { result?: { pane?: unknown }; error?: { code?: unknown; message?: unknown } }
    | null;
  const errorObj = parsed?.error;
  if (errorObj?.code === "pane_not_found" || errorObj?.code === "not_found") {
    return { kind: "missing", error: typeof errorObj.message === "string" ? errorObj.message : "pane not found" };
  }
  const pane = parsed?.result?.pane;
  if (!pane || typeof pane !== "object") return { kind: "unavailable", error: "pane get returned no pane record" };
  const record = pane as { pane_id?: unknown; agent?: unknown; agent_status?: unknown };
  if (record.pane_id !== surface) return { kind: "unavailable", error: "pane id mismatch" };
  const agent = typeof record.agent === "string" ? record.agent : undefined;
  const rawStatus = typeof record.agent_status === "string" ? record.agent_status : "unknown";
  const agentStatus = rawStatus === "idle" ||
      rawStatus === "working" ||
      rawStatus === "blocked" ||
      rawStatus === "done" ||
      rawStatus === "unknown"
    ? rawStatus
    : "unknown";
  return { kind: "present", ...(agent ? { agent } : {}), agentStatus };
}

function parsePaneGetError(error: any): PaneInspectionResult {
  for (const raw of [error?.stderr, error?.stdout]) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    try {
      const parsed = parsePaneGetOutput(raw, "");
      if (parsed.kind === "missing") return parsed;
    } catch {
      // A CLI may emit plain diagnostics on one stream and structured JSON on
      // the other. Parse each stream independently before giving up.
    }
    // Older/alternate Herdr builds may print the stable error code as plain
    // text rather than JSON. Only match explicit identifiers, not generic
    // prose such as "pane unavailable".
    if (/\b(?:pane_not_found|not_found)\b/.test(raw)) {
      return { kind: "missing", error: raw.trim() };
    }
  }
  const message = error?.message ? String(error.message) : "herdr pane get failed";
  return { kind: "unavailable", error: message };
}

/**
 * Structured pane query.
 * - present: pane is reachable; agent/agentStatus may be present when detected
 * - missing: server responded, pane is gone
 * - unavailable: server command failed; caller should keep polling
 */
export async function inspectHerdrPane(surface: string): Promise<PaneInspectionResult> {
  try {
    return parsePaneGetOutput(await herdrExecAsync(["pane", "get", surface]), surface);
  } catch (error: any) {
    return parsePaneGetError(error);
  }
}

export function sendHerdrCommand(surface: string, command: string): void {
  // pane run sends the text and Enter in a single socket request, avoiding
  // a race where Enter could arrive before the text is fully processed.
  herdrExec(["pane", "run", surface, command]);
}

export function sendHerdrEscape(surface: string): void {
  herdrExec(["pane", "send-keys", surface, "Escape"]);
}

export function closeHerdrSurface(surface: string): void {
  herdrExec(["pane", "close", surface]);
}

export function renameHerdrTab(title: string): void {
  const { tab_id: tabId } = getHerdrCurrentPaneInfo();
  herdrExec(["tab", "rename", tabId, title]);
}

export function renameHerdrWorkspace(title: string): void {
  const { workspace_id: workspaceId } = getHerdrCurrentPaneInfo();
  herdrExec(["workspace", "rename", workspaceId, title]);
}

function buildPaneReportTaskArgs(
  paneId: string,
  task: string,
  source = "pi",
): string[] {
  const normalizedTask = task.replace(/[\r\n\t]+/g, " ").trim();
  return [
    "pane",
    "report-metadata",
    paneId,
    "--source",
    source,
    "--token",
    `task=${normalizedTask}`,
  ];
}

export function reportHerdrPaneTask(
  paneId: string,
  task: string,
  source = "pi",
): void {
  const normalizedTask = task.replace(/[\r\n\t]+/g, " ").trim();
  if (!normalizedTask) return;
  try {
    herdrExec(buildPaneReportTaskArgs(paneId, normalizedTask, source));
  } catch {
    // Non-fatal: cosmetic metadata report failure should not abort subagent launch.
  }
}

/** Agents-panel name of a child at `depth` (1 = direct child): "\u2514\u2500 name", "\u250a \u2514\u2500 name", \u2026 */
function treeDisplayName(name: string, depth: number): string {
  const label = name.replace(/[\r\n\t]+/g, " ").trim() || "subagent";
  return `${"\u250a ".repeat(Math.max(0, depth - 1))}\u2514\u2500 ${label}`;
}

function buildPaneTreeArgs(
  paneId: string,
  name: string,
  parentPaneId: string,
  depth: number,
): string[] {
  return [
    "pane",
    "report-metadata",
    paneId,
    "--source",
    "memo-subagents",
    "--display-agent",
    treeDisplayName(name, depth),
    "--token",
    `parent=${parentPaneId}`,
    "--token",
    `tree_depth=${depth}`,
  ];
}

/** Depth of a pane in the subagent tree: its reported `tree_depth` token, else 0 (a root). */
function parsePaneTreeDepth(output: string): number {
  const pane = (parseHerdrJson(output) as { result?: { pane?: { tokens?: Record<string, unknown> } } } | null)
    ?.result?.pane;
  const depth = Number(pane?.tokens?.tree_depth);
  return Number.isSafeInteger(depth) && depth > 0 ? depth : 0;
}

/**
 * Display-only: name the child pane in Herdr's Agents panel as a branch under the
 * calling pane ("\u2514\u2500 scout"), one level deeper than the caller when it is itself
 * a subagent. Never affects identity or lifecycle; failures are ignored.
 */
export function reportHerdrPaneTree(paneId: string, name: string): void {
  const parentPaneId = process.env.HERDR_PANE_ID;
  if (!parentPaneId || parentPaneId === paneId) return;
  let depth = 1;
  try {
    depth = parsePaneTreeDepth(herdrExec(["pane", "get", parentPaneId])) + 1;
  } catch {
    // Unknown parent depth: show as a direct child.
  }
  try {
    herdrExec(buildPaneTreeArgs(paneId, name, parentPaneId, depth));
  } catch {
    // Cosmetic only.
  }
}

export const __herdrTest__ = {
  buildTabCreateArgs,
  buildPaneReportTaskArgs,
  buildPaneTreeArgs,
  parsePaneTreeDepth,
  treeDisplayName,
  parseHerdrJson,
  extractHerdrPaneId,
  extractHerdrRootPaneId,
  parsePaneGetOutput,
  parsePaneGetError,
};
