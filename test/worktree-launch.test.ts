// Launch/resume integration of `worktree: true` against a fake agent runtime and real git.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import subagentsExtension, { __test__ } from "../pi-extension/subagents/index.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";
import { setSubagentRuntime } from "../pi-extension/subagents/runtime-client.ts";
import { RuntimeError } from "../pi-extension/subagents/runtime/index.ts";
import type { AgentHandle, LaunchSpec } from "../pi-extension/subagents/runtime/index.ts";

/** Agent runtime stand-in: records launch specs; a child ends when the test says so. */
class FakeRuntime {
  specs = new Map<string, LaunchSpec>();
  ended = new Set<string>();
  closed: string[] = [];
  failLaunch?: Error;
  async launch(spec: LaunchSpec): Promise<AgentHandle> {
    if (this.failLaunch) throw this.failLaunch;
    this.specs.set(spec.agentId, spec);
    return {
      scope: spec.scope, agentId: spec.agentId, attempt: spec.attempt, taskId: spec.taskId, taskToken: "token",
      nonce: "nonce", sessionId: "child", sessionPath: spec.session && spec.session.kind === "file" ? spec.session.path : "",
      paneId: `pane-${spec.agentId}`, terminalId: "t", tabId: "tab", workspaceId: "ws", pid: 1, processIdentity: "p",
      shellPid: 2, tty: "ttys0", cwd: spec.cwd, protocolDir: `/fake/${spec.agentId}`,
    };
  }
  async observe(h: AgentHandle) {
    return this.ended.has(h.agentId)
      ? { kind: "stopped", requests: [], exit: { reason: "done" } }
      : { kind: "active", requests: [] };
  }
  async close(h: AgentHandle) { this.closed.push(h.agentId); }
  async stop() {}
  async interrupt() {}
  activity() { return { ok: false, reason: "missing" }; }
  forget() {}
}
let fake: FakeRuntime;

let root: string;
let stateDir: string;
let agentDir: string;
let parentSession: string;
const savedEnv: Record<string, string | undefined> = {};

// Display-only Herdr calls (agent status, task metadata) still go to a herdr binary.
const FAKE_HERDR = `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_HERDR_STATE/log"
case "$1 $2" in
  "pane get") echo "{\\"result\\":{\\"pane\\":{\\"pane_id\\":\\"$3\\",\\"agent_status\\":\\"working\\"}}}";;
  *) echo '{"result":{}}';;
esac
`;

function setEnv(name: string, value: string | undefined) {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "memo-wt-launch-")));
  stateDir = join(root, "herdr-state");
  agentDir = join(root, "agent");
  const bin = join(root, "bin");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "herdr"), FAKE_HERDR, { mode: 0o755 });
  const gitConfig = join(root, "gitconfig");
  writeFileSync(gitConfig, "[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n");

  setEnv("PATH", `${bin}:${process.env.PATH}`);
  setEnv("HERDR_ENV", "1");
  setEnv("HERDR_PANE_ID", "parent-pane");
  setEnv("HERDR_TAB_ID", "parent-tab");
  setEnv("HERDR_WORKSPACE_ID", "parent-ws");
  setEnv("FAKE_HERDR_STATE", stateDir);
  setEnv("PI_SUBAGENT_SURFACE", "tab");
  setEnv("PI_CODING_AGENT_DIR", agentDir);
  for (const name of [
    "PI_SUBAGENT_ID",
    "PI_DENY_TOOLS",
    "PI_SUBAGENT_AGENT",
    "MEMO_SUBAGENTS_CHILD_EXTENSIONS",
    "MEMO_SUBAGENTS_CHILD_ENV",
    "IR_CHILD_EXTENSIONS",
    "IR_CHILD_ENV",
  ]) setEnv(name, undefined);
  setEnv("GIT_CONFIG_GLOBAL", gitConfig);
  setEnv("GIT_CONFIG_NOSYSTEM", "1");
  for (const name of ["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"]) setEnv(name, "Test");
  for (const name of ["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"]) setEnv(name, "test@example.com");

  fake = new FakeRuntime();
  setSubagentRuntime(fake as any);
  parentSession = join(root, "parent-sessions", "parent.jsonl");
  mkdirSync(dirname(parentSession), { recursive: true });
  writeFileSync(parentSession, `${JSON.stringify({ type: "session", version: 3, id: "p", cwd: root })}\n`);
});

after(() => {
  for (const running of __test__.runningSubagents.values()) running.abortController?.abort();
  __test__.runningSubagents.clear();
  for (const key of ["pi-subagents/widget-interval", "pi-subagents/status-interval"]) {
    const timer = (globalThis as any)[Symbol.for(key)];
    if (timer) clearInterval(timer);
  }
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  setSubagentRuntime(undefined);
  rmSync(root, { recursive: true, force: true });
});

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

let repoCounter = 0;
function makeRepo(): string {
  const repo = join(root, `repo${++repoCounter}`);
  mkdirSync(join(repo, "packages", "api"), { recursive: true });
  sh(root, "init", "-q", repo);
  writeFileSync(join(repo, "README.md"), "hello\n");
  writeFileSync(join(repo, "packages", "api", "index.ts"), "export {};\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "initial");
  return repo;
}

function setup() {
  const tools = new Map<string, any>();
  const sent: any[] = [];
  subagentsExtension({
    on() {},
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
    registerMessageRenderer() {},
    registerShortcut() {},
    sendUserMessage() {},
    sendMessage(message: any) { sent.push(message); },
    getThinkingLevel: () => "high",
    getAllTools: () => [],
  } as any);
  return { tools, sent };
}

function ctx(cwd: string, ui?: { hasUI: boolean; select?: (title: string, options: string[]) => Promise<string | undefined> }) {
  const model = { provider: "fake", id: "parent", reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 16_000 };
  return {
    cwd,
    hasUI: ui?.hasUI ?? false,
    mode: ui?.hasUI ? "tui" : "print",
    ui: {
      select: ui?.select ?? (async () => { throw new Error("select must not be called"); }),
      notify() {},
      setWidget() {},
      confirm: async () => true,
    },
    model: { provider: "fake", id: "parent" },
    modelRegistry: {
      find: () => model,
      getAvailable: () => [model],
      hasConfiguredAuth: () => true,
    },
    sessionManager: {
      getSessionFile: () => parentSession,
      getSessionId: () => "parent-session-id",
      getSessionDir: () => dirname(parentSession),
    },
  };
}

function launched(details: any): LaunchSpec {
  const spec = fake.specs.get(details.id);
  assert.ok(spec, `launch spec of ${details.id}`);
  return spec;
}

/** Number of agents launched so far. */
function panesCreated(): number {
  return fake.specs.size;
}

function surfaceOf(id: string): string {
  const running = __test__.runningSubagents.get(id);
  assert.ok(running, `running subagent ${id}`);
  return running.surface;
}

async function finish(id: string, sent: any[], customType = "subagent_result"): Promise<any> {
  const before = sent.length;
  surfaceOf(id);
  fake.ended.add(id);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const message = sent.slice(before).find((m) => m.customType === customType);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no ${customType} delivered for ${id}`);
}

function sessionDirFor(cwd: string): string {
  return join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

describe("subagent worktree launch", () => {
  it("without worktree the child is a plain profile launch through the agent runtime", async () => {
    const repo = makeRepo();
    const { tools } = setup();
    const result = await tools.get("subagent").execute("t", { name: "plain", task: "do it", fork: true }, undefined, undefined, ctx(repo));
    const d = result.details;
    assert.equal(d.status, "started");
    assert.equal(d.worktree, undefined);
    assert.doesNotMatch(result.content[0].text, /Worktree/);
    const spec = launched(d);
    assert.equal(spec.isolation, "profile");
    assert.equal(spec.cwd, repo);
    assert.equal(spec.agentDir, agentDir);
    assert.equal(spec.model, "fake/parent");
    assert.equal(spec.thinking, "high");
    assert.equal(spec.prompt, "do it");
    assert.equal(spec.userInput, "allowed");
    assert.equal(spec.exit, "auto");
    assert.equal(spec.tools, undefined);
    assert.equal(spec.placement, "tab");
    assert.deepEqual(spec.display, { label: "plain" });
    assert.deepEqual(spec.session, { kind: "file", path: d.sessionFile });
    assert.deepEqual(spec.env, { PI_SUBAGENT_NAME: "plain", PI_SUBAGENT_ID: d.id });
    assert.equal(surfaceOf(d.id), `pane-${d.id}`);
    assert.equal(dirname(d.sessionFile), sessionDirFor(repo));
    // fork: the session file carries the parent lineage.
    assert.equal(JSON.parse(readFileSync(d.sessionFile, "utf8").split("\n")[0]).parentSession, parentSession);
    assert.ok(!existsSync(join(dirname(repo), `${basename(repo)}-memo-worktrees`)));
    __test__.runningSubagents.get(d.id)?.abortController?.abort();
  });

  it("agent definitions become runtime policy (tools, denied tools, skills, interactive exit, system prompt)", async () => {
    const repo = makeRepo();
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(
      join(agentDir, "agents", "planner-test.md"),
      "---\nname: planner-test\ntools: read, bash, caller_ping\nskills: review\nspawning: false\nauto-exit: false\nsystem-prompt: append\n---\nYou plan.\n",
    );
    const { tools } = setup();
    const result = await tools.get("subagent").execute("t", { name: "P", task: "plan", agent: "planner-test" }, undefined, undefined, ctx(repo));
    const spec = launched(result.details);
    assert.deepEqual(spec.tools, ["read", "bash"]);
    assert.ok(spec.denyTools?.includes("subagent"));
    assert.deepEqual(spec.skills, ["review"]);
    assert.equal(spec.exit, "tool");
    assert.equal(readFileSync(spec.appendSystemPrompt![0], "utf8"), "You plan.");
    assert.match(spec.prompt, /call the subagent_done tool/);
    assert.equal(spec.env?.PI_SUBAGENT_AGENT, "planner-test");
    assert.ok(spec.env?.PI_DENY_TOOLS?.includes("subagent"));
    // Standalone session: header only, no parent lineage.
    const header = JSON.parse(readFileSync(result.details.sessionFile, "utf8").split("\n")[0]);
    assert.equal(header.type, "session");
    assert.equal(header.parentSession, undefined);
    __test__.runningSubagents.get(result.details.id)?.abortController?.abort();
    rmSync(join(agentDir, "agents"), { recursive: true, force: true });
  });

  it("rejects worktreeBranch/worktreeBase without worktree: true", async () => {
    const { tools } = setup();
    for (const extra of [{ worktreeBranch: "x" }, { worktreeBase: "HEAD" }, { worktree: false, worktreeBranch: "x" }]) {
      const result = await tools.get("subagent").execute("t", { name: "n", task: "t", ...extra }, undefined, undefined, ctx(root));
      assert.match(result.details.error, /require worktree: true/);
    }
  });

  it("reports a non-repository source without spawning", async () => {
    const { tools } = setup();
    const plain = join(root, "not-a-repo");
    mkdirSync(plain, { recursive: true });
    const panes = panesCreated();
    const result = await tools.get("subagent").execute("t", { name: "n", task: "t", worktree: true }, undefined, undefined, ctx(plain));
    assert.match(result.details.error, /not inside a git work tree/);
    assert.equal(panesCreated(), panes);
  });

  it("runs the child in the worktree (cwd sub-path, session dir, header, task note, details) and reports final state", async () => {
    const repo = makeRepo();
    const { tools, sent } = setup();
    const result = await tools.get("subagent").execute(
      "t",
      { name: "WT Test", task: "build it", fork: true, worktree: true, cwd: join(repo, "packages", "api") },
      undefined,
      undefined,
      ctx(repo),
    );
    const d = result.details;
    const wt = d.worktree;
    const expectedPath = join(dirname(repo), `${basename(repo)}-memo-worktrees`, `wt-test-${d.id.slice(0, 8)}`);
    assert.equal(wt.path, expectedPath);
    assert.equal(wt.cwd, join(expectedPath, "packages", "api"));
    assert.equal(wt.branch, `memo/wt-test-${d.id.slice(0, 8)}`);
    assert.equal(wt.base, sh(repo, "rev-parse", "HEAD"));
    assert.equal(wt.repo, repo);
    assert.match(result.content[0].text, /Worktree: .*memo-worktrees.*branch memo\/wt-test/);

    const spec = launched(d);
    assert.equal(spec.cwd, wt.cwd);
    assert.match(spec.prompt, /\[memo-subagents worktree\] You are working in the git worktree/);
    assert.ok(spec.prompt.includes(`Do not modify the original checkout ${repo}`));
    assert.equal(dirname(d.sessionFile), sessionDirFor(wt.cwd));
    const header = JSON.parse(readFileSync(d.sessionFile, "utf8").split("\n")[0]);
    assert.equal(header.cwd, wt.cwd);

    const running = __test__.runningSubagents.get(d.id)!;
    assert.equal(running.worktree?.branch, wt.branch);
    const widget = __test__.renderSubagentWidgetLines([running], 200).join("\n");
    assert.ok(widget.includes(`⎇ ${wt.branch}`));

    const records = await __test__.listWorktreeEntries({ cwd: repo });
    assert.equal(records.length, 1);
    assert.equal(records[0].record.sessionFile, d.sessionFile);
    assert.equal(records[0].inUse, true);
    const inUse = await __test__.removeWorktreeEntry({ id: d.id });
    assert.equal(inUse.ok, false);
    assert.match(inUse.text, /in use/);

    writeFileSync(join(wt.cwd, "new.ts"), "export const x = 1;\n");
    sh(wt.path, "add", "-A");
    sh(wt.path, "commit", "-q", "-m", "child work");

    const final = await finish(d.id, sent);
    assert.equal(final.details.worktree.commitsAhead, 1);
    assert.equal(final.details.worktree.dirty, 0);
    assert.equal(final.details.worktree.untracked, 0);
    assert.match(final.content, /Worktree: .* \(branch memo\/wt-test-\w+, 1 commit ahead of \w{7}, clean\)\n\nSession: /);
    assert.equal(__test__.extractWorktreeBlock(final.content)?.trim().startsWith("Worktree: "), true);

    // Resume runs in the worktree.
    const resumed = await tools.get("subagent_resume").execute("t", { sessionPath: d.sessionFile, name: "Again" }, undefined, undefined, ctx(repo));
    assert.equal(resumed.details.status, "started");
    assert.equal(resumed.details.worktree.path, wt.path);
    const resumeSpec = launched(resumed.details);
    assert.equal(resumeSpec.cwd, wt.cwd);
    assert.deepEqual(resumeSpec.session, { kind: "file", path: d.sessionFile });
    assert.equal(resumeSpec.prompt, "");
    assert.equal(resumeSpec.exit, "auto");
    const resumedFinal = await finish(resumed.details.id, sent);
    assert.equal(resumedFinal.details.worktree.commitsAhead, 1);

    // Remove (branch not merged → kept), then resume is refused.
    const removed = await __test__.removeWorktreeEntry({ id: d.id.slice(0, 8), deleteBranch: true });
    assert.equal(removed.ok, true, removed.text);
    assert.equal(removed.details.branchDeleted, false);
    assert.ok(!existsSync(wt.path));
    assert.notEqual(sh(repo, "branch", "--list", wt.branch), "");
    const refused = await tools.get("subagent_resume").execute("t", { sessionPath: d.sessionFile }, undefined, undefined, ctx(repo));
    assert.match(refused.details.error, /was removed; resuming would run in the wrong checkout/);
    assert.equal((await __test__.listWorktreeEntries({ cwd: repo })).length, 0);
  });

  it("resume of a session without a worktree record runs in the current directory; a live session is refused", async () => {
    const { tools } = setup();
    const session = join(root, "other.jsonl");
    writeFileSync(session, `${JSON.stringify({ type: "session", version: 3, id: "o", cwd: root })}\n`);
    const resumed = await tools.get("subagent_resume").execute("t", { sessionPath: session, message: "go on", autoExit: false }, undefined, undefined, ctx(root));
    assert.equal(resumed.details.worktree, undefined);
    const spec = launched(resumed.details);
    assert.equal(spec.cwd, root);
    assert.equal(spec.prompt, "go on");
    assert.equal(spec.exit, "tool");
    // The session model is unknown: the parent's model is used.
    assert.equal(spec.model, "fake/parent");
    const twice = await tools.get("subagent_resume").execute("t", { sessionPath: session }, undefined, undefined, ctx(root));
    assert.equal(twice.details.error, "session in use");
    __test__.runningSubagents.get(resumed.details.id)?.abortController?.abort();
  });

  it("dirty source + TUI: cancelling creates nothing", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "README.md"), "local edit\n");
    const { tools } = setup();
    let asked: { title: string; options: string[] } | undefined;
    const panes = panesCreated();
    const result = await tools.get("subagent").execute(
      "t",
      { name: "dirty", task: "t", worktree: true },
      undefined,
      undefined,
      ctx(repo, { hasUI: true, select: async (title, options) => { asked = { title, options }; return options[1]; } }),
    );
    assert.ok(asked);
    assert.match(asked.title, /1 uncommitted\/untracked change\(s\) that will NOT be included/);
    assert.match(asked.options[0], /Proceed from the last commit/);
    assert.equal(result.details.worktreeCancelled, true);
    assert.match(result.content[0].text, /No worktree or subagent was created/);
    assert.equal(panesCreated(), panes);
    assert.ok(!existsSync(join(dirname(repo), `${basename(repo)}-memo-worktrees`)));
    assert.equal(sh(repo, "branch", "--list", "memo/*"), "");
  });

  it("dirty source + TUI: proceeding warns the child and the master", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "untracked.txt"), "u\n");
    const { tools } = setup();
    const result = await tools.get("subagent").execute(
      "t",
      { name: "dirty-ok", task: "t", worktree: true, fork: true },
      undefined,
      undefined,
      ctx(repo, { hasUI: true, select: async (_title, options) => options[0] }),
    );
    assert.equal(result.details.status, "started");
    assert.match(result.details.worktree.warnings[0], /NOT included in the worktree/);
    assert.match(result.content[0].text, /Worktree warning: The source checkout has 1 uncommitted/);
    assert.match(launched(result.details).prompt, /Warning: The source checkout has 1 uncommitted/);
    assert.ok(!existsSync(join(result.details.worktree.path, "untracked.txt")));
    __test__.runningSubagents.get(result.details.id)?.abortController?.abort();
  });

  it("dirty source without UI proceeds with the warning and never asks", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "README.md"), "local edit\n");
    const { tools } = setup();
    const result = await tools.get("subagent").execute(
      "t",
      { name: "headless", task: "t", worktree: true, worktreeBranch: "feature/headless" },
      undefined,
      undefined,
      ctx(repo),
    );
    assert.equal(result.details.status, "started");
    assert.equal(result.details.worktree.branch, "feature/headless");
    assert.match(result.details.worktree.warnings[0], /1 uncommitted/);
    // Wrapped (non-fork) delivery: the note is in the task prompt.
    assert.match(launched(result.details).prompt, /\[memo-subagents worktree\][\s\S]*Warning: The source checkout/);
    __test__.runningSubagents.get(result.details.id)?.abortController?.abort();
  });

  it("rolls the worktree back when the launch definitely failed, keeps it when uncertain", async () => {
    const repo = makeRepo();
    const { tools } = setup();
    const worktrees = () => sh(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length;
    fake.failLaunch = new RuntimeError("launch_failed", "shell never ready");
    try {
      await assert.rejects(
        tools.get("subagent").execute("t", { name: "fails", task: "t", worktree: true }, undefined, undefined, ctx(repo)),
        /rolled back/,
      );
      assert.equal(worktrees(), 1);
      assert.equal(sh(repo, "branch", "--list", "memo/*"), "");
      fake.failLaunch = new RuntimeError("launch_uncertain", "child readiness timed out");
      await assert.rejects(
        tools.get("subagent").execute("t", { name: "unsure", task: "t", worktree: true }, undefined, undefined, ctx(repo)),
        /kept for inspection/,
      );
      assert.equal(worktrees(), 2);
    } finally {
      fake.failLaunch = undefined;
    }
  });

  it("spawning: false denies subagent_worktrees", () => {
    assert.ok(__test__.resolveDenyTools({ spawning: false }).has("subagent_worktrees"));
  });

  it("subagent_worktrees tool lists and refuses unknown targets", async () => {
    const { tools } = setup();
    const tool = tools.get("subagent_worktrees");
    assert.ok(tool);
    const listed = await tool.execute("t", { action: "list", all: true }, undefined, undefined, ctx(root));
    assert.equal(listed.details.action, "list");
    assert.ok(Array.isArray(listed.details.worktrees));
    const refused = await tool.execute("t", { action: "remove", path: "/nonexistent" }, undefined, undefined, ctx(root));
    assert.match(refused.content[0].text, /Only worktrees created by subagent are managed here/);
  });

  it("the worktree result block is inserted before the session reference", () => {
    assert.equal(
      __test__.insertBeforeSessionRef("Done.\n\nSession: /s\nResume: pi --session /s", "Worktree: /w"),
      "Done.\n\nWorktree: /w\n\nSession: /s\nResume: pi --session /s",
    );
    assert.equal(__test__.insertBeforeSessionRef("Done.", "Worktree: /w"), "Done.\n\nWorktree: /w");
    assert.equal(
      __test__.formatWorktreeBadge({ branch: "memo/x", commitsAhead: 2, dirty: 0, untracked: 1, path: "/w" }),
      "⎇ memo/x · 2 ahead · dirty · /w",
    );
    const running = {
      id: "x", name: "n", task: "t", surface: "s", startTime: Date.now(), sessionFile: "/s",
      interactive: false, runtimePlan: undefined, lifecycle: createLifecycle(Date.now()),
    };
    assert.ok(!__test__.renderSubagentWidgetLines([running as any], 120).join("\n").includes("⎇"));
  });
});
