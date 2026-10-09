// Ask-parent for the one `question` tool. pi-memo-question is not modified: its extension registers the
// tool through a proxy of `pi` that wraps `execute`, so the child keeps exactly one `question` tool with
// pi-memo-question's schema, events (`memo-question` → question.json, `herdr:blocked`) and dialog. Only
// the dialog call (`ctx.ui.custom`) is routed: to the parent agent first, to today's dialog in the
// child's pane when the parent cannot be asked.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import questionExtension from "pi-memo-question/extension";
import { answerText } from "pi-memo-question/dialog";
import type { QuestionAnswer } from "pi-memo-question/dialog";
import { answeredByText, askBlockedLabel, questionAnswerFrom } from "../ask-parent.ts";
import type { AnsweredBy, AskOption, AskOutcome, AskTarget } from "../ask-parent.ts";
import { fallbackText } from "./bash-policy.ts";
import type { HerdrBlockedEvent } from "./bash-policy.ts";

export interface QuestionRoute {
  /** Whether this child asks its parent first (ask-parent on and an owned runtime). */
  enabled(): boolean;
  ask(
    question: string,
    options: AskOption[],
    signal: AbortSignal | undefined,
    onTarget: (target: AskTarget) => void,
  ): Promise<AskOutcome>;
  emitBlocked(event: HerdrBlockedEvent): void;
}

type ToolResult = { content: { type: string; text?: string }[]; details?: unknown };
type QuestionTool = {
  name: string;
  execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown, ctx: any): Promise<ToolResult>;
  [key: string]: unknown;
};

/** What happened to one routed dialog, for the transcript. */
type Routed =
  | { kind: "answered"; by: AnsweredBy; requestId: string; answer: QuestionAnswer | null; note?: string }
  | { kind: "fallback"; reason: string }
  | { kind: "cancelled" };

/** Delegate to `target`, binding methods (pi's objects may use private fields), overriding `overrides`. */
function delegate<T extends object>(target: T, overrides: Record<string | symbol, unknown>): T {
  return new Proxy(target, {
    get(t, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      const value = Reflect.get(t, prop);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
}

/** Text returned to the model for a routed answer: who answered is part of it. */
export function routedAnswerText(answer: QuestionAnswer | null, by: AnsweredBy, note?: string): string {
  let text = answerText(answer);
  if (by.who === "parent")
    text = text.replace(/^User /, "The parent agent ").replace(/\nUser note: /, "\nParent agent note: ");
  const extra = note?.trim();
  if (extra && !(answer && !answer.custom && answer.note)) text += `\nNote: ${extra}`;
  return `${text}\n(${answeredByText(by)})`;
}

function audited(result: ToolResult, routed: Routed): ToolResult {
  const details = (result.details && typeof result.details === "object" ? result.details : {}) as Record<string, unknown>;
  if (routed.kind === "answered")
    return {
      ...result,
      content: [{ type: "text", text: routedAnswerText(routed.answer, routed.by, routed.note) }],
      details: { ...details, answeredBy: routed.by, requestId: routed.requestId },
    };
  const first = result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";
  const suffix =
    routed.kind === "fallback"
      ? fallbackText(routed.reason)
      : "the request to the parent agent was withdrawn: the turn was aborted";
  return {
    ...result,
    content: [{ type: "text", text: `${first}\n(${suffix})` }, ...result.content.slice(1)],
    details: {
      ...details,
      ...(routed.kind === "fallback"
        ? { answeredBy: { who: "user", where: "child-pane", reason: "parent-unavailable" } satisfies AnsweredBy }
        : {}),
    },
  };
}

/** pi-memo-question's tool with its dialog routed through `route` (unchanged when the route is off). */
export function wrapQuestionTool<T extends QuestionTool>(tool: T, route: QuestionRoute): T {
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!route.enabled() || !ctx) return tool.execute(toolCallId, params, signal, onUpdate, ctx);
      let routed: Routed | undefined;
      const options: AskOption[] = Array.isArray(params?.options) ? params.options : [];
      const question = String(params?.question ?? "");
      const custom = async (factory: unknown, opts?: unknown) => {
        let open = false;
        const close = () => {
          if (open) route.emitBlocked({ active: false });
          open = false;
        };
        const target = (to: AskTarget) => {
          route.emitBlocked({ active: true, kind: "question", label: askBlockedLabel(to, question), target: to });
          if (open) route.emitBlocked({ active: false });
          open = true;
        };
        let outcome: AskOutcome;
        try {
          outcome = await route.ask(question, options, signal, target);
        } catch (error) {
          outcome = { kind: "fallback", reason: error instanceof Error ? error.message : String(error) };
        }
        if (outcome.kind === "answered") {
          close();
          const answer = questionAnswerFrom(outcome.result, options);
          routed = { kind: "answered", by: outcome.result.by, requestId: outcome.requestId, answer, note: outcome.result.note };
          return answer;
        }
        if (outcome.kind === "cancelled" || signal?.aborted) {
          close();
          routed = { kind: "cancelled" };
          return null;
        }
        // The parent cannot answer: today's dialog in this pane.
        routed = { kind: "fallback", reason: outcome.reason };
        target("user");
        try {
          return await ctx.ui.custom(factory, opts);
        } finally {
          close();
        }
      };
      const routedCtx = delegate(ctx, { ui: delegate(ctx.ui, { custom }) });
      const result = await tool.execute(toolCallId, params, signal, onUpdate, routedCtx);
      return routed ? audited(result, routed) : result;
    },
  } as T;
}

/** Register pi-memo-question's `question` tool through `pi`, wrapped to ask the parent first. */
export function registerAskParentQuestion(pi: ExtensionAPI, route: QuestionRoute): void {
  const proxy = new Proxy(pi, {
    get(target, prop) {
      if (prop === "registerTool")
        return (tool: QuestionTool) =>
          target.registerTool((tool.name === "question" ? wrapQuestionTool(tool, route) : tool) as any);
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  questionExtension(proxy);
}
