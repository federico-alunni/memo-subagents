// Display-only Herdr helpers of the subagent tool. Panes are created, moved and closed by the
// agent runtime (runtime/); this module only checks Herdr, reads the agent status shown in the
// widget and reports cosmetic pane metadata.
import {
  inspectHerdrPane,
  isHerdrAvailable,
  reportHerdrPaneTask,
  sendHerdrEscape,
} from "./herdr.ts";

export type PaneId = string;

const SETUP_HINT = "Start pi inside herdr (`herdr`, then run `pi`).";

export function isTerminalAvailable(): boolean {
  return isHerdrAvailable();
}

export function terminalSetupHint(): string {
  return SETUP_HINT;
}

/** Escape key for subagents that are not runtime children (entries adopted across an upgrade). */
export function interruptPane(paneId: PaneId): void {
  sendHerdrEscape(paneId);
}

export type { PaneInspection, HerdrAgentStatus } from "./lifecycle.ts";

export async function inspectPane(paneId: PaneId): Promise<import("./lifecycle.ts").PaneInspection> {
  const result = await inspectHerdrPane(paneId);
  if (result.kind === "present") return { kind: "present", observedAt: Date.now(), ...result };
  return result;
}

/** Cosmetic task token in Herdr's pane metadata. */
export function setPaneTask(paneId: PaneId, task: string): void {
  reportHerdrPaneTask(paneId, task, "memo-subagents");
}
