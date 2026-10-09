# Pane selector

pi-memo-subagents shows up to two agents in a column right of the main pane and runs the others in background tabs. The selector lives in the agent runtime and is shared by every runtime client of the process: the `subagent` tool and Issue Round use the same placement rules and the same menu. This was a local customization of pi-herdr-subagents 0.2.0 (originally documented in `LOCAL-SELECTOR.md` of that local package) and is now part of this package.

## Layout

```
┌──────────────────────┬──────────────┐      ┌──────────────────────┬──────────────┐
│                      │              │      │                      │ agent (top)  │
│      main pane       │    agent     │      │      main pane       ├──────────────┤
│        60%           │     40%      │      │                      │agent (bottom)│
└──────────────────────┴──────────────┘      └──────────────────────┴──────────────┘
         1 open agent                                 2 or more open agents
```

- **Column width**: `PI_SUBAGENT_COLUMN_RATIO` (same family as `PI_SUBAGENT_SURFACE`), the fraction of the tab taken by the agent column: a plain decimal number strictly between 0 and 1, e.g. `0.3` or `0.5`. Missing or invalid (`0`, `1`, `40%`, `abc`, …) → `0.4` (main pane 60%). It is applied when an agent pane is created in the column (`herdr pane split --ratio`) and on every move into the column; Herdr's `--ratio` of a right split measures the main pane (the left side), so the selector passes `1 − ratio`. Moving an agent below another one (`--split down --ratio 0.5`) keeps the column width.
- **Slots**: 1 open agent fills the whole column; 2 are stacked (top and bottom halves, the column split down); with 3 or more, two are shown and the others run in background tabs of the same workspace.

## Behaviour

- The default `PI_SUBAGENT_SURFACE` is `selector`.
- **Launch**: a child takes a free slot of the column — the empty column (split right of the main pane) or the bottom slot (split down below the agent shown alone) — whenever the main tab contains only the main pane and at most one of our agents, is not zoomed and no other launch or rearrangement reserved that slot. Agents already open in background tabs do not matter. Otherwise children run in background tabs; they do not create more splits or change the shown agents.
- **Reservation**: each slot is reserved synchronously (check-and-set on the layout read just before), so concurrent launches never create more than two agent panes beside the main pane nor an extra split. When two launches start together, the first one takes the top slot and the second the bottom slot: it waits until the first one has created its pane, then splits it down (if the first launch fails, the second decides again). A layout read before the selector moved panes is stale: that launch goes to a tab.
- **Placement modes**: the runtime decides (`placement: "auto"` for the `subagent` tool; Issue Round's triage and planner use `"visible"`). `visible` fills a free slot like `auto`; with both slots taken by our agents it follows the queue rule: the top agent is parked in a tab (through its own runtime), the bottom agent moves up and the new agent is created in the bottom slot.
- **`/subagent` menu** (no arguments): a pi selection dialog lists the tracked, open agents; both shown agents are marked `▶`. Selecting an agent already shown changes nothing; with a free slot the chosen agent fills it; with both slots taken the queue rule applies (top → tab, bottom → top, chosen → bottom). No process or conversation is restarted and pane IDs stay stable, so watchers keep working.
- **`Ctrl+Alt+X`** (no menu, no model request): 1 open agent → unchanged ("only open agent"); a free slot → filled with the next open agent in menu order; exactly 2 open agents → top and bottom swap; 3 or more → the queue shifts by one: the top agent goes to a background tab, the bottom agent moves to the top, and the next agent in menu order after the bottom one (wrapping around, among the agents in background tabs) enters the bottom slot.
- **A shown agent finishes**: once its pane has closed, its slot is filled in place by the agent that followed it in the menu order (the `Ctrl+Alt+X` order, wrapping around; the first one when its position is unknown) among the agents in background tabs — a finished top agent's replacement goes on top, a finished bottom agent's below. If no agent is in a tab, the remaining shown agent takes the whole column. It is a move, never a restart. The promotion takes the slot reservations like a launch (a launch arriving meanwhile goes to a tab, and a promotion never takes a slot a launch reserved) and the same refusals as `/subagent`. A finished background agent changes nothing.
- **Moves**: every move (park, move up, bring in) goes through the runtime that launched the agent (`PaneControl`/`movePane`, Issue Round agents included), which observes the new tab; the owner's handle stays valid (recorded move). Herdr only splits right or down, so moving an agent up means parking the other one and placing both again (a swap: park the top agent, move it below the other one). Each step reads the layout back; a failure rolls the column back to what it was, leaving every terminal alive. Focus stays on the main pane.
- **Refusals**: existing unrelated splits (anything in the main tab other than the main pane and up to two of our agents stacked in the column), zoomed tabs and panes in other workspaces (Herdr worktree spaces) are never reorganized; the selector refuses and explains why. It also refuses while a launch is placing an agent in the column.
- The menu lists this session's subagents and the other runtime agents in the main pane's workspace (e.g. `Issue Round › planner`). `/subagent <agent> [task]` keeps the spawn behaviour.
- The widget marks both shown agents with `▶`, Issue Round rows included (and worktree children with `⎇ <branch>`); the `/subagent · Ctrl+Alt+X` hint is shown once, also when only Issue Round agents are open.
- Completion/result delivery is unchanged. Finished children close normally.
- `PI_SUBAGENT_SURFACE=split` (always split right of the main pane, no column ratio), `tab` (always a new tab, upstream default) and `panel` (status panel above the editor, see [panel.md](panel.md)) still work.
- **Worktree-space mirror panes & multi-pane column**: Subagents spawned with `worktreeSpace: true` run in their own Herdr workspace. A single mirror pane appears on the right in the main session's tab (managed by `MirrorManager`). When multiple worktree-space subagents run concurrently, they share this single column, stacked with balanced heights. Each slot is listed in the `/subagent` menu as `⧉ <name>`; selecting a slot marks it with `▶` (which also designates it for interactive keyboard input if multiple dialogs are open). Selecting a slot that is already selected and visible promotes the agent by moving focus to its workspace (`herdr agent focus`, with fallback to workspace + tab navigation). `Ctrl+Alt+X` cycles through all open agents and slots. When all worktree-space subagents finish, the mirror column automatically closes.
- **Delegated child columns**: An agent spawned with `spawning: true` (e.g. a planner) can start its own helpers (researchers, challengers). Each delegated child opens in a vertical split under its requester. The column divides automatically (the root keeps its half, the members below share the rest equally), and rebalances when a member finishes. Their results are delivered to the requester, not the main session; the main session's widget shows them as live rows (with `↳ <requester>` in selector mode, or as panel rows in `panel` mode).
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

The live test sets `PI_SUBAGENT_COLUMN_RATIO=0.35`, creates an explicitly named workspace with six shell terminals launched concurrently (two stacked in the column, four in tabs), then checks after every step the column width (≈ 35% of the tab), the stacked slots, stable pane and terminal IDs and unchanged focus: swap with two agents, queue rotation with more, menu selection, promotion in place after the top and the bottom agent close, a finished background agent, and the last agent taking the whole column. It removes only that workspace and makes no provider/model calls.
