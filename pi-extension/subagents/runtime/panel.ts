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
  const close = theme.fg("accent", "─╮");
  const left = (withPhase: boolean) =>
    `${theme.fg("accent", "╭─")} ${[...segments, ...(withPhase && phaseSegment ? [phaseSegment] : [])].join(" ")} `;
  let barLeft = left(true);
  let barRight = total > 0 ? ` ${prog} ${count} ${close}` : close;
  const fits = () => visibleWidth(barLeft) + visibleWidth(barRight) + 1 <= width;
  if (!fits() && total > 0) barRight = ` ${count} ${close}`;
  if (!fits()) barLeft = left(false);
  if (!fits()) barLeft = `${truncateAnsi(barLeft, Math.max(0, width - visibleWidth(barRight) - 3))}… `;
  const barFill = Math.max(1, width - visibleWidth(barLeft) - visibleWidth(barRight));
  lines.push(barLeft + theme.fg("accent", "─".repeat(barFill)) + barRight);

  // A row never exceeds the box: longer content (e.g. the legend in a narrow pane) is cut with `…`.
  const fit = (content: string, max: number): string =>
    visibleWidth(content) <= max ? content : `${truncateAnsi(content, Math.max(0, max - 1))}…`;
  const row = (content = ""): string =>
    `${theme.fg("accent", "│")} ${pad(fit(content, width - 4), width - 4)} ${theme.fg("accent", "│")}`;

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
    const dot = note
      ? `${theme.fg(active ? "accent" : "muted", active ? "●" : "○")} ${theme.fg("muted", theme.italic(note))}`
      : "";
    const label = `${arrow} ${theme.bold(group.name)} ${dot}`.trimEnd();
    // Column headers only over groups whose items carry marks (free-text groups have none).
    if (active && headers && group.items.some((item) => item.marks)) {
      // The label must leave a space before the headers: drop the note, then cut, when the pane is narrow.
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
    return { ...entry, icon, iconColor: state.dot === "muted" ? "muted" : state.dot, text };
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
