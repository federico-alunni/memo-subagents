import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  answeredByText,
  askBlockedLabel,
  askParentTimeoutMs,
  parentState,
  questionAnswerFrom,
  validAskRequest,
  validAskResult,
} from "../../pi-extension/subagents/runtime/ask-parent.ts";
import type { AskOutcome } from "../../pi-extension/subagents/runtime/ask-parent.ts";
import {
  BASH_ASK_OPTIONS,
  applyApprovalDecision,
  createBashApprovals,
} from "../../pi-extension/subagents/runtime/child/bash-policy.ts";
import type { BashParentRoute, HerdrBlockedEvent, ParentApproval } from "../../pi-extension/subagents/runtime/child/bash-policy.ts";
import {
  QUESTION_ROUTER_KEY,
  createQuestionRouter,
  setQuestionRouter,
} from "../../pi-extension/subagents/runtime/child/question-router.ts";
import childExtension, { CHILD_ENV, createAttentionTracker } from "../../pi-extension/subagents/runtime/child/extension.ts";
import { createSubagentActivityRecorder, readSubagentActivityFile } from "../../pi-extension/subagents/activity.ts";
import { normalizePolicy, validPolicy } from "../../pi-extension/subagents/runtime/protocol.ts";

const ASK = { bash: "readonly" as const, bashAllow: ["npm test"], bashAsk: true };

test("timeout: PI_MEMO_SUBAGENTS_ASK_PARENT_TIMEOUT_MS, default 60 s, invalid values fall back", () => {
  assert.equal(askParentTimeoutMs({}), 60000);
  assert.equal(askParentTimeoutMs({ PI_MEMO_SUBAGENTS_ASK_PARENT_TIMEOUT_MS: "1500" }), 1500);
  for (const bad of ["", "0", "-5", "1.5", "abc", "9".repeat(30)])
    assert.equal(askParentTimeoutMs({ PI_MEMO_SUBAGENTS_ASK_PARENT_TIMEOUT_MS: bad }), 60000, bad);
});

test("policy: askParent defaults to false for old boot records and needs a user-driven child", () => {
  const old = normalizePolicy({ tools: null, bash: "readonly", bashAsk: true, question: false, delegatedTools: [], userInput: "allowed" });
  assert.equal(old?.askParent, false);
  assert.ok(validPolicy(old));
  assert.ok(validPolicy({ ...old!, askParent: true }));
  assert.equal(validPolicy({ ...old!, askParent: true, bashAsk: false, bash: "unrestricted", userInput: "takeover" }), false);
  assert.equal(validPolicy({ ...old!, askParent: "yes" as unknown as boolean }), false);
});

test("answers: option label or number selects, anything else is free; who answered is spelled out", () => {
  const options = [{ label: "main (Recommended)" }, { label: "dev" }];
  assert.deepEqual(questionAnswerFrom({ answer: "dev" }, options), { answer: "dev", custom: false, index: 2 });
  assert.deepEqual(questionAnswerFrom({ answer: " 1 ", note: "ok" }, options), { answer: "main (Recommended)", custom: false, index: 1, note: "ok" });
  assert.deepEqual(questionAnswerFrom({ answer: "3" }, options), { answer: "3", custom: true });
  assert.deepEqual(questionAnswerFrom({ answer: "dev", custom: true }, options), { answer: "dev", custom: true });
  assert.equal(questionAnswerFrom({ answer: null }, options), null);
  assert.equal(questionAnswerFrom({ answer: "  " }, options), null);
  assert.equal(answeredByText({ who: "parent", name: "main agent", id: "s1" }), 'answered by the parent agent "main agent" (s1)');
  assert.match(answeredByText({ who: "parent", name: "Scout", forwardedBy: ["Mid"] }), /relayed by "Mid"/);
  assert.match(
    answeredByText({ who: "user", where: "parent-session", reason: "timeout", name: "main agent" }),
    /user in the session of "main agent" \(the parent agent did not answer in time\)/,
  );
  assert.match(answeredByText({ who: "user", where: "parent-session", reason: "always" }), /only the user can allow a command always/);
  assert.match(answeredByText({ who: "user", where: "parent-session", reason: "escalated" }), /escalated by the parent agent/);
  assert.match(answeredByText({ who: "user", where: "child-pane", reason: "parent-unavailable" }), /in this pane/);
  assert.equal(askBlockedLabel("parent", "Quale\nbase?"), "→ parent · Quale base?");
});

test("records: requests and answers from the other side are validated", () => {
  assert.equal(validAskRequest({ kind: "other", childId: "a", childName: "A", text: "x" }), undefined);
  assert.equal(validAskRequest({ kind: "question", childId: "a", childName: "A", text: "x" }), undefined);
  assert.equal(validAskRequest({ kind: "approval", childId: "a", childName: "A", text: "x", command: "x" }), undefined);
  assert.deepEqual(
    validAskRequest({ kind: "question", childId: "a", childName: "A", text: "x", options: [{ label: "y", extra: 1 }], junk: 1 }),
    { kind: "question", childId: "a", childName: "A", text: "x", options: [{ label: "y" }] },
  );
  assert.equal(validAskResult({ answer: "x" }), undefined); // no answerer
  assert.equal(validAskResult({ decision: "sometimes", by: { who: "parent" } }), undefined);
  assert.deepEqual(validAskResult({ fallback: true, reason: "r", withdrawn: true }), { fallback: true, reason: "r" });
  assert.ok(validAskResult({ decision: "once", by: { who: "parent" } }));
});

test("parent liveness: unknown without a record, gone when closed, stale or its process is dead", () => {
  const beat = { version: 1 as const, pid: 42, at: 10_000, name: "m", id: "s" };
  assert.equal(parentState(undefined, 10_000), "unknown");
  assert.equal(parentState(beat, 11_000, () => true), "alive");
  assert.equal(parentState({ ...beat, closed: true }, 11_000, () => true), "gone");
  assert.equal(parentState(beat, 17_000, () => true), "gone");
  assert.equal(parentState(beat, 11_000, () => false), "gone");
});

// ── Bash approvals through the parent ──

function route(answers: (ParentApproval | Error)[], enabled = true) {
  const calls: { command: string; prefix: string }[] = [];
  let active = 0;
  let maxActive = 0;
  const r: BashParentRoute & { calls: typeof calls; maxActive: () => number } = {
    calls,
    maxActive: () => maxActive,
    enabled: () => enabled,
    async ask(command, prefix, _signal, onTarget) {
      calls.push({ command, prefix });
      active++;
      maxActive = Math.max(maxActive, active);
      onTarget("parent");
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      const next = answers.shift()!;
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return r;
}
const PARENT = { who: "parent" as const, name: "main agent", id: "s1" };
const USER = { who: "user" as const, where: "parent-session" as const, reason: "always" as const, name: "main agent" };
const noUi = {
  hasUI: false,
  ui: {
    select: async (): Promise<string | undefined> => {
      throw new Error("must not ask in the pane");
    },
  },
};

test("approvals go to the parent first: once passes this call only, deny blocks, with an audit line", async () => {
  const r = route([
    { kind: "decision", decision: "once", by: PARENT, note: "just this time" },
    { kind: "decision", decision: "deny", by: PARENT },
  ]);
  const events: HerdrBlockedEvent[] = [];
  const approvals = createBashApprovals((e) => events.push(e), r);
  const audit: string[] = [];
  assert.equal(await approvals.check(ASK, "npm run build", noUi, (line) => audit.push(line)), undefined);
  assert.match(audit[0], /allowed once \(answered by the parent agent "main agent" \(s1\)\)\. Note: just this time/);
  const denied = await approvals.check(ASK, "npm run build", noUi);
  assert.match(denied?.reason ?? "", /refused \(answered by the parent agent "main agent"/);
  assert.deepEqual(r.calls, [
    { command: "npm run build", prefix: "npm run" },
    { command: "npm run build", prefix: "npm run" },
  ]);
  assert.deepEqual(approvals.prefixes(), []);
  // The wait is bracketed and labelled with its target, for the widget and Herdr.
  assert.deepEqual(events.slice(0, 2), [
    { active: true, label: "→ parent · npm run build", kind: "approval", target: "parent" },
    { active: false },
  ]);
});

test("invariants: blocked commands are never routed, a parent 'always' is never applied, every decision is re-checked", async () => {
  const r = route([
    { kind: "decision", decision: "always", by: PARENT },
    { kind: "decision", decision: "always", by: USER },
  ]);
  const approvals = createBashApprovals(() => {}, r);
  // Shell grammar and policy blocks never reach the parent.
  for (const command of ["npm run build | tee x", "rm -rf $HOME", "echo 'x'"])
    assert.equal((await approvals.check(ASK, command, noUi))?.block, true, command);
  assert.equal(r.calls.length, 0);
  // Read-only and bash-allow commands never need the parent.
  assert.equal(await approvals.check(ASK, "npm test", noUi), undefined);
  assert.equal(r.calls.length, 0);
  const parentAlways = await approvals.check(ASK, "npm run build", noUi);
  assert.match(parentAlways?.reason ?? "", /only the user can allow a command always/);
  assert.deepEqual(approvals.prefixes(), []);
  assert.equal(await approvals.check(ASK, "npm run build", noUi), undefined);
  assert.deepEqual(approvals.prefixes(), ["npm run"]);
  assert.equal(await approvals.check(ASK, "npm run lint", noUi), undefined); // covered by the user's "always"
  assert.equal(r.calls.length, 2);
  // A decision for a command the policy blocks or does not ask about is ignored.
  const prefixes: string[] = [];
  for (const [policy, command] of [
    [ASK, "npm run build && rm -rf /"],
    [{ ...ASK, bashAsk: false }, "npm run build"],
    [ASK, "cat $(whoami)"],
  ] as const)
    for (const decision of ["once", "always"] as const)
      assert.equal(
        applyApprovalDecision(policy, command, prefixes, { decision, by: USER }).block?.block,
        true,
        `${command} ${decision}`,
      );
  assert.deepEqual(prefixes, []);
  assert.equal(applyApprovalDecision(ASK, "make", prefixes, { decision: "cancel", by: PARENT }).block?.block, true);
  assert.equal(applyApprovalDecision(ASK, "make", prefixes, { decision: "once", by: PARENT }).block, undefined);
});

test("approvals stay serialized one at a time, also through the parent", async () => {
  const r = route([
    { kind: "decision", decision: "once", by: PARENT },
    { kind: "decision", decision: "once", by: PARENT },
    { kind: "decision", decision: "once", by: PARENT },
  ]);
  const approvals = createBashApprovals(() => {}, r);
  const results = await Promise.all(["make a", "make b", "make c"].map((c) => approvals.check(ASK, c, noUi)));
  assert.deepEqual(results, [undefined, undefined, undefined]);
  assert.equal(r.maxActive(), 1);
});

test("fallback: the parent cannot be asked → today's question in the child pane, recorded as a pane answer", async () => {
  const r = route([{ kind: "fallback", reason: "the parent agent is not available" }, new Error("boom"), { kind: "cancelled" }]);
  const asked: string[] = [];
  const ui = {
    hasUI: true,
    ui: {
      select: async (title: string, options: string[]) => {
        asked.push(title);
        assert.deepEqual(options, [BASH_ASK_OPTIONS.deny, BASH_ASK_OPTIONS.once, BASH_ASK_OPTIONS.always]);
        return asked.length === 1 ? BASH_ASK_OPTIONS.once : BASH_ASK_OPTIONS.deny;
      },
    },
  };
  const events: HerdrBlockedEvent[] = [];
  const approvals = createBashApprovals((e) => events.push(e), r);
  const audit: string[] = [];
  assert.equal(await approvals.check(ASK, "npm run build", ui, (line) => audit.push(line)), undefined);
  assert.match(
    audit[0],
    /allowed once \(answered by the user in this pane; the parent agent could not answer: the parent agent is not available\)/,
  );
  assert.ok(events.some((e) => e.active && e.target === "user"));
  const refused = await approvals.check(ASK, "npm run build", ui);
  assert.match(refused?.reason ?? "", /The user refused this bash command \(answered by the user in this pane; .*boom\)/);
  // Cancelled upstream (aborted turn): blocked without asking here.
  assert.match((await approvals.check(ASK, "npm run build", ui))?.reason ?? "", /cancelled/);
  assert.equal(asked.length, 2);
});

test("opt-out: with ask-parent off the approval is exactly today's question in the pane", async () => {
  const r = route([], false);
  const events: HerdrBlockedEvent[] = [];
  const approvals = createBashApprovals((e) => events.push(e), r);
  const audit: string[] = [];
  const ui = { hasUI: true, ui: { select: async () => BASH_ASK_OPTIONS.always } };
  assert.equal(await approvals.check(ASK, "npm run build", ui, (line) => audit.push(line)), undefined);
  assert.equal(r.calls.length, 0);
  assert.deepEqual(audit, []);
  assert.deepEqual(events, [{ active: true, label: "npm run build", kind: "approval" }, { active: false }]);
  assert.deepEqual(approvals.prefixes(), ["npm run"]);
  // No UI and no parent: blocked, as before.
  assert.equal((await createBashApprovals(() => {}, r).check(ASK, "make", noUi))?.block, true);
});

// ── The question tool through the parent: pi-memo-question's router hook ──

function routerHarness(outcome: AskOutcome, opts: { enabled?: boolean; parentByDefault?: boolean } = {}) {
  const emitted: HerdrBlockedEvent[] = [];
  const asks: unknown[][] = [];
  const router = createQuestionRouter({
    enabled: () => opts.enabled ?? true,
    parentByDefault: () => opts.parentByDefault ?? false,
    ask: async (question, options, _signal, onTarget) => {
      asks.push([question, options]);
      onTarget("parent");
      return outcome;
    },
    emitBlocked: (event) => emitted.push(event),
  });
  const q = { id: "q1", question: "Quale base?", options: [{ label: "main (Recommended)" }, { label: "dev" }] };
  return { router, emitted, asks, run: () => router.askParent(q, undefined) };
}

test("question router: the parent's answer becomes pi-memo-question's answer, with who answered", async () => {
  const h = routerHarness({
    kind: "answered",
    requestId: "r1",
    result: { answer: "1", note: "safer", by: { who: "parent", name: "main agent", id: "s1" } },
  });
  const outcome = await h.run();
  assert.deepEqual(h.asks, [["Quale base?", [{ label: "main (Recommended)" }, { label: "dev" }]]]);
  assert.deepEqual(outcome, {
    kind: "answered",
    answer: { answer: "main (Recommended)", custom: false, index: 1, note: "safer" },
    by: "the parent agent",
    note: "safer",
    details: {
      answeredBy: { who: "parent", name: "main agent", id: "s1" },
      answeredByText: 'answered by the parent agent "main agent" (s1)',
      requestId: "r1",
    },
  });
  // The wait is visible with its target, and always closed.
  assert.deepEqual(h.emitted, [
    { active: true, kind: "question", label: "→ parent · Quale base?", target: "parent" },
    { active: false },
  ]);
});

test("question router: escalated answers, fallback to the user, withdrawal, default target", async () => {
  const viaUser = await routerHarness({
    kind: "answered",
    requestId: "r1",
    result: { answer: "something else", by: { who: "user", where: "parent-session", reason: "timeout", name: "main agent" } },
  }).run();
  assert.equal(viaUser.kind === "answered" && viaUser.by, "the user");
  assert.deepEqual(viaUser.kind === "answered" && viaUser.answer, { answer: "something else", custom: true });
  assert.deepEqual(await routerHarness({ kind: "fallback", reason: "the parent agent is not available" }).run(), {
    kind: "user",
    reason: "the parent agent is not available",
  });
  assert.deepEqual(await routerHarness({ kind: "cancelled" }).run(), { kind: "cancelled" });
  const off = routerHarness({ kind: "cancelled" }, { enabled: false, parentByDefault: true });
  assert.equal((await off.run()).kind, "user");
  assert.equal(off.asks.length, 0);
  assert.equal(off.router.defaultTarget(), "user");
  assert.equal(routerHarness({ kind: "cancelled" }, { parentByDefault: true }).router.defaultTarget(), "parent");
  assert.equal(routerHarness({ kind: "cancelled" }).router.defaultTarget(), "user");
});

test("child extension: ask-parent children register the router; the question tool stays the installed package's", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "memo-ask-child-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env[CHILD_ENV.protocolDir];
  t.after(() => {
    if (previous === undefined) delete process.env[CHILD_ENV.protocolDir];
    else process.env[CHILD_ENV.protocolDir] = previous;
    setQuestionRouter(undefined);
  });
  process.env[CHILD_ENV.protocolDir] = dir;
  const load = async (policy: object, isolation = "profile") => {
    setQuestionRouter(undefined);
    await writeFile(join(dir, "boot.json"), JSON.stringify({ isolation, policy }));
    const tools: string[] = [];
    childExtension({
      events: { on() {}, emit() {} },
      registerShortcut() {},
      registerTool: (tool: any) => tools.push(tool.name),
      on() {},
    } as any);
    return { tools: tools.sort(), router: (globalThis as any)[QUESTION_ROUTER_KEY] };
  };
  const base = { tools: null, bash: "readonly", bashAsk: true, question: false, delegatedTools: [], userInput: "allowed", exit: "tool" };
  const asking = await load({ ...base, askParent: true, askParentDefault: false });
  assert.deepEqual(asking.tools, ["caller_ping", "subagent_done"]);
  assert.equal(typeof asking.router?.askParent, "function");
  // Not started yet: no runtime, so the user is the target whatever the default.
  assert.equal(asking.router.defaultTarget(), "user");
  assert.equal((await load(base)).router, undefined);
});

test("attention: the waiting target reaches activity.json (validated)", async (t) => {
  const seen: unknown[] = [];
  const track = createAttentionTracker((a) => seen.push(a), () => 5);
  track({ active: true, label: "Quale base?" }); // pi-memo-question's own event
  track({ active: true, kind: "question", label: "→ parent · Quale base?", target: "parent" });
  track({ active: true, kind: "question", label: "→ user · Quale base?", target: "user" });
  track({ active: false });
  track({ active: true, kind: "approval", target: "nobody" });
  assert.deepEqual(seen, [
    { kind: "question", label: "Quale base?", since: 5 },
    { kind: "question", label: "→ parent · Quale base?", target: "parent", since: 5 },
    { kind: "question", label: "→ user · Quale base?", target: "user", since: 5 },
    { kind: "approval", since: 5 },
  ]);
  const dir = await mkdtemp(join(tmpdir(), "memo-ask-activity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "activity.json");
  const recorder = createSubagentActivityRecorder({ runningChildId: "c", activityFile: file });
  recorder.agentStart();
  recorder.attention({ kind: "approval", label: "→ parent · make", target: "parent", since: 7 });
  const read = readSubagentActivityFile(file, "c");
  assert.ok(read.ok);
  assert.deepEqual(read.activity.attention, { kind: "approval", label: "→ parent · make", target: "parent", since: 7 });
  const raw = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...raw, attention: { kind: "approval", target: "someone", since: 1 } }));
  assert.equal(readSubagentActivityFile(file, "c").ok, false);
});

test("contract with pi-memo-question: its question tool asks this router (to: parent, or the parent default)", async (t) => {
  const { default: questionExtension } = await import("pi-memo-question/extension");
  t.after(() => setQuestionRouter(undefined));
  const tools: any[] = [];
  questionExtension({ registerTool: (tool: any) => tools.push(tool), events: { emit() {} } } as any);
  const tool = tools.find((x) => x.name === "question");
  assert.deepEqual(Object.keys(tool.parameters.properties), ["question", "options", "to"]);
  let parentByDefault = false;
  const asked: string[] = [];
  setQuestionRouter(
    createQuestionRouter({
      enabled: () => true,
      parentByDefault: () => parentByDefault,
      ask: async (question) => {
        asked.push(question);
        return { kind: "answered", requestId: "r", result: { answer: "dev", by: { who: "parent", name: "main agent" } } };
      },
      emitBlocked() {},
    }),
  );
  const params = { question: "Quale base?", options: [{ label: "main" }, { label: "dev" }] };
  const noUi = { hasUI: false, ui: {} };
  const routed = await tool.execute("c1", { ...params, to: "parent" }, undefined, undefined, noUi);
  assert.equal(routed.content[0].text, "The parent agent selected: 2. dev");
  // The host's details (who answered, request id) are recorded with the result.
  assert.deepEqual(routed.details.answeredBy, { who: "parent", name: "main agent" });
  // Without `to` the user is asked (default false): no UI here, so the tool reports it instead of the router.
  assert.match((await tool.execute("c2", params, undefined, undefined, noUi)).content[0].text, /UI not available/);
  parentByDefault = true;
  assert.equal((await tool.execute("c3", params, undefined, undefined, noUi)).content[0].text, "The parent agent selected: 2. dev");
  assert.deepEqual(asked, ["Quale base?", "Quale base?"]);
});
