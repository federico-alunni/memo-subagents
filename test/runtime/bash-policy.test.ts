import test from "node:test";
import assert from "node:assert/strict";
import {
  BASH_ASK_OPTIONS,
  bashDecision,
  createBashApprovals,
  sessionAllowPrefix,
} from "../../pi-extension/subagents/runtime/child/bash-policy.ts";
import { createChildToolGuard } from "../../pi-extension/subagents/runtime/child/extension.ts";
import type { ChildPolicy } from "../../pi-extension/subagents/runtime/protocol.ts";

const READONLY = { bash: "readonly" as const, bashAllow: [] as string[], bashAsk: false };
const ASK = { ...READONLY, bashAllow: ["npm test"], bashAsk: true };

test("bashDecision: read-only list, bash-allow prefixes, ask for plain commands, block for shell grammar", () => {
  assert.equal(bashDecision({ ...READONLY, bash: "unrestricted" }, "rm -rf x"), "allow");
  assert.equal(bashDecision(READONLY, "git log -5 --oneline"), "allow");
  assert.equal(bashDecision(READONLY, "npm test"), "block");
  assert.equal(bashDecision(READONLY, undefined), "block");
  assert.equal(bashDecision(ASK, "npm test -- --grep x"), "allow");
  assert.equal(bashDecision(ASK, "cat README.md"), "allow");
  assert.equal(bashDecision(ASK, "npm run build"), "ask");
  assert.equal(bashDecision(ASK, "rm -rf dist"), "ask");
  // Shell grammar is never asked: the question shows exactly what bash would run.
  for (const command of [
    "npm run build | tee x",
    "npm run build > out",
    "npm run build && rm x",
    "echo $HOME",
    "echo 'quoted'",
    "ls *.ts",
    "npm run build #comment",
    "",
    "   ",
  ])
    assert.equal(bashDecision(ASK, command), "block", command);
  assert.equal(bashDecision(ASK, 42), "block");
  // Session "always" prefixes allow by exact word prefix.
  assert.equal(bashDecision(ASK, "npm run build", ["npm run"]), "allow");
  assert.equal(bashDecision(ASK, "npm run lint --fix", ["npm run"]), "allow");
  assert.equal(bashDecision(ASK, "npm install", ["npm run"]), "ask");
  assert.equal(bashDecision(ASK, "npm run build | cat", ["npm run"]), "block");
  // Without bashAsk the session list is irrelevant and nothing is asked.
  assert.equal(bashDecision(READONLY, "npm run build"), "block");
  assert.equal(bashDecision(READONLY, "npm run build", ["npm run"]), "block");
});

test("the 'always' prefix is the first two words of the command, or its only word", () => {
  assert.equal(sessionAllowPrefix("npm run build --watch"), "npm run");
  assert.equal(sessionAllowPrefix("  make   test "), "make test");
  assert.equal(sessionAllowPrefix("make"), "make");
  assert.equal(sessionAllowPrefix("make | cat"), undefined);
});

function fakeUi(answers: (string | undefined)[], hasUI = true) {
  const asked: { title: string; options: string[] }[] = [];
  return {
    asked,
    ctx: {
      hasUI,
      signal: undefined as AbortSignal | undefined,
      ui: {
        select: async (title: string, options: string[]) => {
          asked.push({ title, options });
          return answers.shift();
        },
      },
    },
  };
}

test("approvals: deny first, 'once' passes only that call, 'always' covers the same prefix in this process", async () => {
  const approvals = createBashApprovals();
  const ui = fakeUi([BASH_ASK_OPTIONS.once, BASH_ASK_OPTIONS.deny, BASH_ASK_OPTIONS.always]);
  assert.equal(await approvals.check(ASK, "npm run build", ui.ctx), undefined);
  assert.deepEqual(ui.asked[0].options, ["Rifiuta", "Permetti una volta", "Permetti sempre in questa sessione dell'agente"]);
  assert.match(ui.asked[0].title, /npm run build/);
  assert.match(ui.asked[0].title, /"npm run"/);
  // "Once" is not remembered: the same command is asked again, and refused.
  const refused = await approvals.check(ASK, "npm run build", ui.ctx);
  assert.equal(refused?.block, true);
  assert.match(refused!.reason, /refused/);
  assert.equal(ui.asked.length, 2);
  // "Always": this and later commands with the same two-word prefix pass without asking.
  assert.equal(await approvals.check(ASK, "npm run build", ui.ctx), undefined);
  assert.equal(await approvals.check(ASK, "npm run lint", ui.ctx), undefined);
  assert.equal(ui.asked.length, 3);
  assert.deepEqual(approvals.prefixes(), ["npm run"]);
  // Another prefix is still asked; another process (new approvals) remembers nothing.
  const other = fakeUi([undefined]);
  assert.equal((await approvals.check(ASK, "npm install", other.ctx))?.block, true);
  assert.equal(other.asked.length, 1);
  assert.deepEqual(createBashApprovals().prefixes(), []);
});

test("approvals: cancelled question, no UI, aborted turn and shell grammar block", async () => {
  const approvals = createBashApprovals();
  const cancelled = fakeUi([undefined]);
  const result = await approvals.check(ASK, "npm run build", cancelled.ctx);
  assert.equal(result?.block, true);
  assert.match(result!.reason, /cancelled/);
  const noUi = fakeUi([BASH_ASK_OPTIONS.once], false);
  assert.equal((await approvals.check(ASK, "npm run build", noUi.ctx))?.block, true);
  assert.equal(noUi.asked.length, 0);
  const aborted = fakeUi([BASH_ASK_OPTIONS.once]);
  const controller = new AbortController();
  controller.abort();
  aborted.ctx.signal = controller.signal;
  assert.equal((await approvals.check(ASK, "npm run build", aborted.ctx))?.block, true);
  assert.equal(aborted.asked.length, 0);
  // Aborted while the question is open: the answer is ignored.
  const late = new AbortController();
  const racing = {
    hasUI: true,
    signal: late.signal,
    ui: { select: async () => (late.abort(), BASH_ASK_OPTIONS.always) },
  };
  assert.equal((await approvals.check(ASK, "npm run build", racing))?.block, true);
  assert.deepEqual(approvals.prefixes(), []);
  const grammar = fakeUi([BASH_ASK_OPTIONS.once]);
  const piped = await approvals.check(ASK, "npm run build | cat", grammar.ctx);
  assert.equal(piped?.block, true);
  assert.match(piped!.reason, /Also allowed: npm test/);
  assert.equal(grammar.asked.length, 0);
});

test("approvals: concurrent calls ask one at a time and an 'always' answer covers the waiting call", async () => {
  const approvals = createBashApprovals();
  let release!: (answer: string) => void;
  let asked = 0;
  const ctx = {
    hasUI: true,
    ui: {
      select: () => {
        asked++;
        return new Promise<string>((resolve) => (release = resolve));
      },
    },
  };
  const first = approvals.check(ASK, "npm run build", ctx);
  const second = approvals.check(ASK, "npm run lint", ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asked, 1);
  release(BASH_ASK_OPTIONS.always);
  assert.deepEqual(await Promise.all([first, second]), [undefined, undefined]);
  assert.equal(asked, 1);
});

const policy = (patch: Partial<ChildPolicy>): ChildPolicy => ({
  tools: null,
  denyTools: [],
  bash: "readonly",
  bashAllow: [],
  bashAsk: false,
  question: false,
  delegatedTools: [],
  userInput: "allowed",
  exit: "tool",
  ...patch,
});

test("child tool guard: asks only with bashAsk; workflow (takeover) policies never ask", async () => {
  const guard = createChildToolGuard();
  const ui = fakeUi([BASH_ASK_OPTIONS.once, BASH_ASK_OPTIONS.always]);
  const user = policy({ bashAsk: true, bashAllow: ["npm test"] });
  assert.equal(await guard(user, "bash", { command: "npm test" }, ui.ctx), undefined);
  assert.equal(await guard(user, "read", { path: "x" }, ui.ctx), undefined);
  assert.equal(ui.asked.length, 0);
  assert.equal(await guard(user, "bash", { command: "npm run build" }, ui.ctx), undefined);
  assert.equal(await guard(user, "bash", { command: "make check" }, ui.ctx), undefined);
  assert.equal(await guard(user, "bash", { command: "make check -j4" }, ui.ctx), undefined);
  assert.equal(ui.asked.length, 2);
  // Denied tools stay blocked without asking.
  const denied = policy({ bashAsk: true, denyTools: ["bash"] });
  assert.equal((await guard(denied, "bash", { command: "npm run build" }, ui.ctx))?.block, true);
  // Workflow children (takeover, no bashAsk) are blocked as before, even with a UI.
  const workflow = policy({ userInput: "takeover", exit: "parent", bashAllow: ["npm test"] });
  const never = fakeUi([BASH_ASK_OPTIONS.always]);
  const blocked = await guard(workflow, "bash", { command: "npm run build" }, never.ctx);
  assert.equal(blocked?.block, true);
  assert.match(blocked!.reason, /Read-only agent.*Also allowed: npm test\./s);
  assert.equal(never.asked.length, 0);
  // No policy at all: blocked.
  assert.equal((await guard(undefined, "bash", { command: "ls" }, never.ctx))?.block, true);
});
