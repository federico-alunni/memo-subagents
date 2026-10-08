import { test } from 'node:test';
import assert from 'node:assert/strict';
import extension, { __test__ } from '../pi-extension/subagents/index.ts';
import { paneSelector } from '../pi-extension/subagents/pane-selector.ts';
import { createLifecycle } from '../pi-extension/subagents/lifecycle.ts';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hermetic agent definitions: do not depend on the developer's ~/.pi/agent/agents.
const agentDir = mkdtempSync(join(tmpdir(), 'memo-subagents-agents-'));
mkdirSync(join(agentDir, 'agents'));
writeFileSync(join(agentDir, 'agents', 'worker.md'), '---\nname: worker\ndescription: Test worker\n---\nYou are a test worker.\n');
process.env.PI_CODING_AGENT_DIR = agentDir;

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
  paneSelector.visible = () => 'test-pane';
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
  paneSelector.visible = () => undefined;
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

test('Ctrl+Alt+X cycles to the next open agent without a menu', async () => {
  const f = fixture();
  const oldVisible = paneSelector.visible;
  const oldSelect = paneSelector.select;
  const a = { id: 'cycle-test-a', name: 'Cycle A', surface: 'cycle-pane-a', startTime: Date.now(), lifecycle: createLifecycle(Date.now()) };
  const b = { id: 'cycle-test-b', name: 'Cycle B', surface: 'cycle-pane-b', startTime: Date.now(), lifecycle: createLifecycle(Date.now()) };
  let visible;
  const selected = [];
  paneSelector.visible = () => visible;
  paneSelector.select = (id) => { selected.push(id); visible = id; };
  __test__.runningSubagents.set(a.id, a);
  __test__.runningSubagents.set(b.id, b);
  const ctx = { mode: 'tui', ui: { select: async () => { throw new Error('no menu expected'); }, notify(message) { throw new Error(message); } } };
  try {
    const cycle = f.shortcuts.get('ctrl+alt+x').handler;
    await cycle(ctx);
    await cycle(ctx);
    await cycle(ctx);
    assert.deepEqual(selected, [a.surface, b.surface, a.surface]);
    assert.equal(f.sent.length, 0);
  } finally {
    paneSelector.visible = oldVisible;
    paneSelector.select = oldSelect;
    __test__.runningSubagents.delete(a.id);
    __test__.runningSubagents.delete(b.id);
    paneSelector.forget(a.surface);
    paneSelector.forget(b.surface);
  }
});
