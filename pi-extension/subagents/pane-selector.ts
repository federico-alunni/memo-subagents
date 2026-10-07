import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface PaneRecord {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
}
export interface SelectorState {
  owned: Map<string, string>;
  selected?: string;
  /** Token of a launch that reserved the visible split and has not reported its pane yet. */
  reservedSplit?: string;
}
type Run = (args: string[]) => any;

export type PaneMoveTarget =
  | { newTab: { label: string } }
  | { split: { targetPane: string; tab: string; direction: "right"; ratio: number } };
/** Moves an owned pane; resolves only when the move is observed (the runtime's `move`). */
export type PaneMover = (paneId: string, to: PaneMoveTarget) => Promise<void>;

export interface PlacementReservation {
  token: string;
  placement: "split-right" | "tab";
}

/**
 * Decides where subagent panes go and which one is shown beside the main pane. Panes are created and
 * moved by the agent runtime; this class only reads the layout, reserves the visible split and
 * asks the mover to move owned panes within the caller's workspace (pane IDs stay stable).
 */
export class PaneSelector {
  readonly state: SelectorState;
  private readonly run: Run;
  private readonly parentId: () => string;

  constructor(state: SelectorState, run: Run, parentId: () => string) {
    this.state = state;
    this.run = run;
    this.parentId = parentId;
  }

  private parent(): PaneRecord {
    return this.run(["pane", "get", this.parentId()]).pane;
  }

  private layout(parent: PaneRecord): any {
    return this.run(["pane", "layout", "--pane", parent.pane_id]).layout;
  }

  visible(): string | undefined {
    const parent = this.parent();
    const layout = this.layout(parent);
    return layout.panes.find((pane: PaneRecord) => this.state.owned.has(pane.pane_id))?.pane_id;
  }

  /**
   * Synchronous placement decision: the first child of a single-pane, unzoomed main tab gets the
   * visible split (reserved until it reports its pane), every other child a background tab.
   */
  reserve(): PlacementReservation {
    const token = randomUUID();
    let first = false;
    try {
      const parent = this.parent();
      const layout = this.layout(parent);
      first =
        this.state.owned.size === 0 &&
        !this.state.reservedSplit &&
        layout.panes.length === 1 &&
        !layout.zoomed;
    } catch {
      first = false; // Unknown layout: never split.
    }
    if (first) this.state.reservedSplit = token;
    return { token, placement: first ? "split-right" : "tab" };
  }

  /** The launch created its pane: track it, and select it when it took the reserved split. */
  adopt(reservation: PlacementReservation, paneId: string, name: string): void {
    this.state.owned.set(paneId, name);
    if (this.state.reservedSplit === reservation.token) {
      this.state.reservedSplit = undefined;
      if (reservation.placement === "split-right") this.state.selected = paneId;
    }
  }

  /** The launch failed before creating a pane it could report. */
  release(reservation: PlacementReservation): void {
    if (this.state.reservedSplit === reservation.token) this.state.reservedSplit = undefined;
  }

  async select(paneId: string, move: PaneMover = this.herdrMover()): Promise<void> {
    if (!this.state.owned.has(paneId)) throw new Error("Only this session's subagent panes can be selected");
    const parent = this.parent();
    const target: PaneRecord = this.run(["pane", "get", paneId]).pane;
    if (target.workspace_id !== parent.workspace_id) throw new Error("Subagent was moved to another workspace; refusing to change its ID");
    const layout = this.layout(parent);
    if (layout.zoomed) throw new Error("Unzoom the main pane before selecting a subagent");
    const siblings: PaneRecord[] = layout.panes.filter((pane: PaneRecord) => pane.pane_id !== parent.pane_id);
    if (siblings.length > 1 || siblings.some((pane) => !this.state.owned.has(pane.pane_id))) {
      throw new Error("The main tab contains other splits; leave only the main pane and its subagent before selecting");
    }
    const previous = siblings[0]?.pane_id;
    if (previous === paneId) { this.state.selected = paneId; return; }
    const beside: PaneMoveTarget = {
      split: { targetPane: parent.pane_id, tab: parent.tab_id, direction: "right", ratio: 0.5 },
    };
    let parked = false;
    if (previous) {
      await move(previous, { newTab: { label: this.state.owned.get(previous)! } });
      parked = true;
      this.state.selected = undefined;
    }
    try {
      await move(paneId, beside);
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
          await move(previous, beside);
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
      if (!moved?.changed || moved.pane?.pane_id !== paneId) throw new Error("Unable to move the subagent pane safely");
    };
  }

  forget(paneId: string): void {
    this.state.owned.delete(paneId);
    if (this.state.selected === paneId) this.state.selected = undefined;
  }
}

const STATE_KEY = Symbol.for("pi-subagents/pane-selector-v1");
const globals = globalThis as any;
const state: SelectorState = globals[STATE_KEY] ?? (globals[STATE_KEY] = { owned: new Map() });
export const paneSelector = new PaneSelector(state, (args) => {
  const output = execFileSync("herdr", args, { encoding: "utf8" });
  const response = JSON.parse(output);
  if (response.error) throw new Error(response.error.message ?? "Herdr request failed");
  return response.result;
}, () => {
  if (!process.env.HERDR_PANE_ID) throw new Error("HERDR_PANE_ID is not set");
  return process.env.HERDR_PANE_ID;
});
