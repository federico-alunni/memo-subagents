# Changelog

## Unreleased

### Added

- Herdr Agents panel tree: every subagent pane reports a display-only name `└─ <name>` (one `┊ ` per extra level for nested subagents) plus `parent=<caller pane>` and `tree_depth=<n>` tokens (`pane report-metadata --source memo-subagents`). Purely cosmetic; failures are ignored and lifecycle/identity are unchanged.

## 0.1.0 — 2026-10-07

First standalone release, imported from the pi-issue-round vendored copy of pi-herdr-subagents v0.2.0 (+ local pane selector).

### Added

- `worktree`, `worktreeBranch`, `worktreeBase` parameters on `subagent`: run a child in a fresh git worktree on a new branch, next to the repository (`<repo>-memo-worktrees/<slug>-<id8>`) or under `config.json` → `worktrees.root`; branch prefix `worktrees.branchPrefix` (default `memo/`). Results report path, branch, commits ahead and clean/dirty state; no automatic merge. See `docs/worktrees.md`.
- Dirty source checkout prompt in the interactive TUI (proceed from last commit / cancel); other modes proceed with a warning delivered to child and master.
- Rollback of a created worktree when the launch fails (never forced; branch deleted only while at base).
- Worktree registry per profile (`memo-subagents/worktrees/<id>.json`); `subagent_resume` resumes inside the worktree and refuses if it was removed.
- `subagent_worktrees` tool (list/remove; never `--force`, `git branch -d` only; gated by `spawning: false`) and `/subagent-worktrees` command.
- `MEMO_SUBAGENTS_CHILD_EXTENSIONS` / `MEMO_SUBAGENTS_CHILD_ENV` host composition (`docs/child-host.md`).
- Upstream live integration suite as opt-in `npm run test:integration`; `npm run test:live` for the pane selector.

### Changed

- Host composition now also applies to `subagent_resume` (previously resumed children lost host extensions/variables).
- `IR_CHILD_EXTENSIONS` / `IR_CHILD_ENV` are no longer read.

### Unchanged

- Without the new parameters/variables, launch and resume commands are byte-identical to before.
- Lifecycle, stall detection, interrupt, ping/done, reload survival and pane selector behaviour.
