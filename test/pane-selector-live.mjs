// Real Herdr smoke test using owned shell terminals only (no providers or agents).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { PaneSelector, placedPane } from '../pi-extension/subagents/pane-selector.ts';

const RATIO = 0.35; // Not the default (0.4): proves PI_SUBAGENT_COLUMN_RATIO is applied.
process.env.PI_SUBAGENT_COLUMN_RATIO = String(RATIO);
const run = (args) => JSON.parse(execFileSync('herdr', args, { encoding: 'utf8' })).result;
const focusedBefore = run(['pane', 'current']).pane.pane_id;
const created = run(['workspace', 'create', '--label', 'pi-selector-owned-smoke', '--cwd', '/tmp', '--no-focus']);
const workspace = created.workspace.workspace_id;
const parent = created.root_pane.pane_id;
try {
  const state = { owned: new Map() };
  const selector = new PaneSelector(state, run, () => parent, { pollMs: 100, timeoutMs: 10_000 });
  // Panes are created as the agent runtime would: reserve the placement, create there, note, adopt.
  const create = async (reservation, name) => {
    let target = reservation.targetPane;
    if (reservation.after) target = await placedPane(state, reservation.after, { timeoutMs: 5000 });
    const result = reservation.placement === 'tab'
      ? run(['tab', 'create', '--workspace', workspace, '--label', name, '--cwd', '/tmp', '--no-focus'])
      : run(['pane', 'split', target, '--direction', reservation.placement === 'split-down' ? 'down' : 'right', '--ratio', String(reservation.ratio), '--cwd', '/tmp', '--no-focus']);
    const id = (result.pane ?? result.root_pane).pane_id;
    selector.placed(reservation, id);
    return id;
  };
  // Concurrent launches: all reserve before any pane exists; only two slots are handed out.
  const reservations = Array.from({ length: 6 }, () => selector.reserve());
  assert.deepEqual(reservations.map(r => r.placement), ['split-right', 'split-down', 'tab', 'tab', 'tab', 'tab']);
  const ids = await Promise.all(reservations.map((r, index) => create(r, `Smoke ${index + 1}`)));
  reservations.forEach((r, index) => selector.adopt(r, ids[index], `Smoke ${index + 1}`));
  const identities = new Map(ids.map(id => [id, run(['pane', 'get', id]).pane.terminal_id]));

  const layoutNow = () => run(['pane', 'layout', '--pane', parent]).layout;
  /** Column right of the main pane: agents top to bottom, width ratio, focus and identities unchanged. */
  const expectColumn = (expected, label) => {
    const layout = layoutNow();
    assert.equal(layout.panes.length, 1 + expected.length, label);
    assert.equal(layout.splits.length, expected.length, label);
    assert.deepEqual(selector.visible(), expected, label);
    assert.deepEqual(state.slots, expected, label);
    const main = layout.panes.find(p => p.pane_id === parent).rect;
    const column = expected.map(id => layout.panes.find(p => p.pane_id === id).rect);
    for (const rect of column) {
      assert.ok(rect.x >= main.x + main.width, `${label}: agents right of the main pane`);
      assert.equal(rect.x, column[0].x, `${label}: one column`);
    }
    const ratio = column[0].width / layout.area.width;
    assert.ok(Math.abs(ratio - RATIO) <= 1.5 / layout.area.width + 0.01, `${label}: column ratio ${ratio.toFixed(3)} ≈ ${RATIO}`);
    if (expected.length === 2) {
      assert.ok(column[0].y < column[1].y, `${label}: stacked top/bottom`);
      assert.ok(Math.abs(column[0].height - column[1].height) <= 1, `${label}: halves`);
    } else assert.equal(column[0].height, main.height, `${label}: full column`);
    assert.equal(layout.focused_pane_id, parent, label);
    assert.equal(run(['pane', 'current']).pane.pane_id, focusedBefore, label);
    for (const [id, terminal] of identities) {
      if (state.owned.has(id)) assert.equal(run(['pane', 'get', id]).pane.terminal_id, terminal, `${label}: ${id} same terminal`);
    }
  };

  expectColumn([ids[0], ids[1]], 'two concurrent launches stacked');
  // Exactly two open agents: Ctrl+Alt+X swaps top and bottom.
  assert.equal(await selector.cycle([ids[0], ids[1]]), 'swapped');
  expectColumn([ids[1], ids[0]], 'swap');
  // 3+: queue rotation in menu order (top → tab, bottom → top, next after the bottom one → bottom).
  assert.equal(await selector.cycle(ids), 'rotated');
  expectColumn([ids[0], ids[2]], 'rotation 1');
  assert.equal(await selector.cycle(ids), 'rotated');
  expectColumn([ids[2], ids[3]], 'rotation 2');
  // /subagent selection with both slots taken: same queue rule.
  await selector.select(ids[5]);
  expectColumn([ids[3], ids[5]], 'selection');
  await selector.select(ids[5]);
  expectColumn([ids[3], ids[5]], 'selecting a shown agent');

  // The top agent finishes: the runtime forgets it, then closes it; the next open agent in menu order
  // (owned order here) fills the top slot in place.
  selector.forget(ids[3]);
  run(['pane', 'close', ids[3]]);
  await selector.promoteVacated();
  expectColumn([ids[4], ids[5]], 'top finished → promotion in place');
  // The bottom agent finishes: wraps around to the first open one.
  selector.forget(ids[5]);
  run(['pane', 'close', ids[5]]);
  await selector.promoteVacated();
  expectColumn([ids[4], ids[0]], 'bottom finished → promotion in place');
  // A finished background agent leaves the column alone.
  selector.forget(ids[1]);
  run(['pane', 'close', ids[1]]);
  await selector.promoteVacated();
  expectColumn([ids[4], ids[0]], 'background finished');
  selector.forget(ids[0]);
  run(['pane', 'close', ids[0]]);
  await selector.promoteVacated();
  expectColumn([ids[4], ids[2]], 'last agent in a tab promoted');
  // Nothing left in tabs: the remaining agent takes the whole column.
  selector.forget(ids[2]);
  run(['pane', 'close', ids[2]]);
  await selector.promoteVacated();
  expectColumn([ids[4]], 'remaining agent fills the column');
  assert.equal(await selector.cycle([ids[4]]), 'only');
  expectColumn([ids[4]], 'only open agent');
  console.log(`PASS: column ${RATIO * 100}% wide, two concurrent launches stacked, swap, queue rotation, selection, promotions in place, full column, stable pane/terminal IDs, focus unchanged.`);
} finally {
  run(['workspace', 'close', workspace]);
  console.log(`Removed owned test workspace ${workspace}`);
}
