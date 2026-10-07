import test from "node:test";
import assert from "node:assert/strict";
import {
  FREE_ANSWER,
  answerText,
  questionComponent,
} from "../../pi-extension/subagents/runtime/child/question-dialog.ts";
import type { QuestionAnswer } from "../../pi-extension/subagents/runtime/child/question-dialog.ts";

const UP = "\x1b[A",
  DOWN = "\x1b[B",
  TAB = "\t",
  ENTER = "\r",
  ESC = "\x1b";
const theme = { fg: (_c: string, t: string) => t };
const tui: any = { requestRender() {}, terminal: { rows: 40, columns: 80 } };
const options = [
  { label: "Unire (Recommended)", description: "parte da 739e432" },
  { label: "Solo 739e432" },
];
function open() {
  const results: (QuestionAnswer | null)[] = [];
  const c = questionComponent(tui, theme, "Quale base?", options, (r) =>
    results.push(r),
  );
  const type = (...keys: string[]) => keys.forEach((k) => c.handleInput(k));
  return { c, results, type };
}

test("child question: descriptions below options and a Tab hint", () => {
  const lines = open().c.render(80).join("\n");
  assert.match(
    lines,
    /> 1\. Unire \(Recommended\)\n {5}parte da 739e432\n {2}2\. Solo 739e432\n {2}3\. Altro/,
  );
  assert.match(lines, /Tab aggiunge una nota/);
});

test("child question: arrows + Enter select, Tab attaches a note", () => {
  let d = open();
  d.type(DOWN, ENTER);
  assert.deepEqual(d.results, [
    { answer: "Solo 739e432", custom: false, index: 2 },
  ]);

  d = open();
  d.type(TAB, ..."solo il doc", ENTER);
  assert.deepEqual(d.results, [
    {
      answer: "Unire (Recommended)",
      custom: false,
      index: 1,
      note: "solo il doc",
    },
  ]);
  assert.equal(
    answerText(d.results[0]),
    "L'utente ha scelto: 1. Unire (Recommended)\nNota dell'utente: solo il doc",
  );
});

test("child question: free answer inline, Esc goes back then cancels", () => {
  let d = open();
  d.type(DOWN, DOWN, TAB); // Tab on the free answer does nothing
  assert.doesNotMatch(d.c.render(80).join("\n"), /Nota/);
  d.type(ENTER, ..."altro piano", ENTER);
  assert.deepEqual(d.results, [{ answer: "altro piano", custom: true }]);
  assert.match(answerText(d.results[0]), /ha scritto: altro piano/);

  d = open();
  d.type(TAB, ESC); // leaves the note editor without answering
  assert.deepEqual(d.results, []);
  d.type(UP, ESC);
  assert.deepEqual(d.results, [null]);
  assert.match(answerText(null), /non ha risposto/);
  assert.equal(FREE_ANSWER, "Altro: scrivo io la risposta");
});
