// Parent side of ask-parent (see docs/runtime.md): picks up the requests of this session's subagents,
// notifies the parent agent (steer message), applies its `subagent_answer` within the policy limits,
// escalates to the user (or, in a nested agent, one level up) on request, for "always" approvals and
// after the timeout, and keeps the liveness record children use to detect an unavailable parent.
import { PARENT_BEAT_MS, askOrigin } from "./runtime/ask-parent.ts";
import type { AnsweredBy, AskRequest, AskResult, AskTarget, AskUpstream } from "./runtime/ask-parent.ts";
import type { EscalationAnswer, EscalationEntry } from "./escalation-dialog.ts";
import type { AgentHandle, PendingAsk } from "./runtime/index.ts";

export interface AskChild {
  /** Running subagent id (what the parent agent passes to subagent_answer). */
  id: string;
  name: string;
  handle: AgentHandle;
}

export interface AskHostRuntime {
  pendingAsks(h: AgentHandle): Promise<PendingAsk[]>;
  markAsk(
    h: AgentHandle,
    requestId: string,
    mark: { kind: "received" } | { kind: "escalated"; escalation: { target: AskTarget; reason: EscalationReason } },
  ): Promise<boolean>;
  answerAsk(h: AgentHandle, requestId: string, result: AskResult): Promise<void>;
  askHeartbeat(h: AgentHandle, beat: { name: string; id: string; closed?: boolean }): Promise<void>;
}

export type EscalationReason = "escalated" | "always" | "timeout";

export interface EscalationRequest {
  child: AskChild;
  requestId: string;
  request: AskRequest;
  reason: EscalationReason;
  signal: AbortSignal;
  /** The request moved (e.g. this agent's parent is unavailable, so the user here is asked). */
  setTarget(target: AskTarget): void;
}

export interface SubagentRequestDetails {
  id: string;
  name: string;
  requestId: string;
  kind: AskRequest["kind"];
  from: string;
  text: string;
  options?: AskRequest["options"];
  command?: string;
  prefix?: string;
  timeoutMs: number;
  escalatesTo: AskTarget;
}

export interface AskHostOptions {
  runtime: AskHostRuntime;
  /** This session's live subagents with ask-parent on. */
  children(): AskChild[];
  /** Name and id of this agent, recorded as the answerer. */
  self(): { name: string; id: string };
  /** Deliver a request to the parent agent (steer message). */
  notify(message: { content: string; details: SubagentRequestDetails }): void;
  /** Where an escalation goes first: the user in this session, or this agent's own parent. */
  escalationTarget(): AskTarget;
  /** Ask the user (or this agent's parent): the answer, or a fallback to the child's own pane. */
  escalate(request: EscalationRequest): Promise<AskResult>;
  timeoutMs: number;
  now?: () => number;
}

interface Tracked {
  key: string;
  child: AskChild;
  requestId: string;
  request: AskRequest;
  deadline: number;
  escalation?: { controller: AbortController; reason: EscalationReason };
  answering?: boolean;
}

export interface SubagentAnswerParams {
  id: string;
  requestId: string;
  answer?: string;
  decision?: string;
  escalate?: boolean;
  note?: string;
}

const keyOf = (id: string, requestId: string) => `${id}\0${requestId}`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The steer message of one request: who asks, what, the requestId and how to answer. */
export function requestMessage(
  child: Pick<AskChild, "id" | "name">,
  requestId: string,
  request: AskRequest,
  timeoutMs: number,
  escalatesTo: AskTarget,
): { content: string; details: SubagentRequestDetails } {
  const from = askOrigin(request);
  const via = request.origin?.length ? ` (forwarded by your subagent "${child.name}")` : "";
  const upstream = escalatesTo === "user" ? "the user" : "your own parent agent";
  const seconds = Math.round(timeoutMs / 1000);
  const call = (args: string) => `subagent_answer({ id: "${child.id}", requestId: "${requestId}", ${args} })`;
  const lines =
    request.kind === "question"
      ? [
          `Subagent "${from}"${via} asks you a question (requestId ${requestId}):`,
          "",
          request.text,
          "",
          "Options:",
          ...(request.options ?? []).map(
            (o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`,
          ),
          "",
          `Answer with ${call(`answer: "<option label, its number, or a free answer>"`)} (optional note).`,
          `If you cannot answer, call it with escalate: true to ask ${upstream}.`,
        ]
      : [
          `Subagent "${from}"${via} asks to run a bash command its read-only policy does not allow by itself (requestId ${requestId}):`,
          "",
          `  ${request.command ?? request.text}`,
          "",
          `Decide with ${call(`decision: "once" | "deny"`)} (optional note).`,
          `You may allow it once or deny it. Only the user can allow it always (every command starting with "${request.prefix}" for this subagent): decision "always" or escalate: true asks ${upstream}.`,
        ];
  lines.push(
    `The subagent waits for the answer. Without an answer within ${seconds}s the request goes to ${upstream} automatically.`,
  );
  return {
    content: lines.join("\n"),
    details: {
      id: child.id,
      name: child.name,
      requestId,
      kind: request.kind,
      from,
      text: request.text,
      ...(request.options ? { options: request.options } : {}),
      ...(request.command ? { command: request.command, prefix: request.prefix } : {}),
      timeoutMs,
      escalatesTo,
    },
  };
}

/**
 * The escalation of this agent: a nested agent (runtime child with ask-parent, `upstream()`) forwards the
 * request one level up and never asks the user here, unless its parent cannot be asked; the top-level
 * agent asks the user in its session (`askUser`, the escalation list). No UI → fallback to the child.
 */
export function createEscalate(deps: {
  upstream(): AskUpstream | undefined;
  askUser(entry: EscalationEntry, signal: AbortSignal): Promise<EscalationAnswer | undefined>;
  self(): { name: string; id: string };
}): (request: EscalationRequest) => Promise<AskResult> {
  return async (request) => {
    const self = deps.self();
    const upstream = deps.upstream();
    if (upstream) {
      const { kind, text, options, command, prefix } = request.request;
      const outcome = await upstream.forward(
        {
          kind,
          text,
          ...(options ? { options } : {}),
          ...(command !== undefined ? { command, prefix } : {}),
          origin: [request.request.childName, ...(request.request.origin ?? [])],
        },
        { signal: request.signal },
      );
      if (outcome.kind === "answered")
        return {
          ...outcome.result,
          by: { ...outcome.result.by, forwardedBy: [...(outcome.result.by.forwardedBy ?? []), self.name] },
        };
      if (outcome.kind === "cancelled" || request.signal.aborted)
        return { fallback: true, reason: "the request was withdrawn" };
      request.setTarget("user");
    }
    const answer = await deps.askUser(
      { key: `${request.child.id}\0${request.requestId}`, request: request.request, reason: request.reason },
      request.signal,
    );
    if (!answer) return { fallback: true, reason: "the user cannot be asked in the parent session" };
    const by: AnsweredBy = {
      who: "user",
      where: "parent-session",
      reason: request.reason,
      name: self.name,
      ...(self.id ? { id: self.id } : {}),
    };
    if (answer.kind === "approval") return { decision: answer.decision, by };
    const chosen = answer.answer;
    if (!chosen) return { answer: null, by };
    return chosen.custom
      ? { answer: chosen.answer, custom: true, by }
      : { answer: chosen.answer, ...(chosen.note ? { note: chosen.note } : {}), by };
  };
}

export class AskParentHost {
  private o: AskHostOptions;
  private tracked = new Map<string, Tracked>();
  private beats = new Map<string, number>();
  private ticking?: Promise<void>;
  private closed = false;
  constructor(options: AskHostOptions) {
    this.o = options;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** The latest handle of a tracked child (the pane selector may replace it). */
  private child(t: Tracked): AskChild {
    return this.o.children().find((c) => c.id === t.child.id) ?? t.child;
  }

  /** Pending requests waiting for this agent (for tests and the subagent_answer error text). */
  pending(): { id: string; requestId: string; kind: AskRequest["kind"]; escalated?: EscalationReason }[] {
    return [...this.tracked.values()].map((t) => ({
      id: t.child.id,
      requestId: t.requestId,
      kind: t.request.kind,
      ...(t.escalation ? { escalated: t.escalation.reason } : {}),
    }));
  }

  /** One pass: liveness, new requests (picked up and notified), withdrawn requests, timeouts. */
  tick(): Promise<void> {
    this.ticking ??= this.pass().finally(() => (this.ticking = undefined));
    return this.ticking;
  }

  private async pass(): Promise<void> {
    if (this.closed) return;
    const { runtime } = this.o;
    const children = this.o.children();
    const self = this.o.self();
    const observed = new Set<string>();
    const live = new Set<string>();
    for (const child of children) {
      const h = child.handle;
      const now = this.now();
      if (now - (this.beats.get(h.protocolDir) ?? -Infinity) >= PARENT_BEAT_MS) {
        this.beats.set(h.protocolDir, now);
        await runtime.askHeartbeat(h, self).catch(() => {});
      }
      let pending: PendingAsk[];
      try {
        pending = await runtime.pendingAsks(h);
      } catch {
        continue;
      }
      observed.add(child.id);
      for (const p of pending) {
        const key = keyOf(child.id, p.requestId);
        live.add(key);
        if (this.tracked.has(key) || this.closed) continue;
        if (p.received) {
          // Picked up by an earlier instance of this parent (reload) that can no longer answer it.
          await runtime.answerAsk(h, p.requestId, { fallback: true, reason: "the parent agent was reloaded" }).catch(() => {});
          continue;
        }
        if (!(await runtime.markAsk(h, p.requestId, { kind: "received" }).catch(() => false))) continue;
        this.tracked.set(key, {
          key,
          child,
          requestId: p.requestId,
          request: p.request,
          deadline: this.now() + this.o.timeoutMs,
        });
        this.o.notify(requestMessage(child, p.requestId, p.request, this.o.timeoutMs, this.o.escalationTarget()));
      }
    }
    const now = this.now();
    for (const t of [...this.tracked.values()]) {
      const gone = !children.some((c) => c.id === t.child.id);
      if (gone || (observed.has(t.child.id) && !live.has(t.key) && !t.answering)) {
        // Answered elsewhere, withdrawn by the child (aborted, asked in its pane) or the child ended.
        t.escalation?.controller.abort();
        this.tracked.delete(t.key);
        continue;
      }
      if (!t.escalation && !t.answering && now >= t.deadline) this.escalate(t, "timeout");
    }
  }

  private escalate(t: Tracked, reason: EscalationReason): void {
    const controller = new AbortController();
    t.escalation = { controller, reason };
    const { runtime } = this.o;
    const mark = (target: AskTarget) =>
      runtime
        .markAsk(this.child(t).handle, t.requestId, { kind: "escalated", escalation: { target, reason } })
        .catch(() => false);
    void (async () => {
      await mark(this.o.escalationTarget());
      let result: AskResult;
      try {
        result = await this.o.escalate({
          child: this.child(t),
          requestId: t.requestId,
          request: t.request,
          reason,
          signal: controller.signal,
          setTarget: (target) => void mark(target),
        });
      } catch (error) {
        result = { fallback: true, reason: errorText(error) };
      }
      if (controller.signal.aborted) return;
      await runtime.answerAsk(this.child(t).handle, t.requestId, result).catch(() => {});
      if (this.tracked.get(t.key) === t) this.tracked.delete(t.key);
    })();
  }

  /** subagent_answer: validate against the pending request and the policy limits, then answer once. */
  async answer(params: SubagentAnswerParams): Promise<{ ok: boolean; text: string }> {
    const refuse = (text: string) => ({ ok: false, text });
    const t = this.tracked.get(keyOf(params.id, params.requestId));
    if (!t)
      return refuse(
        `No pending request "${params.requestId}" of subagent "${params.id}": unknown, already answered, ` +
          `withdrawn by the subagent (it asked the user in its own pane) or escalated and answered there.`,
      );
    const upstream = this.o.escalationTarget() === "user" ? "the user" : "your own parent agent";
    if (t.escalation)
      return refuse(`Request "${params.requestId}" was already escalated (${t.escalation.reason}); it is answered there, not by you.`);
    if (t.answering) return refuse(`Request "${params.requestId}" is already being answered.`);
    const note = params.note?.trim() ? { note: params.note.trim() } : {};
    const self = this.o.self();
    const by: AnsweredBy = { who: "parent", name: self.name, id: self.id };
    if (params.escalate === true) {
      this.escalate(t, "escalated");
      return { ok: true, text: `Request "${params.requestId}" escalated to ${upstream}; the subagent keeps waiting for that answer.` };
    }
    let result: AskResult;
    if (t.request.kind === "question") {
      if (params.decision !== undefined) return refuse("This request is a question: answer it with `answer`, not `decision`.");
      if (typeof params.answer !== "string" || !params.answer.trim())
        return refuse("A question needs a non-empty `answer` (an option label, its number, or a free answer), or escalate: true.");
      result = { answer: params.answer.trim(), ...note, by };
    } else {
      if (params.decision === "always") {
        // Policy: "always" is the user's decision only; never applied from the parent agent.
        this.escalate(t, "always");
        return {
          ok: true,
          text: `Only the user can allow a command always: request "${params.requestId}" was escalated to ${upstream}. Use decision "once" to allow just this call.`,
        };
      }
      if (params.decision !== "once" && params.decision !== "deny")
        return refuse('A bash approval needs `decision`: "once" or "deny" ("always" asks the user), or escalate: true.');
      result = { decision: params.decision, ...note, by };
    }
    t.answering = true;
    try {
      await this.o.runtime.answerAsk(this.child(t).handle, t.requestId, result);
    } catch (error) {
      if (this.tracked.get(t.key) === t) this.tracked.delete(t.key);
      return refuse(`Not applied: ${errorText(error)} (the subagent may have withdrawn the request).`);
    }
    if (this.tracked.get(t.key) === t) this.tracked.delete(t.key);
    const what =
      t.request.kind === "question"
        ? `answer "${(result as { answer: string }).answer}"`
        : `decision "${(result as { decision: string }).decision}"`;
    return { ok: true, text: `Delivered to subagent "${t.child.name}": ${what}.` };
  }

  /** Quit/reload: no more answers from this instance; children ask the user in their own pane. */
  async shutdown(): Promise<void> {
    this.closed = true;
    await this.ticking?.catch(() => {});
    const self = this.o.self();
    for (const t of this.tracked.values()) {
      t.escalation?.controller.abort();
      await this.o.runtime
        .answerAsk(this.child(t).handle, t.requestId, { fallback: true, reason: "the parent agent session ended" })
        .catch(() => {});
    }
    this.tracked.clear();
    for (const child of this.o.children())
      await this.o.runtime.askHeartbeat(child.handle, { ...self, closed: true }).catch(() => {});
  }
}
