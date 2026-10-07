# Local subagent selector customization

This is a local copy of the installed pi-herdr-subagents 0.2.0 package, including the pre-existing local edits. Pi loads this directory instead of the npm copy so package updates cannot overwrite the customization.

## Behavior

- The default `PI_SUBAGENT_SURFACE` is now `selector`.
- The first child creates a half-width right split, provided the main tab has no other splits and is not zoomed.
- Additional children run in background tabs in the same workspace. They do not create more visible splits or change the selected child.
- `/subagent` with no arguments opens the existing Pi selection dialog listing tracked, open children. Selecting a child moves its existing terminal to the right and parks the previous child in a background tab. No process or conversation is restarted.
- `/subagent <profile> [task]` preserves the existing spawn behavior.
- `Ctrl+Alt+S` opens the same menu without issuing a model request.
- The widget marks the selected child with `▶`.
- Completion/result delivery remains unchanged. Finished children close normally. If the visible child finishes, the right split disappears until you select another open child (or a new first child starts). There is no automatic selection change.
- Existing unrelated splits, zoomed tabs, and panes moved to another workspace are not reorganized automatically.
- Explicit `PI_SUBAGENT_SURFACE=split` and `tab` still work.
- Package bundled agents (`agents/`) and upstream `/plan` command were removed so only user/project agents and canonical plan-mode are active.

The selector is a Pi dialog in the main session, not a permanently embedded native Herdr tab bar. Background tabs remain visible in Herdr's normal tab list.

## Activation

Run `/reload` in the main Pi session. Already-running children retain their own loaded extension code. Do not restart the Herdr server.

## Tests

On this machine, using Pi's existing host dependencies (no installation):

```sh
cd ~/.pi/agent/local-packages/pi-herdr-subagents
node --import ./test/host-aliases.mjs --test test/test.ts test/runtime-routing.test.ts test/release-workflow.test.ts test/harness-drivers.test.ts test/pane-selector.test.mjs test/pane-selector-command.test.mjs
node test/pane-selector-live.mjs
```

The live test creates an explicitly named owned workspace with ten shell terminals, switches displayed terminals, checks terminal IDs/focus/layout, and removes only that workspace. It makes no provider/model calls.

## Rollback

In `~/.pi/agent/settings.json`, replace the local package source with `npm:pi-herdr-subagents`, then `/reload`. The npm package was not modified by this customization. The original settings file was backed up under `~/.pi/agent/backups/subagent-selector-settings.json`.
