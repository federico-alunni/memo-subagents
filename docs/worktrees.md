# Worktree isolation

`subagent({ …, worktree: true })` runs the child in a fresh `git worktree` on a new branch, so several children can edit the same repository without touching each other or your checkout. It only changes the child's working directory.

Without `worktree: true` nothing changes: launched commands are byte-identical to the previous behaviour (covered by `test/worktree-launch.test.ts`).

## Parameters

| Parameter | Meaning |
| --- | --- |
| `worktree: true` | Enable isolation for this spawn. |
| `worktreeBranch` | Name of the **new** branch. Must be a valid ref name and must not exist (existing branches are never adopted). Default `<branchPrefix><slug(name)>-<id8>`, i.e. `memo/<slug>-<id8>`. |
| `worktreeBase` | Commit-ish to start from. Default `HEAD` of the source checkout. Resolved to a commit SHA at spawn time. |

`worktreeBranch` / `worktreeBase` without `worktree: true` is a validation error. The worktree path is not a model parameter; it comes from configuration. Agent frontmatter cannot enable worktrees in this version.

## Source, location and child cwd

- **Source directory**: the directory the child would otherwise run in — `cwd` parameter, else the agent's frontmatter `cwd`, else the session cwd. It must be inside a git work tree.
- **Location** (default): next to the repository, `<dirname(toplevel)>/<basename(toplevel)>-memo-worktrees/<slug>-<id8>`. With `config.json` → `"worktrees": { "root": "/abs/dir" }` it becomes `<root>/<repoName>/<slug>-<id8>`. A root inside the source checkout is refused.
- **Child cwd**: the same sub-path inside the worktree. Spawning with `cwd: "repo/packages/api"` starts the child in `<worktree>/packages/api` (or the worktree root if that directory does not exist at the base commit — reported as a warning).
- The child's pi session directory, the seeded session header (`lineage-only` / `fork`), `.pi/agent` lookup and the Herdr pane cwd all follow the worktree cwd. Runtime evidence stays in the private runtime state directory (outside the worktree).
- The task gets a short note: work in `<cwd>` on branch `<branch>` (base `<sha7>`), commit there, do not modify the original checkout, nothing is merged automatically.

## Creation and safety

All git calls use `execFile` (no shell), `-c core.fsmonitor=false`, `GIT_TERMINAL_PROMPT=0` and a 120 s timeout.

Preflight (nothing is created if any check fails): source inside a work tree; repository has commits; `check-ref-format refs/heads/<branch>`; branch does not exist; base resolves with `rev-parse --verify <base>^{commit}`; path does not exist and is not registered in `git worktree list --porcelain -z`.

Then `git worktree add -b <branch> <path> <baseSha>` and a read-back (registered, on the branch, `HEAD == baseSha`). If `add` fails or the read-back disagrees (e.g. a failing `post-checkout` hook), or the runtime launch definitely fails afterwards (`unsupported` / `launch_failed`), the worktree is rolled back with `git worktree remove <path>` (never `--force`) and `git update-ref -d refs/heads/<branch> <baseSha>` — the branch is deleted only if it still points at the base. An uncertain launch (`launch_uncertain`) keeps the worktree and any pane for inspection: a child may already be running there.

Shallow clones are allowed (warning). A detached `HEAD` in the source is fine (the base is a SHA).

### Dirty source checkout

Uncommitted and untracked changes in the source checkout are **not** part of the worktree (it starts from the last commit). When the source has such changes:

- **Interactive TUI** (`ctx.hasUI` and mode `tui`): you are asked — *proceed from the last commit `<sha7>` without these changes* or *cancel*. Cancel returns an error to the master and creates nothing (no worktree, branch or pane).
- **Print / JSON / RPC**: the spawn proceeds.

In every proceed case the warning is included in the child task note, in the tool result text (`Worktree warning: …`) and in `details.worktree.warnings`.

## Results

- Immediate tool result: a `Worktree:` line and `details.worktree = { id, repo, path, cwd, branch, base, warnings? }`.
- Final `subagent_result` / `subagent_ping` / error messages: `Worktree: <path> (branch <b>, <n> commits ahead of <base7>, clean|dirty)` inserted before the `Session:` reference, and `details.worktree` with `head`, `commitsAhead`, `dirty`, `untracked`, `exists`, `registered`.
- Widget: `⎇ <branch>` after the child name. `renderCall` shows ` in worktree`.

**There is no automatic merge.** Review, merge or cherry-pick with normal git commands from the master.

## Registry and resume

Each worktree spawn writes `$PI_CODING_AGENT_DIR/pi-memo-subagents/worktrees/<id>.json` (atomic write) with `{ id, name, agent, repo, sourceCwd, path, cwd, branch, base, sessionFile, parentSession, createdAt, removedAt? }`. The running entry (`RunningSubagent.worktree`) also survives `/reload`.

`subagent_resume` looks the session up in the registry. If found and the worktree still exists and is registered with git, the resumed child runs with `cd <worktree cwd>`; if it was removed, the resume is refused (it would run in the wrong checkout). Sessions without a record resume exactly as before.

## Cleanup

`subagent_worktrees`:

- `{ action: "list", all?: boolean }` — records of the current repository (or every repository with `all: true`) cross-checked with git: exists/registered, branch, commits ahead, dirty/untracked, locked, in-progress operation, in use by a running child.
- `{ action: "remove", id | path, deleteBranch?: boolean }` — refuses if the worktree is in use by a running child, not registered, locked, has uncommitted or untracked changes, or a merge/rebase/cherry-pick/revert/bisect in progress. Otherwise `git worktree remove <path>` (no `--force`). With `deleteBranch: true`, `git branch -d <branch>`: an unmerged branch is kept and reported. Only worktrees in the registry can be removed. A record whose worktree is already gone is simply forgotten.

`/subagent-worktrees` offers the same through `select` + `confirm`. Nothing is cleaned up automatically at shutdown.

## Caveats

- **Project trust**: a worktree is a new path without a saved trust decision. If the repository has project `.pi/` resources, a pi child may ask for trust in its pane and an autonomous child then waits. Trusting the `…-memo-worktrees` parent directory once (decisions are inherited from the nearest parent) avoids it.
- Worktrees do not contain ignored files (`.env`, `node_modules`), initialised submodules or LFS objects. Children may need to install/setup before running tests.
- `git worktree add` on large repositories or with slow hooks makes the spawn call slower (async, 120 s timeout).
- Herdr-based behaviour (pane cwd, widget) is covered by a fake `herdr` CLI in tests; verify live once with `PI_SUBAGENT_SURFACE` of your choice.
