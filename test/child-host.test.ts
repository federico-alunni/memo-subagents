// pi-memo-subagents host composition: PI_MEMO_SUBAGENTS_CHILD_EXTENSIONS / PI_MEMO_SUBAGENTS_CHILD_ENV.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { hostChildEnv, hostChildExtensions } from "../pi-extension/subagents/child-host.ts";
import { subagentRuntimeConfig } from "../pi-extension/subagents/runtime-client.ts";

const HOST_VARS = [
  "PI_MEMO_SUBAGENTS_CHILD_EXTENSIONS",
  "PI_MEMO_SUBAGENTS_CHILD_ENV",
  "IR_CHILD_EXTENSIONS",
  "IR_CHILD_ENV",
  "CPA_PROXY_CONFIG",
];

function withEnv<T>(vars: Record<string, string | undefined>, run: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const name of [...HOST_VARS, ...Object.keys(vars)]) saved[name] = process.env[name];
  try {
    for (const name of HOST_VARS) delete process.env[name];
    for (const [name, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("pi-memo-subagents host child composition", () => {
  it("parses only absolute, de-duplicated extensions", () => {
    assert.deepEqual(
      hostChildExtensions({ PI_MEMO_SUBAGENTS_CHILD_EXTENSIONS: "/a/ext::relative:/b/ext:/a/ext: /c " }),
      ["/a/ext", "/b/ext", "/c"],
    );
    assert.deepEqual(hostChildExtensions({}), []);
  });

  it("forwards only listed, present, valid, non-reserved variables", () => {
    assert.deepEqual(
      hostChildEnv({
        PI_MEMO_SUBAGENTS_CHILD_ENV:
          "CPA_PROXY_CONFIG, MISSING,PI_CODING_AGENT_DIR,bad-name,PI_MEMO_SUBAGENTS_CHILD_EXTENSIONS,CPA_PROXY_CONFIG,EMPTY",
        CPA_PROXY_CONFIG: "/x/config.yaml",
        PI_CODING_AGENT_DIR: "/profile",
        PI_MEMO_SUBAGENTS_CHILD_EXTENSIONS: "/ext",
        EMPTY: "",
      }),
      [["CPA_PROXY_CONFIG", "/x/config.yaml"], ["EMPTY", ""]],
    );
    assert.deepEqual(hostChildEnv({}), []);
  });

  it("ignores IR_CHILD_* entirely (no coupling to pi-issue-round)", () => {
    const env = {
      IR_CHILD_EXTENSIONS: "/host/cpa",
      IR_CHILD_ENV: "CPA_PROXY_CONFIG",
      CPA_PROXY_CONFIG: "/host/config.yaml",
    };
    assert.deepEqual(hostChildExtensions(env), []);
    assert.deepEqual(hostChildEnv(env), []);
  });

  it("the subagent runtime gets the host composition and a private per-user state dir", () => {
    const config = withEnv(
      {
        PI_MEMO_SUBAGENTS_CHILD_EXTENSIONS: "/host/cpa ext",
        PI_MEMO_SUBAGENTS_CHILD_ENV: "CPA_PROXY_CONFIG",
        CPA_PROXY_CONFIG: "/host/config.yaml",
      },
      () => subagentRuntimeConfig(),
    );
    assert.deepEqual(config.hostExtensions, ["/host/cpa ext"]);
    assert.deepEqual(config.hostEnv, { CPA_PROXY_CONFIG: "/host/config.yaml" });
    assert.match(config.stateDir, /pi-memo-subagents-/);
    assert.equal(config.startupTimeoutMs, 120000);
    const bare = withEnv({}, () => subagentRuntimeConfig());
    assert.deepEqual(bare.hostExtensions, []);
    assert.deepEqual(bare.hostEnv, {});
  });

  it("the package registers only its own extension entry point", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(pkg.name, "pi-memo-subagents");
    assert.deepEqual(pkg.pi.extensions, ["./pi-extension/subagents/index.ts"]);
  });
});
