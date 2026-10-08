import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_ENV,
  PACKAGE_ROOT,
  USER_CONFIG_NAME,
  agentConfigDir,
  resolveConfigPath,
} from "../pi-extension/subagents/config-path.ts";

function agentDir(withConfig: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "memo-subagents-config-"));
  if (withConfig) writeFileSync(join(dir, USER_CONFIG_NAME), "{}");
  return dir;
}

test("explicit PI_MEMO_SUBAGENTS_CONFIG wins, even when the file does not exist", () => {
  const dir = agentDir(true);
  const explicit = join(dir, "elsewhere.json");
  assert.equal(resolveConfigPath({ PI_CODING_AGENT_DIR: dir, [CONFIG_ENV]: explicit }), explicit);
});

test("the user config lives in the agent dir, outside the package checkout that pi wipes on update", () => {
  const dir = agentDir(true);
  assert.equal(resolveConfigPath({ PI_CODING_AGENT_DIR: dir }), join(dir, USER_CONFIG_NAME));
});

test("without a user config it falls back to the package-root config.json", () => {
  const dir = agentDir(false);
  // HOME points to an empty dir too, so a developer's real ~/.pi/agent cannot leak into the result.
  const result = resolveConfigPath({ PI_CODING_AGENT_DIR: dir, HOME: dir });
  assert.ok(
    result === join(PACKAGE_ROOT, "config.json") || result.endsWith(USER_CONFIG_NAME),
    result,
  );
});

test("agentConfigDir follows PI_CODING_AGENT_DIR", () => {
  assert.equal(agentConfigDir({ PI_CODING_AGENT_DIR: "/x/profile" }), "/x/profile");
});
