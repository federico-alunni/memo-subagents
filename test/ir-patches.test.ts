// pi-issue-round local patches to memo-subagents (vendored from pi-herdr-subagents).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  PiHarnessDriver,
  type SubagentLaunchContext,
} from "../pi-extension/subagents/harness/index.ts";
import {
  hostChildEnv,
  hostChildExtensions,
} from "../pi-extension/subagents/harness/drivers/pi.ts";

const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
function context(): SubagentLaunchContext {
  return {
    params: { id: "abc12345", name: "scout", task: "map" },
    runtimePlan: {
      provider: "cpa-vps",
      modelId: "m",
      model: "cpa-vps/m",
      thinking: "high",
      modelSource: "parent",
      thinkingSource: "parent",
    },
    effectiveModel: "cpa-vps/m",
    effectiveThinking: "high",
    parentThinking: "high",
    surface: "w1:p2",
    artifactDir: "/tmp/artifacts",
    sessionDir: "/tmp/sessions",
    subagentSessionFile: "/tmp/sessions/s.jsonl",
    effectiveCwd: "/tmp/project",
    effectiveAutoExit: true,
    effectiveInteractive: false,
    inheritsConversationContext: true,
    taskDelivery: "direct",
    subagentsDir: "/path/to/subagents",
    shellQuote: quote,
  } as SubagentLaunchContext;
}

describe("pi-issue-round host child composition", () => {
  it("parses only absolute extensions and forwards only listed, present, non-PI_ variables", () => {
    assert.deepEqual(
      hostChildExtensions({ IR_CHILD_EXTENSIONS: "/a/ext::relative:/b/ext" }),
      ["/a/ext", "/b/ext"],
    );
    assert.deepEqual(
      hostChildEnv({
        IR_CHILD_ENV: "CPA_PROXY_CONFIG, MISSING,PI_CODING_AGENT_DIR,bad-name",
        CPA_PROXY_CONFIG: "/x/config.yaml",
        PI_CODING_AGENT_DIR: "/profile",
      }),
      [["CPA_PROXY_CONFIG", "/x/config.yaml"]],
    );
    assert.deepEqual(hostChildExtensions({}), []);
    assert.deepEqual(hostChildEnv({}), []);
  });

  it("pi child command loads the host provider extension and its config after subagent-done", () => {
    const saved = { ...process.env };
    try {
      process.env.IR_CHILD_EXTENSIONS = "/host/cpa ext";
      process.env.IR_CHILD_ENV = "CPA_PROXY_CONFIG";
      process.env.CPA_PROXY_CONFIG = "/host/config.yaml";
      const { command } = new PiHarnessDriver().buildCommand(context());
      assert.ok(
        command.includes("-e '/path/to/subagents/subagent-done.ts' -e '/host/cpa ext' --model"),
        command,
      );
      assert.ok(command.includes("CPA_PROXY_CONFIG='/host/config.yaml' "), command);
    } finally {
      process.env = saved;
    }
  });

  it("without host variables the command matches upstream (no extra -e or env)", () => {
    const saved = { ...process.env };
    try {
      delete process.env.IR_CHILD_EXTENSIONS;
      delete process.env.IR_CHILD_ENV;
      const { command } = new PiHarnessDriver().buildCommand(context());
      assert.equal(command.match(/ -e /g)?.length, 1);
      assert.ok(!command.includes("CPA_PROXY_CONFIG"));
    } finally {
      process.env = saved;
    }
  });

  it("the package registers the vendored extension next to the IR extension", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    assert.deepEqual(pkg.pi.extensions, [
      "./src/extension.ts",
      "./src/memo-subagents/pi-extension/subagents/index.ts",
    ]);
  });
});
