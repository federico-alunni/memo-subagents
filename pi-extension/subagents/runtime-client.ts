// The subagent tool as a client of the agent runtime (docs/runtime.md): one shared AgentRuntime per
// process, and a supervisor that turns runtime observations into the subagent result.
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  hostCompositionFromEnv,
} from "./runtime/index.ts";
import type {
  AgentHandle,
  ChildRecord,
  Observation,
  RuntimeConfig,
} from "./runtime/index.ts";

const INSTANCE_KEY = Symbol.for("pi-memo-subagents/subagent-runtime");

/**
 * Private evidence root of generic subagents: per user, outside any project checkout (a child may run in
 * the home directory). Children do not survive a reboot, and resume never needs old evidence.
 */
export function subagentStateDir(): string {
  return join(tmpdir(), `pi-memo-subagents-${process.getuid?.() ?? "user"}`);
}

export function subagentRuntimeConfig(): RuntimeConfig {
  return {
    stateDir: subagentStateDir(),
    ...hostCompositionFromEnv(),
    // A profile child loads every extension of the user's profile (and may ask the user, e.g. project
    // trust in a new worktree) before it reports ready.
    startupTimeoutMs: 120000,
  };
}

/** The process-wide runtime of the subagent tool (survives /reload with the running entries). */
export function subagentRuntime(): AgentRuntime {
  const store = globalThis as unknown as Record<symbol, AgentRuntime | undefined>;
  return (store[INSTANCE_KEY] ??= new AgentRuntime(subagentRuntimeConfig()));
}

/** Test hook: replace the process-wide runtime. */
export function setSubagentRuntime(runtime: AgentRuntime | undefined): void {
  (globalThis as unknown as Record<symbol, AgentRuntime | undefined>)[INSTANCE_KEY] = runtime;
}

export type SupervisedEnd =
  /** The child ended itself (subagent_done or auto exit after a normal run). */
  | { kind: "done"; exit: ChildRecord }
  /** caller_ping: the child asks the parent for help and exited. */
  | { kind: "ping"; message: string; exit: ChildRecord }
  /** The run failed (provider error after retries). */
  | { kind: "error"; errorMessage: string; exit: ChildRecord }
  /** The user quit pi in the child pane, or closed the pane. */
  | { kind: "ended"; reason: "user-quit" | "pane-closed" }
  /** The child process ended without an exit record or an orderly pi shutdown (crash, kill). */
  | { kind: "crashed" }
  /** The parent session stopped supervising (quit, cancel). */
  | { kind: "cancelled" };

export interface SupervisedOutcome {
  end: SupervisedEnd;
  /** The child's pane was closed by the runtime after the end (proven). */
  closed: boolean;
  closeError?: string;
}

function exitEnd(exit: ChildRecord): SupervisedEnd {
  if (exit.reason === "ping") return { kind: "ping", message: exit.message ?? "", exit };
  if (exit.reason === "error")
    return { kind: "error", errorMessage: exit.error || "Subagent run failed", exit };
  return { kind: "done", exit };
}

/** Map one observation to the end of the subagent, or undefined while it is still running. */
export function subagentEnd(o: Observation): SupervisedEnd | undefined {
  const exit = o.exit;
  if (exit && (o.kind === "stopped" || o.kind === "missing" || (o.kind === "unavailable" && o.exited)))
    return exitEnd(exit);
  if (exit) return undefined; // exiting: wait for the observed process exit
  if (o.kind === "unavailable" && o.exited) return { kind: "ended", reason: "user-quit" };
  if (o.kind === "stopped") return { kind: "ended", reason: "user-quit" };
  if (o.kind === "missing") return { kind: "ended", reason: "pane-closed" };
  return undefined;
}

/**
 * Observe a subagent until it ends, then close its pane through the runtime (never forced).
 * `handle()` returns the current handle: the pane selector may replace it after a move.
 */
export async function superviseSubagent(options: {
  runtime: AgentRuntime;
  handle: () => AgentHandle;
  signal: AbortSignal;
  intervalMs?: number;
  onObservation?: (o: Observation, handle: AgentHandle) => void;
}): Promise<SupervisedOutcome> {
  const { runtime, signal } = options;
  const interval = options.intervalMs ?? 1000;
  let end: SupervisedEnd | undefined;
  while (!signal.aborted) {
    const handle = options.handle();
    const o = await runtime.observe(handle);
    if (signal.aborted) break;
    options.onObservation?.(o, handle);
    end = subagentEnd(o);
    if (!end && o.kind === "changed") {
      // The pane no longer matches the handle (e.g. moved outside the runtime): never loop forever,
      // end the supervision once the exact child process is gone.
      try {
        const shutdown = await runtime.inspectShutdown(handle);
        if (shutdown.exited) end = o.exit ? exitEnd(o.exit) : { kind: "ended", reason: "user-quit" };
      } catch {
        // Unobservable now; try again on the next tick.
      }
    }
    if (end?.kind === "ended" && end.reason === "user-quit") {
      // A user who quits pi leaves an orderly session_shutdown in the activity; a crash does not.
      const activity = runtime.activity(handle);
      if (!(activity.ok && activity.activity.latestEvent === "session_shutdown")) end = { kind: "crashed" };
    }
    if (end) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, interval);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  if (!end) {
    // Parent stops supervising: retire a settled, idle child cleanly; a busy child keeps its pane.
    try {
      await runtime.stop(options.handle());
      await runtime.close(options.handle());
    } catch {
      // Not settled or not owned any more: leave the pane to the user.
    }
    return { end: { kind: "cancelled" }, closed: false };
  }
  if (end.kind === "ended" && end.reason === "pane-closed") {
    runtime.forget(options.handle());
    return { end, closed: true };
  }
  try {
    await runtime.close(options.handle());
    return { end, closed: true };
  } catch (error) {
    runtime.forget(options.handle());
    return { end, closed: false, closeError: error instanceof Error ? error.message : String(error) };
  }
}
