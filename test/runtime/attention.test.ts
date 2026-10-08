import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import childExtension, {
  CHILD_ENV,
  HERDR_BLOCKED_EVENT,
  createAttentionTracker,
} from "../../pi-extension/subagents/runtime/child/extension.ts";
import {
  createSubagentActivityRecorder,
  readSubagentActivityFile,
  type SubagentAttention,
} from "../../pi-extension/subagents/activity.ts";
import { createHerdrReporter, HERDR_REPORT_SOURCE } from "../../pi-extension/subagents/runtime/child/herdr-reporter.ts";
import { presenceActive, type PresenceEntry } from "../../pi-extension/subagents/runtime/presence.ts";

test("attention tracker: overlapping waits are counted; kind defaults to question; since from the first", () => {
  const seen: (SubagentAttention | null)[] = [];
  let clock = 1_000;
  const track = createAttentionTracker((a) => seen.push(a), () => clock);
  track({ active: false }); // nothing open: ignored
  assert.deepEqual(seen, []);
  track({ active: true, label: "Push?" });
  clock = 2_000;
  track({ active: true, label: "npm run build", kind: "approval" });
  track({ active: false });
  track({ active: false });
  track({ active: false }); // extra release: ignored
  track({ active: true, kind: "custom" });
  assert.deepEqual(seen, [
    { kind: "question", label: "Push?", since: 1_000 },
    { kind: "approval", label: "npm run build", since: 1_000 },
    null,
    { kind: "blocked", since: 2_000 },
  ]);
});

test("activity attention: written immediately, latestEvent kept, cleared on null and on done; validated", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "memo-attention-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "activity.json");
  let clock = 10_000;
  const recorder = createSubagentActivityRecorder({ runningChildId: "c1", activityFile: file, now: () => clock });
  recorder.agentStart();
  clock += 10; // well inside the 500 ms throttle window
  recorder.messageUpdate("text_delta"); // throttled: not written yet
  recorder.attention({ kind: "question", label: "Push o\nmerge?", since: clock });
  let read = readSubagentActivityFile(file, "c1");
  assert.ok(read.ok);
  assert.deepEqual(read.activity.attention, { kind: "question", label: "Push o merge?", since: 10_010 });
  assert.equal(read.activity.latestEvent, "message_update");
  assert.equal(read.activity.phase, "active"); // no new phase
  recorder.attention(null);
  read = readSubagentActivityFile(file, "c1");
  assert.ok(read.ok);
  assert.equal(read.activity.attention, undefined);
  recorder.attention({ kind: "approval", since: clock });
  recorder.subagentDone();
  read = readSubagentActivityFile(file, "c1");
  assert.ok(read.ok);
  assert.equal(read.activity.attention, undefined);
  // Older files (no attention) stay valid; a malformed attention is not.
  const raw = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...raw, attention: { kind: "nope", since: 1 } }));
  assert.equal(readSubagentActivityFile(file, "c1").ok, false);
  await writeFile(file, JSON.stringify({ ...raw, attention: { kind: "approval" } }));
  assert.equal(readSubagentActivityFile(file, "c1").ok, false);
  delete raw.attention;
  await writeFile(file, JSON.stringify(raw));
  assert.equal(readSubagentActivityFile(file, "c1").ok, true);
});

test("child extension: herdr:blocked events reach activity.json at once", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "memo-attention-child-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const saved = Object.fromEntries(Object.values(CHILD_ENV).map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });
  // No `isolation`: never a Herdr reporter (the test may itself run inside Herdr).
  await writeFile(join(dir, "boot.json"), JSON.stringify({ policy: { tools: ["read"], bash: "readonly" } }));
  process.env[CHILD_ENV.protocolDir] = dir;
  process.env[CHILD_ENV.nonce] = "nonce-1";
  const bus = new Map<string, (data: unknown) => void>();
  childExtension({
    events: { on: (event: string, handler: (data: unknown) => void) => bus.set(event, handler), emit() {} },
    registerShortcut: () => {},
    registerTool: () => {},
    on: () => {},
  } as any);
  const blocked = bus.get(HERDR_BLOCKED_EVENT)!;
  blocked({ active: true, label: "Quale branch?" });
  let read = readSubagentActivityFile(join(dir, "activity.json"), "nonce-1");
  assert.ok(read.ok);
  assert.equal(read.activity.attention?.kind, "question");
  assert.equal(read.activity.attention?.label, "Quale branch?");
  blocked({ active: false });
  read = readSubagentActivityFile(join(dir, "activity.json"), "nonce-1");
  assert.ok(read.ok);
  assert.equal(read.activity.attention, undefined);
});

function fakeExec() {
  const calls: string[][] = [];
  const gates: (() => void)[] = [];
  let hold = false;
  return {
    calls,
    hold(value: boolean) {
      hold = value;
    },
    release() {
      for (const open of gates.splice(0)) open();
    },
    exec: async (bin: string, args: string[]) => {
      calls.push([bin, ...args]);
      if (hold) await new Promise<void>((r) => gates.push(r));
    },
  };
}

const HERDR_ENV = { HERDR_ENV: "1", HERDR_PANE_ID: "w:p9", HERDR_BIN_PATH: "/opt/herdr" };

test("Herdr reporter: only for isolated children inside Herdr", () => {
  const { exec } = fakeExec();
  assert.equal(createHerdrReporter({ isolation: "profile", env: HERDR_ENV, exec }), undefined);
  assert.equal(createHerdrReporter({ isolation: undefined, env: HERDR_ENV, exec }), undefined);
  assert.equal(createHerdrReporter({ isolation: "isolated", env: { ...HERDR_ENV, HERDR_ENV: "0" }, exec }), undefined);
  assert.equal(createHerdrReporter({ isolation: "isolated", env: { HERDR_ENV: "1" }, exec }), undefined);
  assert.ok(createHerdrReporter({ isolation: "isolated", env: HERDR_ENV, exec }));
});

test("Herdr reporter: working/idle/blocked, only the latest state, growing seq, errors ignored, release", async () => {
  const fake = fakeExec();
  const reporter = createHerdrReporter({ isolation: "isolated", env: HERDR_ENV, exec: fake.exec, now: () => 5 })!;
  const id = ["--source", HERDR_REPORT_SOURCE, "--agent", "pi"];
  fake.hold(true);
  reporter.agentActive(true); // sent at once, held in flight
  reporter.attention({ label: "rm -rf\ndist" }); // superseded while queued
  reporter.attention(undefined);
  reporter.agentActive(true); // same state as queued: nothing new
  reporter.agentActive(false);
  reporter.agentActive(false);
  fake.hold(false);
  fake.release();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(fake.calls, [
    ["/opt/herdr", "pane", "report-agent", "w:p9", ...id, "--state", "working", "--seq", "5001"],
    ["/opt/herdr", "pane", "report-agent", "w:p9", ...id, "--state", "idle", "--seq", "5004"],
  ]);
  reporter.attention({ label: "rm -rf\ndist" });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(fake.calls[2], ["/opt/herdr", "pane", "report-agent", "w:p9", ...id, "--state", "blocked", "--message=rm -rf dist", "--seq", "5005"]);
  await reporter.release();
  assert.deepEqual(fake.calls[3], ["/opt/herdr", "pane", "release-agent", "w:p9", ...id, "--seq", "5006"]);
  // A failing Herdr never throws; the default binary is `herdr`.
  const failing = createHerdrReporter({
    isolation: "isolated",
    env: { HERDR_ENV: "1", HERDR_PANE_ID: "p" },
    exec: async (bin) => {
      assert.equal(bin, "herdr");
      throw new Error("down");
    },
  })!;
  failing.agentActive(true);
  await failing.release();
});

test("presenceActive: a row waiting for the user is never active, even when annotated active", () => {
  const row: PresenceEntry = { key: "k", label: "l", model: "p/m", thinking: "low", startedAt: 0, state: "active", updatedAt: 0 };
  assert.equal(presenceActive(row), true);
  assert.equal(presenceActive({ ...row, attention: { kind: "question", since: 1 } }), false);
  assert.equal(presenceActive({ ...row, active: true, attention: { kind: "approval", since: 1 } }), false);
  assert.equal(presenceActive({ ...row, active: true }), true);
  assert.equal(presenceActive({ ...row, state: "settled" }), false);
});
