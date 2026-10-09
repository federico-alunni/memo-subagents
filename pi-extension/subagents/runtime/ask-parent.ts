// Ask-parent: a user-driven child's `question` calls and `bashAsk` approvals go to its parent agent first
// (correlated request/response records, see docs/runtime.md), and reach the user only when the parent
// cannot answer. Shared by the child (ChildRuntime.ask), the runtime (AgentRuntime.pendingAsks/answerAsk)
// and the parent extension. No pi imports.

export type AskKind = "question" | "approval";
/** Who the child is waiting for: its parent agent, or a user (parent session, or its own pane). */
export type AskTarget = "parent" | "user";
export type ApprovalDecision = "deny" | "once" | "always" | "cancel";

export interface AskOption {
  label: string;
  description?: string;
}

/** `params` of an ask-parent request record (child input: untrusted, validated by `validAskRequest`). */
export interface AskRequest {
  kind: AskKind;
  /** Requesting child: runtime agent id and display name. */
  childId: string;
  childName: string;
  /** Question text, or the bash command. */
  text: string;
  /** question: the options offered to the user (recommended first). */
  options?: AskOption[];
  /** approval: the command and the prefix an "always" approval would cover. */
  command?: string;
  prefix?: string;
  /** Forwarded requests: names of the descendants it comes from, nearest last (e.g. ["Grandchild"]). */
  origin?: string[];
}

/** Who answered: recorded in the child transcript. */
export interface AnsweredBy {
  who: "parent" | "user";
  /** Name and id of the parent agent that answered, or of the session in which the user answered. */
  name?: string;
  id?: string;
  /** user only: where the user was asked. */
  where?: "parent-session" | "child-pane";
  /** user only: why the user was asked. */
  reason?: "escalated" | "always" | "timeout" | "parent-unavailable";
  /** Intermediate agents that relayed the request up and the answer down (nearest first). */
  forwardedBy?: string[];
}

/** `result` of a response record. */
export type AskResult =
  | {
      /** question: chosen label or free text; null = cancelled. */
      answer?: string | null;
      /** question: the answer is free text even if it matches an option label. */
      custom?: boolean;
      /** approval. */
      decision?: ApprovalDecision;
      note?: string;
      by: AnsweredBy;
    }
  /** Nobody upstream can answer (or the child withdrew): the child asks the user in its own pane. */
  | { fallback: true; reason: string };

export function isFallback(result: AskResult): result is { fallback: true; reason: string } {
  return (result as { fallback?: unknown }).fallback === true;
}

/** Escalation marker: the request now waits for the user, or for the parent's own parent. */
export interface AskEscalation {
  target: AskTarget;
  reason: "escalated" | "always" | "timeout";
}

/** Liveness record of the parent (`parent.json` in the child's protocol directory). */
export interface ParentBeat {
  version: 1;
  pid: number;
  at: number;
  name: string;
  id: string;
  /** The parent quit or reloaded: pending requests are not answered any more. */
  closed?: boolean;
}

export const DEFAULT_ASK_PARENT_TIMEOUT_MS = 60000;
export const ASK_PARENT_TIMEOUT_ENV = "PI_MEMO_SUBAGENTS_ASK_PARENT_TIMEOUT_MS";
/** Child side: a request nobody picked up within this window goes to the user in the child's pane. */
export const ASK_PICKUP_MS = 5000;
/** Child side: a parent whose liveness record is older than this is unavailable. */
export const PARENT_STALE_MS = 6000;
/** Parent side: liveness refresh interval. */
export const PARENT_BEAT_MS = 2000;

/** PI_MEMO_SUBAGENTS_ASK_PARENT_TIMEOUT_MS: positive integer milliseconds, anything else = 60000. */
export function askParentTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ASK_PARENT_TIMEOUT_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_ASK_PARENT_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_ASK_PARENT_TIMEOUT_MS;
}

const oneLine = (text: string, max = 2000) => text.replace(/\s+/g, " ").trim().slice(0, max);

/** Validate (and normalize) a request read from a child record. */
export function validAskRequest(raw: unknown): AskRequest | undefined {
  const r = raw as Partial<AskRequest> | undefined;
  if (!r || typeof r !== "object") return undefined;
  if (r.kind !== "question" && r.kind !== "approval") return undefined;
  if (typeof r.childId !== "string" || typeof r.childName !== "string" || typeof r.text !== "string")
    return undefined;
  if (r.origin !== undefined && !(Array.isArray(r.origin) && r.origin.every((o) => typeof o === "string")))
    return undefined;
  if (r.kind === "question") {
    if (
      !Array.isArray(r.options) ||
      !r.options.every(
        (o) =>
          !!o &&
          typeof o.label === "string" &&
          (o.description === undefined || typeof o.description === "string"),
      )
    )
      return undefined;
    return {
      kind: "question",
      childId: r.childId,
      childName: r.childName,
      text: r.text,
      options: r.options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
      ...(r.origin?.length ? { origin: [...r.origin] } : {}),
    };
  }
  if (typeof r.command !== "string" || typeof r.prefix !== "string") return undefined;
  return {
    kind: "approval",
    childId: r.childId,
    childName: r.childName,
    text: r.text,
    command: r.command,
    prefix: r.prefix,
    ...(r.origin?.length ? { origin: [...r.origin] } : {}),
  };
}

/** Validate a response result read from a parent record. */
export function validAskResult(raw: unknown): AskResult | undefined {
  const r = raw as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object") return undefined;
  if (r.fallback === true) return { fallback: true, reason: typeof r.reason === "string" ? r.reason : "" };
  const by = r.by as AnsweredBy | undefined;
  if (!by || (by.who !== "parent" && by.who !== "user")) return undefined;
  if (r.answer !== undefined && r.answer !== null && typeof r.answer !== "string") return undefined;
  if (r.decision !== undefined && !["deny", "once", "always", "cancel"].includes(r.decision as string)) return undefined;
  if (r.note !== undefined && typeof r.note !== "string") return undefined;
  return r as AskResult;
}

/** "Intermediate › Grandchild": where a (possibly forwarded) request comes from. */
export function askOrigin(request: Pick<AskRequest, "childName" | "origin">): string {
  return [request.childName, ...(request.origin ?? [])].join(" › ");
}

/** One line for the child transcript: who answered and why. */
export function answeredByText(by: AnsweredBy): string {
  const relay = by.forwardedBy?.length ? `, relayed by ${by.forwardedBy.map((n) => `"${n}"`).join(", ")}` : "";
  const named = by.name ? ` "${by.name}"${by.id ? ` (${by.id})` : ""}` : "";
  if (by.who === "parent") return `answered by the parent agent${named}${relay}`;
  if (by.where === "child-pane")
    return `answered by the user in this pane${by.reason === "parent-unavailable" ? " (the parent agent could not be asked)" : ""}`;
  const why =
    by.reason === "timeout"
      ? "the parent agent did not answer in time"
      : by.reason === "always"
        ? "only the user can allow a command always"
        : "escalated by the parent agent";
  return `answered by the user in the session of${named || " the parent agent"} (${why})${relay}`;
}

/**
 * The parent's (or user's) answer to a question, as pi-memo-question's dialog result: an exact option
 * label or its 1-based number selects the option; anything else is a free answer. null = cancelled.
 */
export function questionAnswerFrom(
  result: { answer?: string | null; custom?: boolean; note?: string },
  options: readonly AskOption[],
):
  | { answer: string; custom: false; index: number; note?: string }
  | { answer: string; custom: true }
  | null {
  if (result.answer === null || result.answer === undefined) return null;
  const text = result.answer.trim();
  if (!text) return null;
  let index = result.custom === true ? -1 : options.findIndex((o) => o.label === text);
  if (index < 0 && result.custom !== true && /^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= options.length)
    index = Number(text) - 1;
  if (index >= 0) {
    const note = result.note?.trim();
    return { answer: options[index].label, custom: false, index: index + 1, ...(note ? { note } : {}) };
  }
  return { answer: text, custom: true };
}

/** Liveness of the parent seen by the child: unknown (no record yet), alive or gone (quit/reload/stale). */
export function parentState(
  beat: ParentBeat | undefined,
  now: number,
  pidAlive: (pid: number) => boolean = processAlive,
  staleMs = PARENT_STALE_MS,
): "unknown" | "alive" | "gone" {
  if (!beat || typeof beat !== "object" || typeof beat.at !== "number") return "unknown";
  if (beat.closed === true) return "gone";
  if (now - beat.at > staleMs) return "gone";
  if (Number.isSafeInteger(beat.pid) && beat.pid > 0 && !pidAlive(beat.pid)) return "gone";
  return "alive";
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Label of the `herdr:blocked` event: Herdr shows who the child waits for. */
export function askBlockedLabel(target: AskTarget, text: string): string {
  return `→ ${target} · ${oneLine(text, 180)}`;
}

/**
 * Outcome of `ChildRuntime.ask`: the answer, a fallback to the child's own pane (parent unavailable or
 * nobody upstream can answer), or cancelled (the child's own turn was aborted).
 */
export type AskOutcome =
  | { kind: "answered"; requestId: string; result: Exclude<AskResult, { fallback: true }> }
  | { kind: "fallback"; reason: string; requestId?: string }
  | { kind: "cancelled"; requestId?: string };

export interface AskWaitOptions {
  signal?: AbortSignal;
  /** The waiting target changed: "parent" once published, "user"/"parent" on escalation markers. */
  onTarget?(target: AskTarget): void;
}

/**
 * Process-wide upstream of a runtime child with ask-parent (set by the child extension): the parent
 * extension of a nested agent forwards escalated requests through it, one level up, instead of asking
 * the user.
 */
export interface AskUpstream {
  name: string;
  forward(request: Omit<AskRequest, "childId" | "childName">, options: AskWaitOptions): Promise<AskOutcome>;
}
const UPSTREAM_KEY = Symbol.for("pi-memo-subagents/ask-upstream");
export function askUpstream(): AskUpstream | undefined {
  return (globalThis as unknown as Record<symbol, AskUpstream | undefined>)[UPSTREAM_KEY];
}
export function setAskUpstream(upstream: AskUpstream | undefined): void {
  (globalThis as unknown as Record<symbol, AskUpstream | undefined>)[UPSTREAM_KEY] = upstream;
}
