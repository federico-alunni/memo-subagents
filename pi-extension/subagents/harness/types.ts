import type { ResolvedRuntimePlan, ThinkingLevel } from "../runtime-routing.ts";

export interface SubagentLaunchParams {
  id: string;
  name: string;
  task: string;
  agent?: string;
  cwd?: string;
  systemPrompt?: string;
  tools?: string;
  skills?: string;
  interactive?: boolean;
}

export interface AgentDefinition {
  name: string;
  description?: string;
  model?: string;
  thinking?: string;
  tools?: string;
  skills?: string;
  sessionMode?: string;
  systemPromptMode?: string;
  interactive?: boolean;
  body?: string;
  disableModelInvocation?: boolean;
}

export interface SubagentLaunchContext {
  params: SubagentLaunchParams;
  agentDefs?: AgentDefinition | null;
  runtimePlan: ResolvedRuntimePlan;
  effectiveModel?: string;
  effectiveThinking?: ThinkingLevel;
  parentThinking: ThinkingLevel;
  surface: string;
  artifactDir: string;
  sessionDir: string;
  subagentSessionFile: string;
  effectiveCwd: string;
  localAgentDir?: string;
  effectiveAutoExit: boolean;
  effectiveInteractive: boolean;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
  denySet?: Set<string>;
  identity?: string | null;
  identityInSystemPrompt?: boolean;
  systemPromptMode?: string;
  roleBlock?: string;
  modeHint?: string;
  summaryInstruction?: string;
  subagentsDir: string;
  shellQuote: (s: string) => string;
}

export interface BuiltHarnessCommand {
  /** The full shell command line to run in the pane (including cd and exit-code trailer) */
  command: string;
  sessionFile?: string;
  launchScriptPreamble?: string[];
}

export interface HarnessDriver {
  /** Canonical CLI identifier (always "pi"). */
  readonly id: string;

  /** Human-readable display name. */
  readonly name: string;

  /** Format the model reference for this CLI */
  formatModel(runtimePlan: Pick<ResolvedRuntimePlan, "model" | "modelId" | "provider">): string;

  /** Build the execution command line and metadata for launch */
  buildCommand(context: SubagentLaunchContext): BuiltHarnessCommand;

  /** Whether this CLI writes structured .activity.json snapshots */
  readonly hasActivitySnapshots?: boolean;

  /** Whether this CLI supports Turn-only Escape interrupts */
  readonly supportsTurnInterrupt?: boolean;
}
