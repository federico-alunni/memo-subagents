// Convoy Panel renderer: pure function (data + theme -> string[]), zero runtime dependencies.
// Implements the approved issue #86 design (riquadro ⛟, fasi, griglia a 2 colonne).
import { stripAnsi, visibleWidth } from "./mirror-view.ts";
import type { MirrorColor, MirrorTheme } from "./mirror-view.ts";

export type ConvoyStageProgress = "completed" | "active" | "pending";

export interface ConvoyStageState {
  build: ConvoyStageProgress;
  simplify: ConvoyStageProgress;
  review: ConvoyStageProgress;
  /** `pending` or number of correction iterations (e.g. 2 for ↺2) */
  correction?: "pending" | number;
  checkpoint: boolean;
}

export type ConvoyTaskDot = "success" | "accent" | "error" | "warning" | "muted";

export interface ConvoyTaskItem {
  id: string;
  name: string;
  dot: ConvoyTaskDot;
  stages?: ConvoyStageState;
  /** Stall warning (e.g. "⚠12m") or question duration (e.g. "?40s") */
  stall?: string;
  /** Extension: selection indicator ▸ */
  selected?: boolean;
}

export interface ConvoyPhaseSection {
  name: string;
  status: "active" | "queued" | "completed";
  tasks: ConvoyTaskItem[];
}

export interface ConvoyPlanningItem {
  icon: "?" | "✓" | "◐" | string;
  iconColor: MirrorColor;
  label: string;
  text: string;
  extra?: string;
}

export interface ConvoySelectedDetail {
  branch?: string;
  status?: string;
}

export interface ConvoyPanelData {
  title?: string;
  phase: string;
  done: number;
  total: number;
  planning?: ConvoyPlanningItem[];
  phases?: ConvoyPhaseSection[];
  compact?: boolean;
  tasks?: ConvoyTaskItem[]; // compact mode tasks
  selectedDetail?: ConvoySelectedDetail;
  showHint?: boolean;
}

const CELL_W = 10; // "B S R C  ☑"

function pad(text: string, width: number): string {
  const vis = visibleWidth(text);
  return vis >= width ? text : text + " ".repeat(width - vis);
}

function truncateName(name: string, maxWidth: number): string {
  const vis = visibleWidth(name);
  if (vis <= maxWidth) return name;
  const chars = Array.from(name);
  let w = 0;
  let out = "";
  for (const ch of chars) {
    if (w + 1 >= maxWidth) return out + "…";
    out += ch;
    w += 1;
  }
  return out + "…";
}

/**
 * Pure Convoy Panel renderer following the approved issue #86 specification.
 */
export function renderConvoyPanel(
  data: ConvoyPanelData,
  width: number,
  theme: MirrorTheme,
): string[] {
  const lines: string[] = [];
  const title = data.title ?? "panel-refresh";

  // 1. Top bar: ╭─ ⛟  Convoy │ <title> │ phase <phase> ──────── <progress> <done>/<total> ─╮
  const barLeft = `${theme.fg("accent", "╭─")} ${theme.bold(theme.fg("text", "⛟  Convoy"))} ${theme.fg("muted", "│")} ${theme.italic(title)} ${theme.fg("muted", "│")} phase ${theme.bold(data.phase)} `;
  let prog = "";
  for (let i = 0; i < data.total; i++) {
    prog += i < data.done ? theme.fg("success", "▰") : theme.fg("muted", "▱");
  }
  // Without tasks yet (e.g. planning) there is nothing to count: no progress bar.
  const barRight = data.total > 0
    ? ` ${prog} ${theme.bold(theme.fg("text", `${data.done}/${data.total}`))} ${theme.fg("accent", "─╮")}`
    : ` ${theme.fg("accent", "─╮")}`;
  const barFill = Math.max(1, width - visibleWidth(barLeft) - visibleWidth(barRight));
  lines.push(barLeft + theme.fg("accent", "─".repeat(barFill)) + barRight);

  const row = (content = ""): string =>
    `${theme.fg("accent", "│")} ${pad(content, width - 4)} ${theme.fg("accent", "│")}`;

  // 2. Scenario 1: Planning stage (no workers yet)
  if (data.planning && data.planning.length > 0) {
    for (const item of data.planning) {
      const icon =
        item.icon === "?"
          ? theme.bold(theme.fg(item.iconColor, "?"))
          : theme.fg(item.iconColor, item.icon);
      const label = theme.bold(item.label);
      const extra = item.extra ? ` ${theme.fg("muted", `· ${item.extra}`)}` : "";
      const textStyle = item.icon === "?" ? theme.bold(theme.fg("text", item.text)) : theme.italic(item.text);
      lines.push(row(`${icon} ${pad(label, 11)}  ${textStyle}${extra}`));
    }
    return lines;
  }

  // Calculate grid metrics
  const cellWidth = Math.floor((width - 4 - 2 - 3) / 2);
  const allTasks: ConvoyTaskItem[] = data.compact
    ? (data.tasks ?? [])
    : (data.phases ?? []).flatMap((p) => p.tasks);
  const maxTaskLen = Math.max(0, ...allTasks.map((t) => visibleWidth(t.name)));
  const idMax = Math.max(8, cellWidth - 2 - 2 - CELL_W - 1 - 5);
  const idW = Math.min(idMax, maxTaskLen > 0 ? maxTaskLen + 1 : 8);

  const formatStageIcon = (p: ConvoyStageProgress): string => {
    if (p === "completed") return theme.fg("success", "✓");
    if (p === "active") return theme.bold(theme.fg("accent", "▶"));
    return theme.fg("muted", "·");
  };

  const formatStages = (st?: ConvoyStageState): string => {
    if (!st) return pad("", CELL_W);
    const b = formatStageIcon(st.build);
    const s = formatStageIcon(st.simplify);
    const r = formatStageIcon(st.review);
    const c =
      st.correction !== undefined && st.correction !== "pending"
        ? theme.fg("warning", `↺${st.correction}`)
        : theme.fg("muted", "·");
    const cp = st.checkpoint ? theme.fg("success", "☑") : theme.fg("muted", "☐");
    return `${b} ${s} ${r} ${pad(c, 2)} ${cp}`;
  };

  const formatDot = (d: ConvoyTaskDot): string => {
    if (d === "success") return theme.fg("success", "●");
    if (d === "accent") return theme.fg("accent", "●");
    if (d === "error") return theme.fg("error", "●");
    if (d === "warning") return theme.fg("warning", "●");
    return theme.fg("muted", "●");
  };

  const formatCell = (t?: ConvoyTaskItem): string => {
    if (!t) return pad("", cellWidth);
    const name = truncateName(t.name, idW);
    const nameStyled = t.dot === "muted" ? theme.fg("muted", name) : theme.bold(name);
    const dot = formatDot(t.dot);
    const nameCol = pad(`${dot} ${nameStyled}`, 2 + idW);
    const stagesCol = pad(formatStages(t.stages), CELL_W);

    let stallCol = "";
    if (t.stall) {
      stallCol = t.stall.startsWith("?")
        ? theme.bold(theme.fg("warning", t.stall))
        : theme.fg("error", t.stall);
    }
    return `${nameCol}  ${stagesCol} ${pad(stallCol, 5)}`;
  };

  const sep = theme.fg("muted", "│");

  const formatPair = (left?: ConvoyTaskItem, right?: ConvoyTaskItem): string => {
    const leftCell = formatCell(left);
    const rightCell = formatCell(right);
    const leftPrefix = left?.selected ? ` ${theme.fg("accent", "▸")}` : "  ";
    const rightPrefix = right?.selected ? `${theme.fg("accent", "▸")}` : " ";
    return row(`${leftPrefix}${pad(leftCell, cellWidth)} ${sep}${rightPrefix}${pad(rightCell, cellWidth)}`);
  };

  // 3. Compact mode: directly pairs of active tasks
  if (data.compact) {
    const tasks = data.tasks ?? [];
    for (let i = 0; i < tasks.length; i += 2) {
      lines.push(formatPair(tasks[i], tasks[i + 1]));
    }
    return lines;
  }

  // 4. Execution mode: Legend + grouped phases
  const legend =
    `${theme.fg("muted", theme.bold("B"))}${theme.fg("muted", " build · ")}` +
    `${theme.bold("S")}${theme.fg("muted", " simplify · ")}` +
    `${theme.bold("R")}${theme.fg("muted", " review · ")}` +
    `${theme.bold("C")}${theme.fg("muted", " correction · ☑ checkpoint · ")}` +
    `${theme.fg("error", "●")}${theme.fg("muted", " stallo")}`;
  lines.push(row(legend));

  for (const ph of data.phases ?? []) {
    // Phase header
    const arrow = ph.status === "active" ? theme.fg("accent", "▾") : theme.fg("muted", "▾");
    const dot =
      ph.status === "active"
        ? `${theme.fg("accent", "●")} ${theme.fg("muted", theme.italic("attiva"))}`
        : `${theme.fg("muted", "○")} ${theme.fg("muted", theme.italic("in coda"))}`;
    const phLabel = `${arrow} ${theme.bold(ph.name)} ${dot}`;

    const hdr = `${theme.fg("muted", theme.bold("B S R C  ☑"))}`;
    if (ph.status === "active") {
      const leftPart = pad(phLabel, 2 + 2 + idW + 2) + hdr;
      const rightPart = " ".repeat(2 + idW + 2) + hdr;
      lines.push(row(`${pad(leftPart, 2 + cellWidth)} ${sep} ${rightPart}`));
    } else {
      lines.push(row(phLabel));
    }

    // Phase tasks
    for (let i = 0; i < ph.tasks.length; i += 2) {
      lines.push(formatPair(ph.tasks[i], ph.tasks[i + 1]));
    }
  }

  // 5. Extension: Detail row for selected worker
  if (data.selectedDetail && (data.selectedDetail.branch || data.selectedDetail.status)) {
    const branch = data.selectedDetail.branch ? `${theme.fg("accent", "⎇")} ${data.selectedDetail.branch}` : "";
    const status = data.selectedDetail.status ? `· ${data.selectedDetail.status}` : "";
    const detailLeft = `  ${branch} ${status}`.trimEnd();
    const hint = data.showHint ? theme.fg("muted", "/subagent · Ctrl+Alt+X") : "";
    const fill = width - 4 - visibleWidth(detailLeft) - visibleWidth(hint);
    if (fill >= 2) {
      lines.push(row(`${detailLeft}${" ".repeat(fill)}${hint}`));
    } else {
      lines.push(row(detailLeft));
    }
  }

  return lines;
}


function formatStallDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m`;
}

/**
 * Build pure ConvoyPanelData from running subagents for aboveEditor rendering in convoy mode.
 */
export function buildConvoyPanelDataFromAgents(
  agents: any[],
  selectedSlotId?: string,
  now = Date.now(),
): ConvoyPanelData {
  const slotGroups = new Map<string, any[]>();
  for (const agent of agents) {
    const key = agent.slot?.id ?? agent.id;
    const group = slotGroups.get(key) ?? [];
    group.push(agent);
    slotGroups.set(key, group);
  }

  const tasks: ConvoyTaskItem[] = [];
  let doneCount = 0;
  let selectedDetail: ConvoySelectedDetail | undefined;

  const firstSlotKey = slotGroups.keys().next().value;
  const effectiveSelectedKey = selectedSlotId ?? firstSlotKey;

  for (const [key, members] of slotGroups) {
    const sorted = [...members].sort((a, b) => a.startTime - b.startTime);
    const active = sorted[sorted.length - 1];
    const first = sorted[0];
    const turn = active.lifecycle?.turn;
    const isCompleted = active.lifecycle?.process?.kind === "completed";

    let dot: ConvoyTaskDot = "muted";
    let stall: string | undefined;

    if (isCompleted) {
      dot = "success";
      doneCount++;
    } else if (turn?.kind === "blocked") {
      dot = "warning";
      const since = turn.stateDurationSince ?? active.startTime;
      stall = `?${formatStallDuration(now - since)}`;
    } else if (turn?.kind === "stalled") {
      dot = "error";
      const since = turn.stateDurationSince ?? active.startTime;
      stall = `⚠${formatStallDuration(now - since)}`;
    } else if (turn?.kind === "active" || active.lifecycle?.process?.kind === "running") {
      dot = "accent";
    }

    // Infer stages from chain / agent role
    const chainStr = (first.slot?.chain ?? [first.name]).join(" ").toLowerCase();
    const isReview = chainStr.includes("review");
    const isSimplify = chainStr.includes("simplif");

    const stages: ConvoyStageState = isCompleted
      ? { build: "completed", simplify: "completed", review: "completed", checkpoint: true }
      : isReview
      ? { build: "completed", simplify: "completed", review: "active", checkpoint: false }
      : isSimplify
      ? { build: "completed", simplify: "active", review: "pending", checkpoint: false }
      : { build: "active", simplify: "pending", review: "pending", checkpoint: false };

    const isSelected = key === effectiveSelectedKey;
    if (isSelected) {
      const branch = first.slot?.worktree?.branch ?? first.worktree?.branch;
      selectedDetail = {
        branch,
        status: `active · ${active.agent ?? "worker"}`,
      };
    }

    tasks.push({
      id: key,
      name: first.slot?.name ?? first.name,
      dot,
      stages,
      stall,
      selected: isSelected,
    });
  }

  return {
    title: "subagents",
    phase: tasks.some((t) => t.dot === "accent" || t.dot === "warning") ? "execution" : "idle",
    done: doneCount,
    total: Math.max(1, tasks.length),
    phases: [
      {
        name: "workers",
        status: "active",
        tasks,
      },
    ],
    selectedDetail,
    showHint: true,
  };
}
