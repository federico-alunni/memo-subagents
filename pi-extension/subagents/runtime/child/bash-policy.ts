/**
 * Bash decision of a runtime child with `bash: "readonly"`: the read-only list, the agent's extra
 * prefixes (`bashAllow`) and, for user-driven children with `bashAsk`, a question to the user in the
 * child's pane. "Always" answers live only in this child process (never on disk).
 */
import type { ChildPolicy } from "../protocol.ts";
import { allowedExtraCommand, plainArgv, readonlyBashRejection, readonlyCommand } from "./readonly-bash.ts";
import { answeredByText, askBlockedLabel } from "../ask-parent.ts";
import type { AnsweredBy, ApprovalDecision, AskTarget } from "../ask-parent.ts";

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

/** `herdr:blocked` payload: the child waits for the user while `active` (see docs/runtime.md). */
export type HerdrBlockedEvent =
  | { active: true; label?: string; kind?: string; target?: AskTarget }
  | { active: false };

/** Ask-parent outcome of one approval, as seen by the approvals queue. */
export type ParentApproval =
  | { kind: "decision"; decision: ApprovalDecision; by: AnsweredBy; note?: string }
  | { kind: "fallback"; reason: string }
  | { kind: "cancelled" };

/** Ask-parent route of the approvals (child extension): the parent agent is asked before the user. */
export interface BashParentRoute {
  enabled(): boolean;
  ask(
    command: string,
    prefix: string,
    signal: AbortSignal | undefined,
    onTarget: (target: AskTarget) => void,
  ): Promise<ParentApproval>;
}

/** Audit of an answer given in the child's own pane because the parent could not be asked. */
export function fallbackText(reason: string): string {
  return `answered by the user in this pane; the parent agent could not answer: ${reason}`;
}

/** Result of applying an upstream decision: a block, or allowed with the audit line for the transcript. */
export type ApprovalApplied = { block: BashBlock; audit: string } | { block?: undefined; audit: string };

/**
 * Apply a decision that came from upstream (parent agent or a user asked elsewhere), re-checked against
 * the child's own policy: nothing the policy blocks (or does not ask about) is ever allowed, "once" passes
 * only this call, and "always" is applied only when a user gave it (a parent "always" is never applied).
 * `prefixes` (this process's "always" list) is extended in place.
 */
export function applyApprovalDecision(
  policy: BashPolicyFields,
  command: string,
  prefixes: string[],
  answer: { decision: ApprovalDecision; by: AnsweredBy; note?: string },
): ApprovalApplied {
  const who = answeredByText(answer.by);
  const note = answer.note?.trim() ? ` Note: ${answer.note.trim()}` : "";
  const decision = bashDecision(policy, command, prefixes);
  const prefix = sessionAllowPrefix(command);
  if (answer.decision === "deny")
    return {
      block: {
        block: true,
        reason: `This bash command was refused (${who}): ${command}. Do not retry it; continue without it or explain in your final message what you need.${note}`,
      },
      audit: who,
    };
  if (answer.decision !== "once" && answer.decision !== "always")
    return {
      block: { block: true, reason: `Bash command not approved (cancelled, ${who}): ${command}. ${readonlyBlockReason(policy, prefixes)}` },
      audit: who,
    };
  // The parent can never widen the policy: only what the child would have asked about may pass.
  if (decision === "block" || !prefix)
    return {
      block: { block: true, reason: `The approval (${who}) was ignored: this agent's policy does not allow ${command}. ${readonlyBlockReason(policy, prefixes)}` },
      audit: who,
    };
  if (answer.decision === "always") {
    if (answer.by.who !== "user")
      return {
        block: { block: true, reason: `Bash command not approved: only the user can allow a command always (${who}): ${command}.` },
        audit: who,
      };
    if (!prefixes.includes(prefix)) prefixes.push(prefix);
    return { audit: `bash command allowed always for "${prefix}" in this agent session (${who}).${note}` };
  }
  return { audit: `bash command allowed once (${who}).${note}` };
}

/**
 * Per-process bash approvals: "always" prefixes and the question flow. Questions are asked one at a
 * time, and a waiting call is decided again after the previous answer (an "always" may cover it).
 * `emitBlocked` (the extension's `pi.events.emit("herdr:blocked", …)`) brackets every open dialog.
 */
export function createBashApprovals(
  emitBlocked: (event: HerdrBlockedEvent) => void = () => {},
  route?: BashParentRoute,
) {
  const prefixes: string[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  const emit = (event: HerdrBlockedEvent) => {
    try {
      emitBlocked(event);
    } catch {
      // Display only: a listener failure never decides the bash call.
    }
  };

  async function askNow(
    policy: BashPolicyFields,
    command: string,
    ctx: BashAskContext,
    audit: (line: string) => void,
  ): Promise<BashBlock | undefined> {
    const decision = bashDecision(policy, command, prefixes);
    if (decision === "allow") return undefined;
    const prefix = sessionAllowPrefix(command);
    if (decision === "block" || !prefix) return { block: true, reason: readonlyBlockReason(policy, prefixes) };
    let fallback: string | undefined;
    if (route?.enabled() && !ctx.signal?.aborted) {
      // Ask-parent: one open wait, re-targeted (open the new one, then close the old one) as it moves.
      let open = false;
      const target = (to: AskTarget) => {
        emit({ active: true, label: askBlockedLabel(to, command), kind: "approval", target: to });
        if (open) emit({ active: false });
        open = true;
      };
      let outcome: ParentApproval;
      try {
        outcome = await route.ask(command, prefix, ctx.signal, target);
      } catch (error) {
        outcome = { kind: "fallback", reason: error instanceof Error ? error.message : String(error) };
      }
      // A fallback dialog below brackets itself (target "user").
      if (open) emit({ active: false });
      if (outcome.kind === "cancelled" || ctx.signal?.aborted)
        return { block: true, reason: `Bash command not approved (the request was cancelled): ${command}. ${readonlyBlockReason(policy, prefixes)}` };
      if (outcome.kind === "decision") {
        const applied = applyApprovalDecision(policy, command, prefixes, outcome);
        if (!applied.block) audit(applied.audit);
        return applied.block;
      }
      fallback = outcome.reason;
    }
    if (!ctx.hasUI || ctx.signal?.aborted)
      return { block: true, reason: readonlyBlockReason(policy, prefixes) };
    let choice: string | undefined;
    emit({ active: true, label: fallback !== undefined ? askBlockedLabel("user", command) : command, kind: "approval", ...(fallback !== undefined ? { target: "user" as const } : {}) });
    try {
      choice = await ctx.ui.select(
        bashAskTitle(command, prefix),
        [BASH_ASK_OPTIONS.deny, BASH_ASK_OPTIONS.once, BASH_ASK_OPTIONS.always],
        ctx.signal ? { signal: ctx.signal } : undefined,
      );
    } catch {
      choice = undefined;
    } finally {
      emit({ active: false });
    }
    if (ctx.signal?.aborted) choice = undefined;
    // Ask-parent fallback: the transcript records that the user answered here, and why.
    const local = fallback !== undefined ? ` (${fallbackText(fallback)})` : "";
    if (choice === BASH_ASK_OPTIONS.once) {
      if (local) audit(`bash command allowed once${local}.`);
      return undefined;
    }
    if (choice === BASH_ASK_OPTIONS.always) {
      if (!prefixes.includes(prefix)) prefixes.push(prefix);
      if (local) audit(`bash command allowed always for "${prefix}" in this agent session${local}.`);
      return undefined;
    }
    return {
      block: true,
      reason:
        choice === BASH_ASK_OPTIONS.deny
          ? `The user refused this bash command${local}: ${command}. Do not retry it; continue without it or explain in your final message what you need.`
          : `Bash command not approved (the question was cancelled${local}): ${command}. ${readonlyBlockReason(policy, prefixes)}`,
    };
  }

  return {
    /** Prefixes allowed "always" in this child process. */
    prefixes(): readonly string[] {
      return prefixes;
    },
    /**
     * Decide one bash call, asking when the policy says "ask": the parent agent first with the ask-parent
     * route, else (or as fallback) the user in this pane when a UI is available. `audit` receives the
     * transcript line of an upstream or fallback approval.
     */
    check(
      policy: BashPolicyFields,
      command: unknown,
      ctx: BashAskContext,
      audit: (line: string) => void = () => {},
    ): Promise<BashBlock | undefined> {
      const decision = bashDecision(policy, command, prefixes);
      if (decision === "allow") return Promise.resolve(undefined);
      if (decision === "block" || typeof command !== "string" || (!ctx.hasUI && !route?.enabled()))
        return Promise.resolve({ block: true, reason: readonlyBlockReason(policy, prefixes) });
      const run = queue.then(() => askNow(policy, command, ctx, audit));
      queue = run.catch(() => {});
      return run;
    },
  };
}
