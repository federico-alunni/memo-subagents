# Third-party notices

memo-subagents is a modified copy of MIT-licensed software. The full license text, with all copyright lines, is in [LICENSE](LICENSE).

## Derivation chain

1. **[HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)** — original interactive subagent extension for pi. MIT, Copyright (c) 2026 HazAT.
2. **[0xRichardH/pi-herdr-subagents](https://github.com/0xRichardH/pi-herdr-subagents)** v0.2.0 (commit `7180d98`, npm `pi-herdr-subagents@0.2.0`) — Herdr-only fork with lifecycle/status supervision, turn interrupt, harness drivers. MIT, same license file.
3. **Local customizations** (Federico Alunni), previously kept as a local package and vendored in pi-issue-round:
   - `terminal.ts`: configurable surface (`PI_SUBAGENT_SURFACE`).
   - `pane-selector.ts`: selector surface (default), `/subagent` picker, `Ctrl+Alt+S`, `▶` widget marker, `randomBytes(12)` child ids.
   - bundled `agents/`, `/plan` and `plan-skill.md` removed.
4. **memo-subagents 0.1.0** (Federico Alunni):
   - `child-host.ts`: `MEMO_SUBAGENTS_CHILD_EXTENSIONS` / `MEMO_SUBAGENTS_CHILD_ENV`, applied to launch and resume (replaces the vendored `IR_CHILD_*` patch).
   - `worktree.ts` and `index.ts`: optional git worktree isolation, `subagent_worktrees` tool, `/subagent-worktrees` command.
   - `terminal.ts` / `herdr.ts`: optional pane cwd.
5. **Unreleased** (Federico Alunni):
   - non-pi harness drivers and the Claude Code plugin removed (pi only).
   - the `subagent` tool launches through the agent runtime; the pi driver, `subagent-done.ts`, the pane/surface creation code of `herdr.ts`/`terminal.ts`, the sentinel/sidecar completion of `completion.ts` and the upstream live suite `test/integration/` were removed (the identity widget of `subagent-done.ts` lives on in `runtime/child/identity-widget.ts`).
   - `runtime/` (`memo-subagents/runtime`): ported from **pi-issue-round** (same author, MIT) at commit `b3b19aa` — `src/agents/index.ts` (HerdrTransport, itself selectively adapted from pi-herdr-subagents), `protocol.ts`, `child-runtime.ts`, `readonly-bash.ts`, `src/child-extension.ts`, `src/ui/question-dialog.ts` (adapted from the pi `question` example extension, MIT) and their tests, made role-agnostic (scope/labels, tool policy, generic delegated tools) with a display-only presence registry.
   - unified widget for runtime agents in `index.ts`.

Per-file SHA-256 hashes against upstream v0.2.0, the installed npm copy, the local package and the imported vendored copy are recorded in [provenance.json](provenance.json).

The `Symbol.for("pi-subagents/…")` runtime keys are intentionally the same as upstream; consequently memo-subagents must never be loaded together with pi-herdr-subagents or pi-interactive-subagents.

The sub-agent status supervision and turn-only interruption features of upstream were inspired by [RepoPrompt](https://repoprompt.com/).
