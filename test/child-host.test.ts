// memo-subagents host composition: MEMO_SUBAGENTS_CHILD_EXTENSIONS / MEMO_SUBAGENTS_CHILD_ENV.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PiHarnessDriver,
  type SubagentLaunchContext,
} from "../pi-extension/subagents/harness/index.ts";
import {
  hostChildEnv,
  hostChildEnvAssignments,
  hostChildExtensionArgs,
  hostChildExtensions,
} from "../pi-extension/subagents/child-host.ts";
import { __test__ } from "../pi-extension/subagents/index.ts";

const SUBAGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../pi-extension/subagents");
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const HOST_VARS = [
  "MEMO_SUBAGENTS_CHILD_EXTENSIONS",
  "MEMO_SUBAGENTS_CHILD_ENV",
  "IR_CHILD_EXTENSIONS",
  "IR_CHILD_ENV",
  "CPA_PROXY_CONFIG",
  "PI_CODING_AGENT_DIR",
];

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

/** The resume command exactly as upstream v0.2.0 built it (index.ts subagent_resume). */
function upstreamResumeCommand(opts: {
  sessionPath: string;
  name: string;
  id: string;
  activityFile: string;
  autoExit: boolean;
  resumeMsgFile?: string;
  agentDir?: string;
}): string {
  const parts = ["pi", "--session", quote(opts.sessionPath)];
  parts.push("-e", quote(join(SUBAGENTS_DIR, "subagent-done.ts")));
  if (opts.resumeMsgFile) parts.push(quote(`@${opts.resumeMsgFile}`));
  const env: string[] = [];
  if (opts.agentDir) env.push(`PI_CODING_AGENT_DIR=${quote(opts.agentDir)}`);
  env.push(`PI_SUBAGENT_NAME=${quote(opts.name)}`);
  env.push(`PI_SUBAGENT_SESSION=${quote(opts.sessionPath)}`);
  env.push(`PI_SUBAGENT_ID=${quote(opts.id)}`);
  env.push(`PI_SUBAGENT_ACTIVITY_FILE=${quote(opts.activityFile)}`);
  if (opts.autoExit) env.push("PI_SUBAGENT_AUTO_EXIT=1");
  return `${env.join(" ")} ${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;
}

describe("memo-subagents host child composition", () => {
  it("parses only absolute, de-duplicated extensions", () => {
    assert.deepEqual(
      hostChildExtensions({ MEMO_SUBAGENTS_CHILD_EXTENSIONS: "/a/ext::relative:/b/ext:/a/ext: /c " }),
      ["/a/ext", "/b/ext", "/c"],
    );
    assert.deepEqual(hostChildExtensions({}), []);
  });

  it("forwards only listed, present, valid, non-reserved variables", () => {
    assert.deepEqual(
      hostChildEnv({
        MEMO_SUBAGENTS_CHILD_ENV:
          "CPA_PROXY_CONFIG, MISSING,PI_CODING_AGENT_DIR,bad-name,MEMO_SUBAGENTS_CHILD_EXTENSIONS,CPA_PROXY_CONFIG,EMPTY",
        CPA_PROXY_CONFIG: "/x/config.yaml",
        PI_CODING_AGENT_DIR: "/profile",
        MEMO_SUBAGENTS_CHILD_EXTENSIONS: "/ext",
        EMPTY: "",
      }),
      [["CPA_PROXY_CONFIG", "/x/config.yaml"], ["EMPTY", ""]],
    );
    assert.deepEqual(hostChildEnv({}), []);
    assert.deepEqual(
      hostChildEnvAssignments(quote, { MEMO_SUBAGENTS_CHILD_ENV: "A", A: "it's" }),
      ["A='it'\\''s'"],
    );
    assert.deepEqual(
      hostChildExtensionArgs(quote, { MEMO_SUBAGENTS_CHILD_EXTENSIONS: "/a b" }),
      ["-e", "'/a b'"],
    );
  });

  it("ignores IR_CHILD_* entirely (no coupling to pi-issue-round)", () => {
    const env = {
      IR_CHILD_EXTENSIONS: "/host/cpa",
      IR_CHILD_ENV: "CPA_PROXY_CONFIG",
      CPA_PROXY_CONFIG: "/host/config.yaml",
    };
    assert.deepEqual(hostChildExtensions(env), []);
    assert.deepEqual(hostChildEnv(env), []);
    withEnv(env, () => {
      const { command } = new PiHarnessDriver().buildCommand(context());
      assert.equal(command.match(/ -e /g)?.length, 1, command);
      assert.ok(!command.includes("CPA_PROXY_CONFIG"), command);
    });
  });

  it("pi child command loads host extensions and env after subagent-done / PI_CODING_AGENT_DIR", () => {
    withEnv(
      {
        MEMO_SUBAGENTS_CHILD_EXTENSIONS: "/host/cpa ext",
        MEMO_SUBAGENTS_CHILD_ENV: "CPA_PROXY_CONFIG",
        CPA_PROXY_CONFIG: "/host/config.yaml",
        PI_CODING_AGENT_DIR: "/profile",
      },
      () => {
        const { command } = new PiHarnessDriver().buildCommand(context());
        assert.ok(
          command.includes("-e '/path/to/subagents/subagent-done.ts' -e '/host/cpa ext' --model"),
          command,
        );
        assert.ok(
          command.includes("PI_CODING_AGENT_DIR='/profile' CPA_PROXY_CONFIG='/host/config.yaml' "),
          command,
        );
      },
    );
  });

  it("without host variables the pi command has no extra -e or env", () => {
    withEnv({}, () => {
      const { command } = new PiHarnessDriver().buildCommand(context());
      assert.equal(command.match(/ -e /g)?.length, 1);
      assert.ok(!command.includes("CPA_PROXY_CONFIG"));
    });
  });

  it("subagent_resume command carries host extensions and env", () => {
    const command = __test__.buildResumeCommand({
      sessionPath: "/s/child.jsonl",
      name: "Resume",
      id: "r1",
      activityFile: "/a/act.json",
      autoExit: true,
      resumeMsgFile: "/a/msg.md",
      env: {
        MEMO_SUBAGENTS_CHILD_EXTENSIONS: "/host/cpa",
        MEMO_SUBAGENTS_CHILD_ENV: "CPA_PROXY_CONFIG",
        CPA_PROXY_CONFIG: "/host/config.yaml",
        PI_CODING_AGENT_DIR: "/profile",
      },
    });
    const done = quote(join(SUBAGENTS_DIR, "subagent-done.ts"));
    assert.ok(command.includes(`-e ${done} -e '/host/cpa' '@/a/msg.md'`), command);
    assert.ok(
      command.startsWith("PI_CODING_AGENT_DIR='/profile' CPA_PROXY_CONFIG='/host/config.yaml' PI_SUBAGENT_NAME="),
      command,
    );
  });

  it("subagent_resume ignores IR_CHILD_* and matches upstream byte-for-byte without host variables", () => {
    for (const variant of [
      { autoExit: true, resumeMsgFile: "/a/msg.md", agentDir: "/profile" },
      { autoExit: false, resumeMsgFile: undefined, agentDir: undefined },
    ]) {
      const opts = {
        sessionPath: "/s/child's.jsonl",
        name: "Resume",
        id: "r1",
        activityFile: "/a/act.json",
        autoExit: variant.autoExit,
        resumeMsgFile: variant.resumeMsgFile,
      };
      const env: NodeJS.ProcessEnv = {
        IR_CHILD_EXTENSIONS: "/host/cpa",
        IR_CHILD_ENV: "CPA_PROXY_CONFIG",
        CPA_PROXY_CONFIG: "/host/config.yaml",
        ...(variant.agentDir ? { PI_CODING_AGENT_DIR: variant.agentDir } : {}),
      };
      assert.equal(
        __test__.buildResumeCommand({ ...opts, env }),
        upstreamResumeCommand({ ...opts, agentDir: variant.agentDir }),
      );
    }
  });

  it("the package registers only its own extension entry point", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(pkg.name, "memo-subagents");
    assert.deepEqual(pkg.pi.extensions, ["./pi-extension/subagents/index.ts"]);
  });
});
