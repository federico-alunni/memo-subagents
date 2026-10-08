import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MirrorManager } from "../pi-extension/subagents/runtime/mirror-manager.ts";
import type { MirrorSlot } from "../pi-extension/subagents/runtime/mirror-manager.ts";

const OWNER = { pid: 4242, identity: "Thu Oct  8 17:00:00 2026 pi" };

/** A runtime double: records launch/stop/close and hands out stable handles. */
function fakeRuntime() {
  const calls: string[] = [];
  const launched: any[] = [];
  const state = { failClose: 0, failLaunch: false };
  let next = 1;
  return {
    calls,
    launched,
    state,
    runtime: {
      async launch(spec: any) {
        calls.push(`launch:${spec.agentId}`);
        launched.push(spec);
        if (state.failLaunch) throw new Error("no pane");
        const n = next++;
        return { agentId: spec.agentId, paneId: `mirror-pane-${n}`, protocolDir: `/state/${spec.agentId}`, workspaceId: "w1" } as any;
      },
      async stop(h: any) { calls.push(`stop:${h.paneId}`); },
      async close(h: any) {
        calls.push(`close:${h.paneId}`);
        if (state.failClose > 0) { state.failClose--; throw new Error("not proven"); }
      },
    },
  };
}

async function fixture(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), "memo-mirrors-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = fakeRuntime();
  const alive = new Set<string>([OWNER.identity]);
  const manager = new MirrorManager({
    runtime: fake.runtime as any,
    stateDir: dir,
    viewerScript: "/pkg/runtime/mirror-viewer.ts",
    cwd: "/main/cwd",
    owner: OWNER,
    ownerAlive: async (owner) => alive.has(owner.identity),
    now: () => 1_000,
  });
  return { dir, fake, manager, alive };
}

const slot = (patch: Partial<MirrorSlot> = {}): MirrorSlot => ({
  slotId: "slot-1",
  view: { version: 1, paneId: "w2:p1", name: "fix-lock", agent: "worker", branch: "memo/fix-lock-1a", startedAt: 0, status: "active" },
  ...patch,
});

const views = async (dir: string) =>
  Promise.all(
    (await readdir(join(dir, "mirrors"))).filter((n) => n.endsWith(".view.json")).map(async (n) => JSON.parse(await readFile(join(dir, "mirrors", n), "utf8"))),
  );

test("a slot gets one viewer, launched once however often it is synced; the view carries the owner", async (t) => {
  const f = await fixture(t);
  await Promise.all([f.manager.sync([slot()]), f.manager.sync([slot()])]);
  await f.manager.sync([slot()]);
  assert.deepEqual(f.fake.calls, ["launch:" + f.fake.launched[0].agentId]);
  const spec = f.fake.launched[0];
  assert.equal(spec.scope, "mirror");
  assert.equal(spec.cwd, "/main/cwd");
  assert.equal(spec.placement, "auto");
  assert.equal(spec.prompt, "");
  assert.equal(spec.viewer.script, "/pkg/runtime/mirror-viewer.ts");
  assert.match(spec.viewer.env.PI_MEMO_MIRROR_VIEW_FILE, /mirrors\/slot-1\.view\.json$/);
  assert.equal(spec.display.label, "⧉ fix-lock");
  assert.equal(f.manager.paneFor("slot-1"), "mirror-pane-1");
  const [view] = await views(f.dir);
  assert.equal(view.paneId, "w2:p1");
  assert.deepEqual(view.owner, OWNER);
});

test("the view follows the active agent; unchanged views are not rewritten", async (t) => {
  const f = await fixture(t);
  await f.manager.sync([slot()]);
  const file = join(f.dir, "mirrors", "slot-1.view.json");
  const first = await readFile(file, "utf8");
  await writeFile(file, first + " "); // a sentinel: an unchanged sync must not touch the file
  await f.manager.sync([slot()]);
  assert.equal(await readFile(file, "utf8"), first + " ");
  // The slot's active agent changes (handoff): same mirror, new pane and agent.
  await f.manager.sync([slot({ view: { ...slot().view, paneId: "w2:p7", agent: "reviewer", startedAt: 500 } })]);
  const view = JSON.parse(await readFile(file, "utf8"));
  assert.equal(view.paneId, "w2:p7");
  assert.equal(view.agent, "reviewer");
  assert.equal(f.fake.launched.length, 1, "no second viewer");
});

test("a slot that is gone closes its viewer through stop and close, and forgets the record", async (t) => {
  const f = await fixture(t);
  await f.manager.sync([slot()]);
  await f.manager.sync([]);
  assert.deepEqual(f.fake.calls.slice(1), ["stop:mirror-pane-1", "close:mirror-pane-1"]);
  assert.equal(f.manager.paneFor("slot-1"), undefined);
  assert.deepEqual(await readdir(join(f.dir, "mirrors")), []);
});

test("closing is retried while the end is not proven, then the pane is left to the user", async (t) => {
  const f = await fixture(t);
  await f.manager.sync([slot()]);
  f.fake.state.failClose = 2;
  await f.manager.sync([]);
  assert.equal(f.manager.paneFor("slot-1"), "mirror-pane-1", "still ours while not proven closed");
  await f.manager.sync([]);
  await f.manager.sync([]);
  assert.equal(f.fake.calls.filter((c) => c.startsWith("close:")).length, 3);
  assert.equal(f.manager.paneFor("slot-1"), undefined);
});

test("a failed launch is retried on the next sync, never leaves a half-open record", async (t) => {
  const f = await fixture(t);
  f.fake.state.failLaunch = true;
  await f.manager.sync([slot()]);
  assert.equal(f.manager.paneFor("slot-1"), undefined);
  f.fake.state.failLaunch = false;
  await f.manager.sync([slot()]);
  assert.equal(f.manager.paneFor("slot-1"), "mirror-pane-1");
  assert.notEqual(f.fake.launched[0].agentId, f.fake.launched[1].agentId, "every attempt has its own identity");
});

test("orphans: a record whose owner is gone is closed by whoever finds it; a live owner's is never touched", async (t) => {
  const f = await fixture(t);
  await f.manager.sync([slot()]);
  // Another process (new session) starts with the same state directory.
  const other = fakeRuntime();
  const second = new MirrorManager({
    runtime: other.runtime as any,
    stateDir: f.dir,
    viewerScript: "/pkg/runtime/mirror-viewer.ts",
    cwd: "/main/cwd",
    owner: { pid: 99, identity: "other" },
    ownerAlive: async (owner) => f.alive.has(owner.identity),
    now: () => 2_000,
  });
  await second.reconcile();
  assert.deepEqual(other.calls, [], "the first owner is alive: hands off");
  f.alive.delete(OWNER.identity);
  await second.reconcile();
  assert.deepEqual(other.calls, ["stop:mirror-pane-1", "close:mirror-pane-1"]);
  assert.deepEqual(await readdir(join(f.dir, "mirrors")), []);
});

test("closeAll (session quit) closes every viewer this process owns", async (t) => {
  const f = await fixture(t);
  await f.manager.sync([slot(), slot({ slotId: "slot-2", view: { ...slot().view, name: "other" } })]);
  await f.manager.closeAll();
  assert.equal(f.fake.calls.filter((c) => c.startsWith("close:")).length, 2);
});
