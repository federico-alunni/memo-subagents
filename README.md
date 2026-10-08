# pi-memo-subagents

Interactive, non-blocking [pi](https://github.com/badlogic/pi-mono) subagents running in [Herdr](https://herdr.dev) panes — using **agent definitions you keep elsewhere** (`~/.pi/agent/agents/*.md` and project `.pi/agents/*.md`), with an in-session pane selector, optional **git worktree isolation** and host-controlled child composition for custom pi profiles.

pi-memo-subagents is a derivative of [pi-herdr-subagents](https://github.com/0xRichardH/pi-herdr-subagents) v0.2.0 (itself derived from [pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [provenance.json](provenance.json).

> **Never load pi-memo-subagents together with pi-herdr-subagents** (or another copy of it). Both register the same tools (`subagent`, `subagents_list`, `subagent_resume`, `subagent_interrupt`) and share the same `globalThis` runtime keys (`Symbol.for("pi-subagents/…")`, kept unchanged so `/reload` adoption keeps working). Remove the other package first, with pi closed and no subagents running.

## What it does

- `subagent({ name, task, agent?, … })` returns immediately; the child runs in its own Herdr pane and its result is **steered back** into the main session when it finishes (`subagent_result`), or when it asks for help (`caller_ping` → `subagent_ping`).
- No bundled agents and no `/plan` command: only global (`$PI_CODING_AGENT_DIR/agents`, default `~/.pi/agent/agents`) and project (`.pi/agents`) definitions are discovered. Project definitions override global ones with the same name.
- Live widget above the editor with lifecycle state (`starting`, `active`, `waiting`, `stalled`, `interrupted`, …), model/thinking, the selected pane (`▶`) and the worktree branch (`⎇`).
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
pi install git:github.com/federico-alunni/pi-memo-subagents
```

For a profile launched with `pi -ne` (packages disabled), load it explicitly with `pi -ne -e /path/to/pi-memo-subagents …`; see [docs/child-host.md](docs/child-host.md) for host extensions/variables that children need.

## Herdr UX

The default surface is `selector` (`PI_SUBAGENT_SURFACE`): the first child opens a half-width split on the right, further children run in background tabs of the same workspace. `/subagent` without arguments (or `Ctrl+Alt+X`) picks which open child is shown on the right without restarting anything. `PI_SUBAGENT_SURFACE=split` or `tab` restore the upstream behaviours. Details: [docs/pane-selector.md](docs/pane-selector.md).

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
| `Ctrl+Alt+X` | shortcut | Same picker as `/subagent`. |

`spawning: false` in agent frontmatter denies all of `subagent`, `subagent_interrupt`, `subagents_list`, `subagent_resume` and `subagent_worktrees` to that child; `deny-tools` denies individual tools.

### `subagent` parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `name` | string | Display name (widget, pane title). Required. |
| `task` | string | Task prompt. Required. |
| `agent` | string | Agent definition to load defaults from. |
| `model` / `thinking` | string | Explicit runtime override (exact `provider/model-id`; `off`…`max`). |
| `systemPrompt`, `skills`, `tools` | string | Extra role instructions / comma-separated skills / tools. |
| `cwd` | string | Child working directory (absolute, or relative to the current directory). |
| `fork` | boolean | Full-context fork of the current conversation. |
| `interactive` | boolean | Don't wake the parent on stall/recovery transitions. |
| `worktree` | boolean | Run the child in a fresh git worktree on a new branch (see below). |
| `worktreeBranch` | string | New branch name (requires `worktree: true`). Default `memo/<name>-<id8>`. |
| `worktreeBase` | string | Start commit-ish (requires `worktree: true`). Default the source `HEAD`. |

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

`config.json` at the package root (gitignored; falls back to `config.json.example` for `status`):

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

Environment: `PI_SUBAGENT_SURFACE` (`selector` | `split` | `tab`) and the host composition variables `MEMO_SUBAGENTS_CHILD_EXTENSIONS` / `MEMO_SUBAGENTS_CHILD_ENV` ([docs/child-host.md](docs/child-host.md)).

## Development

Tests use pi's own host dependencies (no `npm install`; paths in `test/host-aliases.mjs` assume a Homebrew install of `@earendil-works/pi-coding-agent`).

```bash
npm test                  # unit, fake runtime/Herdr and real-git tests, offline, no model calls
npm run test:live         # pane selector against a real Herdr server (own workspace only)
```

## License

MIT — see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
