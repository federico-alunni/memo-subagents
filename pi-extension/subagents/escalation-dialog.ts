// Ask-parent escalations shown to the user in the parent session: one dialog listing every pending
// escalated request (one or more children), browsed with ←/→, each showing which child it comes from.
// Questions use the installed pi-memo-question's dialog component (published on globalThis by the package, never
// imported); approvals the same three options as the child pane.
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import { BASH_ASK_OPTIONS, bashAskTitle } from "./runtime/child/bash-policy.ts";
import { askOrigin } from "./runtime/ask-parent.ts";
import type { ApprovalDecision, AskRequest } from "./runtime/ask-parent.ts";

/** pi-memo-question's dialog result: an option (1-based index, optional note) or a free answer. */
type QuestionAnswer = { answer: string; custom: false; index: number; note?: string } | { answer: string; custom: true };

/** pi-memo-question's `QUESTION_DIALOG_KEY`: its extension publishes `{ questionComponent }` when it loads. */
const QUESTION_DIALOG_KEY = Symbol.for("pi-memo-question/dialog");

type QuestionComponent = (
  tui: TUI,
  theme: Theme,
  question: string,
  options: { label: string; description?: string }[],
  done: (answer: QuestionAnswer | null) => void,
) => DialogComponent;

function installedQuestionComponent(): QuestionComponent | undefined {
  const api = (globalThis as Record<symbol, { questionComponent?: unknown } | undefined>)[QUESTION_DIALOG_KEY];
  return typeof api?.questionComponent === "function" ? (api.questionComponent as QuestionComponent) : undefined;
}

/** Without pi-memo-question in this session: say so; any key answers "cancelled" (the child decides). */
function missingQuestionComponent(theme: Theme, done: (answer: QuestionAnswer | null) => void): DialogComponent {
  return {
    render: (width) => wrapTextWithAnsi(theme.fg("warning", "pi-memo-question is not loaded in this session: press any key to cancel this question."), width),
    handleInput: () => done(null),
    invalidate() {},
  };
}

export interface EscalationEntry {
  key: string;
  request: AskRequest;
  reason: "escalated" | "always" | "timeout";
}
export type EscalationAnswer =
  | { kind: "question"; answer: QuestionAnswer | null }
  | { kind: "approval"; decision: ApprovalDecision };

interface Theme {
  fg(color: any, text: string): string;
}
export interface DialogComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}

/** The bash approval of the child pane (Rifiuta / Permetti una volta / Permetti sempre), Esc cancels. */
export function approvalComponent(
  tui: TUI,
  theme: Theme,
  command: string,
  prefix: string,
  done: (decision: ApprovalDecision) => void,
): DialogComponent {
  const options: [ApprovalDecision, string][] = [
    ["deny", BASH_ASK_OPTIONS.deny],
    ["once", BASH_ASK_OPTIONS.once],
    ["always", BASH_ASK_OPTIONS.always],
  ];
  let index = 0;
  return {
    render(width) {
      const w = Math.max(1, width);
      const lines = [theme.fg("accent", "─".repeat(w))];
      for (const line of wrapTextWithAnsi(bashAskTitle(command, prefix), Math.max(1, w - 1)))
        lines.push(` ${theme.fg("text", line)}`);
      lines.push("");
      options.forEach(([, label], i) =>
        lines.push(
          truncateToWidth(
            i === index ? theme.fg("accent", `> ${i + 1}. ${label}`) : `  ${theme.fg("text", `${i + 1}. ${label}`)}`,
            w,
          ),
        ),
      );
      lines.push("", truncateToWidth(` ${theme.fg("dim", "↑↓ navigate • Enter to select • Esc to cancel")}`, w));
      lines.push(theme.fg("accent", "─".repeat(w)));
      return lines;
    },
    handleInput(data) {
      if (matchesKey(data, Key.up)) index = Math.max(0, index - 1);
      else if (matchesKey(data, Key.down)) index = Math.min(options.length - 1, index + 1);
      else if (matchesKey(data, Key.enter)) return done(options[index][0]);
      else if (matchesKey(data, Key.escape)) return done("cancel");
      else return;
      tui.requestRender();
    },
    invalidate() {},
  };
}

const REASON: Record<EscalationEntry["reason"], string> = {
  escalated: "escalated by the agent",
  always: "only you can allow a command always",
  timeout: "the agent did not answer in time",
};

interface Item {
  entry: EscalationEntry;
  resolve(answer: EscalationAnswer | undefined): void;
  component?: DialogComponent;
}

/** Opens the dialog (ctx.ui.custom); undefined when the session has no interactive UI. */
export type OpenDialog = (
  factory: (tui: TUI, theme: Theme, done: () => void) => DialogComponent,
) => Promise<unknown> | undefined;

/** The pending escalations of this session: one dialog for all of them while any is pending. */
export class EscalationList {
  private items: Item[] = [];
  private index = 0;
  private width = 80;
  private tui?: TUI;
  private theme?: Theme;
  private close?: () => void;
  private showing = false;
  private open: OpenDialog;
  constructor(open: OpenDialog) {
    this.open = open;
  }

  get size(): number {
    return this.items.length;
  }

  /** Ask the user; undefined when there is no UI or the request was withdrawn (`signal`). */
  ask(entry: EscalationEntry, signal?: AbortSignal): Promise<EscalationAnswer | undefined> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve(undefined);
      const item: Item = { entry, resolve };
      this.items.push(item);
      signal?.addEventListener("abort", () => this.remove(item, undefined), { once: true });
      if (!this.show()) this.remove(item, undefined);
    });
  }

  /** Withdraw every pending request (session shutdown). */
  clear(): void {
    for (const item of [...this.items]) this.remove(item, undefined);
  }

  private show(): boolean {
    if (this.showing) {
      this.tui?.requestRender();
      return true;
    }
    let opened: Promise<unknown> | undefined;
    try {
      opened = this.open((tui, theme, done) => {
        this.tui = tui;
        this.theme = theme;
        this.close = done;
        return this.component();
      });
    } catch {
      opened = undefined;
    }
    if (!opened) return false;
    this.showing = true;
    void opened
      .catch(() => {})
      .finally(() => {
        this.showing = false;
        this.tui = undefined;
        this.close = undefined;
        if (this.items.length > 0 && !this.show()) this.clear();
      });
    return true;
  }

  private remove(item: Item, answer: EscalationAnswer | undefined): void {
    const at = this.items.indexOf(item);
    if (at < 0) return;
    this.items.splice(at, 1);
    if (this.index >= this.items.length) this.index = Math.max(0, this.items.length - 1);
    else if (at < this.index) this.index -= 1;
    item.resolve(answer);
    if (this.items.length === 0) this.close?.();
    else this.tui?.requestRender();
  }

  private inner(item: Item): DialogComponent {
    if (item.component) return item.component;
    const { request } = item.entry;
    const tui = this.tui!;
    const theme = this.theme!;
    item.component =
      request.kind === "question"
        ? (() => {
            const done = (answer: QuestionAnswer | null) => this.remove(item, { kind: "question", answer });
            const question = installedQuestionComponent();
            return question ? question(tui, theme, request.text, request.options ?? [], done) : missingQuestionComponent(theme, done);
          })()
        : approvalComponent(tui, theme, request.command ?? request.text, request.prefix ?? "", (decision) =>
            this.remove(item, { kind: "approval", decision }),
          );
    return item.component;
  }

  /** The dialog: a header naming the child (and position in the list), then the request's own dialog. */
  component(): DialogComponent {
    return {
      render: (width) => {
        this.width = width;
        const item = this.items[this.index];
        if (!item || !this.theme) return [];
        const theme = this.theme;
        const n = this.items.length;
        const kind = item.entry.request.kind === "question" ? "question" : "bash approval";
        const head = `${n > 1 ? `Request ${this.index + 1}/${n} · ` : ""}${kind} from subagent "${askOrigin(item.entry.request)}" (${REASON[item.entry.reason]})`;
        const w = Math.max(2, width);
        return [
          ...wrapTextWithAnsi(head, w - 1).map((line) => ` ${theme.fg("accent", line)}`),
          ...(n > 1 ? [truncateToWidth(` ${theme.fg("dim", "←/→ other requests")}`, w)] : []),
          ...this.inner(item).render(width),
        ];
      },
      handleInput: (data) => {
        const item = this.items[this.index];
        if (!item) return;
        const inner = this.inner(item);
        const arrow = matchesKey(data, Key.left) ? -1 : matchesKey(data, Key.right) ? 1 : 0;
        // The question dialog's free answer/note editor keeps the arrows for its cursor.
        const editing =
          item.entry.request.kind === "question" &&
          inner.render(this.width).some((line) => line.includes("Enter to submit"));
        if (arrow && this.items.length > 1 && !editing) {
          this.index = (this.index + arrow + this.items.length) % this.items.length;
          this.tui?.requestRender();
          return;
        }
        inner.handleInput(data);
      },
      invalidate: () => {
        for (const item of this.items) item.component?.invalidate();
      },
    };
  }
}
