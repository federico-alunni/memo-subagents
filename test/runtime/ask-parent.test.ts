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
import { registerAskParentQuestion, routedAnswerText } from "../../pi-extension/subagents/runtime/child/question-tool.ts";
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

// ── The question tool through the parent ──

function questionHarness(outcome: AskOutcome, enabled = true) {
  const tools: any[] = [];
  const emitted: [string, any][] = [];
  const pi = {
    registerTool: (tool: any) => tools.push(tool),
    events: { emit: (name: string, data: unknown) => emitted.push([name, data]), on() {} },
  } as any;
  const asks: unknown[][] = [];
  registerAskParentQuestion(pi, {
    enabled: () => enabled,
    ask: async (question, options, _signal, onTarget) => {
      asks.push([question, options]);
      onTarget("parent");
      return outcome;
    },
    emitBlocked: (event) => emitted.push(["herdr:blocked", event]),
  });
  let customCalls = 0;
  const ctx = {
    hasUI: true,
    ui: {
      custom: async () => {
        customCalls++;
        return { answer: "dev", custom: false, index: 2 };
      },
    },
  };
  const params = { question: "Quale base?", options: [{ label: "main (Recommended)" }, { label: "dev" }] };
  return {
    tools,
    emitted,
    asks,
    customCalls: () => customCalls,
    run: () => tools[0].execute("call-1", params, undefined, undefined, ctx),
  };
}

test("question: one tool with pi-memo-question's schema; the parent's answer is used and recorded, no pane dialog", async () => {
  const h = questionHarness({
    kind: "answered",
    requestId: "r1",
    result: { answer: "1", note: "safer", by: { who: "parent", name: "main agent", id: "s1" } },
  });
  assert.deepEqual(h.tools.map((t) => t.name), ["question"]);
  assert.deepEqual(Object.keys(h.tools[0].parameters.properties), ["question", "options"]);
  const result = await h.run();
  assert.equal(h.customCalls(), 0);
  assert.deepEqual(h.asks, [["Quale base?", [{ label: "main (Recommended)" }, { label: "dev" }]]]);
  assert.equal(
    result.content[0].text,
    'The parent agent selected: 1. main (Recommended)\nParent agent note: safer\n(answered by the parent agent "main agent" (s1))',
  );
  assert.equal(result.details.answer, "main (Recommended)");
  assert.deepEqual(result.details.answeredBy, { who: "parent", name: "main agent", id: "s1" });
  // memo-question events still feed question.json; the wait carries its target.
  const memo = h.emitted.filter(([name]) => name === "memo-question").map(([, data]) => data);
  assert.equal(memo[0].pending, true);
  assert.equal(memo[1].answer, "main (Recommended)");
  assert.ok(h.emitted.some(([name, data]) => name === "herdr:blocked" && data.target === "parent"));
  const blocked = h.emitted.filter(([name]) => name === "herdr:blocked").map(([, data]) => data);
  assert.equal(blocked.filter((e) => e.active).length, blocked.filter((e) => !e.active).length);
});

test("question: a user answer via the parent session, a fallback to the pane, a withdrawn request, and opt-out", async () => {
  const viaUser = await questionHarness({
    kind: "answered",
    requestId: "r1",
    result: { answer: "something else", by: { who: "user", where: "parent-session", reason: "timeout", name: "main agent" } },
  }).run();
  assert.match(
    viaUser.content[0].text,
    /^User wrote: something else\n\(answered by the user in the session of "main agent" \(the parent agent did not answer in time\)\)$/,
  );
  const fallback = questionHarness({ kind: "fallback", reason: "the parent agent is not available" });
  const local = await fallback.run();
  assert.equal(fallback.customCalls(), 1);
  assert.equal(
    local.content[0].text,
    "User selected: 2. dev\n(answered by the user in this pane; the parent agent could not answer: the parent agent is not available)",
  );
  assert.equal(local.details.answeredBy.where, "child-pane");
  assert.ok(fallback.emitted.some(([name, data]) => name === "herdr:blocked" && data.target === "user"));
  const withdrawn = await questionHarness({ kind: "cancelled" }).run();
  assert.match(withdrawn.content[0].text, /^User cancelled the selection\n\(the request to the parent agent was withdrawn/);
  const off = questionHarness({ kind: "fallback", reason: "unused" }, false);
  const plain = await off.run();
  assert.equal(off.customCalls(), 1);
  assert.equal(off.asks.length, 0);
  assert.equal(plain.content[0].text, "User selected: 2. dev");
  assert.equal(routedAnswerText(null, { who: "parent", name: "p" }), 'The parent agent cancelled the selection\n(answered by the parent agent "p")');
});

test("child extension: ask-parent children register the one wrapped question tool; others do not", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "memo-ask-child-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env[CHILD_ENV.protocolDir];
  t.after(() => {
    if (previous === undefined) delete process.env[CHILD_ENV.protocolDir];
    else process.env[CHILD_ENV.protocolDir] = previous;
  });
  process.env[CHILD_ENV.protocolDir] = dir;
  const load = async (policy: object, isolation = "profile") => {
    await writeFile(join(dir, "boot.json"), JSON.stringify({ isolation, policy }));
    const tools: string[] = [];
    childExtension({
      events: { on() {}, emit() {} },
      registerShortcut() {},
      registerTool: (tool: any) => tools.push(tool.name),
      on() {},
    } as any);
    return tools.sort();
  };
  const base = { tools: null, bash: "readonly", bashAsk: true, question: false, delegatedTools: [], userInput: "allowed", exit: "tool" };
  assert.deepEqual(await load({ ...base, askParent: true }), ["caller_ping", "question", "subagent_done"]);
  assert.deepEqual(
    await load({ ...base, askParent: true, tools: ["read"], question: true }, "isolated"),
    ["caller_ping", "question", "subagent_done"],
  );
  assert.deepEqual(await load({ ...base, askParent: true }, "isolated"), ["caller_ping", "subagent_done"]);
  assert.deepEqual(await load(base), ["caller_ping", "subagent_done"]);
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
