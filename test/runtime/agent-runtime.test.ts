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
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  RuntimeError,
  readProcessTerminal,
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
  /** Herdr `worktree open` outcome for worker launches. */
  worktree: "open" | "already-open" | "refused" | "mismatch" = "open";
  workspace = "workspace-1";
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
    if (a[0] === "pane" && a[1] === "split") {
      this.createCount++;
      return this.result({ pane: this.pane() });
    }
    if (a[1] === "rename" || a[1] === "report-metadata") return this.result({});
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
      const dir = a[3].match(/MEMO_RUNTIME_PROTOCOL_DIR='([^']+)'/)?.[1];
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
          pane_id: "pane-1",
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
      pane_id: "pane-1",
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
  assert.ok(!f.fake.calls.some((c) => c.argv[0] === "tab"));
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
  assert.equal(meta.argv[meta.argv.indexOf("--display-agent") + 1], "└─ #56 worker");
  assert.ok(meta.argv.includes("parent=master-pane"));
  assert.ok(meta.argv.includes("tree_depth=1"));
  // Owned cleanup closes only the exact pane (Herdr then closes the emptied space).
  assert.equal((await f.transport.observe(h)).kind, "active");
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
    { MEMO_RUNTIME_SCOPE: "other" },
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
      .filter((c) => c.argv[1] === "get")
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
      if (call.argv[1] === "get") {
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
  f.fake.cliUnsupported = false;
  f.fake.readySuppressed = true;
  await assert.rejects(
    f.transport.launch({ ...f.input, attempt: 2 }),
    errorCode("launch_uncertain"),
  );
  assert.equal(f.fake.createCount, 1);
  await assert.rejects(
    f.transport.launch({ ...f.input, attempt: 2 }),
    (e: any) => e.code === "EEXIST",
  );
  assert.equal(f.fake.createCount, 1);
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

test("question is a policy flag: observed for enabled children, refused otherwise", async (t) => {
  assert.equal(childToolCall(WORKER_POLICY, "question", {})?.block, true);
  assert.equal(childToolCall(TRIAGE_POLICY, "question", {}), undefined);
  const f = await fixture(t);
  const h = await f.transport.launch({ ...f.input, ...PLANNER });
  const run = f.fake.calls.find((c) => c.argv[1] === "run")!;
  assert.match(run.argv[3], /'--tools' 'read,bash,grep,find,ls,question'/);
  assert.equal((await f.transport.observe(h)).question, undefined);
  await f.fake.runtime!.question("q1", "Push o solo merge?");
  assert.deepEqual((await f.transport.observe(h)).question, {
    id: "q1",
    text: "Push o solo merge?",
    pending: true,
  });
  await f.fake.runtime!.question("q1", "Push o solo merge?", "Solo merge");
  assert.equal((await f.transport.observe(h)).question?.pending, false);
  const w = await fixture(t);
  await w.transport.launch(w.input);
  await assert.rejects(w.fake.runtime!.question("q", "?"), /not enabled/);
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
  // The profile's own question tool is not the runtime's.
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

test("move: the observed tab becomes the handle identity; old handles are refused", async (t) => {
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
  assert.equal((await f.transport.observe(h)).kind, "changed");
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

test("boot records of 0.2.0 (without the new policy fields) keep their meaning", async () => {
  const { normalizePolicy, validPolicy } = await import("../../pi-extension/subagents/runtime/protocol.ts");
  const old = normalizePolicy({ tools: ["read"], bash: "readonly", question: true, delegatedTools: [] });
  assert.ok(validPolicy(old));
  assert.deepEqual(old, {
    tools: ["read"],
    denyTools: [],
    bash: "readonly",
    question: true,
    delegatedTools: [],
    userInput: "takeover",
    exit: "parent",
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
