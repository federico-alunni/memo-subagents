# pi-memo-subagents

Interactive, non-blocking [pi](https://github.com/badlogic/pi-mono) subagents running in [Herdr](https://herdr.dev) panes — using **agent definitions you keep elsewhere** (`~/.pi/agent/agents/*.md` and project `.pi/agents/*.md`), with an in-session pane selector, optional **git worktree isolation** and host-controlled child composition for custom pi profiles.

pi-memo-subagents is a derivative of [pi-herdr-subagents](https://github.com/0xRichardH/pi-herdr-subagents) v0.2.0 (itself derived from [pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [provenance.json](provenance.json).

> **Never load pi-memo-subagents together with pi-herdr-subagents** (or another copy of it). Both register the same tools (`subagent`, `subagents_list`, `subagent_resume`, `subagent_interrupt`) and share the same `globalThis` runtime keys (`Symbol.for("pi-subagents/…")`, kept unchanged so `/reload` adoption keeps working). Remove the other package first, with pi closed and no subagents running.

## What it does

- `subagent({ name, task, agent?, … })` returns immediately; the child runs in its own Herdr pane and its result is **steered back** into the main session when it finishes (`subagent_result`), or when it asks for help (`caller_ping` → `subagent_ping`).
- No bundled agents and no `/plan` command: only global (`$PI_CODING_AGENT_DIR/agents`, default `~/.pi/agent/agents`) and project (`.pi/agents`) definitions are discovered. Project definitions override global ones with the same name.
- Live widget above the editor with lifecycle state (`starting`, `active`, `waiting`, `stalled`, `interrupted`, …), model/thinking, the selected pane (`▶`) and the worktree branch (`⎇`). A child waiting for the user shows `❓ question` / `❓ approval` with its duration, is counted as `question` (not `active`) and its Herdr tab is `blocked`; the parent agent is not notified.
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

The default surface is `selector` (`PI_SUBAGENT_SURFACE`): the first child opens a half-width split on the right, further children run in background tabs of the same workspace. `/subagent` without arguments picks which open child is shown on the right without restarting anything; `Ctrl+Alt+X` cycles to the next one. `PI_SUBAGENT_SURFACE=split`, `tab`, or `panel` (status panel above the editor) restore or enable other surface layouts. Other extensions can supply their own status panel through `pi.events` ([docs/panel.md](docs/panel.md)). Details: [docs/pane-selector.md](docs/pane-selector.md).

## Tools and commands

| Name | Kind | Purpose |
| --- | --- | --- |
| `subagent` | tool | Spawn a child (async). |
| `subagents_list` | tool | List discoverable agent definitions. |
| `subagent_resume` | tool | Resume a child session in a new pane (async). |
| `subagent_interrupt` | tool | Interrupt the current turn of a running child (correlated request; the child stays open). |
| `subagent_worktrees` | tool | List/remove worktrees created with `worktree: true`. |
| `/subagent [agent task]` | command | Pick the visible child, or spawn `agent` with `task`. |
| `/iterate [task]` | command | Fork the session into an interactive child. |
| `/subagent-worktrees` | command | Interactive list/remove of subagent worktrees. |
| `Ctrl+Alt+X` | shortcut | Cycles the agent shown on the right (next open agent, wrapping around), no menu. |

`spawning: false` in agent frontmatter denies all of `subagent`, `subagent_interrupt`, `subagents_list`, `subagent_resume` and `subagent_worktrees` to that child; `deny-tools` denies individual tools.

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
| `interactive` | boolean | Don't wake the parent on stall/recovery transitions. |
| `worktree` | boolean | Run the child in a fresh git worktree on a new branch (see below). |
| `worktreeBranch` | string | New branch name (requires `worktree: true`). Default `memo/<name>-<id8>`. |
| `worktreeBase` | string | Start commit-ish (requires `worktree: true`). Default the source `HEAD`. |
| `worktreeSpace` | boolean | Open the worktree as its own Herdr workspace and show a mirror pane beside the main pane (requires `worktree: true`). |
| `spawning` | boolean | Grant delegated spawning: this child can start sub-agents through the main session. They open in a column under it, the main session supervises them, and each result goes back to this child as a separate task. |
| `spawningDepth` | number | With `spawning: true`: how many levels of sub-agents may exist below this one (1–4, default 2). Each delegated spawn with `spawning: true` consumes 1 level. |
| `handoff` | `"wait"` \| `"replace"` | Start an agent in a new tab of your own worktree space (worktree-space children only). `wait`: wait for result; `replace`: hand off and exit. |

Agent frontmatter supports `name`, `description`, `model`, `thinking`, `tools`, `skills`, `session-mode` (`standalone` / `lineage-only` / `fork`), `spawning`, `deny-tools`, `bash`, `bash-allow` (see below), `auto-exit`, `interactive`, `system-prompt` (`append` / `replace`), `cwd` and `disable-model-invocation`, as upstream ([reference](https://github.com/0xRichardH/pi-herdr-subagents/blob/v0.2.0/README.md#frontmatter-reference)). `worktree` is **not** read from frontmatter in this version.

Bash levels per agent:

| Frontmatter | Effect |
|---|---|
| `bash: full` (default) | unrestricted bash |
| `bash: readonly` | one plain read-only command per call (`git log`, `rg`, `cat`, …) |
| `bash: none` | no bash (`bash` is added to the denied tools) |
| `bash-allow: npm test, npm run check` | extra commands on top of `readonly`, matched as an exact word prefix of one plain command (no pipes, redirections, quotes, `$`, globs or comments). Without `bash` it implies `readonly`; with `bash: full` or `none` the launch fails |

With `bash: readonly` (or `bash-allow`) a plain command outside the read-only list and `bash-allow` is **asked** in the subagent's pane: `Rifiuta` (first, the default), `Permetti una volta`, `Permetti sempre in questa sessione dell'agente`. "Always" covers commands starting with the same first two words (or the same single word) and lasts only for that subagent process; nothing is written to disk or to the agent definition. Without a UI, on cancel or abort, and for commands with shell grammar the command is blocked without asking. An unknown `bash` value or an invalid `bash-allow` fails the launch before any worktree or pane is created.

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

Environment: `PI_SUBAGENT_SURFACE` (`selector` | `split` | `tab` | `panel`) and the host composition variables `PI_MEMO_SUBAGENTS_CHILD_EXTENSIONS` / `PI_MEMO_SUBAGENTS_CHILD_ENV` ([docs/child-host.md](docs/child-host.md)).

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
