import test from "node:test";
import assert from "node:assert/strict";
import { EscalationList, approvalComponent } from "../pi-extension/subagents/escalation-dialog.ts";
import type { DialogComponent, EscalationAnswer } from "../pi-extension/subagents/escalation-dialog.ts";
import type { AskRequest } from "../pi-extension/subagents/runtime/ask-parent.ts";
import { questionComponent } from "pi-memo-question/dialog";

// The installed pi-memo-question publishes its dialog when it loads; the test stands in for it.
(globalThis as any)[Symbol.for("pi-memo-question/dialog")] = { questionComponent };

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const theme = { fg: (_c: string, t: string) => t };
const tui: any = { requestRender() {}, terminal: { rows: 40, columns: 100 } };

const QUESTION: AskRequest = {
  kind: "question",
  childId: "a1",
  childName: "Scout",
  text: "Quale base?",
  options: [{ label: "main (Recommended)" }, { label: "dev" }],
};
const APPROVAL: AskRequest = {
  kind: "approval",
  childId: "b2",
  childName: "Builder",
  origin: ["Grandchild"],
  text: "npm run build",
  command: "npm run build",
  prefix: "npm run",
};

/** A fake `ctx.ui.custom`: one component at a time, closed by `done`. */
function harness(withUi = true) {
  let component: DialogComponent | undefined;
  let opens = 0;
  let closeOpen: () => void = () => {};
  const list = new EscalationList((factory) => {
    if (!withUi) return undefined;
    opens++;
    return new Promise<void>((resolve) => {
      closeOpen = resolve;
      component = factory(tui, theme, () => {
        component = undefined;
        resolve();
      });
    });
  });
  return {
    list,
    opens: () => opens,
    screen: () => component?.render(160).join("\n") ?? "",
    type: (...keys: string[]) => keys.forEach((k) => component!.handleInput(k)),
    closed: () => component === undefined,
    forceClose: () => closeOpen(),
  };
}

test("several escalated requests form one list in the parent session, browsed with ←/→, naming each child", async () => {
  const h = harness();
  const answers: (EscalationAnswer | undefined)[] = [];
  const first = h.list.ask({ key: "a1/r1", request: QUESTION, reason: "timeout" }).then((a) => answers.push(a));
  const second = h.list.ask({ key: "b2/r2", request: APPROVAL, reason: "always" }).then((a) => answers.push(a));
  assert.equal(h.opens(), 1);
  assert.equal(h.list.size, 2);
  let screen = h.screen();
  assert.match(screen, /Request 1\/2 · question from subagent "Scout" \(the agent did not answer in time\)/);
  assert.match(screen, /←\/→ other requests/);
  assert.match(screen, /Quale base\?/);
  assert.match(screen, /1\. main \(Recommended\)/);
  h.type(RIGHT);
  screen = h.screen();
  assert.match(screen, /Request 2\/2 · bash approval from subagent "Builder › Grandchild" \(only you can allow a command always\)/);
  assert.match(screen, /Il subagente vuole eseguire: npm run build/);
  assert.match(screen, /1\. Rifiuta/);
  assert.match(screen, /2\. Permetti una volta/);
  assert.match(screen, /3\. Permetti sempre/);
  h.type(RIGHT); // wraps around
  assert.match(h.screen(), /Request 1\/2/);
  h.type(LEFT);
  h.type(DOWN, ENTER); // approval: Permetti una volta
  await second;
  assert.deepEqual(answers, [{ kind: "approval", decision: "once" }]);
  // One request left: no position, no arrows hint; the question dialog is pi-memo-question's.
  screen = h.screen();
  assert.doesNotMatch(screen, /Request \d\/\d|←\/→/);
  h.type(DOWN, ENTER);
  await first;
  assert.deepEqual(answers[1], { kind: "question", answer: { answer: "dev", custom: false, index: 2 } });
  assert.equal(h.closed(), true);
});

test("arrows stay with the free-answer editor; Esc cancels; withdrawn requests leave the list", async () => {
  const h = harness();
  const answers: (EscalationAnswer | undefined)[] = [];
  const controller = new AbortController();
  const q = h.list.ask({ key: "a1/r1", request: QUESTION, reason: "escalated" }).then((a) => answers.push(a));
  const a = h.list.ask({ key: "b2/r2", request: APPROVAL, reason: "timeout" }, controller.signal).then((x) => answers.push(x));
  h.type(DOWN, DOWN, ENTER); // free answer editor
  h.type(..."abc", LEFT, LEFT, "X");
  assert.match(h.screen(), /Request 1\/2/); // arrows moved the cursor, not the list
  h.type(ENTER);
  await q;
  assert.deepEqual(answers[0], { kind: "question", answer: { answer: "aXbc", custom: true } });
  controller.abort(); // e.g. the child asked the user in its own pane
  await a;
  assert.equal(answers[1], undefined);
  assert.equal(h.list.size, 0);
  assert.equal(h.closed(), true);
  // Esc on an approval is a cancel.
  const h2 = harness();
  const cancelled = h2.list.ask({ key: "b2/r3", request: APPROVAL, reason: "escalated" });
  h2.type(ESC);
  assert.deepEqual(await cancelled, { kind: "approval", decision: "cancel" });
});

test("without an interactive UI nothing is shown: the request falls back; clear() withdraws everything", async () => {
  const none = harness(false);
  assert.equal(await none.list.ask({ key: "k", request: QUESTION, reason: "timeout" }), undefined);
  const h = harness();
  const pending = h.list.ask({ key: "k", request: QUESTION, reason: "timeout" });
  h.list.clear();
  assert.equal(await pending, undefined);
  const decisions: string[] = [];
  const c = approvalComponent(tui, theme, "make", "make", (d) => decisions.push(d));
  c.handleInput(ENTER);
  c.handleInput(DOWN);
  c.handleInput(DOWN);
  c.handleInput(DOWN);
  c.handleInput(ENTER);
  assert.deepEqual(decisions, ["deny", "always"]);
});
