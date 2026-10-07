# Changelog

## 0.2.0 — 2026-10-08

### Added

- `memo-subagents/runtime` (package `exports`): `AgentRuntime` launches and controls pi children in Herdr panes with exact identities and durable evidence — launch (split/tab/Herdr worktree space), multi-task `dispatch`, `observe`/`watch`, delegated tools answered by the parent (`drainRequests`/`respond`/`hasResponse`), `interrupt`, proven `stop`/`close`, `inspectShutdown`, `focus`. Child extension with tool allowlist, read-only bash policy, optional `question` tool and takeover detection. Ported from pi-issue-round's transport and made role-agnostic. Contract: `docs/runtime.md`.
- Unified widget: agents of any runtime client in the process are listed in the memo widget, one box per `display.group` (e.g. "Issue Round"), with client-provided workflow status (`annotate`).

### Removed

- Non-pi harness drivers (Claude Code, Codex, OpenCode, Grok, generic `command`/`command-template`), `harness/pane-summary.ts` and the Claude Code plugin hook (`plugin/`). memo-subagents launches only pi; an agent definition with `cli:` other than `pi` fails at spawn with `UnsupportedCliError`, before any worktree or pane is created.
- `resumeSessionId` parameter of `subagent` (Claude Code sessions) and `claudeSessionId` result details.

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
