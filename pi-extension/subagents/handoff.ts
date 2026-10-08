// Delegated spawns: a sub-agent asks the main session to start another agent for it. The request travels
// through the runtime's delegated-tool protocol (the child's `subagent` tool calls the child delegate hook);
// the main session launches, owns and supervises the new agent, and routes its end:
//   delegate: any agent granted `spawning` starts helpers in a column under it; each result is delivered to
//             the requester as its next task (planner -> research / challenger -> researcher -> ...);
//   wait:     a worktree-space agent starts an agent in its own space and waits for its result the same way;
//   replace:  a worktree-space agent hands its work over and ends; the main session receives only the final
//             result of the slot (chain in details).
import { randomUUID } from "node:crypto";

export const SPAWN_TOOL = "subagent_spawn";

export type HandoffMode = "wait" | "replace";
export type SpawnMode = "delegate" | HandoffMode;

/** Declared (internal, never a model tool) in the policy of worktree-space agents and agents granted spawning. */
export const SPAWN_SPEC = {
  name: SPAWN_TOOL,
  label: "Spawn",
  description: "Internal transport of delegated sub-agent spawns (the subagent tool of a child).",
  parameters: { type: "object" },
  internal: true as const,
  // The main session launches the new agent (a pane, a profile) before answering.
  timeoutMs: 180000,
};


/** The child's delegate hook (runtime/child/extension.ts), shared through globalThis. */
export interface ChildDelegateHookLike {
  request(tool: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  holdAutoExit(): void;
  end(kind: "replace", extra?: { summary?: string }): Promise<void>;
}
export function childDelegateHook(): ChildDelegateHookLike | undefined {
  return (globalThis as Record<symbol, ChildDelegateHookLike | undefined>)[Symbol.for("pi-memo-subagents/child-delegate-hook")];
}

export interface SpawnRequest {
  mode: SpawnMode;
  /** The `subagent` tool arguments of the new agent (name, task, agent, model, thinking, ...). */
  spawn: Record<string, unknown>;
}


/** The part of a result the handoff messages need. */
export interface HandoffResult {
  name: string;
  task?: string;
  summary: string;
  sessionFile?: string;
  exitCode: number;
  elapsed: number;
  errorMessage?: string;
}

interface ParentLike {
  id: string;
  handle?: any;
}

interface RuntimeLike {
  dispatch(h: any, task: { taskId: string; prompt: string }): Promise<any>;
}

const formatElapsed = (seconds: number) =>
  seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

/** The text A receives (wait) or the main session sees (replace) for B's outcome. */
export function handoffResultText(result: HandoffResult, name = result.name): string {
  const sessionRef = result.sessionFile ? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}` : "";
  if (result.errorMessage)
    return `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} (provider/agent error).\n\nError: ${result.errorMessage}${sessionRef}`;
  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;
}

const isBusy = (error: unknown) => (error as { code?: string } | undefined)?.code === "busy";

/**
 * wait: B ended, give its result to A as A's next task. A may still be finishing the turn in which it
 * started B, so a `busy` refusal (previous task not settled) is retried; the parent's handle is replaced
 * by the new task's, as for any dispatch.
 */
export async function deliverHandoffResult(
  runtime: RuntimeLike,
  parent: ParentLike,
  result: HandoffResult,
  name: string,
  options: { retryMs?: number; attempts?: number } = {},
): Promise<void> {
  const prompt =
    `${handoffResultText(result, name)}\n\n` +
    "This is the result of a sub-agent you started (other results, if any, arrive as separate tasks). Continue your work with it.";
  const taskId = `handoff-${randomUUID().slice(0, 8)}`;
  const attempts = options.attempts ?? 120;
  for (let attempt = 1; ; attempt++) {
    try {
      parent.handle = await runtime.dispatch(parent.handle, { taskId, prompt });
      return;
    } catch (error) {
      if (!isBusy(error) || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, options.retryMs ?? 1000));
    }
  }
}

/** replace: the slot's final result goes to the main session, with the chain of agents in `details`. */
export function deliverReplacedResult(
  pi: { sendMessage(message: any, options: any): void },
  input: {
    slot: { id: string; name: string; chain: string[] };
    result: HandoffResult;
    parentSummary?: string;
    agent?: string;
    extra?: Record<string, unknown>;
  },
): void {
  const { slot, result } = input;
  const chain = slot.chain.join(" › ");
  const text =
    `Sub-agent chain ${chain}: ` +
    handoffResultText(result) +
    (input.parentSummary ? `\n\nHanded off by "${slot.chain[0]}": ${input.parentSummary}` : "");
  pi.sendMessage(
    {
      customType: "subagent_result",
      content: text,
      display: true,
      details: {
        name: result.name,
        task: result.task,
        agent: input.agent,
        exitCode: result.exitCode,
        elapsed: result.elapsed,
        sessionFile: result.sessionFile,
        chain: slot.chain,
        ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
        ...(input.extra ?? {}),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

/** A replaced parent ended by a handoff: its completion is not delivered to the model. */
export function shouldSuppressDelivery(running: { replacedBy?: string }): boolean {
  return typeof running.replacedBy === "string";
}

interface ServerOptions {
  /** Launch the requested agent for `parent`; resolves with its identity. */
  launch(parent: any, request: SpawnRequest): Promise<{ id: string }>;
  runtime: {
    hasResponse(h: any, requestId: string): Promise<boolean>;
    respond(h: any, requestId: string, result: unknown): Promise<void>;
  };
}

/**
 * Serves the spawn requests found in an observation of an agent. Each request id is served once (`seen`
 * survives /reload with the running entry); a failed launch answers with the error so the child never waits
 * for a response that cannot come. Other tools' requests are not ours.
 */
export function createSpawnServer(options: ServerOptions) {
  return async (
    parent: ParentLike,
    requests: { requestId?: string; tool?: string; params?: unknown }[],
    seen: Set<string>,
  ): Promise<void> => {
    for (const request of requests) {
      if (request.tool !== SPAWN_TOOL || typeof request.requestId !== "string") continue;
      if (seen.has(request.requestId)) continue;
      seen.add(request.requestId);
      let result: unknown;
      try {
        if (await options.runtime.hasResponse(parent.handle, request.requestId)) continue;
        const launched = await options.launch(parent, request.params as SpawnRequest);
        result = { launched: true, id: launched.id };
      } catch (error) {
        result = { error: error instanceof Error ? error.message : String(error) };
      }
      await options.runtime.respond(parent.handle, request.requestId, result).catch(() => {});
    }
  };
}
