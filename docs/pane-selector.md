# Pane selector

memo-subagents keeps one child visible next to the main pane and runs the others in background tabs. This was a local customization of pi-herdr-subagents 0.2.0 (originally documented in `LOCAL-SELECTOR.md` of that local package) and is now part of this package.

## Behaviour

- The default `PI_SUBAGENT_SURFACE` is `selector`.
- The first child creates a half-width right split, provided the main tab has no other splits and is not zoomed.
- Additional children run in background tabs in the same workspace. They do not create more visible splits or change the selected child.
- `/subagent` with no arguments opens a pi selection dialog listing tracked, open children. Selecting a child moves its existing terminal to the right and parks the previously visible child in a background tab. No process or conversation is restarted and pane IDs stay stable, so watchers keep working.
- The selector only decides placement: it reserves the visible split synchronously (concurrent launches never get two splits), the agent runtime creates the pane there, and moves go through the runtime's `move`, which observes the new tab and updates the child's handle. Agents of other runtime clients (e.g. issue-round) are never moved.
- `/subagent <agent> [task]` keeps the spawn behaviour.
- `Ctrl+Alt+S` opens the same menu without issuing a model request.
- The widget marks the selected child with `▶` (and worktree children with `⎇ <branch>`).
- Completion/result delivery is unchanged. Finished children close normally. If the visible child finishes, the right split disappears until you select another open child (or a new first child starts). There is no automatic selection change.
- Existing unrelated splits, zoomed tabs and panes moved to another workspace are never reorganized; the selector refuses and explains why.
- `PI_SUBAGENT_SURFACE=split` (always split right) and `tab` (always a new tab, upstream default) still work.
- Panes are created with the child's working directory (the worktree cwd for `worktree: true`).
- No bundled agents and no upstream `/plan` command: only user (`~/.pi/agent/agents`) and project (`.pi/agents`) definitions are active.

The selector is a pi dialog in the main session, not an embedded Herdr tab bar. Background tabs remain visible in Herdr's normal tab list.

## Activation

After installing or updating the package, start a new pi session (or `/reload` if no other copy of the subagent extension is loaded). Already-running children keep their own loaded extension code. Do not restart the Herdr server.

## Tests

```sh
npm test            # includes test/pane-selector.test.mjs and test/pane-selector-command.test.mjs (no Herdr needed)
npm run test:live   # node test/pane-selector-live.mjs, requires a running Herdr server
```

The live test creates an explicitly named workspace with ten shell terminals, switches displayed terminals, checks terminal IDs/focus/layout, and removes only that workspace. It makes no provider/model calls.
