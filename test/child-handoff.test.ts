import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import childExtension, { CHILD_ENV, childDelegateHook } from "../pi-extension/subagents/runtime/child/extension.ts";
import { ChildRuntime } from "../pi-extension/subagents/runtime/child/runtime.ts";
import {
  json,
  publish,
  record,
  taskFile,
  policyTools,
  validPolicy,
} from "../pi-extension/subagents/runtime/protocol.ts";
import type { Boot, ChildRecord } from "../pi-extension/subagents/runtime/protocol.ts";

const HANDOFF_SPEC = {
  name: "subagent_handoff",
  description: "Internal handoff transport.",
  parameters: { type: "object" },
  internal: true as const,
};

test("internal delegated tools are valid policy but never active, visible model tools", () => {
  const policy = {
    tools: ["read"],
    denyTools: [],
    bash: "unrestricted",
    bashAllow: [],
    bashAsk: false,
    question: false,
    askParent: false,
    delegatedTools: [HANDOFF_SPEC],
    userInput: "takeover",
    exit: "parent",
  };
  assert.ok(validPolicy(policy));
  assert.deepEqual(policyTools(policy), []);
});

test("the child extension registers no model tool for an internal spec", async (t) => {
  const dir = await realpathSync(await mkdtemp(join(tmpdir(), "memo-handoff-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const policy = {
    tools: ["read"],
    denyTools: [],
    bash: "unrestricted",
    bashAllow: [],
    bashAsk: false,
    question: false,
    askParent: false,
    delegatedTools: [HANDOFF_SPEC],
    userInput: "takeover",
    exit: "parent",
  };
  await writeFile(join(dir, "boot.json"), JSON.stringify({ policy }));
  const previous = process.env[CHILD_ENV.protocolDir];
  process.env[CHILD_ENV.protocolDir] = dir;
  try {
    const registered: string[] = [];
    const api = {
      events: { on: () => {} },
      registerTool: (tool: { name: string }) => registered.push(tool.name),
      on: () => {},
    } as any;
    childExtension(api);
    assert.deepEqual(registered, []);
  } finally {
    if (previous === undefined) delete process.env[CHILD_ENV.protocolDir];
    else process.env[CHILD_ENV.protocolDir] = previous;
  }
});

test("the hook delegates only internal specs of the active task and awaits the parent response", async (t) => {
  // Without an active task the hook refuses.
  const idleFixture = await childFixture(t);
  const idleHook = childDelegateHook(idleFixture.runtime, new Set(["subagent_handoff"]));
  assert.ok(idleHook);
  await assert.rejects(idleHook.request("other_tool", {}), /not an internal delegated tool/);
  await assert.rejects(idleHook.request("subagent_handoff", {}), /restricted to the active task/);

  // With the accepted task running, the parent answers the published request.
  const { dir, runtime } = await childFixture(t, { active: true });
  const hook = childDelegateHook(runtime, new Set(["subagent_handoff"]));
  assert.ok(hook);
  const answered = (async () => {
    for (;;) {
      for (const request of await drainRequests(dir)) {
        await publish(
          join(dir, `${sha(request.requestId!)}.response.json`),
          record(request, "response", { requestId: request.requestId, tool: request.tool, result: { launched: true } }),
        );
        return;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  })();
  assert.deepEqual(await hook.request("subagent_handoff", { mode: "wait" }), { launched: true });
  await answered;
});

test("holdAutoExit keeps an auto child open through the next settled run; without it, it ends", async (t) => {
  const held = await childFixture(t, { exit: "auto", active: true });
  const hook = childDelegateHook(held.runtime, new Set(["subagent_handoff"]));
  held.runtime.agentEnd([{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "handing off" }] }]);
  hook.holdAutoExit();
  await held.runtime.agentSettled();
  assert.ok(!held.exited, "the child waits for the handed-off result");
  held.runtime.agentEnd([{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "resumed work done" }] }]);
  await held.runtime.agentSettled();
  assert.ok(held.exited, "the hold covers exactly one settlement");

  const plain = await childFixture(t, { exit: "auto", active: true });
  plain.runtime.agentEnd([{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }]);
  await plain.runtime.agentSettled();
  assert.ok(plain.exited);
});

test("end(\"replace\") publishes the exit record and shuts the child down", async (t) => {
  const { dir, runtime } = await childFixture(t);
  const hook = childDelegateHook(runtime, new Set(["subagent_handoff"]));
  await hook.end("replace", { summary: "work continues in the reviewer" });
  const exit = await json<ChildRecord>(join(dir, "exit.json"));
  assert.ok(exit);
  assert.equal(exit!.reason, "done");
  assert.equal(exit!.summary, "work continues in the reviewer");
  assert.ok(await json<ChildRecord>(join(dir, "shutdown-ack.json")));
});

/** A real ChildRuntime over a temp protocol dir; `active` accepts the task before the hook is used. */
async function childFixture(
  t: { after(fn: () => unknown): void },
  extra: { exit?: "auto" | "tool" | "parent"; active?: boolean } = {},
) {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "memo-handoff-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const policy = {
    tools: ["read"],
    denyTools: [],
    bash: "unrestricted",
    bashAllow: [],
    bashAsk: false,
    question: false,
    askParent: false,
    delegatedTools: [HANDOFF_SPEC],
    userInput: "takeover",
    exit: extra.exit ?? "tool",
  };
  const sessions = join(dir, "sessions");
  await mkdir(sessions);
  const boot: Boot = {
    scope: "s", agentId: "a", attempt: 1, nonce: "n", sessionId: "sid", paneId: "p",
    cwd: dir, protocolDir: dir, model: "p/m", effort: "low", policy,
  } as Boot;
  await publish(join(dir, "boot.json"), boot, false);
  const task = {
    scope: boot.scope, agentId: boot.agentId, attempt: boot.attempt, nonce: boot.nonce,
    sessionId: boot.sessionId, paneId: boot.paneId,
    kind: "task" as const, taskId: "task-1", taskToken: "tok-1", prompt: "work", previousToken: null,
  };
  await publish(join(dir, "task.json"), task, false);
  const state = { exited: false };
  let idle = true;
  const runtime = new ChildRuntime(boot, {
    sessionId: "sid",
    sessionPath: join(sessions, "sid.jsonl"),
    cwd: dir,
    pid: process.pid,
    model: "p/m",
    effort: "low",
    isIdle: () => idle,
    sendPrompt: () => (idle = false),
    abort: () => {},
    shutdown: () => (state.exited = true),
  });
  if (extra.active) {
    await runtime.start(false);
    await runtime.tick(); // accepts the task and starts it
  }
  return { dir, boot, runtime, get exited() { return state.exited; } };
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

async function drainRequests(dir: string): Promise<ChildRecord[]> {
  const out: ChildRecord[] = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".request.json")) continue;
    const parsed = await json<ChildRecord>(join(dir, name));
    if (parsed?.kind === "request") out.push(parsed);
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
