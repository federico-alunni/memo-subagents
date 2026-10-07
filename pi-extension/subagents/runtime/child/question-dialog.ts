// Adapted from the Pi `question` example extension (MIT, @earendil-works/pi-coding-agent
// examples/extensions/question.ts) with the Tab-note variant of the master profile.
import {
  Editor,
  Key,
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

export interface QuestionOption {
  label: string;
  description?: string;
}
/** Chosen option (with optional note) or a free answer; null = cancelled. */
export type QuestionAnswer =
  | { answer: string; custom: false; index: number; note?: string }
  | { answer: string; custom: true };

interface Theme {
  fg(color: any, text: string): string;
}
export const FREE_ANSWER = "Altro: scrivo io la risposta";

/** Options with descriptions below, Tab for a note, inline free answer, Esc cancels. */
export function questionComponent(
  tui: TUI,
  theme: Theme,
  question: string,
  options: QuestionOption[],
  done: (result: QuestionAnswer | null) => void,
) {
  const all = [
    ...options,
    { label: FREE_ANSWER, other: true },
  ] as (QuestionOption & {
    other?: boolean;
  })[];
  let index = 0,
    editing = false,
    noting = false,
    cached: string[] | undefined;
  const editorTheme: EditorTheme = {
    borderColor: (s) => theme.fg("accent", s),
    selectList: {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    },
  };
  const editor = new Editor(tui, editorTheme);
  const refresh = () => {
    cached = undefined;
    tui.requestRender();
  };
  editor.onSubmit = (value) => {
    const text = value.trim();
    if (noting)
      done({
        answer: all[index].label,
        custom: false,
        index: index + 1,
        note: text || undefined,
      });
    else if (text) done({ answer: text, custom: true });
    else {
      editing = false;
      editor.setText("");
      refresh();
    }
  };
  function handleInput(data: string) {
    if (editing) {
      if (matchesKey(data, Key.escape)) {
        editing = noting = false;
        editor.setText("");
      } else editor.handleInput(data);
      refresh();
      return;
    }
    if (matchesKey(data, Key.up)) index = Math.max(0, index - 1);
    else if (matchesKey(data, Key.down))
      index = Math.min(all.length - 1, index + 1);
    else if (matchesKey(data, Key.tab)) {
      if (all[index].other) return;
      editing = noting = true;
      editor.setText("");
    } else if (matchesKey(data, Key.enter)) {
      if (!all[index].other)
        return done({
          answer: all[index].label,
          custom: false,
          index: index + 1,
        });
      editing = true;
      noting = false;
    } else if (matchesKey(data, Key.escape)) return done(null);
    else return;
    refresh();
  }
  function render(width: number): string[] {
    if (cached) return cached;
    const w = Math.max(1, width),
      lines: string[] = [];
    const add = (prefix: string, text: string) => {
      const pw = visibleWidth(prefix);
      if (pw >= w)
        return void lines.push(...wrapTextWithAnsi(prefix + text, w));
      wrapTextWithAnsi(text, w - pw).forEach((l, i) =>
        lines.push(`${i ? " ".repeat(pw) : prefix}${l}`),
      );
    };
    lines.push(theme.fg("accent", "─".repeat(w)));
    add(" ", theme.fg("text", question));
    lines.push("");
    all.forEach((o, i) => {
      const selected = i === index;
      const label = `${i + 1}. ${o.label}${o.other && editing && !noting ? " ✎" : ""}`;
      add(
        selected ? theme.fg("accent", "> ") : "  ",
        theme.fg(selected ? "accent" : "text", label),
      );
      if (o.description) add("     ", theme.fg("muted", o.description));
    });
    if (editing) {
      lines.push("");
      if (noting) {
        add(
          " ",
          theme.fg("accent", `Scelta: ${index + 1}. ${all[index].label}`),
        );
        add(" ", theme.fg("muted", "Nota / commento (facoltativo):"));
      } else add(" ", theme.fg("muted", "La tua risposta:"));
      for (const l of editor.render(Math.max(1, w - 2))) lines.push(` ${l}`);
    }
    lines.push("");
    add(
      " ",
      theme.fg(
        "dim",
        editing
          ? "Invio per confermare • Esc per tornare alle opzioni"
          : "↑↓ scegli • Invio seleziona • Tab aggiunge una nota • Esc annulla",
      ),
    );
    lines.push(theme.fg("accent", "─".repeat(w)));
    return (cached = lines);
  }
  return { render, handleInput, invalidate: () => void (cached = undefined) };
}

/** Text returned to the child model for an answer (null = cancelled). */
export function answerText(result: QuestionAnswer | null): string {
  if (!result)
    return "L'utente non ha risposto (dialog annullato): non insistere, scegli l'opzione consigliata e dichiaralo nel report.";
  if (result.custom) return `L'utente ha scritto: ${result.answer}`;
  return `L'utente ha scelto: ${result.index}. ${result.answer}${result.note ? `\nNota dell'utente: ${result.note}` : ""}`;
}
