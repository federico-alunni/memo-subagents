import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaneSelector } from '../pi-extension/subagents/pane-selector.ts';

function fixture() {
  let next = 1;
  const panes = new Map([['w1:p0', { pane_id: 'w1:p0', tab_id: 'w1:t0', workspace_id: 'w1' }]]);
  const commands = [];
  let failDisplay = false;
  let uncertainDisplay = false;
  let zoomed = false;
  const state = { owned: new Map() };
  const run = (args) => {
    commands.push(args);
    const value = (flag) => args[args.indexOf(flag) + 1];
    if (args[1] === 'get') {
      const pane = panes.get(args[2]);
      if (!pane) throw new Error('pane_not_found');
      return { pane: { ...pane } };
    }
    if (args[1] === 'layout') return { layout: { zoomed, panes: [...panes.values()].filter(p => p.tab_id === 'w1:t0') } };
    if (args[1] === 'move') {
      const pane = panes.get(args[2]);
      if (!pane) throw new Error('pane_not_found');
      if (args.includes('--tab') && failDisplay) { failDisplay = false; throw new Error('display failed'); }
      pane.tab_id = args.includes('--new-tab') ? `w1:park${next++}` : value('--tab');
      if (args.includes('--tab') && uncertainDisplay) { uncertainDisplay = false; throw new Error('response lost'); }
      return { move_result: { changed: true, pane: { ...pane } } };
    }
    throw new Error(`Unexpected command ${args}`);
  };
  const selector = new PaneSelector(state, run, () => 'w1:p0');
  // A launch through the agent runtime: reserve the placement, create the pane there, adopt it.
  const launch = (name) => {
    const reservation = selector.reserve();
    const id = `w1:p${next++}`;
    panes.set(id, { pane_id: id, tab_id: reservation.placement === 'split-right' ? 'w1:t0' : `w1:t${next}`, workspace_id: 'w1' });
    selector.adopt(reservation, id, name);
    return id;
  };
  return { selector, launch, panes, commands, state, fail: () => { failDisplay = true; }, uncertain: () => { uncertainDisplay = true; }, zoom: () => { zoomed = true; } };
}

test('10 simultaneous launches reserve exactly one split; background agents never replace selection', () => {
  const f = fixture();
  const reservations = Array.from({ length: 10 }, () => f.selector.reserve());
  assert.equal(reservations.filter(r => r.placement === 'split-right').length, 1);
  assert.equal(reservations[0].placement, 'split-right');
  reservations.forEach((r, i) => f.selector.adopt(r, `id${i}`, `Agent ${i}`));
  assert.equal(f.state.selected, 'id0');
  assert.equal(f.state.reservedSplit, undefined);
  assert.equal(f.state.owned.size, 10);
});

test('a failed launch releases its split reservation', () => {
  const f = fixture();
  const first = f.selector.reserve();
  assert.equal(f.selector.reserve().placement, 'tab');
  f.selector.release(first);
  assert.equal(f.selector.reserve().placement, 'split-right');
});

test('selection parks previous terminal without closing or changing IDs; repeat selection is a no-op', async () => {
  const f = fixture();
  const a = f.launch('A');
  const b = f.launch('B');
  await f.selector.select(b);
  assert.equal(f.selector.visible(), b);
  assert.equal(f.panes.size, 3);
  assert.notEqual(f.panes.get(a).tab_id, 'w1:t0');
  assert.equal(f.panes.get(b).tab_id, 'w1:t0');
  const moves = f.commands.filter(c => c[1] === 'move').length;
  await f.selector.select(b);
  assert.equal(f.commands.filter(c => c[1] === 'move').length, moves);
  await f.selector.select(a);
  assert.equal(f.selector.visible(), a);
  assert.ok(!f.commands.some(c => c[1] === 'close'));
});

test('an injected mover (the agent runtime) receives every move', async () => {
  const f = fixture();
  const a = f.launch('A');
  const b = f.launch('B');
  const moves = [];
  await f.selector.select(b, async (paneId, to) => {
    moves.push([paneId, to]);
    f.panes.get(paneId).tab_id = 'newTab' in to ? 'w1:parked' : to.split.tab;
  });
  assert.deepEqual(moves, [
    [a, { newTab: { label: 'A' } }],
    [b, { split: { targetPane: 'w1:p0', tab: 'w1:t0', direction: 'right', ratio: 0.5 } }],
  ]);
  assert.equal(f.state.selected, b);
  assert.ok(!f.commands.some(c => c[1] === 'move'));
});

test('failed display restores previous terminal; both child terminals remain alive', async () => {
  const f = fixture();
  const a = f.launch('A');
  const b = f.launch('B');
  f.fail();
  await assert.rejects(f.selector.select(b), /display failed/);
  assert.equal(f.selector.visible(), a);
  assert.equal(f.state.selected, a);
  assert.equal(f.panes.size, 3);
});

test('lost response after successful move reconciles without duplicate moves or rollback', async () => {
  const f = fixture();
  f.launch('A');
  const b = f.launch('B');
  f.uncertain();
  await f.selector.select(b);
  assert.equal(f.selector.visible(), b);
  assert.equal(f.commands.filter(c => c[1] === 'move').length, 2);
});

test('unowned panes, cross-workspace targets, zoom and unrelated splits are protected', async () => {
  const f = fixture();
  await assert.rejects(f.selector.select('other'), /Only this session/);
  f.launch('A');
  const b = f.launch('B');
  f.panes.get(b).workspace_id = 'w2';
  await assert.rejects(f.selector.select(b), /another workspace/);
  f.panes.get(b).workspace_id = 'w1';
  f.panes.set('other', { pane_id: 'other', tab_id: 'w1:t0', workspace_id: 'w1' });
  await assert.rejects(f.selector.select(b), /other splits/);
  f.panes.delete('other');
  f.zoom();
  await assert.rejects(f.selector.select(b), /Unzoom/);
  assert.equal(f.commands.filter(c => c[1] === 'move').length, 0);
});

test('completed child is forgotten; next launch does not unexpectedly change current selection', async () => {
  const f = fixture();
  const a = f.launch('A');
  const b = f.launch('B');
  f.selector.forget(a);
  f.panes.delete(a);
  assert.equal(f.state.selected, undefined);
  const c = f.launch('C');
  assert.equal(f.panes.get(c).tab_id === 'w1:t0', false);
  await f.selector.select(b);
  assert.equal(f.selector.visible(), b);
});

test('existing user split is never overwritten or split again', () => {
  const f = fixture();
  f.panes.set('user', { pane_id: 'user', tab_id: 'w1:t0', workspace_id: 'w1' });
  assert.equal(f.selector.reserve().placement, 'tab');
});

test('unknown layout never splits', () => {
  const selector = new PaneSelector({ owned: new Map() }, () => { throw new Error('herdr down'); }, () => 'w1:p0');
  assert.equal(selector.reserve().placement, 'tab');
});

test('state reused after reload retains ownership and selection', () => {
  const f = fixture();
  const a = f.launch('A');
  const b = f.launch('B');
  const reloaded = new PaneSelector(f.state, (args) => {
    if (args[1] === 'get') return { pane: f.panes.get(args[2]) };
    if (args[1] === 'layout') return { layout: { panes: [...f.panes.values()].filter(p => p.tab_id === 'w1:t0') } };
    throw new Error('Unexpected mutation');
  }, () => 'w1:p0');
  assert.equal(reloaded.visible(), a);
  assert.ok(reloaded.state.owned.has(b));
});
