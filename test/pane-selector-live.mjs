// Real Herdr smoke test using owned shell terminals only (no providers or agents).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { PaneSelector } from '../pi-extension/subagents/pane-selector.ts';
const run = (args) => JSON.parse(execFileSync('herdr', args, { encoding: 'utf8' })).result;
const focusedBefore = run(['pane', 'current']).pane.pane_id;
const created = run(['workspace', 'create', '--label', 'pi-selector-owned-smoke', '--cwd', '/tmp', '--no-focus']);
const workspace = created.workspace.workspace_id;
const parent = created.root_pane.pane_id;
try {
  const state = { owned: new Map() };
  const selector = new PaneSelector(state, run, () => parent);
  const ids = Array.from({ length: 10 }, (_, index) => selector.create(`Smoke ${index + 1}`, '/tmp'));
  const identities = new Map(ids.map(id => [id, run(['pane', 'get', id]).pane.terminal_id]));
  let layout = run(['pane', 'layout', '--pane', parent]).layout;
  assert.equal(layout.panes.length, 2);
  assert.equal(layout.splits.length, 1);
  assert.equal(selector.visible(), ids[0]);
  assert.equal(run(['pane', 'current']).pane.pane_id, focusedBefore);
  for (const id of [ids[9], ids[4], ids[0]]) {
    selector.select(id);
    layout = run(['pane', 'layout', '--pane', parent]).layout;
    assert.equal(layout.panes.length, 2);
    assert.equal(layout.splits.length, 1);
    assert.equal(selector.visible(), id);
    assert.equal(layout.focused_pane_id, parent);
    assert.equal(run(['pane', 'current']).pane.pane_id, focusedBefore);
    for (const child of ids) assert.equal(run(['pane', 'get', child]).pane.terminal_id, identities.get(child));
  }
  run(['pane', 'close', ids[0]]);
  selector.forget(ids[0]);
  assert.equal(run(['pane', 'layout', '--pane', parent]).layout.panes.length, 1);
  selector.select(ids[1]);
  assert.equal(selector.visible(), ids[1]);
  console.log('PASS: 10 shells, one split, selection changes, terminal IDs preserved, focus unchanged, completion cleanup.');
} finally {
  run(['workspace', 'close', workspace]);
  console.log(`Removed owned test workspace ${workspace}`);
}
