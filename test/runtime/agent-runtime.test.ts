import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  readdir,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentRuntime,
  RuntimeError,
  nextSubagentIndex,
  readProcessTerminal,
  subagentPanelName,
  presence,
} from "../../pi-extension/subagents/runtime/index.ts";
import type {
  LaunchSpec,
  RunInput,
  RunResult,
  Runner,
} from "../../pi-extension/subagents/runtime/index.ts";
import {
  ChildRuntime,
  settledResult,
} from "../../pi-extension/subagents/runtime/child/runtime.ts";
import {
  json,
  publish,
  taskFile,
  taskKey,
  record,
} from "../../pi-extension/subagents/runtime/protocol.ts";
import type {
  Boot,
  DelegatedToolSpec,
} from "../../pi-extension/subagents/runtime/protocol.ts";
import { childToolCall } from "../../pi-extension/subagents/runtime/child/extension.ts";
import { resolveQuestionExtension } from "../../pi-extension/subagents/runtime/question-extension.ts";
import { AskParentHost, createEscalate } from "../../pi-extension/subagents/ask-parent-host.ts";
import { PaneSelector } from "../../pi-extension/subagents/runtime/pane-selector.ts";
import type { SelectorState } from "../../pi-extension/subagents/runtime/pane-selector.ts";

// Role presets of the original issue-round transport tests, expressed as runtime policies.
const WORKER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];
const INTEGRATE: DelegatedToolSpec = {
  name: "ir_integrate",
  description: "Request the parent to integrate the assigned task.",
  parameters: {
    type: "object",
    properties: { taskId: { type: "string" } },
    required: ["taskId"],
  },
  once: "per-task",
};
const TRIAGE = {
  tools: READ_ONLY_TOOLS,
  bash: "readonly" as const,
  question: true,
  placement: "split-right" as const,
  display: { label: "triage" },
};
const PLANNER = { ...TRIAGE, display: { label: "planner" } };
const MERGER = {
  tools: [] as string[],
  delegatedTools: [INTEGRATE],
  placement: "tab" as const,
  display: { label: "merger" },
};

class FakeHerdr {
  calls: RunInput[] = [];
  boot?: Boot;
  runtime?: ChildRuntime;
  alive = false;
  idle = true;
  missing = false;
  /** Real Herdr 0.9: exit 1, empty stdout, JSON error on stderr. */
  errorsOnStderr = false;
  unavailable = false;
  terminal = "terminal-1";
  occupant?: number;
  processIdentity = "Tue Oct 6 00:00:00 2026 pi --session-id exact";
  shellIdentity = "Tue Oct 6 00:00:00 2026 /bin/zsh";
  reportedTty: string | undefined = "/dev/ttys-test";
  shellTty = "ttys-test";
  childTty = "ttys-test";
  ttyFailure = false;
  prompts: string[] = [];
  skills: string[][] = [];
  aborts = 0;
  shutdowns = 0;
  closes = 0;
  createCount = 0;
  pid = 8123;
  suppressShutdown = false;
  cliUnsupported = false;
  readySuppressed = false;
  uncertainCreate = false;
  uncertainRun = false;
  emptyRun = false;
  /** Labels and live panes seen by the Agents-panel naming (display only). */
  workspaceLabel: string | undefined = "local-app";
  tabLabel: string | undefined = "PLAN";
  livePanes: unknown[] = [];
  /** Herdr `worktree open` outcome for worker launches. */
  worktree: "open" | "already-open" | "refused" | "mismatch" = "open";
  workspace = "workspace-1";
  paneId = "pane-1";
  /** Caller tab layout read by "auto"/"visible" placement. */
  layout: { zoomed?: boolean; panes: { pane_id: string; tab_id: string; workspace_id: string }[] } = {
    panes: [{ pane_id: "master-pane", tab_id: "tab-1", workspace_id: "workspace-1" }],
  };
  onCall?: (input: RunInput) => void | RunResult | Promise<void | RunResult>;
  runner: Runner = async (input) => {
    this.calls.push(input);
    const override = await this.onCall?.(input);
    if (override) return override;
    if (input.executable === "fake-pi")
      return {
        exitCode: 0,
        stdout: this.cliUnsupported
          ? "old help"
          : "--session-id --session-dir --no-extensions --no-skills --no-prompt-templates --no-approve",
      };
    if (input.executable === "ps") {
      await this.runtime?.tick();
      const shell = input.argv[1] === "8111";
      const alive = shell || this.alive;
      const identity = shell ? this.shellIdentity : this.processIdentity;
      if (input.argv.includes("tty="))
        return {
          exitCode: this.ttyFailure || !alive ? 1 : 0,
          stdout:
            this.ttyFailure || !alive
              ? ""
              : `${shell ? this.shellTty : this.childTty}   ${identity}\n`,
        };
      return { exitCode: alive ? 0 : 1, stdout: alive ? identity : "" };
    }
    assert.equal(
      input.executable,
      "fake-herdr",
      "No real executables are allowed in transport tests",
    );
    const a = input.argv;
    if (a[0] === "pane" && a[1] === "current")
      return this.result({
        pane: {
          pane_id: "master-pane",
          tab_id: "tab-1",
          workspace_id: "workspace-1",
        },
      });
    if (a[0] === "pane" && a[1] === "layout") return this.result({ layout: this.layout });
    if (a[0] === "pane" && a[1] === "split") {
      this.createCount++;
      return this.result({ pane: this.pane() });
    }
    if (a[1] === "rename" || a[1] === "report-metadata") return this.result({});
    if (a[0] === "workspace" && a[1] === "get")
      return this.result({ workspace: { workspace_id: a[2], label: this.workspaceLabel } });
    if (a[0] === "tab" && a[1] === "get")
      return this.result({ tab: { tab_id: a[2], label: this.tabLabel } });
    if (a[0] === "pane" && a[1] === "list")
      return this.result({ panes: this.livePanes });
    if (a[0] === "worktree" && a[1] === "open") {
      if (this.worktree === "refused")
        return {
          exitCode: 1,
          stdout: "",
          stderr: JSON.stringify({
            error: { code: "worktree_not_git", message: "not a Git space" },
          }),
        };
      const path = a[a.indexOf("--path") + 1];
      const workspace = {
        workspace_id: "workspace-wt",
        worktree: {
          checkout_path: this.worktree === "mismatch" ? "/elsewhere" : path,
        },
      };
      if (this.worktree === "already-open")
        return this.result({ already_open: true, workspace });
      this.createCount++;
      if (this.uncertainCreate)
        return { exitCode: 0, stdout: "lost create response" };
      this.workspace = "workspace-wt";
      return this.result({
        already_open: false,
        workspace,
        root_pane: this.pane(),
      });
    }
    if (a[0] === "tab" && a[1] === "create") {
      this.createCount++;
      this.workspace = a[a.indexOf("--workspace") + 1];
      if (this.uncertainCreate)
        return { exitCode: 0, stdout: "lost create response" };
      return this.result({ root_pane: this.pane() });
    }
    if (a[1] === "run") {
      const dir = a[3].match(/PI_MEMO_RUNTIME_PROTOCOL_DIR='([^']+)'/)?.[1];
      assert.ok(dir);
      this.boot = await json<Boot>(join(dir, "boot.json"));
      assert.ok(this.boot);
      this.alive = true;
      if (!this.readySuppressed) {
        this.runtime = this.child();
        await this.runtime.start(false);
        await this.runtime.tick();
      }
      if (this.uncertainRun)
        return { exitCode: 0, stdout: "lost run response" };
      if (this.emptyRun) return { exitCode: 0, stdout: "", stderr: "" };
      return this.result({});
    }
    if (this.unavailable)
      return { exitCode: 1, stdout: "", stderr: "backend unavailable" };
    if (this.missing) {
      const error = JSON.stringify({
        error: { code: "pane_not_found", message: "gone" },
      });
      return this.errorsOnStderr
        ? { exitCode: 1, stdout: "", stderr: error }
        : { exitCode: 1, stdout: error };
    }
    if (a[1] === "get") return this.result({ pane: this.pane() });
    if (a[1] === "process-info")
      return this.result({
        process_info: {
          pane_id: this.paneId,
          shell_pid: 8111,
          ...(this.reportedTty === undefined ? {} : { tty: this.reportedTty }),
          foreground_processes: [
            { pid: this.occupant ?? (this.alive ? this.pid : 8111) },
          ],
        },
      });
    if (a[1] === "close") {
      this.closes++;
      this.missing = true;
      return this.result({});
    }
    throw new Error(`Unexpected fake command: ${a.join(" ")}`);
  };
  result(result: unknown) {
    return { exitCode: 0, stdout: JSON.stringify({ result }) };
  }
  pane() {
    return {
      pane_id: this.paneId,
      tab_id: "tab-1",
      workspace_id: this.workspace,
      terminal_id: this.terminal,
    };
  }
  child() {
    assert.ok(this.boot);
    return new ChildRuntime(this.boot, {
      sessionId: this.boot.sessionId,
      sessionPath:
        this.boot.sessionFile ??
        join(this.boot.protocolDir, "sessions", `${this.boot.sessionId}.jsonl`),
      cwd: this.boot.cwd,
      pid: this.pid,
      model: this.boot.model,
      effort: this.boot.effort,
      isIdle: () => this.idle,
      sendPrompt: (prompt, skills) => {
        this.prompts.push(prompt);
        if (skills?.length) this.skills.push(skills);
        this.idle = false;
      },
      abort: () => {
        this.aborts++;
      },
      shutdown: () => {
        this.shutdowns++;
        if (!this.suppressShutdown) this.alive = false;
      },
    });
  }
  async settle(stopReason = "stop", errorMessage?: string) {
    assert.ok(this.runtime);
    this.runtime.agentEnd([
      {
        role: "assistant",
        stopReason,
        errorMessage,
        content: [{ type: "text", text: "Observed summary" }],
      },
    ]);
    await this.runtime.agentSettled();
    this.idle = true;
  }
}
async function fixture(t: { after(fn: () => unknown): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ir-transport-")));
  const cwd = join(root, "checkout with spaces");
  await mkdir(cwd);
  const stateDir = join(root, "private state");
  const fake = new FakeHerdr();
  const config = {
    stateDir,
    piExecutable: "fake-pi",
    herdrExecutable: "fake-herdr",
    runner: fake.runner,
    startupTimeoutMs: 200,
    shellReadyTimeoutMs: 1000,
    shutdownTimeoutMs: 500,
    selector: { owned: new Map() } as SelectorState,
  };
  const transport = new AgentRuntime(config);
  const input: LaunchSpec = {
    scope: "round-1",
    agentId: "agent-1",
    attempt: 1,
    taskId: "task-1",
    cwd,
    model: "provider/exact-model",
    thinking: "high",
    prompt: "Literal prompt; $(no-shell-expansion)\nsecond line",
    tools: WORKER_TOOLS,
    placement: "worktree",
    display: { label: "worker" },
  };
  t.after(async () => {
    transport.dispose();
    fake.runtime?.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return { root, cwd, stateDir, fake, config, transport, input };
}
function errorCode(code: string) {
  return (error: unknown) =>
    error instanceof RuntimeError && error.code === code;
}

test("launch uses explicit cwd/no-focus and observed identities, private session storage and isolated resources", async (t) => {
  const f = await fixture(t);
  const h = await f.transport.launch(f.input);
  assert.equal(h.pid, f.fake.pid);
  assert.equal(h.paneId, "pane-1");
  assert.equal(h.cwd, f.cwd);
  assert.equal(h.taskId, "task-1");
  assert.equal(h.attempt, 1);
  assert.ok(h.sessionId);
  assert.ok(h.processIdentity);
  assert.ok(h.sessionPath.startsWith(f.stateDir));
  assert.deepEqual(f.fake.prompts, [f.input.prompt]);
  const create = f.fake.calls.find((c) => c.argv[0] === "worktree");
  assert.ok(create);
  assert.ok(create.argv.includes("--no-focus"));
  assert.equal(create.argv[create.argv.indexOf("--path") + 1], f.cwd);
  const run = f.fake.calls.find((c) => c.argv[1] === "run");
  assert.ok(run);
  assert.ok(run.argv[3].includes("'-ne' '-e'"));
  assert.ok(run.argv[3].includes("'-ns' '-np' '--no-approve'"));
  assert.ok(!run.argv[3].includes(f.input.prompt));
  // Only the runtime child extension: never the generic subagent-done extension.
  assert.ok(run.argv[3].includes("/runtime/child/extension.ts"));
  assert.ok(!run.argv[3].includes("subagent-done"));
  assert.ok(run.argv[3].includes("'--tools' 'read,bash,edit,write,grep,find,ls'"));
  assert.ok(!run.argv[3].includes("--append-system-prompt"));
  assert.ok(!f.fake.calls.some((c) => c.argv.includes("focus")));
  assert.equal((await f.transport.observe(h)).kind, "active");
});

test("triage opens beside the master pane (split right, no focus); workers keep their own tab", async (t) => {
  const f = await fixture(t);
  const h = await f.transport.launch({ ...f.input, ...TRIAGE });
  assertSingleLaunch(f.fake, 1);
  const split = f.fake.calls.find(
    (c) => c.argv[0] === "pane" && c.argv[1] === "split",
  );
  assert.ok(split, "triage must split the master pane");
  assert.equal(split.argv[2], "master-pane");
  assert.equal(split.argv[split.argv.indexOf("--direction") + 1], "right");
  assert.ok(split.argv.includes("--no-focus"));
  assert.equal(split.argv[split.argv.indexOf("--cwd") + 1], f.cwd);
  assert.ok(!f.fake.calls.some((c) => c.argv[0] === "tab" && c.argv[1] !== "get"));
  assert.ok(
    f.fake.calls.some(
      (c) =>
        c.argv[1] === "rename" &&
        c.argv[2] === h.paneId &&
        c.argv[3] === "triage",
    ),
  );
  assert.ok(!f.fake.calls.some((c) => c.argv.includes("focus")));
  const { records } = await launchEvidence(f.stateDir, {
    ...f.input,
  });
  assert.equal(
    records.find((r) => r.name.endsWith("create-intent.json"))?.data.placement,
    "split-right",
  );
  // A worker (default) gets a worktree space; an explicit "tab" placement a background tab.
  const g = await fixture(t);
  await g.transport.launch(g.input);
  assert.ok(g.fake.calls.some((c) => c.argv[0] === "worktree"));
  assert.ok(!g.fake.calls.some((c) => c.argv[0] === "tab" && c.argv[1] === "create"));
  assert.ok(!g.fake.calls.some((c) => c.argv[1] === "split"));
  const k = await fixture(t);
  await new AgentRuntime(k.config).launch(
    { ...k.input, ...TRIAGE, placement: "tab" },
  );
  assert.ok(k.fake.calls.some((c) => c.argv[0] === "tab" && c.argv[1] === "create"));
});

test("worker opens its checkout as a Herdr worktree space under the master space, labelled as a child", async (t) => {
  const f = await fixture(t);
  const h = await f.transport.launch({
    ...f.input,
    labels: { role: "worker", issue: 56 },
    display: { label: "#56 worker" },
  });
  assertSingleLaunch(f.fake, 1);
  const open = f.fake.calls.find((c) => c.argv[0] === "worktree");
  assert.ok(open);
  assert.deepEqual(open.argv.slice(0, 4), ["worktree", "open", "--workspace", "workspace-1"]);
  assert.equal(open.argv[open.argv.indexOf("--label") + 1], "#56 worker");
  assert.deepEqual(h.labels, { role: "worker", issue: 56 });
  assert.equal(h.workspaceId, "workspace-wt");
  assert.ok(!f.fake.calls.some((c) => c.argv[0] === "tab" && c.argv[1] === "create"));
  const meta = f.fake.calls.find((c) => c.argv[1] === "report-metadata");
  assert.ok(meta);
  assert.equal(meta.argv[2], h.paneId);
  assert.equal(meta.argv[meta.argv.indexOf("--display-agent") + 1], "local-app-PLAN-sub1");
  assert.ok(meta.argv.includes("parent=master-pane"));
  assert.ok(meta.argv.includes("tree_depth=1"));
  // Owned cleanup closes only the exact pane (Herdr then closes the emptied space).
  assert.equal((await f.transport.observe(h)).kind, "active");
});

test("Agents panel name: caller workspace-tab-sub<first free index>, display only", async (t) => {
  assert.equal(subagentPanelName("local-app", "PLAN", 1), "local-app-PLAN-sub1");
  assert.equal(subagentPanelName(undefined, " ", 3), "sub3");
  assert.equal(subagentPanelName("a\nb", "t", 2), "a b-t-sub2");
  assert.equal(nextSubagentIndex([]), 1);
  assert.equal(nextSubagentIndex(["x-PLAN-sub1", "x-PLAN-sub2"]), 3);
  assert.equal(nextSubagentIndex(["x-PLAN-sub2", "\u2514\u2500 old", undefined, "subsub"]), 1);
  assert.equal(nextSubagentIndex(["sub1", "x-y-sub3"]), 2);
  const name = (f: { fake: FakeHerdr }) => {
    const meta = f.fake.calls.find((c) => c.argv[1] === "report-metadata")!;
    return meta.argv[meta.argv.indexOf("--display-agent") + 1];
  };
  // Live subagents of this caller (any client) count; other callers' panes do not.
  const f = await fixture(t);
  f.fake.livePanes = [
    { pane_id: "a", tokens: { parent: "master-pane" }, display_agent: "local-app-PLAN-sub1" },
    { pane_id: "b", tokens: { parent: "master-pane" }, display_agent: "local-app-PLAN-sub2" },
    { pane_id: "c", tokens: { parent: "other-pane" }, display_agent: "local-app-PLAN-sub3" },
    { pane_id: "d" },
  ];
  await f.transport.launch({ ...f.input, placement: "tab" });
  assert.equal(name(f), "local-app-PLAN-sub3");
  const ws = f.fake.calls.find((c) => c.argv[0] === "workspace")!;
  assert.deepEqual(ws.argv, ["workspace", "get", "workspace-1"]);
  assert.deepEqual(f.fake.calls.find((c) => c.argv[0] === "tab" && c.argv[1] === "get")!.argv, ["tab", "get", "tab-1"]);
  // Unreadable labels/panes never fail the launch.
  const u = await fixture(t);
  u.fake.onCall = (c) =>
    ["workspace", "tab"].includes(c.argv[0]) && c.argv[1] === "get"
      ? { exitCode: 1, stdout: "", stderr: JSON.stringify({ error: { code: "x", message: "no" } }) }
      : c.argv[1] === "list"
        ? { exitCode: 0, stdout: "garbage" }
        : undefined;
  const uh = await u.transport.launch(u.input);
  assert.equal(name(u), "sub1");
  assert.equal((await u.transport.observe(uh)).kind, "active");
  // An explicit agentsPanelName wins and reads nothing.
  const e = await fixture(t);
  await e.transport.launch({ ...e.input, display: { label: "w", agentsPanelName: "custom" } });
  assert.equal(name(e), "custom");
  assert.ok(!e.fake.calls.some((c) => c.argv[1] === "list"));
  // Concurrent launches of one caller (separate runtimes) get distinct indices.
  const shared: unknown[] = [];
  const [p, q] = [await fixture(t), await fixture(t)];
  for (const [g, id] of [[p, "p"], [q, "q"]] as const) {
    g.fake.livePanes = shared;
    g.fake.onCall = async (c) => {
      if (c.argv[1] === "list") await new Promise((r) => setTimeout(r, 20));
      if (c.argv[1] === "report-metadata")
        shared.push({
          pane_id: id,
          tokens: { parent: "master-pane" },
          display_agent: c.argv[c.argv.indexOf("--display-agent") + 1],
        });
    };
  }
  await Promise.all([p.transport.launch(p.input), q.transport.launch(q.input)]);
  assert.deepEqual([name(p), name(q)].sort(), ["local-app-PLAN-sub1", "local-app-PLAN-sub2"]);
});

test("worktree space: refusal falls back to a master tab, already-open gets its own tab, mismatch/lost response never run", async (t) => {
  const r = await fixture(t);
  r.fake.worktree = "refused";
  const rh = await r.transport.launch(r.input);
  assert.equal(rh.workspaceId, "workspace-1");
  const tab = r.fake.calls.find((c) => c.argv[0] === "tab" && c.argv[1] === "create");
  assert.ok(tab);
  assert.equal(tab.argv[tab.argv.indexOf("--workspace") + 1], "workspace-1");
  assertSingleLaunch(r.fake, 1);
  const o = await fixture(t);
  o.fake.worktree = "already-open";
  const oh = await o.transport.launch(o.input);
  assert.equal(oh.workspaceId, "workspace-wt");
  const own = o.fake.calls.find((c) => c.argv[0] === "tab" && c.argv[1] === "create");
  assert.ok(own);
  assert.equal(own.argv[own.argv.indexOf("--workspace") + 1], "workspace-wt");
  assertSingleLaunch(o.fake, 1);
  const m = await fixture(t);
  m.fake.worktree = "mismatch";
  await assert.rejects(m.transport.launch(m.input), errorCode("launch_uncertain"));
  assert.equal(m.fake.calls.filter((c) => c.argv[1] === "run").length, 0);
  assert.ok(!m.fake.calls.some((c) => c.argv[0] === "tab" && c.argv[1] === "create"));
  const u = await fixture(t);
  u.fake.uncertainCreate = true;
  await assert.rejects(u.transport.launch(u.input), errorCode("launch_uncertain"));
  assertSingleLaunch(u.fake, 0);
  assert.ok(!u.fake.calls.some((c) => c.argv[0] === "tab" && c.argv[1] === "create"));
});

test("split returning the master pane itself or another tab is refused, never run", async (t) => {
  for (const wrong of ["master", "tab"]) {
    const f = await fixture(t);
    f.fake.onCall = (call) => {
      if (call.argv[1] !== "split") return;
      f.fake.createCount++;
      return f.fake.result({
        pane: {
          ...f.fake.pane(),
          ...(wrong === "master"
            ? { pane_id: "master-pane" }
            : { tab_id: "other-tab" }),
        },
      });
    };
    await assert.rejects(
      f.transport.launch({ ...f.input, ...TRIAGE }),
      errorCode("launch_uncertain"),
      wrong,
    );
    assertSingleLaunch(f.fake, 0);
  }
});

test("Herdr errors on stderr (real 0.9 format) still prove pane closure", async (t) => {
  // Regression: close succeeded but "Unsupported Herdr response (pane get)" left cleanup_uncertain.
  const f = await fixture(t);
  f.fake.errorsOnStderr = true;
  const h = await f.transport.launch({ ...f.input, ...TRIAGE });
  await f.fake.settle();
  await f.transport.stop(h);
  await f.transport.close(h);
  assert.equal(f.fake.closes, 1);
  // The unused-pane retirement after a readiness timeout relies on the same proof.
  const g = await fixture(t);
  g.fake.errorsOnStderr = true;
  g.fake.occupant = 9999;
  await assert.rejects(
    new AgentRuntime({ ...g.config, shellReadyTimeoutMs: 100 }).launch(
      g.input,
    ),
    errorCode("launch_failed"),
  );
  assert.equal(g.fake.closes, 1);
});

test("host child extensions and forwarded env are passed quoted; reserved env names are refused", async (t) => {
  const f = await fixture(t);
  const provider = join(f.root, "provider ext.ts");
  await writeFile(provider, "export default () => {}");
  const transport = new AgentRuntime({
    ...f.config,
    hostExtensions: [provider],
    hostEnv: { CPA_PROXY_CONFIG: "/cfg/it's.yaml" },
  });
  t.after(() => transport.dispose());
  await transport.launch(f.input);
  const run = f.fake.calls.find((c) => c.argv[1] === "run")!.argv[3];
  assert.ok(run.includes(`'-e' '${provider}' '-ns'`));
  assert.ok(run.includes(`CPA_PROXY_CONFIG='/cfg/it'\\''s.yaml' PI_CODING_AGENT_DIR=`));
  const refused: Record<string, string>[] = [
    { PI_MEMO_RUNTIME_SCOPE: "other" },
    { PI_CODING_AGENT_DIR: "/x" },
    { "A;B": "x" },
  ];
  for (const hostEnv of refused) {
    const bad = new AgentRuntime({ ...f.config, hostEnv });
    t.after(() => bad.dispose());
    await assert.rejects(
      bad.launch({ ...f.input, agentId: `bad-${Object.keys(hostEnv)[0]}` }),
      errorCode("unsupported"),
    );
  }
  const missing = new AgentRuntime({ ...f.config, hostExtensions: ["relative.ts"] });
  t.after(() => missing.dispose());
  await assert.rejects(
    missing.launch({ ...f.input, agentId: "bad-relative" }),
    errorCode("unsupported"),
  );
});

async function launchEvidence(
  stateDir: string,
  input: { scope: string; agentId: string; attempt: number },
) {
  const dir = join(
    stateDir,
    "runtime",
    taskKey(`${input.scope}\0${input.agentId}\0${input.attempt}`),
  );
  const files = (await readdir(dir))
    .filter((name) => name.startsWith("launch-") && name.endsWith(".json"))
    .sort();
  const records = await Promise.all(
    files.map(async (name) => ({
      name,
      data: JSON.parse(await readFile(join(dir, name), "utf8")),
    })),
  );
  return { dir, records };
}

function assertSingleLaunch(fake: FakeHerdr, runs: number, closes = 0) {
  assert.equal(fake.createCount, 1);
  assert.equal(fake.calls.filter((c) => c.argv[1] === "run").length, runs);
  assert.equal(fake.closes, closes);
  assert.equal(fake.shutdowns, 0);
}

test("delayed shell/foreground/OS readiness observes only the returned pane before one run", async (t) => {
  const f = await fixture(t);
  let probes = 0;
  f.fake.reportedTty = undefined;
  f.fake.onCall = (call) => {
    if (call.argv[1] !== "process-info") return;
    probes++;
    if (probes <= 2 || probes === 5)
      return f.fake.result({
        process_info: {
          pane_id: "pane-1",
          shell_pid: probes === 1 ? 0 : 8111,
          ...(probes === 1 ? {} : { foreground_processes: [] }),
        },
      });
    f.fake.ttyFailure = probes === 3;
  };
  const h = await f.transport.launch(f.input);
  assertSingleLaunch(f.fake, 1);
  assert.deepEqual(f.fake.prompts, [f.input.prompt]);
  assert.equal(h.shellPid, 8111);
  assert.equal(h.shellProcessIdentity, f.fake.shellIdentity);
  const { records } = await launchEvidence(f.stateDir, f.input);
  const shellProbes = records.filter((r) =>
    r.name.endsWith("shell-probe.json"),
  );
  assert.equal(shellProbes.length, 8); // Incomplete probe resets stability; final pair plus pre-run recheck.
  assert.deepEqual(
    shellProbes.map((r) => r.data.ready),
    [false, false, false, true, false, true, true, true],
  );
  assert.match(shellProbes[2].data.osError, /snapshot unavailable/);
  assert.equal(
    records.find((r) => r.name.endsWith("created.json"))?.data.returned
      .root_pane.terminal_id,
    h.terminalId,
  );
  assert.ok(
    f.fake.calls
      .filter((c) => c.argv[0] === "pane" && c.argv[1] === "get")
      .every((c) => c.argv[2] === h.paneId),
  );
  assert.ok(
    f.fake.calls
      .filter((c) => c.argv[1] === "process-info")
      .every((c) => c.argv[3] === h.paneId),
  );
  assert.deepEqual(f.fake.calls.find((c) => c.argv[1] === "current")?.argv, [
    "pane",
    "current",
    "--current",
  ]);
});

test("vanished or changed newly created pane/occupant fails without adopting or replaying", async (t) => {
  for (const change of [
    "vanished",
    "terminal",
    "tab",
    "workspace",
    "pane",
    "shell-pid",
    "shell-start",
    "shell-tty",
    "occupant",
    "initial-occupant",
    "process-pane",
    "pre-run-occupant",
  ]) {
    const f = await fixture(t);
    let probes = 0;
    let gets = 0;
    f.fake.onCall = (call) => {
      if (call.argv[0] === "pane" && call.argv[1] === "get") {
        gets++;
        if (gets === 2) {
          if (change === "vanished") f.fake.missing = true;
          if (change === "terminal") f.fake.terminal = "replacement";
          if (["tab", "workspace", "pane"].includes(change)) {
            return f.fake.result({
              pane: { ...f.fake.pane(), [`${change}_id`]: "replacement" },
            });
          }
        }
      }
      if (call.argv[1] !== "process-info") return;
      probes++;
      if (probes === 1 && change === "initial-occupant") f.fake.occupant = 9999;
      if (probes === 2) {
        if (change === "process-pane")
          return f.fake.result({
            process_info: {
              pane_id: "replacement",
              shell_pid: 8111,
              foreground_processes: [{ pid: 8111 }],
            },
          });
        if (change === "shell-pid")
          return f.fake.result({
            process_info: {
              pane_id: "pane-1",
              shell_pid: 8222,
              foreground_processes: [{ pid: 8222 }],
            },
          });
        if (change === "shell-start")
          f.fake.shellIdentity = "replacement shell start";
        if (change === "shell-tty") f.fake.shellTty = "ttys-other";
        if (change === "occupant") f.fake.occupant = 9999;
      }
      if (probes === 3 && change === "pre-run-occupant") f.fake.occupant = 9999;
    };
    // A persisting occupant is never typed into: readiness times out and our unused pane is closed.
    const busy = ["occupant", "initial-occupant"].includes(change);
    await assert.rejects(
      f.transport.launch(f.input),
      errorCode(busy ? "launch_failed" : "launch_uncertain"),
      change,
    );
    assertSingleLaunch(f.fake, 0, busy ? 1 : 0);
    const { dir, records } = await launchEvidence(f.stateDir, f.input);
    assert.ok(
      records.some((r) => r.name.endsWith("created.json")),
      change,
    );
    assert.ok(
      records.some(
        (r) =>
          r.name.endsWith("shell-probe.json") &&
          (busy || change === "pre-run-occupant"
            ? /9999/.test(r.data.occupants)
            : r.data.error),
      ),
      change,
    );
    assert.ok(records.at(-1)?.name.endsWith("failed.json"), change);
    assert.equal(records.at(-1)?.data.paneId, "pane-1");
    assert.equal(records.at(-1)?.data.paneClosed, busy, change);
    assert.equal(await json(join(dir, "ready.json")), undefined);
    if (change !== "pre-run-occupant")
      assert.equal(await json(join(dir, "boot.json")), undefined);
    const restarted = new AgentRuntime(f.config);
    await assert.rejects(
      restarted.launch(f.input),
      (e: any) => e.code === "EEXIST",
    );
    assertSingleLaunch(f.fake, 0, busy ? 1 : 0);
  }
});

test("empty foreground or unavailable OS terminal times out with immutable pre-boot evidence", async (t) => {
  for (const mode of ["empty", "no-pid", "no-os-terminal"]) {
    const f = await fixture(t);
    const transport = new AgentRuntime({
      ...f.config,
      shellReadyTimeoutMs: 70,
    });
    f.fake.onCall = (call) => {
      if (call.argv[1] !== "process-info") return;
      if (mode === "no-os-terminal") {
        f.fake.ttyFailure = true;
        return;
      }
      return f.fake.result({
        process_info: {
          pane_id: "pane-1",
          shell_pid: mode === "no-pid" ? 0 : 8111,
          foreground_processes: [],
        },
      });
    };
    const start = Date.now();
    await assert.rejects(
      transport.launch(f.input),
      (e: unknown) =>
        errorCode("launch_failed")(e) && /timed out/.test(String(e)),
      mode,
    );
    assert.ok(Date.now() - start < 1000, "bounded fake observation");
    assertSingleLaunch(f.fake, 0, 1); // Nothing typed: the unused pane is retired.
    const { dir, records } = await launchEvidence(f.stateDir, f.input);
    assert.equal(await json(join(dir, "boot.json")), undefined);
    const probes = records.filter((r) => r.name.endsWith("shell-probe.json"));
    assert.ok(probes.length >= 2);
    assert.ok(probes.every((r) => r.data.ready === false));
    assert.match(records.at(-1)?.data.error, /timed out/);
    // Existing records cannot be replaced, including by recovery.
    const first = records[0];
    const original = await readFile(join(dir, first.name), "utf8");
    await assert.rejects(
      publish(join(dir, first.name), {}),
      (e: any) => e.code === "EEXIST",
    );
    assert.equal(await readFile(join(dir, first.name), "utf8"), original);
    await assert.rejects(
      new AgentRuntime(f.config).launch(f.input),
      (e: any) => e.code === "EEXIST",
    );
    assertSingleLaunch(f.fake, 0, 1);
  }
});

test("readiness probe commands use remaining timeout and a late snapshot never runs", async (t) => {
  const f = await fixture(t);
  f.fake.onCall = async (call) => {
    if (call.argv[1] !== "process-info") return;
    assert.ok(call.timeoutMs! > 0 && call.timeoutMs! <= 30);
    await new Promise((resolve) => setTimeout(resolve, 40)); // Simulate runner returning after its bound.
  };
  await assert.rejects(
    new AgentRuntime({ ...f.config, shellReadyTimeoutMs: 30 }).launch(
      f.input,
    ),
    errorCode("launch_failed"),
  );
  assertSingleLaunch(f.fake, 0, 1);
});

test("transient shell-startup foreground process (e.g. locale from .zshrc) delays readiness, then one run", async (t) => {
  const f = await fixture(t);
  let probes = 0;
  f.fake.onCall = (call) => {
    if (call.argv[1] !== "process-info") return;
    if (++probes <= 2)
      return f.fake.result({
        process_info: {
          pane_id: "pane-1",
          shell_pid: 8111,
          tty: "/dev/ttys-test",
          foreground_processes: [
            { pid: 8222, name: "locale", cmdline: "locale LC_CTYPE" },
            { pid: 8111, name: "zsh", cmdline: "-zsh" },
          ],
        },
      });
  };
  const h = await f.transport.launch(f.input);
  assert.equal(h.shellPid, 8111);
  assertSingleLaunch(f.fake, 1);
  const { records } = await launchEvidence(f.stateDir, f.input);
  const busy = records.filter(
    (r) => r.name.endsWith("shell-probe.json") && r.data.occupants,
  );
  assert.equal(busy.length, 2);
  assert.match(busy[0].data.occupants, /locale LC_CTYPE/);
  assert.ok(busy.every((r) => r.data.ready === false && !r.data.error));
});

test("persistent occupant times out naming it; a pane whose identity changed is never closed", async (t) => {
  for (const changed of [false, true]) {
    const f = await fixture(t);
    f.fake.occupant = 9999;
    f.fake.onCall = (call) => {
      // Only the pre-closure identity re-check (no cwd) observes a different terminal.
      if (changed && call.argv[1] === "get" && call.cwd === undefined)
        f.fake.terminal = "replacement";
    };
    await assert.rejects(
      new AgentRuntime({ ...f.config, shellReadyTimeoutMs: 150 }).launch(
        f.input,
      ),
      (e: unknown) =>
        errorCode(changed ? "launch_uncertain" : "launch_failed")(e) &&
        /foreground still busy \(9999\)/.test(String(e)),
      String(changed),
    );
    assertSingleLaunch(f.fake, 0, changed ? 0 : 1);
    const { records } = await launchEvidence(f.stateDir, f.input);
    assert.equal(records.at(-1)?.data.paneClosed, !changed);
  }
});

test("uncertain create/run responses preserve single-shot effects and launch phase evidence", async (t) => {
  for (const mode of ["create", "run"]) {
    const f = await fixture(t);
    f.fake.uncertainCreate = mode === "create";
    f.fake.uncertainRun = mode === "run";
    await assert.rejects(
      f.transport.launch(f.input),
      errorCode("launch_uncertain"),
    );
    assertSingleLaunch(f.fake, mode === "run" ? 1 : 0);
    assert.equal(f.fake.prompts.length, mode === "run" ? 1 : 0);
    const { records } = await launchEvidence(f.stateDir, f.input);
    assert.ok(records.some((r) => r.name.endsWith(`${mode}-intent.json`)));
    assert.equal(records.at(-1)?.data.phase, mode);
    assert.match(records.at(-1)?.data.error, /Unsupported Herdr response/);
    await assert.rejects(
      new AgentRuntime(f.config).launch(f.input),
      (e: any) => e.code === "EEXIST",
    );
    assertSingleLaunch(f.fake, mode === "run" ? 1 : 0);
  }
});

test("Herdr 0.9 empty pane run acknowledgement is a successful single launch", async (t) => {
  const f = await fixture(t);
  f.fake.emptyRun = true;
  const h = await f.transport.launch(f.input);
  assert.equal(h.pid, f.fake.pid);
  assertSingleLaunch(f.fake, 1);
});

test("missing Herdr tty uses exact OS shell/child terminal through launch, reuse, shutdown and pane close", async (t) => {
  const f = await fixture(t);
  f.fake.reportedTty = undefined;
  const h = await f.transport.launch({ ...f.input, ...MERGER });
  assert.equal(h.tty, "ttys-test");
  assert.equal(h.shellProcessIdentity, f.fake.shellIdentity);
  assert.equal((await f.transport.observe(h)).kind, "active");
  await f.fake.settle();
  const next = await f.transport.dispatch(h, {
    taskId: "next",
    prompt: "second task",
  });
  await f.fake.runtime!.tick();
  await f.fake.settle();
  await f.transport.stop(next);
  await f.transport.close(next);
  assert.equal(f.fake.shutdowns, 1);
  assert.equal(f.fake.closes, 1);
  assert.ok(
    f.fake.calls.some(
      (c) =>
        c.argv[0] === "pane" &&
        c.argv[1] === "current" &&
        c.argv.includes("--current"),
    ),
  );
});

test("OS terminal changes, shell PID reuse and read failures block control even without Herdr tty", async (t) => {
  const f = await fixture(t);
  f.fake.reportedTty = undefined;
  const h = await f.transport.launch(f.input);
  await f.fake.settle();
  f.fake.childTty = "ttys-other";
  assert.equal((await f.transport.observe(h)).kind, "changed");
  await assert.rejects(f.transport.stop(h));
  assert.equal(f.fake.shutdowns, 0);
  f.fake.childTty = h.tty;
  f.fake.shellTty = "ttys-other";
  assert.equal((await f.transport.observe(h)).kind, "changed");
  f.fake.shellTty = h.tty;
  f.fake.shellIdentity = "different shell";
  assert.equal((await f.transport.observe(h)).kind, "changed");
  f.fake.shellIdentity = h.shellProcessIdentity!;
  f.fake.ttyFailure = true;
  assert.equal((await f.transport.observe(h)).kind, "changed");
  await assert.rejects(f.transport.close(h));
  assert.equal(f.fake.closes, 0);
});

test("provided Herdr tty must agree with OS rather than override it", async (t) => {
  const f = await fixture(t);
  f.fake.reportedTty = "/dev/ttys-other";
  await assert.rejects(
    f.transport.launch(f.input),
    errorCode("launch_uncertain"),
  );
  assert.equal(
    f.fake.calls.some((c) => c.argv[1] === "run"),
    false,
  );
});

test("missing OS terminal fails before child start; post-exit mismatch prevents pane closure", async (t) => {
  const f = await fixture(t);
  f.fake.reportedTty = undefined;
  f.fake.shellTty = "?";
  await assert.rejects(
    f.transport.launch(f.input),
    errorCode("launch_failed"),
  );
  assert.equal(f.fake.closes, 1);
  assert.equal(
    f.fake.calls.some((c) => c.argv[1] === "run"),
    false,
  );
  const g = await fixture(t);
  g.fake.reportedTty = undefined;
  const h = await g.transport.launch(g.input);
  await g.fake.settle();
  await g.transport.stop(h);
  g.fake.shellTty = "ttys-other";
  await assert.rejects(g.transport.close(h), errorCode("cleanup_blocked"));
  assert.equal(g.fake.closes, 0);
});

test("agent_end is not completion; provider failure is recorded only at agent_settled and never deletes evidence", async (t) => {
  const f = await fixture(t);
  const h = await f.transport.launch(f.input);
  f.fake.runtime!.agentEnd([
    {
      role: "assistant",
      stopReason: "error",
      errorMessage: "provider unavailable",
    },
  ]);
  assert.equal((await f.transport.observe(h)).kind, "active");
  await f.fake.runtime!.agentSettled();
  f.fake.idle = true;
  const o = await f.transport.observe(h);
  assert.equal(o.kind, "settled");
  assert.equal(o.completion?.status, "error");
  assert.equal(o.completion?.error, "provider unavailable");
  await f.fake.runtime!.agentSettled();
  assert.equal(
    (await f.transport.observe(h)).completion?.recordId,
    o.completion?.recordId,
  );
  assert.ok(
    await readFile(taskFile(h.protocolDir, h.taskId, "settled"), "utf8"),
  );
});

test("stale identities and unaccepted completion cannot settle a task; duplicate dispatch is refused", async (t) => {
  const f = await fixture(t);
  const h = await f.transport.launch(f.input);
  await publish(
    taskFile(h.protocolDir, h.taskId, "settled"),
    record({ ...h, attempt: 9 }, "settled", { status: "success" }),
  );
  assert.equal((await f.transport.observe(h)).kind, "active");
  await assert.rejects(
    f.transport.dispatch(h, { taskId: "task-2", prompt: "new" }),
    errorCode("busy"),
  );
  await assert.rejects(
    f.transport.launch(f.input),
    (e: any) => e.code === "EEXIST",
  );
  assert.equal(f.fake.createCount, 1);
});

test("reusable merger receives two correlated tasks, rejects stale/duplicate evidence and does not auto-terminate at idle", async (t) => {
  const f = await fixture(t);
  const h = await f.transport.launch({ ...f.input, ...MERGER });
  await f.fake.settle();
  assert.equal(f.fake.shutdowns, 0);
  assert.equal(f.fake.closes, 0);
  const next = await f.transport.dispatch(h, {
    taskId: "task-2",
    prompt: "Integrate next exact result",
  });
  assert.equal(next.sessionId, h.sessionId);
  assert.equal(next.pid, h.pid);
  assert.notEqual(next.taskToken, h.taskToken);
  assert.equal((await f.transport.observe(h)).kind, "changed");
  assert.equal((await f.transport.observe(next)).kind, "starting");
  await f.fake.runtime!.tick();
  assert.equal((await f.transport.observe(next)).kind, "active");
  await publish(
    taskFile(next.protocolDir, next.taskId, "settled"),
    record(h, "settled", { status: "success" }),
  );
  assert.equal((await f.transport.observe(next)).kind, "active");
  // Fault injection leaves a conflicting record; preserve it, rather than pretending success.
  await assert.rejects(f.fake.settle(), /Conflicting settlement/);
  assert.equal(f.fake.createCount, 1);
  assert.equal(f.fake.shutdowns, 0);
});

test("merger bridge: only declared tools, params reach the parent untrusted, correlated immutable result, then session reuse and shutdown", async (t) => {
  const f = await fixture(t);
  const h = await f.transport.launch({ ...f.input, ...MERGER });
  await assert.rejects(
    f.fake.runtime!.delegate("undeclared", {}, "call-0"),
    /restricted to the active task/,
  );
  const pending = f.fake.runtime!.delegate(
    "ir_integrate",
    { taskId: h.taskId },
    "call-1",
  );
  // request publication is asynchronous; await event/file publication without a live process.
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 500;
    const check = async () => {
      if ((await f.transport.drainRequests(h)).length) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("fixture request timeout"));
        return;
      }
      setTimeout(() => {
        void check();
      }, 5);
    };
    void check();
  });
  const [request] = await f.transport.drainRequests(h);
  assert.equal(request.tool, "ir_integrate");
  assert.equal(request.taskId, h.taskId);
  assert.deepEqual(request.params, { taskId: h.taskId });
  // Assignment checks belong to the parent: params are untrusted model input.
  assert.equal((request.params as { taskId: string }).taskId === h.taskId, true);
  assert.equal(request.requestId, `${h.taskToken}-ir_integrate`);
  assert.equal(await f.transport.hasResponse(h, request.requestId!), false);
  await assert.rejects(
    f.transport.respond(h, "foreign-request", {}),
    errorCode("busy"),
  );
  const result = { passed: true, receipt: "coordinator-observed" };
  await f.transport.respond(h, request.requestId!, result);
  assert.deepEqual(await pending, result);
  assert.equal(await f.transport.hasResponse(h, request.requestId!), true);
  await assert.rejects(
    f.transport.respond(h, request.requestId!, result),
    (e: any) => e.code === "EEXIST",
  );
  await f.fake.settle();
  assert.equal(f.fake.shutdowns, 0);
  const next = await f.transport.dispatch(h, {
    taskId: "task-2",
    prompt: "Next integration",
  });
  await f.fake.runtime!.tick();
  assert.equal((await f.transport.drainRequests(next)).length, 0);
  await f.fake.settle();
  await assert.rejects(
    f.transport.dispatch(next, { taskId: "task-1", prompt: "duplicate" }),
    (e: any) => e.code === "EEXIST",
  );
  await f.transport.stop(next);
  assert.equal(f.fake.shutdowns, 1);
  assert.equal(f.fake.closes, 0);
  assert.equal((await f.transport.observe(next)).kind, "stopped");
  await f.transport.close(next);
  await f.transport.close(next);
  assert.equal(f.fake.closes, 1);
  assert.equal(f.fake.createCount, 1);
});

test("reload/cold coordinator restart reconstruct from handle without spawn/prompt replay and keep one observer", async (t) => {
  const f = await fixture(t);
  const h = await f.transport.launch(f.input);
  f.fake.runtime!.dispose();
  f.fake.runtime = f.fake.child();
  await f.fake.runtime.start(false);
  await f.fake.runtime.tick();
  assert.equal(f.fake.prompts.length, 1);
  const restarted = new AgentRuntime(f.config);
  t.after(() => restarted.dispose());
  assert.equal(
    (await restarted.observe(JSON.parse(JSON.stringify(h)))).kind,
    "active",
  );
  const events: string[] = [];
  const dispose = restarted.watch(
    h,
    (o) => {
      events.push(o.kind);
    },
    25,
  );
  assert.throws(() => f.transport.watch(h, () => {}), errorCode("busy"));
  dispose();
  dispose();
  const dispose2 = f.transport.watch(h, () => {});
  dispose2();
  await f.fake.settle();
  assert.equal((await restarted.observe(h)).kind, "settled");
  assert.equal(f.fake.prompts.length, 1);
  assert.equal(f.fake.createCount, 1);
});

test("cold child restart with different PID is refused rather than replaying an accepted task", async (t) => {
  const f = await fixture(t);
  await f.transport.launch(f.input);
  f.fake.runtime!.dispose();
  f.fake.pid++;
  const child = f.fake.child();
  await assert.rejects(child.start(false), /restart\/identity changed/);
  child.dispose();
  assert.equal(f.fake.prompts.length, 1);
});

test("interrupt is private and correlated, does not fabricate completion or terminate child", async (t) => {
  const f = await fixture(t);
  const h = await f.transport.launch(f.input);
  await assert.rejects(f.transport.stop(h), errorCode("cleanup_blocked"));
  await f.transport.interrupt(h);
  await f.fake.runtime!.tick();
  assert.equal(f.fake.aborts, 1);
  assert.equal(f.fake.shutdowns, 0);
  assert.equal((await f.transport.observe(h)).kind, "active");
  await f.fake.settle("aborted");
  assert.equal(
    (await f.transport.observe(h)).completion?.status,
    "interrupted",
  );
  await f.fake.runtime!.tick();
  assert.equal(f.fake.aborts, 1);
  await f.transport.stop(h);
  await f.transport.close(h);
});

test("vanished pane and backend failure retain correlated evidence but never authorize unsafe cleanup", async (t) => {
  const f = await fixture(t);
  const h = await f.transport.launch(f.input);
  await f.fake.settle();
  f.fake.missing = true;
  const gone = await f.transport.observe(h);
  assert.equal(gone.kind, "missing");
  assert.equal(gone.completion?.status, "success");
  await assert.rejects(f.transport.stop(h), errorCode("cleanup_uncertain"));
  f.fake.missing = false;
  f.fake.unavailable = true;
  const outage = await f.transport.observe(h);
  assert.equal(outage.kind, "unavailable");
  assert.equal(outage.exited, undefined);
  f.fake.unavailable = false;
  f.fake.alive = false; // user quit the child without an orderly shutdown
  const exited = await f.transport.observe(h);
  assert.equal(exited.kind, "unavailable");
  assert.equal(exited.exited, true);
  assert.equal(f.fake.shutdowns, 0);
  assert.equal(f.fake.closes, 0);
});

test("changed terminal, PID identity, foreground occupant and takeover block owned cleanup", async (t) => {
  const f = await fixture(t);
  const h = await f.transport.launch(f.input);
  await f.fake.settle();
  f.fake.terminal = "replacement-terminal";
  assert.equal((await f.transport.observe(h)).kind, "changed");
  await assert.rejects(f.transport.stop(h), errorCode("cleanup_blocked"));
  f.fake.terminal = h.terminalId;
  f.fake.processIdentity = "different process";
  await assert.rejects(f.transport.stop(h), errorCode("cleanup_blocked"));
  f.fake.processIdentity = h.processIdentity;
  f.fake.occupant = 9999;
  await assert.rejects(f.transport.stop(h), errorCode("cleanup_blocked"));
  f.fake.occupant = undefined;
  await f.fake.runtime!.takeover();
  assert.equal((await f.transport.observe(h)).kind, "taken-over");
  await assert.rejects(f.transport.stop(h), errorCode("cleanup_blocked"));
  assert.equal(f.fake.shutdowns, 0);
  assert.equal(f.fake.closes, 0);
});

test("shutdown ack alone is not process exit, bounded wait does not kill or close an uncertain pane", async (t) => {
  const f = await fixture(t);
  const h = await f.transport.launch(f.input);
  await f.fake.settle();
  f.fake.suppressShutdown = true;
  await assert.rejects(f.transport.stop(h), errorCode("cleanup_uncertain"));
  await assert.rejects(f.transport.close(h), errorCode("cleanup_blocked"));
  assert.equal(f.fake.shutdowns, 1);
  assert.equal(f.fake.closes, 0);
  assert.ok(
    !f.fake.calls.some(
      (c) => c.executable === "kill" || c.argv.includes("send-keys"),
    ),
  );
  // Reload recovery: same acknowledged child has now genuinely exited.
  f.fake.alive = false;
  await f.transport.stop(h);
  f.fake.occupant = 9999;
  await assert.rejects(f.transport.close(h), errorCode("cleanup_blocked"));
  f.fake.occupant = undefined;
  await f.transport.close(h);
  assert.equal(f.fake.closes, 1);
});

test("unsupported CLI fails before pane creation; readiness failure is launch_uncertain and reserves attempt", async (t) => {
  const f = await fixture(t);
  f.fake.cliUnsupported = true;
  await assert.rejects(f.transport.launch(f.input), errorCode("unsupported"));
  assert.equal(f.fake.createCount, 0);
  const { scope, agentId } = f.input;
  assert.equal(await f.transport.attemptAllocated(scope, agentId, 1), false);
  f.fake.cliUnsupported = false;
  f.fake.readySuppressed = true;
  await assert.rejects(
    f.transport.launch({ ...f.input, attempt: 2 }),
    errorCode("launch_uncertain"),
  );
  assert.equal(f.fake.createCount, 1);
  assert.equal(await f.transport.attemptAllocated(scope, agentId, 2), true);
  await assert.rejects(
    f.transport.launch({ ...f.input, attempt: 2 }),
    (e: any) => e.code === "EEXIST",
  );
  assert.equal(f.fake.createCount, 1);
});

test("attemptAllocated rethrows errors other than ENOENT: no proof, never a false 'not allocated'", async (t) => {
  const f = await fixture(t);
  // The runtime root is a regular file: stat of the attempt directory fails with ENOTDIR.
  await mkdir(f.stateDir, { recursive: true });
  await writeFile(join(f.stateDir, "runtime"), "not a directory");
  await assert.rejects(
    new AgentRuntime(f.config).attemptAllocated(f.input.scope, f.input.agentId, 1),
    (e: any) => e.code === "ENOTDIR",
  );
});

test("settled record without matching acceptance is not completion evidence", async (t) => {
  const f = await fixture(t);
  const h = await f.transport.launch(f.input);
  await f.fake.settle();
  await unlink(taskFile(h.protocolDir, h.taskId, "accepted"));
  const observation = await f.transport.observe(h);
  assert.equal(observation.kind, "starting");
  assert.equal(observation.completion, undefined);
});

test("child rejects model fallback or effort clamping at readiness", async (t) => {
  const f = await fixture(t);
  await f.transport.launch(f.input);
  f.fake.runtime!.dispose();
  const wrongBoot = { ...f.fake.boot!, model: "provider/unapproved-fallback" };
  const child = new ChildRuntime(wrongBoot, {
    sessionId: wrongBoot.sessionId,
    sessionPath: join(wrongBoot.protocolDir, "sessions", "observed.jsonl"),
    cwd: wrongBoot.cwd,
    pid: f.fake.pid,
    model: f.input.model,
    effort: "medium",
    isIdle: () => true,
    sendPrompt: () => assert.fail("must not prompt"),
    abort: () => {},
    shutdown: () => {},
  });
  await assert.rejects(child.start(false), /identity mismatch/);
  child.dispose();
});

const policyOf = (spec: {
  tools: string[];
  bash?: "unrestricted" | "readonly";
  question?: boolean;
  delegatedTools?: DelegatedToolSpec[];
}) => ({
  tools: spec.tools,
  denyTools: [] as string[],
  bash: spec.bash ?? ("unrestricted" as const),
  bashAllow: [] as string[],
  bashAsk: false,
  question: spec.question === true,
  delegatedTools: spec.delegatedTools ?? [],
  userInput: "takeover" as const,
  exit: "parent" as const,
});
const WORKER_POLICY = policyOf({ tools: WORKER_TOOLS });
const TRIAGE_POLICY = policyOf(TRIAGE);
const REVIEWER_POLICY = policyOf({ tools: READ_ONLY_TOOLS, bash: "readonly" });
const MERGER_POLICY = policyOf(MERGER);

test("child tool policy is narrow and settlement distinguishes error/interruption", () => {
  // Only allowlisted and declared tools are active.
  assert.equal(childToolCall(MERGER_POLICY, "ir_integrate", { taskId: "x" }), undefined);
  assert.equal(childToolCall(MERGER_POLICY, "bash", { command: "pwd" })?.block, true);
  assert.equal(childToolCall(WORKER_POLICY, "subagent", {})?.block, true);
  assert.equal(childToolCall(WORKER_POLICY, "ir_integrate", {})?.block, true);
  // Read-only policies get bash only through the shared read-only guard.
  for (const [name, policy] of [
    ["triage", TRIAGE_POLICY],
    ["reviewer", REVIEWER_POLICY],
  ] as const) {
    assert.equal(
      childToolCall(policy, "bash", { command: "git log -5 --oneline" }),
      undefined,
      name,
    );
    for (const command of ["git commit -m x", "rm -rf x", "git log | head", "gh issue view 1"])
      assert.match(
        childToolCall(policy, "bash", { command })?.reason ?? "",
        /not an allowed read-only form/,
        `${name}: ${command}`,
      );
    assert.equal(childToolCall(policy, "bash", {})?.block, true);
    assert.equal(childToolCall(policy, "write", {})?.block, true);
  }
  assert.equal(childToolCall(WORKER_POLICY, "bash", { command: "npm test" }), undefined);
  assert.equal(childToolCall(undefined, "read", {})?.block, true);
  assert.equal(settledResult([]).status, "error");
  assert.equal(
    settledResult([{ role: "assistant", stopReason: "aborted" }]).status,
    "interrupted",
  );
  assert.equal(
    settledResult([{ role: "assistant", stopReason: "error" }]).status,
    "error",
  );
});

test("invalid tool policies are refused before any pane is created", async (t) => {
  const f = await fixture(t);
  const bad: Partial<LaunchSpec>[] = [
    { tools: ["read", "bad name"] },
    { bash: "sometimes" as any },
    { delegatedTools: [{ ...INTEGRATE, name: "read" }], tools: ["read"] },
    { delegatedTools: [INTEGRATE, INTEGRATE] },
    { delegatedTools: [{ ...INTEGRATE, name: "question" }] },
    { delegatedTools: [{ ...INTEGRATE, once: "always" as any }] },
    { appendSystemPrompt: ["relative.md"] },
    { tools: ["read", "question"], question: true },
    { delegatedTools: [{ ...INTEGRATE, name: "bash" }] },
    { delegatedTools: [{ ...INTEGRATE, name: "write" }], tools: ["read"] },
    { delegatedTools: [{ ...INTEGRATE, parameters: [] as any }] },
    { thinking: "extreme" as any },
    { display: { label: "" } },
  ];
  for (const [index, patch] of bad.entries())
    await assert.rejects(
      f.transport.launch({ ...f.input, agentId: `bad-${index}`, ...patch }),
      errorCode("unsupported"),
      JSON.stringify(patch),
    );
  assert.equal(f.fake.createCount, 0);
});

// The runtime prefers a pi-installed pi-memo-question over the bundled dependency: expect what it resolves.
const QUESTION_EXTENSION =
  resolveQuestionExtension() ??
  realpathSync(fileURLToPath(new URL("../../node_modules/pi-memo-question/extensions/question.ts", import.meta.url)));

test("question is pi-memo-question's tool: loaded with question: true, observed for any child with a task", async (t) => {
  assert.equal(childToolCall(WORKER_POLICY, "question", {})?.block, true);
  assert.equal(childToolCall(TRIAGE_POLICY, "question", {}), undefined);
  const f = await fixture(t);
  const h = await f.transport.launch({ ...f.input, ...PLANNER });
  const run = f.fake.calls.find((c) => c.argv[1] === "run")!;
  assert.match(run.argv[3], /'--tools' 'read,bash,grep,find,ls,question'/);
  assert.ok(run.argv[3].includes(`/runtime/child/extension.ts' '-e' '${QUESTION_EXTENSION}'`));
  assert.equal((await f.transport.observe(h)).question, undefined);
  await f.fake.runtime!.question("q1", "Push o solo merge?");
  assert.deepEqual((await f.transport.observe(h)).question, {
    id: "q1",
    text: "Push o solo merge?",
    pending: true,
  });
  await f.fake.runtime!.question("q1", "Push o solo merge?", "Solo merge");
  assert.equal((await f.transport.observe(h)).question?.pending, false);
  // Isolated children without the flag do not load it; a record is still observed if one is written.
  const w = await fixture(t);
  const wh = await w.transport.launch(w.input);
  assert.ok(!w.fake.calls.find((c) => c.argv[1] === "run")!.argv[3].includes("pi-memo-question"));
  await w.fake.runtime!.question("q", "?");
  assert.equal((await w.transport.observe(wh)).question?.pending, true);
  // question: true without the package is refused before any pane.
  const n = await fixture(t);
  await assert.rejects(
    new AgentRuntime({ ...n.config, questionExtension: null }).launch({ ...n.input, ...PLANNER }),
    errorCode("unsupported"),
  );
  assert.equal(n.fake.createCount, 0);
});

test("focus moves between master and split child only through the exact neighbor; tabs never move", async (t) => {
  const f = await fixture(t);
  const h = await f.transport.launch({ ...f.input, ...PLANNER });
  assert.equal(h.parentPaneId, "master-pane");
  assert.equal(h.placement, "split-right");
  let neighbor = "pane-1";
  const moves: string[][] = [];
  f.fake.onCall = (call) => {
    if (call.argv[1] === "neighbor")
      return f.fake.result({ neighbor: { pane_id: neighbor } });
    if (call.argv[1] === "focus") {
      moves.push(call.argv);
      return f.fake.result({});
    }
  };
  assert.equal(await f.transport.focus(h, "child"), true);
  assert.deepEqual(moves.at(-1), [
    "pane",
    "focus",
    "--pane",
    "master-pane",
    "--direction",
    "right",
  ]);
  neighbor = "master-pane";
  assert.equal(await f.transport.focus(h, "parent"), true);
  assert.deepEqual(moves.at(-1), [
    "pane",
    "focus",
    "--pane",
    "pane-1",
    "--direction",
    "left",
  ]);
  // Layout changed (another pane in between, or no neighbor = self): stay put.
  neighbor = "someone-else";
  assert.equal(await f.transport.focus(h, "child"), false);
  assert.equal(moves.length, 2);
  // A worker in its own tab has no master beside it.
  const w = await fixture(t);
  const wh = await w.transport.launch(w.input);
  const before = w.fake.calls.length;
  assert.equal(await w.transport.focus(wh, "child"), false);
  assert.equal(w.fake.calls.length, before);
});

test("system prompts, labels and per-call delegated tools reach the child unchanged", async (t) => {
  const f = await fixture(t);
  const role = join(f.root, "role prompt.md");
  await writeFile(role, "You are a worker.");
  const NOTE: DelegatedToolSpec = {
    name: "note",
    description: "Send a note to the parent.",
    parameters: { type: "object", properties: { text: { type: "string" } } },
  };
  const h = await f.transport.launch({
    ...f.input,
    labels: { role: "worker", issue: 7 },
    delegatedTools: [NOTE],
    appendSystemPrompt: [role],
  });
  const run = f.fake.calls.find((c) => c.argv[1] === "run")!.argv[3];
  assert.ok(run.includes(`'--append-system-prompt' '${role}'`));
  assert.ok(run.includes("'--tools' 'read,bash,edit,write,grep,find,ls,note'"));
  assert.deepEqual(f.fake.boot!.labels, { role: "worker", issue: 7 });
  assert.deepEqual(f.fake.boot!.policy.delegatedTools, [NOTE]);
  // Without once: per-task, each tool call gets its own request id.
  const first = f.fake.runtime!.delegate("note", { text: "a" }, "call-a");
  await new Promise((r) => setTimeout(r, 50));
  const [request] = await f.transport.drainRequests(h);
  assert.equal(request.requestId, `${h.taskToken}-note-call-a`);
  await f.transport.respond(h, request.requestId!, { ok: 1 });
  assert.deepEqual(await first, { ok: 1 });
  const missing = await fixture(t);
  const absent = join(missing.root, "absent.md");
  await assert.rejects(
    missing.transport.launch({ ...missing.input, appendSystemPrompt: [absent] }),
    errorCode("unsupported"),
  );
  assert.equal(missing.fake.createCount, 0);
  // `unsupported` creates nothing: the same attempt can still be launched.
  await writeFile(absent, "late prompt");
  await missing.transport.launch({ ...missing.input, appendSystemPrompt: [absent] });
  assert.equal(missing.fake.createCount, 1);
});

test("inspectShutdown reports exact ack, exit and takeover for reconciliation", async (t) => {
  const f = await fixture(t);
  const h = await f.transport.launch(f.input);
  assert.deepEqual(await f.transport.inspectShutdown(h), {
    acknowledged: false,
    exited: false,
    pidReused: false,
    takenOver: false,
  });
  // A reused PID is not the exact child: reported as exited and reused, never "still running".
  f.fake.processIdentity = "Wed Oct 7 00:00:00 2026 unrelated";
  assert.deepEqual(await f.transport.inspectShutdown(h), {
    acknowledged: false,
    exited: true,
    pidReused: true,
    takenOver: false,
  });
  const g = await fixture(t);
  const gh = await g.transport.launch(g.input);
  await g.fake.settle();
  await g.transport.stop(gh);
  assert.deepEqual(await g.transport.inspectShutdown(gh), {
    acknowledged: true,
    exited: true,
    pidReused: false,
    takenOver: false,
  });
  g.fake.onCall = (call) => {
    if (call.executable === "ps") return { exitCode: 2, stdout: "", stderr: "ps broken" };
  };
  await assert.rejects(g.transport.inspectShutdown(gh), errorCode("cleanup_uncertain"));
});

test("presence: one display row per agent, updated by the runtime and annotated by the client", async (t) => {
  const f = await fixture(t);
  const rows = () => presence().list().filter((r) => r.key.startsWith(f.stateDir));
  const h = await f.transport.launch({
    ...f.input,
    display: { label: "#3 worker", group: "Issue Round" },
  });
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].group, "Issue Round");
  assert.equal(rows()[0].label, "#3 worker");
  assert.equal(rows()[0].paneId, "pane-1");
  assert.equal(rows()[0].model, "provider/exact-model");
  assert.equal(rows()[0].thinking, "high");
  assert.equal((await f.transport.observe(h)).kind, "active");
  assert.equal(rows()[0].state, "active");
  f.transport.annotate(h, { status: "in verifica", active: false });
  assert.equal(rows()[0].status, "in verifica");
  assert.equal(rows()[0].active, false);
  // A second copy of the module (e.g. a client import next to the -e extension) shares the rows.
  const copy = await import(
    "../../pi-extension/subagents/runtime/presence.ts?second-copy"
  );
  assert.notEqual(copy.presence, presence);
  assert.equal(
    copy.presence().list().filter((r: any) => r.key.startsWith(f.stateDir)).length,
    1,
  );
  await f.fake.settle();
  await f.transport.stop(h);
  assert.equal(rows()[0].state, "stopped");
  await f.transport.close(h);
  assert.equal(rows().length, 0);
  // forget retires a row early; a definitely failed launch leaves none.
  const g = await fixture(t);
  const gh = await g.transport.launch(g.input);
  g.transport.forget(gh);
  assert.equal(presence().list().filter((r) => r.key.startsWith(g.stateDir)).length, 0);
  const k = await fixture(t);
  k.fake.occupant = 9999;
  await assert.rejects(
    new AgentRuntime({ ...k.config, shellReadyTimeoutMs: 100 }).launch(k.input),
    errorCode("launch_failed"),
  );
  assert.equal(presence().list().filter((r) => r.key.startsWith(k.stateDir)).length, 0);
  const u = await fixture(t);
  u.fake.uncertainRun = true;
  u.fake.readySuppressed = true;
  await assert.rejects(u.transport.launch(u.input), errorCode("launch_uncertain"));
  const uncertain = presence().list().filter((r) => r.key.startsWith(u.stateDir));
  assert.equal(uncertain.length, 1);
  assert.equal(uncertain[0].state, "launch-uncertain");
  u.transport.forget({ protocolDir: uncertain[0].key } as any);
});

test("once-per-task delegated tools never reuse a result for different arguments", async (t) => {
  const f = await fixture(t);
  const h = await f.transport.launch({ ...f.input, ...MERGER });
  const first = f.fake.runtime!.delegate("ir_integrate", { taskId: h.taskId }, "c1");
  await new Promise((r) => setTimeout(r, 50));
  const [request] = await f.transport.drainRequests(h);
  await f.transport.respond(h, request.requestId!, { passed: true });
  assert.deepEqual(await first, { passed: true });
  // Same arguments: the single per-task answer is acquired again, no new request.
  assert.deepEqual(
    await f.fake.runtime!.delegate("ir_integrate", { taskId: h.taskId }, "c2"),
    { passed: true },
  );
  await assert.rejects(
    f.fake.runtime!.delegate("ir_integrate", { taskId: "other" }, "c3"),
    /already requested for this task with different arguments/,
  );
  assert.equal((await f.transport.drainRequests(h)).length, 1);
});

test("labels are part of the owned identity", async (t) => {
  const f = await fixture(t);
  const h = await f.transport.launch({ ...f.input, labels: { role: "worker", issue: 4 } });
  await f.transport.interrupt({ ...h, labels: { issue: 4, role: "worker" } });
  await assert.rejects(
    f.transport.interrupt({ ...h, labels: { role: "merger", issue: 4 } }),
    errorCode("cleanup_blocked"),
  );
  await assert.rejects(
    f.transport.interrupt({ ...h, labels: undefined }),
    errorCode("cleanup_blocked"),
  );
});

test("presence: rows are rebuilt after a cold restart and never repainted by a superseded handle", async (t) => {
  const f = await fixture(t);
  const rows = () => presence().list().filter((r) => r.key.startsWith(f.stateDir));
  const h = await f.transport.launch({
    ...f.input,
    display: { label: "#9 worker", group: "Issue Round" },
  });
  // A new process has an empty registry: observing the persisted handle restores the row.
  presence().remove(h.protocolDir);
  const cold = new AgentRuntime(f.config);
  t.after(() => cold.dispose());
  assert.equal((await cold.observe(h)).kind, "active");
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].label, "#9 worker");
  assert.equal(rows()[0].group, "Issue Round");
  assert.equal(rows()[0].thinking, "high");
  await f.fake.settle();
  const next = await f.transport.dispatch(h, { taskId: "task-2", prompt: "next" });
  await f.fake.runtime!.tick();
  assert.equal((await f.transport.observe(next)).kind, "active");
  assert.equal((await f.transport.observe(h)).kind, "changed");
  assert.equal(rows()[0].state, "active");
  // A closed agent is not resurrected by a later observation.
  await f.fake.settle();
  await f.transport.stop(next);
  await f.transport.close(next);
  assert.equal(rows().length, 0);
  await f.transport.observe(next);
  assert.equal(rows().length, 0);
});

// ── Profile children, sessions, skills, exit and user input (subagent tool on the runtime) ──

const GENERIC = {
  isolation: "profile" as const,
  tools: undefined,
  userInput: "allowed" as const,
  exit: "auto" as const,
  placement: "tab" as const,
  display: { label: "scout" },
};

test("profile children load their normal profile: no isolation flags, no allowlist unless declared", async (t) => {
  const f = await fixture(t);
  const agentDir = join(f.root, "user agent dir");
  await mkdir(agentDir);
  await f.transport.launch({ ...f.input, ...GENERIC, agentDir, env: { PI_SUBAGENT_AGENT: "scout" } });
  const run = f.fake.calls.find((c) => c.argv[1] === "run")!.argv[3];
  for (const flag of ["'-ne'", "'-ns'", "'-np'", "'--no-approve'", "'--no-themes'", "'--tools'"])
    assert.ok(!run.includes(flag), flag);
  assert.ok(run.includes("/runtime/child/extension.ts"));
  // The question tool even if the profile lacks pi-memo-question (pi de-duplicates it otherwise).
  assert.ok(run.includes(`'-e' '${QUESTION_EXTENSION}'`));
  assert.ok(run.includes(`PI_CODING_AGENT_DIR='${agentDir}'`));
  assert.ok(run.includes("PI_SUBAGENT_AGENT='scout'"));
  assert.equal(f.fake.boot!.isolation, "profile");
  assert.equal(f.fake.boot!.policy.tools, null);
  // Declared tools still become an allowlist (plus the exit tools of an auto child).
  const g = await fixture(t);
  await g.transport.launch({ ...g.input, ...GENERIC, tools: ["read", "bash"], denyTools: ["bash"] });
  const run2 = g.fake.calls.find((c) => c.argv[1] === "run")!.argv[3];
  assert.ok(run2.includes("'--tools' 'read,subagent_done,caller_ping'"));
  // Isolated children always need an allowlist; a missing agent dir creates nothing.
  const k = await fixture(t);
  await assert.rejects(k.transport.launch({ ...k.input, tools: undefined }), errorCode("unsupported"));
  await assert.rejects(
    k.transport.launch({ ...k.input, ...GENERIC, agentDir: join(k.root, "absent") }),
    errorCode("unsupported"),
  );
  assert.equal(k.fake.createCount, 0);
  await k.transport.launch(k.input);
});

test("tool policy without allowlist: profile tools allowed, deny and runtime-only tools enforced", () => {
  const policy = {
    tools: null,
    denyTools: ["write"],
    bash: "unrestricted" as const,
    question: false,
    delegatedTools: [],
    userInput: "allowed" as const,
    exit: "tool" as const,
  };
  assert.equal(childToolCall(policy, "some_extension_tool", {}), undefined);
  assert.equal(childToolCall(policy, "bash", { command: "npm test" }), undefined);
  assert.equal(childToolCall(policy, "write", {})?.block, true);
  // No allowlist: question (pi-memo-question, loaded by the runtime) is allowed.
  assert.equal(childToolCall(policy, "question", {}), undefined);
  assert.equal(childToolCall(policy, "subagent_done", {}), undefined);
  assert.equal(childToolCall({ ...policy, exit: "parent" as const }, "caller_ping", {})?.block, true);
});

test("reserved tool names and invalid new policy fields are refused before any pane", async (t) => {
  const f = await fixture(t);
  const bad: Partial<LaunchSpec>[] = [
    { tools: ["read", "subagent_done"] },
    { delegatedTools: [{ ...INTEGRATE, name: "caller_ping" }] },
    { denyTools: ["bad name"] },
    { userInput: "sometimes" as any },
    { exit: "never" as any },
    { skills: ["ok", "bad skill"] },
    { isolation: "sandbox" as any },
    { session: { kind: "file", path: "relative.jsonl" } },
    { session: { kind: "other" } as any },
  ];
  for (const [index, patch] of bad.entries())
    await assert.rejects(
      f.transport.launch({ ...f.input, agentId: `bad-${index}`, ...patch }),
      errorCode("unsupported"),
      JSON.stringify(patch),
    );
  assert.equal(f.fake.createCount, 0);
});

test("an existing or seeded session file is opened exactly, with its header id as identity", async (t) => {
  const f = await fixture(t);
  const file = join(f.root, "seeded session.jsonl");
  await writeFile(file, JSON.stringify({ type: "session", version: 3, id: "seeded-id", cwd: f.cwd }) + "\n");
  const h = await f.transport.launch({ ...f.input, ...GENERIC, session: { kind: "file", path: file } });
  const run = f.fake.calls.find((c) => c.argv[1] === "run")!.argv[3];
  assert.ok(run.includes(`'--session' '${file}'`));
  assert.ok(!run.includes("--session-id"));
  assert.equal(h.sessionId, "seeded-id");
  assert.equal(h.sessionPath, file);
  // The child refuses to start on any other session file.
  f.fake.runtime!.dispose();
  const wrong = new ChildRuntime(f.fake.boot!, {
    sessionId: "seeded-id",
    sessionPath: join(f.fake.boot!.protocolDir, "sessions", "seeded-id.jsonl"),
    cwd: f.cwd,
    pid: f.fake.pid,
    model: f.input.model,
    effort: f.input.thinking,
    isIdle: () => true,
    sendPrompt: () => assert.fail("must not prompt"),
    abort: () => {},
    shutdown: () => {},
  });
  await assert.rejects(wrong.start(false), /identity mismatch/);
  wrong.dispose();
  // A file without a session header is unusable and creates nothing.
  const g = await fixture(t);
  const junk = join(g.root, "junk.jsonl");
  await writeFile(junk, "not json\n");
  await assert.rejects(
    g.transport.launch({ ...g.input, session: { kind: "file", path: junk } }),
    errorCode("unsupported"),
  );
  assert.equal(g.fake.createCount, 0);
});

test("skills travel with the task and reach the child before the prompt", async (t) => {
  const f = await fixture(t);
  const h = await f.transport.launch({ ...f.input, ...MERGER, skills: ["pdf-tools", "review"] });
  assert.deepEqual(f.fake.skills, [["pdf-tools", "review"]]);
  assert.deepEqual(f.fake.prompts, [f.input.prompt]);
  await f.fake.settle();
  await f.transport.dispatch(h, { taskId: "task-2", prompt: "next", skills: ["review"] });
  await f.fake.runtime!.tick();
  assert.deepEqual(f.fake.skills, [["pdf-tools", "review"], ["review"]]);
});

test("exit auto: a normal run ends the child with exit evidence; an aborted run stays open", async (t) => {
  const f = await fixture(t);
  const h = await f.transport.launch({ ...f.input, ...GENERIC });
  f.fake.suppressShutdown = false;
  await f.fake.settle("aborted");
  assert.equal(f.fake.shutdowns, 0);
  assert.equal((await f.transport.observe(h)).exit, undefined);
  // The user continues in the pane; the next normal run ends it.
  await f.fake.settle("stop");
  assert.equal(f.fake.shutdowns, 1);
  const o = await f.transport.observe(h);
  assert.equal(o.kind, "stopped");
  assert.equal(o.exit?.reason, "done");
  assert.equal(o.exit?.status, "success");
  await f.transport.close(h);
  assert.equal(f.fake.closes, 1);
  // A provider failure ends it as an error.
  const g = await fixture(t);
  const gh = await g.transport.launch({ ...g.input, ...GENERIC });
  await g.fake.settle("error", "overloaded");
  const go = await g.transport.observe(gh);
  assert.equal(go.exit?.reason, "error");
  assert.equal(go.exit?.error, "overloaded");
});

test("exit tool: subagent_done/caller_ping end the child; parent-ended children cannot end themselves", async (t) => {
  const f = await fixture(t);
  const h = await f.transport.launch({ ...f.input, ...GENERIC, exit: "tool" });
  await f.fake.settle();
  assert.equal(f.fake.shutdowns, 0);
  await f.fake.runtime!.exitWith("ping", { message: "Need the API key" });
  assert.equal(f.fake.shutdowns, 1);
  const o = await f.transport.observe(h);
  assert.equal(o.kind, "stopped");
  assert.equal(o.exit?.reason, "ping");
  assert.equal(o.exit?.message, "Need the API key");
  await f.transport.close(h);
  const g = await fixture(t);
  await g.transport.launch(g.input);
  await assert.rejects(g.fake.runtime!.exitWith("done"), /ended by its parent/);
});

test("userInput allowed: a user who quits pi ends the child and its pane can be closed", async (t) => {
  const f = await fixture(t);
  const h = await f.transport.launch({ ...f.input, ...GENERIC, exit: "tool" });
  f.fake.alive = false; // user quit, no acknowledgement
  const o = await f.transport.observe(h);
  assert.equal(o.kind, "unavailable");
  assert.equal(o.exited, true);
  await f.transport.close(h);
  assert.equal(f.fake.closes, 1);
  // A workflow child (takeover policy) still needs the orderly acknowledgement.
  const g = await fixture(t);
  const gh = await g.transport.launch(g.input);
  g.fake.alive = false;
  await assert.rejects(g.transport.close(gh), errorCode("cleanup_blocked"));
  assert.equal(g.fake.closes, 0);
});

test("move: the observed tab becomes the handle identity; older handles follow recorded moves only", async (t) => {
  const f = await fixture(t);
  const h = await f.transport.launch(f.input);
  let tab = "tab-1";
  let lose = false;
  let fail = false;
  const base = f.fake.pane.bind(f.fake);
  f.fake.pane = () => ({ ...base(), tab_id: tab });
  f.fake.onCall = (call) => {
    if (call.argv[1] !== "move") return;
    if (fail) return { exitCode: 1, stdout: "", stderr: JSON.stringify({ error: { code: "refused", message: "no" } }) };
    tab = call.argv.includes("--new-tab") ? "tab-parked" : "tab-1";
    if (lose) return { exitCode: 0, stdout: "lost" };
    return f.fake.result({ move_result: { changed: true } });
  };
  const parked = await f.transport.move(h, { newTab: { label: "scout" } });
  assert.equal(parked.tabId, "tab-parked");
  assert.equal(parked.placement, undefined);
  assert.equal((await f.transport.observe(parked)).kind, "active");
  // The owner may keep its older handle (the move came from the pane selector, maybe through another
  // client's runtime): the recorded move is followed, from this and from a fresh runtime.
  assert.equal((await f.transport.observe(h)).kind, "active");
  assert.equal((await new AgentRuntime(f.config).observe(h)).kind, "active");
  // A tab change nobody recorded is still a change.
  tab = "tab-user";
  assert.equal((await f.transport.observe(h)).kind, "changed");
  assert.equal((await f.transport.observe(parked)).kind, "changed");
  tab = "tab-parked";
  // A lost answer is resolved by observation.
  lose = true;
  const shown = await f.transport.move(parked, { split: { targetPane: "master-pane", ratio: 0.5 } });
  assert.equal(shown.tabId, "tab-1");
  assert.equal(shown.placement, "split-right");
  assert.equal(shown.parentPaneId, "master-pane");
  // A refused move with no observed change is "busy"; identity drift blocks.
  lose = false;
  fail = true;
  await assert.rejects(f.transport.move(shown, { newTab: { label: "x" } }), errorCode("busy"));
  fail = false;
  f.fake.onCall = (call) => {
    if (call.argv[1] === "move") f.fake.terminal = "other-terminal";
    return call.argv[1] === "move" ? f.fake.result({}) : undefined;
  };
  await assert.rejects(f.transport.move(shown, { newTab: { label: "x" } }), errorCode("cleanup_blocked"));
});

test("activity snapshots written by the child are readable through the handle", async (t) => {
  const { createSubagentActivityRecorder } = await import("../../pi-extension/subagents/activity.ts");
  const f = await fixture(t);
  const h = await f.transport.launch({ ...f.input, ...GENERIC });
  assert.equal(f.transport.activity(h).ok, false);
  const recorder = createSubagentActivityRecorder({
    runningChildId: h.nonce,
    activityFile: join(h.protocolDir, "activity.json"),
  });
  recorder.sessionStart();
  recorder.agentStart();
  recorder.toolExecutionStart("call-1", "bash");
  await new Promise((r) => setTimeout(r, 30));
  const read = f.transport.activity(h);
  assert.equal(read.ok, true);
  if (read.ok) assert.equal(read.activity.phase, "active");
});

test("presence attention: activity.json first, a pending question.json as fallback; never active", async (t) => {
  const { createSubagentActivityRecorder } = await import("../../pi-extension/subagents/activity.ts");
  const { presenceActive } = await import("../../pi-extension/subagents/runtime/presence.ts");
  const f = await fixture(t);
  const h = await f.transport.launch({ ...f.input, display: { label: "planner", group: "Issue Round" } });
  const row = () => presence().list().find((r) => r.key === h.protocolDir)!;
  await f.transport.observe(h);
  assert.equal(row().attention, undefined);
  f.transport.annotate(h, { active: true });
  // Fallback: a pending question record without activity attention.
  await f.fake.runtime!.question("q1", "Push o solo merge?");
  await f.transport.observe(h);
  assert.equal(row().attention?.kind, "question");
  assert.equal(row().attention?.label, "Push o solo merge?");
  const since = row().attention!.since;
  assert.equal(presenceActive(row()), false);
  await f.transport.observe(h);
  assert.equal(row().attention?.since, since);
  // The child's activity attention wins (e.g. a bash approval).
  const recorder = createSubagentActivityRecorder({ runningChildId: h.nonce, activityFile: join(h.protocolDir, "activity.json") });
  recorder.agentStart();
  recorder.attention({ kind: "approval", label: "npm run build", since: 42 });
  await f.transport.observe(h);
  assert.deepEqual(row().attention, { kind: "approval", label: "npm run build", since: 42 });
  recorder.attention(null);
  await f.fake.runtime!.question("q1", "Push o solo merge?", "Solo merge");
  await f.transport.observe(h);
  assert.equal(row().attention, undefined);
  assert.equal(presenceActive(row()), true);
  f.transport.forget(h);
});

test("boot records of 0.2.0 (without the new policy fields) keep their meaning", async () => {
  const { normalizePolicy, validPolicy } = await import("../../pi-extension/subagents/runtime/protocol.ts");
  const old = normalizePolicy({ tools: ["read"], bash: "readonly", question: true, delegatedTools: [] });
  assert.ok(validPolicy(old));
  assert.deepEqual(old, {
    tools: ["read"],
    denyTools: [],
    bash: "readonly",
    bashAllow: [],
    bashAsk: false,
    question: true,
    delegatedTools: [],
    userInput: "takeover",
    exit: "parent",
    // Boot records written before ask-parent (and external clients) never ask the parent.
    askParent: false,
  });
});

test("an empty task (resume without message) sends nothing and settles; the user drives", async (t) => {
  const f = await fixture(t);
  const file = join(f.root, "old.jsonl");
  await writeFile(file, JSON.stringify({ type: "session", version: 3, id: "old-id", cwd: f.cwd }) + "\n");
  const h = await f.transport.launch({ ...f.input, ...GENERIC, prompt: "", session: { kind: "file", path: file } });
  assert.deepEqual(f.fake.prompts, []);
  const o = await f.transport.observe(h);
  assert.equal(o.kind, "settled");
  assert.equal(o.completion?.status, "success");
});

test("a replacing system prompt is passed with --system-prompt", async (t) => {
  const f = await fixture(t);
  const prompt = join(f.root, "identity.md");
  await writeFile(prompt, "You are a scout.");
  await f.transport.launch({ ...f.input, ...GENERIC, systemPrompt: prompt });
  const run = f.fake.calls.find((c) => c.argv[1] === "run")!.argv[3];
  assert.ok(run.includes(`'--system-prompt' '${prompt}'`));
  const g = await fixture(t);
  await assert.rejects(g.transport.launch({ ...g.input, systemPrompt: "relative.md" }), errorCode("unsupported"));
});

test("move beside a pane can name the target tab", async (t) => {
  const f = await fixture(t);
  const h = await f.transport.launch({ ...f.input, ...GENERIC });
  let args: string[] = [];
  f.fake.onCall = (call) => {
    if (call.argv[1] !== "move") return;
    args = call.argv;
    return f.fake.result({ move_result: { changed: true } });
  };
  // Same tab after the move: an answered move without change is still observed as is.
  const same = await f.transport.move(h, { split: { targetPane: "master-pane", tab: "tab-1", ratio: 0.5 } });
  assert.deepEqual(args.slice(3, 9), ["--tab", "tab-1", "--target-pane", "master-pane", "--split", "right"]);
  assert.equal(same.tabId, "tab-1");
});

test("a user-driven child may be moved to another tab by the user; a workflow child may not", async (t) => {
  for (const userDriven of [true, false]) {
    const f = await fixture(t);
    const h = await f.transport.launch(userDriven ? { ...f.input, ...GENERIC } : f.input);
    const base = f.fake.pane.bind(f.fake);
    f.fake.pane = () => ({ ...base(), tab_id: "tab-moved-by-user" });
    assert.equal((await f.transport.observe(h)).kind, userDriven ? "active" : "changed");
  }
});

test("bash-allow adds exact command prefixes on top of the read-only policy, nothing else", () => {
  const policy = { ...REVIEWER_POLICY, bashAllow: ["npm test", "gh issue view"] };
  const allowed = (command: string) => childToolCall(policy, "bash", { command }) === undefined;
  assert.ok(allowed("git log -5 --oneline")); // read-only list still applies
  assert.ok(allowed("npm test"));
  assert.ok(allowed("npm test -- --grep runtime"));
  assert.ok(allowed("gh issue view 12"));
  for (const command of [
    "npm testx",
    "npm run build",
    "gh issue create --title x",
    "gh issue view 12 | head",
    "npm test && rm -rf x",
    "npm test $(whoami)",
    "gh issue view 'quoted'",
  ])
    assert.equal(allowed(command), false, command);
  assert.match(childToolCall(policy, "bash", { command: "npm run build" })?.reason ?? "", /Also allowed: npm test; gh issue view/);
});

test("bash-allow requires the read-only policy and plain words", async (t) => {
  const f = await fixture(t);
  for (const [index, patch] of [
    { bashAllow: ["npm test"] }, // unrestricted bash: meaningless
    { bash: "readonly" as const, bashAllow: ["npm test | cat"] },
    { bash: "readonly" as const, bashAllow: ["rm $HOME"] },
  ].entries())
    await assert.rejects(
      f.transport.launch({ ...f.input, agentId: `allow-${index}`, ...patch }),
      errorCode("unsupported"),
    );
  assert.equal(f.fake.createCount, 0);
  await f.transport.launch({ ...f.input, bash: "readonly", bashAllow: [" npm test ", ""] });
  assert.deepEqual(f.fake.boot!.policy.bashAllow, ["npm test"]);
});

test("bash-ask requires the read-only policy and a user-driven child; old boot records never ask", async (t) => {
  const f = await fixture(t);
  for (const [index, patch] of [
    { bashAsk: true, userInput: "allowed" as const }, // unrestricted bash: nothing to ask
    { bashAsk: true, bash: "readonly" as const }, // takeover (workflow) children never ask
    { bashAsk: true, bash: "readonly" as const, userInput: "takeover" as const },
    { bashAsk: "yes" as unknown as boolean, bash: "readonly" as const, userInput: "allowed" as const },
    { bash: "readonly" as const, bashAllow: "npm test" as unknown as string[] },
    { bash: "readonly" as const, bashAllow: [42 as unknown as string] },
  ].entries())
    await assert.rejects(
      f.transport.launch({ ...f.input, agentId: `ask-${index}`, ...patch }),
      errorCode("unsupported"),
    );
  assert.equal(f.fake.createCount, 0);
  await f.transport.launch({
    ...f.input,
    bash: "readonly",
    userInput: "allowed",
    bashAsk: true,
    bashAllow: ["npm  test", "gh issue view"],
  });
  assert.equal(f.fake.boot!.policy.bashAsk, true);
  assert.deepEqual(f.fake.boot!.policy.bashAllow, ["npm test", "gh issue view"]);
});

// ── Pane selector shared by every runtime client (subagent tool, Issue Round, ...) ──

/** Two clients (own runtimes and Herdr fakes) of one process-wide selector state. */
async function twoClients(t: { after(fn: () => unknown): void }) {
  const selector: SelectorState = { owned: new Map() };
  const a = await fixture(t);
  const b = await fixture(t);
  a.config.selector = b.config.selector = selector;
  const ra = new AgentRuntime(a.config);
  const rb = new AgentRuntime(b.config);
  t.after(() => (ra.dispose(), rb.dispose()));
  a.fake.paneId = "pane-a";
  b.fake.paneId = "pane-b";
  // pane-a's tab follows the moves its own runtime performs.
  let tabA = "tab-1";
  const baseA = a.fake.pane.bind(a.fake);
  a.fake.pane = () => ({ ...baseA(), tab_id: tabA });
  const movesA: string[][] = [];
  a.fake.onCall = (call) => {
    if (call.argv[1] !== "move") return;
    movesA.push(call.argv);
    tabA = call.argv.includes("--new-tab") ? "tab-parked" : "tab-1";
    return a.fake.result({ move_result: { changed: true } });
  };
  return { selector, a, b, ra, rb, movesA };
}
const SCOUT = {
  isolation: "profile" as const,
  tools: undefined,
  userInput: "allowed" as const,
  exit: "auto" as const,
  display: { label: "scout" },
};
const BESIDE = { pane_id: "pane-a", tab_id: "tab-1", workspace_id: "workspace-1" };

const splitCall = (f: { fake: { calls: { argv: string[] }[] } }) =>
  f.fake.calls.find((c) => c.argv[0] === "pane" && c.argv[1] === "split")?.argv;
const flag = (argv: string[] | undefined, name: string) => argv?.[argv.indexOf(name) + 1];

test("auto placement: the first agent fills the column, the second goes below it, the next ones in tabs", async (t) => {
  const previous = process.env.PI_SUBAGENT_COLUMN_RATIO;
  delete process.env.PI_SUBAGENT_COLUMN_RATIO;
  t.after(() => {
    if (previous !== undefined) process.env.PI_SUBAGENT_COLUMN_RATIO = previous;
  });
  const { selector, a, b, ra, rb } = await twoClients(t);
  const ha = await ra.launch({ ...a.input, ...SCOUT, placement: "auto" });
  const first = splitCall(a);
  assert.equal(first?.[2], "master-pane");
  assert.equal(flag(first, "--direction"), "right");
  // Herdr's ratio is the main pane's share: the column gets 40%.
  assert.equal(flag(first, "--ratio"), "0.6");
  assert.equal(ha.placement, "split-right");
  assert.deepEqual(selector.slots, ["pane-a"]);
  assert.equal(selector.owned.get("pane-a"), "scout");
  assert.equal(selector.controls?.get("pane-a")?.handle.protocolDir, ha.protocolDir);
  // pane-a fills the column: another client's "auto" agent is split below it.
  b.fake.layout = { panes: [...b.fake.layout.panes, BESIDE] };
  const hb = await rb.launch({ ...b.input, ...PLANNER, placement: "auto" });
  const second = splitCall(b);
  assert.equal(second?.[2], "pane-a");
  assert.equal(flag(second, "--direction"), "down");
  assert.equal(flag(second, "--ratio"), "0.5");
  assert.equal(hb.placement, "split-down");
  assert.equal(hb.parentPaneId, "pane-a");
  assert.deepEqual(selector.slots, ["pane-a", "pane-b"]);
  // Both slots taken: a tab.
  const c = await fixture(t);
  c.config.selector = selector;
  const rc = new AgentRuntime(c.config);
  t.after(() => rc.dispose());
  c.fake.paneId = "pane-c";
  c.fake.layout = { panes: [...b.fake.layout.panes, { ...BESIDE, pane_id: "pane-b" }] };
  const hc = await rc.launch({ ...c.input, ...SCOUT, placement: "auto" });
  assert.ok(!splitCall(c));
  assert.ok(c.fake.calls.some((call) => call.argv[0] === "tab" && call.argv[1] === "create"));
  assert.equal(hc.placement, undefined);
  assert.deepEqual(selector.slots, ["pane-a", "pane-b"]);
  assert.deepEqual([...selector.owned.keys()], ["pane-a", "pane-b", "pane-c"]);
});

test("the column ratio comes from PI_SUBAGENT_COLUMN_RATIO; invalid values fall back to 40%", async (t) => {
  const previous = process.env.PI_SUBAGENT_COLUMN_RATIO;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_SUBAGENT_COLUMN_RATIO;
    else process.env.PI_SUBAGENT_COLUMN_RATIO = previous;
  });
  for (const [value, ratio] of [["0.3", "0.7"], ["1.2", "0.6"], ["wide", "0.6"]]) {
    process.env.PI_SUBAGENT_COLUMN_RATIO = value;
    const f = await fixture(t);
    await f.transport.launch({ ...f.input, ...SCOUT, placement: "auto" });
    assert.equal(flag(splitCall(f), "--ratio"), ratio, value);
  }
});

test("concurrent auto launches with a free column: top and bottom slot, the bottom split below the top pane", async (t) => {
  const { selector, a, b, ra, rb } = await twoClients(t);
  const [ha, hb] = await Promise.all([
    ra.launch({ ...a.input, ...SCOUT, placement: "auto" }),
    rb.launch({ ...b.input, ...PLANNER, placement: "auto" }),
  ]);
  const handles = [ha, hb].sort((x, y) => (x.placement === "split-right" ? -1 : y.placement === "split-right" ? 1 : 0));
  assert.deepEqual(handles.map((h) => h.placement), ["split-right", "split-down"]);
  const [top, bottom] = handles;
  const bottomSplit = [splitCall(a), splitCall(b)].find((argv) => flag(argv, "--direction") === "down");
  assert.equal(bottomSplit?.[2], top.paneId);
  assert.equal(bottom.parentPaneId, top.paneId);
  assert.deepEqual(selector.slots, [top.paneId, bottom.paneId]);
  assert.deepEqual((selector.reservedSlots ?? []).filter(Boolean), []);
  assert.equal(selector.placed?.size ?? 0, 0);
});

test("auto placement takes the free column even with our agents open in background tabs", async (t) => {
  const { selector, a, b, ra, rb } = await twoClients(t);
  await ra.launch({ ...a.input, ...SCOUT, placement: "tab" });
  assert.equal(selector.owned.size, 1);
  const hb = await rb.launch({ ...b.input, ...PLANNER, placement: "auto" });
  assert.ok(b.fake.calls.some((c) => c.argv[1] === "split"));
  assert.equal(hb.placement, "split-right");
  assert.deepEqual(selector.slots, ["pane-b"]);
});

test("auto placement on a layout read before the selector moved a pane into the column: a tab", async (t) => {
  const { selector, b, rb } = await twoClients(t);
  b.fake.onCall = (call) => {
    // A promotion moves an agent into the column while this launch reads the layout.
    if (call.argv[1] === "layout") selector.layoutEpoch = (selector.layoutEpoch ?? 0) + 1;
  };
  const hb = await rb.launch({ ...b.input, ...PLANNER, placement: "auto" });
  assert.equal(hb.placement, undefined);
  assert.ok(!b.fake.calls.some((c) => c.argv[1] === "split"));
  assert.deepEqual((selector.reservedSlots ?? []).filter(Boolean), []);
});

test("visible placement with a free slot fills it; with both slots taken it parks the top agent through its own runtime", async (t) => {
  const { selector, a, b, ra, rb, movesA } = await twoClients(t);
  const ha = await ra.launch({ ...a.input, ...SCOUT, placement: "auto" });
  // pane-a (top) and another owned agent (bottom) fill the column.
  selector.owned.set("pane-x", "other");
  selector.slots = ["pane-a", "pane-x"];
  b.fake.layout = { panes: [...b.fake.layout.panes, BESIDE, { ...BESIDE, pane_id: "pane-x" }] };
  const hb = await rb.launch({ ...b.input, ...PLANNER, placement: "visible" });
  assert.equal(movesA.length, 1);
  assert.ok(movesA[0].includes("--new-tab"));
  const split = splitCall(b);
  assert.equal(split?.[2], "pane-x");
  assert.equal(flag(split, "--direction"), "down");
  assert.equal(hb.placement, "split-down");
  // Queue rule: the bottom agent moved up, the new one is below it.
  assert.deepEqual(selector.slots, ["pane-x", "pane-b"]);
  // The selector's control has the parked tab; the owner's older handle still works (recorded move).
  assert.equal(selector.controls?.get("pane-a")?.handle.tabId, "tab-parked");
  assert.equal((await ra.observe(ha)).kind, "active");

  // A free slot: no park, the new agent goes below the shown one.
  const g = await twoClients(t);
  await g.ra.launch({ ...g.a.input, ...SCOUT, placement: "auto" });
  g.b.fake.layout = { panes: [...g.b.fake.layout.panes, BESIDE] };
  const hg = await g.rb.launch({ ...g.b.input, ...PLANNER, placement: "visible" });
  assert.equal(g.movesA.length, 0);
  assert.equal(hg.placement, "split-down");
  assert.deepEqual(g.selector.slots, ["pane-a", "pane-b"]);
});

test("visible placement never splits a tab with another split or a zoomed caller", async (t) => {
  const master = { pane_id: "master-pane", tab_id: "tab-1", workspace_id: "workspace-1" };
  for (const layout of [
    { panes: [master, { ...master, pane_id: "user-pane" }] },
    { zoomed: true, panes: [master] },
  ]) {
    const f = await fixture(t);
    f.fake.layout = layout;
    const h = await f.transport.launch({ ...f.input, ...PLANNER, placement: "visible" });
    assert.equal(h.placement, undefined);
    assert.ok(!f.fake.calls.some((c) => c.argv[1] === "split"));
    assert.deepEqual((f.config.selector!.reservedSlots ?? []).filter(Boolean), []);
    assert.deepEqual(f.config.selector!.slots ?? [], []);
  }
});

test("the pane selector shows another client's agent by moving it through that client's runtime", async (t) => {
  const { selector, a, ra } = await twoClients(t);
  const ha = await ra.launch({ ...a.input, ...SCOUT, placement: "tab" });
  assert.deepEqual(selector.slots ?? [], []);
  let tabA = "tab-x";
  a.fake.pane = () => ({ pane_id: "pane-a", tab_id: tabA, workspace_id: "workspace-1", terminal_id: a.fake.terminal });
  const moves: string[][] = [];
  a.fake.onCall = (call) => {
    if (call.argv[1] !== "move") return;
    moves.push(call.argv);
    tabA = "tab-1";
    return a.fake.result({ move_result: { changed: true } });
  };
  // The main process' selector reads the layout itself; the move goes through runtime A.
  const master = { pane_id: "master-pane", tab_id: "tab-1", workspace_id: "workspace-1" };
  const view = new PaneSelector(selector, (args) => {
    if (args[1] === "get" && args[2] === "master-pane") return { pane: master };
    if (args[1] === "get") return { pane: { pane_id: args[2], tab_id: tabA, workspace_id: "workspace-1" } };
    if (args[1] === "layout")
      return { layout: { panes: tabA === "tab-1" ? [master, { pane_id: "pane-a" }] : [master] } };
    throw new Error(`direct Herdr move not expected: ${args.join(" ")}`);
  }, () => "master-pane");
  assert.deepEqual(view.selectable(), ["pane-a"]);
  await view.select("pane-a");
  assert.deepEqual(selector.slots, ["pane-a"]);
  assert.equal(flag(moves[0], "--split"), "right");
  assert.equal(flag(moves[0], "--ratio"), String(Number((1 - Number(process.env.PI_SUBAGENT_COLUMN_RATIO ?? 0.4)).toFixed(4))));
  assert.equal(selector.controls?.get("pane-a")?.handle.tabId, "tab-1");
  assert.equal((await ra.observe(ha)).kind, "active");
});

test("agents are registered again when observed in a new process and forgotten with forget", async (t) => {
  const f = await fixture(t);
  const h = await f.transport.launch({ ...f.input, ...SCOUT, placement: "tab" });
  const fresh: SelectorState = { owned: new Map() };
  const restarted = new AgentRuntime({ ...f.config, selector: fresh });
  t.after(() => restarted.dispose());
  assert.equal((await restarted.observe(h)).kind, "active");
  assert.equal(fresh.owned.get("pane-1"), "scout");
  assert.equal(fresh.controls?.get("pane-1")?.handle.taskToken, h.taskToken);
  restarted.forget(h);
  assert.equal(fresh.owned.size, 0);
  assert.equal(f.config.selector!.owned.size, 1);
});

// ── Mirror viewers: a read-only terminal program launched with pi's exact identity/shutdown contract.

test("viewer: runs a node program under the child contract, no pi checks, no presence row, selector-owned", async (t) => {
  const f = await fixture(t);
  const script = join(f.root, "mirror-viewer.ts");
  await writeFile(script, "void 0;\n");
  const h = await f.transport.launch({
    ...f.input,
    viewer: { script, args: ["--slot", "slot-1"] },
    placement: "auto",
    prompt: "",
  });
  assert.equal(h.pid, f.fake.pid);
  assert.equal(f.config.selector!.owned.get("pane-1"), "worker"); // display label
  assert.deepEqual(f.config.selector!.slots, ["pane-1"]); // the top slot was reserved by this launch
  assert.equal(f.config.selector!.controls?.get("pane-1")?.handle.paneId, "pane-1");
  // The viewer program is executed with node, not pi: no help check, no isolation flags.
  const run = f.fake.calls.find((c) => c.argv[1] === "run");
  assert.ok(run);
  assert.ok(run.argv[3].includes("'node' '--experimental-strip-types'"));
  assert.ok(run.argv[3].includes(`'${script}' '--slot' 'slot-1'`));
  assert.ok(run.argv[3].includes("PI_MEMO_MIRROR_VIEW=1 'node'"));
  assert.ok(!run.argv[3].includes("'-ne'"));
  assert.ok(!f.fake.calls.some((c) => c.executable === "fake-pi"));
  // The empty task is accepted and settled at once; the boot is a viewer boot.
  assert.ok(f.fake.boot?.viewer);
  assert.equal(f.fake.boot!.prompt, undefined);
  const observation = await f.transport.observe(h);
  assert.equal(observation.kind, "settled");
  // No presence row: a mirror is a pane, not an agent.
  assert.equal(presence().get(h.protocolDir), undefined);
  // Stop and close follow the same proof as any child.
  await f.transport.stop(h);
  await f.transport.close(h);
  assert.equal(f.fake.closes, 1);
  assert.equal(f.config.selector!.owned.size, 0);
});

test("viewer: relative scripts and pi-only options are unsupported before any pane", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "v.ts"), "void 0;\n");
  await assert.rejects(
    f.transport.launch({ ...f.input, viewer: { script: "v.ts" }, prompt: "" }),
    errorCode("unsupported"),
  );
  await assert.rejects(
    f.transport.launch({ ...f.input, viewer: { script: join(f.root, "v.ts"), prompt: "" }, skills: ["demo-evidence"] }),
    errorCode("unsupported"),
  );
  await assert.rejects(
    f.transport.launch({
      ...f.input,
      viewer: { script: join(f.root, "v.ts"), prompt: "" },
      delegatedTools: [INTEGRATE],
    }),
    errorCode("unsupported"),
  );
  await assert.rejects(
    f.transport.launch({
      ...f.input,
      viewer: { script: join(f.root, "v.ts"), prompt: "" },
      session: { kind: "new" },
    }),
    errorCode("unsupported"),
  );
  // A viewer launch with a prompt is refused too.
  await assert.rejects(
    f.transport.launch({ ...f.input, viewer: { script: join(f.root, "v.ts") } }),
    errorCode("unsupported"),
  );
  assert.equal(f.fake.createCount, 0, "nothing was created");
  assert.ok(!f.fake.calls.some((c) => c.executable === "fake-herdr"), "Herdr was never called");
});

// ── Column placement: a split under a given pane (not the caller's), with an explicit ratio.

test("split placement under an explicit target pane, with ratio; identity checked against the target's tab", async (t) => {
  const f = await fixture(t);
  const target = { pane_id: "column-pane", tab_id: "tab-1", workspace_id: "workspace-1", terminal_id: "term-col" };
  f.fake.onCall = (input) => {
    const a = input.argv;
    if (input.executable === "fake-herdr" && a[0] === "pane" && a[1] === "get" && a[2] === "column-pane")
      return f.fake.result({ pane: target });
  };
  const h = await f.transport.launch({
    ...f.input,
    ...SCOUT,
    placement: "split-down",
    splitTarget: "column-pane",
    splitRatio: 0.5,
  });
  const split = f.fake.calls.find((c) => c.argv[0] === "pane" && c.argv[1] === "split");
  assert.ok(split);
  assert.equal(split.argv[2], "column-pane", "split under the target, not the caller");
  assert.equal(split.argv[split.argv.indexOf("--direction") + 1], "down");
  assert.equal(split.argv[split.argv.indexOf("--ratio") + 1], "0.5");
  assert.ok(split.argv.includes("--no-focus"));
  assert.equal(h.parentPaneId, "column-pane");
  assert.equal(h.placement, "split-down");
  assert.equal((await f.transport.observe(h)).kind, "active");
});

test("split target and ratio are validated before anything is created", async (t) => {
  const f = await fixture(t);
  for (const bad of [
    { placement: "tab" as const, splitTarget: "x" },
    { placement: "split-down" as const, splitRatio: 0 },
    { placement: "split-down" as const, splitRatio: 1 },
    { placement: "split-down" as const, splitTarget: "" },
  ])
    await assert.rejects(f.transport.launch({ ...f.input, ...SCOUT, ...bad }), errorCode("unsupported"), JSON.stringify(bad));
  assert.equal(f.fake.createCount, 0);
  // A target that is not the pane Herdr returns (or is in another workspace) is refused, nothing created.
  f.fake.onCall = (input) => {
    if (input.executable === "fake-herdr" && input.argv[1] === "get" && input.argv[2] === "column-pane")
      return f.fake.result({ pane: { pane_id: "other", tab_id: "tab-1", workspace_id: "workspace-1" } });
  };
  await assert.rejects(
    f.transport.launch({ ...f.input, ...SCOUT, placement: "split-down", splitTarget: "column-pane" }),
    (error: unknown) => error instanceof RuntimeError && (error.code === "launch_failed" || error.code === "launch_uncertain"),
  );
  assert.equal(f.fake.createCount, 0);
});

// ── Ask-parent: correlated requests from a user-driven child to its parent ──

const until = async <T>(read: () => Promise<T | undefined>, ms = 3000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 5));
  }
};

test("ask-parent: launch policy, user-driven only, and the child extension owns the one question tool", async (t) => {
  const f = await fixture(t);
  await f.transport.launch({ ...f.input, ...GENERIC, askParent: true });
  assert.equal(f.fake.boot!.policy.askParent, true);
  const run = f.fake.calls.find((c) => c.argv[1] === "run")!.argv[3];
  assert.doesNotMatch(run, /extensions\/question\.ts/);
  // Opt-out: profile children keep loading pi-memo-question's extension as before.
  const g = await fixture(t);
  await g.transport.launch({ ...g.input, ...GENERIC });
  assert.equal(g.fake.boot!.policy.askParent, false);
  assert.match(g.fake.calls.find((c) => c.argv[1] === "run")!.argv[3], /extensions\/question\.ts/);
  // Workflow (takeover) children never ask the parent; `ask_parent` is a reserved tool name.
  const n = await fixture(t);
  for (const [index, patch] of [
    { askParent: true },
    { askParent: "yes" as unknown as boolean, ...GENERIC },
    { delegatedTools: [{ ...INTEGRATE, name: "ask_parent" }] },
  ].entries())
    await assert.rejects(
      n.transport.launch({ ...n.input, agentId: `askp-${index}`, ...patch }),
      errorCode("unsupported"),
      JSON.stringify(patch),
    );
  assert.equal(n.fake.createCount, 0);
});

test("ask-parent: a question reaches the parent as a correlated request; the child waits for exactly that answer", async (t) => {
  const f = await fixture(t);
  const h = await f.transport.launch({ ...f.input, ...GENERIC, askParent: true });
  await f.transport.askHeartbeat(h, { name: "main agent", id: "parent-session" });
  const targets: string[] = [];
  const asked = f.fake.runtime!.ask(
    { kind: "question", text: "Quale base?", options: [{ label: "main (Recommended)" }, { label: "dev" }] },
    { onTarget: (target) => targets.push(target), pollMs: 5 },
  );
  const [pending] = await until(async () => {
    const list = await f.transport.pendingAsks(h);
    return list.length ? list : undefined;
  });
  assert.equal(pending.request.kind, "question");
  assert.equal(pending.request.childName, "scout");
  assert.equal(pending.request.childId, h.agentId);
  assert.deepEqual(pending.request.options, [{ label: "main (Recommended)" }, { label: "dev" }]);
  assert.equal(pending.received, false);
  // Not a delegated-tool request: other runtime clients never see it in observe/drainRequests.
  assert.deepEqual(await f.transport.drainRequests(h), []);
  assert.equal(await f.transport.markAsk(h, pending.requestId, { kind: "received" }), true);
  assert.equal(await f.transport.markAsk(h, pending.requestId, { kind: "received" }), false);
  await f.transport.markAsk(h, pending.requestId, { kind: "escalated", escalation: { target: "user", reason: "timeout" } });
  await until(async () => (targets.includes("user") ? true : undefined));
  await f.transport.answerAsk(h, pending.requestId, {
    answer: "dev",
    by: { who: "user", where: "parent-session", reason: "timeout", name: "main agent" },
  });
  const outcome = await asked;
  assert.equal(outcome.kind, "answered");
  assert.equal(outcome.kind === "answered" && outcome.result.answer, "dev");
  assert.deepEqual(targets, ["parent", "user"]);
  // Answered once: repeated or stale answers are refused.
  await assert.rejects(
    f.transport.answerAsk(h, pending.requestId, { answer: "main", by: { who: "parent" } }),
    errorCode("busy"),
  );
  await assert.rejects(
    f.transport.answerAsk(h, "unknown-request", { answer: "main", by: { who: "parent" } }),
    errorCode("busy"),
  );
  assert.deepEqual(await f.transport.pendingAsks(h), []);
  // The child keeps running: no exit record, nothing like caller_ping.
  const o = await f.transport.observe(h);
  assert.equal(o.exit, undefined);
  assert.notEqual(o.kind, "stopped");
});

test("ask-parent: unavailable parent → fallback to the child's pane without the full timeout; late answers refused", async (t) => {
  const f = await fixture(t);
  const h = await f.transport.launch({ ...f.input, ...GENERIC, askParent: true });
  const child = f.fake.runtime!;
  const approval = { kind: "approval" as const, text: "npm run build", command: "npm run build", prefix: "npm run" };
  // Parent extension not loaded: nobody picks the request up.
  const unpicked = await child.ask(approval, { pickupMs: 30, pollMs: 5 });
  assert.equal(unpicked.kind, "fallback");
  assert.match(unpicked.kind === "fallback" ? unpicked.reason : "", /did not pick/);
  assert.deepEqual(await f.transport.pendingAsks(h), []);
  await assert.rejects(
    f.transport.answerAsk(h, unpicked.requestId!, { decision: "once", by: { who: "parent" } }),
    errorCode("busy"),
  );
  // Parent quit or reloaded (closed liveness record): no request at all.
  await f.transport.askHeartbeat(h, { name: "main agent", id: "s", closed: true });
  const started = Date.now();
  const closed = await child.ask(approval, { pickupMs: 60_000 });
  assert.equal(closed.kind, "fallback");
  assert.ok(Date.now() - started < 1000);
  // The parent goes away while the request waits.
  await f.transport.askHeartbeat(h, { name: "main agent", id: "s" });
  const waiting = child.ask(approval, { pickupMs: 60_000, pollMs: 5 });
  const [pending] = await until(async () => {
    const list = await f.transport.pendingAsks(h);
    return list.length ? list : undefined;
  });
  await f.transport.markAsk(h, pending.requestId, { kind: "received" });
  await f.transport.askHeartbeat(h, { name: "main agent", id: "s", closed: true });
  const gone = await waiting;
  assert.equal(gone.kind, "fallback");
  assert.match(gone.kind === "fallback" ? gone.reason : "", /not available/);
  // A fallback answer published by the parent (e.g. no UI to ask the user) also sends the child to its pane.
  await f.transport.askHeartbeat(h, { name: "main agent", id: "s" });
  const relayed = child.ask(approval, { pickupMs: 60_000, pollMs: 5 });
  const [next] = await until(async () => {
    const list = await f.transport.pendingAsks(h);
    return list.length ? list : undefined;
  });
  await f.transport.answerAsk(h, next.requestId, { fallback: true, reason: "no UI in the parent session" });
  assert.deepEqual(await relayed, { kind: "fallback", reason: "no UI in the parent session", requestId: next.requestId });
  // Aborted turn: the child withdraws (claims the slot) and reports cancelled.
  const controller = new AbortController();
  const aborted = child.ask(approval, { pickupMs: 60_000, pollMs: 5, signal: controller.signal });
  const [third] = await until(async () => {
    const list = await f.transport.pendingAsks(h);
    return list.length ? list : undefined;
  });
  controller.abort();
  assert.equal((await aborted).kind, "cancelled");
  await assert.rejects(
    f.transport.answerAsk(h, third.requestId, { decision: "once", by: { who: "parent" } }),
    errorCode("busy"),
  );
  // Opt-out children never publish requests.
  const g = await fixture(t);
  await g.transport.launch({ ...g.input, ...GENERIC });
  assert.deepEqual(await g.fake.runtime!.ask(approval), { kind: "fallback", reason: "ask-parent is off" });
});

test("ask-parent nesting: an intermediate agent forwards an escalation one level up, never to its user", async (t) => {
  // top (main agent) → mid (runtime child, itself a parent) → leaf.
  const top = await fixture(t);
  const midHandle = await top.transport.launch({ ...top.input, ...GENERIC, askParent: true, display: { label: "Mid" } });
  await top.transport.askHeartbeat(midHandle, { name: "main agent", id: "s0" });
  const mid = await fixture(t);
  const leafHandle = await mid.transport.launch({ ...mid.input, ...GENERIC, askParent: true, display: { label: "Leaf" } });
  await mid.transport.askHeartbeat(leafHandle, { name: "Mid", id: "mid-id" });
  let userAsked = 0;
  const midHost = new AskParentHost({
    runtime: mid.transport,
    children: () => [{ id: "leaf-id", name: "Leaf", handle: leafHandle }],
    self: () => ({ name: "Mid", id: "mid-id" }),
    notify: () => {},
    escalationTarget: () => "parent",
    escalate: createEscalate({
      // What the child extension of "mid" registers as its upstream.
      upstream: () => ({ name: "Mid", forward: (request, options) => top.fake.runtime!.ask(request, { ...options, pollMs: 5 }) }),
      askUser: async () => {
        userAsked++;
        return undefined;
      },
      self: () => ({ name: "Mid", id: "mid-id" }),
    }),
    timeoutMs: 60_000,
  });
  const targets: string[] = [];
  const leafAsk = mid.fake.runtime!.ask(
    { kind: "approval", text: "make build", command: "make build", prefix: "make build" },
    { pollMs: 5, onTarget: (target) => targets.push(target) },
  );
  const [pending] = await until(async () => {
    await midHost.tick();
    const list = midHost.pending();
    return list.length ? list : undefined;
  });
  assert.equal((await midHost.answer({ id: "leaf-id", requestId: pending.requestId, escalate: true })).ok, true);
  const [up] = await until(async () => {
    const list = await top.transport.pendingAsks(midHandle);
    return list.length ? list : undefined;
  });
  assert.equal(up.request.childName, "Mid");
  assert.deepEqual(up.request.origin, ["Leaf"]);
  assert.equal(up.request.command, "make build");
  await top.transport.markAsk(midHandle, up.requestId, { kind: "received" });
  await top.transport.answerAsk(midHandle, up.requestId, { decision: "once", by: { who: "parent", name: "main agent", id: "s0" } });
  const outcome = await leafAsk;
  assert.equal(outcome.kind, "answered");
  assert.deepEqual(outcome.kind === "answered" && outcome.result, {
    decision: "once",
    by: { who: "parent", name: "main agent", id: "s0", forwardedBy: ["Mid"] },
  });
  assert.equal(userAsked, 0);
  assert.deepEqual(targets, ["parent"]); // escalated one level up: still waiting for a parent, not the user
});
