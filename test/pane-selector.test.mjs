import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaneSelector, reservePlacement, adoptPane } from '../pi-extension/subagents/pane-selector.ts';

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
  const selector = new PaneSelector(state, run, () => 'w1:p0', { pollMs: 5, timeoutMs: 200 });
  // A launch through the agent runtime: reserve the placement, create the pane there, adopt it.
  const launch = (name) => {
    const reservation = selector.reserve();
    const id = `w1:p${next++}`;
    panes.set(id, { pane_id: id, tab_id: reservation.placement === 'split-right' ? 'w1:t0' : `w1:t${next}`, workspace_id: 'w1' });
    selector.adopt(reservation, id, name);
    return id;
  };
  // The finished agent's runtime: forget the pane, then close it.
  const finish = (id) => { selector.forget(id); panes.delete(id); };
  const mainTab = () => [...panes.values()].filter(p => p.tab_id === 'w1:t0').map(p => p.pane_id);
  return { selector, launch, finish, mainTab, panes, commands, state, fail: () => { failDisplay = true; }, uncertain: () => { uncertainDisplay = true; }, zoom: () => { zoomed = true; } };
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

test('a finished background agent changes neither the split nor the selection', async () => {
  const f = fixture();
  const a = f.launch('A');
  const b = f.launch('B');
  f.finish(b);
  await f.selector.promoteVacated();
  assert.equal(f.state.selected, a);
  assert.deepEqual(f.mainTab(), ['w1:p0', a]);
  assert.equal(f.commands.filter(c => c[1] === 'move').length, 0);
});

test('free split with owned agents in background tabs: a new auto launch takes the split', () => {
  const f = fixture();
  const a = f.launch('A');
  f.launch('B');
  f.launch('C');
  // The visible agent went away without a promotion (e.g. closed by the user).
  f.panes.get(a).tab_id = 'w1:elsewhere';
  const d = f.launch('D');
  assert.equal(f.panes.get(d).tab_id, 'w1:t0');
  assert.equal(f.state.selected, d);
  assert.equal(f.launch('E') && f.mainTab().length, 2);
});

test('visible agent finishes: the next one in menu order is moved into the split, same pane, selected', async () => {
  const f = fixture();
  const a = f.launch('A');
  const b = f.launch('B');
  const c = f.launch('C');
  await f.selector.select(b);
  const promoted = [];
  f.state.onPromoted = (id) => promoted.push(id);
  f.state.menuOrder = () => [a, b, c];
  f.finish(b);
  assert.equal(f.state.selected, undefined);
  await f.selector.promoteVacated();
  assert.deepEqual(f.mainTab(), ['w1:p0', c]);
  assert.equal(f.state.selected, c);
  assert.deepEqual(promoted, [c]);
  assert.ok(f.panes.has(a) && f.panes.has(c));
  assert.ok(!f.commands.some(c => c[1] === 'close' || c[1] === 'split'));
  const last = f.commands.filter(c => c[1] === 'move').at(-1);
  assert.deepEqual(last, ['pane', 'move', c, '--tab', 'w1:t0', '--target-pane', 'w1:p0', '--split', 'right', '--ratio', '0.5', '--no-focus']);
  assert.equal(f.state.reservedSplit, undefined);
  // The last one in the menu wraps around to the first.
  f.state.menuOrder = () => [a, c];
  f.finish(c);
  await f.selector.promoteVacated();
  assert.deepEqual(f.mainTab(), ['w1:p0', a]);
  assert.equal(f.state.selected, a);
});

test('unknown menu position promotes the first open agent', async () => {
  const f = fixture();
  const a = f.launch('A');
  const b = f.launch('B');
  const c = f.launch('C');
  f.state.menuOrder = () => [c, b]; // The finished agent is no longer listed.
  f.finish(a);
  await f.selector.promoteVacated();
  assert.equal(f.state.selected, c);
  assert.deepEqual(f.mainTab(), ['w1:p0', c]);
});

test('promotion waits until the finished pane has actually closed', async () => {
  const f = fixture();
  const a = f.launch('A');
  const b = f.launch('B');
  f.selector.forget(a); // Forgotten before the runtime closes it.
  const done = f.selector.promoteVacated();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.commands.filter(c => c[1] === 'move').length, 0);
  f.panes.delete(a);
  await done;
  assert.deepEqual(f.mainTab(), ['w1:p0', b]);
  assert.equal(f.state.selected, b);
});

test('a pane that never closes is not replaced', async () => {
  const f = fixture();
  const a = f.launch('A');
  f.launch('B');
  f.selector.forget(a);
  await f.selector.promoteVacated();
  assert.deepEqual(f.mainTab(), ['w1:p0', a]);
  assert.equal(f.commands.filter(c => c[1] === 'move').length, 0);
});

test('launch and promotion share the split reservation: never both take it', async () => {
  // A launch holds the reservation: the promotion skips.
  let f = fixture();
  let a = f.launch('A');
  f.launch('B');
  f.finish(a);
  const pending = f.selector.reserve();
  assert.equal(pending.placement, 'split-right');
  await f.selector.promoteVacated();
  assert.equal(f.commands.filter(c => c[1] === 'move').length, 0);
  f.selector.release(pending);

  // A promotion holds the reservation: a launch arriving meanwhile gets a tab.
  f = fixture();
  a = f.launch('A');
  const b = f.launch('B');
  f.state.onVacated = undefined; // Drive the promotion directly to launch while its move is in flight.
  f.finish(a);
  let during;
  const promoted = await f.selector.promote(f.state.vacated, async (id, to) => {
    during = f.selector.reserve();
    f.panes.get(id).tab_id = to.split.tab;
  });
  assert.equal(promoted, b);
  assert.equal(during.placement, 'tab');
  assert.equal(f.state.reservedSplit, undefined);
  assert.deepEqual(f.mainTab(), ['w1:p0', b]);
  assert.equal(f.state.selected, b);
});

test('a launch that read the layout before a promotion falls back to a tab', async () => {
  const f = fixture();
  const a = f.launch('A');
  f.launch('B');
  f.finish(a);
  const parent = f.panes.get('w1:p0');
  const epoch = f.state.layoutEpoch ?? 0;
  const staleLayout = { panes: [parent] };
  await f.selector.promoteVacated();
  assert.equal(f.mainTab().length, 2);
  assert.equal(reservePlacement(f.state, parent, staleLayout, 'auto', epoch).placement, 'tab');
});

test('two concurrent auto launches with a free split and agents in tabs: exactly one split', () => {
  const state = { owned: new Map([['bg1', 'B1'], ['bg2', 'B2']]) };
  const parent = { pane_id: 'w1:p0', tab_id: 'w1:t0', workspace_id: 'w1' };
  const layout = { panes: [parent] };
  const r1 = reservePlacement(state, parent, layout, 'auto', 0);
  const r2 = reservePlacement(state, parent, layout, 'auto', 0);
  assert.deepEqual([r1.placement, r2.placement], ['split-right', 'tab']);
  adoptPane(state, r1, 'n1', 'N1');
  adoptPane(state, r2, 'n2', 'N2');
  assert.equal(state.selected, 'n1');
});

test('no promotion with unrelated splits, zoom or agents in another workspace', async () => {
  for (const setup of [
    (f) => f.panes.set('user', { pane_id: 'user', tab_id: 'w1:t0', workspace_id: 'w1' }),
    (f) => f.zoom(),
    (f) => { for (const pane of f.panes.values()) if (pane.pane_id !== 'w1:p0') pane.workspace_id = 'w2'; },
  ]) {
    const f = fixture();
    const a = f.launch('A');
    f.launch('B');
    setup(f);
    f.finish(a);
    await f.selector.promoteVacated();
    assert.equal(f.commands.filter(c => c[1] === 'move').length, 0);
    assert.equal(f.state.selected, undefined);
    assert.equal(f.state.reservedSplit, undefined);
  }
});

test('a failed promotion keeps every terminal alive and the selector usable', async () => {
  const f = fixture();
  const a = f.launch('A');
  const b = f.launch('B');
  const c = f.launch('C');
  f.fail();
  f.finish(a);
  await f.selector.promoteVacated();
  assert.equal(f.state.selected, undefined);
  assert.equal(f.state.reservedSplit, undefined);
  assert.ok(f.panes.has(b) && f.panes.has(c));
  await f.selector.select(c);
  assert.equal(f.selector.visible(), c);
});

test('promotion moves runtime agents through their control (handle updated)', async () => {
  const f = fixture();
  const a = f.launch('A');
  const b = f.launch('B');
  const moves = [];
  f.state.controls.set(b, {
    handle: { paneId: b, tabId: 'old', workspaceId: 'w1' },
    move: async (h, to) => { moves.push([h.paneId, to]); f.panes.get(b).tab_id = to.split.tab; return { ...h, tabId: to.split.tab }; },
  });
  f.finish(a);
  await f.selector.promoteVacated();
  assert.deepEqual(moves, [[b, { split: { targetPane: 'w1:p0', tab: 'w1:t0', direction: 'right', ratio: 0.5 } }]]);
  assert.equal(f.state.controls.get(b).handle.tabId, 'w1:t0');
  assert.equal(f.state.selected, b);
  assert.ok(!f.commands.some(c => c[1] === 'move'));
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
