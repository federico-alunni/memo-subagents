import { test } from 'node:test';
import assert from 'node:assert/strict';
import extension, { __test__ } from '../pi-extension/subagents/index.ts';
import { paneSelector, PaneSelector } from '../pi-extension/subagents/pane-selector.ts';
import { createLifecycle } from '../pi-extension/subagents/lifecycle.ts';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hermetic agent definitions: do not depend on the developer's ~/.pi/agent/agents.
const agentDir = mkdtempSync(join(tmpdir(), 'memo-subagents-agents-'));
mkdirSync(join(agentDir, 'agents'));
writeFileSync(join(agentDir, 'agents', 'worker.md'), '---\nname: worker\ndescription: Test worker\n---\nYou are a test worker.\n');
process.env.PI_CODING_AGENT_DIR = agentDir;

// Hermetic Herdr: these tests must not depend on running inside a real Herdr (CI has neither the binary nor the
// variables). A stub `herdr` on PATH and the pane variables make the extension see an interactive Herdr session.
const binDir = mkdtempSync(join(tmpdir(), 'memo-subagents-bin-'));
writeFileSync(join(binDir, 'herdr'), '#!/bin/sh\nexit 0\n');
chmodSync(join(binDir, 'herdr'), 0o755);
process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
process.env.HERDR_ENV = '1';
process.env.HERDR_PANE_ID = 'test-pane-0';

function fixture() {
  const commands = new Map();
  const shortcuts = new Map();
  const sent = [];
  extension({ on() {}, registerTool() {}, registerMessageRenderer() {}, registerCommand(name, cmd) { commands.set(name, cmd); }, registerShortcut(key, cmd) { shortcuts.set(key, cmd); }, sendUserMessage(msg) { sent.push(msg); } });
  return { commands, shortcuts, sent };
}

test('/subagent without arguments selects a live child, not a model turn or separate command', async () => {
  const f = fixture();
  const oldVisible = paneSelector.visible;
  const oldSelect = paneSelector.select;
  let selected;
  paneSelector.visible = () => ['test-pane'];
  paneSelector.select = (id) => { selected = id; };
  const child = { id: 'selector-command-test', name: 'Worker test', surface: 'test-pane', startTime: Date.now(), lifecycle: createLifecycle(Date.now()) };
  __test__.runningSubagents.set(child.id, child);
  try {
    assert.ok(!f.commands.has('subagent-view'));
    let title;
    await f.commands.get('subagent').handler('', { mode: 'tui', ui: { select: async (t, labels) => { title = t; return labels[0]; }, notify() {} } });
    assert.match(title, /Subagents/);
    assert.equal(selected, child.surface);
    assert.equal(f.sent.length, 0);
    assert.ok(f.shortcuts.has('ctrl+alt+x'));
  } finally {
    paneSelector.visible = oldVisible;
    paneSelector.select = oldSelect;
    __test__.runningSubagents.delete(child.id);
    paneSelector.forget(child.surface);
  }
});

test('/subagent <profile> <task> preserves the existing spawn behavior', async () => {
  const f = fixture();
  await f.commands.get('subagent').handler('worker Check the code', { ui: { notify(message) { throw new Error(message); } } });
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /Use subagent with agent: "worker"/);
  assert.match(f.sent[0], /Check the code/);
});

test('an agent completing while the menu is open is not moved or relaunched', async () => {
  const f = fixture();
  const oldVisible = paneSelector.visible;
  const oldSelect = paneSelector.select;
  const child = { id: 'completion-race-test', name: 'Finishing', surface: 'finished-pane', startTime: Date.now(), lifecycle: createLifecycle(Date.now()) };
  let moved = false;
  const notices = [];
  paneSelector.visible = () => [];
  paneSelector.select = () => { moved = true; };
  __test__.runningSubagents.set(child.id, child);
  try {
    await f.commands.get('subagent').handler('', { mode: 'tui', ui: { select: async (_, labels) => { __test__.runningSubagents.delete(child.id); return labels[0]; }, notify(message) { notices.push(message); } } });
    assert.equal(moved, false);
    assert.equal(f.sent.length, 0);
    assert.match(notices[0], /already finished/);
  } finally {
    paneSelector.visible = oldVisible;
    paneSelector.select = oldSelect;
    __test__.runningSubagents.delete(child.id);
  }
});

test('Ctrl+Alt+X rotates the column over the open agents in menu order, without a menu', async () => {
  const f = fixture();
  const oldCycle = paneSelector.cycle;
  const a = { id: 'cycle-test-a', name: 'Cycle A', surface: 'cycle-pane-a', startTime: Date.now(), lifecycle: createLifecycle(Date.now()) };
  const b = { id: 'cycle-test-b', name: 'Cycle B', surface: 'cycle-pane-b', startTime: Date.now(), lifecycle: createLifecycle(Date.now()) };
  const orders = [];
  const notices = [];
  let result = 'swapped';
  paneSelector.cycle = async (order) => { orders.push(order); return result; };
  __test__.runningSubagents.set(a.id, a);
  __test__.runningSubagents.set(b.id, b);
  const ctx = { mode: 'tui', ui: { select: async () => { throw new Error('no menu expected'); }, notify(message) { notices.push(message); } } };
  try {
    const cycle = f.shortcuts.get('ctrl+alt+x').handler;
    await cycle(ctx);
    assert.deepEqual(orders, [[a.surface, b.surface]]);
    assert.ok(paneSelector.state.owned.has(a.surface) && paneSelector.state.owned.has(b.surface));
    assert.deepEqual(notices, []);
    __test__.runningSubagents.delete(b.id);
    result = 'only';
    await cycle(ctx);
    assert.deepEqual(orders[1], [a.surface]);
    assert.match(notices[0], /Cycle A .* is the only open agent/);
    assert.equal(f.sent.length, 0);
  } finally {
    paneSelector.cycle = oldCycle;
    __test__.runningSubagents.delete(a.id);
    __test__.runningSubagents.delete(b.id);
    paneSelector.forget(a.surface);
    paneSelector.forget(b.surface);
  }
});

test('the /subagent menu marks both shown agents with ▶', async () => {
  const f = fixture();
  const oldVisible = paneSelector.visible;
  const oldSelect = paneSelector.select;
  const agents = ['a', 'b', 'c'].map((key) => ({ id: `menu-test-${key}`, name: `Menu ${key}`, surface: `menu-pane-${key}`, startTime: Date.now(), lifecycle: createLifecycle(Date.now()) }));
  paneSelector.visible = () => [agents[0].surface, agents[1].surface];
  let selected;
  paneSelector.select = (id) => { selected = id; };
  for (const agent of agents) __test__.runningSubagents.set(agent.id, agent);
  try {
    let shown;
    await f.commands.get('subagent').handler('', { mode: 'tui', ui: { select: async (_, labels) => { shown = labels; return labels[2]; }, notify() {} } });
    assert.deepEqual(shown.map((label) => label.startsWith('▶ ')), [true, true, false]);
    assert.equal(selected, agents[2].surface);
  } finally {
    paneSelector.visible = oldVisible;
    paneSelector.select = oldSelect;
    for (const agent of agents) {
      __test__.runningSubagents.delete(agent.id);
      paneSelector.forget(agent.surface);
    }
  }
});

test('shown subagent finishes: the next one in menu order is promoted into its slot and its handle synced', async () => {
  fixture();
  const state = paneSelector.state;
  const a = { id: 'promote-test-a', name: 'Promote A', surface: 'promote-pane-a', startTime: Date.now(), lifecycle: createLifecycle(Date.now()), handle: { paneId: 'promote-pane-a', protocolDir: '/tmp/pa', taskToken: 'ta', tabId: 'main', workspaceId: 'w1' } };
  const b = { id: 'promote-test-b', name: 'Promote B', surface: 'promote-pane-b', startTime: Date.now(), lifecycle: createLifecycle(Date.now()), handle: { paneId: 'promote-pane-b', protocolDir: '/tmp/pb', taskToken: 'tb', tabId: 'bg', workspaceId: 'w1' } };
  const c = { id: 'promote-test-c', name: 'Promote C', surface: 'promote-pane-c', startTime: Date.now(), lifecycle: createLifecycle(Date.now()), handle: { paneId: 'promote-pane-c', protocolDir: '/tmp/pc', taskToken: 'tc', tabId: 'bg2', workspaceId: 'w1' } };
  const panes = new Map([
    ['main', { pane_id: 'main', tab_id: 'main', workspace_id: 'w1' }],
    [a.surface, { pane_id: a.surface, tab_id: 'main', workspace_id: 'w1' }],
    [b.surface, { pane_id: b.surface, tab_id: 'bg', workspace_id: 'w1' }],
    [c.surface, { pane_id: c.surface, tab_id: 'bg2', workspace_id: 'w1' }],
  ]);
  const view = new PaneSelector(state, (args) => {
    if (args[1] === 'get') { const pane = panes.get(args[2]); if (!pane) throw new Error('pane_not_found'); return { pane }; }
    if (args[1] === 'layout') return { layout: { panes: [...panes.values()].filter(p => p.tab_id === 'main') } };
    throw new Error(`direct Herdr call not expected: ${args.join(' ')}`);
  }, () => 'main', { pollMs: 5, timeoutMs: 500 });
  for (const agent of [a, b, c]) {
    __test__.runningSubagents.set(agent.id, agent);
    state.owned.set(agent.surface, agent.name);
    state.controls.set(agent.surface, {
      handle: agent.handle,
      move: async (h, to) => { panes.get(h.paneId).tab_id = to.split.tab; return { ...h, tabId: to.split.tab }; },
    });
  }
  state.slots = [a.surface];
  try {
    // The runtime forgets the finished agent (still listed in the menu), then closes its pane.
    paneSelector.forget(a.surface);
    panes.delete(a.surface);
    await view.promoteVacated();
    assert.deepEqual(state.slots, [b.surface]);
    assert.equal(panes.get(b.surface).tab_id, 'main');
    assert.equal(panes.get(c.surface).tab_id, 'bg2');
    assert.equal(b.handle.tabId, 'main'); // syncSelectorHandles ran after the promotion.
  } finally {
    state.onVacated = () => { void paneSelector.promoteVacated(); };
    for (const agent of [a, b, c]) {
      __test__.runningSubagents.delete(agent.id);
      state.owned.delete(agent.surface);
      state.controls.delete(agent.surface);
    }
    state.slots = [];
  }
});
