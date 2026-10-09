// Read-only mirror of an agent pane: pure rendering, no I/O and no runtime dependency.
// Input: the screen returned by `herdr pane read <pane> --source visible --format ansi`, a view record
// written by the mirror's owner and a theme. Output: the rows the mirror process paints.

/** Theme tokens the mirror uses (a subset of pi's ThemeColor). */
export type MirrorColor = "accent" | "muted" | "dim" | "success" | "error" | "warning" | "text";
export const MIRROR_COLORS: readonly MirrorColor[] = ["accent", "muted", "dim", "success", "error", "warning", "text"];

/** The few theme operations the renderer needs (pi's Theme satisfies it). */
export interface MirrorTheme {
  fg(token: MirrorColor, text: string): string;
  bold(text: string): string;
  italic(text: string): string;
}

export type MirrorStatus = "starting" | "active" | "waiting" | "question" | "stalled" | "done" | "error";

/** Written by the mirror's owner (atomic replace), read by the mirror process about once a second. */
export const MIN_MIRROR_BOX_ROWS = 6;

export interface MirrorView {
  version: 1;
  slotId?: string;
  /** Pane of the agent currently shown (the slot's active agent); absent while none is known. */
  paneId?: string;
  /** Slot name (the first agent's name). */
  name: string;
  /** Agent definition (or name) of the active agent. */
  agent?: string;
  model?: string;
  thinking?: string;
  branch?: string;
  /** Start of the active agent (header duration). */
  startedAt: number;
  status: MirrorStatus;
  /** The agent waits for the user (question, approval): its dialog is inside the editor, never crop. */
  attention?: boolean;
  /** The slot ended: the owner stops and closes the mirror. */
  ended?: boolean;
  /** SGR foreground prefixes resolved from the owner's pi theme. */
  palette?: Partial<Record<MirrorColor, string>>;
  /** Owner process: the mirror ends itself when it is gone. */
  owner?: { pid: number; identity: string };
}

/** Multi-pane view: a collection of active slots displayed in a single stacked column. */
export interface MultiMirrorView {
  version: 1;
  slots: MirrorView[];
  /** Currently selected slot (e.g. via /subagent or Ctrl+Alt+X) */
  selectedSlotId?: string;
  palette?: Partial<Record<MirrorColor, string>>;
  owner?: { pid: number; identity: string };
}

const ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const SGR = /^\x1b\[[0-9;:]*m$/;
const OSC = /^\x1b\]/;

export function stripAnsi(text: string): string {
  return text.replace(ESCAPE, "");
}

function charWidth(code: number): number {
  if (code === 0 || code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if ((code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || code === 0xfe0f) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
    return 2;
  return 1;
}

export function visibleWidth(text: string): number {
  let width = 0;
  for (const ch of stripAnsi(text)) width += charWidth(ch.codePointAt(0)!);
  return width;
}

/**
 * Cut a terminal line to `width` cells. SGR and OSC 8 sequences are kept (zero width), any other
 * control sequence is dropped, wide characters are never split, and the result ends with a reset.
 */
export function truncateAnsi(line: string, width: number): string {
  let out = "";
  let used = 0;
  let last = 0;
  const take = (text: string): boolean => {
    for (const ch of text) {
      const w = charWidth(ch.codePointAt(0)!);
      if (used + w > width) return false;
      out += ch;
      used += w;
    }
    return true;
  };
  for (const match of line.matchAll(ESCAPE)) {
    if (!take(line.slice(last, match.index))) return `${out}\x1b[0m`;
    if (SGR.test(match[0]) || OSC.test(match[0])) out += match[0];
    last = match.index! + match[0].length;
  }
  take(line.slice(last));
  return `${out}\x1b[0m`;
}

/** Rows of a `pane read` capture (CRLF or LF), without a trailing empty row. */
export function splitScreen(raw: string): string[] {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

const EDITOR_BORDER = /^─{10,}$|^──+ .* ─{10,}$/;
/** The editor's lower border is followed by pi's footer only (status bar, path/branch, tokens). */
const MAX_FOOTER_LINES = 4;

/**
 * Remove pi's chat bar: from the bottom, the last two editor borders (the upper one may carry a label,
 * e.g. `── ⠴ Working ──`); the input rows between them and the lower border go, the upper border, the
 * status rows above it and the footer below stay. When the agent waits for the user its dialog is drawn
 * inside the editor borders, so nothing is cropped; nor without two borders right above the footer.
 */
export function cropChatBar(lines: string[], options: { attention?: boolean } = {}): { lines: string[]; cropped: boolean } {
  if (options.attention) return { lines, cropped: false };
  const borders: number[] = [];
  for (let i = lines.length - 1; i >= 0 && borders.length < 2; i--)
    if (EDITOR_BORDER.test(stripAnsi(lines[i]).trim())) borders.push(i);
  if (borders.length < 2) return { lines, cropped: false };
  const [bottom, top] = borders;
  const footer = lines.slice(bottom + 1).filter((line) => stripAnsi(line).trim() !== "");
  if (footer.length > MAX_FOOTER_LINES) return { lines, cropped: false };
  return { lines: [...lines.slice(0, top + 1), ...lines.slice(bottom + 1)], cropped: true };
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function statusSymbol(status: MirrorStatus, theme: MirrorTheme): string {
  switch (status) {
    case "question":
      return theme.bold(theme.fg("warning", "?"));
    case "stalled":
      return theme.fg("error", "●");
    case "done":
      return theme.fg("success", "✓");
    case "error":
      return theme.fg("error", "✗");
    case "waiting":
      return theme.fg("muted", "○");
    case "starting":
      return theme.fg("accent", "◐");
    default:
      return theme.fg("accent", "●");
  }
}

/**
 * `╭─ <status> <slot> │ <agent> │ ⎇ <branch> ─── <duration> ─╮`, exactly `width` cells: when narrow the
 * branch goes first, then the agent, then the name is truncated.
 */
export function mirrorHeader(view: MirrorView, width: number, theme: MirrorTheme, now = Date.now()): string {
  const right = ` ${theme.fg("muted", formatDuration(now - view.startedAt))} ${theme.fg("accent", "─╮")}`;
  const hint = view.attention ? ` ${theme.bold(theme.fg("warning", "[rispondi qui]"))}` : "";
  const name = `${theme.fg("accent", "⧉")} ${theme.bold(theme.fg("text", view.name))}${hint}`;
  const sep = ` ${theme.fg("muted", "│")} `;
  const modelId = view.model ? (view.model.includes("/") ? view.model.slice(view.model.indexOf("/") + 1) : view.model) : undefined;
  const modelTag = modelId ? (view.thinking && view.thinking !== "off" ? `${modelId}|${view.thinking}` : modelId) : undefined;
  const variants = [
    [name, ...(view.agent ? [theme.italic(view.agent)] : []), ...(modelTag ? [theme.fg("muted", modelTag)] : []), ...(view.branch ? [`${theme.fg("accent", "⎇")} ${view.branch}`] : [])],
    [name, ...(view.agent ? [theme.italic(view.agent)] : []), ...(modelTag ? [theme.fg("muted", modelTag)] : [])],
    [name, ...(view.agent ? [theme.italic(view.agent)] : [])],
    [name],
  ];
  for (const parts of variants) {
    const left = `${theme.fg("accent", "╭─")} ${statusSymbol(view.status, theme)} ${parts.join(sep)} `;
    const fill = width - visibleWidth(left) - visibleWidth(right);
    if (fill >= 3) return `${left}${theme.fg("accent", "─".repeat(fill))}${right}`;
  }
  // Very narrow: keep the frame, cut the content.
  const left = truncateAnsi(`${theme.fg("accent", "╭─")} ${statusSymbol(view.status, theme)} ${name}`, Math.max(0, width - 2));
  return `${left}${" ".repeat(Math.max(0, width - 2 - visibleWidth(left)))}${theme.fg("accent", "─╮")}`;
}

/**
 * The whole mirror: header, then the cropped screen between accent side borders (no bottom border),
 * anchored at the bottom when taller than the mirror, top aligned otherwise. Exactly rows × columns.
 */
export function renderMirrorLines(
  view: MirrorView,
  screen: string[],
  rows: number,
  columns: number,
  theme: MirrorTheme,
  now = Date.now(),
): string[] {
  if (rows <= 0 || columns <= 0) return [];
  const inner = Math.max(0, columns - 2);
  const { lines } = cropChatBar(screen, { attention: view.attention });
  const body = lines.slice(Math.max(0, lines.length - (rows - 1)));
  const side = theme.fg("accent", "│");
  const out = [mirrorHeader(view, columns, theme, now)];
  for (const line of body) {
    const cut = truncateAnsi(line, inner);
    out.push(`${side}${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut)))}${side}`);
  }
  while (out.length < rows) out.push(`${side}${" ".repeat(inner)}${side}`);
  return out;
}

/**
 * Render N worker mirrors stacked vertically in a single terminal column of `rows` x `columns`.
 * Available rows are distributed evenly. If there are more slots than can fit (minimum 6 rows per box),
 * only the top slots are shown and an overflow notice is placed in the bottom box.
 */
export function renderStackedMirrors(
  slots: MirrorView[],
  screens: Map<string, string[]>,
  rows: number,
  columns: number,
  theme: MirrorTheme,
  now = Date.now(),
): string[] {
  if (rows <= 0 || columns <= 0) return [];
  const inner = Math.max(0, columns - 2);
  const side = theme.fg("accent", "│");
  if (slots.length === 0) {
    return Array.from({ length: rows }, () => `${side}${" ".repeat(inner)}${side}`);
  }
  if (slots.length === 1) {
    const screen = screens.get(slots[0].paneId ?? "") ?? [];
    return renderMirrorLines(slots[0], screen, rows, columns, theme, now);
  }

  const maxFit = Math.max(1, Math.floor(rows / MIN_MIRROR_BOX_ROWS));
  const visibleCount = Math.min(slots.length, maxFit);
  const overflow = slots.length - visibleCount;

  const base = Math.floor(rows / visibleCount);
  const rem = rows % visibleCount;

  const out: string[] = [];
  for (let i = 0; i < visibleCount; i++) {
    const boxHeight = base + (i < rem ? 1 : 0);
    const slot = slots[i];
    const screen = screens.get(slot.paneId ?? "") ?? [];
    const box = renderMirrorLines(slot, screen, boxHeight, columns, theme, now);

    // If there is overflow, replace the last row of the last visible box with an overflow notice
    if (i === visibleCount - 1 && overflow > 0 && box.length > 1) {
      const notice = ` ${theme.fg("muted", `… (+${overflow} more in background)`)} `;
      const fill = Math.max(0, inner - visibleWidth(notice));
      box[box.length - 1] = `${side}${notice}${" ".repeat(fill)}${side}`;
    }
    out.push(...box);
  }

  // Ensure exact row count
  while (out.length < rows) out.push(`${side}${" ".repeat(inner)}${side}`);
  return out.slice(0, rows);
}

/**
 * Repaint without flicker: home, each row painted over the previous frame, erased to its end only when it
 * is shorter than the terminal, then the rest of the screen. A full-width row must NOT be followed by an
 * erase: with autowrap off the cursor stays on the last column, and `\x1b[K` erases from the cursor
 * included, i.e. it would wipe the row's last cell (the right border).
 */
export function renderMirrorFrame(lines: string[], columns = Number.POSITIVE_INFINITY): string {
  const rows = lines.map((line) => `\x1b[0m${line}\x1b[0m${visibleWidth(line) < columns ? "\x1b[K" : ""}`);
  return `\x1b[H${rows.join("\r\n")}\x1b[J`;
}

/** SGR prefixes of the mirror's tokens from a pi theme (resolved by the owner, which has the theme). */
export function themePalette(theme: { getFgAnsi(token: string): string }): Partial<Record<MirrorColor, string>> {
  const palette: Partial<Record<MirrorColor, string>> = {};
  for (const token of MIRROR_COLORS) {
    try {
      const sgr = theme.getFgAnsi(token);
      if (typeof sgr === "string" && SGR.test(sgr)) palette[token] = sgr;
    } catch {
      // Token missing in this theme: plain text.
    }
  }
  return palette;
}

/** A MirrorTheme from palette prefixes; anything that is not a plain SGR sequence is ignored. */
export function paletteTheme(palette: Partial<Record<MirrorColor, string>>): MirrorTheme {
  return {
    fg: (token, text) => {
      const sgr = palette[token];
      return typeof sgr === "string" && SGR.test(sgr) ? `${sgr}${text}\x1b[39m` : text;
    },
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
    italic: (text) => `\x1b[3m${text}\x1b[23m`,
  };
}

export type DecodedInput =
  | { kind: "key"; name: "up" | "down" | "left" | "right" | "enter" | "esc" | "tab" | "backspace" }
  | { kind: "text"; text: string };

/**
 * Decodes raw terminal input bytes during an active dialog (question, approval) into a key or text
 * for `herdr pane send-keys` / `send-text`. Anything outside the dialog grammar (e.g. Ctrl+C) is dropped.
 */
export function decodeInputKey(chunk: Buffer): DecodedInput | undefined {
  if (chunk.length === 0) return undefined;
  // Arrow keys (standard VT100/ANSI CSI sequence)
  if (chunk.length === 3 && chunk[0] === 0x1b && chunk[1] === 0x5b) {
    if (chunk[2] === 0x41) return { kind: "key", name: "up" };
    if (chunk[2] === 0x42) return { kind: "key", name: "down" };
    if (chunk[2] === 0x43) return { kind: "key", name: "right" };
    if (chunk[2] === 0x44) return { kind: "key", name: "left" };
  }
  // Single-byte control keys
  if (chunk.length === 1) {
    const b = chunk[0];
    if (b === 0x0d || b === 0x0a) return { kind: "key", name: "enter" };
    if (b === 0x1b) return { kind: "key", name: "esc" };
    if (b === 0x09) return { kind: "key", name: "tab" };
    if (b === 0x7f || b === 0x08) return { kind: "key", name: "backspace" };
    // Printable ASCII
    if (b >= 0x20 && b <= 0x7e) return { kind: "text", text: String.fromCharCode(b) };
    return undefined;
  }
  // Multibyte printable text (e.g. UTF-8 pasting or fast typing)
  const str = chunk.toString("utf8");
  // If it contains control chars (other than regular text), drop it
  if (/[ -]/.test(str)) return undefined;
  return { kind: "text", text: str };
}
