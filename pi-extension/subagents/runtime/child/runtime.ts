// Child-side evidence writer: no scheduler/state machine. Ported from pi-issue-round (same author, MIT).
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import {
  json,
  publish,
  taskFile,
  requestFile,
  onceRequestId,
  questionFile,
  sameAgent,
  sameTask,
  validTask,
  record,
  privateDirectory,
  within,
} from "../protocol.ts";
import type {
  Boot,
  TaskCommand,
  ChildRecord,
  Ready,
  DelegatedToolSpec,
} from "../protocol.ts";

export interface ChildHost {
  sessionId: string;
  sessionPath: string;
  cwd: string;
  pid: number;
  model: string;
  effort: string;
  isIdle(): boolean;
  sendPrompt(prompt: string): void;
  abort(): void;
  shutdown(): void;
}
export const DEFAULT_DELEGATED_TIMEOUT_MS = 300000;

export function settledResult(
  messages: readonly unknown[] | undefined,
): Pick<ChildRecord, "status" | "summary" | "error"> {
  for (const raw of [...(messages ?? [])].reverse()) {
    const m = raw as {
      role?: string;
      stopReason?: string;
      errorMessage?: string;
      content?: { type?: string; text?: string }[];
    };
    if (m.role !== "assistant") continue;
    const summary = Array.isArray(m.content)
      ? m.content
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("\n")
      : "";
    if (m.stopReason === "error")
      return {
        status: "error",
        error: m.errorMessage || "Provider/agent loop failed",
        summary,
      };
    if (m.stopReason === "aborted") return { status: "interrupted", summary };
    if (!["stop", "length", "toolUse"].includes(m.stopReason ?? ""))
      return {
        status: "error",
        error: `Unresolved assistant outcome: ${m.stopReason ?? "missing stopReason"}`,
        summary,
      };
    return { status: "success", summary };
  }
  return {
    status: "error",
    error: "No assistant outcome was observed at settlement",
  };
}
/** Private child evidence writer, not a scheduler/state machine. No resources in constructor. */
export class ChildRuntime {
  private boot: Boot;
  private host: ChildHost;
  private active?: TaskCommand;
  private busy = false;
  private closed = false;
  private latest?: readonly unknown[];
  private timer?: ReturnType<typeof setInterval>;
  private pendingRequest?: string;
  constructor(boot: Boot, host: ChildHost) {
    this.boot = boot;
    this.host = host;
  }
  async start(startTimer = true): Promise<void> {
    await privateDirectory(this.boot.protocolDir);
    if (
      this.host.model !== this.boot.model ||
      this.host.effort !== this.boot.effort ||
      this.host.sessionId !== this.boot.sessionId ||
      this.host.cwd !== this.boot.cwd ||
      !within(join(this.boot.protocolDir, "sessions"), this.host.sessionPath)
    )
      throw new Error("Child session/cwd identity mismatch");
    const ready: Ready = {
      scope: this.boot.scope,
      agentId: this.boot.agentId,
      attempt: this.boot.attempt,
      nonce: this.boot.nonce,
      sessionId: this.boot.sessionId,
      paneId: this.boot.paneId,
      pid: this.host.pid,
      sessionPath: this.host.sessionPath,
      cwd: this.host.cwd,
    };
    const prior = await json<Ready>(join(this.boot.protocolDir, "ready.json"));
    if (prior) {
      if (
        !sameAgent(prior, ready) ||
        prior.pid !== ready.pid ||
        prior.sessionPath !== ready.sessionPath
      )
        throw new Error(
          "Child restart/identity changed; reconciliation required",
        );
    } else await publish(join(this.boot.protocolDir, "ready.json"), ready);
    const task = await this.current();
    if (task) {
      const accepted = await json<ChildRecord>(
        taskFile(this.boot.protocolDir, task.taskId, "accepted"),
      );
      const settled = await json<ChildRecord>(
        taskFile(this.boot.protocolDir, task.taskId, "settled"),
      );
      if (
        validTask(accepted, task, "accepted") &&
        !validTask(settled, task, "settled")
      )
        this.active = task;
    }
    // Reload observes an already accepted task, never resubmits it.
    if (startTimer) {
      this.timer = setInterval(() => {
        void this.tick().catch(() => {});
      }, 100);
      this.timer.unref();
    }
  }
  private async current(): Promise<TaskCommand | undefined> {
    const task = await json<TaskCommand>(
      join(this.boot.protocolDir, "task.json"),
    );
    if (
      !task ||
      task.kind !== "task" ||
      !task.taskId ||
      !task.taskToken ||
      typeof task.prompt !== "string" ||
      !sameAgent(this.boot, task)
    )
      return undefined;
    return task;
  }
  async tick(): Promise<void> {
    if (this.closed || this.busy) return;
    this.busy = true;
    try {
      if (await json(join(this.boot.protocolDir, "takeover.json"))) return;
      const task = await this.current();
      if (!task) return;
      const interrupt = await json<ChildRecord>(
        join(this.boot.protocolDir, "interrupt.json"),
      );
      const interruptAck = await json<ChildRecord>(
        join(this.boot.protocolDir, "interrupt-ack.json"),
      );
      if (
        validTask(interrupt, task, "interrupt-request") &&
        interrupt.recordId !== interruptAck?.recordId
      ) {
        this.host.abort();
        await publish(
          join(this.boot.protocolDir, "interrupt-ack.json"),
          { ...interrupt, kind: "interrupt-ack" },
          false,
        );
      }
      const shutdown = await json<ChildRecord>(
        join(this.boot.protocolDir, "shutdown.json"),
      );
      const settled = await json<ChildRecord>(
        taskFile(this.boot.protocolDir, task.taskId, "settled"),
      );
      if (validTask(shutdown, task, "shutdown-request")) {
        if (
          this.active ||
          !this.host.isIdle() ||
          this.pendingRequest ||
          !validTask(settled, task, "settled")
        )
          return;
        const ackPath = join(this.boot.protocolDir, "shutdown-ack.json");
        const ack = await json<ChildRecord>(ackPath);
        if (!ack) await publish(ackPath, record(task, "shutdown-ack"));
        else if (!validTask(ack, task, "shutdown-ack"))
          throw new Error("Invalid shutdown acknowledgement");
        this.dispose();
        this.host.shutdown();
        return;
      }
      if (this.active || !this.host.isIdle()) return;
      const accepted = await json<ChildRecord>(
        taskFile(this.boot.protocolDir, task.taskId, "accepted"),
      );
      if (accepted || settled) return; // immutable acceptance forbids uncertain prompt replay
      if (task.previousToken !== null) {
        // The previous task must really be settled. A token alone is not enough.
        let priorSettled = false;
        for (const name of (await readdir(this.boot.protocolDir)).filter((n) =>
          n.endsWith(".settled.json"),
        )) {
          const prior = await json<ChildRecord>(
            join(this.boot.protocolDir, name),
          );
          if (
            prior &&
            sameAgent(prior, task) &&
            prior.kind === "settled" &&
            prior.taskToken === task.previousToken
          )
            priorSettled = true;
        }
        if (!priorSettled) return;
      }
      await publish(
        taskFile(this.boot.protocolDir, task.taskId, "accepted"),
        record(task, "accepted"),
      );
      this.active = task;
      this.latest = undefined;
      this.host.sendPrompt(task.prompt);
    } finally {
      this.busy = false;
    }
  }
  agentEnd(messages: readonly unknown[]): void {
    this.latest = messages;
  }
  async agentSettled(): Promise<void> {
    if (!this.active || this.closed) return;
    const task = this.active;
    const current = await this.current();
    if (!current || !sameTask(current, task))
      throw new Error("Task changed during an active child run");
    const path = taskFile(this.boot.protocolDir, task.taskId, "settled");
    const previous = await json<ChildRecord>(path);
    if (!previous)
      await publish(path, record(task, "settled", settledResult(this.latest)));
    else if (!validTask(previous, task, "settled"))
      throw new Error("Conflicting settlement record");
    this.active = undefined;
  }
  async takeover(): Promise<void> {
    const task = await this.current();
    if (task && !(await json(join(this.boot.protocolDir, "takeover.json"))))
      await publish(
        join(this.boot.protocolDir, "takeover.json"),
        record(task, "takeover"),
      );
  }
  /** Ask the parent to execute a declared delegated tool for the active task and wait for its response. */
  async delegate(
    tool: string,
    params: unknown,
    toolCallId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const spec: DelegatedToolSpec | undefined =
      this.boot.policy.delegatedTools.find((d) => d.name === tool);
    const task = this.active;
    if (!spec || !task || this.pendingRequest)
      throw new Error(
        `${tool} is restricted to the active task (one request at a time)`,
      );
    const requestId =
      spec.once === "per-task"
        ? onceRequestId(task.taskToken, tool)
        : `${task.taskToken}-${tool}-${toolCallId}`;
    this.pendingRequest = requestId;
    try {
      const path = requestFile(this.boot.protocolDir, requestId, "request");
      const existing = await json<ChildRecord>(path);
      if (
        existing &&
        (!validTask(existing, task, "request") || existing.tool !== tool)
      )
        throw new Error(`${tool} request identity changed`);
      if (!existing)
        await publish(path, record(task, "request", { requestId, tool, params }));
      const deadline =
        Date.now() + (spec.timeoutMs ?? DEFAULT_DELEGATED_TIMEOUT_MS);
      while (!this.closed && !signal?.aborted && Date.now() < deadline) {
        const response = await json<ChildRecord>(
          requestFile(this.boot.protocolDir, requestId, "response"),
        );
        if (response) {
          if (
            !validTask(response, task, "response") ||
            response.requestId !== requestId ||
            response.tool !== tool
          )
            throw new Error(`Stale/invalid ${tool} response`);
          return response.result;
        }
        await new Promise<void>((r) => setTimeout(r, 25));
      }
      throw new Error(
        `${tool} outcome uncertain; the parent must reconcile the request, never blindly retry`,
      );
    } finally {
      this.pendingRequest = undefined;
    }
  }
  /** Record that the active task awaits a human answer (pending) or received it.
   * The parent observes this to move focus; the answer itself stays in the child session. */
  async question(
    questionId: string,
    question: string,
    answer?: string,
  ): Promise<void> {
    const task = this.active;
    if (!this.boot.policy.question || !task)
      throw new Error("question is not enabled for this child/task");
    await publish(
      join(this.boot.protocolDir, questionFile),
      record(task, answer === undefined ? "question" : "answer", {
        questionId,
        question,
        ...(answer === undefined ? {} : { answer }),
      }),
      false,
    );
  }
  dispose(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
  }
}
