import assert from "node:assert/strict";
import { test, describe, it } from "node:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startSessionSocket } from "../pi-extension/subagents/runtime/session-socket.ts";
import { SubagentClient } from "../pi-extension/subagents/client.ts";

describe("session socket & SubagentClient", () => {
  it("serves spawn, list, send, interrupt over unix socket with token auth", async () => {
    const calls: Array<{ method: string; args: any }> = [];
    const server = await startSessionSocket({
      async spawn(callerId, params) {
        calls.push({ method: "spawn", args: { callerId, params } });
        return { id: "sub-123", name: params.name };
      },
      async list(callerId) {
        calls.push({ method: "list", args: { callerId } });
        return [{ id: "sub-123", name: "test-agent" }];
      },
      async send(callerId, id, prompt, options) {
        calls.push({ method: "send", args: { callerId, id, prompt, options } });
        return { ok: true, taskId: "task-1" };
      },
      async interrupt(callerId, target) {
        calls.push({ method: "interrupt", args: { callerId, target } });
        return { ok: true, id: target.id };
      },
    });

    try {
      const client = new SubagentClient({
        socketPath: server.socketPath,
        token: server.token,
      });

      // 1. spawn
      const spawned = await client.spawn({ name: "worker-1", task: "build" });
      assert.deepEqual(spawned, { id: "sub-123", name: "worker-1" });
      assert.equal(calls[0].method, "spawn");
      assert.equal(calls[0].args.callerId, undefined);

      // 2. list
      const list = await client.list();
      assert.deepEqual(list, [{ id: "sub-123", name: "test-agent" }]);

      // 3. send
      await client.send("sub-123", "continue with step 2");
      assert.equal(calls[2].method, "send");
      assert.equal(calls[2].args.prompt, "continue with step 2");

      // 4. interrupt
      await client.interrupt({ id: "sub-123" });
      assert.equal(calls[3].method, "interrupt");
      assert.equal(calls[3].args.target.id, "sub-123");

      // 5. the session token may name a caller
      const childClient = new SubagentClient({
        socketPath: server.socketPath,
        token: server.token,
        callerId: "worker-parent-99",
      });
      await childClient.spawn({ name: "child-worker", task: "research" });
      assert.equal(calls[4].args.callerId, "worker-parent-99");

      // 6. an agent token makes the caller that agent, whatever callerId it sends
      const agentClient = new SubagentClient({ socketPath: server.socketPath, token: server.agentToken("agent-7") });
      await agentClient.spawn({ name: "grandchild", task: "x" });
      assert.equal(calls[5].args.callerId, "agent-7");
      await agentClient.send("sub-123", "hi");
      assert.equal(calls[6].args.callerId, "agent-7");
      const spoofing = new SubagentClient({ socketPath: server.socketPath, token: server.agentToken("agent-7"), callerId: "other" });
      await assert.rejects(() => spoofing.list(), /caller_mismatch/);
      const forged = new SubagentClient({ socketPath: server.socketPath, token: "agent-7.deadbeef" });
      await assert.rejects(() => forged.list(), /invalid_token/);

      // 7. Invalid token rejection
      const badClient = new SubagentClient({
        socketPath: server.socketPath,
        token: "wrong-token",
      });
      await assert.rejects(
        () => badClient.list(),
        /invalid_token/,
      );
    } finally {
      await server.close();
    }
  });

  it("throws when PI_SUBAGENT_SOCKET is missing", () => {
    const prev = process.env.PI_SUBAGENT_SOCKET;
    delete process.env.PI_SUBAGENT_SOCKET;
    try {
      assert.throws(() => new SubagentClient(), /No subagent socket available/);
    } finally {
      if (prev !== undefined) process.env.PI_SUBAGENT_SOCKET = prev;
    }
  });
});

describe("extra agent directories discovery", () => {
  it("loads agents from PI_SUBAGENT_AGENT_DIRS as extra sources", async () => {
    const testDir = join(tmpdir(), `pi-test-agents-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    writeFileSync(
      join(testDir, "convoy-custom.md"),
      `---
name: convoy-custom
description: Custom agent for convoy
model: custom-model
---
Custom agent system prompt.
`,
    );

    const prevDirs = process.env.PI_SUBAGENT_AGENT_DIRS;
    try {
      process.env.PI_SUBAGENT_AGENT_DIRS = testDir;
      const { __test__ } = await import("../pi-extension/subagents/index.ts");
      const definitions = __test__.discoverAgentDefinitions?.() ?? [];
      const found = definitions.find((d: any) => d.name === "convoy-custom");
      assert.ok(found, "convoy-custom should be discovered from extra agent dir");
      assert.equal(found.source, "extra");
      assert.equal(found.description, "Custom agent for convoy");
    } finally {
      if (prevDirs !== undefined) process.env.PI_SUBAGENT_AGENT_DIRS = prevDirs;
      else delete process.env.PI_SUBAGENT_AGENT_DIRS;
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
