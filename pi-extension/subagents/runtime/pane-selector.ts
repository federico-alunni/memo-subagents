import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentHandle } from "./protocol.ts";

export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PaneRecord {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
}
/** A pane of `herdr pane layout` (Herdr reports its rectangle; older answers and tests may not). */
export interface LayoutPane {
  pane_id: string;
  rect?: PaneRect;
}
export interface PaneLayout {
  zoomed?: boolean;
  panes: LayoutPane[];
}

export type PaneMoveTarget =
  | { newTab: { label: string } }
  | { split: { targetPane: string; tab: string; direction: "right" | "down"; ratio: number } };
/** Moves an owned pane; resolves only when the move is observed (the runtime's `move`). */
export type PaneMover = (paneId: string, to: PaneMoveTarget) => Promise<void>;

/**
 * How a live runtime agent's pane is moved: through a runtime that owns it, with its latest handle.
 * Every AgentRuntime of the process (the `subagent` tool, Issue Round, ...) registers its agents.
 */
export interface PaneControl {
  handle: AgentHandle;
  move(h: AgentHandle, to: PaneMoveTarget): Promise<AgentHandle>;
}

/** Agents shown at once in the column right of the main pane (top and bottom slot). */
export const COLUMN_SLOTS = 2;
/** Default width of the agent column, as a fraction of the tab (the main pane keeps the rest). */
export const DEFAULT_COLUMN_RATIO = 0.4;

/**
 * Width of the agent column as a fraction of the tab: `PI_SUBAGENT_COLUMN_RATIO`, a plain decimal number
 * strictly between 0 and 1 (e.g. `0.3`); missing or invalid → 0.4.
 */
export function columnRatio(value: string | undefined = process.env.PI_SUBAGENT_COLUMN_RATIO): number {
  const text = value?.trim() ?? "";
  if (!/^\d*\.?\d+$/.test(text)) return DEFAULT_COLUMN_RATIO;
  const ratio = Number(text);
  return Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? ratio : DEFAULT_COLUMN_RATIO;
}

/**
 * Herdr's `--ratio` of a right split measures the pane being split (the main pane, on the left): the
 * column gets the rest.
 */
export function columnSplitRatio(ratio: number = columnRatio()): number {
  return Number((1 - ratio).toFixed(4));
}

/** The column right of the main pane: its top slot (or the whole column when it is empty). */
export function columnTarget(parent: PaneRecord, ratio: number = columnRatio()): PaneMoveTarget {
  return { split: { targetPane: parent.pane_id, tab: parent.tab_id, direction: "right", ratio: columnSplitRatio(ratio) } };
}

/** The bottom slot: the lower half of the column, below the agent in the top slot. */
export function belowTarget(parent: PaneRecord, top: string): PaneMoveTarget {
  return { split: { targetPane: top, tab: parent.tab_id, direction: "down", ratio: 0.5 } };
}

export interface SelectorState {
  /** Panes this process may show beside the main pane, with their label. */
  owned: Map<string, string>;
  /** Runtime agents' panes: moved through their runtime (absent: moved directly with Herdr). */
  controls?: Map<string, PaneControl>;
  /** Agents shown in the column right of the main pane: index 0 top, 1 bottom (a hole while a launch places). */
  slots?: (string | undefined)[];
  /**
   * Per-slot reservations (index 0 top, 1 bottom): the token of a launch placing an agent there, or of a
   * selector rearrangement (it holds both). Taken with a synchronous check-and-set.
   */
  reservedSlots?: (string | undefined)[];
  /** Panes created by a launch that holds a slot and has not adopted them yet (token → pane). */
  placed?: Map<string, string>;
  /** Bumped whenever the selector moves panes in the column: layouts read before it are stale. */
  layoutEpoch?: number;
  /** Shown agents that were forgotten (finished): their slot is filled once their pane has closed. */
  vacated?: VacatedSlot[];
  /** Menu order of the selectable panes (Ctrl+Alt+X / `/subagent`), registered by the extension. */
  menuOrder?: () => string[];
  /** Called (by `forgetPane`) when a shown agent was forgotten; set by the selector doing promotions. */
  onVacated?: () => void;
  /** Called after a promotion moved `paneId` into the column (widget refresh, handle sync). */
  onPromoted?: (paneId: string) => void;
}

export interface VacatedSlot {
  paneId: string;
  /** Menu order when the agent was forgotten (it included the finished agent, if still listed). */
  order: string[];
  /** Its position in the column (0 top, 1 bottom): the promoted agent takes it. */
  slot?: number;
}
/** @deprecated Former name of `VacatedSlot`. */
export type VacatedSplit = VacatedSlot;
type Run = (args: string[]) => any;

/**
 * - `auto`: a free slot of the agent column (the main tab holds only the main pane and at most one of our
 *   agents, is not zoomed and no other launch or rearrangement reserved that slot; agents open in background
 *   tabs do not matter), else a tab.
 * - `visible`: like `auto`; with both slots taken by our agents, the top one is parked in a tab, the bottom
 *   one moves up and the new agent takes the bottom slot. A tab when the main tab has other splits, is
 *   zoomed or the slots are reserved.
 */
export type PlacementMode = "auto" | "visible";

export interface PlacementReservation {
  token: string;
  placement: "split-right" | "split-down" | "tab";
  /** Column slot reserved: 0 top (split right of the main pane), 1 bottom (split down below the top agent). */
  slot?: number;
  /** Pane to split: the main pane for the top slot, the top agent for the bottom one. */
  targetPane?: string;
  /** Bottom slot reserved before the top slot's launch created its pane: split that pane once created. */
  after?: string;
  /** Herdr `--ratio` of the split. */
  ratio?: number;
  /** `visible` only: our agent in the top slot, to park in a tab before the new split is created. */
  park?: string;
}

const STATE_KEY = Symbol.for("pi-subagents/pane-selector-v1");

/** Brings a state created by an older version (single `selected` agent, one `reservedSplit`) up to date. */
function normalize(state: SelectorState): SelectorState {
  const legacy = state as SelectorState & { selected?: string; reservedSplit?: string; vacated?: unknown };
  state.controls ??= new Map();
  if (!state.slots) state.slots = legacy.selected ? [legacy.selected] : [];
  if (!state.reservedSlots) state.reservedSlots = legacy.reservedSplit ? [legacy.reservedSplit] : [];
  if (legacy.vacated && !Array.isArray(legacy.vacated)) state.vacated = [legacy.vacated as VacatedSlot];
  delete legacy.selected;
  delete legacy.reservedSplit;
  return state;
}

/** The process-wide selector state, shared by every runtime client and preserved across /reload. */
export function selectorState(): SelectorState {
  const globals = globalThis as any;
  return normalize((globals[STATE_KEY] ??= { owned: new Map() }));
}

/** Agents shown in the column, top first. */
export function shownSlots(state: SelectorState): string[] {
  return (state.slots ?? []).filter((id): id is string => !!id);
}

/** Whether `paneId` is shown in the agent column (widget ▶, menu marker). */
export function isShown(state: SelectorState, paneId: string | undefined): boolean {
  return !!paneId && shownSlots(state).includes(paneId);
}

function reservedAny(state: SelectorState): boolean {
  return (state.reservedSlots ?? []).some(Boolean);
}

/** Owned panes in the caller's workspace (agents in other workspaces, e.g. worktree spaces, never count). */
function ownedIn(state: SelectorState, workspaceId: string): string[] {
  return [...state.owned.keys()].filter(
    (id) => (state.controls?.get(id)?.handle.workspaceId ?? workspaceId) === workspaceId,
  );
}

/** Panes of the main tab other than the main pane, top to bottom (then left to right) when Herdr reports rectangles. */
function siblingsOf(layout: PaneLayout, parent: PaneRecord): LayoutPane[] {
  const siblings = layout.panes.filter((pane) => pane.pane_id !== parent.pane_id);
  if (!siblings.every((pane) => pane.rect)) return siblings;
  return [...siblings].sort((a, b) => a.rect!.y - b.rect!.y || a.rect!.x - b.rect!.x);
}

const OTHER_SPLITS =
  "The main tab contains other splits; leave only the main pane and up to two of its agents before selecting";

/**
 * The agents in the column right of the main pane (top first), or why the selector must not touch the tab:
 * zoom, a pane that is not ours, more than two agents, or agents not stacked in one column on the right.
 */
export function readColumn(
  layout: PaneLayout,
  parent: PaneRecord,
  ours: (paneId: string) => boolean,
): { shown: string[] } | { refusal: string } {
  if (layout.zoomed) return { refusal: "Unzoom the main pane before selecting an agent" };
  const siblings = siblingsOf(layout, parent);
  if (siblings.length > COLUMN_SLOTS || siblings.some((pane) => !ours(pane.pane_id))) return { refusal: OTHER_SPLITS };
  const main = layout.panes.find((pane) => pane.pane_id === parent.pane_id)?.rect;
  if (main && siblings.every((pane) => pane.rect)) {
    const rects = siblings.map((pane) => pane.rect!);
    const right = rects.every((rect) => rect.x >= main.x + main.width);
    const stacked = rects.every((rect) => rect.x === rects[0].x && rect.width === rects[0].width);
    if (!right || !stacked) return { refusal: OTHER_SPLITS };
  }
  return { shown: siblings.map((pane) => pane.pane_id) };
}

/**
 * Synchronous check-and-set on a layout read beforehand: concurrent launches never take the same slot, so
 * they never create more than two agent panes beside the main pane. `adoptPane` or `releasePlacement` must
 * follow; `notePlacedPane` once the pane exists.
 */
export function reservePlacement(
  state: SelectorState,
  parent: PaneRecord,
  layout: PaneLayout | undefined,
  mode: PlacementMode,
  /** `layoutEpoch` when `layout` was read (asynchronously): a pane moved by the selector since makes it stale. */
  seenEpoch?: number,
): PlacementReservation {
  normalize(state);
  const token = randomUUID();
  const tab: PlacementReservation = { token, placement: "tab" };
  if (!layout) return tab;
  if (seenEpoch !== undefined && (state.layoutEpoch ?? 0) !== seenEpoch) return tab;
  const placing = new Map([...(state.placed ?? new Map<string, string>())].map(([t, pane]) => [pane, t] as const));
  const column = readColumn(layout, parent, (id) => state.owned.has(id) || placing.has(id));
  if ("refusal" in column) return tab;
  const shown = column.shown;
  const reserved = state.reservedSlots!;
  const take = (slot: number, rest: Omit<PlacementReservation, "token" | "slot">): PlacementReservation => {
    reserved[slot] = token;
    return { token, slot, ...rest };
  };
  if (shown.length === COLUMN_SLOTS) {
    // "visible": the queue rule. The top agent goes to a tab, the bottom one moves up, the new one goes below it.
    if (mode !== "visible" || reservedAny(state) || shown.some((id) => placing.has(id))) return tab;
    return take(1, { placement: "split-down", targetPane: shown[1], ratio: 0.5, park: shown[0] });
  }
  if (shown.length === 1) {
    // The top agent is shown (or being placed by the launch that reserved the top slot): the bottom slot.
    if (reserved[1] || (reserved[0] && placing.get(shown[0]) !== reserved[0])) return tab;
    return take(1, { placement: "split-down", targetPane: shown[0], ratio: 0.5 });
  }
  if (!reserved[0]) {
    if (reserved[1]) return tab;
    return take(0, { placement: "split-right", targetPane: parent.pane_id, ratio: columnSplitRatio() });
  }
  if (reserved[1]) return tab;
  // The top slot's launch has not created its pane yet: the bottom slot, split from that pane once it exists.
  const pending = state.placed?.get(reserved[0]);
  return take(1, {
    placement: "split-down",
    ratio: 0.5,
    ...(pending ? { targetPane: pending } : { after: reserved[0] }),
  });
}

/** The launch created its pane in the reserved slot (not adopted yet): it counts as ours in the column. */
export function notePlacedPane(state: SelectorState, reservation: PlacementReservation | undefined, paneId: string): void {
  if (!reservation || reservation.placement === "tab" || reservation.slot === undefined) return;
  if (state.reservedSlots?.[reservation.slot] !== reservation.token) return;
  (state.placed ??= new Map()).set(reservation.token, paneId);
}

/**
 * Pane created by the launch holding `token` (a top slot): resolves with it once created, or undefined when
 * that launch no longer holds the slot without having created one (adopted meanwhile, failed) or on timeout.
 */
export async function placedPane(
  state: SelectorState,
  token: string,
  options: { pollMs?: number; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  for (;;) {
    const pane = state.placed?.get(token);
    if (pane) return pane;
    if (!state.reservedSlots?.includes(token) || Date.now() >= deadline) return undefined;
    // Not unref'd: a launch waiting for its slot is live work (bounded by the deadline), and an unref'd
    // timer alone lets the event loop end with the launch still pending.
    await new Promise<void>((resolve) => setTimeout(resolve, options.pollMs ?? 25));
  }
}

function releaseToken(state: SelectorState, token: string): void {
  const reserved = state.reservedSlots ?? [];
  for (let slot = 0; slot < reserved.length; slot++) if (reserved[slot] === token) reserved[slot] = undefined;
  state.placed?.delete(token);
}

/** The launch created its pane: track it, and show it in its slot when it took a reserved one. */
export function adoptPane(
  state: SelectorState,
  reservation: PlacementReservation | undefined,
  paneId: string,
  label: string,
  control?: PaneControl,
): void {
  normalize(state);
  state.owned.set(paneId, label);
  if (control) state.controls!.set(paneId, control);
  if (!reservation || reservation.slot === undefined) return;
  if (state.reservedSlots?.[reservation.slot] !== reservation.token) return;
  releaseToken(state, reservation.token);
  if (reservation.placement === "tab") return;
  const slots = state.slots!;
  if (slots[reservation.slot] && slots[reservation.slot] !== paneId) {
    // The column changed since the reservation (e.g. the top agent was parked by a visible launch).
    state.slots = [...shownSlots(state).filter((id) => id !== paneId), paneId].slice(-COLUMN_SLOTS);
  } else slots[reservation.slot] = paneId;
}

/** The launch failed before creating a pane it could report. */
export function releasePlacement(state: SelectorState, reservation: PlacementReservation | undefined): void {
  if (reservation) releaseToken(normalize(state), reservation.token);
}

/**
 * The agent finished (or is no longer ours). When it was shown in the column, remember its menu position
 * and slot: the selector fills the slot with the next open agent once the pane has actually closed.
 */
export function forgetPane(state: SelectorState, paneId: string): void {
  normalize(state);
  const shown = shownSlots(state);
  const slot = shown.indexOf(paneId);
  let order: string[] = [];
  if (slot !== -1) {
    try {
      order = state.menuOrder?.() ?? [...state.owned.keys()];
    } catch {
      order = [...state.owned.keys()];
    }
  }
  state.owned.delete(paneId);
  state.controls?.delete(paneId);
  if (slot === -1) return;
  // Herdr gives the closed pane's space to the other agent: it becomes the top (or only) one.
  state.slots = shown.filter((id) => id !== paneId);
  (state.vacated ??= []).push({ paneId, order, slot });
  try {
    state.onVacated?.();
  } catch { /* Promotion is best effort; forgetting never fails. */ }
}

/** Candidates after `vacated` in its menu order (wrapping around); the menu order itself when unknown. */
export function promotionOrder(vacated: VacatedSlot): string[] {
  return after(vacated.order, vacated.paneId).filter((id) => id !== vacated.paneId);
}

/** `order` rotated to start right after `anchor` (wrapping around); unchanged when `anchor` is not listed. */
function after(order: string[], anchor: string): string[] {
  const index = order.indexOf(anchor);
  return index === -1 ? order : [...order.slice(index + 1), ...order.slice(0, index + 1)];
}

/** Moves a pane through its runtime control (which keeps the observed handle), else with `fallback`. */
export async function movePane(
  state: SelectorState,
  paneId: string,
  to: PaneMoveTarget,
  fallback: PaneMover,
): Promise<void> {
  const control = state.controls?.get(paneId);
  if (!control) return fallback(paneId, to);
  control.handle = await control.move(control.handle, to);
}

/** One move of a rearrangement and the column expected once it is done. */
export interface ColumnStep {
  paneId: string;
  to: PaneMoveTarget;
  expect: string[];
}

/**
 * Moves turning the column `from` into `desired` (both top first, at most two agents): park the agents that
 * leave, park the top one to swap or to put another agent above it, then fill the column top to bottom.
 * Herdr only splits right or down, so an agent can only enter the empty column or below the top agent.
 */
export function planColumn(
  parent: PaneRecord,
  from: string[],
  desired: string[],
  label: (paneId: string) => string,
): ColumnStep[] {
  const steps: ColumnStep[] = [];
  let column = [...from];
  const park = (paneId: string) => {
    column = column.filter((id) => id !== paneId);
    steps.push({ paneId, to: { newTab: { label: label(paneId) } }, expect: [...column] });
  };
  for (const id of from) if (!desired.includes(id)) park(id);
  if (column.length === 2 && column[0] !== desired[0]) park(column[0]);
  if (column.length === 1 && column[0] !== desired[0]) park(column[0]);
  while (column.length < desired.length) {
    const paneId = desired[column.length];
    const to = column.length === 0 ? columnTarget(parent) : belowTarget(parent, column[0]);
    column = [...column, paneId];
    steps.push({ paneId, to, expect: [...column] });
  }
  return steps;
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** What Ctrl+Alt+X did: `only`/`none` change nothing. */
export type CycleResult = "only" | "none" | "filled" | "swapped" | "rotated";

/**
 * Decides where agent panes go and which ones are shown in the column right of the main pane (two slots,
 * top and bottom). Panes are created and moved by the agent runtime; this class reads the layout, reserves
 * the slots and moves owned panes within the caller's workspace (pane IDs stay stable), each through the
 * runtime that owns it.
 */
export interface PromotionOptions {
  /** Interval between checks that the finished agent's pane has closed. */
  pollMs?: number;
  /** Give up waiting for the pane to close after this long (the column stays as it is). */
  timeoutMs?: number;
}

export class PaneSelector {
  readonly state: SelectorState;
  private readonly run: Run;
  private readonly parentId: () => string;
  private readonly promotionOptions: Required<PromotionOptions>;
  private promoting?: Promise<void>;

  constructor(state: SelectorState, run: Run, parentId: () => string, options: PromotionOptions = {}) {
    this.state = normalize(state);
    this.run = run;
    this.parentId = parentId;
    this.promotionOptions = { pollMs: options.pollMs ?? 250, timeoutMs: options.timeoutMs ?? 120_000 };
    // The latest selector of the state (e.g. after /reload) promotes when a shown agent finishes.
    this.state.onVacated = () => { void this.promoteVacated(); };
  }

  parent(): PaneRecord {
    return this.run(["pane", "get", this.parentId()]).pane;
  }

  private layout(parent: PaneRecord): PaneLayout {
    return this.run(["pane", "layout", "--pane", parent.pane_id]).layout;
  }

  /** Our agents in the main tab, top first. */
  visible(): string[] {
    const parent = this.parent();
    return siblingsOf(this.layout(parent), parent)
      .map((pane) => pane.pane_id)
      .filter((id) => this.state.owned.has(id));
  }

  /** The column on the current layout; throws the selector's refusal (zoom, unrelated splits). */
  private column(parent: PaneRecord): string[] {
    const column = readColumn(this.layout(parent), parent, (id) => this.state.owned.has(id));
    if ("refusal" in column) throw new Error(column.refusal);
    return column.shown;
  }

  /** `auto` placement decision on the current layout (unknown layout: never split). */
  reserve(): PlacementReservation {
    try {
      const parent = this.parent();
      return reservePlacement(this.state, parent, this.layout(parent), "auto");
    } catch {
      return { token: randomUUID(), placement: "tab" };
    }
  }

  placed(reservation: PlacementReservation, paneId: string): void {
    notePlacedPane(this.state, reservation, paneId);
  }

  adopt(reservation: PlacementReservation, paneId: string, name: string): void {
    adoptPane(this.state, reservation, paneId, name);
  }

  release(reservation: PlacementReservation): void {
    releasePlacement(this.state, reservation);
  }

  /** Owned panes that can be shown here (same workspace as the main pane). */
  selectable(): string[] {
    return ownedIn(this.state, this.parent().workspace_id);
  }

  private mover(move?: PaneMover): PaneMover {
    return move ?? ((id, to) => movePane(this.state, id, to, this.herdrMover()));
  }

  /** An owned agent of the main pane's workspace that can enter the column. */
  private eligible(paneId: string, parent: PaneRecord): boolean {
    if (!this.state.owned.has(paneId) || !ownedIn(this.state, parent.workspace_id).includes(paneId)) return false;
    try {
      return this.run(["pane", "get", paneId]).pane.workspace_id === parent.workspace_id;
    } catch {
      return false;
    }
  }

  /**
   * Shows `paneId` (`/subagent` menu, `visible` rule): nothing when already shown; a free slot takes it;
   * with both slots taken the top agent is parked in a tab, the bottom one moves up and `paneId` takes the
   * bottom slot. `move` overrides every move (tests); otherwise each pane moves through its runtime control.
   */
  async select(paneId: string, move?: PaneMover): Promise<void> {
    if (!this.state.owned.has(paneId)) throw new Error("Only this session's agent panes can be selected");
    const parent = this.parent();
    const target: PaneRecord = this.run(["pane", "get", paneId]).pane;
    if (target.workspace_id !== parent.workspace_id) throw new Error("Agent runs in another workspace; refusing to change its ID");
    const shown = this.column(parent);
    if (shown.includes(paneId)) {
      this.state.slots = shown;
      return;
    }
    const desired = shown.length < COLUMN_SLOTS ? [...shown, paneId] : [shown[1], paneId];
    await this.rearrange(parent, shown, desired, this.mover(move));
  }

  /**
   * Ctrl+Alt+X over `order` (the menu order): a free slot takes the next open agent; with both slots taken,
   * two open agents swap top and bottom, more rotate as a queue (the top one goes to a tab, the bottom one
   * moves up, the next agent in menu order after it, among those in tabs, takes the bottom slot).
   */
  async cycle(order: string[], move?: PaneMover): Promise<CycleResult> {
    const parent = this.parent();
    const shown = this.column(parent);
    const next = (anchor: string | undefined, exclude: string[]) =>
      (anchor === undefined ? order : after(order, anchor)).find(
        (id) => !exclude.includes(id) && this.eligible(id, parent),
      );
    let desired: string[];
    let result: CycleResult;
    if (shown.length === 0) {
      const first = next(undefined, []);
      if (!first) return "none";
      const second = next(first, [first]);
      desired = second ? [first, second] : [first];
      result = "filled";
    } else if (shown.length === 1) {
      const second = next(shown[0], shown);
      if (!second) return "only";
      desired = [shown[0], second];
      result = "filled";
    } else {
      const incoming = next(shown[1], shown);
      desired = incoming ? [shown[1], incoming] : [shown[1], shown[0]];
      result = incoming ? "rotated" : "swapped";
    }
    await this.rearrange(parent, shown, desired, this.mover(move));
    return result;
  }

  /**
   * Moves the column from `shown` to `desired` holding both slots (launches arriving meanwhile get a tab).
   * Each step is read back; a failure rolls the column back to `shown`, leaving every terminal alive.
   */
  private async rearrange(parent: PaneRecord, shown: string[], desired: string[], mover: PaneMover): Promise<void> {
    if (reservedAny(this.state)) throw new Error("An agent is being placed beside the main pane; try again in a moment");
    const token = randomUUID();
    this.state.reservedSlots = [token, token];
    this.state.layoutEpoch = (this.state.layoutEpoch ?? 0) + 1;
    try {
      const label = (id: string) => this.state.owned.get(id) ?? "agent";
      try {
        for (const step of planColumn(parent, shown, desired, label)) await this.step(parent, step, mover);
      } catch (error) {
        await this.rollback(parent, shown, mover);
        throw error;
      }
      this.state.slots = desired.filter((id) => this.state.owned.has(id));
    } finally {
      releaseToken(this.state, token);
    }
  }

  /** Runs one move and reads the layout back: a failed answer does not prove the move failed, nor the reverse. */
  private async step(parent: PaneRecord, step: ColumnStep, mover: PaneMover): Promise<void> {
    let failure: unknown;
    try {
      await mover(step.paneId, step.to);
    } catch (error) {
      failure = error;
    }
    const now = siblingsOf(this.layout(parent), parent).map((pane) => pane.pane_id);
    if (!same(now, step.expect)) throw failure ?? new Error("Unable to move the agent pane safely");
  }

  /** Best effort: back to the original column with the agents still open; never closes anything. */
  private async rollback(parent: PaneRecord, original: string[], mover: PaneMover): Promise<void> {
    try {
      const now = siblingsOf(this.layout(parent), parent).map((pane) => pane.pane_id);
      if (now.some((id) => !this.state.owned.has(id))) return;
      const target = original.filter((id) => {
        if (!this.state.owned.has(id)) return false;
        try {
          this.run(["pane", "get", id]);
          return true;
        } catch {
          return false;
        }
      });
      const label = (id: string) => this.state.owned.get(id) ?? "agent";
      for (const step of planColumn(parent, now, target, label)) await this.step(parent, step, mover);
    } catch { /* Keep every terminal alive; the selector can be used again. */ } finally {
      try {
        this.state.slots = this.visible();
      } catch { /* Layout unknown: keep the last known slots. */ }
    }
  }

  /** Direct Herdr moves, for panes that are not runtime agents (and tests). */
  herdrMover(): PaneMover {
    return async (paneId, to) => {
      const args = "newTab" in to
        ? ["pane", "move", paneId, "--new-tab", "--label", to.newTab.label, "--no-focus"]
        : ["pane", "move", paneId, "--tab", to.split.tab, "--target-pane", to.split.targetPane, "--split", to.split.direction, "--ratio", String(to.split.ratio), "--no-focus"];
      const moved = this.run(args).move_result;
      if (!moved?.changed || moved.pane?.pane_id !== paneId) throw new Error("Unable to move the agent pane safely");
    };
  }

  forget(paneId: string): void {
    forgetPane(this.state, paneId);
  }

  /**
   * Fills the slots of shown agents that finished (`state.vacated`). Resolves when no promotion is pending;
   * never rejects (a failed promotion leaves every terminal where it is).
   */
  promoteVacated(): Promise<void> {
    this.promoting ??= this.runPromotions().finally(() => { this.promoting = undefined; });
    return this.promoting;
  }

  private async runPromotions(): Promise<void> {
    // Never inside the caller's forget: it may be about to close the pane.
    await new Promise<void>((resolve) => setImmediate(resolve));
    while (this.state.vacated?.length) {
      const vacated = this.state.vacated[0];
      const closed = await this.closed(vacated.paneId);
      this.state.vacated = (this.state.vacated ?? []).filter((entry) => entry !== vacated);
      if (!closed) continue;
      try {
        await this.promote(vacated);
      } catch { /* Best effort: the selector stays usable. */ }
    }
  }

  /** Waits until the pane is gone (bounded); false when it stays open. */
  private async closed(paneId: string): Promise<boolean> {
    const deadline = Date.now() + this.promotionOptions.timeoutMs;
    for (;;) {
      if (this.state.owned.has(paneId)) return false; // Ours again: not finished.
      try {
        this.run(["pane", "get", paneId]);
      } catch {
        return true;
      }
      if (Date.now() >= deadline) return false;
      // Not unref'd (bounded by the deadline): see placedPane.
      await new Promise<void>((resolve) => setTimeout(resolve, this.promotionOptions.pollMs));
    }
  }

  /**
   * Fills the finished agent's slot in place with the next open agent in menu order (from a background
   * tab), with the refusals of `select` and the launches' slot reservations. Without a candidate the
   * remaining agent keeps the whole column. Returns the promoted pane, if any.
   */
  async promote(vacated: VacatedSlot, move?: PaneMover): Promise<string | undefined> {
    const parent = this.parent();
    if (reservedAny(this.state)) return undefined;
    const column = readColumn(this.layout(parent), parent, (id) => this.state.owned.has(id));
    if ("refusal" in column) return undefined;
    const shown = column.shown;
    if (shown.length >= COLUMN_SLOTS) return undefined;
    const candidate = promotionOrder(vacated).find((id) => !shown.includes(id) && this.eligible(id, parent));
    if (!candidate) {
      this.state.slots = shown;
      return undefined;
    }
    if (reservedAny(this.state)) return undefined;
    const desired = [...shown];
    desired.splice(Math.min(vacated.slot ?? shown.length, shown.length), 0, candidate);
    try {
      await this.rearrange(parent, shown, desired, this.mover(move));
    } catch {
      return undefined;
    }
    if (!this.state.owned.has(candidate)) return candidate; // Finished during the move.
    try {
      this.state.onPromoted?.(candidate);
    } catch { /* Display only. */ }
    return candidate;
  }
}

export const paneSelector = new PaneSelector(selectorState(), (args) => {
  const output = execFileSync("herdr", args, { encoding: "utf8" });
  const response = JSON.parse(output);
  if (response.error) throw new Error(response.error.message ?? "Herdr request failed");
  return response.result;
}, () => {
  if (!process.env.HERDR_PANE_ID) throw new Error("HERDR_PANE_ID is not set");
  return process.env.HERDR_PANE_ID;
});
