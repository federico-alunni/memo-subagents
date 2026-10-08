import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";
import * as subagentsModule from "../pi-extension/subagents/index.ts";

const testApi = (subagentsModule as any).__test__;

describe("worktree-space mirror: parameters", () => {
  it("worktreeSpace requires worktree and is rejected with handoff or surface placements", () => {
    assert.equal(
      testApi.validateWorktreeParams({ worktree: true, worktreeSpace: true }),
      undefined,
    );
    assert.match(
      testApi.validateWorktreeParams({ worktreeSpace: true } as any),
      /requires worktree/,
    );
    assert.match(
      testApi.validateWorktreeParams({ worktree: true, worktreeSpace: true, handoff: "wait" } as any),
      /only available from a subagent that runs in a worktree space.*cannot be combined with worktreeSpace/,
    );
    assert.match(
      testApi.validateWorktreeParams({ worktree: true, worktreeSpace: true, fork: true } as any),
      /cannot be combined/,
    );
    assert.equal(testApi.validateWorktreeParams({ worktree: true }), undefined);
    assert.equal(testApi.validateWorktreeParams({}), undefined);
  });

  it("handoff is a wait/replace mode validated before anything is created", () => {
    assert.match(testApi.validateHandoffParams("wait" as any), /only available from a subagent that runs in a worktree space/);
    assert.match(testApi.validateHandoffParams(undefined as any), /only available from a subagent that runs in a worktree space/);
    assert.equal(testApi.validateHandoffParams(undefined as any, { worktreeSpace: true }), undefined);
    assert.equal(testApi.validateHandoffParams("wait", { worktreeSpace: true }), undefined);
    assert.equal(testApi.validateHandoffParams("replace", { worktreeSpace: true }), undefined);
    assert.match(testApi.validateHandoffParams("wai" as any, { worktreeSpace: true }), /wait.*replace/);
  });
});

describe("worktree-space mirror: widget slot rows", () => {
  const running = { kind: "running" as const, startedAt: 5_000, confirmedAt: 5_000 };
  const agent = (id: string, turn: any, patch: any = {}) => ({
    id, name: id, task: "", surface: `s-${id}`, startTime: 5_000, sessionFile: id, interactive: false,
    lifecycle: { ...createLifecycle(5_000), process: running, hasWorked: true, turn },
    ...patch,
  });
  const active = { kind: "active" as const, startedAt: 60_000, source: "herdr" as const };

  it("a slot renders one row: mirror marker, chain of names, agent tag on the oldest living member", () => {
    const originalNow = Date.now;
    Date.now = () => 65_000;
    try {
      const slot = { id: "slot-1", name: "fix-lock", startTime: 5_000, chain: ["fix-lock", "reviewer"], worktree: { branch: "memo/fix-lock-1a2b" } };
      // wait: A (oldest, alive) waits for B (active, newer)
      const a = agent("fix-lock", { kind: "waiting", startedAt: 60_000 }, { agent: "worker", slot });
      const b = agent("reviewer", active, { agent: "reviewer", slot, startTime: 60_000 });
      const lines = testApi.renderSubagentWidgetLines([a, b], 100);
      assert.equal(lines.filter((line: string) => /fix-lock/.test(line)).length, 1, "one row per slot");
      const row = lines.find((line: string) => line.includes("fix-lock"));
      assert.match(row, /⧉ fix-lock \(worker\) › reviewer/);
      assert.match(row, /waiting › reviewer 5s/);
      assert.match(row, /⎇ memo\/fix-lock-1a2b/);
      assert.match(row, /▶? ?01:00 /, "the row shows the slot's own elapsed time");
      assert.match(lines[0], /1 active/, "the slot is counted once, by its active member");
      // replace: the root member ended, only the successor remains
      const taken = testApi.renderSubagentWidgetLines([agent("reviewer", active, { agent: "reviewer", slot, startTime: 60_000 })], 100);
      assert.match(taken[1], /⧉ fix-lock › reviewer \(reviewer\)/);
      assert.match(taken[0], /1 active/);
    } finally {
      Date.now = originalNow;
    }
  });

  it("members of different slots render one row each; other agents are unchanged", () => {
    const originalNow = Date.now;
    Date.now = () => 65_000;
    try {
      const slotA = { id: "a", name: "one", startTime: 5_000, chain: ["one"], worktree: { branch: "memo/a" } };
      const slotB = { id: "b", name: "two", startTime: 6_000, chain: ["two"], worktree: { branch: "memo/b" } };
      const lines = testApi.renderSubagentWidgetLines([
        agent("one", active, { slot: slotA }),
        agent("two", active, { slot: slotB }),
        agent("plain", active),
      ], 100);
      assert.match(lines[0], /3 active/);
      assert.ok(lines.some((line: string) => /⧉ one/.test(line)));
      assert.ok(lines.some((line: string) => /⧉ two/.test(line)));
      assert.ok(lines.some((line: string) => /  plain/.test(line) && !/⧉/.test(line)));
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("worktree-space mirror: handoff routing", () => {
  it("a wait result is dispatched to the parent agent as its next task", async () => {
    const dispatched: any[] = [];
    const runtime = {
      dispatch: async (h: any, task: any) => (dispatched.push([h, task]), { ...h, taskId: task.taskId, taskToken: "t2" }),
    };
    const parent = { id: "a", handle: { taskId: "t1" } as any };
    await testApi.deliverHandoffResult(runtime, parent, { name: "reviewer", task: "", summary: "looks good", exitCode: 0, elapsed: 90, sessionFile: "/s" }, "reviewer");
    assert.equal(dispatched.length, 1);
    assert.match(dispatched[0][1].prompt, /Sub-agent "reviewer" completed/);
    assert.match(dispatched[0][1].prompt, /looks good/);
    assert.notEqual(dispatched[0][1].taskId, "t1");
    assert.equal(parent.handle.taskId, dispatched[0][1].taskId, "the parent's handle is replaced by the new task's");
  });

  it("a busy parent is retried until its previous task has settled", async () => {
    let attempts = 0;
    const runtime = {
      dispatch: async (h: any, task: any) => {
        if (++attempts < 3) throw Object.assign(new Error("not settled"), { code: "busy", name: "RuntimeError" });
        return { ...h, taskId: task.taskId };
      },
    };
    const parent = { id: "a", handle: { taskId: "t1" } as any };
    await testApi.deliverHandoffResult(runtime, parent, { name: "r", task: "", summary: "x", exitCode: 0, elapsed: 1 }, "r", { retryMs: 1 });
    assert.equal(attempts, 3);
  });

  it("a replace result is delivered to the main session with the chain; the replaced parent's own delivery is suppressed", () => {
    const messages: any[] = [];
    const pi = { sendMessage: (m: any) => messages.push(m) };
    testApi.deliverReplacedResult(pi, {
      slot: { id: "s", name: "fix-lock", chain: ["fix-lock", "reviewer"] },
      result: { name: "reviewer", task: "t", summary: "all merged", exitCode: 0, elapsed: 120, sessionFile: "/s" },
      parentSummary: "work handed off",
    });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].customType, "subagent_result");
    assert.match(messages[0].content, /fix-lock › reviewer/);
    assert.match(messages[0].content, /all merged/);
    assert.match(messages[0].content, /work handed off/);
    assert.deepEqual(messages[0].details.chain, ["fix-lock", "reviewer"]);
    assert.equal(testApi.shouldSuppressDelivery({ slot: { id: "s" }, replacedBy: "reviewer" }), true);
    assert.equal(testApi.shouldSuppressDelivery({ slot: { id: "s" } }), false);
    assert.equal(testApi.shouldSuppressDelivery({}), false);
  });

  it("handoff requests of a slot member are served exactly once (requestId dedup)", async () => {
    const launched: any[] = [];
    const responses: any[] = [];
    const serve = testApi.createSpawnServer({
      launch: async (_parent: any, params: any) => (launched.push(params), { id: "b" }),
      runtime: { hasResponse: async () => false, respond: async (_h: any, id: string, result: any) => { responses.push([id, result]); } },
    });
    const parent = { id: "a", handle: { protocolDir: "/p", taskId: "t1", taskToken: "k1" } };
    const seen = new Set(["req-1"]); // served before a /reload
    const requests = [
      { requestId: "req-1", tool: "subagent_spawn", params: { mode: "wait", name: "reviewer" } },
      { requestId: "req-2", tool: "subagent_spawn", params: { mode: "replace", name: "reviewer" } },
      { requestId: "req-3", tool: "other_tool", params: {} },
    ];
    await serve(parent, requests, seen);
    await serve(parent, requests, seen);
    assert.deepEqual(launched.map((p: any) => p.mode), ["replace"]);
    assert.deepEqual(responses, [["req-2", { launched: true, id: "b" }]]);
  });

  it("a failing launch answers the request with the error instead of leaving the child waiting", async () => {
    const responses: any[] = [];
    const serve = testApi.createSpawnServer({
      launch: async () => { throw new Error("no worktree space"); },
      runtime: { hasResponse: async () => false, respond: async (_h: any, _id: string, result: any) => { responses.push(result); } },
    });
    await serve({ id: "a", handle: {} }, [{ requestId: "r", tool: "subagent_spawn", params: {} }], new Set());
    assert.deepEqual(responses, [{ error: "no worktree space" }]);
  });
});

describe("worktree-space mirror: selector", () => {
  const running = { kind: "running" as const, startedAt: 5_000, confirmedAt: 5_000 };
  const member = (id: string, slot: any, surface: string, startTime: number) => ({
    id, name: id, task: "", surface, startTime, sessionFile: id, interactive: false, slot,
    lifecycle: { ...createLifecycle(startTime), process: running, hasWorked: true, turn: { kind: "active", startedAt: 1, source: "herdr" } },
  });

  it("one menu entry per slot, pointing at the mirror pane, whatever the chain length", () => {
    const slot = { id: "s1", name: "fix-lock", startTime: 1, chain: ["fix-lock", "reviewer"] };
    const a = member("fix-lock", slot, "w2:p1", 1);
    const b = member("reviewer", slot, "w2:p2", 2);
    const plain = member("plain", undefined, "w1:p9", 3);
    const choices = testApi.slotSelectorChoices([a, b, plain], (id: string) => (id === "s1" ? "w1:mirror" : undefined));
    assert.deepEqual(choices.map((c: any) => [c.paneId, c.name, !!c.slot]), [
      ["w1:mirror", "fix-lock", true],
      ["w1:p9", "plain", false],
    ]);
    assert.match(choices[0].label, /^⧉ fix-lock › reviewer · /);
    // No mirror pane yet (it is being opened, or the column is full): the slot is not selectable.
    assert.deepEqual(testApi.slotSelectorChoices([a, b], () => undefined), []);
  });

  it("choosing a slot whose mirror is already visible promotes its active agent with an agent focus", () => {
    const calls: string[][] = [];
    const slot = { id: "s1", name: "fix-lock", startTime: 1, chain: ["fix-lock", "reviewer"] };
    const a = member("fix-lock", slot, "w2:p1", 1);
    const b = member("reviewer", slot, "w2:p2", 2);
    const result = testApi.promoteSlot([a, b], "s1", (args: string[]) => { calls.push(args); });
    assert.equal(result, "w2:p2", "the newest living member is the active agent");
    assert.deepEqual(calls, [["agent", "focus", "w2:p2"]]);
    assert.equal(testApi.promoteSlot([], "s1", () => { throw new Error("never"); }), undefined);
  });

  it("without a detected agent in the pane, promotion goes to its workspace and tab", () => {
    const calls: string[][] = [];
    const slot = { id: "s1", name: "fix-lock", startTime: 1, chain: ["fix-lock"] };
    const a = member("fix-lock", slot, "w2:p1", 1);
    const herdr = (args: string[]) => {
      calls.push(args);
      if (args[0] === "agent") throw new Error("agent_not_found");
      if (args[0] === "pane") return { pane: { workspace_id: "w2", tab_id: "w2:t1" } };
    };
    assert.equal(testApi.promoteSlot([a], "s1", herdr), "w2:p1");
    assert.deepEqual(calls, [
      ["agent", "focus", "w2:p1"],
      ["pane", "get", "w2:p1"],
      ["workspace", "focus", "w2"],
      ["tab", "focus", "w2:t1"],
    ]);
    // A pane that is gone is an error, not a silent no-op.
    assert.throws(() => testApi.promoteSlot([a], "s1", (args: string[]) => { if (args[0] === "agent" || args[0] === "pane") throw new Error("gone"); }));
  });
});
