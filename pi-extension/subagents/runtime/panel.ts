// Status panel renderer: pure function (data + theme -> string[]), zero runtime dependencies.
// Everything shown comes from the data: brand, title, phase, progress, the stage columns of a staged
// workflow, groups of items, free rows. The extension derives the data from its own subagents, or another
// extension supplies it (see `PANEL_EVENT` in index.ts).
import { visibleWidth } from "./mirror-view.ts";
import type { MirrorColor, MirrorTheme } from "./mirror-view.ts";

/** Builtin progress of one stage of an item. */
export type PanelMarkState = "done" | "active" | "pending";
/** A free mark (e.g. `↺2` in warning for a correction loop). */
export interface PanelMark {
  text: string;
  color?: MirrorColor;
}
export type PanelMarkValue = PanelMarkState | PanelMark;

/** A stage column of a staged workflow (e.g. build, review). */
export interface PanelColumn {
  key: string;
  /** Header glyph shown above the column and in the legend, e.g. `B`. */
  header: string;
  /** Legend text after the header, e.g. `build`. Omitted columns are left out of the legend. */
  legend?: string;
  /** Cell width (default the header width, minimum 1). */
  width?: number;
  /** Glyphs for the builtin states (defaults `✓`, `▶`, `·`). */
  glyphs?: Partial<Record<PanelMarkState, string>>;
}

export type PanelDot = "success" | "accent" | "error" | "warning" | "muted";

export interface PanelItem {
  id: string;
  name: string;
  dot: PanelDot;
  /** Marks by column key; a missing mark is `pending`. */
  marks?: Record<string, PanelMarkValue>;
  /** Shown instead of the marks when the data declares no columns. */
  text?: string;
  /** Short flag at the end of the cell: `?40s` (warning, waits for an answer) or anything else (error, e.g. `⚠12m`). */
  flag?: string;
  /** Selection marker `▸` before the dot. */
  selected?: boolean;
  /** Name of the subagent/slot this item stands for: the extension marks it selected when it is. */
  subagent?: string;
}

export interface PanelGroup {
  name: string;
  status: "active" | "queued" | "completed";
  /** Status text after the group name (defaults `attiva`, `in coda`, `completata`). */
  note?: string;
  items: PanelItem[];
}

/** A free row: icon, label, text, optional muted extra (e.g. `↳ planner`). */
export interface PanelRow {
  icon: string;
  iconColor: MirrorColor;
  label: string;
  text: string;
  extra?: string;
  /** Name of the subagent this row stands for (its own row is then left out). */
  subagent?: string;
}

export interface PanelLegendEntry {
  mark: string;
  color?: MirrorColor;
  label: string;
}

export interface PanelData {
  /** Brand glyph and label of the top bar (defaults `⧉`, `Subagents`). */
  icon?: string;
  label?: string;
  title?: string;
  phase?: string;
  /** Progress bar: shown only with `total > 0`. */
  done?: number;
  total?: number;
  /** Free rows; when present they are the whole body. */
  rows?: PanelRow[];
  /** Stage columns shared by every item. */
  columns?: PanelColumn[];
  /** Legend entries after the columns (e.g. `● stallo`). */
  legend?: PanelLegendEntry[];
  groups?: PanelGroup[];
  /** Compact: `items` in pairs, no legend nor group headers. */
  compact?: boolean;
  items?: PanelItem[];
  /** Detail row under the grid for the selected item. */
  detail?: { branch?: string; status?: string };
  /** Right-aligned hint on the detail row. */
  hint?: string;
}

const DEFAULT_GLYPHS: Record<PanelMarkState, string> = { done: "✓", active: "▶", pending: "·" };
const DEFAULT_NOTES: Record<PanelGroup["status"], string> = { active: "attiva", queued: "in coda", completed: "completata" };
/** Strip width reserved for names when there are no columns. */
const TEXT_STRIP_WIDTH = 10;

function pad(text: string, width: number): string {
  const vis = visibleWidth(text);
  return vis >= width ? text : text + " ".repeat(width - vis);
}

function truncate(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  let out = "";
  for (const ch of Array.from(text)) {
    if (visibleWidth(out) + 1 >= maxWidth) return out + "…";
    out += ch;
  }
  return out + "…";
}

const columnWidth = (column: PanelColumn): number => Math.max(1, column.width ?? 0, visibleWidth(column.header));

/** Renders the panel; every line is exactly `width` columns wide. */
export function renderPanel(data: PanelData, width: number, theme: MirrorTheme): string[] {
  const lines: string[] = [];
  const columns = data.columns ?? [];
  const brand = [data.icon ?? "⧉", data.label ?? "Subagents"].filter(Boolean).join("  ");
  const sepBar = theme.fg("muted", "│");

  // Top bar: ╭─ <icon>  <label> │ <title> │ phase <phase> ──────── <progress> <done>/<total> ─╮
  const segments = [theme.bold(theme.fg("text", brand))];
  if (data.title) segments.push(`${sepBar} ${theme.italic(data.title)}`);
  if (data.phase) segments.push(`${sepBar} phase ${theme.bold(data.phase)}`);
  const barLeft = `${theme.fg("accent", "╭─")} ${segments.join(" ")} `;
  const total = data.total ?? 0;
  const done = data.done ?? 0;
  let prog = "";
  for (let i = 0; i < total; i++) prog += i < done ? theme.fg("success", "▰") : theme.fg("muted", "▱");
  const barRight = total > 0
    ? ` ${prog} ${theme.bold(theme.fg("text", `${done}/${total}`))} ${theme.fg("accent", "─╮")}`
    : theme.fg("accent", "─╮");
  const barFill = Math.max(1, width - visibleWidth(barLeft) - visibleWidth(barRight));
  lines.push(barLeft + theme.fg("accent", "─".repeat(barFill)) + barRight);

  const row = (content = ""): string =>
    `${theme.fg("accent", "│")} ${pad(content, width - 4)} ${theme.fg("accent", "│")}`;

  // Free rows.
  if (data.rows && data.rows.length > 0) {
    for (const item of data.rows) {
      const waiting = item.icon === "?";
      const icon = waiting ? theme.bold(theme.fg(item.iconColor, item.icon)) : theme.fg(item.iconColor, item.icon);
      const extra = item.extra ? ` ${theme.fg("muted", `· ${item.extra}`)}` : "";
      const text = waiting ? theme.bold(theme.fg("text", item.text)) : theme.italic(item.text);
      lines.push(row(`${icon} ${pad(theme.bold(item.label), 11)}  ${text}${extra}`));
    }
    return lines;
  }

  // Grid metrics.
  const stripWidth = columns.length > 0
    ? columns.reduce((sum, column) => sum + columnWidth(column), 0) + columns.length - 1
    : TEXT_STRIP_WIDTH;
  const cellWidth = Math.floor((width - 4 - 2 - 3) / 2);
  const allItems: PanelItem[] = data.compact ? (data.items ?? []) : (data.groups ?? []).flatMap((group) => group.items);
  const maxNameLen = Math.max(0, ...allItems.map((item) => visibleWidth(item.name)));
  const idMax = Math.max(8, cellWidth - 2 - 2 - stripWidth - 1 - 5);
  const idW = Math.min(idMax, maxNameLen > 0 ? maxNameLen + 1 : 8);
  // Without columns the free text takes the strip and whatever the name column leaves.
  const textWidth = Math.max(stripWidth, cellWidth - (2 + idW) - 2 - 1 - 5);

  const formatMark = (column: PanelColumn, value: PanelMarkValue | undefined): string => {
    const cell = columnWidth(column);
    if (value !== undefined && typeof value === "object") {
      return pad(value.color ? theme.fg(value.color, value.text) : value.text, cell);
    }
    const state = value ?? "pending";
    const glyph = column.glyphs?.[state] ?? DEFAULT_GLYPHS[state];
    const styled =
      state === "done" ? theme.fg("success", glyph)
      : state === "active" ? theme.bold(theme.fg("accent", glyph))
      : theme.fg("muted", glyph);
    return pad(styled, cell);
  };

  const formatStrip = (item: PanelItem): string => {
    if (columns.length === 0) return pad(theme.fg("muted", truncate(item.text ?? "", textWidth)), textWidth);
    return columns.map((column) => formatMark(column, item.marks?.[column.key])).join(" ");
  };

  const formatCell = (item?: PanelItem): string => {
    if (!item) return pad("", cellWidth);
    const name = truncate(item.name, idW);
    const nameStyled = item.dot === "muted" ? theme.fg("muted", name) : theme.bold(name);
    const nameCol = pad(`${theme.fg(item.dot, "●")} ${nameStyled}`, 2 + idW);
    const flag = item.flag
      ? item.flag.startsWith("?") ? theme.bold(theme.fg("warning", item.flag)) : theme.fg("error", item.flag)
      : "";
    return `${nameCol}  ${pad(formatStrip(item), columns.length > 0 ? stripWidth : textWidth)} ${pad(flag, 5)}`;
  };

  const formatPair = (left?: PanelItem, right?: PanelItem): string => {
    const leftPrefix = left?.selected ? ` ${theme.fg("accent", "▸")}` : "  ";
    const rightPrefix = right?.selected ? theme.fg("accent", "▸") : " ";
    return row(`${leftPrefix}${pad(formatCell(left), cellWidth)} ${sepBar}${rightPrefix}${pad(formatCell(right), cellWidth)}`);
  };

  // Compact: pairs of items only.
  if (data.compact) {
    const items = data.items ?? [];
    for (let i = 0; i < items.length; i += 2) lines.push(formatPair(items[i], items[i + 1]));
    return lines;
  }

  // Legend: the columns, then the extra entries.
  const legendParts = [
    ...columns
      .filter((column) => column.legend)
      .map((column) => `${theme.bold(column.header)}${theme.fg("muted", ` ${column.legend}`)}`),
    ...(data.legend ?? []).map((entry) =>
      `${entry.color ? theme.fg(entry.color, entry.mark) : entry.mark}${theme.fg("muted", ` ${entry.label}`)}`),
  ];
  if (legendParts.length > 0) lines.push(row(legendParts.join(theme.fg("muted", " · "))));

  const headers = columns.length > 0
    ? theme.fg("muted", theme.bold(columns.map((column) => pad(column.header, columnWidth(column))).join(" ")))
    : "";
  for (const group of data.groups ?? []) {
    const active = group.status === "active";
    const arrow = theme.fg(active ? "accent" : "muted", "▾");
    const note = group.note ?? DEFAULT_NOTES[group.status];
    const dot = active
      ? `${theme.fg("accent", "●")} ${theme.fg("muted", theme.italic(note))}`
      : `${theme.fg("muted", "○")} ${theme.fg("muted", theme.italic(note))}`;
    const label = `${arrow} ${theme.bold(group.name)} ${dot}`;
    if (active && headers) {
      const leftPart = pad(label, 2 + 2 + idW + 2) + headers;
      const rightPart = " ".repeat(2 + idW + 2) + headers;
      lines.push(row(`${pad(leftPart, 2 + cellWidth)} ${sepBar} ${rightPart}`));
    } else {
      lines.push(row(label));
    }
    for (let i = 0; i < group.items.length; i += 2) lines.push(formatPair(group.items[i], group.items[i + 1]));
  }

  // Detail row for the selected item, hint right-aligned when there is room.
  if (data.detail && (data.detail.branch || data.detail.status)) {
    const branch = data.detail.branch ? `${theme.fg("accent", "⎇")} ${data.detail.branch}` : "";
    const status = data.detail.status ? `· ${data.detail.status}` : "";
    const detailLeft = `  ${branch} ${status}`.trimEnd();
    const hint = data.hint ? theme.fg("muted", data.hint) : "";
    const fill = width - 4 - visibleWidth(detailLeft) - visibleWidth(hint);
    lines.push(row(fill >= 2 ? `${detailLeft}${" ".repeat(fill)}${hint}` : detailLeft));
  }

  return lines;
}

/** Marks every item standing for `subagent` as selected (and only those, when a name is given). */
export function markSelected(data: PanelData, subagent: string | undefined): PanelData {
  if (!subagent) return data;
  const mark = (item: PanelItem): PanelItem =>
    item.subagent === undefined ? item : { ...item, selected: item.subagent === subagent };
  return {
    ...data,
    ...(data.items ? { items: data.items.map(mark) } : {}),
    ...(data.groups ? { groups: data.groups.map((group) => ({ ...group, items: group.items.map(mark) })) } : {}),
  };
}

/** Light shape check for data received from another extension. */
export function isPanelData(value: unknown): value is PanelData {
  if (!value || typeof value !== "object") return false;
  const data = value as PanelData;
  const optionalArray = (key: keyof PanelData) => data[key] === undefined || Array.isArray(data[key]);
  return optionalArray("rows") && optionalArray("columns") && optionalArray("groups") && optionalArray("items") && optionalArray("legend");
}

function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m`;
}

/**
 * Panel data from the extension's own running subagents grouped in worktree slots: one item per slot with
 * its state dot, flag (`?Ns` waiting for an answer, `⚠Nm` stalled) and agent chain.
 */
export function buildSlotPanelData(agents: any[], selectedSlotId?: string, now = Date.now()): PanelData {
  const slots = new Map<string, any[]>();
  for (const agent of agents) {
    const key = agent.slot?.id ?? agent.id;
    slots.set(key, [...(slots.get(key) ?? []), agent]);
  }
  const selectedKey = selectedSlotId ?? slots.keys().next().value;
  const items: PanelItem[] = [];
  let done = 0;
  let detail: PanelData["detail"];
  for (const [key, members] of slots) {
    const sorted = [...members].sort((a, b) => a.startTime - b.startTime);
    const active = sorted[sorted.length - 1];
    const first = sorted[0];
    const turn = active.lifecycle?.turn;
    const since = turn?.stateDurationSince ?? active.startTime;
    let dot: PanelDot = "muted";
    let flag: string | undefined;
    if (active.lifecycle?.process?.kind === "completed") {
      dot = "success";
      done++;
    } else if (turn?.kind === "blocked") {
      dot = "warning";
      flag = `?${formatDuration(now - since)}`;
    } else if (turn?.kind === "stalled") {
      dot = "error";
      flag = `⚠${formatDuration(now - since)}`;
    } else if (turn?.kind === "active" || active.lifecycle?.process?.kind === "running") {
      dot = "accent";
    }
    const chain: string[] = first.slot?.chain ?? [first.name];
    const selected = key === selectedKey;
    if (selected) {
      detail = {
        branch: first.slot?.worktree?.branch ?? first.worktree?.branch,
        status: `${dot === "success" ? "done" : "active"} · ${active.agent ?? active.name}`,
      };
    }
    items.push({
      id: key,
      name: first.slot?.name ?? first.name,
      dot,
      text: chain.length > 1 ? chain.join(" › ") : (active.agent ?? ""),
      ...(flag ? { flag } : {}),
      selected,
    });
  }
  return {
    phase: items.some((item) => item.dot === "accent" || item.dot === "warning") ? "running" : "idle",
    done,
    total: items.length,
    groups: [{ name: "workers", status: "active", items }],
    ...(detail ? { detail } : {}),
    hint: "/subagent · Ctrl+Alt+X",
  };
}
