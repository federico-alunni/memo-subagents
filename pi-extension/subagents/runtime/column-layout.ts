// Geometry of a column of agent panes (a root agent and the agents it starts, stacked under it).
// New members split the bottom-most member in half; a rebalance then brings the column to its targets:
// the root keeps its share (half), the other members split the rest equally. Herdr semantics (0.9.3):
//   `pane split X --direction down --ratio r`  X keeps r of its height, the new pane gets the rest;
//   `pane resize --pane X --direction down --amount a`  +a on the ratio of the split with X on top;
//   `pane resize --pane Y --direction up --amount a`    -a on the ratio of the split with Y below.
// A column is a chain of vertical splits (member i on top, members i+1.. below), because every new member
// splits the bottom-most one and a closed member's split collapses into its neighbour.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface LayoutPane {
  pane_id: string;
  rect: Rect;
}
export interface LayoutSplit {
  id?: string;
  direction: string;
  ratio: number;
  rect: Rect;
}
export interface PaneLayoutSnapshot {
  panes: LayoutPane[];
  splits: LayoutSplit[];
}
export interface ResizeOp {
  pane: string;
  direction: "down" | "up";
  amount: number;
}

export const COLUMN_ROOT_SHARE = 0.5;
const TOLERANCE = 0.02;

/** Target ratio of the split below member i (i = 0..n-2). */
export function columnSplitTargets(count: number, hasRoot: boolean, rootShare = COLUMN_ROOT_SHARE): number[] {
  const targets: number[] = [];
  for (let i = 0; i < count - 1; i++) {
    if (hasRoot && i === 0) targets.push(rootShare);
    else targets.push(1 / (count - i)); // member i and the (count - i - 1) below it share the rest equally
  }
  return targets;
}

/** Members present in the layout, top to bottom, restricted to the first member's column (same x and width). */
export function orderColumn(members: string[], layout: PaneLayoutSnapshot): string[] {
  const wanted = new Set(members);
  const panes = layout.panes.filter((p) => wanted.has(p.pane_id));
  if (panes.length === 0) return [];
  const top = [...panes].sort((a, b) => a.rect.y - b.rect.y)[0];
  return panes
    .filter((p) => p.rect.x === top.rect.x && p.rect.width === top.rect.width)
    .sort((a, b) => a.rect.y - b.rect.y)
    .map((p) => p.pane_id);
}

/** Where the next member goes: under the bottom-most member, which keeps half of its height. */
export function nextColumnSplit(ordered: string[]): { target: string; ratio: number } | undefined {
  const bottom = ordered.at(-1);
  return bottom ? { target: bottom, ratio: 0.5 } : undefined;
}

/**
 * Resizes that bring the column to its targets. Only splits whose rect is exactly "member i and everything
 * below it" are touched; anything else (foreign panes, a split done by the user) is left alone.
 */
export function planColumnResize(
  ordered: string[],
  layout: PaneLayoutSnapshot,
  hasRoot: boolean,
  rootShare = COLUMN_ROOT_SHARE,
  tolerance = TOLERANCE,
): ResizeOp[] {
  if (ordered.length < 2) return [];
  const rect = new Map(layout.panes.map((p) => [p.pane_id, p.rect]));
  const rects = ordered.map((id) => rect.get(id));
  if (rects.some((r) => !r)) return [];
  const bottom = rects.at(-1)!.y + rects.at(-1)!.height;
  const targets = columnSplitTargets(ordered.length, hasRoot, rootShare);
  const ops: ResizeOp[] = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const top = rects[i]!;
    const chain = layout.splits.find(
      (s) =>
        s.direction === "down" &&
        s.rect.x === top.x &&
        s.rect.width === top.width &&
        s.rect.y === top.y &&
        s.rect.y + s.rect.height === bottom,
    );
    if (!chain) continue;
    const delta = targets[i] - chain.ratio;
    if (Math.abs(delta) <= tolerance) continue;
    ops.push(
      delta > 0
        ? { pane: ordered[i], direction: "down", amount: round(delta) }
        : { pane: ordered[i + 1], direction: "up", amount: round(-delta) },
    );
  }
  return ops;
}

const round = (value: number) => Math.round(value * 10000) / 10000;

type HerdrRun = (args: string[]) => unknown | Promise<unknown>;

/**
 * Reads the layout and applies the resizes. `root` keeps its share only while it is the top member (an ended
 * root leaves the column to equal members). Cosmetic: never throws.
 */
export async function applyColumnLayout(
  members: string[],
  root: string | undefined,
  run: HerdrRun,
  rootShare = COLUMN_ROOT_SHARE,
): Promise<void> {
  if (members.length === 0) return;
  try {
    const result = (await run(["pane", "layout", "--pane", members[0]])) as { layout?: PaneLayoutSnapshot };
    const layout = result?.layout;
    if (!layout) return;
    const ordered = orderColumn(members, layout);
    const hasRoot = root !== undefined && ordered[0] === root;
    for (const op of planColumnResize(ordered, layout, hasRoot, rootShare))
      await run(["pane", "resize", "--pane", op.pane, "--direction", op.direction, "--amount", String(op.amount)]);
  } catch {
    // A layout that cannot be read or resized stays as Herdr left it.
  }
}
