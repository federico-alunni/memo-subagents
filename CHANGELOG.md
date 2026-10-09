# Changelog

## Unreleased

### Added

- **Ask-parent**: a subagent's `question` calls and bash approvals (`bashAsk`) go to the parent agent first, and reach the user only when the parent cannot answer. On by default for the children of `subagent`/`subagent_resume`; opt out with `ask-parent: false` in the agent definition or `askParent: false` on the spawn (the parameter wins); opted-out children behave exactly as before.
  - The parent agent receives a steer message (`subagent_request`: child id/name, kind, text and options or the command, `requestId`) and answers with the new `subagent_answer` tool (`answer`, `decision: "once" | "deny"`, `escalate: true`, `note`). Repeated or stale answers are refused. The child keeps running and waits; it never exits like `caller_ping`.
  - Policy limits: the parent may answer questions, deny, or allow a command once. "Always" can only be granted by the user (a parent `always` escalates). Commands the child's policy blocks are never sent, and the child re-checks every decision against its bash policy before running anything.
  - Escalation to the user in the parent session when the parent escalates, asks for "always", or does not answer within 60 s (`PI_MEMO_SUBAGENTS_ASK_PARENT_TIMEOUT_MS`). Several pending requests (one or more children) form one dialog browsed with `←`/`→`, each naming its child; questions use `pi-memo-question/dialog`, approvals `Rifiuta` / `Permetti una volta` / `Permetti sempre`.
  - Parent unavailable (quit, `/reload`, request not picked up, extension not loaded, no UI): the child asks the user in its own pane with today's dialog, without waiting for the timeout.
  - Nested subagents escalate one level at a time: an intermediate agent forwards to its own parent; only the top-level agent asks the user.
  - The child transcript records who answered (parent agent with name/id, or the user, escalated / timed out / asked in the pane) in the `question` result and in the bash result or block reason.
  - Widget and Herdr: `activity.json` attention gains `target` (`parent` | `user`); rows read `❓ question → parent` / `❓ approval → user`, the Herdr blocked label starts with `→ parent ·` / `→ user ·`. Kinds, durations and counts are unchanged.
- Runtime: `ChildPolicy.askParent` / `LaunchSpec.askParent` (default `false`: older boot records and other clients such as pi-issue-round keep today's behaviour; user-driven children only), `AgentRuntime.pendingAsks` / `markAsk` / `answerAsk` / `askHeartbeat`, `ChildRuntime.ask`. Ask-parent records reuse the correlated `<key>.request.json` / `<key>.response.json` (tool `ask_parent`, now a reserved name) and are not returned by `drainRequests`. Contract in `docs/runtime.md`.

### Changed

- Tests: the expected `question` extension path follows the runtime's own resolution (the pi-installed `pi-memo-question` first), so the suite passes on machines that installed it.
- Pane selector: a new `auto` launch takes the visible split whenever it is free (main tab with only the main pane, not zoomed, split not reserved), even with other agents open in background tabs. When the visible agent finishes, the next open agent in menu order (`Ctrl+Alt+X` order, wrapping around) is moved into the split once the finished pane has closed — same pane ID and terminal, through its runtime; the widget `▶` and `/subagent` menu follow it. Promotions share the launches' split reservation and the selector's refusals (unrelated splits, zoom, other workspaces).
- Pane selector: agents are shown in a column right of the main pane, 40% of the tab by default (`PI_SUBAGENT_COLUMN_RATIO`, a number strictly between 0 and 1; invalid → 0.4), applied when the pane is created and on every move into the column. The column has two stacked slots: one open agent fills it, two are shown top/bottom, more run in background tabs. Each slot is reserved synchronously, so concurrent launches never create more than two agent panes nor an extra split (a second concurrent launch waits for the first one's pane and splits it down). `Ctrl+Alt+X` swaps the two shown agents, or with three or more rotates them as a queue (top → tab, bottom → top, next in menu order → bottom, wrapping around); `/subagent` selection and `visible` launches with both slots taken follow the same queue rule, a free slot is simply filled. A finishing shown agent's slot is filled in place by the next background agent in menu order, otherwise the remaining agent takes the whole column. Every move goes through the owning runtime, is read back and rolled back on failure; the widget `▶` and the menu mark both shown agents. `SelectorState.selected`/`reservedSplit` became `slots`/`reservedSlots` (older states are migrated on load).

## 0.4.5 — 2026-10-09

### Added

- Planning panel free rows support rich metrics from live agents: elapsed time (`04:12` or `(18s)`), selected marker `▶`, right-aligned model and activity (`profile-high|high · question 15s`), bottom navigation hint, and `? N in attesa` in the top bar with attention styling.

## 0.4.4 — 2026-10-09

### Fixed

- Concurrent delegated tool calls (e.g. parallel `subagent` calls from an agent in the same turn) no longer fail with `subagent_spawn is restricted to the active task (one request at a time)`. Delegated requests now use concurrent tracking instead of a single pending request slot.

## 0.4.3 — 2026-10-09

### Added

- Grid `2×2` lead-anchored layout: slot 0 (lead agent) stays full-width across the top half (50% height); slots 1 & 2 share the bottom half side by side (50% width, 50% height each). Capacity of visible split is 3 panes.
- Lane inheritance and slot delegation: a subagent spawned by a helper in slot 1 or 2 inherits that lane and temporarily takes its slot while the parent waits. When it finishes, the parent is promoted back.
- `Ctrl+Alt+X` cycling in `2×2`: keeps the lead agent permanently anchored in slot 0, rotating only the helper lanes below.

## 0.4.2 — 2026-10-09

### Fixed

- A subagent keeps the session socket inherited from its parent instead of starting its own. Its scripts (e.g. a CLI asking for a `replace` handoff) therefore act as this agent in the session that owns it: the successor is supervised and closed there, and the slot's final result reaches the main session. Before, the successor belonged to the agent it replaced, which then ended: nobody supervised or closed it.
- A spawn requested over the session socket by a subagent (e.g. a CLI handoff) no longer fails with `Cannot read properties of undefined (reading 'getThinkingLevel')`.

### Added

- Panel rows may give `waitingText`, shown while their subagent waits for the user.
- Frontmatter `spawning: true` (with optional `spawning-depth`) grants delegated spawning by default; an explicit `spawning` parameter wins.

## 0.4.1 — 2026-10-09

### Fixed

- Closing a finished child no longer closes its tab when another pane still shares it. A handoff successor is created in the tab of its predecessor; closing the predecessor's tab took the successor down (`convoy smoke` failed at the build → simplify handoff). The tab is closed only when the child was its only pane.

## 0.4.0 — 2026-10-09

First stable release of the merged line: pane-selector grid, worktree sub-spaces with mirrors, ask-parent
with per-question target, auto-exit by default, the installed pi-memo-question as the only question tool,
and deterministic CI without local dependencies.

## 0.4.0-beta.5 — 2026-10-09

### Added

- **Agent grid**: the agent area right of the main pane is a configurable grid of `cols × rows` cells (default `1x2`). Set globally with `PI_SUBAGENT_GRID` or `"layout": { "grid": "..." }` in `pi-memo-subagents.json`, or per agent with frontmatter `grid: 2x2` (the largest grid of the live agents wins while it lives). Cells fill row by row with equal shares across rows and columns; excess agents run in background tabs and rotate with `Ctrl+Alt+X`. Delegated children place into the same grid.
- **Ask-parent with per-question target**: every child can ask its parent agent via `to: "parent"` on the `question` tool (steer `subagent_request`, answered with `subagent_answer`). The default target is the user; set `askParent: true` / frontmatter `ask-parent: true` to make the parent the default target for questions without `to` and for bash approvals.
- **Standalone `pi-memo-question` integration**: `pi-memo-subagents` bundles no copy of the question tool; children register a process-wide router hook (`globalThis[Symbol.for("pi-memo-question/router")]`) through which the installed package routes to the parent when requested.

### Fixed

- Task delivery: multiple skills and prompt are delivered in a single user message instead of queuing fragmented turns via follow-ups (which caused models to run turns on slash commands without the task prompt). Single skills expand via `/skill:<name> <prompt>`.
- Merged `main` (pane selector, ask-parent) cleanly into `beta`.
- Ordered slot creation across grid rows (`waitFor` previous slot) so lower rows don't split prematurely during concurrent launches.
- Rebalance grid resizes after adopt.

## 0.4.0-beta.4 — 2026-10-09

### Changed

- Subagents close when they are done by default, named agents included: new `autoExit` spawn parameter (then `auto-exit` frontmatter, then `true`). `interactive` only silences stall pings and no longer keeps a subagent open; `/iterate` passes `autoExit: false`.
- An explicit `thinking` level the selected model does not support is clamped to the nearest supported level (e.g. `minimal` → `low`) and reported in the launch result, instead of failing the spawn.
- **Supplied panels follow the life of their subagents.** A panel that names subagents (`group`, or `subagent` on items/rows) is shown only while one of them is alive, while it sets `attention`, or for `linger` ms after its last live subagent. A panel that names none is shown as long as its provider keeps it. A provider can no longer leave a stale box above the editor.
- **One box.** Live subagents that no panel item stands for are folded into the last supplied panel (rows, compact items, or a trailing group), instead of a second box. Items standing for a live subagent take its live dot and flag (`?40s` waiting, `⚠12m` stalled).
- **Socket tokens identify the caller.** Each subagent process gets its own token (`<id>.<mac>`); requests made with it act as that subagent whatever `callerId` they send (`caller_mismatch` otherwise), so a subagent can no longer obtain session rights by omitting `callerId`. A subagent may `send` to / `interrupt` only itself and the agents it started. The session token keeps full rights.
- Widget and status refresh timers are `unref`'d (they no longer keep a headless process alive).

### Added

- `PI_SUBAGENT_PANE_LINGER`: delays closing a completed subagent's pane (e.g. `30s`, `2m`), so the user can inspect its final terminal output before the pane closes.
- `group` for agents started by scripts (socket `spawn`): inherited by agents they start; reported by `list` and the lifecycle events. `subagents:ready` carries a snapshot `{ agents: { id, name, agent, group }[] }`.
- [docs/socket.md](docs/socket.md): the session socket, its tokens and methods.

### Changed

- `worktree: true` opens the agent in its own Herdr sub-space by default (any caller, not only orchestrators). Opt out with `worktreeSpace: false`; `fork` and `handoff` never default to a sub-space.

### Fixed

- Mirror column: closes as soon as the last worktree-space agent ends (the close was only retried by the widget refresh, which stops with the last agent, and a sync requested during another one was dropped).
- Mirror column: view and record files are per session (`column-<pid>.*`); two pi sessions of the same user no longer show or delete each other's mirror.
- Worktree placement: when `herdr worktree open` is refused (e.g. repository outside the caller workspace), a dedicated workspace is created instead of falling back to creating tabs in the caller workspace.
- Tab cleanup: closing a completed subagent in a dedicated tab closes the Herdr tab, and waits up to 1.5s for process exit so cleanups are not prematurely blocked.
- Supplied panel: the presence row of a live subagent shown by the panel no longer adds a second box.
- Panel renderer in narrow panes: every line keeps the exact width (the top bar sheds progress glyphs, then the phase, then cuts the title; long rows are cut with `…`), and an active group's label never runs into the column headers.
- The `pi-subagent` bin is self-contained JavaScript: installed from npm it imported `client.ts`, which Node refuses to type-strip under `node_modules`.

## 0.4.0-beta.3 — 2026-10-09

### Added

- **Session socket & script access**: private Unix domain socket server (`PI_SUBAGENT_SOCKET`, `PI_SUBAGENT_SOCKET_TOKEN`) enabling scripts, background tools, and CLI commands to interact with the subagent runtime.
  - Supports `spawn`, `list`, `send`, `interrupt` over line-delimited JSON.
  - TypeScript client `SubagentClient` in `pi-memo-subagents/client` and executable binary `pi-subagent`.
  - Child processes inherit socket credentials: a worker tool can initiate a `replace` handoff directly.
- **Configurable worktree naming**: `branchTemplate` and `pathTemplate` in config, with environment overrides (`PI_SUBAGENT_WORKTREE_BRANCH`, `PI_SUBAGENT_WORKTREE_PATH`), supporting `{name}`, `{repoName}`, `{id8}`, etc., falling back seamlessly to default `memo/<name>-<id8>`.
- **Explicit worktree path**: optional `worktreePath` parameter to place a worktree at a specific directory.
- **Extra agent definitions**: `PI_SUBAGENT_AGENT_DIRS` (`:`-separated paths) loads extra agent definitions alongside global and project agents.
- **Lifecycle events on pi.events**: `subagents:started` and `subagents:ended` allow other extensions to react to subagent lifecycle deterministically.

## 0.4.0-beta.2 — 2026-10-09

### Changed

- **Generic status panel**: the opt-in `convoy` surface of 0.4.0-beta.1 becomes `PI_SUBAGENT_SURFACE=panel` (`runtime/panel.ts`). `renderPanel(data, width, theme): string[]` stays a pure, dependency-free renderer, but everything it shows now comes from the data: brand (default `⧉ Subagents`), title, phase, progress (only with `total > 0`), stage columns with their glyphs and legend, groups with their notes, free rows. Golden tests cover free rows, staged groups and compact mode at W=96 and W=140.
  - Built-in data: worktree slots render as a grid of items (state dot, `?40s` waiting / `⚠12m` stalled flags, agent chain, `▸` selection, `⎇ <branch> · <status>` detail row); other agents render as one row each (`? planner`, `◐ research · ↳ planner`).

### Added

- **Inter-extension status panels**: another extension supplies its own panel with `pi.events.emit("subagents:panel", { source, data })` (`data: null` removes it). Supplied panels are rendered above the editor in every surface; subagents they name (`subagent` on an item or row) leave the extension's own rows, and the selected one gets the `▸` marker. `subagents:ready` is emitted at session start so a provider loaded earlier can send its panel again. See [docs/panel.md](docs/panel.md).

### Removed

- `PI_SUBAGENT_SURFACE=convoy`, `runtime/convoy-panel.ts`, `renderConvoyPanel` and `buildConvoyPanelDataFromAgents` (replaced by the generic panel above).

## 0.4.0-beta.1 — 2026-10-08

### Added

- **Worktree-space mirror & delegated handoff**: `subagent({ ..., worktree: true, worktreeSpace: true })` opens the child in its own Herdr workspace and shows a read-only mirror pane beside the main pane.
  - The mirror renders the child's live terminal with the issue #86 style header (`╭─ <status> <name> │ <agent> │ ⎇ <branch> ─── <duration> ─╮`), accent-colored side borders, and auto-cropped chat input (the input row and lower border are removed; status bar and footer remain).
  - When the child enters a dialog (`question` or `bashAsk` approval), the mirror displays the full uncropped screen, appends `[rispondi qui]` to the header, and forwards dialog keys (arrows, Enter, Esc, Tab, Backspace, printable text) directly to the child's pane. Polling rate dynamically ramps up from 1000ms to 100ms (~10 fps) with filesystem watching on the view file and immediate multi-frame repaints on keystrokes for snappy feedback. Outside dialogs, typed input is safely dropped and polling returns to 1s.
  - Worktree-space subagents can start successor agents in their workspace using `subagent({ handoff: "wait" | "replace", ... })`. With `wait`, the parent pauses its turn while the child runs, and receives the result as its next task. With `replace`, the parent completes silently and the successor takes over the slot; the main session receives the final result with the full agent chain in details.
  - Selecting an open mirror in `/subagent` or via `Ctrl+Alt+X` promotes the active agent by moving focus to its workspace (`herdr agent focus`, with fallback to workspace + tab navigation).
  - The widget groups worktree-space handoff chains into a single slot row (`⧉ root (agent) › successor ...`) with the slot's cumulative elapsed time and current status.
  - **Multi-pane stacked column**: When multiple worktree-space slots run simultaneously, they share a single right-hand column split. The viewer balances vertical heights evenly (`rows // N`, minimum 6 rows per box), with an overflow indicator (`… (+N more in background)`) when more workers run than fit on screen. When one worker finishes, remaining boxes expand immediately; when all finish, the mirror column cleanly closes.
  - Interactive input routing in multi-pane mode: routes directly to the worker with active dialog attention matching the selector's `▶` choice (or the first slot with attention). Cycling (`Ctrl+Alt+X`) and `/subagent` cycle through all open slots and update the active interactive target.
  - `MirrorManager` supervises viewer processes via `AgentRuntime`, writes persistent ownership records (`<stateDir>/mirrors/column.json`), updates active views atomically on handoffs, cleanly closes viewers on shutdown, and reconciles orphaned viewer panes from dead processes.
- `LaunchSpec.viewer`: AgentRuntime launch capability for launching read-only terminal programs with child identity and shutdown guarantees, omitting pi CLI checks and presence rows.
- `LaunchSpec.spaceRoot`: Allows launching worktree-space children from sub-directories within the worktree checkout.
- `DelegatedToolSpec.internal`: Policy flag for internal delegated transports (e.g. `subagent_handoff`), accessible to child extensions without being exposed as visible model tools.
- **Convoy surface mode & issue #86 panel**: Opt-in `PI_SUBAGENT_SURFACE=convoy` renders the approved issue #86 panel above the editor (`runtime/convoy-panel.ts`), featuring the `╭─ ⛟ Convoy │ <title> │ phase <phase> ...` header bar with progress indicators, stages grid (`B S R C ☑`), selection marker `▸` in the free cell before the dot without shifting alignment, stall durations (`⚠12m` or `?40s`), and selected worker detail row (`⎇ <branch> · <status>`).
  - Implemented as a pure, dependency-free function (`renderConvoyPanel(data, width, theme): string[]`) verified against golden byte-for-byte tests for all 3 scenarios (planning, execution, compact) at W=96 and W=140.
  - Leaves existing surfaces (`selector`, `split`, `tab`) and their tests completely unchanged.
- **Delegated spawning & child columns** (`spawning: true`, `spawningDepth`): A sub-agent can start its own sub-agents (e.g. planner spawning researchers/challengers, each challenger spawning a researcher).
  - The request travels through the unified internal transport (`SPAWN_TOOL`, `subagent_spawn`) to the main session, which launches, owns and supervises each child, guaranteeing clean shutdowns, durable evidence and widget visibility.
  - The spawned children open in a vertical column under their requester (`runtime/column-layout.ts`), with incremental splits and automatic rebalancing: the root keeps its half, the members below share the rest equally, and space returns cleanly when a member ends.
  - Results are routed directly to the requester as separate tasks via `dispatch` (with retry on busy, so multiple concurrent children queue cleanly); the requester ends its turn with `holdAutoExit`.
  - Recursive spawning is capped by `spawningDepth` (1–4, default 2), decremented at each level.
  - In `convoy` surface mode, non-worktree agents automatically render as the issue #86 scenario-1 planning rows (`? planner`, `✓ research`, `◐ challenger` with `↳ <requester>`).
- `LaunchSpec.splitTarget` and `LaunchSpec.splitRatio`: Runtime support for splitting a specific pane (not the caller's) with an explicit ratio, enabling column stacks.
- Pure column layout geometry module (`runtime/column-layout.ts`) with target ratios, top-to-bottom ordering, and Herdr resize planning.
- Unified internal spawn transport (`handoff.ts`: `subagent_spawn`), covering `delegate`, `wait` and `replace` modes with validation, requester cwd resolution and server-side authorization.
- Pure mirror rendering module (`runtime/mirror-view.ts`) and standalone viewer process (`runtime/mirror-viewer.ts`).

## 0.3.0 — 2026-10-08

### Changed

- Distribution: `pi-memo-question` is now a git dependency (`git+https://github.com/federico-alunni/pi-memo-question.git#semver:^0.1.0`) instead of `file:../pi-memo-question`, so the package installs from git on any machine. CI (`.github/workflows/ci.yml`) runs the tests on `main`/PRs; pushing a `vX.Y.Z` tag runs `release.yml` and creates the GitHub Release. Install and release steps in the README.
- User config moved out of the package: `~/.pi/agent/pi-memo-subagents.json` (`$PI_CODING_AGENT_DIR`, or `PI_MEMO_SUBAGENTS_CONFIG`), with the package-root `config.json` as fallback. pi runs `git clean -fdx` on git updates, which deleted `config.json` at every `pi update --extensions`.
- The `question` extension is resolved from the pi-installed `pi-memo-question` first (one load per process), then from the bundled dependency. Dependency URL is `git+https://` (no SSH key needed).
- `peerDependencies` lists `typebox` (was `@sinclair/typebox`; sources import `typebox`), `engines.node >= 22.15`; `test/host-aliases.mjs` fails with a hint instead of assuming a Homebrew path.
- Tests: `test/host-aliases.mjs` also works in CI (host packages from npm, `@sinclair/typebox` → `typebox`, `.ts` of the `pi-memo-question` dependency loaded under `node_modules`); the `/subagent <profile>` test no longer depends on `~/.pi/agent/agents`.

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
