// Runtime child extension: lifecycle and policy only. Workflow permissions belong to the parent.
// Ported from pi-issue-round's child extension (same author, MIT) and made role-agnostic.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { json, activeTools, validPolicy } from "../protocol.ts";
import type { Boot, ChildPolicy } from "../protocol.ts";
import { ChildRuntime } from "./runtime.ts";
import { answerText, questionComponent } from "./question-dialog.ts";
import type { QuestionAnswer } from "./question-dialog.ts";
import { readonlyBashRejection, readonlyCommand } from "./readonly-bash.ts";
import { CHILD_ENV } from "./env.ts";

export { CHILD_ENV };

/** Allowlist + read-only bash guard. Anything not activated by the policy is blocked. */
export function childToolCall(
  policy: ChildPolicy | undefined,
  toolName: string,
  input: unknown,
): { block: true; reason: string } | undefined {
  if (!policy || !activeTools(policy).includes(toolName))
    return {
      block: true,
      reason:
        "Tool not allowed for this agent; ask the parent for extra resources/permissions in your report.",
    };
  if (toolName === "bash" && policy.bash === "readonly") {
    const command = (input as { command?: unknown } | undefined)?.command;
    if (typeof command !== "string" || !readonlyCommand(command))
      return { block: true, reason: readonlyBashRejection("Read-only agent") };
  }
}

/** Boot policy read synchronously at load time: delegated tools must be registered before session_start. */
function bootPolicy(): ChildPolicy | undefined {
  const dir = process.env[CHILD_ENV.protocolDir];
  if (!dir) return undefined;
  try {
    const boot = JSON.parse(readFileSync(join(dir, "boot.json"), "utf8")) as Boot;
    return validPolicy(boot.policy) ? boot.policy : undefined;
  } catch {
    return undefined;
  }
}

export default function childExtension(pi: ExtensionAPI): void {
  let runtime: ChildRuntime | undefined;
  let boot: Boot | undefined;
  const declared = bootPolicy();
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
      !validPolicy(boot.policy) ||
      JSON.stringify(boot.policy) !== JSON.stringify(declared)
    )
      throw new Error("Runtime child environment/boot mismatch");
    runtime?.dispose();
    const sessionPath = ctx.sessionManager.getSessionFile();
    if (!sessionPath)
      throw new Error("Runtime children require persistent sessions");
    runtime = new ChildRuntime(boot, {
      cwd: ctx.cwd,
      pid: process.pid,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionPath,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "",
      effort: pi.getThinkingLevel(),
      isIdle: () => ctx.isIdle(),
      sendPrompt: (prompt) => pi.sendUserMessage(prompt),
      abort: () => ctx.abort(),
      shutdown: () => ctx.shutdown(),
    });
    pi.setActiveTools(activeTools(boot.policy));
    await runtime.start();
  });
  pi.on("tool_call", (event) =>
    childToolCall(boot?.policy, event.toolName, event.input),
  );
  pi.on("input", async (event) => {
    if (event.source !== "extension") await runtime?.takeover();
    return { action: "continue" as const };
  });
  pi.on("user_bash", async () => {
    await runtime?.takeover();
  });
  pi.on("model_select", async (event) => {
    if (boot && `${event.model.provider}/${event.model.id}` !== boot.model)
      await runtime?.takeover();
  });
  pi.on("thinking_level_select", async (event) => {
    if (boot && event.level !== boot.effort) await runtime?.takeover();
  });
  pi.on("agent_end", (event) => {
    runtime?.agentEnd(event.messages);
  });
  pi.on("agent_settled", async () => {
    await runtime?.agentSettled();
  });
  pi.on("session_shutdown", () => {
    runtime?.dispose();
    runtime = undefined;
  });
}
