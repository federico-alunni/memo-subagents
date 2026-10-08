# Pane selector

pi-memo-subagents keeps one agent visible next to the main pane and runs the others in background tabs. The selector lives in the agent runtime and is shared by every runtime client of the process: the `subagent` tool and Issue Round use the same placement rules and the same menu. This was a local customization of pi-herdr-subagents 0.2.0 (originally documented in `LOCAL-SELECTOR.md` of that local package) and is now part of this package.

## Behaviour

- The default `PI_SUBAGENT_SURFACE` is `selector`.
- A child takes the half-width right split whenever it is free: the main tab contains only the main pane, is not zoomed and no other launch (or promotion) is taking it — also when other agents are already open in background tabs.
- Otherwise children run in background tabs in the same workspace. They do not create more visible splits or change the selected child. The split is reserved synchronously, so concurrent launches still produce exactly one split.
- `/subagent` with no arguments opens a pi selection dialog listing tracked, open children. Selecting a child moves its existing terminal to the right and parks the previously visible child in a background tab. No process or conversation is restarted and pane IDs stay stable, so watchers keep working.
- Placement is decided by the runtime (`placement: "auto"` for the `subagent` tool; Issue Round's triage and planner use `"visible"`, which parks the agent shown beside the main pane in a tab): the split is reserved synchronously (concurrent launches never get two splits), the runtime creates the pane there.
- The menu lists this session's subagents and the other runtime agents in the main pane's workspace (e.g. `Issue Round › planner`). Each move goes through the runtime that launched the agent, which observes the new tab; the owner's handle stays valid (recorded move). Agents in other workspaces (Herdr worktree spaces) are never moved.
- `/subagent <agent> [task]` keeps the spawn behaviour.
- `Ctrl+Alt+X` cycles without a menu: it shows the open agent after the visible one in the menu order (wrapping around; the first one when none is visible). No model request.
- The widget marks the selected agent with `▶`, Issue Round rows included (and worktree children with `⎇ <branch>`); the `/subagent · Ctrl+Alt+X` hint is shown once, also when only Issue Round agents are open.
- Completion/result delivery is unchanged. Finished children close normally. If the visible child finishes and another selectable agent (this session's subagents, Issue Round agents, same workspace) is open in a background tab, the agent that followed it in the menu order (the `Ctrl+Alt+X` order, wrapping around; the first one when its position is unknown) is moved into the split automatically once the finished pane has closed. It is a move, never a restart: same pane ID and terminal, through the runtime that owns the agent; the widget `▶` and the menu follow it. The promotion takes the same split reservation as a launch (a launch arriving meanwhile goes to a tab, and a promotion never takes a split a launch reserved) and the same refusals as `/subagent` (unrelated splits, zoom, other workspaces). A failed promotion leaves every terminal where it is; the split stays empty until you select an agent or a new child starts. A finished background agent changes nothing.
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

The live test creates an explicitly named workspace with ten shell terminals, switches displayed terminals, closes the visible one and checks that the next one is promoted into the split (one split, same pane and terminal IDs, focus unchanged), and removes only that workspace. It makes no provider/model calls.
