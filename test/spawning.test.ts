import { describe, it, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import { paletteTheme, stripAnsi, visibleWidth } from "../pi-extension/subagents/runtime/mirror-view.ts";

const testApi = (subagentsModule as any).__test__;

const running = { kind: "running" as const, startedAt: 5_000, confirmedAt: 5_000 };
const agent = (id: string, patch: any = {}, turn: any = { kind: "active", startedAt: 60_000, source: "herdr" }) => ({
  id, name: id, task: "", surface: `pane-${id}`, startTime: 5_000, sessionFile: id, interactive: false,
  handle: { cwd: `/repo/${id}`, taskId: "task-1" },
  lifecycle: { ...createLifecycle(5_000), process: running, hasWorked: true, turn },
  ...patch,
});

describe("spawning: parameters", () => {
  it("spawning grants delegated spawns; spawningDepth needs spawning and is 1..4", () => {
    assert.equal(testApi.validateSpawningParams({}), undefined);
    assert.equal(testApi.validateSpawningParams({ spawning: true }), undefined);
    assert.equal(testApi.validateSpawningParams({ spawning: true, spawningDepth: 2 }), undefined);
    assert.match(testApi.validateSpawningParams({ spawningDepth: 2 }), /requires spawning: true/);
    for (const depth of [0, 5, 1.5, -1])
      assert.match(testApi.validateSpawningParams({ spawning: true, spawningDepth: depth }), /integer between 1 and 4/);
  });
});

describe("spawning: child side", () => {
  it("handoff inside a worktree space, delegate when the child may spawn, local otherwise", () => {
    assert.equal(testApi.childSpawnMode({ handoff: "wait" }, { PI_SUBAGENT_ID: "x", PI_SUBAGENT_WORKTREE_SPACE: "1" }), "wait");
    assert.equal(testApi.childSpawnMode({ handoff: "replace" }, { PI_SUBAGENT_ID: "x", PI_SUBAGENT_WORKTREE_SPACE: "1" }), "replace");
    assert.equal(testApi.childSpawnMode({}, { PI_SUBAGENT_ID: "x", PI_SUBAGENT_SPAWNING: "1" }), "delegate");
    assert.equal(testApi.childSpawnMode({}, { PI_SUBAGENT_ID: "x" }), undefined);
    assert.equal(testApi.childSpawnMode({}, {}), undefined, "the main session spawns locally");
    // A spawning grant without a subagent identity (the main session's own env) never delegates.
    assert.equal(testApi.childSpawnMode({}, { PI_SUBAGENT_SPAWNING: "1" }), undefined);
  });
});

describe("spawning: main side authorization", () => {
  const planner = agent("planner", { spawning: { depth: 2 } });

  it("delegate: allowed with a spawning grant; cwd defaults to the requester's, relative cwd resolved against it", () => {
    const ok = testApi.authorizeSpawn(planner, { mode: "delegate", spawn: { name: "research", task: "look", thinking: "low" } });
    assert.equal(ok.error, undefined);
    assert.equal(ok.params.cwd, "/repo/planner");
    assert.equal(ok.childSpawning, undefined, "no grant unless asked");
    const rel = testApi.authorizeSpawn(planner, { mode: "delegate", spawn: { name: "r", task: "t", cwd: "sub/dir" } });
    assert.equal(rel.params.cwd, "/repo/planner/sub/dir");
    const abs = testApi.authorizeSpawn(planner, { mode: "delegate", spawn: { name: "r", task: "t", cwd: "/elsewhere" } });
    assert.equal(abs.params.cwd, "/elsewhere");
  });

  it("delegate: a child grant costs one level; an exhausted depth is refused", () => {
    const challenger = testApi.authorizeSpawn(planner, { mode: "delegate", spawn: { name: "c", task: "t", spawning: true } });
    assert.deepEqual(challenger.childSpawning, { depth: 1 });
    const leaf = agent("c", { spawning: { depth: 1 } });
    assert.match(testApi.authorizeSpawn(leaf, { mode: "delegate", spawn: { name: "r", task: "t", spawning: true } }).error, /no spawning depth left/);
    assert.equal(testApi.authorizeSpawn(leaf, { mode: "delegate", spawn: { name: "r", task: "t" } }).error, undefined);
  });

  it("delegate: refused without a grant, for forks and handoff parameters; bad requests refused", () => {
    assert.match(testApi.authorizeSpawn(agent("x"), { mode: "delegate", spawn: { name: "r", task: "t" } }).error, /not allowed to start sub-agents/);
    assert.match(testApi.authorizeSpawn(planner, { mode: "delegate", spawn: { name: "r", task: "t", fork: true } }).error, /fork/);
    assert.match(testApi.authorizeSpawn(planner, { mode: "delegate", spawn: { name: "r", task: "t", handoff: "wait" } }).error, /handoff/);
    assert.match(testApi.authorizeSpawn(planner, { mode: "delegate", spawn: { task: "t" } }).error, /name and a task/);
    assert.match(testApi.authorizeSpawn(planner, { mode: "launch", spawn: { name: "r", task: "t" } }).error, /Unknown spawn mode/);
  });

  it("wait/replace: only for worktree-space agents, in their own checkout", () => {
    const worker = agent("w", { slot: { id: "s" }, worktree: { cwd: "/wt/w", branch: "memo/w" } });
    const ok = testApi.authorizeSpawn(worker, { mode: "wait", spawn: { name: "r", task: "t", cwd: "/elsewhere" } });
    assert.equal(ok.error, undefined);
    assert.equal(ok.params.cwd, "/wt/w");
    assert.match(testApi.authorizeSpawn(planner, { mode: "replace", spawn: { name: "r", task: "t" } }).error, /worktree space/);
  });
});

describe("spawning: column", () => {
  it("members are the root and its living descendants in start order", () => {
    const planner = agent("planner", { startTime: 1, column: { rootId: "planner" } });
    const research = agent("research", { startTime: 2, column: { rootId: "planner" } });
    const challenger = agent("challenger", { startTime: 3, column: { rootId: "planner" } });
    const other = agent("other", { startTime: 4 });
    assert.deepEqual(testApi.columnPanes("planner", [challenger, other, research, planner]), ["pane-planner", "pane-research", "pane-challenger"]);
    // A requester outside any column starts one rooted at itself.
    assert.equal(testApi.columnRootOf(agent("solo")), "solo");
    assert.equal(testApi.columnRootOf(challenger), "planner");
  });
});

describe("spawning: one transport for every request", () => {
  it("subagent_spawn requests are served once, other tools ignored, failures answered", async () => {
    const launched: any[] = [];
    const responses: any[] = [];
    const serve = testApi.createSpawnServer({
      launch: async (_parent: any, request: any) => {
        launched.push(request);
        if (request.spawn.name === "boom") throw new Error("no pane");
        return { id: request.spawn.name };
      },
      runtime: { hasResponse: async () => false, respond: async (_h: any, id: string, result: any) => { responses.push([id, result]); } },
    });
    const seen = new Set<string>();
    const parent = { id: "planner", handle: {} };
    const requests = [
      { requestId: "a", tool: "subagent_spawn", params: { mode: "delegate", spawn: { name: "research" } } },
      { requestId: "b", tool: "subagent_spawn", params: { mode: "delegate", spawn: { name: "boom" } } },
      { requestId: "c", tool: "ir_integrate", params: {} },
    ];
    await serve(parent, requests, seen);
    await serve(parent, requests, seen);
    assert.equal(launched.length, 2);
    assert.deepEqual(responses, [["a", { launched: true, id: "research" }], ["b", { error: "no pane" }]]);
  });
});

describe("spawning: panel rows", () => {
  it("delegated agents render as panel rows: icon by state, name, status, requester", () => {
    const planner = agent("planner", { startTime: 1 }, { kind: "blocked", startedAt: 60_000, reason: "question" });
    const research = agent("research", { startTime: 2, spawnedBy: { mode: "delegate", parentId: "planner" } });
    const originalNow = Date.now;
    Date.now = () => 65_000;
    try {
      const data = testApi.agentRowsPanelData([planner, research]);
      assert.equal(data.total, undefined);
      assert.deepEqual(data.rows.map((r: any) => [r.icon, r.label]), [["?", "planner"], ["◐", "research"]]);
      assert.match(data.rows[1].extra, /↳ planner/);
      const theme = paletteTheme({});
      const lines = testApi.renderPanel(data, 96, theme);
      for (const line of lines) assert.equal(visibleWidth(stripAnsi(line)), 96);
      assert.match(stripAnsi(lines[0]), /^╭─ ⧉  Subagents ─+╮$/, "no progress bar without a total");
      assert.match(stripAnsi(lines[1]), /^│ \? planner/);
    } finally {
      Date.now = originalNow;
    }
  });
});

test("a subagent keeps its parent's session socket (its scripts act as this agent there)", async () => {
  const { inheritsParentSocket } = subagentsModule as any;
  const dir = mkdtempSync(join(tmpdir(), "inherit-sock-"));
  const sock = join(dir, "s.sock");
  writeFileSync(sock, "");
  const child = { PI_SUBAGENT_ID: "abc", PI_SUBAGENT_SOCKET: sock, PI_SUBAGENT_SOCKET_TOKEN: "abc.mac" };
  assert.equal(inheritsParentSocket(child), true);
  // The main session (no agent id), a session token, or a vanished socket: start an own socket.
  assert.equal(inheritsParentSocket({ ...child, PI_SUBAGENT_ID: undefined }), false);
  assert.equal(inheritsParentSocket({ ...child, PI_SUBAGENT_SOCKET_TOKEN: "sessiontoken" }), false);
  assert.equal(inheritsParentSocket({ ...child, PI_SUBAGENT_SOCKET: join(dir, "gone.sock") }), false);
  rmSync(dir, { recursive: true, force: true });
});

test("frontmatter `spawning: true` grants delegated spawning by default; the parameter wins", () => {
  const { spawningGrant } = subagentsModule as any;
  assert.deepEqual(spawningGrant({}, { spawning: true }), { depth: 2 });
  assert.deepEqual(spawningGrant({}, { spawning: true, spawningDepth: 3 }), { depth: 3 });
  assert.deepEqual(spawningGrant({ spawning: true, spawningDepth: 1 }, null), { depth: 1 });
  assert.equal(spawningGrant({ spawning: false }, { spawning: true }), undefined);
  assert.equal(spawningGrant({}, { spawning: false }), undefined);
  assert.equal(spawningGrant({}, null), undefined);
});
