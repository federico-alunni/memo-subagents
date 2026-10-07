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

function herdrExec(args: string[]): string {
  return execFileSync("herdr", args, { encoding: "utf8" });
}

async function herdrExecAsync(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("herdr", args, { encoding: "utf8" });
  return stdout;
}

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

export function sendHerdrEscape(surface: string): void {
  herdrExec(["pane", "send-keys", surface, "Escape"]);
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

export const __herdrTest__ = {
  buildPaneReportTaskArgs,
  parseHerdrJson,
  parsePaneGetOutput,
  parsePaneGetError,
};
