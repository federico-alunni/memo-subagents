import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installedQuestionExtension,
  resolveQuestionExtension,
} from "../../pi-extension/subagents/runtime/question-extension.ts";

test("the package installed by pi wins over the dependency copy, so pi loads the tool once", () => {
  const agent = mkdtempSync(join(tmpdir(), "memo-question-"));
  const dir = join(agent, "git", "github.com", "federico-alunni", "pi-memo-question", "extensions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "question.ts"), "export default () => {};\n");
  const expected = realpathSync(join(dir, "question.ts"));
  assert.equal(installedQuestionExtension({ PI_CODING_AGENT_DIR: agent }), expected);
  assert.equal(resolveQuestionExtension({ PI_CODING_AGENT_DIR: agent }), expected);
});

test("without an installed package there is no question tool to load", () => {
  const agent = mkdtempSync(join(tmpdir(), "memo-question-empty-"));
  // Nothing is bundled: the user who did not install pi-memo-question gets no question extension.
  assert.equal(installedQuestionExtension({ PI_CODING_AGENT_DIR: agent, HOME: agent }), undefined);
  assert.equal(resolveQuestionExtension({ PI_CODING_AGENT_DIR: agent, HOME: agent }), undefined);
});
