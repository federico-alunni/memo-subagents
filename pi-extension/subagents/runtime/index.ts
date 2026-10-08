// Public surface of `pi-memo-subagents/runtime`. Contract: docs/runtime.md.
export {
  AgentRuntime,
  RuntimeError,
  nextSubagentIndex,
  subagentPanelName,
} from "./agent-runtime.ts";
export type { RuntimeConfig, LaunchSpec, Observation } from "./agent-runtime.ts";
export {
  nodeRunner,
  readProcessTerminal,
  processIdentity,
  terminalName,
  hostCompositionFromEnv,
} from "./runner.ts";
export type { Runner, RunInput, RunResult } from "./runner.ts";
export {
  sameAgent,
  sameTask,
  validTask,
  taskKey,
  onceRequestId,
  THINKING_LEVELS,
} from "./protocol.ts";
export type {
  AgentHandle,
  ChildRecord,
  DelegatedToolSpec,
  Labels,
  Placement,
  BashPolicy,
  ThinkingLevel,
} from "./protocol.ts";
export { paneSelector, selectorState } from "./pane-selector.ts";
export type { PlacementMode, SelectorState } from "./pane-selector.ts";
export { presence, presenceActive } from "./presence.ts";
export type { PresenceEntry, PresenceRegistry, PresenceState } from "./presence.ts";
