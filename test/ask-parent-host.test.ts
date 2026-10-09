import test from "node:test";
import assert from "node:assert/strict";
import { AskParentHost, createEscalate, requestMessage } from "../pi-extension/subagents/ask-parent-host.ts";
import type { AskHostOptions, EscalationRequest } from "../pi-extension/subagents/ask-parent-host.ts";
import type { AskRequest, AskResult } from "../pi-extension/subagents/runtime/ask-parent.ts";
import type { AgentHandle, PendingAsk } from "../pi-extension/subagents/runtime/index.ts";

const handle = (id: string) => ({ protocolDir: `/dir/${id}`, agentId: id }) as unknown as AgentHandle;
const QUESTION: AskRequest = {
  kind: "question",
  childId: "a1",
  childName: "Scout",
  text: "Quale base?",
  options: [{ label: "main (Recommended)", description: "stable" }, { label: "dev" }],
};
const APPROVAL: AskRequest = {
  kind: "approval",
  childId: "a1",
  childName: "Scout",
  text: "npm run build",
  command: "npm run build",
  prefix: "npm run",
};

/** In-memory runtime: requests per child, markers, exclusive answers, liveness records. */
function fakeRuntime() {
  const requests = new Map<string, { requestId: string; request: AskRequest; at: string }[]>();
  const answers = new Map<string, AskResult>();
  const received = new Set<string>();
  const escalated = new Map<string, unknown>();
  const beats: { dir: string; closed?: boolean }[] = [];
  return {
    answers,
    received,
    escalated,
    beats,
    add(child: string, requestId: string, request: AskRequest) {
      const list = requests.get(child) ?? [];
      list.push({ requestId, request, at: new Date().toISOString() });
      requests.set(child, list);
    },
    async pendingAsks(h: AgentHandle): Promise<PendingAsk[]> {
      return (requests.get(h.agentId) ?? [])
        .filter((r) => !answers.has(r.requestId))
        .map((r) => ({ ...r, received: received.has(r.requestId) }));
    },
    async markAsk(_h: AgentHandle, requestId: string, mark: any) {
      if (answers.has(requestId)) throw new Error("busy");
      if (mark.kind === "received") {
        if (received.has(requestId)) return false;
        received.add(requestId);
        return true;
      }
      escalated.set(requestId, mark.escalation);
      return true;
    },
    async answerAsk(_h: AgentHandle, requestId: string, result: AskResult) {
      if (answers.has(requestId)) throw new Error("Ask-parent request already answered");
      answers.set(requestId, result);
    },
    async askHeartbeat(h: AgentHandle, beat: { closed?: boolean }) {
      beats.push({ dir: h.protocolDir, ...(beat.closed ? { closed: true } : {}) });
    },
  };
}

function setup(overrides: Partial<AskHostOptions> = {}) {
  const runtime = fakeRuntime();
  const notified: { content: string; details: any }[] = [];
  const escalations: EscalationRequest[] = [];
  let resolveEscalation: (result: AskResult) => void = () => {};
  let clock = 1_000;
  const children = [{ id: "a1", name: "Scout", handle: handle("a1") }];
  const host = new AskParentHost({
    runtime,
    children: () => children,
    self: () => ({ name: "main agent", id: "session-1" }),
    notify: (message) => notified.push(message),
    escalationTarget: () => "user",
    escalate: (request) => {
      escalations.push(request);
      return new Promise((resolve) => (resolveEscalation = resolve));
    },
    timeoutMs: 60_000,
    now: () => clock,
    ...overrides,
  });
  return {
    runtime,
    notified,
    escalations,
    children,
    host,
    resolve: (result: AskResult) => resolveEscalation(result),
    advance: (ms: number) => (clock += ms),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("each pending request is picked up once and delivered to the parent agent with how to answer", async () => {
  const s = setup();
  s.runtime.add("a1", "r1", QUESTION);
  await s.host.tick();
  await s.host.tick();
  assert.equal(s.notified.length, 1);
  assert.ok(s.runtime.received.has("r1"));
  const { content, details } = s.notified[0];
  for (const part of ['Subagent "Scout"', "Quale base?", "1. main (Recommended) — stable", "2. dev", "requestId r1", 'id: "a1"', "subagent_answer", "escalate: true", "60s", "the user"])
    assert.ok(content.includes(part), part);
  assert.deepEqual(
    { id: details.id, name: details.name, kind: details.kind, requestId: details.requestId, text: details.text },
    { id: "a1", name: "Scout", kind: "question", requestId: "r1", text: "Quale base?" },
  );
  // Liveness record for the child (refreshed periodically, not on every tick).
  assert.deepEqual(s.runtime.beats, [{ dir: "/dir/a1" }]);
  s.advance(2_000);
  await s.host.tick();
  assert.equal(s.runtime.beats.length, 2);
  const approval = requestMessage({ id: "a1", name: "Scout" }, "r2", APPROVAL, 30_000, "parent");
  assert.match(approval.content, /npm run build/);
  assert.match(approval.content, /decision: "once" \| "deny"/);
  assert.match(approval.content, /Only the user can allow it always/);
  assert.match(approval.content, /your own parent agent/);
  assert.match(approval.content, /30s/);
  assert.equal(approval.details.command, "npm run build");
});

test("subagent_answer: a question answer is delivered once with the parent as answerer; repeats are refused", async () => {
  const s = setup();
  s.runtime.add("a1", "r1", QUESTION);
  await s.host.tick();
  assert.equal((await s.host.answer({ id: "a1", requestId: "r1", decision: "once" })).ok, false);
  assert.equal((await s.host.answer({ id: "a1", requestId: "r1", answer: "  " })).ok, false);
  const first = await s.host.answer({ id: "a1", requestId: "r1", answer: "dev", note: "use dev for now" });
  assert.equal(first.ok, true);
  assert.deepEqual(s.runtime.answers.get("r1"), {
    answer: "dev",
    note: "use dev for now",
    by: { who: "parent", name: "main agent", id: "session-1" },
  });
  const repeated = await s.host.answer({ id: "a1", requestId: "r1", answer: "main" });
  assert.equal(repeated.ok, false);
  assert.equal((s.runtime.answers.get("r1") as any).answer, "dev");
  assert.equal((await s.host.answer({ id: "other", requestId: "r1", answer: "x" })).ok, false);
  assert.equal((await s.host.answer({ id: "a1", requestId: "stale", answer: "x" })).ok, false);
});

test("subagent_answer: approvals take deny/once; 'always' is never applied by the parent, it escalates to the user", async () => {
  const s = setup();
  s.runtime.add("a1", "r1", APPROVAL);
  s.runtime.add("a1", "r2", APPROVAL);
  s.runtime.add("a1", "r3", APPROVAL);
  await s.host.tick();
  assert.equal(s.notified.length, 3);
  assert.equal((await s.host.answer({ id: "a1", requestId: "r1", answer: "yes" })).ok, false);
  assert.equal((await s.host.answer({ id: "a1", requestId: "r1", decision: "sure" })).ok, false);
  assert.equal((await s.host.answer({ id: "a1", requestId: "r1", decision: "once" })).ok, true);
  assert.equal((s.runtime.answers.get("r1") as any).decision, "once");
  assert.equal((await s.host.answer({ id: "a1", requestId: "r2", decision: "deny", note: "no builds" })).ok, true);
  assert.deepEqual(s.runtime.answers.get("r2"), { decision: "deny", note: "no builds", by: { who: "parent", name: "main agent", id: "session-1" } });
  const always = await s.host.answer({ id: "a1", requestId: "r3", decision: "always" });
  assert.equal(always.ok, true);
  assert.match(always.text, /Only the user can allow a command always/);
  await flush();
  assert.equal(s.runtime.answers.has("r3"), false); // never applied from the parent
  assert.equal(s.escalations.length, 1);
  assert.equal(s.escalations[0].reason, "always");
  assert.deepEqual(s.runtime.escalated.get("r3"), { target: "user", reason: "always" });
  // Escalated: the parent agent cannot answer it any more; the user's answer is delivered.
  assert.equal((await s.host.answer({ id: "a1", requestId: "r3", decision: "once" })).ok, false);
  s.resolve({ decision: "always", by: { who: "user", where: "parent-session", reason: "always" } });
  await flush();
  await flush();
  assert.deepEqual(s.runtime.answers.get("r3"), { decision: "always", by: { who: "user", where: "parent-session", reason: "always" } });
});

test("escalate: true and the timeout hand the request to the user; the timeout is configurable", async () => {
  const s = setup({ timeoutMs: 5_000 });
  s.runtime.add("a1", "r1", QUESTION);
  s.runtime.add("a1", "r2", QUESTION);
  await s.host.tick();
  assert.equal((await s.host.answer({ id: "a1", requestId: "r1", escalate: true })).ok, true);
  await flush();
  assert.equal(s.escalations.length, 1);
  assert.equal(s.escalations[0].reason, "escalated");
  s.advance(4_999);
  await s.host.tick();
  assert.equal(s.escalations.length, 1);
  s.advance(1);
  await s.host.tick();
  await flush();
  assert.equal(s.escalations.length, 2);
  assert.equal(s.escalations[1].requestId, "r2");
  assert.equal(s.escalations[1].reason, "timeout");
  assert.deepEqual(s.runtime.escalated.get("r2"), { target: "user", reason: "timeout" });
  assert.deepEqual(s.host.pending().map((p) => p.escalated), ["escalated", "timeout"]);
});

test("withdrawn requests (child asked in its pane, aborted, or ended) cancel their escalation", async () => {
  const s = setup({ timeoutMs: 10 });
  s.runtime.add("a1", "r1", QUESTION);
  await s.host.tick();
  s.advance(10);
  await s.host.tick();
  await flush();
  assert.equal(s.escalations.length, 1);
  // The child claimed the response slot (fallback) while the user had not answered yet.
  s.runtime.answers.set("r1", { fallback: true, reason: "withdrawn" });
  await s.host.tick();
  assert.equal(s.escalations[0].signal.aborted, true);
  assert.deepEqual(s.host.pending(), []);
  // A child that is no longer running drops its requests too.
  s.runtime.add("a1", "r2", APPROVAL);
  await s.host.tick();
  s.children.length = 0;
  await s.host.tick();
  assert.deepEqual(s.host.pending(), []);
});

test("a reloaded parent sends requests picked up by its previous instance back to the child's pane", async () => {
  const s = setup();
  s.runtime.add("a1", "r1", QUESTION);
  s.runtime.received.add("r1");
  await s.host.tick();
  assert.equal(s.notified.length, 0);
  assert.deepEqual(s.runtime.answers.get("r1"), { fallback: true, reason: "the parent agent was reloaded" });
});

test("shutdown: pending requests fall back to the child's pane and the liveness record is closed", async () => {
  const s = setup();
  s.runtime.add("a1", "r1", QUESTION);
  await s.host.tick();
  await s.host.shutdown();
  assert.deepEqual(s.runtime.answers.get("r1"), { fallback: true, reason: "the parent agent session ended" });
  assert.deepEqual(s.runtime.beats.at(-1), { dir: "/dir/a1", closed: true });
  // Nothing is picked up any more.
  s.runtime.add("a1", "r2", QUESTION);
  await s.host.tick();
  assert.equal(s.notified.length, 1);
});

test("nested agent: escalations go to its own parent first (marker target parent)", async () => {
  const s = setup({ escalationTarget: () => "parent" });
  s.runtime.add("a1", "r1", { ...APPROVAL, origin: ["Grandchild"] });
  await s.host.tick();
  assert.match(s.notified[0].content, /Subagent "Scout › Grandchild" \(forwarded by your subagent "Scout"\)/);
  assert.match(s.notified[0].content, /your own parent agent/);
  await s.host.answer({ id: "a1", requestId: "r1", escalate: true });
  await flush();
  assert.deepEqual(s.runtime.escalated.get("r1"), { target: "parent", reason: "escalated" });
  // The upstream parent was unavailable: the user of this session is asked instead.
  s.escalations[0].setTarget("user");
  await flush();
  assert.deepEqual(s.runtime.escalated.get("r1"), { target: "user", reason: "escalated" });
});

function escalationRequest(request: AskRequest, overrides: Partial<EscalationRequest> = {}): EscalationRequest & { targets: string[] } {
  const targets: string[] = [];
  return {
    child: { id: "a1", name: request.childName, handle: handle("a1") },
    requestId: "r1",
    request,
    reason: "timeout",
    signal: new AbortController().signal,
    setTarget: (target) => targets.push(target),
    targets,
    ...overrides,
  };
}

test("escalation in a nested agent goes one level up, never to its user, and records the relay", async () => {
  const forwarded: any[] = [];
  let userAsked = 0;
  const escalate = createEscalate({
    upstream: () => ({
      name: "Scout",
      forward: async (request) => {
        forwarded.push(request);
        return { kind: "answered", requestId: "up-1", result: { decision: "once", by: { who: "parent", name: "main agent" } } };
      },
    }),
    askUser: async () => {
      userAsked++;
      return undefined;
    },
    self: () => ({ name: "Scout", id: "a1" }),
  });
  const result = await escalate(escalationRequest({ ...APPROVAL, childName: "Grandchild", origin: ["Great"] }));
  assert.equal(userAsked, 0);
  assert.deepEqual(forwarded, [
    { kind: "approval", text: "npm run build", command: "npm run build", prefix: "npm run", origin: ["Grandchild", "Great"] },
  ]);
  assert.deepEqual(result, { decision: "once", by: { who: "parent", name: "main agent", forwardedBy: ["Scout"] } });
});

test("escalation: the upstream parent cannot be asked → the user of this session; top level → the user", async () => {
  const asked: any[] = [];
  const escalate = createEscalate({
    upstream: () => ({ name: "Scout", forward: async () => ({ kind: "fallback", reason: "the parent agent is not available" }) }),
    askUser: async (entry) => {
      asked.push(entry);
      return { kind: "question", answer: { answer: "dev", custom: false, index: 2, note: "for now" } };
    },
    self: () => ({ name: "Scout", id: "a1" }),
  });
  const request = escalationRequest(QUESTION);
  assert.deepEqual(await escalate(request), {
    answer: "dev",
    note: "for now",
    by: { who: "user", where: "parent-session", reason: "timeout", name: "Scout", id: "a1" },
  });
  assert.deepEqual(request.targets, ["user"]);
  assert.equal(asked[0].request, QUESTION);
  const top = createEscalate({
    upstream: () => undefined,
    askUser: async () => ({ kind: "approval", decision: "always" }),
    self: () => ({ name: "main agent", id: "s" }),
  });
  assert.deepEqual(await top(escalationRequest(APPROVAL, { reason: "always" })), {
    decision: "always",
    by: { who: "user", where: "parent-session", reason: "always", name: "main agent", id: "s" },
  });
  // Free answer, cancel, and no UI (the child asks in its own pane).
  const free = createEscalate({ upstream: () => undefined, askUser: async () => ({ kind: "question", answer: { answer: "other", custom: true } }), self: () => ({ name: "m", id: "" }) });
  assert.deepEqual(await free(escalationRequest(QUESTION)), { answer: "other", custom: true, by: { who: "user", where: "parent-session", reason: "timeout", name: "m" } });
  const cancel = createEscalate({ upstream: () => undefined, askUser: async () => ({ kind: "question", answer: null }), self: () => ({ name: "m", id: "" }) });
  assert.equal(((await cancel(escalationRequest(QUESTION))) as any).answer, null);
  const noUi = createEscalate({ upstream: () => undefined, askUser: async () => undefined, self: () => ({ name: "m", id: "" }) });
  assert.equal(((await noUi(escalationRequest(QUESTION))) as any).fallback, true);
});
