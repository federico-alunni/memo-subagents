import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentHandle } from "./protocol.ts";

export interface PaneRecord {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
}
export interface PaneLayout {
  zoomed?: boolean;
  panes: PaneRecord[];
}

export type PaneMoveTarget =
  | { newTab: { label: string } }
  | { split: { targetPane: string; tab: string; direction: "right"; ratio: number } };
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

export interface SelectorState {
  /** Panes this process may show beside the main pane, with their label. */
  owned: Map<string, string>;
  /** Runtime agents' panes: moved through their runtime (absent: moved directly with Herdr). */
  controls?: Map<string, PaneControl>;
  selected?: string;
  /**
   * Token of a launch (or promotion) that reserved the visible split and has not finished with it yet.
   * Launches and promotions take it with the same synchronous check-and-set.
   */
  reservedSplit?: string;
  /** Bumped whenever the selector moves a pane into the split: layouts read before it are stale. */
  layoutEpoch?: number;
  /** The agent shown in the split was forgotten (finished): promote another one once its pane closed. */
  vacated?: VacatedSplit;
  /** Menu order of the selectable panes (Ctrl+Alt+X / `/subagent`), registered by the extension. */
  menuOrder?: () => string[];
  /** Called (by `forgetPane`) when the visible agent was forgotten; set by the selector doing promotions. */
  onVacated?: () => void;
  /** Called after a promotion moved `paneId` into the split (widget refresh, handle sync). */
  onPromoted?: (paneId: string) => void;
}

export interface VacatedSplit {
  paneId: string;
  /** Menu order when the agent was forgotten (it included the finished agent, if still listed). */
  order: string[];
}
type Run = (args: string[]) => any;

/**
 * - `auto`: the visible split when the main tab holds only the main pane, is not zoomed and no other
 *   launch or promotion reserved it (agents open in background tabs do not matter), else a tab.
 * - `visible`: the visible split, parking our agent shown there; a tab when the main tab has other splits,
 *   is zoomed or another launch already reserved the split.
 */
export type PlacementMode = "auto" | "visible";

export interface PlacementReservation {
  token: string;
  placement: "split-right" | "tab";
  /** `visible` only: our agent currently in the split, to park in a tab before the new split is created. */
  park?: string;
}

const STATE_KEY = Symbol.for("pi-subagents/pane-selector-v1");

/** The process-wide selector state, shared by every runtime client and preserved across /reload. */
export function selectorState(): SelectorState {
  const globals = globalThis as any;
  const state: SelectorState = (globals[STATE_KEY] ??= { owned: new Map() });
  state.controls ??= new Map();
  return state;
}

/** Owned panes in the caller's workspace (agents in other workspaces, e.g. worktree spaces, never count). */
function ownedIn(state: SelectorState, workspaceId: string): string[] {
  return [...state.owned.keys()].filter(
    (id) => (state.controls?.get(id)?.handle.workspaceId ?? workspaceId) === workspaceId,
  );
}

/**
 * Synchronous check-and-set on a layout read beforehand: concurrent launches never both get the split.
 * `adoptPane` or `releasePlacement` must follow.
 */
export function reservePlacement(
  state: SelectorState,
  parent: PaneRecord,
  layout: PaneLayout | undefined,
  mode: PlacementMode,
  /** `layoutEpoch` when `layout` was read (asynchronously): a pane moved into the split since makes it stale. */
  seenEpoch?: number,
): PlacementReservation {
  const token = randomUUID();
  const tab: PlacementReservation = { token, placement: "tab" };
  if (!layout || layout.zoomed || state.reservedSplit) return tab;
  if (seenEpoch !== undefined && (state.layoutEpoch ?? 0) !== seenEpoch) return tab;
  const siblings = layout.panes.filter((pane) => pane.pane_id !== parent.pane_id);
  let park: string | undefined;
  if (mode === "auto") {
    if (siblings.length > 0) return tab;
  } else if (siblings.length === 1 && state.owned.has(siblings[0].pane_id)) {
    park = siblings[0].pane_id;
  } else if (siblings.length > 0) return tab;
  state.reservedSplit = token;
  return { token, placement: "split-right", ...(park ? { park } : {}) };
}

/** The launch created its pane: track it, and select it when it took the reserved split. */
export function adoptPane(
  state: SelectorState,
  reservation: PlacementReservation | undefined,
  paneId: string,
  label: string,
  control?: PaneControl,
): void {
  state.owned.set(paneId, label);
  if (control) (state.controls ??= new Map()).set(paneId, control);
  if (reservation && state.reservedSplit === reservation.token) {
    state.reservedSplit = undefined;
    if (reservation.placement === "split-right") state.selected = paneId;
  }
}

/** The launch failed before creating a pane it could report. */
export function releasePlacement(state: SelectorState, reservation: PlacementReservation | undefined): void {
  if (reservation && state.reservedSplit === reservation.token) state.reservedSplit = undefined;
}

/**
 * The agent finished (or is no longer ours). When it was the one shown in the split, remember its menu
 * position: the selector promotes the next open agent once the pane has actually closed.
 */
export function forgetPane(state: SelectorState, paneId: string): void {
  const wasSelected = state.selected === paneId;
  let order: string[] = [];
  if (wasSelected) {
    try {
      order = state.menuOrder?.() ?? [...state.owned.keys()];
    } catch {
      order = [...state.owned.keys()];
    }
  }
  state.owned.delete(paneId);
  state.controls?.delete(paneId);
  if (!wasSelected) return;
  state.selected = undefined;
  state.vacated = { paneId, order };
  try {
    state.onVacated?.();
  } catch { /* Promotion is best effort; forgetting never fails. */ }
}

/** Candidates after `vacated` in its menu order (wrapping around); the menu order itself when unknown. */
export function promotionOrder(vacated: VacatedSplit): string[] {
  const index = vacated.order.indexOf(vacated.paneId);
  const rotated = index === -1
    ? vacated.order
    : [...vacated.order.slice(index + 1), ...vacated.order.slice(0, index)];
  return rotated.filter((id) => id !== vacated.paneId);
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

/**
 * Decides where agent panes go and which one is shown beside the main pane. Panes are created and
 * moved by the agent runtime; this class reads the layout, reserves the visible split and moves owned
 * panes within the caller's workspace (pane IDs stay stable), each through the runtime that owns it.
 */
export interface PromotionOptions {
  /** Interval between checks that the finished agent's pane has closed. */
  pollMs?: number;
  /** Give up waiting for the pane to close after this long (the split stays as it is). */
  timeoutMs?: number;
}

export class PaneSelector {
  readonly state: SelectorState;
  private readonly run: Run;
  private readonly parentId: () => string;
  private readonly promotionOptions: Required<PromotionOptions>;
  private promoting?: Promise<void>;

  constructor(state: SelectorState, run: Run, parentId: () => string, options: PromotionOptions = {}) {
    this.state = state;
    this.state.controls ??= new Map();
    this.run = run;
    this.parentId = parentId;
    this.promotionOptions = { pollMs: options.pollMs ?? 250, timeoutMs: options.timeoutMs ?? 120_000 };
    // The latest selector of the state (e.g. after /reload) promotes when the visible agent finishes.
    this.state.onVacated = () => { void this.promoteVacated(); };
  }

  parent(): PaneRecord {
    return this.run(["pane", "get", this.parentId()]).pane;
  }

  private layout(parent: PaneRecord): PaneLayout {
    return this.run(["pane", "layout", "--pane", parent.pane_id]).layout;
  }

  visible(): string | undefined {
    const parent = this.parent();
    const layout = this.layout(parent);
    return layout.panes.find((pane: PaneRecord) => this.state.owned.has(pane.pane_id))?.pane_id;
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

  /** `move` overrides every move (tests); otherwise each pane moves through its runtime control. */
  async select(paneId: string, move?: PaneMover): Promise<void> {
    if (!this.state.owned.has(paneId)) throw new Error("Only this session's agent panes can be selected");
    const mover: PaneMover = move ?? ((id, to) => movePane(this.state, id, to, this.herdrMover()));
    const parent = this.parent();
    const target: PaneRecord = this.run(["pane", "get", paneId]).pane;
    if (target.workspace_id !== parent.workspace_id) throw new Error("Agent runs in another workspace; refusing to change its ID");
    const layout = this.layout(parent);
    if (layout.zoomed) throw new Error("Unzoom the main pane before selecting an agent");
    const siblings: PaneRecord[] = layout.panes.filter((pane: PaneRecord) => pane.pane_id !== parent.pane_id);
    if (siblings.length > 1 || siblings.some((pane) => !this.state.owned.has(pane.pane_id))) {
      throw new Error("The main tab contains other splits; leave only the main pane and its agent before selecting");
    }
    const previous = siblings[0]?.pane_id;
    if (previous === paneId) { this.state.selected = paneId; return; }
    const beside = besideTarget(parent);
    this.state.layoutEpoch = (this.state.layoutEpoch ?? 0) + 1;
    let parked = false;
    if (previous) {
      await mover(previous, { newTab: { label: this.state.owned.get(previous)! } });
      parked = true;
      this.state.selected = undefined;
    }
    try {
      await mover(paneId, beside);
      this.state.selected = paneId;
    } catch (error) {
      // Read back before rollback: a failed answer does not prove the move failed.
      const current = this.layout(parent);
      if (current.panes.some((pane: PaneRecord) => pane.pane_id === paneId)) {
        this.state.selected = paneId;
        return;
      }
      if (previous && parked && current.panes.length === 1) {
        try {
          await mover(previous, beside);
          this.state.selected = previous;
        } catch { /* Keep both terminals alive; the selector can be used again. */ }
      }
      throw error;
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
   * Promotion of the next open agent after the visible one finished (`state.vacated`). Resolves when no
   * promotion is pending; never rejects (a failed promotion leaves every terminal where it is).
   */
  promoteVacated(): Promise<void> {
    this.promoting ??= this.runPromotions().finally(() => { this.promoting = undefined; });
    return this.promoting;
  }

  private async runPromotions(): Promise<void> {
    // Never inside the caller's forget: it may be about to close the pane.
    await new Promise<void>((resolve) => setImmediate(resolve));
    while (this.state.vacated) {
      const vacated = this.state.vacated;
      const closed = await this.closed(vacated.paneId);
      if (this.state.vacated !== vacated) continue; // A newer visible agent finished meanwhile.
      this.state.vacated = undefined;
      if (!closed) return;
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
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.promotionOptions.pollMs);
        (timer as any).unref?.();
      });
    }
  }

  /**
   * Moves the next open agent in menu order into the free split, with the refusals of `select` and the
   * launches' split reservation. Returns the promoted pane, if any.
   */
  async promote(vacated: VacatedSplit, move?: PaneMover): Promise<string | undefined> {
    const mover: PaneMover = move ?? ((id, to) => movePane(this.state, id, to, this.herdrMover()));
    const parent = this.parent();
    const layout = this.layout(parent);
    if (layout.zoomed || this.state.reservedSplit) return undefined;
    if (layout.panes.some((pane: PaneRecord) => pane.pane_id !== parent.pane_id)) return undefined;
    const candidate = promotionOrder(vacated).find((id) => {
      if (!this.state.owned.has(id) || !ownedIn(this.state, parent.workspace_id).includes(id)) return false;
      try {
        return this.run(["pane", "get", id]).pane.workspace_id === parent.workspace_id;
      } catch {
        return false;
      }
    });
    if (!candidate || this.state.reservedSplit) return undefined;
    // Same synchronous check-and-set as a launch: a launch arriving now falls back to a tab.
    const token = randomUUID();
    this.state.reservedSplit = token;
    this.state.layoutEpoch = (this.state.layoutEpoch ?? 0) + 1;
    try {
      try {
        await mover(candidate, besideTarget(parent));
      } catch {
        // Read back: a failed answer does not prove the move failed.
        const current = this.layout(parent);
        if (!current.panes.some((pane: PaneRecord) => pane.pane_id === candidate)) return undefined;
      }
      if (!this.state.owned.has(candidate)) return candidate; // Finished during the move.
      this.state.selected = candidate;
    } finally {
      if (this.state.reservedSplit === token) this.state.reservedSplit = undefined;
    }
    try {
      this.state.onPromoted?.(candidate);
    } catch { /* Display only. */ }
    return candidate;
  }
}

/** The split shown beside the main pane (same target for selections and promotions). */
function besideTarget(parent: PaneRecord): PaneMoveTarget {
  return { split: { targetPane: parent.pane_id, tab: parent.tab_id, direction: "right", ratio: 0.5 } };
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
