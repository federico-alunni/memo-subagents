import test from "node:test";
import assert from "node:assert/strict";
import { hostCompositionFromEnv } from "../../pi-extension/subagents/runtime/index.ts";

test("host composition reads only PI_MEMO_SUBAGENTS_CHILD_* and refuses reserved names", () => {
  assert.deepEqual(
    hostCompositionFromEnv({
      PI_MEMO_SUBAGENTS_CHILD_EXTENSIONS: "/a/ext.ts:relative.ts: /b/ext.ts :/a/ext.ts",
      PI_MEMO_SUBAGENTS_CHILD_ENV: "CPA_PROXY_CONFIG, PI_X, PI_MEMO_SUBAGENTS_Y, MISSING",
      CPA_PROXY_CONFIG: "/cfg.yaml",
      PI_X: "no",
      PI_MEMO_SUBAGENTS_Y: "no",
      IR_CHILD_EXTENSIONS: "/ignored.ts",
    }),
    {
      hostExtensions: ["/a/ext.ts", "/b/ext.ts"],
      hostEnv: { CPA_PROXY_CONFIG: "/cfg.yaml" },
    },
  );
});
