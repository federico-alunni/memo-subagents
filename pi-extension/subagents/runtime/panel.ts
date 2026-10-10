// Status panel renderer: pure function (data + theme -> string[]), zero runtime dependencies.
// Everything shown comes from the data: brand, title, phase, progress, the stage columns of a staged
// workflow, groups of items, free rows. The extension derives the data from its own subagents, or another
// extension supplies it (see `PANEL_EVENT` in index.ts).
import { truncateAnsi, visibleWidth } from "./mirror-view.ts";
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
  /** Shown instead of the marks when the data declares no columns, or the item has no marks. */
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
  /** Text shown instead of `text` while that subagent waits for the user (e.g. `aspetta una tua risposta`). */
  waitingText?: string;
  elapsed?: string;
  selected?: boolean;
  rightText?: string;
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
  /**
   * Subagent group this panel stands for: subagents started with this `group` belong to it. A panel that names
   * subagents (`group`, or `subagent` on items/rows) is shown only while one of them is alive, while it has
   * `attention`, or within `linger` ms after the last one ended. A panel naming none is always shown.
   */
  group?: string;
  /** Keep the panel visible without live subagents (e.g. a question or a decision waits for the user). */
  attention?: boolean;
  /** Milliseconds the panel stays visible after its last live subagent ended (default 0). */
  linger?: number;
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
  // In a narrow pane it sheds the progress glyphs, then the phase, then cuts the title.
  const segments = [theme.bold(theme.fg("text", brand))];
  if (data.title) segments.push(`${sepBar} ${theme.italic(data.title)}`);
  const phaseSegment = data.phase ? `${sepBar} phase ${theme.bold(data.phase)}` : "";
  const total = data.total ?? 0;
  const done = data.done ?? 0;
  let prog = "";
  for (let i = 0; i < total; i++) prog += i < done ? theme.fg("success", "▰") : theme.fg("muted", "▱");
  const count = theme.bold(theme.fg("text", `${done}/${total}`));
  const waitingRows = data.rows?.filter((r) => r.icon === "?").length ?? 0;
  const activeRows = data.rows?.filter((r) => r.icon === "◐").length ?? 0;
  const borderAccent: MirrorColor = (data.attention || waitingRows > 0) ? "warning" : "accent";
  const close = theme.fg(borderAccent, "─╮");
  const left = (withPhase: boolean) =>
    `${theme.fg(borderAccent, "╭─")} ${[...segments, ...(withPhase && phaseSegment ? [phaseSegment] : [])].join(" ")} `;
  let barLeft = left(true);
  let barRight = close;
  if (total > 0) {
    barRight = ` ${prog} ${count} ${close}`;
  } else if (data.rows && data.rows.length > 0 && (data.title || data.phase || data.attention)) {
    const info = waitingRows > 0
      ? theme.bold(theme.fg("warning", `? ${waitingRows} in attesa`))
      : theme.fg("muted", `${activeRows} active`);
    barRight = ` ${info} ${close}`;
  }
  const fits = () => visibleWidth(barLeft) + visibleWidth(barRight) + 1 <= width;
  if (!fits() && total > 0) barRight = ` ${count} ${close}`;
  if (!fits()) barLeft = left(false);
  if (!fits()) barLeft = `${truncateAnsi(barLeft, Math.max(0, width - visibleWidth(barRight) - 3))}… `;
  const barFill = Math.max(1, width - visibleWidth(barLeft) - visibleWidth(barRight));
  lines.push(barLeft + theme.fg(borderAccent, "─".repeat(barFill)) + barRight);

  // A row never exceeds the box: longer content (e.g. the legend in a narrow pane) is cut with `…`.
  const fit = (content: string, max: number): string =>
    visibleWidth(content) <= max ? content : `${truncateAnsi(content, Math.max(0, max - 1))}…`;
  const row = (content = ""): string =>
    `${theme.fg(borderAccent, "│")} ${pad(fit(content, width - 4), width - 4)} ${theme.fg(borderAccent, "│")}`;

  // Free rows.
  if (data.rows && data.rows.length > 0) {
    const hasSelection = data.rows.some((r) => r.selected);
    const hasElapsed = data.rows.some((r) => r.elapsed);
    for (const item of data.rows) {
      const waiting = item.icon === "?";
      const icon = waiting ? theme.bold(theme.fg(item.iconColor, item.icon)) : theme.fg(item.iconColor, item.icon);
      const sel = hasSelection ? (item.selected ? theme.fg("accent", "▶ ") : "  ") : "";
      const elapsed = hasElapsed ? (item.elapsed ? theme.fg("muted", `${pad(item.elapsed, 6)} `) : "       ") : "";
      const extra = item.extra ? ` ${theme.fg("muted", `· ${item.extra}`)}` : "";
      const text = waiting ? theme.bold(theme.fg("text", item.text)) : theme.italic(item.text);
      const leftPart = `${sel}${icon} ${elapsed}${pad(theme.bold(item.label), 11)}  ${text}${extra}`;
      const rightPart = item.rightText ? theme.fg("muted", item.rightText) : "";
      const innerW = width - 4;
      if (rightPart && visibleWidth(leftPart) + visibleWidth(rightPart) + 2 <= innerW) {
        const fill = innerW - visibleWidth(leftPart) - visibleWidth(rightPart);
        lines.push(row(`${leftPart}${" ".repeat(fill)}${rightPart}`));
      } else {
        lines.push(row(leftPart));
      }
    }
    if (data.hint) {
      lines.push(row(theme.fg("muted", data.hint)));
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
  const idMax = Math.max(6, cellWidth - 2 - 2 - stripWidth - 1 - 5 - 2);
  // An active group's label sits before the column headers: the name column is at least that wide.
  const labelWidth = (group: PanelGroup) =>
    visibleWidth(`▾ ${group.name} ● ${group.note ?? DEFAULT_NOTES[group.status]}`) + 1;
  const headerLabels = data.compact
    ? 0
    : Math.max(0, ...(data.groups ?? []).filter((group) => group.status === "active").map(labelWidth));
  const idW = Math.min(idMax, Math.max(maxNameLen > 0 ? maxNameLen + 1 : 8, headerLabels - 6));
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
    if (!item.marks && item.text) return pad(theme.fg("muted", truncate(item.text, stripWidth)), stripWidth);
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
    const leftPrefix = left?.selected ? `  ${theme.fg("accent", "▸")} ` : "    ";
    const rightPrefix = right?.selected ? ` ${theme.fg("accent", "▸")} ` : "   ";
    return row(`${leftPrefix}${pad(formatCell(left), cellWidth - 2)} ${sepBar}${rightPrefix}${pad(formatCell(right), cellWidth - 2)}`);
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
  const groups = data.groups ?? [];
  if (groups.length === 1) {
    const group = groups[0];
    const active = group.status === "active";
    const arrow = theme.fg(active ? "accent" : "muted", "▾");
    const note = group.note ?? DEFAULT_NOTES[group.status];
    const dot = note
      ? `${theme.fg(active ? "accent" : "muted", active ? "●" : "○")} ${theme.fg("muted", theme.italic(note))}`
      : "";
    const label = `${arrow} ${theme.bold(group.name)} ${dot}`.trimEnd();
    if (active && headers && group.items.some((item) => item.marks)) {
      const room = 2 + 2 + idW + 1;
      const short = `${arrow} ${theme.bold(group.name)} ${theme.fg("accent", "●")}`;
      const fitted = visibleWidth(label) <= room ? label : visibleWidth(short) <= room ? short : fit(short, room);
      const leftPart = pad(fitted, 2 + 2 + idW + 2) + headers;
      const rightPart = " ".repeat(2 + idW + 2) + headers;
      lines.push(row(`${pad(leftPart, 2 + cellWidth)} ${sepBar} ${rightPart}`));
    } else {
      lines.push(row(label));
    }
    for (let i = 0; i < group.items.length; i += 2) lines.push(formatPair(group.items[i], group.items[i + 1]));
  } else if (groups.length >= 2) {
    const groupHeight = (g: PanelGroup): number => (g.status === "completed" ? 1 : 1 + g.items.length);
    let bestSplit = 1;
    let minMax = Infinity;
    for (let i = 1; i < groups.length; i++) {
      const h1 = groups.slice(0, i).reduce((s, g) => s + groupHeight(g), 0);
      const h2 = groups.slice(i).reduce((s, g) => s + groupHeight(g), 0);
      const maxH = Math.max(h1, h2);
      if (maxH < minMax) {
        minMax = maxH;
        bestSplit = i;
      }
    }
    const col1Groups = groups.slice(0, bestSplit);
    const col2Groups = groups.slice(bestSplit);

    const renderColGroupLines = (groupList: PanelGroup[], isLeft: boolean): string[] => {
      const colLines: string[] = [];
      for (const group of groupList) {
        const active = group.status === "active";
        const isCompleted = group.status === "completed";
        const arrow = theme.fg(active ? "accent" : "muted", "▾");
        const note = isCompleted
          ? theme.fg("success", `✓ completata (${group.items.length}/${group.items.length})`)
          : group.note ?? DEFAULT_NOTES[group.status];
        const dot = isCompleted
          ? ` ${note}`
          : note
            ? ` ${theme.fg(active ? "accent" : "muted", active ? "●" : "○")} ${theme.fg("muted", theme.italic(note))}`
            : "";
        const label = `${arrow} ${theme.bold(group.name)}${dot}`.trimEnd();
        const isFirst = colLines.length === 0;

        if (isFirst && headers && group.items.some((item) => item.marks)) {
          const room = cellWidth - visibleWidth(headers) - 1;
          const short = `${arrow} ${theme.bold(group.name)} ${theme.fg(active ? "accent" : "muted", active ? "●" : "○")}`;
          const fitted = visibleWidth(label) <= room ? label : visibleWidth(short) <= room ? short : fit(short, room);
          const fill = cellWidth - visibleWidth(fitted) - visibleWidth(headers);
          const headerLine = `${fitted}${" ".repeat(Math.max(1, fill))}${headers}`;
          colLines.push(isLeft ? `  ${headerLine}` : ` ${headerLine}`);
        } else {
          colLines.push(isLeft ? `  ${pad(label, cellWidth)}` : ` ${pad(label, cellWidth)}`);
        }

        if (!isCompleted) {
          for (const item of group.items) {
            const prefix = isLeft
              ? (item.selected ? `  ${theme.fg("accent", "▸")} ` : "    ")
              : (item.selected ? ` ${theme.fg("accent", "▸")} ` : "   ");
            colLines.push(`${prefix}${pad(formatCell(item), cellWidth - 2)}`);
          }
        }
      }
      return colLines;
    };

    const col1Lines = renderColGroupLines(col1Groups, true);
    const col2Lines = renderColGroupLines(col2Groups, false);
    const maxLines = Math.max(col1Lines.length, col2Lines.length);

    for (let i = 0; i < maxLines; i++) {
      const left = col1Lines[i] ?? `  ${pad("", cellWidth)}`;
      const right = col2Lines[i] ?? ` ${pad("", cellWidth)}`;
      lines.push(row(`${left} ${sepBar}${right}`));
    }
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
  const markRow = (row: PanelRow): PanelRow =>
    row.subagent === undefined ? row : { ...row, selected: row.subagent === subagent };
  return {
    ...data,
    ...(data.items ? { items: data.items.map(mark) } : {}),
    ...(data.groups ? { groups: data.groups.map((group) => ({ ...group, items: group.items.map(mark) })) } : {}),
    ...(data.rows ? { rows: data.rows.map(markRow) } : {}),
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

function formatMMSS(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
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
    const { dot, flag } = agentState(active, now);
    if (dot === "success") done++;
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

/** Dot and flag of a live agent from its lifecycle: completed, waiting for an answer, stalled, working. */
export function agentState(agent: any, now = Date.now()): { dot: PanelDot; flag?: string } {
  const turn = agent?.lifecycle?.turn;
  const since = turn?.stateDurationSince ?? agent?.startTime ?? now;
  if (agent?.lifecycle?.process?.kind === "completed") return { dot: "success" };
  if (turn?.kind === "blocked") return { dot: "warning", flag: `?${formatDuration(now - since)}` };
  if (turn?.kind === "stalled") return { dot: "error", flag: `⚠${formatDuration(now - since)}` };
  if (turn?.kind === "active" || agent?.lifecycle?.process?.kind === "running") return { dot: "accent" };
  return { dot: "muted" };
}

/** A live agent as seen by panels: its name, slot name and group. */
export interface PanelAgent {
  name: string;
  slot?: { name: string };
  group?: string;
  agent?: string;
  /** Short state shown when folded into a panel (default the agent type). */
  text?: string;
  lifecycle?: any;
  startTime?: number;
}

/** Subagent names the panel's items and rows stand for. */
function namedSubagents(data: PanelData): Set<string> {
  const names = new Set<string>();
  for (const item of [...(data.items ?? []), ...(data.groups ?? []).flatMap((group) => group.items)]) {
    if (item.subagent) names.add(item.subagent);
  }
  for (const row of data.rows ?? []) if (row.subagent) names.add(row.subagent);
  return names;
}

/** True when the panel names no subagent at all: it is shown as long as its provider keeps it. */
export function isStaticPanel(data: PanelData): boolean {
  return !data.group && namedSubagents(data).size === 0;
}

/** The item/row name `agent` matches in `data`, if any (a group mismatch never matches). */
function matchName(data: PanelData, agent: PanelAgent, names = namedSubagents(data)): string | undefined {
  if (data.group && agent.group !== undefined && agent.group !== data.group) return undefined;
  if (names.has(agent.name)) return agent.name;
  if (agent.slot && names.has(agent.slot.name)) return agent.slot.name;
  return undefined;
}

/** True when `agent` belongs to the panel: same group, or an item/row stands for it. */
export function belongsToPanel(data: PanelData, agent: PanelAgent): boolean {
  if (data.group && agent.group === data.group) return true;
  return matchName(data, agent) !== undefined;
}

/**
 * The panel with live state merged in: items and rows standing for a live agent take its dot and flag
 * (waiting `?40s`, stalled `⚠12m`). Items without a live agent keep the provider's state.
 */
export function enrichPanel(data: PanelData, agents: PanelAgent[], now = Date.now()): PanelData {
  const names = namedSubagents(data);
  if (names.size === 0) return data;
  const live = new Map<string, PanelAgent>();
  for (const agent of agents) {
    const name = matchName(data, agent, names);
    // The latest agent of a handoff chain wins.
    if (name && (!live.has(name) || (agent.startTime ?? 0) >= (live.get(name)!.startTime ?? 0))) live.set(name, agent);
  }
  if (live.size === 0) return data;
  const item = (entry: PanelItem): PanelItem => {
    const agent = entry.subagent ? live.get(entry.subagent) : undefined;
    if (!agent) return entry;
    const state = agentState(agent, now);
    const { flag: _old, ...rest } = entry;
    return { ...rest, dot: state.dot, ...(state.flag ? { flag: state.flag } : {}) };
  };
  const row = (entry: PanelRow): PanelRow => {
    const agent = entry.subagent ? live.get(entry.subagent) : undefined;
    if (!agent) return entry;
    const state = agentState(agent, now);
    const icon = state.dot === "warning" ? "?" : state.dot === "error" ? "⚠" : state.dot === "success" ? "✓" : "◐";
    const text = icon === "?" && entry.waitingText ? entry.waitingText : entry.text;
    const elapsed = agent.startTime
      ? (state.dot === "success" ? `(${formatDuration(now - agent.startTime)})` : formatMMSS(now - agent.startTime))
      : undefined;
    const plan = (agent as any).runtimePlan;
    const model = plan?.model ?? (agent as any).model;
    const thinking = plan?.thinking ?? (agent as any).thinking;
    const modelId = typeof model === "string" ? (model.includes("/") ? model.slice(model.indexOf("/") + 1) : model) : undefined;
    const modelTag = modelId ? (thinking ? `${modelId}|${thinking}` : modelId) : undefined;
    const turn = (agent as any).lifecycle?.turn;
    const act = state.dot === "warning"
      ? (state.flag ? `question ${state.flag.replace(/^\?/, "")}` : "question")
      : state.dot === "success"
        ? "done"
        : turn?.toolName
          ? `${turn.toolName}${turn.toolStartedAt ? ` ${formatDuration(now - turn.toolStartedAt)}` : ""}`
          : turn?.kind ?? undefined;
    const rightParts = [modelTag, act].filter(Boolean);
    const rightText = rightParts.length > 0 ? rightParts.join(" · ") : undefined;
    return {
      ...entry,
      icon,
      iconColor: state.dot === "muted" ? "muted" : state.dot,
      text,
      ...(elapsed ? { elapsed } : {}),
      ...(rightText ? { rightText } : {}),
    };
  };
  return {
    ...data,
    ...(data.items ? { items: data.items.map(item) } : {}),
    ...(data.groups ? { groups: data.groups.map((group) => ({ ...group, items: group.items.map(item) })) } : {}),
    ...(data.rows ? { rows: data.rows.map(row) } : {}),
  };
}

/** Live agents no item/row of `data` stands for, one per slot (the chain's latest member). */
export function unshownAgents<T extends PanelAgent>(panels: PanelData[], agents: T[]): T[] {
  const bySlot = new Map<string, T>();
  for (const agent of agents) {
    if (panels.some((data) => matchName(data, agent) !== undefined)) continue;
    const key = agent.slot?.name ?? agent.name;
    const prev = bySlot.get(key);
    if (!prev || (agent.startTime ?? 0) >= (prev.startTime ?? 0)) bySlot.set(key, agent);
  }
  return [...bySlot.values()];
}

/** Appends live agents to the panel, so one box shows everything: as rows, compact items, or a last group. */
export function foldAgents(data: PanelData, agents: PanelAgent[], now = Date.now(), label = "subagents"): PanelData {
  if (agents.length === 0) return data;
  if (data.rows) {
    const rows = agents.map((agent): PanelRow => {
      const state = agentState(agent, now);
      const icon = state.dot === "warning" ? "?" : state.dot === "error" ? "⚠" : state.dot === "success" ? "✓" : "◐";
      return {
        icon,
        iconColor: state.dot === "muted" ? "muted" : state.dot,
        label: agent.slot?.name ?? agent.name,
        text: agent.text ?? agent.agent ?? "",
        subagent: agent.slot?.name ?? agent.name,
      };
    });
    return { ...data, rows: [...data.rows, ...rows] };
  }
  const items = agents.map((agent): PanelItem => {
    const state = agentState(agent, now);
    const name = agent.slot?.name ?? agent.name;
    return { id: name, name, ...state, text: agent.text ?? agent.agent ?? "", subagent: name };
  });
  if (data.compact) return { ...data, items: [...(data.items ?? []), ...items] };
  return { ...data, groups: [...(data.groups ?? []), { name: label, status: "active", note: "", items }] };
}
