import { hostChildEnv, hostChildExtensions } from "../child-host.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface RunInput {
  executable: string;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}
export interface RunResult {
  stdout: string;
  stderr?: string;
  exitCode: number;
}
/** Every external command of the runtime (herdr, pi, ps) goes through a Runner: no shell, bounded. */
export type Runner = (input: RunInput) => Promise<RunResult>;
const exec = promisify(execFile);
export const nodeRunner: Runner = async ({
  executable,
  argv,
  cwd,
  env,
  timeoutMs = 5000,
}) => {
  try {
    const result = await exec(executable, argv, {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const e = error as {
      code?: unknown;
      stdout?: string;
      stderr?: string;
      message: string;
    };
    if (typeof e.code !== "number") throw error;
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message,
      exitCode: e.code,
    };
  }
};

/** One read-only OS snapshot binds a controlling terminal to process start/command identity. */
export function terminalName(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Process terminal unavailable");
  const tty = value.trim().replace(/^\/dev\//, "");
  if (
    !tty ||
    !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(tty) ||
    tty.split("/").some((part) => part === "." || part === "..") ||
    ["none", "unknown"].includes(tty.toLowerCase())
  )
    throw new Error("Process terminal unavailable or invalid");
  return tty;
}
export async function readProcessTerminal(
  runner: Runner,
  pid: number,
  timeoutMs = 5000,
): Promise<{ tty: string; identity: string }> {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("Invalid terminal process PID");
  const r = await runner({
    executable: "ps",
    argv: ["-p", String(pid), "-o", "tty=", "-o", "lstart=", "-o", "command="],
    timeoutMs,
  });
  const line = r.stdout.trim();
  if (r.exitCode !== 0 || !line || /[\r\n]/.test(line))
    throw new Error("OS process terminal snapshot unavailable");
  const match = /^(\S+)\s+(.+)$/.exec(line);
  if (!match || !match[2].trim())
    throw new Error("OS process terminal identity missing");
  return { tty: terminalName(match[1]), identity: match[2].trim() };
}
/** Process start/command identity, or undefined when the PID is gone. */
export async function processIdentity(
  runner: Runner,
  pid: number,
  timeoutMs = 5000,
): Promise<string | undefined> {
  const r = await runner({
    executable: "ps",
    argv: ["-p", String(pid), "-o", "lstart=", "-o", "command="],
    timeoutMs,
  });
  if (r.exitCode === 1 && !r.stdout.trim() && !r.stderr?.trim())
    return undefined;
  if (r.exitCode !== 0 || !r.stdout.trim())
    throw new Error("Process identity unavailable");
  return r.stdout.trim();
}

/** Host composition declared with MEMO_SUBAGENTS_CHILD_EXTENSIONS / MEMO_SUBAGENTS_CHILD_ENV (see docs/child-host.md). */
export function hostCompositionFromEnv(env: NodeJS.ProcessEnv = process.env): {
  hostExtensions: string[];
  hostEnv: Record<string, string>;
} {
  return {
    hostExtensions: hostChildExtensions(env),
    hostEnv: Object.fromEntries(hostChildEnv(env)),
  };
}
