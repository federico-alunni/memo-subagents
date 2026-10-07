/**
 * Bash decision of a runtime child with `bash: "readonly"`: the read-only list, the agent's extra
 * prefixes (`bashAllow`) and, for user-driven children with `bashAsk`, a question to the user in the
 * child's pane. "Always" answers live only in this child process (never on disk).
 */
import type { ChildPolicy } from "../protocol.ts";
import { allowedExtraCommand, plainArgv, readonlyBashRejection, readonlyCommand } from "./readonly-bash.ts";

export type BashDecision = "allow" | "ask" | "block";
export type BashPolicyFields = Pick<ChildPolicy, "bash" | "bashAllow" | "bashAsk">;
export type BashBlock = { block: true; reason: string };

/**
 * Pure decision for one bash call. `sessionAllow` holds the prefixes the user allowed "always" in this
 * child process (used only with `bashAsk`). Only a plain argv (no shell grammar) is ever asked; everything else is blocked.
 */
export function bashDecision(
  policy: BashPolicyFields,
  command: unknown,
  sessionAllow: readonly string[] = [],
): BashDecision {
  if (policy.bash !== "readonly") return "allow";
  if (typeof command !== "string") return "block";
  if (
    readonlyCommand(command) ||
    allowedExtraCommand(command, policy.bashAllow ?? []) ||
    // "Always" answers exist only where the user is asked.
    (policy.bashAsk === true && allowedExtraCommand(command, sessionAllow))
  )
    return "allow";
  return policy.bashAsk === true && plainArgv(command) ? "ask" : "block";
}

/** Prefix an "always" answer covers: the first two words of the command, or its only word. */
export function sessionAllowPrefix(command: string): string | undefined {
  const argv = plainArgv(command);
  return argv ? argv.slice(0, 2).join(" ") : undefined;
}

/** Rejection shown to the model: the read-only hint plus the extra allowed prefixes. */
export function readonlyBlockReason(policy: BashPolicyFields, sessionAllow: readonly string[] = []): string {
  const extra = [...(policy.bashAllow ?? []), ...(policy.bashAsk === true ? sessionAllow : [])];
  return readonlyBashRejection("Read-only agent") + (extra.length ? ` Also allowed: ${extra.join("; ")}.` : "");
}

/** Options of the bash question, in this order: the safe default (deny) comes first. */
export const BASH_ASK_OPTIONS = {
  deny: "Rifiuta",
  once: "Permetti una volta",
  always: "Permetti sempre in questa sessione dell'agente",
} as const;

export function bashAskTitle(command: string, prefix: string): string {
  return `Il subagente vuole eseguire: ${command}   («sempre» vale per i comandi che iniziano con "${prefix}")`;
}

/** The part of pi's tool_call context the question needs. */
export interface BashAskContext {
  hasUI: boolean;
  ui: { select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined> };
  signal?: AbortSignal;
}

/**
 * Per-process bash approvals: "always" prefixes and the question flow. Questions are asked one at a
 * time, and a waiting call is decided again after the previous answer (an "always" may cover it).
 */
export function createBashApprovals() {
  const prefixes: string[] = [];
  let queue: Promise<unknown> = Promise.resolve();

  async function askNow(policy: BashPolicyFields, command: string, ctx: BashAskContext): Promise<BashBlock | undefined> {
    const decision = bashDecision(policy, command, prefixes);
    if (decision === "allow") return undefined;
    const prefix = sessionAllowPrefix(command);
    if (decision === "block" || !prefix) return { block: true, reason: readonlyBlockReason(policy, prefixes) };
    if (!ctx.hasUI || ctx.signal?.aborted)
      return { block: true, reason: readonlyBlockReason(policy, prefixes) };
    let choice: string | undefined;
    try {
      choice = await ctx.ui.select(
        bashAskTitle(command, prefix),
        [BASH_ASK_OPTIONS.deny, BASH_ASK_OPTIONS.once, BASH_ASK_OPTIONS.always],
        ctx.signal ? { signal: ctx.signal } : undefined,
      );
    } catch {
      choice = undefined;
    }
    if (ctx.signal?.aborted) choice = undefined;
    if (choice === BASH_ASK_OPTIONS.once) return undefined;
    if (choice === BASH_ASK_OPTIONS.always) {
      if (!prefixes.includes(prefix)) prefixes.push(prefix);
      return undefined;
    }
    return {
      block: true,
      reason:
        choice === BASH_ASK_OPTIONS.deny
          ? `The user refused this bash command: ${command}. Do not retry it; continue without it or explain in your final message what you need.`
          : `Bash command not approved (the question was cancelled): ${command}. ${readonlyBlockReason(policy, prefixes)}`,
    };
  }

  return {
    /** Prefixes allowed "always" in this child process. */
    prefixes(): readonly string[] {
      return prefixes;
    },
    /** Decide one bash call, asking the user when the policy says "ask" and a UI is available. */
    check(policy: BashPolicyFields, command: unknown, ctx: BashAskContext): Promise<BashBlock | undefined> {
      const decision = bashDecision(policy, command, prefixes);
      if (decision === "allow") return Promise.resolve(undefined);
      if (decision === "block" || typeof command !== "string" || !ctx.hasUI)
        return Promise.resolve({ block: true, reason: readonlyBlockReason(policy, prefixes) });
      const run = queue.then(() => askNow(policy, command, ctx));
      queue = run.catch(() => {});
      return run;
    },
  };
}
