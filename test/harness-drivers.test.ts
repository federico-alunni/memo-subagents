import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getHarnessDriver,
  PiHarnessDriver,
  UnsupportedCliError,
  type SubagentLaunchContext,
} from "../pi-extension/subagents/harness/index.ts";
import type { ResolvedRuntimePlan } from "../pi-extension/subagents/runtime-routing.ts";

function createMockLaunchContext(overrides?: Partial<SubagentLaunchContext>): SubagentLaunchContext {
  const runtimePlan: ResolvedRuntimePlan = {
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
    model: "anthropic/claude-sonnet-4-5",
    thinking: "medium",
    modelSource: "request",
    thinkingSource: "request",
  };

  return {
    params: {
      id: "abc12345",
      name: "worker",
      task: "Analyze the repository structure",
    },
    runtimePlan,
    effectiveModel: "anthropic/claude-sonnet-4-5",
    effectiveThinking: "medium",
    parentThinking: "medium",
    surface: "pane-1",
    artifactDir: "/tmp/artifacts",
    sessionDir: "/tmp/sessions",
    subagentSessionFile: "/tmp/sessions/subagent.jsonl",
    effectiveCwd: "/tmp/project",
    effectiveAutoExit: true,
    effectiveInteractive: false,
    inheritsConversationContext: true,
    taskDelivery: "direct",
    subagentsDir: "/path/to/subagents",
    shellQuote: (s: string) => `'${s.replace(/'/g, "'\\''")}'`,
    ...overrides,
  };
}

describe("Harness driver registry (pi only)", () => {
  it("resolves pi case-insensitively and by default", () => {
    for (const cli of [undefined, "", "   ", "pi", "PI", " Pi "]) {
      assert.equal(getHarnessDriver(cli).id, "pi");
    }
  });

  it("rejects any other cli with a clear error", () => {
    for (const cli of ["claude", "codex", "opencode", "grok", "aider"]) {
      assert.throws(() => getHarnessDriver(cli), UnsupportedCliError);
    }
  });
});

describe("Pi Harness Driver", () => {
  const driver = new PiHarnessDriver();

  it("formats model using full provider/model reference", () => {
    assert.equal(
      driver.formatModel({ provider: "anthropic", modelId: "claude-sonnet-4-5", model: "anthropic/claude-sonnet-4-5" }),
      "anthropic/claude-sonnet-4-5",
    );
  });

  it("supports turn interrupts and live activity snapshots", () => {
    assert.equal(driver.supportsTurnInterrupt, true);
    assert.equal(driver.hasActivitySnapshots, true);
  });

  it("builds correct pi invocation command", () => {
    const ctx = createMockLaunchContext({
      effectiveModel: "anthropic/claude-sonnet-4-5",
      effectiveThinking: "high",
    });
    const built = driver.buildCommand(ctx);

    assert.ok(built.command.includes("pi --session '/tmp/sessions/subagent.jsonl'"));
    assert.ok(built.command.includes("--model 'anthropic/claude-sonnet-4-5'"));
    assert.ok(built.command.includes("--thinking 'high'"));
    assert.ok(built.command.includes("echo '__SUBAGENT_DONE_'$?'__'"));
  });
});
