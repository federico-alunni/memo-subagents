import { execFileSync } from "node:child_process";

export interface PaneRecord {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
}
export interface SelectorState {
  owned: Map<string, string>;
  selected?: string;
}
type Run = (args: string[]) => any;

/** Only moves owned panes within the caller's workspace, so watcher IDs stay stable. */
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

  create(name: string, cwd: string): string {
    const parent = this.parent();
    const layout = this.layout(parent);
    const first = this.state.owned.size === 0 && layout.panes.length === 1 && !layout.zoomed;
    const result = first
      ? this.run(["pane", "split", parent.pane_id, "--direction", "right", "--ratio", "0.5", "--cwd", cwd, "--no-focus"])
      : this.run(["tab", "create", "--workspace", parent.workspace_id, "--label", name, "--cwd", cwd, "--no-focus"]);
    const pane = first ? result.pane : result.root_pane;
    if (!pane?.pane_id) throw new Error("Herdr did not return the created pane ID");
    this.state.owned.set(pane.pane_id, name);
    if (first) this.state.selected = pane.pane_id;
    try { this.run(["pane", "rename", pane.pane_id, name]); } catch { /* Cosmetic only. */ }
    return pane.pane_id;
  }

  select(paneId: string): void {
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
    let parkedTab: string | undefined;
    if (previous) {
      const moved = this.run(["pane", "move", previous, "--new-tab", "--label", this.state.owned.get(previous)!, "--no-focus"]).move_result;
      if (!moved?.changed || moved.pane?.pane_id !== previous) throw new Error("Unable to park the visible subagent safely");
      parkedTab = moved.pane.tab_id;
      this.state.selected = undefined;
    }
    try {
      const moved = this.run(["pane", "move", paneId, "--tab", parent.tab_id, "--target-pane", parent.pane_id, "--split", "right", "--ratio", "0.5", "--no-focus"]).move_result;
      if (!moved?.changed || moved.pane?.pane_id !== paneId) throw new Error("Unable to display the selected subagent safely");
      this.state.selected = paneId;
    } catch (error) {
      // Read back before rollback: a failed CLI response does not prove the move failed.
      const current = this.layout(parent);
      if (current.panes.some((pane: PaneRecord) => pane.pane_id === paneId)) {
        this.state.selected = paneId;
        return;
      }
      if (previous && parkedTab && current.panes.length === 1) {
        try {
          const moved = this.run(["pane", "move", previous, "--tab", parent.tab_id, "--target-pane", parent.pane_id, "--split", "right", "--ratio", "0.5", "--no-focus"]).move_result;
          if (moved?.changed && moved.pane?.pane_id === previous) this.state.selected = previous;
        } catch { /* Keep both terminals alive; the selector can be used again. */ }
      }
      throw error;
    }
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
