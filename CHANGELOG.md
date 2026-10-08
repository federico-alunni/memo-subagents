# Changelog

## Unreleased

### Fixed

- A child waiting for the user (question or bash approval) is no longer shown or counted as active: the widget row reads `❓ question <duration>` / `❓ approval <duration>` (`blocked <duration>` when only Herdr says so), box headers count `N active · N question · N open` and use an attention color, also for Issue Round rows annotated active. The Herdr tab is `blocked`: the bash approval emits `herdr:blocked` like the `question` tool, and isolated children (no Herdr integration under `-ne`) report working/idle/blocked to Herdr themselves (`--source memo-subagents`). No steer is sent to the parent when a child waits (nor stalled while it waits).

### Added

- `activity.json` field `attention` (`{kind: question | approval | blocked, label?, since}`), written at once while a child waits for the user; `PresenceEntry.attention`. Older files stay valid. Contract in `docs/runtime.md`.

### Removed

- The runtime's own `question` tool and `runtime/child/question-dialog.ts`: the `question` tool now comes from the **pi-memo-question** package (see Changed).
- The old launch path: pi harness driver, `subagent-done.ts`, launch scripts and the terminal sentinel/`.exit` sidecar, the fixed shell delay `PI_SUBAGENT_SHELL_READY_DELAY_MS` (the runtime waits for a stable shell), pane creation in `herdr.ts`/`terminal.ts`, and the upstream live suite (`npm run test:integration`), which tested that path.

### Changed

- `Ctrl+Alt+X` cycles to the next open agent (menu order, wrapping around) instead of opening the `/subagent` menu.

- The `subagent` tool requires `thinking` unless the named agent declares a `thinking` default in its frontmatter: the caller's level is no longer inherited, so the master decides the effort of every spawn. A missing value is refused before any worktree or pane (`thinking is required…`, with the guidance scale). `subagent_resume` keeps the session's level, and runtime clients (Issue Round) are unchanged.
- Renamed from `memo-subagents` to **pi-memo-subagents**: package name (`pi-memo-subagents/runtime`), repository and checkout directory. Runtime state (`$TMPDIR/pi-memo-subagents-<uid>`), the worktree registry (`<agent dir>/pi-memo-subagents/worktrees`), the Herdr metadata source and the process-wide `Symbol.for` keys use the new name: agents launched by an older copy are not adopted after `/reload`. Environment variables too: `MEMO_SUBAGENTS_CHILD_EXTENSIONS` / `MEMO_SUBAGENTS_CHILD_ENV` are now `PI_MEMO_SUBAGENTS_CHILD_EXTENSIONS` / `PI_MEMO_SUBAGENTS_CHILD_ENV` (the old names are no longer read), and the child identity variables `MEMO_RUNTIME_*` are `PI_MEMO_RUNTIME_*`.
- Herdr Agents panel name of every subagent: `<caller workspace>-<caller tab>-sub<n>` (e.g. `local-app-PLAN-sub1`) instead of `└─ <label>`. `n` is the first index not used by the caller pane's live subagents of any runtime client (active + 1 without gaps); concurrent launches in one process get distinct indices. Display only: unreadable labels are omitted and failures never affect the launch. `treeDisplayName` is replaced by `subagentPanelName` and `nextSubagentIndex`.
- The pane selector moved into the agent runtime (`runtime/pane-selector.ts`, re-exported from `pane-selector.ts`) and is shared by every runtime client of the process: placements `auto` (the `subagent` tool) and `visible` (beside the caller, parking the agent shown there; Issue Round's triage and planner); every agent of the caller's workspace is registered with a control that moves it through its own runtime. `/subagent` and Ctrl+Alt+X list Issue Round agents too; the widget marks them with `▶` and shows the hint also without generic subagents.
- `move` is recorded and older handles of the same task follow recorded moves (a tab change nobody recorded is still `changed`), so a client keeps working when the selector moves its agent through another client's runtime.
- One `question` tool for the main agent and every child: **pi-memo-question** (new dependency). The runtime loads it with `-e` in isolated children with `question: true` and in every profile child; its dialogs become `question.json` records for any child (pending question in `observe`, ❓ in the widget), and it emits `herdr:blocked` everywhere. Answer texts and dialog are the master profile's (English).

### Added

- The `subagent` tool, `subagent_resume`, `/iterate` and `/subagent <agent>` launch through the agent runtime: profile children with exact identities, seeded/resumed session files in the usual session directory, `subagent_done`/`caller_ping`/auto exit recorded by the child, pane closed only after a proven end, interrupts as correlated requests, pane selector moves observed by the runtime. A session already open in a running subagent cannot be resumed twice. Resume runs in the session's own cwd and keeps its model while available. A crash (no exit record, no orderly pi shutdown) is reported as an error; an uncertain launch is reported with "do not relaunch". Runtime state lives in a private per-user directory under the system temp dir.
- Agent frontmatter `bash: full | readonly | none` (default `full`; `none` denies the bash tool) and `bash-allow` (comma-separated extra command prefixes on top of `readonly`; alone it implies `readonly`). Unknown values, `bash-allow` with `full`/`none` and non-plain entries fail the launch before any worktree or pane.
- Read-only memo subagents ask the user in their pane before running a plain bash command outside the read-only list and `bash-allow`: deny (default) / allow once / allow always for that subagent process (same first two words). No UI, cancel, abort or shell grammar → blocked.
- Runtime policy `bashAllow` (exact word prefixes allowed on top of `bash: "readonly"`) and `bashAsk` (only with `bash: "readonly"` and `userInput: "allowed"`: ask instead of block). Workflow children (`takeover`) never ask; boot records without the fields keep their meaning.
- Runtime options for generic subagents: `isolation: "profile"` (normal profile, optional allowlist, `denyTools`, per-child `agentDir` and `env`), `session: { kind: "file" }` (seeded or resumed sessions), `skills`, `userInput: "allowed"`, exit policies `auto`/`tool` with `subagent_done`/`caller_ping` and an `exit` record, `move` (pane selector) and `activity`. Boot records of 0.2.0 keep their meaning.

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
