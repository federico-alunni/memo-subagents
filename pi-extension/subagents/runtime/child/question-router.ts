// Ask-parent for the one `question` tool: the installed pi-memo-question package (never a copy) asks the
// router registered here before opening its dialog. The router sends `to: "parent"` questions (or every
// question without `to` when the parent is the default target) to the parent agent through the child runtime,
// and tells the tool to ask the user when the parent cannot answer. Contract: pi-memo-question `src/router.ts`
// (the key is a registered symbol, so nothing of the package is imported here).
import { answeredByText, askBlockedLabel, questionAnswerFrom } from "../ask-parent.ts";
import type { AnsweredBy, AskOption, AskOutcome, AskTarget } from "../ask-parent.ts";
import type { HerdrBlockedEvent } from "./bash-policy.ts";

/** pi-memo-question's router key (`QUESTION_ROUTER_KEY` of its `src/router.ts`). */
export const QUESTION_ROUTER_KEY = Symbol.for("pi-memo-question/router");

type QuestionTarget = "user" | "parent";
type QuestionAnswer = { answer: string; custom: false; index: number; note?: string } | { answer: string; custom: true };
type RouteOutcome =
  | { kind: "answered"; answer: QuestionAnswer | null; by: string; note?: string; details?: Record<string, unknown> }
  | { kind: "user"; reason?: string }
  | { kind: "cancelled" };

export interface QuestionRouterPort {
  defaultTarget(): QuestionTarget;
  askParent(
    question: { id: string; question: string; options: AskOption[] },
    signal: AbortSignal | undefined,
  ): Promise<RouteOutcome>;
}

export interface QuestionRoute {
  /** Whether the parent can be asked now (ask-parent on and a running child runtime). */
  enabled(): boolean;
  /** Questions without `to` go to the parent. */
  parentByDefault(): boolean;
  ask(
    question: string,
    options: AskOption[],
    signal: AbortSignal | undefined,
    onTarget: (target: AskTarget) => void,
  ): Promise<AskOutcome>;
  emitBlocked(event: HerdrBlockedEvent): void;
}

function byName(by: AnsweredBy): string {
  return by.who === "parent" ? "the parent agent" : "the user";
}

/** The router for pi-memo-question's `question` tool, routing through `route`. */
export function createQuestionRouter(route: QuestionRoute): QuestionRouterPort {
  return {
    defaultTarget: () => (route.enabled() && route.parentByDefault() ? "parent" : "user"),
    async askParent(question, signal) {
      if (!route.enabled()) return { kind: "user", reason: "no parent agent can be asked" };
      let open = false;
      const target = (to: AskTarget) => {
        if (open) route.emitBlocked({ active: false });
        route.emitBlocked({ active: true, kind: "question", label: askBlockedLabel(to, question.question), target: to });
        open = true;
      };
      let outcome: AskOutcome;
      try {
        outcome = await route.ask(question.question, question.options, signal, target);
      } catch (error) {
        outcome = { kind: "fallback", reason: error instanceof Error ? error.message : String(error) };
      } finally {
        if (open) route.emitBlocked({ active: false });
      }
      if (outcome.kind === "answered") {
        const by = outcome.result.by;
        return {
          kind: "answered",
          answer: questionAnswerFrom(outcome.result, question.options),
          by: byName(by),
          ...(outcome.result.note ? { note: outcome.result.note } : {}),
          details: { answeredBy: by, answeredByText: answeredByText(by), requestId: outcome.requestId },
        };
      }
      if (outcome.kind === "cancelled" || signal?.aborted) return { kind: "cancelled" };
      return { kind: "user", reason: outcome.reason };
    },
  };
}

/** Register (or clear) this process' router for pi-memo-question. */
export function setQuestionRouter(router: QuestionRouterPort | undefined): void {
  (globalThis as Record<symbol, unknown>)[QUESTION_ROUTER_KEY] = router;
}
