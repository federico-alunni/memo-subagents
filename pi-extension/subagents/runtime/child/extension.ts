// Runtime child extension: lifecycle and policy only. Workflow permissions belong to the parent.
// Ported from pi-issue-round's child extension (same author, MIT) and made role-agnostic.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  json,
  activeTools,
  normalizePolicy,
  toolAllowed,
  validPolicy,
} from "../protocol.ts";
import type { Boot, ChildPolicy } from "../protocol.ts";
import { ChildRuntime } from "./runtime.ts";
import type { QuestionEvent } from "pi-memo-question/events";
import { bashDecision, createBashApprovals, readonlyBlockReason } from "./bash-policy.ts";
import type { BashAskContext, BashParentRoute, HerdrBlockedEvent, ParentApproval } from "./bash-policy.ts";
import { createQuestionRouter, setQuestionRouter } from "./question-router.ts";
import { setAskUpstream } from "../ask-parent.ts";
import type { AskTarget } from "../ask-parent.ts";
import { CHILD_ENV } from "./env.ts";
import { createSubagentActivityRecorder } from "../../activity.ts";
import type { SubagentAttention, SubagentAttentionKind } from "../../activity.ts";
import { createHerdrReporter } from "./herdr-reporter.ts";
import { installIdentityWidget } from "./identity-widget.ts";

export { CHILD_ENV };

/** pi-memo-question's event (pi-memo-question/events QUESTION_EVENT). */
export const QUESTION_EVENT = "memo-question";

/** The one "waiting for the user" signal of a child: `{active, label?, kind?}` (see docs/runtime.md). */
export const HERDR_BLOCKED_EVENT = "herdr:blocked";

/**
 * Counts open `herdr:blocked` waits (they may overlap) and reports the current attention: the latest
 * kind/label while at least one wait is open, since the first one opened; null once all are closed.
 */
export function createAttentionTracker(
  onChange: (attention: SubagentAttention | null) => void,
  now: () => number = Date.now,
) {
  let open = 0;
  let current: SubagentAttention | null = null;
  return (event: unknown): void => {
    const e = event as { active?: unknown; label?: unknown; kind?: unknown; target?: unknown } | undefined;
    if (e?.active) {
      open += 1;
      const kind: SubagentAttentionKind =
        e.kind === undefined ? "question" : e.kind === "question" || e.kind === "approval" ? e.kind : "blocked";
      current = {
        kind,
        ...(typeof e.label === "string" && e.label ? { label: e.label } : {}),
        // Ask-parent: who the child waits for (the parent agent or a user).
        ...(e.target === "parent" || e.target === "user" ? { target: e.target as AskTarget } : {}),
        since: current?.since ?? now(),
      };
    } else {
      if (open === 0) return;
      open -= 1;
      if (open > 0) return;
      current = null;
    }
    onChange(current);
  };
}

/**
 * Turns `question` tool events into `question.json` records, in order, so the parent sees the pending
 * question (and moves focus). The tool itself is pi-memo-question's; it never depends on this succeeding.
 */
export function createQuestionReporter(
  report: (id: string, question: string, answer?: string) => Promise<void> | undefined,
) {
  let chain: Promise<unknown> = Promise.resolve();
  return (event: unknown): Promise<unknown> => {
    const e = event as Partial<QuestionEvent> | undefined;
    if (!e || typeof e.id !== "string" || typeof e.question !== "string") return chain;
    const { id, question } = e;
    const answer = e.pending ? undefined : (e.answer ?? "");
    return (chain = chain.then(() => report(id, question, answer)).catch(() => {}));
  };
}

/**
 * Allowlist + read-only bash guard. Anything not activated by the policy is blocked. Synchronous: a bash
 * command the policy would ask about is blocked here (no UI); `createChildToolGuard` asks instead.
 */
export function childToolCall(
  policy: ChildPolicy | undefined,
  toolName: string,
  input: unknown,
  sessionAllow: readonly string[] = [],
): { block: true; reason: string } | undefined {
  if (!policy || !toolAllowed(policy, toolName))
    return {
      block: true,
      reason:
        "Tool not allowed for this agent; ask the parent for extra resources/permissions in your report.",
    };
  if (toolName === "bash" && policy.bash === "readonly") {
    const command = (input as { command?: unknown } | undefined)?.command;
    if (bashDecision(policy, command, sessionAllow) !== "allow")
      return { block: true, reason: readonlyBlockReason(policy, sessionAllow) };
  }
}

/**
 * The child's `tool_call` guard: `childToolCall`, plus the bash question for policies with `bashAsk`
 * (user-driven read-only children), routed to the parent agent first with `route` (ask-parent).
 * "Always" answers are remembered by this guard, i.e. per child process. `audit` receives the transcript
 * line of an approval given upstream (or in this pane as ask-parent fallback).
 */
export function createChildToolGuard(emitBlocked?: (event: HerdrBlockedEvent) => void, route?: BashParentRoute) {
  const approvals = createBashApprovals(emitBlocked, route);
  return async (
    policy: ChildPolicy | undefined,
    toolName: string,
    input: unknown,
    ctx: BashAskContext,
    audit?: (line: string) => void,
  ): Promise<{ block: true; reason: string } | undefined> => {
    const blocked = childToolCall(policy, toolName, input, approvals.prefixes());
    if (!blocked || !policy || toolName !== "bash" || !policy.bashAsk || !toolAllowed(policy, toolName))
      return blocked;
    return approvals.check(policy, (input as { command?: unknown } | undefined)?.command, ctx, audit);
  };
}

type SendUserMessage = (
  text: string,
  options: { expandPromptTemplates: boolean; deliverAs?: "followUp" },
) => void;

/**
 * One task = `/skill:<name>` messages, then the prompt, in one run. `/skill:` is expanded by pi only with
 * expandPromptTemplates. Only the first message starts the run; the others are queued as follow-ups once
 * pi reports the run started (agent_start): sent back to back, a follow-up could find pi still idle and
 * start a competing prompt ("Agent is already processing").
 */
export function createTaskDelivery(sendUserMessage: SendUserMessage) {
  return {
    send(prompt: string, skills: string[] = []): void {
      if (skills.length === 0) {
        sendUserMessage(prompt, { expandPromptTemplates: false });
      } else if (skills.length === 1) {
        const text = prompt ? `/skill:${skills[0]} ${prompt}` : `/skill:${skills[0]}`;
        sendUserMessage(text, { expandPromptTemplates: true });
      } else {
        const skillDirective = skills.map((s) => `Apply skill "${s}".`).join(" ");
        sendUserMessage(prompt ? `${skillDirective}

${prompt}` : skillDirective, { expandPromptTemplates: false });
      }
    },
    agentStarted(): void {},
  };
}

function realCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

/** boot.json read synchronously at load time: delegated tools must be registered before session_start. */
function bootRecord(): Boot | undefined {
  const dir = process.env[CHILD_ENV.protocolDir];
  if (!dir) return undefined;
  try {
    return JSON.parse(readFileSync(join(dir, "boot.json"), "utf8")) as Boot;
  } catch {
    return undefined;
  }
}

function bootPolicy(boot: Boot | undefined): ChildPolicy | undefined {
  if (!boot) return undefined;
  try {
    const policy = normalizePolicy(boot.policy);
    return validPolicy(policy) ? policy : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Internal delegated transport (e.g. `subagent_handoff` of a worktree-space subagent): a model tool
 * would be redundant, but the subagent tool running in this child process needs the same
 * request/response protocol. Shared through globalThis so the extension and the subagent tool's own
 * copy of the module interoperate.
 */
export interface ChildDelegateHook {
  request(tool: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  holdAutoExit(): void;
  end(kind: "replace", extra?: { summary?: string }): Promise<void>;
}

const DELEGATE_HOOK_KEY = Symbol.for("pi-memo-subagents/child-delegate-hook");

function installDelegateHook(child: ChildRuntime, internalTools: ReadonlySet<string>): void {
  (globalThis as Record<symbol, unknown>)[DELEGATE_HOOK_KEY] = {
    async request(tool: string, params: unknown, signal?: AbortSignal) {
      if (!internalTools.has(tool))
        throw new Error(`${tool} is not an internal delegated tool of this child`);
      return child.delegate(tool, params, randomUUID(), signal);
    },
    holdAutoExit: () => child.holdAutoExit(),
    async end(kind: "replace", extra?: { summary?: string }) {
      if (kind !== "replace") throw new Error("Only a replace handoff ends the child");
      await child.exitWith("done", extra?.summary ? { summary: extra.summary } : {});
    },
  } satisfies ChildDelegateHook;
}

/** The delegate hook of this child process (`child` installs it: the runtime child session start). */
export function childDelegateHook(child?: ChildRuntime, internalTools?: ReadonlySet<string>): ChildDelegateHook | undefined {
  if (child && internalTools) installDelegateHook(child, internalTools);
  return (globalThis as Record<symbol, ChildDelegateHook | undefined>)[DELEGATE_HOOK_KEY];
}

export default function childExtension(pi: ExtensionAPI): void {
  let runtime: ChildRuntime | undefined;
  let boot: Boot | undefined;
  const declaredBoot = bootRecord();
  const declared = bootPolicy(declaredBoot);
  const protocolDir = process.env[CHILD_ENV.protocolDir];
  // Display-only activity snapshots for the parent's widget/stall detection.
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env[CHILD_ENV.nonce],
    activityFile: protocolDir ? join(protocolDir, "activity.json") : undefined,
  });
  const delivery = createTaskDelivery((text, options) => pi.sendUserMessage(text, options));
  const emitBlocked = (event: HerdrBlockedEvent) => pi.events.emit(HERDR_BLOCKED_EVENT, event);
  // Ask-parent: questions and approvals go to the parent agent first (see docs/runtime.md).
  const askEnabled = () => !!runtime && boot?.policy.askParent === true;
  const bashRoute: BashParentRoute = {
    // Approvals follow the default target: the parent only when it is the default.
    enabled: () => askEnabled() && boot?.policy.askParentDefault === true,
    async ask(command, prefix, signal, onTarget): Promise<ParentApproval> {
      const outcome = await runtime!.ask({ kind: "approval", text: command, command, prefix }, { signal, onTarget });
      if (outcome.kind !== "answered") return outcome;
      return {
        kind: "decision",
        decision: outcome.result.decision ?? "cancel",
        by: outcome.result.by,
        ...(outcome.result.note ? { note: outcome.result.note } : {}),
      };
    },
  };
  const toolGuard = createChildToolGuard(emitBlocked, bashRoute);
  // Transcript lines of approvals given upstream, appended to the bash result.
  const approvalAudit = new Map<string, string>();
  // The installed pi-memo-question asks this router before its dialog (`to: "parent"`, or no `to` when the
  // parent is the default target).
  if (declared?.askParent)
    setQuestionRouter(
      createQuestionRouter({
        enabled: askEnabled,
        parentByDefault: () => boot?.policy.askParentDefault === true,
        ask: (question, options, signal, onTarget) =>
          runtime!.ask({ kind: "question", text: question, options }, { signal, onTarget }),
        emitBlocked,
      }),
    );
  // Isolated children (-ne) lack Herdr's pi integration: report the pane's agent state directly.
  const herdr = declared ? createHerdrReporter({ isolation: declaredBoot?.isolation }) : undefined;
  pi.events.on(
    HERDR_BLOCKED_EVENT,
    createAttentionTracker((attention) => {
      recorder.attention(attention);
      herdr?.attention(attention ?? undefined);
    }),
  );
  // Identity widget (and its Ctrl+J) only for user-driven children: workflow children keep pi's keys.
  const widget = declared?.userInput === "allowed"
    ? installIdentityWidget(pi, () =>
        boot ? { label: boot.display?.label, denied: boot.policy.denyTools } : undefined,
      )
    : undefined;
  if (declared && declared.exit !== "parent") {
    pi.registerTool({
      name: "caller_ping",
      label: "Caller Ping",
      description:
        "Send a help request to the parent agent and exit this session. " +
        "The parent will be notified with your message and can resume this session with a response. " +
        "Use when you're stuck, need clarification, or need the parent to take action.",
      parameters: Type.Object({
        message: Type.String({ description: "What you need help with" }),
      }),
      async execute(_id, params) {
        if (!runtime) throw new Error("Not an owned runtime child");
        recorder.callerPing();
        await runtime.exitWith("ping", { message: params.message });
        return {
          content: [{ type: "text", text: "Ping sent. Session will exit and parent will be notified." }],
          details: {},
        };
      },
    });
    pi.registerTool({
      name: "subagent_done",
      label: "Subagent Done",
      description:
        "Call this tool when you have completed your task. " +
        "It will close this session and return your results to the main session. " +
        "Your LAST assistant message before calling this becomes the summary returned to the caller.",
      parameters: Type.Object({}),
      async execute() {
        if (!runtime) throw new Error("Not an owned runtime child");
        recorder.subagentDone();
        await runtime.exitWith("done");
        return {
          content: [{ type: "text", text: "Shutting down subagent session." }],
          details: {},
        };
      },
    });
  }
  for (const spec of declared?.delegatedTools ?? []) {
    if (spec.internal) continue; // internal transport (handoff): reached through the delegate hook
    pi.registerTool({
      name: spec.name,
      label: spec.label ?? spec.name,
      description: spec.description,
      parameters: Type.Unsafe<Record<string, unknown>>(spec.parameters),
      async execute(toolCallId, params, signal) {
        if (!runtime) throw new Error("Not an owned runtime child");
        const result = await runtime.delegate(spec.name, params, toolCallId, signal);
        return {
          content: [{ type: "text", text: JSON.stringify(result) ?? "No result" }],
          details: result,
        };
      },
    });
  }
  // The `question` tool is pi-memo-question's (loaded with -e by the runtime): report its dialogs.
  pi.events.on(
    QUESTION_EVENT,
    createQuestionReporter((id, question, answer) => runtime?.question(id, question, answer)),
  );
  pi.on("session_start", async (_event, ctx) => {
    const dir = process.env[CHILD_ENV.protocolDir];
    if (!dir || !process.env[CHILD_ENV.nonce])
      throw new Error("Runtime child requires private identity");
    boot = await json<Boot>(join(dir, "boot.json"));
    if (
      !boot ||
      boot.nonce !== process.env[CHILD_ENV.nonce] ||
      boot.protocolDir !== dir ||
      boot.agentId !== process.env[CHILD_ENV.agentId] ||
      boot.scope !== process.env[CHILD_ENV.scope] ||
      String(boot.attempt) !== process.env[CHILD_ENV.attempt] ||
      !validPolicy(normalizePolicy(boot.policy)) ||
      JSON.stringify(normalizePolicy(boot.policy)) !== JSON.stringify(declared)
    )
      throw new Error("Runtime child environment/boot mismatch");
    boot = { ...boot, policy: declared! };
    runtime?.dispose();
    recorder.sessionStart();
    const sessionPath = ctx.sessionManager.getSessionFile();
    if (!sessionPath)
      throw new Error("Runtime children require persistent sessions");
    runtime = new ChildRuntime(boot, {
      // pi may report a session's cwd with symlinks (e.g. /tmp on macOS); identity uses the real path.
      cwd: realCwd(ctx.cwd),
      pid: process.pid,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionPath,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "",
      effort: pi.getThinkingLevel(),
      isIdle: () => ctx.isIdle(),
      sendPrompt: (prompt, skills = []) => delivery.send(prompt, skills),
      abort: () => ctx.abort(),
      shutdown: () => ctx.shutdown(),
    });
    const internalTools = new Set((boot.policy.delegatedTools ?? []).filter((d) => d.internal).map((d) => d.name));
    if (internalTools.size > 0) installDelegateHook(runtime, internalTools);
    const allowlist = activeTools(boot.policy);
    pi.setActiveTools(
      allowlist ??
        pi.getActiveTools().filter((tool) => !boot!.policy.denyTools.includes(tool)),
    );
    await runtime.start();
    // A nested agent's parent extension forwards escalated requests through this child, one level up.
    if (boot.policy.askParent) {
      const owned = runtime;
      setAskUpstream({
        name: boot.display?.label ?? boot.agentId,
        forward: (request, options) => owned.ask(request, options),
      });
    }
    herdr?.agentActive(!ctx.isIdle());
    widget?.show(ctx);
  });
  pi.on("tool_call", (event, ctx) => {
    recorder.toolCall(event.toolCallId, event.toolName);
    return toolGuard(boot?.policy, event.toolName, event.input, ctx, (line) =>
      approvalAudit.set(event.toolCallId, line),
    );
  });

  // With userInput "allowed" the user drives the child; otherwise any manual control is a takeover.
  const takeover = async () => {
    if (boot?.policy.userInput === "takeover") await runtime?.takeover();
  };
  pi.on("input", async (event) => {
    recorder.input();
    if (event.source !== "extension") await takeover();
    return { action: "continue" as const };
  });
  pi.on("user_bash", async () => {
    await takeover();
  });
  pi.on("model_select", async (event) => {
    if (boot && `${event.model.provider}/${event.model.id}` !== boot.model)
      await takeover();
  });
  pi.on("thinking_level_select", async (event) => {
    if (boot && event.level !== boot.effort) await takeover();
  });
  pi.on("before_agent_start", () => recorder.beforeAgentStart());
  pi.on("agent_start", () => {
    recorder.agentStart();
    herdr?.agentActive(true);
    delivery.agentStarted();
  });
  pi.on("turn_start", (event) => recorder.turnStart((event as any).turnIndex));
  pi.on("turn_end", (event) => recorder.turnEnd((event as any).turnIndex));
  pi.on("before_provider_request", () => recorder.beforeProviderRequest());
  pi.on("after_provider_response", () => recorder.afterProviderResponse());
  pi.on("message_update", (event) =>
    recorder.messageUpdate((event as any).assistantMessageEvent?.type),
  );
  pi.on("tool_execution_start", (event) =>
    recorder.toolExecutionStart(event.toolCallId, event.toolName),
  );
  pi.on("tool_execution_update", (event) =>
    recorder.toolExecutionUpdate(event.toolCallId, event.toolName),
  );
  pi.on("tool_result", (event) => {
    recorder.toolResult(event.toolCallId, event.toolName);
    const line = approvalAudit.get(event.toolCallId);
    if (line === undefined) return;
    approvalAudit.delete(event.toolCallId);
    return { content: [...event.content, { type: "text" as const, text: `\n(${line})` }] };
  });
  pi.on("tool_execution_end", (event) =>
    recorder.toolExecutionEnd(event.toolCallId, event.toolName),
  );
  pi.on("agent_end", (event) => {
    recorder.agentEndWaiting();
    runtime?.agentEnd(event.messages);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.isIdle()) herdr?.agentActive(false);
    await runtime?.agentSettled();
  });
  pi.on("session_shutdown", async (event) => {
    recorder.sessionShutdown((event as any).reason);
    runtime?.dispose();
    runtime = undefined;
    if (boot?.policy.askParent) setAskUpstream(undefined);
    // Bounded: the release is best effort and must not hold the child's exit.
    if ((event as any).reason === "quit" && herdr)
      await Promise.race([herdr.release(), new Promise((resolve) => setTimeout(resolve, 1500).unref?.())]);
  });
}
