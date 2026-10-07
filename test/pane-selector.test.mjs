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
    if (args[1] === 'rename') return {};
    if (args[1] === 'split' || args[1] === 'create') {
      const id = `w1:p${next++}`;
      const pane = { pane_id: id, tab_id: args[1] === 'split' ? 'w1:t0' : `w1:t${next}`, workspace_id: 'w1' };
      panes.set(id, pane);
      return args[1] === 'split' ? { pane } : { root_pane: pane };
    }
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
  return { selector, panes, commands, state, fail: () => { failDisplay = true; }, uncertain: () => { uncertainDisplay = true; }, zoom: () => { zoomed = true; } };
}

test('10 simultaneous spawn requests create exactly one split; background agents never replace selection', async () => {
  const f = fixture();
  const ids = await Promise.all(Array.from({ length: 10 }, (_, i) => Promise.resolve().then(() => f.selector.create(`Agent ${i}`, '/tmp'))));
  assert.equal(f.commands.filter(c => c[1] === 'split').length, 1);
  assert.equal(f.commands.filter(c => c[1] === 'create').length, 9);
  assert.equal(f.selector.visible(), ids[0]);
  assert.equal(f.state.selected, ids[0]);
  assert.equal(f.panes.size, 11);
  for (const c of f.commands.filter(c => ['split', 'create'].includes(c[1]))) assert.ok(c.includes('--no-focus'));
});

test('selection parks previous terminal without closing or changing IDs; repeat selection is a no-op', () => {
  const f = fixture();
  const a = f.selector.create('A', '/tmp');
  const b = f.selector.create('B', '/tmp');
  f.selector.select(b);
  assert.equal(f.selector.visible(), b);
  assert.equal(f.panes.size, 3);
  assert.notEqual(f.panes.get(a).tab_id, 'w1:t0');
  assert.equal(f.panes.get(b).tab_id, 'w1:t0');
  const moves = f.commands.filter(c => c[1] === 'move').length;
  f.selector.select(b);
  assert.equal(f.commands.filter(c => c[1] === 'move').length, moves);
  f.selector.select(a);
  assert.equal(f.selector.visible(), a);
  assert.ok(!f.commands.some(c => c[1] === 'close'));
});

test('failed display restores previous terminal; both child terminals remain alive', () => {
  const f = fixture();
  const a = f.selector.create('A', '/tmp');
  const b = f.selector.create('B', '/tmp');
  f.fail();
  assert.throws(() => f.selector.select(b), /display failed/);
  assert.equal(f.selector.visible(), a);
  assert.equal(f.state.selected, a);
  assert.equal(f.panes.size, 3);
});

test('lost response after successful move reconciles without duplicate moves or rollback', () => {
  const f = fixture();
  f.selector.create('A', '/tmp');
  const b = f.selector.create('B', '/tmp');
  f.uncertain();
  f.selector.select(b);
  assert.equal(f.selector.visible(), b);
  assert.equal(f.commands.filter(c => c[1] === 'move').length, 2);
});

test('unowned panes, cross-workspace targets, zoom and unrelated splits are protected', () => {
  const f = fixture();
  assert.throws(() => f.selector.select('other'), /Only this session/);
  f.selector.create('A', '/tmp');
  const b = f.selector.create('B', '/tmp');
  f.panes.get(b).workspace_id = 'w2';
  assert.throws(() => f.selector.select(b), /another workspace/);
  f.panes.get(b).workspace_id = 'w1';
  f.panes.set('other', { pane_id: 'other', tab_id: 'w1:t0', workspace_id: 'w1' });
  assert.throws(() => f.selector.select(b), /other splits/);
  f.panes.delete('other');
  f.zoom();
  assert.throws(() => f.selector.select(b), /Unzoom/);
  assert.equal(f.commands.filter(c => c[1] === 'move').length, 0);
});

test('completed child is forgotten; next spawn does not unexpectedly change current selection', () => {
  const f = fixture();
  const a = f.selector.create('A', '/tmp');
  const b = f.selector.create('B', '/tmp');
  f.selector.forget(a);
  f.panes.delete(a);
  assert.equal(f.state.selected, undefined);
  const c = f.selector.create('C', '/tmp');
  assert.equal(f.panes.get(c).tab_id === 'w1:t0', false);
  f.selector.select(b);
  assert.equal(f.selector.visible(), b);
});

test('existing user split is never overwritten or split again', () => {
  const f = fixture();
  f.panes.set('user', { pane_id: 'user', tab_id: 'w1:t0', workspace_id: 'w1' });
  const id = f.selector.create('A', '/tmp');
  assert.notEqual(f.panes.get(id).tab_id, 'w1:t0');
  assert.equal(f.commands.filter(c => c[1] === 'split').length, 0);
});

test('state reused after reload retains ownership and selection', () => {
  const f = fixture();
  const a = f.selector.create('A', '/tmp');
  const b = f.selector.create('B', '/tmp');
  const reloaded = new PaneSelector(f.state, (args) => {
    if (args[1] === 'get') return { pane: f.panes.get(args[2]) };
    if (args[1] === 'layout') return { layout: { panes: [...f.panes.values()].filter(p => p.tab_id === 'w1:t0') } };
    throw new Error('Unexpected mutation');
  }, () => 'w1:p0');
  assert.equal(reloaded.visible(), a);
  assert.ok(reloaded.state.owned.has(b));
});
