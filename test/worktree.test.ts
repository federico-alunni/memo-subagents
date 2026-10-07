import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  createWorktree,
  findWorktreeRecordBySession,
  getWorktreeState,
  loadWorktreeConfig,
  markWorktreeRecordRemoved,
  parseWorktreeConfig,
  parseWorktreeListPorcelainZ,
  planWorktree,
  readWorktreeRecords,
  removeWorktree,
  rollbackWorktree,
  slugifyName,
  writeWorktreeRecord,
} from "../pi-extension/subagents/worktree.ts";

let root: string;
const savedEnv: Record<string, string | undefined> = {};
const GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "memo-wt-test-")));
  const globalConfig = join(root, "gitconfig");
  writeFileSync(globalConfig, "[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n");
  for (const [name, value] of Object.entries({ ...GIT_ENV, GIT_CONFIG_GLOBAL: globalConfig })) {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }
});
after(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

let counter = 0;
function makeRepo(): string {
  const repo = join(root, `repo${++counter}`);
  mkdirSync(join(repo, "packages", "api"), { recursive: true });
  sh(root, "init", "-q", repo);
  writeFileSync(join(repo, "README.md"), "hello\n");
  writeFileSync(join(repo, "packages", "api", "index.ts"), "export {};\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "initial");
  return repo;
}

describe("worktree config", () => {
  it("defaults, root/branchPrefix and strict keys", () => {
    assert.deepEqual(parseWorktreeConfig({}), { branchPrefix: "memo/" });
    assert.deepEqual(parseWorktreeConfig({ worktrees: {} }), { branchPrefix: "memo/" });
    assert.deepEqual(parseWorktreeConfig({ worktrees: { root: "/wt", branchPrefix: "agents/" } }), {
      root: "/wt",
      branchPrefix: "agents/",
    });
    assert.throws(() => parseWorktreeConfig({ worktrees: { path: "/x" } }), /unsupported key/);
    assert.throws(() => parseWorktreeConfig({ worktrees: { root: "relative" } }), /absolute/);
    assert.throws(() => parseWorktreeConfig({ worktrees: { branchPrefix: "bad prefix" } }), /branchPrefix/);
    assert.throws(() => parseWorktreeConfig({ worktrees: [] }), /must be an object/);
    assert.deepEqual(loadWorktreeConfig(join(root, "missing.json")), { branchPrefix: "memo/" });
    const file = join(root, "cfg.json");
    writeFileSync(file, JSON.stringify({ status: { enabled: true }, worktrees: { branchPrefix: "x/" } }));
    assert.deepEqual(loadWorktreeConfig(file), { branchPrefix: "x/" });
  });

  it("slugifies names", () => {
    assert.equal(slugifyName("WT Test!"), "wt-test");
    assert.equal(slugifyName("***"), "subagent");
  });

  it("parses porcelain -z output including locked entries", () => {
    const parsed = parseWorktreeListPorcelainZ(
      "worktree /a\0HEAD 1111\0branch refs/heads/main\0\0worktree /b\0HEAD 2222\0detached\0locked why\0\0",
    );
    assert.deepEqual(parsed, [
      { path: "/a", head: "1111", branch: "refs/heads/main" },
      { path: "/b", head: "2222", detached: true, locked: "why" },
    ]);
  });
});

describe("worktree creation", () => {
  it("creates next to the repo with default branch, preserving the cwd sub-path", async () => {
    const repo = makeRepo();
    const head = sh(repo, "rev-parse", "HEAD");
    const plan = await planWorktree({ sourceCwd: join(repo, "packages", "api"), id: "abcdef1234567890", name: "WT Test" });
    assert.equal(plan.branch, "memo/wt-test-abcdef12");
    assert.equal(plan.path, join(dirname(repo), `${basename(repo)}-memo-worktrees`, "wt-test-abcdef12"));
    assert.equal(plan.baseSha, head);
    assert.equal(plan.rel, join("packages", "api"));
    assert.deepEqual(plan.warnings, []);
    const info = await createWorktree(plan);
    assert.equal(info.cwd, join(plan.path, "packages", "api"));
    assert.ok(existsSync(join(info.cwd, "index.ts")));
    assert.equal(sh(info.path, "symbolic-ref", "--short", "HEAD"), "memo/wt-test-abcdef12");
    assert.equal(sh(info.path, "rev-parse", "HEAD"), head);
  });

  it("honours explicit branch, base and config root", async () => {
    const repo = makeRepo();
    const first = sh(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "second.txt"), "2\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "second");
    const wtRoot = join(root, "custom-root");
    const plan = await planWorktree({
      sourceCwd: repo,
      id: "11112222333344445555",
      name: "x",
      branch: "feature/explicit",
      base: "HEAD~1",
      config: { root: wtRoot, branchPrefix: "ignored/" },
    });
    assert.equal(plan.path, join(wtRoot, basename(repo), "x-11112222"));
    assert.equal(plan.baseSha, first);
    const info = await createWorktree(plan);
    assert.equal(sh(info.path, "rev-parse", "HEAD"), first);
    assert.ok(!existsSync(join(info.path, "second.txt")));
  });

  it("rejects non-repos, invalid/existing branches, bad bases and existing paths", async () => {
    const repo = makeRepo();
    const plain = join(root, "plain");
    mkdirSync(plain, { recursive: true });
    await assert.rejects(planWorktree({ sourceCwd: plain, id: "aaaaaaaa", name: "a" }), /not inside a git work tree/);
    await assert.rejects(planWorktree({ sourceCwd: repo, id: "aaaaaaaa", name: "a", branch: "bad..name" }), /invalid branch/);
    await assert.rejects(planWorktree({ sourceCwd: repo, id: "aaaaaaaa", name: "a", branch: "main" }), /already exists/);
    await assert.rejects(planWorktree({ sourceCwd: repo, id: "aaaaaaaa", name: "a", base: "nope" }), /does not resolve/);
    await assert.rejects(planWorktree({ sourceCwd: repo, id: "aaaaaaaa", name: "a", base: "--all" }), /invalid base/);
    const plan = await planWorktree({ sourceCwd: repo, id: "bbbbbbbb", name: "a" });
    mkdirSync(plan.path, { recursive: true });
    await assert.rejects(planWorktree({ sourceCwd: repo, id: "bbbbbbbb", name: "a" }), /path already exists/);
    await assert.rejects(
      planWorktree({ sourceCwd: repo, id: "cccccccc", name: "a", config: { root: join(repo, "inside"), branchPrefix: "memo/" } }),
      /inside the source checkout/,
    );
  });

  it("warns about a dirty source and does not carry its changes", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "README.md"), "changed\n");
    writeFileSync(join(repo, "untracked.txt"), "u\n");
    const plan = await planWorktree({ sourceCwd: repo, id: "dddddddd", name: "dirty" });
    assert.equal(plan.sourceDirty, 1);
    assert.equal(plan.sourceUntracked, 1);
    assert.match(plan.warnings[0], /2 uncommitted\/untracked change\(s\) that are NOT included/);
    const info = await createWorktree(plan);
    assert.ok(!existsSync(join(info.path, "untracked.txt")));
    assert.equal(sh(info.path, "show", "HEAD:README.md"), "hello");
    assert.deepEqual(info.warnings, plan.warnings);
  });

  it("works from a detached HEAD source", async () => {
    const repo = makeRepo();
    sh(repo, "checkout", "-q", "--detach");
    const plan = await planWorktree({ sourceCwd: repo, id: "eeeeeeee", name: "detached" });
    const info = await createWorktree(plan);
    assert.equal(sh(info.path, "rev-parse", "HEAD"), sh(repo, "rev-parse", "HEAD"));
  });

  it("rolls back a failed add (post-checkout hook) and deletes the branch only while at base", async () => {
    const repo = makeRepo();
    const hook = join(repo, ".git", "hooks", "post-checkout");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const plan = await planWorktree({ sourceCwd: repo, id: "ffffffff", name: "hook" });
    await assert.rejects(createWorktree(plan), /creation failed.*Rolled back/s);
    assert.ok(!existsSync(plan.path));
    assert.equal(sh(repo, "branch", "--list", plan.branch), "");
    rmSync(hook);

    const plan2 = await planWorktree({ sourceCwd: repo, id: "99999999", name: "moved" });
    const info = await createWorktree(plan2);
    writeFileSync(join(info.path, "new.txt"), "n\n");
    sh(info.path, "add", "-A");
    sh(info.path, "commit", "-q", "-m", "child work");
    const rollback = await rollbackWorktree(info);
    assert.equal(rollback.removed, true);
    assert.equal(rollback.branchDeleted, false);
    assert.match(rollback.errors.join(), /kept/);
    assert.notEqual(sh(repo, "branch", "--list", plan2.branch), "");
  });
});

describe("worktree state and removal", () => {
  it("reports state and refuses unsafe removals; branch -d keeps unmerged branches", async () => {
    const repo = makeRepo();
    const info = await createWorktree(await planWorktree({ sourceCwd: repo, id: "12121212", name: "rm" }));
    let state = await getWorktreeState(info);
    assert.equal(state.registered, true);
    assert.equal(state.commitsAhead, 0);
    assert.equal(state.dirty, 0);

    assert.match((await removeWorktree(info, { inUse: true })).messages[0], /in use/);

    writeFileSync(join(info.path, "README.md"), "dirty\n");
    assert.match((await removeWorktree(info)).messages[0], /1 uncommitted/);
    sh(info.path, "checkout", "--", "README.md");
    writeFileSync(join(info.path, "u.txt"), "u\n");
    assert.match((await removeWorktree(info)).messages[0], /1 untracked/);
    rmSync(join(info.path, "u.txt"));

    sh(repo, "worktree", "lock", info.path, "--reason", "testing");
    assert.match((await removeWorktree(info)).messages[0], /locked \(testing\)/);
    sh(repo, "worktree", "unlock", info.path);

    writeFileSync(join(info.path, "c.txt"), "c\n");
    sh(info.path, "add", "-A");
    sh(info.path, "commit", "-q", "-m", "child commit");
    state = await getWorktreeState(info);
    assert.equal(state.commitsAhead, 1);

    const removed = await removeWorktree(info, { deleteBranch: true });
    assert.equal(removed.ok, true);
    assert.equal(removed.removed, true);
    assert.equal(removed.branchDeleted, false);
    assert.match(removed.messages.join("\n"), /Kept branch .*not fully merged/s);
    assert.ok(!existsSync(info.path));
    assert.notEqual(sh(repo, "branch", "--list", info.branch), "");
    assert.match((await removeWorktree(info)).messages[0], /not a registered worktree/);
  });

  it("removes a clean merged worktree and deletes its branch", async () => {
    const repo = makeRepo();
    const info = await createWorktree(await planWorktree({ sourceCwd: repo, id: "34343434", name: "clean" }));
    const removed = await removeWorktree(info, { deleteBranch: true });
    assert.equal(removed.ok, true);
    assert.equal(removed.branchDeleted, true);
    assert.equal(sh(repo, "branch", "--list", info.branch), "");
  });

  it("refuses removal during an in-progress operation", async () => {
    const repo = makeRepo();
    const info = await createWorktree(await planWorktree({ sourceCwd: repo, id: "56565656", name: "op" }));
    const gitDir = sh(info.path, "rev-parse", "--absolute-git-dir");
    writeFileSync(join(gitDir, "MERGE_HEAD"), `${info.base}\n`);
    assert.match((await removeWorktree(info)).messages[0], /merge is in progress/);
  });
});

describe("worktree registry", () => {
  it("writes atomically, reads, finds by session and marks removal", () => {
    const dir = join(root, "registry");
    const base = {
      name: "r",
      repo: "/r",
      sourceCwd: "/r",
      path: "/r-wt/x",
      cwd: "/r-wt/x",
      branch: "memo/x",
      base: "a".repeat(40),
    };
    writeWorktreeRecord(dir, { ...base, id: "one", sessionFile: "/s/1.jsonl", createdAt: 1 });
    writeWorktreeRecord(dir, { ...base, id: "two", sessionFile: "/s/2.jsonl", createdAt: 2 });
    assert.deepEqual(readdirSync(dir).sort(), ["one.json", "two.json"]);
    assert.deepEqual(readWorktreeRecords(dir).map((r) => r.id), ["one", "two"]);
    assert.equal(findWorktreeRecordBySession(dir, "/s/2.jsonl")?.id, "two");
    assert.equal(findWorktreeRecordBySession(dir, "/s/3.jsonl"), undefined);
    assert.equal(markWorktreeRecordRemoved(dir, "one", 99)?.removedAt, 99);
    assert.equal(readWorktreeRecords(dir)[0].removedAt, 99);
    assert.throws(() => writeWorktreeRecord(dir, { ...base, id: "../x", createdAt: 3 }), /Invalid/);
  });
});
