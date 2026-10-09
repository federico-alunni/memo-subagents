import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MirrorManager } from "../pi-extension/subagents/runtime/mirror-manager.ts";
import type { MirrorSlot } from "../pi-extension/subagents/runtime/mirror-manager.ts";

const OWNER = { pid: 4242, identity: "Thu Oct  8 17:00:00 2026 pi" };

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

test("single shared column viewer is launched once for multiple slots; all slots point to the same mirror pane", async (t) => {
  const f = await fixture(t);
  const s1 = slot({ slotId: "s1", view: { ...slot().view, name: "w1" } });
  const s2 = slot({ slotId: "s2", view: { ...slot().view, name: "w2" } });

  await f.manager.sync([s1, s2]);
  assert.equal(f.fake.launched.length, 1, "exactly one viewer pane for the column");
  const spec = f.fake.launched[0];
  assert.equal(spec.placement, "auto");
  assert.equal(spec.viewer.script, "/pkg/runtime/mirror-viewer.ts");
  assert.match(spec.viewer.env.PI_MEMO_MIRROR_VIEW_FILE, /column-4242\.view\.json$/);
  assert.match(spec.display.label, /subagents/);

  // Both slots point to the same pane
  assert.equal(f.manager.paneFor("s1"), "mirror-pane-1");
  assert.equal(f.manager.paneFor("s2"), "mirror-pane-1");
  assert.equal(f.manager.paneId, "mirror-pane-1");

  // Read view file: contains both slots
  const viewFile = join(f.dir, "mirrors", `column-${OWNER.pid}.view.json`);
  const parsed = JSON.parse(await readFile(viewFile, "utf8"));
  assert.equal(parsed.slots.length, 2);
  assert.equal(parsed.slots[0].name, "w1");
  assert.equal(parsed.slots[1].name, "w2");
  assert.deepEqual(parsed.owner, OWNER);
});

test("adding or removing slots updates the shared view file without launching new panes", async (t) => {
  const f = await fixture(t);
  const s1 = slot({ slotId: "s1" });
  await f.manager.sync([s1]);
  assert.equal(f.fake.launched.length, 1);

  // Add s2: updates view file, no second launch
  const s2 = slot({ slotId: "s2" });
  await f.manager.sync([s1, s2]);
  assert.equal(f.fake.launched.length, 1);
  const parsed = JSON.parse(await readFile(join(f.dir, "mirrors", `column-${OWNER.pid}.view.json`), "utf8"));
  assert.equal(parsed.slots.length, 2);

  // Drop s1: only s2 remains, same viewer pane stays open
  await f.manager.sync([s2]);
  assert.equal(f.fake.launched.length, 1);
  assert.equal(f.manager.paneFor("s1"), undefined);
  assert.equal(f.manager.paneFor("s2"), "mirror-pane-1");
});

test("closing all slots stops and closes the column viewer pane", async (t) => {
  const f = await fixture(t);
  await f.manager.sync([slot()]);
  await f.manager.sync([]);
  assert.deepEqual(f.fake.calls.slice(1), ["stop:mirror-pane-1", "close:mirror-pane-1"]);
  assert.equal(f.manager.paneId, undefined);
  assert.deepEqual(await readdir(join(f.dir, "mirrors")), []);
});

test("reconcile cleans up orphaned mirror panes from dead owners", async (t) => {
  const f = await fixture(t);
  await f.manager.sync([slot()]);

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
  assert.deepEqual(other.calls, [], "owner alive: untouched");

  f.alive.delete(OWNER.identity);
  await second.reconcile();
  assert.deepEqual(other.calls, ["stop:mirror-pane-1", "close:mirror-pane-1"]);
  assert.deepEqual(await readdir(join(f.dir, "mirrors")), []);
});

test("two sessions of the same user never share or delete each other's mirror view", async (t) => {
  const f = await fixture(t);
  const other = new MirrorManager({
    runtime: fakeRuntime().runtime as any,
    stateDir: f.dir,
    viewerScript: "/pkg/runtime/mirror-viewer.ts",
    cwd: "/other/cwd",
    owner: { pid: 5353, identity: "other pi" },
    ownerAlive: async () => true,
  });
  await f.manager.sync([slot({ slotId: "mine" })]);
  await other.sync([slot({ slotId: "theirs", view: { ...slot().view, name: "theirs" } })]);
  const mine = JSON.parse(await readFile(join(f.dir, "mirrors", `column-${OWNER.pid}.view.json`), "utf8"));
  assert.deepEqual(mine.slots.map((s: any) => s.slotId), ["mine"]);
  await other.sync([]);
  const still = JSON.parse(await readFile(join(f.dir, "mirrors", `column-${OWNER.pid}.view.json`), "utf8"));
  assert.deepEqual(still.slots.map((s: any) => s.slotId), ["mine"]);
});
