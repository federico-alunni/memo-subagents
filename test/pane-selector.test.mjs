import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PaneSelector, reservePlacement, adoptPane, releasePlacement, notePlacedPane, placedPane, columnRatio, columnSplitRatio,
  readColumn, selectorState, forgetPane,
} from '../pi-extension/subagents/pane-selector.ts';

/**
 * Fake Herdr tab: the main pane `w1:p0` and the agent column right of it (top to bottom). Moves follow
 * Herdr: `--new-tab` parks, `--split right` of the main pane creates the column, `--split down` inserts below.
 */
function fixture() {
  let next = 1;
  const MAIN = 'w1:p0';
  const panes = new Map([[MAIN, { pane_id: MAIN, tab_id: 'w1:t0', workspace_id: 'w1' }]]);
  let column = [];
  const commands = [];
  const failures = [];
  let zoomed = false;
  const state = { owned: new Map() };
  const place = (id, direction, target) => {
    if (direction === 'right') {
      assert.equal(target, MAIN, 'the column is created right of the main pane');
      assert.equal(column.length, 0, 'never split right of the main pane beside an existing column');
      column = [id];
    } else {
      const index = column.indexOf(target);
      assert.notEqual(index, -1, 'split down only below a pane of the column');
      column.splice(index + 1, 0, id);
    }
    panes.get(id).tab_id = 'w1:t0';
  };
  const run = (args) => {
    commands.push(args);
    const value = (flag) => args[args.indexOf(flag) + 1];
    if (args[1] === 'get') {
      const pane = panes.get(args[2]);
      if (!pane) throw new Error('pane_not_found');
      return { pane: { ...pane } };
    }
    if (args[1] === 'layout') {
      const extra = [...panes.values()].filter(p => p.tab_id === 'w1:t0' && p.pane_id !== MAIN && !column.includes(p.pane_id));
      return { layout: { zoomed, panes: [panes.get(MAIN), ...column.map(id => panes.get(id)), ...extra].map(p => ({ ...p })) } };
    }
    if (args[1] === 'move') {
      const id = args[2];
      const pane = panes.get(id);
      if (!pane) throw new Error('pane_not_found');
      const failure = failures.shift();
      if (failure === 'fail') throw new Error('display failed');
      if (args.includes('--new-tab')) {
        column = column.filter(p => p !== id);
        pane.tab_id = `w1:park${next++}`;
      } else {
        column = column.filter(p => p !== id);
        place(id, value('--split'), value('--target-pane'));
      }
      if (failure === 'lost') throw new Error('response lost');
      return { move_result: { changed: true, pane: { ...pane } } };
    }
    throw new Error(`Unexpected command ${args}`);
  };
  const selector = new PaneSelector(state, run, () => MAIN, { pollMs: 5, timeoutMs: 200 });
  /** The runtime's pane creation for a reservation (after it got its split target). */
  const create = (reservation, name) => {
    const id = `w1:p${next++}`;
    panes.set(id, { pane_id: id, tab_id: `w1:t${next}`, workspace_id: 'w1' });
    if (reservation.placement === 'split-right') place(id, 'right', reservation.targetPane);
    else if (reservation.placement === 'split-down') {
      const target = reservation.targetPane ?? state.placed.get(reservation.after);
      place(id, 'down', target);
    }
    selector.placed(reservation, id);
    return id;
  };
  // A launch through the agent runtime: reserve the placement, create the pane there, adopt it.
  const launch = (name) => {
    const reservation = selector.reserve();
    const id = create(reservation, name);
    selector.adopt(reservation, id, name);
    return id;
  };
  // The finished agent's runtime: forget the pane, then close it (Herdr gives its space to the other one).
  const close = (id) => { panes.delete(id); column = column.filter(p => p !== id); };
  const finish = (id) => { selector.forget(id); close(id); };
  const mainTab = () => [MAIN, ...column];
  const moves = () => commands.filter(c => c[1] === 'move');
  return {
    selector, launch, create, finish, close, mainTab, panes, commands, moves, state, MAIN,
    fail: (n = 1) => { for (let i = 0; i < n; i++) failures.push('fail'); },
    failAt: (index) => { for (let i = 0; i < index; i++) failures.push(undefined); failures.push('fail'); },
    uncertain: () => { failures.push('lost'); },
    zoom: () => { zoomed = true; },
    addForeign: (id = 'user') => panes.set(id, { pane_id: id, tab_id: 'w1:t0', workspace_id: 'w1' }),
  };
}

delete process.env.PI_SUBAGENT_COLUMN_RATIO; // Default 0.4 unless a test sets it.

const parked = (f, id) => f.panes.has(id) && f.panes.get(id).tab_id !== 'w1:t0';

// ── Column ratio ──

test('column ratio: PI_SUBAGENT_COLUMN_RATIO strictly between 0 and 1, otherwise 0.4', () => {
  assert.equal(columnRatio(undefined), 0.4);
  assert.equal(columnRatio('0.3'), 0.3);
  assert.equal(columnRatio(' 0.25 '), 0.25);
  assert.equal(columnRatio('.5'), 0.5);
  assert.equal(columnRatio('0.9'), 0.9);
  for (const invalid of ['', '0', '1', '1.5', '-0.2', 'abc', '40%', '0.4.1', 'NaN', 'Infinity', '4e-1', '0,4'])
    assert.equal(columnRatio(invalid), 0.4, invalid);
  // Herdr's --ratio of a right split measures the main pane (the left side).
  assert.equal(columnSplitRatio(0.4), 0.6);
  assert.equal(columnSplitRatio(0.3), 0.7);
  assert.equal(columnSplitRatio(0.7), 0.3);
});

test('the column ratio is read when placing: launches and moves into the column use it', async () => {
  const previous = process.env.PI_SUBAGENT_COLUMN_RATIO;
  try {
    process.env.PI_SUBAGENT_COLUMN_RATIO = '0.3';
    const f = fixture();
    const r = f.selector.reserve();
    assert.deepEqual([r.placement, r.targetPane, r.ratio], ['split-right', 'w1:p0', 0.7]);
    f.selector.release(r);
    const a = f.launch('A');
    f.launch('B');
    const c = f.launch('C');
    await f.selector.select(c);
    process.env.PI_SUBAGENT_COLUMN_RATIO = 'nonsense';
    f.state.menuOrder = () => [a, c];
    // B (top) finishes: the remaining agent C is parked and moved back below the promoted one.
    const b = f.mainTab()[1];
    f.finish(b);
    await f.selector.promoteVacated();
    const right = f.moves().filter(m => m.includes('right'));
    assert.deepEqual(right.at(-1).slice(-3), ['--ratio', '0.6', '--no-focus']);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_COLUMN_RATIO;
    else process.env.PI_SUBAGENT_COLUMN_RATIO = previous;
  }
});

// ── Placement ──

test('1 agent fills the column, 2 are stacked top/bottom, 3+ go to background tabs', () => {
  const f = fixture();
  const a = f.launch('A');
  assert.deepEqual(f.mainTab(), ['w1:p0', a]);
  assert.deepEqual(f.state.slots, [a]);
  const b = f.launch('B');
  assert.deepEqual(f.mainTab(), ['w1:p0', a, b]);
  assert.deepEqual(f.state.slots, [a, b]);
  const c = f.launch('C');
  const d = f.launch('D');
  assert.deepEqual(f.mainTab(), ['w1:p0', a, b]);
  assert.ok(parked(f, c) && parked(f, d));
  assert.deepEqual(f.state.slots, [a, b]);
  assert.equal(f.state.owned.size, 4);
});

test('10 simultaneous launches reserve exactly the two slots; the bottom one waits for the top pane', async () => {
  const f = fixture();
  const reservations = Array.from({ length: 10 }, () => f.selector.reserve());
  assert.deepEqual(reservations.map(r => r.placement), ['split-right', 'split-down', ...Array(8).fill('tab')]);
  assert.deepEqual([reservations[0].slot, reservations[1].slot], [0, 1]);
  assert.equal(reservations[1].after, reservations[0].token);
  assert.equal(reservations[1].targetPane, undefined);
  // The bottom launch waits until the top one created its pane, then splits below it.
  const waiting = placedPane(f.state, reservations[1].after, { pollMs: 1 });
  const ids = reservations.map((r, i) => i === 1 ? undefined : f.create(r, `Agent ${i}`));
  assert.equal(await waiting, ids[0]);
  ids[1] = f.create({ ...reservations[1], targetPane: ids[0] }, 'Agent 1');
  // Adopted in any order.
  reservations.slice().reverse().forEach((r, i) => f.selector.adopt(r, ids[9 - i], `Agent ${9 - i}`));
  assert.deepEqual(f.mainTab(), ['w1:p0', ids[0], ids[1]]);
  assert.deepEqual(f.state.slots, [ids[0], ids[1]]);
  assert.deepEqual(f.state.reservedSlots.filter(Boolean), []);
  assert.equal(f.state.placed.size, 0);
  assert.equal(f.state.owned.size, 10);
});

test('a pane created by a launch that has not adopted it yet counts as ours: the next launch goes below it', () => {
  const f = fixture();
  const top = f.selector.reserve();
  const id = f.create(top, 'A');
  const bottom = f.selector.reserve();
  assert.deepEqual([bottom.placement, bottom.targetPane, bottom.after], ['split-down', id, undefined]);
  assert.equal(f.selector.reserve().placement, 'tab');
  f.selector.adopt(top, id, 'A');
  const b = f.create(bottom, 'B');
  f.selector.adopt(bottom, b, 'B');
  assert.deepEqual(f.mainTab(), ['w1:p0', id, b]);
});

test('a failed launch releases its slot; a bottom launch waiting for a failed top launch decides again', async () => {
  const f = fixture();
  const first = f.selector.reserve();
  const second = f.selector.reserve();
  assert.equal(f.selector.reserve().placement, 'tab');
  const waiting = placedPane(f.state, second.after, { pollMs: 1 });
  f.selector.release(first);
  assert.equal(await waiting, undefined);
  f.selector.release(second);
  assert.equal(f.selector.reserve().placement, 'split-right');
});

test('a waiting bottom launch gives up after its timeout', async () => {
  const f = fixture();
  const first = f.selector.reserve();
  assert.equal(await placedPane(f.state, first.token, { pollMs: 1, timeoutMs: 10 }), undefined);
  notePlacedPane(f.state, { placement: 'tab', token: 'x' }, 'ignored');
  assert.equal(f.state.placed?.size ?? 0, 0);
});

test('two concurrent auto launches with a free column and agents in tabs: top and bottom, never a third', () => {
  const state = { owned: new Map([['bg1', 'B1'], ['bg2', 'B2']]) };
  const parent = { pane_id: 'w1:p0', tab_id: 'w1:t0', workspace_id: 'w1' };
  const layout = { panes: [parent] };
  const r1 = reservePlacement(state, parent, layout, 'auto', 0);
  const r2 = reservePlacement(state, parent, layout, 'auto', 0);
  const r3 = reservePlacement(state, parent, layout, 'auto', 0);
  assert.deepEqual([r1.placement, r2.placement, r3.placement], ['split-right', 'split-down', 'tab']);
  notePlacedPane(state, r1, 'n1');
  adoptPane(state, r1, 'n1', 'N1');
  adoptPane(state, r2, 'n2', 'N2');
  adoptPane(state, r3, 'n3', 'N3');
  assert.deepEqual(state.slots, ['n1', 'n2']);
});

test('visible placement with both slots taken: queue rule (top parked, bottom up, new one below it)', () => {
  const state = { owned: new Map([['a', 'A'], ['b', 'B']]) };
  const parent = { pane_id: 'main', tab_id: 't', workspace_id: 'w' };
  const layout = { panes: [parent, { pane_id: 'a' }, { pane_id: 'b' }] };
  assert.equal(reservePlacement(state, parent, layout, 'auto').placement, 'tab');
  const r = reservePlacement(state, parent, layout, 'visible');
  assert.deepEqual([r.placement, r.park, r.targetPane, r.slot, r.ratio], ['split-down', 'a', 'b', 1, 0.5]);
  // Exclusive: the next visible launch gets a tab.
  assert.equal(reservePlacement(state, parent, layout, 'visible').placement, 'tab');
  state.slots = ['b']; // The runtime parked `a`.
  adoptPane(state, r, 'n', 'N');
  assert.deepEqual(state.slots, ['b', 'n']);
  // With a free slot it simply fills it; a foreign split or zoom gives a tab.
  const one = { owned: new Map([['a', 'A']]) };
  const free = reservePlacement(one, parent, { panes: [parent, { pane_id: 'a' }] }, 'visible');
  assert.deepEqual([free.placement, free.targetPane, free.park], ['split-down', 'a', undefined]);
  assert.equal(reservePlacement({ owned: new Map() }, parent, { panes: [parent, { pane_id: 'user' }] }, 'visible').placement, 'tab');
  assert.equal(reservePlacement({ owned: new Map() }, parent, { zoomed: true, panes: [parent] }, 'visible').placement, 'tab');
});

test('agents not stacked in one column on the right are refused (Herdr rectangles)', () => {
  const parent = { pane_id: 'main', tab_id: 't', workspace_id: 'w' };
  const ours = () => true;
  const rect = (x, y, width, height) => ({ x, y, width, height });
  const column = { panes: [
    { pane_id: 'main', rect: rect(0, 0, 106, 61) },
    { pane_id: 'b', rect: rect(106, 31, 71, 30) },
    { pane_id: 'a', rect: rect(106, 0, 71, 31) },
  ] };
  assert.deepEqual(readColumn(column, parent, ours), { shown: ['a', 'b'] });
  const sideBySide = { panes: [
    { pane_id: 'main', rect: rect(0, 0, 80, 61) },
    { pane_id: 'a', rect: rect(80, 0, 50, 61) },
    { pane_id: 'b', rect: rect(130, 0, 47, 61) },
  ] };
  assert.match(readColumn(sideBySide, parent, ours).refusal, /other splits/);
  const below = { panes: [
    { pane_id: 'main', rect: rect(0, 0, 177, 30) },
    { pane_id: 'a', rect: rect(0, 30, 177, 31) },
  ] };
  assert.match(readColumn(below, parent, ours).refusal, /other splits/);
  assert.match(readColumn({ panes: [{ pane_id: 'main' }, { pane_id: 'a' }, { pane_id: 'b' }, { pane_id: 'c' }] }, parent, ours).refusal, /other splits/);
});

test('free column with owned agents in background tabs: a new auto launch takes it', () => {
  const f = fixture();
  const a = f.launch('A');
  f.launch('B');
  f.launch('C');
  // The shown agents went away without a promotion (e.g. closed by the user).
  f.close(a);
  f.close(f.mainTab()[1]);
  const d = f.launch('D');
  assert.deepEqual(f.mainTab(), ['w1:p0', d]);
  const e = f.launch('E');
  assert.deepEqual(f.mainTab(), ['w1:p0', d, e]);
  f.launch('F');
  assert.equal(f.mainTab().length, 3);
});

test('existing user split is never overwritten or split again; unknown layout never splits', () => {
  const f = fixture();
  f.addForeign();
  assert.equal(f.selector.reserve().placement, 'tab');
  const selector = new PaneSelector({ owned: new Map() }, () => { throw new Error('herdr down'); }, () => 'w1:p0');
  assert.equal(selector.reserve().placement, 'tab');
});

test('a launch that read the layout before the selector moved panes falls back to a tab', async () => {
  const f = fixture();
  const a = f.launch('A');
  f.launch('B');
  const c = f.launch('C');
  const parent = f.panes.get('w1:p0');
  const epoch = f.state.layoutEpoch ?? 0;
  const staleLayout = { panes: [parent, { pane_id: a }] };
  await f.selector.select(c);
  assert.equal(reservePlacement(f.state, parent, staleLayout, 'auto', epoch).placement, 'tab');
});

// ── Selection (/subagent menu) ──

test('selection with a free slot fills it; selecting a shown agent changes nothing', async () => {
  const f = fixture();
  const [a, b, c] = ['A', 'B', 'C'].map(name => f.launch(name));
  f.state.onVacated = undefined; // No automatic promotion: the bottom slot stays free.
  f.finish(b);
  assert.deepEqual(f.mainTab(), ['w1:p0', a]);
  await f.selector.select(c);
  assert.deepEqual(f.mainTab(), ['w1:p0', a, c]);
  assert.deepEqual(f.state.slots, [a, c]);
  assert.deepEqual(f.moves().at(-1), ['pane', 'move', c, '--tab', 'w1:t0', '--target-pane', a, '--split', 'down', '--ratio', '0.5', '--no-focus']);
  const count = f.moves().length;
  await f.selector.select(a);
  await f.selector.select(c);
  assert.equal(f.moves().length, count);
});

test('selection with both slots taken: top parked, bottom moves up, chosen agent below; IDs stable', async () => {
  const f = fixture();
  const a = f.launch('A');
  const b = f.launch('B');
  const c = f.launch('C');
  await f.selector.select(c);
  assert.deepEqual(f.mainTab(), ['w1:p0', b, c]);
  assert.deepEqual(f.state.slots, [b, c]);
  assert.ok(parked(f, a));
  assert.equal(f.panes.size, 4);
  assert.deepEqual(f.moves().map(m => [m[2], m.includes('--new-tab') ? 'tab' : m[m.indexOf('--split') + 1]]), [[a, 'tab'], [c, 'down']]);
  assert.ok(!f.commands.some(c => c[1] === 'close' || c[1] === 'split'));
  await f.selector.select(a);
  assert.deepEqual(f.mainTab(), ['w1:p0', c, a]);
});

test('an injected mover (the agent runtime) receives every move', async () => {
  const f = fixture();
  const a = f.launch('A');
  const b = f.launch('B');
  const c = f.launch('C');
  const moves = [];
  const herdr = f.selector.herdrMover();
  await f.selector.select(c, async (paneId, to) => { moves.push([paneId, to]); await herdr(paneId, to); });
  assert.deepEqual(moves, [
    [a, { newTab: { label: 'A' } }],
    [c, { split: { targetPane: b, tab: 'w1:t0', direction: 'down', ratio: 0.5 } }],
  ]);
  assert.deepEqual(f.state.slots, [b, c]);
});

test('a failed move rolls the column back; every terminal stays alive', async () => {
  const f = fixture();
  const a = f.launch('A');
  const b = f.launch('B');
  const c = f.launch('C');
  f.failAt(1); // The park of A succeeds, moving C below B fails.
  await assert.rejects(f.selector.select(c), /display failed/);
  assert.deepEqual(f.mainTab(), ['w1:p0', a, b]);
  assert.deepEqual(f.state.slots, [a, b]);
  assert.equal(f.panes.size, 4);
  assert.ok(parked(f, c));
  assert.deepEqual(f.state.reservedSlots.filter(Boolean), []);
  // The selector stays usable.
  await f.selector.select(c);
  assert.deepEqual(f.mainTab(), ['w1:p0', b, c]);
});

test('lost response after successful move reconciles without duplicate moves or rollback', async () => {
  const f = fixture();
  const [, b, c] = ['A', 'B', 'C'].map(name => f.launch(name));
  f.uncertain();
  await f.selector.select(c);
  assert.deepEqual(f.mainTab(), ['w1:p0', b, c]);
  assert.deepEqual(f.state.slots, [b, c]);
  assert.equal(f.moves().length, 2);
});

test('unowned panes, cross-workspace targets, zoom and unrelated splits are protected', async () => {
  const f = fixture();
  await assert.rejects(f.selector.select('other'), /Only this session/);
  f.launch('A');
  f.launch('B');
  const c = f.launch('C');
  f.panes.get(c).workspace_id = 'w2';
  await assert.rejects(f.selector.select(c), /another workspace/);
  f.panes.get(c).workspace_id = 'w1';
  f.addForeign('other');
  await assert.rejects(f.selector.select(c), /other splits/);
  await assert.rejects(f.selector.cycle([c]), /other splits/);
  f.panes.delete('other');
  f.zoom();
  await assert.rejects(f.selector.select(c), /Unzoom/);
  await assert.rejects(f.selector.cycle([c]), /Unzoom/);
  assert.equal(f.moves().length, 0);
});

test('the selector refuses while a launch holds a slot', async () => {
  const f = fixture();
  const a = f.launch('A');
  f.launch('B');
  const c = f.launch('C');
  f.close(f.mainTab()[2]);
  const pending = f.selector.reserve();
  assert.equal(pending.placement, 'split-down');
  await assert.rejects(f.selector.select(c), /being placed/);
  f.selector.release(pending);
  await f.selector.select(c);
  assert.deepEqual(f.mainTab(), ['w1:p0', a, c]);
});

// ── Ctrl+Alt+X ──

test('Ctrl+Alt+X with one open agent changes nothing', async () => {
  const f = fixture();
  const a = f.launch('A');
  assert.equal(await f.selector.cycle([a]), 'only');
  assert.equal(f.moves().length, 0);
  assert.deepEqual(f.mainTab(), ['w1:p0', a]);
});

test('Ctrl+Alt+X with exactly two open agents swaps top and bottom', async () => {
  const f = fixture();
  const a = f.launch('A');
  const b = f.launch('B');
  const before = new Map([...f.panes].map(([id, p]) => [id, p.pane_id]));
  assert.equal(await f.selector.cycle([a, b]), 'swapped');
  assert.deepEqual(f.mainTab(), ['w1:p0', b, a]);
  assert.deepEqual(f.state.slots, [b, a]);
  assert.equal(await f.selector.cycle([a, b]), 'swapped');
  assert.deepEqual(f.mainTab(), ['w1:p0', a, b]);
  assert.deepEqual(new Map([...f.panes].map(([id, p]) => [id, p.pane_id])), before);
  assert.ok(!f.commands.some(c => c[1] === 'close' || c[1] === 'split'));
});

test('Ctrl+Alt+X with 3+ agents rotates as a queue in menu order, wrapping around', async () => {
  const f = fixture();
  const ids = ['A', 'B', 'C', 'D'].map(name => f.launch(name));
  const [a, b, c, d] = ids;
  assert.deepEqual(f.mainTab(), ['w1:p0', a, b]);
  const seen = [];
  for (let i = 0; i < 4; i++) {
    assert.equal(await f.selector.cycle(ids), 'rotated');
    seen.push(f.mainTab().slice(1));
    assert.equal(f.panes.size, 5);
  }
  assert.deepEqual(seen, [[b, c], [c, d], [d, a], [a, b]]);
  // Each step: top → tab, then the next one below the agent that moved up.
  assert.deepEqual(f.moves().slice(0, 2).map(m => [m[2], m.includes('--new-tab') ? 'tab' : m[m.indexOf('--target-pane') + 1]]), [[a, 'tab'], [c, b]]);
  // Menu order decides who comes next, not launch order.
  assert.equal(await f.selector.cycle([a, b, d, c]), 'rotated');
  assert.deepEqual(f.mainTab().slice(1), [b, d]);
});

test('Ctrl+Alt+X fills a free slot first', async () => {
  const f = fixture();
  const [a, b, c] = ['A', 'B', 'C'].map(name => f.launch(name));
  f.state.onVacated = undefined;
  f.finish(b);
  assert.equal(await f.selector.cycle([a, b, c]), 'filled');
  assert.deepEqual(f.mainTab(), ['w1:p0', a, c]);
  assert.equal(f.moves().length, 1);
});

test('Ctrl+Alt+X with an empty column shows the first two open agents', async () => {
  const f = fixture();
  const a = f.launch('A');
  const b = f.launch('B');
  const c = f.launch('C');
  f.state.onVacated = undefined;
  // Park both shown agents directly (e.g. moved by the user).
  await f.selector.herdrMover()(a, { newTab: { label: 'A' } });
  await f.selector.herdrMover()(b, { newTab: { label: 'B' } });
  assert.equal(await f.selector.cycle([c, a, b]), 'filled');
  assert.deepEqual(f.mainTab(), ['w1:p0', c, a]);
  assert.deepEqual(f.state.slots, [c, a]);
});

test('Ctrl+Alt+X skips agents in other workspaces', async () => {
  const f = fixture();
  const a = f.launch('A');
  const b = f.launch('B');
  const c = f.launch('C');
  f.panes.get(c).workspace_id = 'w2';
  assert.equal(await f.selector.cycle([a, b, c]), 'swapped');
  assert.deepEqual(f.mainTab(), ['w1:p0', b, a]);
});

// ── A shown agent finishes ──

test('a finished background agent changes neither the column nor the slots', async () => {
  const f = fixture();
  const a = f.launch('A');
  const b = f.launch('B');
  const c = f.launch('C');
  f.finish(c);
  await f.selector.promoteVacated();
  assert.deepEqual(f.state.slots, [a, b]);
  assert.deepEqual(f.mainTab(), ['w1:p0', a, b]);
  assert.equal(f.moves().length, 0);
});

test('the bottom agent finishes: the next one in menu order fills the bottom slot in place', async () => {
  const f = fixture();
  const [a, b, c, d] = ['A', 'B', 'C', 'D'].map(name => f.launch(name));
  const promoted = [];
  f.state.onPromoted = (id) => promoted.push(id);
  f.state.menuOrder = () => [a, b, c, d];
  f.finish(b);
  assert.deepEqual(f.state.slots, [a]);
  await f.selector.promoteVacated();
  assert.deepEqual(f.mainTab(), ['w1:p0', a, c]);
  assert.deepEqual(f.state.slots, [a, c]);
  assert.deepEqual(promoted, [c]);
  assert.deepEqual(f.moves(), [['pane', 'move', c, '--tab', 'w1:t0', '--target-pane', a, '--split', 'down', '--ratio', '0.5', '--no-focus']]);
  assert.ok(!f.commands.some(c => c[1] === 'close' || c[1] === 'split'));
  assert.deepEqual(f.state.reservedSlots.filter(Boolean), []);
  assert.ok(f.panes.has(d));
});

test('the top agent finishes: the next one in menu order fills the top slot in place', async () => {
  const f = fixture();
  const [a, b, c] = ['A', 'B', 'C'].map(name => f.launch(name));
  f.state.menuOrder = () => [a, b, c];
  f.finish(a);
  await f.selector.promoteVacated();
  // After A comes B (shown), then C.
  assert.deepEqual(f.mainTab(), ['w1:p0', c, b]);
  assert.deepEqual(f.state.slots, [c, b]);
  assert.deepEqual(f.moves().map(m => [m[2], m.includes('--new-tab') ? 'tab' : m[m.indexOf('--split') + 1]]), [[b, 'tab'], [c, 'right'], [b, 'down']]);
  assert.deepEqual(f.moves()[1].slice(-3), ['--ratio', '0.6', '--no-focus']);
});

test('a shown agent finishes with no agent in a tab: the remaining one keeps the whole column', async () => {
  const f = fixture();
  const a = f.launch('A');
  const b = f.launch('B');
  f.state.menuOrder = () => [a, b];
  f.finish(a);
  await f.selector.promoteVacated();
  assert.deepEqual(f.mainTab(), ['w1:p0', b]);
  assert.deepEqual(f.state.slots, [b]);
  assert.equal(f.moves().length, 0);
});

test('the last agent in the menu wraps around to the first; unknown position promotes the first open one', async () => {
  let f = fixture();
  let [a, b, c] = ['A', 'B', 'C'].map(name => f.launch(name));
  f.state.menuOrder = () => [c, a, b];
  f.finish(b);
  await f.selector.promoteVacated();
  assert.deepEqual(f.mainTab(), ['w1:p0', a, c]);

  f = fixture();
  [a, b, c] = ['A', 'B', 'C'].map(name => f.launch(name));
  f.state.menuOrder = () => [c, a]; // The finished agent is no longer listed.
  f.finish(b);
  await f.selector.promoteVacated();
  assert.deepEqual(f.mainTab(), ['w1:p0', a, c]);
});

test('both shown agents finish: both slots are filled', async () => {
  const f = fixture();
  const [a, b, c, d, e] = ['A', 'B', 'C', 'D', 'E'].map(name => f.launch(name));
  f.state.menuOrder = () => [a, b, c, d, e];
  f.finish(a);
  f.finish(b);
  await f.selector.promoteVacated();
  assert.equal(f.mainTab().length, 3);
  assert.deepEqual(new Set(f.mainTab().slice(1)), new Set([c, d]));
  assert.ok(parked(f, e));
});

test('promotion waits until the finished pane has actually closed; a pane that never closes is not replaced', async () => {
  let f = fixture();
  let [a, b, c] = ['A', 'B', 'C'].map(name => f.launch(name));
  f.selector.forget(b); // Forgotten before the runtime closes it.
  const done = f.selector.promoteVacated();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.moves().length, 0);
  f.close(b);
  await done;
  assert.deepEqual(f.mainTab(), ['w1:p0', a, c]);

  f = fixture();
  [a, b, c] = ['A', 'B', 'C'].map(name => f.launch(name));
  f.selector.forget(a);
  await f.selector.promoteVacated();
  assert.deepEqual(f.mainTab(), ['w1:p0', a, b]);
  assert.equal(f.moves().length, 0);
});

test('launch and promotion share the slot reservations: never both take a slot', async () => {
  // A launch holds the free slot: the promotion skips.
  let f = fixture();
  let [a, b] = ['A', 'B', 'C'].map(name => f.launch(name));
  f.finish(b);
  const pending = f.selector.reserve();
  assert.equal(pending.placement, 'split-down');
  await f.selector.promoteVacated();
  assert.equal(f.moves().length, 0);
  f.selector.release(pending);

  // A promotion holds the slots: a launch arriving meanwhile gets a tab.
  f = fixture();
  [a, b] = ['A', 'B', 'C'].map(name => f.launch(name));
  const c = [...f.state.owned.keys()][2];
  f.state.onVacated = undefined; // Drive the promotion directly to launch while its move is in flight.
  f.finish(b);
  let during;
  const herdr = f.selector.herdrMover();
  const promoted = await f.selector.promote(f.state.vacated[0], async (id, to) => {
    during = f.selector.reserve();
    await herdr(id, to);
  });
  assert.equal(promoted, c);
  assert.equal(during.placement, 'tab');
  assert.deepEqual(f.state.reservedSlots.filter(Boolean), []);
  assert.deepEqual(f.mainTab(), ['w1:p0', a, c]);
  assert.deepEqual(f.state.slots, [a, c]);
});

test('no promotion with unrelated splits, zoom or agents in another workspace', async () => {
  for (const setup of [
    (f) => f.addForeign(),
    (f) => f.zoom(),
    (f) => { for (const pane of f.panes.values()) if (pane.tab_id !== 'w1:t0') pane.workspace_id = 'w2'; },
  ]) {
    const f = fixture();
    const [a] = ['A', 'B', 'C'].map(name => f.launch(name));
    setup(f);
    f.finish(a);
    await f.selector.promoteVacated();
    assert.equal(f.moves().length, 0);
    assert.deepEqual(f.state.reservedSlots.filter(Boolean), []);
  }
});

test('a failed promotion keeps every terminal alive and the selector usable', async () => {
  const f = fixture();
  const [a, b, c, d] = ['A', 'B', 'C', 'D'].map(name => f.launch(name));
  f.fail();
  f.finish(b);
  await f.selector.promoteVacated();
  assert.deepEqual(f.state.slots, [a]);
  assert.deepEqual(f.state.reservedSlots.filter(Boolean), []);
  assert.ok(f.panes.has(c) && f.panes.has(d));
  await f.selector.select(d);
  assert.deepEqual(f.mainTab(), ['w1:p0', a, d]);
});

test('a failed top-slot promotion rolls back: the remaining agent is shown again', async () => {
  const f = fixture();
  const [a, b, c] = ['A', 'B', 'C'].map(name => f.launch(name));
  f.state.menuOrder = () => [a, b, c];
  f.failAt(1); // B parked, moving C into the column fails.
  f.finish(a);
  await f.selector.promoteVacated();
  assert.deepEqual(f.mainTab(), ['w1:p0', b]);
  assert.deepEqual(f.state.slots, [b]);
  assert.ok(f.panes.has(c));
});

test('promotion moves runtime agents through their control (handle updated)', async () => {
  const f = fixture();
  const [a, b, c] = ['A', 'B', 'C'].map(name => f.launch(name));
  const moves = [];
  const herdr = f.selector.herdrMover();
  f.state.controls.set(c, {
    handle: { paneId: c, tabId: 'old', workspaceId: 'w1' },
    move: async (h, to) => { moves.push([h.paneId, to]); await herdr(h.paneId, to); return { ...h, tabId: f.panes.get(c).tab_id }; },
  });
  f.finish(b);
  await f.selector.promoteVacated();
  assert.deepEqual(moves, [[c, { split: { targetPane: a, tab: 'w1:t0', direction: 'down', ratio: 0.5 } }]]);
  assert.equal(f.state.controls.get(c).handle.tabId, 'w1:t0');
  assert.deepEqual(f.state.slots, [a, c]);
});

// ── State ──

test('state reused after reload retains ownership and slots; an older single-agent state is migrated', () => {
  const f = fixture();
  const a = f.launch('A');
  const b = f.launch('B');
  const reloaded = new PaneSelector(f.state, (args) => {
    if (args[1] === 'get') return { pane: f.panes.get(args[2]) };
    if (args[1] === 'layout') return { layout: { panes: f.mainTab().map(id => ({ pane_id: id })) } };
    throw new Error('Unexpected mutation');
  }, () => 'w1:p0');
  assert.deepEqual(reloaded.visible(), [a, b]);
  assert.deepEqual(reloaded.state.slots, [a, b]);

  const key = Symbol.for('pi-subagents/pane-selector-v1');
  const previous = globalThis[key];
  try {
    globalThis[key] = { owned: new Map([['x', 'X']]), selected: 'x', reservedSplit: 'tok', vacated: { paneId: 'y', order: [] } };
    const state = selectorState();
    assert.deepEqual(state.slots, ['x']);
    assert.deepEqual(state.reservedSlots, ['tok']);
    assert.equal(state.selected, undefined);
    assert.deepEqual(state.vacated, [{ paneId: 'y', order: [] }]);
    releasePlacement(state, { token: 'tok', placement: 'split-right' });
    assert.deepEqual(state.reservedSlots.filter(Boolean), []);
    forgetPane(state, 'x');
    assert.deepEqual(state.slots, []);
  } finally {
    globalThis[key] = previous;
  }
});

// ── Grid (cols × rows) ──

import { parseGrid, configuredGrid, slotSplit, planColumn, gridCapacity, selectorGrid } from '../pi-extension/subagents/pane-selector.ts';

test('grid: "CxR" with sides 1..4; PI_SUBAGENT_GRID, else 1×2; a live agent can only enlarge it', () => {
  assert.deepEqual(parseGrid('2x2'), { cols: 2, rows: 2 });
  assert.deepEqual(parseGrid(' 1 × 3 '), { cols: 1, rows: 3 });
  for (const invalid of ['', '2', '0x2', '5x1', 'x2', '2x', 'axb', 2, undefined]) assert.equal(parseGrid(invalid), undefined, String(invalid));
  assert.deepEqual(configuredGrid({ PI_SUBAGENT_GRID: '3x1', PI_MEMO_SUBAGENTS_CONFIG: '/nonexistent' }), { cols: 3, rows: 1 });
  assert.deepEqual(configuredGrid({ PI_SUBAGENT_GRID: 'bad', PI_MEMO_SUBAGENTS_CONFIG: '/nonexistent' }), { cols: 1, rows: 2 });
  const state = { owned: new Map() };
  assert.deepEqual(selectorGrid(state), { cols: 1, rows: 2 });
  state.gridHint = () => ({ cols: 2, rows: 2 });
  assert.deepEqual(selectorGrid(state), { cols: 2, rows: 2 });
  state.gridHint = () => ({ cols: 1, rows: 1 });
  assert.deepEqual(selectorGrid(state), { cols: 1, rows: 2 });
  assert.equal(gridCapacity({ cols: 3, rows: 2 }), 6);
});

test('grid: 2×2 lead stays top (full width); slots 1 and 2 take bottom half side by side', () => {
  const parent = { pane_id: 'main', tab_id: 't', workspace_id: 'w' };
  const g = { cols: 2, rows: 2 };
  assert.equal(gridCapacity(g), 3);
  assert.deepEqual(slotSplit(0, g, parent), { direction: 'right', from: 'main', ratio: 0.6 });
  assert.deepEqual(slotSplit(1, g, parent), { direction: 'down', from: 0, ratio: 0.5 });
  assert.deepEqual(slotSplit(2, g, parent), { direction: 'right', from: 1, ratio: 0.5 });
  const three = { cols: 1, rows: 3 };
  assert.deepEqual(slotSplit(1, three, parent), { direction: 'down', from: 0, ratio: 0.3333 });
  assert.deepEqual(slotSplit(2, three, parent), { direction: 'down', from: 1, ratio: 0.5 });
});

test('grid: 2×2 launches take the three cells, the fourth goes to a tab; concurrent ones wait for the cell they split', () => {
  const parent = { pane_id: 'main', tab_id: 't', workspace_id: 'w' };
  const state = { owned: new Map(), gridHint: () => ({ cols: 2, rows: 2 }) };
  const shown = [];
  const layout = () => ({ panes: [{ pane_id: 'main' }, ...shown.map(pane_id => ({ pane_id }))] });
  const launch = (name) => {
    const r = reservePlacement(state, parent, layout(), 'auto');
    if (r.placement !== 'tab') {
      const target = r.targetPane ?? state.placed.get(r.after);
      notePlacedPane(state, r, name);
      shown.push(name);
      adoptPane(state, r, name, name);
      return [r.placement, target];
    }
    return ['tab'];
  };
  assert.deepEqual(launch('a'), ['split-right', 'main']);
  assert.deepEqual(launch('b'), ['split-down', 'a']);
  assert.deepEqual(launch('c'), ['split-right', 'b']);
  assert.deepEqual(launch('d'), ['tab']);
  // Concurrent: cell b splits a down, cell c splits b right.
  const fresh = { owned: new Map(), gridHint: () => ({ cols: 2, rows: 2 }) };
  const empty = { panes: [{ pane_id: 'main' }] };
  const first = reservePlacement(fresh, parent, empty, 'auto');
  const second = reservePlacement(fresh, parent, empty, 'auto');
  const third = reservePlacement(fresh, parent, empty, 'auto');
  assert.deepEqual([first.slot, first.targetPane], [0, 'main']);
  assert.deepEqual([second.slot, second.after, second.placement], [1, first.token, 'split-down']);
  assert.deepEqual([third.slot, third.after, third.placement], [2, second.token, 'split-right']);
});

test('grid: rearranging a wider grid appends, trims from the end, or rebuilds with common prefix', () => {
  const parent = { pane_id: 'main', tab_id: 't', workspace_id: 'w' };
  const g = { cols: 2, rows: 2 };
  const label = (id) => id;
  const summary = (steps) => steps.map((s) => `${s.paneId}:${'newTab' in s.to ? 'tab' : `${s.to.split.direction}@${s.to.split.targetPane}`}`);
  assert.deepEqual(summary(planColumn(parent, ['a', 'b'], ['a', 'b', 'c'], label, g)), ['c:right@b']);
  assert.deepEqual(summary(planColumn(parent, ['a', 'b', 'c'], ['a', 'b'], label, g)), ['c:tab']);
  // Lead 'a' is preserved: only helper slots are parked and rebuilt
  assert.deepEqual(summary(planColumn(parent, ['a', 'b', 'c'], ['a', 'd', 'e'], label, g)), [
    'c:tab', 'b:tab', 'd:down@a', 'e:right@d',
  ]);
  // One column of three: the agents in order stay, a new one is inserted below its predecessor.
  const col = { cols: 1, rows: 3 };
  assert.deepEqual(summary(planColumn(parent, ['a', 'b', 'c'], ['b', 'c', 'd'], label, col)), ['a:tab', 'd:down@c']);
  assert.deepEqual(summary(planColumn(parent, ['a', 'c'], ['a', 'b', 'c'], label, col)), ['b:down@a']);
});

test('grid: a cell below waits for the previous cell of the row above (creation in slot order)', () => {
  const parent = { pane_id: 'main', tab_id: 't', workspace_id: 'w' };
  const state = { owned: new Map(), gridHint: () => ({ cols: 2, rows: 2 }) };
  const empty = { panes: [{ pane_id: 'main' }] };
  const a = reservePlacement(state, parent, empty, 'auto');
  const b = reservePlacement(state, parent, empty, 'auto');
  const c = reservePlacement(state, parent, empty, 'auto');
  assert.equal(b.after, a.token);
  assert.equal(b.waitFor, undefined); // it splits a down: `after` already orders it
  assert.equal(c.after, b.token); // c splits b right
  assert.equal(c.waitFor, undefined);
});

test('grid: 2×2 cycle keeps lead in slot 0 and rotates the helper slots', async () => {
  const parent = { pane_id: 'main', tab_id: 't', workspace_id: 'w' };
  const state = {
    owned: new Map([['lead', 'Lead'], ['cA', 'Challenger A'], ['cB', 'Challenger B'], ['rA', 'Researcher A'], ['rB', 'Researcher B']]),
    slots: ['lead', 'cA', 'cB'],
    gridHint: () => ({ cols: 2, rows: 2 }),
  };
  let visible = ['lead', 'cA', 'cB'];
  const selector = new PaneSelector(state, (args) => {
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: args[2], workspace_id: 'w' } };
    if (args[0] === 'pane' && args[1] === 'layout') return { layout: { panes: [{ pane_id: 'main' }, ...visible.map(id => ({ pane_id: id }))] } };
    return {};
  }, () => 'main');
  const mover = async (paneId, to) => {
    if ('newTab' in to) visible = visible.filter(id => id !== paneId);
    else visible = [...visible.filter(id => id !== paneId), paneId];
  };

  const order = ['lead', 'cA', 'cB', 'rA', 'rB'];
  // Cycle 1: [cA, cB] -> [cB, rA]
  const res1 = await selector.cycle(order, mover);
  assert.equal(res1, 'rotated');
  assert.deepEqual(state.slots, ['lead', 'cB', 'rA']);

  // Cycle 2: [cB, rA] -> [rA, rB] (both researchers!)
  const res2 = await selector.cycle(order, mover);
  assert.equal(res2, 'rotated');
  assert.deepEqual(state.slots, ['lead', 'rA', 'rB']);

  // Lead is ALWAYS at index 0
  assert.equal(state.slots[0], 'lead');
});

test('grid: selecting a delegated child into its parent helper slot swaps lane; finishing promotes parent back', async () => {
  const parent = { pane_id: 'main', tab_id: 't', workspace_id: 'w' };
  const state = {
    owned: new Map([['lead', 'Lead'], ['cA', 'Challenger A'], ['cB', 'Challenger B'], ['rA', 'Researcher A']]),
    slots: ['lead', 'cA', 'cB'],
    gridHint: () => ({ cols: 2, rows: 2 }),
  };
  let visible = ['lead', 'cA', 'cB'];
  const alive = new Set(['main', 'lead', 'cA', 'cB', 'rA']);
  const selector = new PaneSelector(state, (args) => {
    if (args[0] === 'pane' && args[1] === 'get') {
      if (!alive.has(args[2])) throw { herdrCode: 'pane_not_found', message: 'not found' };
      return { pane: { pane_id: args[2], workspace_id: 'w' } };
    }
    if (args[0] === 'pane' && args[1] === 'layout') return { layout: { panes: [{ pane_id: 'main' }, ...visible.map(id => ({ pane_id: id }))] } };
    return {};
  }, () => 'main', { pollMs: 5, timeoutMs: 50 });
  const mover = async (paneId, to) => {
    if ('newTab' in to) visible = visible.filter(id => id !== paneId);
    else visible = [...visible.filter(id => id !== paneId), paneId];
  };

  // rA is selected into slot 1 (Lane 1, where cA was)
  await selector.select('rA', mover, 1);
  assert.deepEqual(state.slots, ['lead', 'rA', 'cB']);

  // rA finishes: closed in Herdr, removed from alive, forgotten from selector
  alive.delete('rA');
  visible = visible.filter(id => id !== 'rA');
  selector.forget('rA');
  assert.equal(state.vacated.length, 1);
  assert.equal(state.vacated[0].slot, 1);

  // promote restores cA back into slot 1
  const promoted = await selector.promote(state.vacated[0], mover);
  assert.equal(promoted, 'cA');
  assert.deepEqual(state.slots, ['lead', 'cA', 'cB']);
});
