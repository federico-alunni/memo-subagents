# pi-memo-subagents

Interactive, non-blocking [pi](https://github.com/badlogic/pi-mono) subagents running in [Herdr](https://herdr.dev) panes — using **agent definitions you keep elsewhere** (`~/.pi/agent/agents/*.md` and project `.pi/agents/*.md`), with an in-session pane selector, optional **git worktree isolation** and host-controlled child composition for custom pi profiles.

pi-memo-subagents is a derivative of [pi-herdr-subagents](https://github.com/0xRichardH/pi-herdr-subagents) v0.2.0 (itself derived from [pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [provenance.json](provenance.json).

> **Never load pi-memo-subagents together with pi-herdr-subagents** (or another copy of it). Both register the same tools (`subagent`, `subagents_list`, `subagent_resume`, `subagent_interrupt`) and share the same `globalThis` runtime keys (`Symbol.for("pi-subagents/…")`, kept unchanged so `/reload` adoption keeps working). Remove the other package first, with pi closed and no subagents running.

## What it does

- `subagent({ name, task, agent?, … })` returns immediately; the child runs in its own Herdr pane and its result is **steered back** into the main session when it finishes (`subagent_result`), or when it asks for help (`caller_ping` → `subagent_ping`).
- No bundled agents and no `/plan` command: only global (`$PI_CODING_AGENT_DIR/agents`, default `~/.pi/agent/agents`) and project (`.pi/agents`) definitions are discovered. Project definitions override global ones with the same name.
- **Ask-parent**: a child chooses per question whom to ask — the user, or **you, the parent agent** (`question` with `to: "parent"`: steer message `subagent_request`, answered with `subagent_answer`; it reaches the user only when you escalate, for "always" approvals, or after 60 s without an answer). The default target is the user; `askParent: true` / `ask-parent: true` makes it the parent (questions without `to` and bash approvals). The child keeps running and waits; it never exits like `caller_ping`. See [Ask-parent](#ask-parent).
- Live widget above the editor with lifecycle state (`starting`, `active`, `waiting`, `stalled`, `interrupted`, …), model/thinking, the shown panes (`▶`) and the worktree branch (`⎇`). A child waiting for an answer shows `❓ question` / `❓ approval` with its duration — `❓ question → parent` / `❓ approval → user` when it tells who it waits for —, is counted as `question` (not `active`) and its Herdr tab is `blocked` (label `→ parent · …` / `→ user · …`). A child waiting for the user in its own pane does not notify the parent agent.
- Every child is launched and supervised by the package's agent runtime (`pi-memo-subagents/runtime`): the child's pane, shell, process and session are identified exactly, its end is recorded by the child itself (`subagent_done`, automatic exit after a normal run, `caller_ping`, or the user quitting pi) and its pane is closed only when that end is proven. Stall detection, interrupt, resume and reload survival work as before, with these differences:
  - a child is never force-closed: when the parent session quits, settled idle children are stopped and closed, busy ones keep their pane;
  - a child that ends without an orderly exit (crash, kill) is reported as an error, not as a success;
  - a launch whose outcome is uncertain (e.g. the child waits for a project trust prompt for longer than 120 s) is reported as such: do not relaunch, check the pane;
  - resume runs in the session's own cwd and keeps its model when it is still available;
  - agent tool names must be plain names (no patterns).

## Install

Requires pi and Herdr (start `herdr`, then run `pi` inside it).

```bash
pi install /path/to/pi-memo-subagents
# or
pi install git:github.com/federico-alunni/pi-memo-subagents   # latest main (collaborators)
pi update --extensions                                       # pull new versions
```

Without a `@ref` pi follows `main`, so `pi update --extensions` picks up every new release. Pinning a release
(`…pi-memo-subagents@v0.3.0`) freezes that tag: `pi update` will not move it, re-run `pi install` with the new tag.
The `pi-memo-question` dependency is fetched from GitHub automatically when pi installs the package.

The `question` tool comes from [pi-memo-question](https://github.com/federico-alunni/pi-memo-question). For the main agent install it too (`pi install git:github.com/federico-alunni/pi-memo-question`); children use that installed copy when it exists (so the tool is loaded once) and fall back to the dependency bundled with this package otherwise.

> **Warning — load it from one source only.** If you already load this package from a local path
> (`settings.json` → `"packages": ["/path/to/pi-memo-subagents"]` or `-e <path>`), do **not** also install the git
> source: pi identifies packages by repo URL or absolute path, so the extension would be loaded twice.

For a profile launched with `pi -ne` (packages disabled), load it explicitly with `pi -ne -e /path/to/pi-memo-subagents …`; see [docs/child-host.md](docs/child-host.md) for host extensions/variables that children need.

## Herdr UX

The default surface is `selector` (`PI_SUBAGENT_SURFACE`): agents are shown in a column right of the main pane (40% of the tab, `PI_SUBAGENT_COLUMN_RATIO`), one agent filling it or two stacked top/bottom; further children run in background tabs of the same workspace. When a shown child finishes, the next open agent in menu order takes its slot (same pane, no restart). `/subagent` without arguments picks an open child for the column (with both slots taken: the top one goes to a tab, the bottom one moves up, the chosen one goes below); `Ctrl+Alt+X` swaps the two shown agents, or rotates them through the open agents as a queue. `PI_SUBAGENT_SURFACE=split`, `tab` or `panel` (status panel above the editor) restore or enable other layouts. Other extensions can supply their own status panel through `pi.events` ([docs/panel.md](docs/panel.md)); scripts drive subagents through the session socket ([docs/socket.md](docs/socket.md)). Details: [docs/pane-selector.md](docs/pane-selector.md).

## Tools and commands

| Name | Kind | Purpose |
| --- | --- | --- |
| `subagent` | tool | Spawn a child (async). |
| `subagents_list` | tool | List discoverable agent definitions. |
| `subagent_resume` | tool | Resume a child session in a new pane (async). |
| `subagent_interrupt` | tool | Interrupt the current turn of a running child (correlated request; the child stays open). |
| `subagent_worktrees` | tool | List/remove worktrees created with `worktree: true`. |
| `subagent_answer` | tool | Answer a child's `subagent_request` (question or bash approval), or escalate it to the user. |
| `/subagent [agent task]` | command | Pick the visible child, or spawn `agent` with `task`. |
| `/iterate [task]` | command | Fork the session into an interactive child. |
| `/subagent-worktrees` | command | Interactive list/remove of subagent worktrees. |
| `Ctrl+Alt+X` | shortcut | Cycles the agent shown on the right (next open agent, wrapping around), no menu. |

`spawning: true` in agent frontmatter grants delegated spawning by default (as if the caller passed `spawning: true`; `spawning-depth` sets the depth, default 2; an explicit `spawning` parameter wins). `spawning: false` in agent frontmatter denies all of `subagent`, `subagent_interrupt`, `subagents_list`, `subagent_resume`, `subagent_worktrees` and `subagent_answer` to that child; `deny-tools` denies individual tools.

### `subagent` parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `name` | string | Display name (widget, pane title). Required. |
| `task` | string | Task prompt. Required. |
| `agent` | string | Agent definition to load defaults from. |
| `model` | string | Explicit model override (exact `provider/model-id`). Omitted: the agent's default, otherwise the parent model. |
| `thinking` | string | `off`…`max`. **Required** unless the named agent declares `thinking` in its frontmatter; never inherited from the parent. An explicit value overrides the frontmatter. |
| `systemPrompt`, `skills`, `tools` | string | Extra role instructions / comma-separated skills / tools. |
| `cwd` | string | Child working directory (absolute, or relative to the current directory). |
| `fork` | boolean | Full-context fork of the current conversation. |
| `autoExit` | boolean | Close the subagent as soon as it gives its final answer (default `true`; falls back to `auto-exit` frontmatter). `false` keeps it open for the user. |
| `interactive` | boolean | Don't wake the parent on stall/recovery transitions (does not keep the subagent open). |
| `worktree` | boolean | Run the child in a fresh git worktree on a new branch (see below). |
| `worktreeBranch` | string | New branch name (requires `worktree: true`). Default `memo/<name>-<id8>`. |
| `worktreeBase` | string | Start commit-ish (requires `worktree: true`). Default the source `HEAD`. |
| `worktreeSpace` | boolean | Open the worktree as its own Herdr workspace (sub-space) and show a mirror pane beside the main pane. Default `true` with `worktree: true` inside Herdr; `false` keeps a plain pane. |
| `spawning` | boolean | Grant delegated spawning: this child can start sub-agents through the main session. They open in a column under it, the main session supervises them, and each result goes back to this child as a separate task. |
| `spawningDepth` | number | With `spawning: true`: how many levels of sub-agents may exist below this one (1–4, default 2). Each delegated spawn with `spawning: true` consumes 1 level. |
| `handoff` | `"wait"` \| `"replace"` | Start an agent in a new tab of your own worktree space (worktree-space children only). `wait`: wait for result; `replace`: hand off and exit. |
| `askParent` | boolean | Default target of the child's questions (without `to`) and bash approvals: `true` the parent agent first ([Ask-parent](#ask-parent)), `false` (default) the user in the child's pane. Overrides the agent's `ask-parent` frontmatter. The child can always pick per question with `to: "parent" \| "user"`. |

Agent frontmatter supports `name`, `description`, `model`, `thinking`, `tools`, `skills`, `session-mode` (`standalone` / `lineage-only` / `fork`), `spawning`, `spawning-depth`, `deny-tools`, `bash`, `bash-allow` (see below), `auto-exit`, `ask-parent` (`true` makes the parent agent the default target, see [Ask-parent](#ask-parent); parsed like `auto-exit`), `grid` (e.g. `2x2`: the agent grid beside the main pane while this agent lives, if larger than the configured one), `interactive`, `system-prompt` (`append` / `replace`), `cwd` and `disable-model-invocation`, as upstream ([reference](https://github.com/0xRichardH/pi-herdr-subagents/blob/v0.2.0/README.md#frontmatter-reference)). `worktree` is **not** read from frontmatter in this version.

Bash levels per agent:

| Frontmatter | Effect |
|---|---|
| `bash: full` (default) | unrestricted bash |
| `bash: readonly` | one plain read-only command per call (`git log`, `rg`, `cat`, …) |
| `bash: none` | no bash (`bash` is added to the denied tools) |
| `bash-allow: npm test, npm run check` | extra commands on top of `readonly`, matched as an exact word prefix of one plain command (no pipes, redirections, quotes, `$`, globs or comments). Without `bash` it implies `readonly`; with `bash: full` or `none` the launch fails |

With `bash: readonly` (or `bash-allow`) a plain command outside the read-only list and `bash-allow` is **asked** — to the parent agent first when it is the default target (below), otherwise (or as fallback) in the subagent's pane: `Rifiuta` (first, the default), `Permetti una volta`, `Permetti sempre in questa sessione dell'agente`. "Always" covers commands starting with the same first two words (or the same single word) and lasts only for that subagent process; nothing is written to disk or to the agent definition. Without a UI, on cancel or abort, and for commands with shell grammar the command is blocked without asking. An unknown `bash` value or an invalid `bash-allow` fails the launch before any worktree or pane is created.

### Ask-parent

Every `subagent`/`subagent_resume` child can ask its parent agent. The `question` tool (the installed
pi-memo-question package, `@beta` channel or later) takes `to: "user" | "parent"`: `parent` when the parent can know
the answer (decisions and context of its session), `user` for what only the user can decide. Without `to`, and for bash
approvals, the default target applies: the user, or the parent with `ask-parent: true` in the agent definition or
`askParent: true` on the spawn (the parameter wins). pi-memo-subagents never loads its own copy of pi-memo-question: the
child registers a router through the package's hook (`globalThis[Symbol.for("pi-memo-question/router")]`).

- a `question` call for the parent, and a bash command its policy would **ask** about when the parent is the default target, are sent to the parent agent as a steer message (`subagent_request`: child id/name, kind, text and options or the command, `requestId`, how to answer). The child waits; its widget row reads `❓ question → parent`;
- the parent agent answers with `subagent_answer({ id, requestId, answer })` for questions (an option label, its number, or a free answer), `decision: "once" | "deny"` for approvals, or `escalate: true`. **Only the user can allow a command "always"**: `decision: "always"` escalates to the user, never applies. Repeated or stale answers are refused;
- the request goes to the user in the **parent session** when the parent escalates, asks for "always", or does not answer within 60 s (`PI_MEMO_SUBAGENTS_ASK_PARENT_TIMEOUT_MS`). Several pending requests (of one or more children) form one dialog: `←`/`→` browse them, each shows which child it comes from; questions use pi-memo-question's dialog, approvals `Rifiuta` / `Permetti una volta` / `Permetti sempre`;
- the parent can never widen the child's policy: commands with shell grammar or outside the read-only policy are never sent (they stay blocked), and the child re-checks every decision before running the command;
- when the parent is unavailable (quit, `/reload`, request not picked up within a few seconds, extension not loaded, no UI to ask the user) the child asks the user in its own pane with today's dialog, without waiting for the timeout;
- nested subagents: a child that is itself a parent receives its children's requests the same way; when it escalates (or times out) the request goes one level up to **its** parent, never to the user; only the top-level agent asks the user;
- the child transcript records who answered (the parent agent with its name/id, or the user, and whether it was escalated, timed out or asked in the child's pane), in the `question` result and in the bash result or block reason.

pi-memo-subagents launches **only pi** children: the upstream drivers for other CLIs (Claude Code, Codex, OpenCode, Grok, generic `command` templates) and the Claude Code plugin hook were removed. A definition with `cli:` other than `pi` is rejected at spawn time.

## Agent runtime (for other packages)

`pi-memo-subagents/runtime` is the library behind agent launching: exact pane/process identities, durable evidence,
long-lived children with correlated tasks, delegated tools, read-only bash policy, proven shutdown. Other packages
(pi-issue-round) launch their agents through it instead of their own transport, and every runtime agent appears in
the same widget, grouped by client. The `subagent` tool is a client of the same runtime. Contract:
[docs/runtime.md](docs/runtime.md).

## Worktrees

`subagent({ name: "Fix", agent: "worker", worktree: true, task: "…" })` creates `<repo>-memo-worktrees/fix-<id8>` next to the repository on branch `memo/fix-<id8>` from the current `HEAD`, runs the child there (same sub-directory as the requested `cwd`), and reports `Worktree: <path> (branch …, N commits ahead of <base>, clean|dirty)` in the result plus `details.worktree`. Nothing is merged automatically; the worktree stays until you remove it with `subagent_worktrees` / `/subagent-worktrees` (never forced; `deleteBranch` uses `git branch -d`). With uncommitted changes in the source checkout, the interactive TUI asks whether to proceed from the last commit or cancel. Full description: [docs/worktrees.md](docs/worktrees.md).

## Configuration

Optional. Put it in **`~/.pi/agent/pi-memo-subagents.json`** (`$PI_CODING_AGENT_DIR/pi-memo-subagents.json`), or point `PI_MEMO_SUBAGENTS_CONFIG` to any file. It must live outside the package: pi updates git packages with `git reset --hard` + `git clean -fdx`, which would delete a `config.json` inside the checkout at every `pi update --extensions`. Children launched with another profile read the one in `~/.pi/agent` too. A `config.json` at the package root is still read as a fallback (local checkouts); without any file, `config.json.example` supplies the `status` defaults and the rest is empty.

```json
{
  "status": { "enabled": true },
  "models": { "default": "provider/model", "agents": { "scout": "provider/fast-model" } },
  "worktrees": { "root": "/abs/worktrees", "branchPrefix": "memo/" }
}
```

- `status.enabled`: in-progress status steers and widget labels.
- `models`: default model per agent name (tool argument → frontmatter → `models.agents` → `models.default` → parent).
- `worktrees` (optional, both keys optional): `root` puts worktrees under `<root>/<repoName>/`; `branchPrefix` changes the generated branch prefix. Unknown keys are rejected.

Environment: `PI_SUBAGENT_SURFACE` (`selector` | `split` | `tab` | `panel`), `PI_SUBAGENT_COLUMN_RATIO` (width of the selector's agent column, a number strictly between 0 and 1, default `0.4`), `PI_SUBAGENT_GRID` (the selector's agent grid, `colsxrows` with sides 1–4, default `1x2`; also `layout.grid` in the config, and `grid` in an agent definition to enlarge it while that agent lives), `PI_MEMO_SUBAGENTS_ASK_PARENT_TIMEOUT_MS` (how long the parent agent has to answer a child's question or approval before the user is asked, positive integer milliseconds, default `60000`; invalid values fall back to the default) and the host composition variables `PI_MEMO_SUBAGENTS_CHILD_EXTENSIONS` / `PI_MEMO_SUBAGENTS_CHILD_ENV` ([docs/child-host.md](docs/child-host.md)).

## Development

Tests need the pi host packages (`@earendil-works/pi-coding-agent`, `-pi-ai`, `-pi-tui`, `typebox`) and `npm install` for the `pi-memo-question` dependency.
`test/host-aliases.mjs` finds the host via `PI_HOST_DIR=<path of pi-coding-agent>`, then packages installed in `node_modules` (what CI does), then the Homebrew global install (macOS). Node >= 22.15 is required (`engines`).

```bash
npm test                  # unit, fake runtime/Herdr and real-git tests, offline, no model calls
npm run test:live         # pane selector against a real Herdr server (own workspace only)
```

## Releasing (maintainers)

1. Move the `## Unreleased` notes of `CHANGELOG.md` under the new version, bump `version` in `package.json`, commit, push to `main` (CI runs `npm test`).
2. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. `.github/workflows/release.yml` checks that the tag is on `main` and equals the `package.json` version, runs the tests and creates the GitHub Release. Nothing is built or published elsewhere: pi reads the source from git, so installs that follow `main` get the update with `pi update --extensions`.

## License

MIT — see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
