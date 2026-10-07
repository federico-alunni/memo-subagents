// Runtime child extension: lifecycle and policy only. Workflow permissions belong to the parent.
// Ported from pi-issue-round's child extension (same author, MIT) and made role-agnostic.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
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
import { answerText, questionComponent } from "./question-dialog.ts";
import type { QuestionAnswer } from "./question-dialog.ts";
import { bashDecision, createBashApprovals, readonlyBlockReason } from "./bash-policy.ts";
import type { BashAskContext } from "./bash-policy.ts";
import { CHILD_ENV } from "./env.ts";
import { createSubagentActivityRecorder } from "../../activity.ts";
import { installIdentityWidget } from "./identity-widget.ts";

export { CHILD_ENV };

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
 * (user-driven read-only children). "Always" answers are remembered by this guard, i.e. per child process.
 */
export function createChildToolGuard() {
  const approvals = createBashApprovals();
  return async (
    policy: ChildPolicy | undefined,
    toolName: string,
    input: unknown,
    ctx: BashAskContext,
  ): Promise<{ block: true; reason: string } | undefined> => {
    const blocked = childToolCall(policy, toolName, input, approvals.prefixes());
    if (!blocked || !policy || toolName !== "bash" || !policy.bashAsk || !toolAllowed(policy, toolName))
      return blocked;
    return approvals.check(policy, (input as { command?: unknown } | undefined)?.command, ctx);
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
  let pending: { text: string; expand: boolean }[] = [];
  return {
    send(prompt: string, skills: string[] = []): void {
      const [first, ...rest] = [
        ...skills.map((skill) => ({ text: `/skill:${skill}`, expand: true })),
        { text: prompt, expand: false },
      ];
      pending = rest;
      sendUserMessage(first.text, { expandPromptTemplates: first.expand });
    },
    agentStarted(): void {
      const queued = pending;
      pending = [];
      for (const message of queued)
        sendUserMessage(message.text, { expandPromptTemplates: message.expand, deliverAs: "followUp" });
    },
  };
}

function realCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

/** Boot policy read synchronously at load time: delegated tools must be registered before session_start. */
function bootPolicy(): ChildPolicy | undefined {
  const dir = process.env[CHILD_ENV.protocolDir];
  if (!dir) return undefined;
  try {
    const boot = JSON.parse(readFileSync(join(dir, "boot.json"), "utf8")) as Boot;
    const policy = normalizePolicy(boot.policy);
    return validPolicy(policy) ? policy : undefined;
  } catch {
    return undefined;
  }
}

export default function childExtension(pi: ExtensionAPI): void {
  let runtime: ChildRuntime | undefined;
  let boot: Boot | undefined;
  const declared = bootPolicy();
  const protocolDir = process.env[CHILD_ENV.protocolDir];
  // Display-only activity snapshots for the parent's widget/stall detection.
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env[CHILD_ENV.nonce],
    activityFile: protocolDir ? join(protocolDir, "activity.json") : undefined,
  });
  const delivery = createTaskDelivery((text, options) => pi.sendUserMessage(text, options));
  const toolGuard = createChildToolGuard();
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
  if (declared?.question)
    pi.registerTool({
      name: "question",
      label: "Domanda all'utente",
      description:
        "Ask the human ONE essential decision in this pane (focus moves here automatically). Put the recommended option first with '(Recommended)' in its label; add a short description per option. The human may also type a free answer or attach a note to an option. Use only for decisions you cannot ground in code/issues; never for approval of execution.",
      parameters: Type.Object({
        question: Type.String(),
        options: Type.Array(
          Type.Object({
            label: Type.String(),
            description: Type.Optional(Type.String()),
          }),
          { minItems: 1 },
        ),
      }),
      async execute(_id, params, signal, _update, ctx) {
        if (!runtime) throw new Error("Not an owned runtime child");
        if (!ctx.hasUI) throw new Error("No interactive UI in this child pane");
        const questionId = randomUUID();
        await runtime.question(questionId, params.question);
        let result: QuestionAnswer | null = null;
        try {
          if (!signal?.aborted)
            result = await ctx.ui.custom<QuestionAnswer | null>(
              (tui, theme, _kb, done) => {
                let settled = false;
                const finish = (r: QuestionAnswer | null) => {
                  if (!settled) ((settled = true), done(r));
                };
                // The dialog has no abort option: an aborted turn closes it as cancelled.
                signal?.addEventListener("abort", () => finish(null), {
                  once: true,
                });
                return questionComponent(
                  tui,
                  theme,
                  params.question,
                  params.options,
                  finish,
                );
              },
            );
        } finally {
          // Always release the pending state, so focus returns to the parent.
          await runtime
            .question(questionId, params.question, result?.answer ?? "")
            .catch(() => {});
        }
        return {
          content: [{ type: "text", text: answerText(result) }],
          details: {
            question: params.question,
            answer: result?.answer ?? null,
            ...(result && !result.custom && result.note
              ? { note: result.note }
              : {}),
          },
        };
      },
    });
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
    const allowlist = activeTools(boot.policy);
    pi.setActiveTools(
      allowlist ??
        pi.getActiveTools().filter((tool) => !boot!.policy.denyTools.includes(tool)),
    );
    await runtime.start();
    widget?.show(ctx);
  });
  pi.on("tool_call", (event, ctx) => {
    recorder.toolCall(event.toolCallId, event.toolName);
    return toolGuard(boot?.policy, event.toolName, event.input, ctx);
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
  pi.on("tool_result", (event) => recorder.toolResult(event.toolCallId, event.toolName));
  pi.on("tool_execution_end", (event) =>
    recorder.toolExecutionEnd(event.toolCallId, event.toolName),
  );
  pi.on("agent_end", (event) => {
    recorder.agentEndWaiting();
    runtime?.agentEnd(event.messages);
  });
  pi.on("agent_settled", async () => {
    await runtime?.agentSettled();
  });
  pi.on("session_shutdown", (event) => {
    recorder.sessionShutdown((event as any).reason);
    runtime?.dispose();
    runtime = undefined;
  });
}
