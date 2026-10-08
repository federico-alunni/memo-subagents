// Real Herdr + real agent runtime, no model calls. Creates two workspaces of its own (a "main" and a
// "worker" that prints a fake pi screen), opens a mirror viewer for the worker beside the main pane
// and checks: layout, focus never stolen, crop, repaint, resize, header follow, promotion across
// workspaces, orderly close, and that the worker pane is never touched. Removes only what it created.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntime } from '../pi-extension/subagents/runtime/index.ts';
import { MirrorManager } from '../pi-extension/subagents/runtime/mirror-manager.ts';
import { stripAnsi } from '../pi-extension/subagents/runtime/mirror-view.ts';

const herdr = (args) => {
  const response = JSON.parse(execFileSync('herdr', args, { encoding: 'utf8' }));
  if (response.error) throw new Error(response.error.message);
  return response.result;
};
const text = (pane) => execFileSync('herdr', ['pane', 'read', pane, '--source', 'visible', '--format', 'text'], { encoding: 'utf8' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (what, fn, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(250);
  }
};
const bar = '─'.repeat(60);
// A stand-in for a pi child: chat output, the two editor borders around an input row, a footer.
const fakePi = `i=0; while :; do i=$((i+1)); clear; echo "work line $i"; echo "tool output"; echo "${bar}"; echo "> typed input"; echo "${bar}"; echo "~/repo (memo/live-1)"; echo "↑1k ↓2k \\$0.01"; sleep 1; done`;

const owned = [];
const dir = mkdtempSync(join(tmpdir(), 'mirror-live-'));
// Runtime state must live outside every child cwd (as in the package: $TMPDIR/pi-memo-subagents-<uid>).
const stateDir = mkdtempSync(join(tmpdir(), 'mirror-live-state-'));
// `pane current` follows HERDR_PANE_ID (changed below), so the user's focus is read from the workspace list.
const focusedWorkspaces = () => herdr(['workspace', 'list']).workspaces.filter((w) => w.focused).map((w) => w.workspace_id).join(',');
const focusedBefore = focusedWorkspaces();
const focusedBeforePane = process.env.HERDR_PANE_ID;
let manager;
try {
  const main = herdr(['workspace', 'create', '--label', 'mirror-live-main-owned', '--cwd', dir, '--no-focus']);
  owned.push(main.workspace.workspace_id);
  const worker = herdr(['workspace', 'create', '--label', 'mirror-live-worker-owned', '--cwd', dir, '--no-focus']);
  owned.push(worker.workspace.workspace_id);
  const worker2 = herdr(['workspace', 'create', '--label', 'mirror-live-worker2-owned', '--cwd', dir, '--no-focus']);
  owned.push(worker2.workspace.workspace_id);
  const mainPane = main.root_pane.pane_id;
  const workerPane = worker.root_pane.pane_id;
  const workerPane2 = worker2.root_pane.pane_id;
  await sleep(1500);
  execFileSync('herdr', ['pane', 'run', workerPane, fakePi], { stdio: 'ignore' });
  execFileSync('herdr', ['pane', 'run', workerPane2, fakePi], { stdio: 'ignore' });
  await until('worker screen', () => text(workerPane).includes('work line'));
  await until('worker2 screen', () => text(workerPane2).includes('work line'));

  // The runtime asks Herdr for "the current pane": make that the main workspace's pane.
  process.env.HERDR_PANE_ID = mainPane;
  const selector = { owned: new Map() };
  const runtime = new AgentRuntime({ stateDir: stateDir, selector, startupTimeoutMs: 60000, shellReadyTimeoutMs: 30000 });
  const processIdentity = (pid) => execFileSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' }).trim();
  manager = new MirrorManager({
    runtime,
    stateDir: stateDir,
    viewerScript: new URL('../pi-extension/subagents/runtime/mirror-viewer.ts', import.meta.url).pathname,
    cwd: dir,
    owner: { pid: process.pid, identity: processIdentity(process.pid) },
    ownerAlive: async (owner) => { try { return processIdentity(owner.pid) === owner.identity; } catch { return false; } },
  });
  const slot = (patch = {}) => ({
    slotId: 'live-slot',
    view: { version: 1, paneId: workerPane, name: 'fix-lock', agent: 'worker', branch: 'memo/live-1', startedAt: Date.now(), status: 'active', ...patch },
  });

  // 1. open: one split beside the main pane, focus not stolen
  await manager.sync([slot()]);
  const mirror = manager.paneFor('live-slot');
  assert.ok(mirror, 'mirror pane opened');
  let layout = herdr(['pane', 'layout', '--pane', mainPane]).layout;
  assert.equal(layout.panes.length, 2, 'main pane + mirror');
  assert.equal(focusedWorkspaces(), focusedBefore, 'focus not stolen');
  assert.equal(selector.owned.get(mirror)?.startsWith('⧉ fix-lock'), true, 'mirror is owned by the selector');
  assert.equal(selector.selected, mirror, 'mirror took the reserved split');

  // 2. content: header, cropped chat bar, footer, repainted as the worker changes
  const first = await until('mirror content', () => { const t = text(mirror); return t.includes('work line') && t.includes('╭─') ? t : undefined; });
  assert.match(first, /fix-lock/);
  assert.match(first, /⎇ memo\/live-1/);
  assert.ok(!first.includes('> typed input'), 'the input row is not mirrored');
  assert.ok(first.includes('~/repo (memo/live-1)'), 'footer kept');
  const n1 = Number(first.match(/work line (\d+)/)[1]);
  const n2 = await until('repaint', () => { const m = text(mirror).match(/work line (\d+)/); return m && Number(m[1]) > n1 ? Number(m[1]) : undefined; });
  assert.ok(n2 > n1, 'the mirror follows the worker');

  // 3. the view follows the slot (handoff: another agent, same pane here)
  await manager.sync([slot({ agent: 'reviewer' })]);
  await until('header follows the active agent', () => /\│ reviewer/.test(text(mirror)));

  // 3b. multi-pane stacked column: adding a second worker divides the column into balanced stacked boxes
  const slot2 = (patch = {}) => ({
    slotId: 'live-slot-2',
    view: { version: 1, paneId: workerPane2, name: 'feat-api', agent: 'tester', branch: 'memo/live-2', startedAt: Date.now(), status: 'active', ...patch },
  });
  await manager.sync([slot({ agent: 'reviewer' }), slot2()]);
  assert.equal(manager.paneFor('live-slot'), mirror);
  assert.equal(manager.paneFor('live-slot-2'), mirror);
  await until('both workers visible in stacked column', () => {
    const t = text(mirror);
    return t.includes('fix-lock') && t.includes('feat-api') ? t : undefined;
  });
  // Drop slot2: column returns to single box taking full height
  await manager.sync([slot()]);
  await until('column returns to single worker', () => {
    const t = text(mirror);
    return t.includes('fix-lock') && !t.includes('feat-api') ? t : undefined;
  });

  // 4. resize: Herdr adjusts the split layout and the mirror stays valid
  const rectWidth = () => herdr(['pane', 'layout', '--pane', mainPane]).layout.panes.find((p) => p.pane_id === mirror)?.rect?.width;
  const rectBefore = rectWidth();
  herdr(['pane', 'resize', '--pane', mirror, '--direction', 'left', '--amount', '0.15']);
  const rectAfter = await until('layout rect updated', () => { const w = rectWidth(); return w && w !== rectBefore ? w : undefined; });
  assert.notEqual(rectAfter, rectBefore, 'split ratio changed');

  // 5. read-only: keys typed into the mirror never reach the worker
  const before = text(workerPane);
  execFileSync('herdr', ['pane', 'send-text', mirror, 'echo SHOULD-NOT-APPEAR'], { stdio: 'ignore' });
  await sleep(2500);
  assert.ok(!text(workerPane).includes('SHOULD-NOT-APPEAR'), 'no input reaches the worker');
  assert.ok(!text(mirror).includes('SHOULD-NOT-APPEAR'), 'the mirror ignores input');
  void before;

  // 6. promotion across workspaces: agent focus (verified, not assumed)
  // The stand-in worker is a shell, so Herdr detects no agent there ("agent_not_found"): this is the
  // fallback path (workspace + tab). With a real pi in the pane, `herdr agent focus` itself crosses workspaces.
  let promoted = 'ok';
  try { herdr(['agent', 'focus', workerPane]); } catch {
    const target = herdr(['pane', 'get', workerPane]).pane;
    herdr(['workspace', 'focus', target.workspace_id]);
    herdr(['tab', 'focus', target.tab_id]);
    promoted = 'ok (workspace + tab fallback)';
  }
  console.log(`promotion of a pane in another workspace: ${promoted}`);
  const workspaces = herdr(['workspace', 'list']).workspaces ?? [];
  console.log('focused workspace after promotion:', workspaces.filter((w) => w.focused).map((w) => w.label ?? w.workspace_id).join(', ') || 'unknown', '(worker workspace:', worker.workspace.workspace_id + ')');
  assert.equal(focusedWorkspaces(), worker.workspace.workspace_id, 'agent focus moved the view to the worker workspace');
  if (focusedBefore) herdr(['workspace', 'focus', focusedBefore]); // give the view back

  // 7. close: orderly stop + close, split gone, worker untouched
  // As the widget tick does: the end is proven by the runtime (exact exit, then pane gone); an exiting
  // process is briefly a zombie whose identity differs, so the close is retried on the next sync.
  await until('mirror closed in order', async () => { await manager.sync([]); return manager.paneFor('live-slot') === undefined; }, 15000);
  assert.equal(manager.paneFor('live-slot'), undefined);
  layout = herdr(['pane', 'layout', '--pane', mainPane]).layout;
  assert.equal(layout.panes.length, 1, 'split closed, column rebalanced');
  assert.ok(text(workerPane).includes('work line'), 'the worker pane was never touched');
  assert.equal(selector.owned.size, 0);
  console.log('PASS: mirror opened beside the main pane, cropped, repainted, resized, read-only, closed in order; worker untouched, focus kept.');
  assert.equal(focusedWorkspaces(), focusedBefore, 'the view was given back');
} finally {
  try { await manager?.closeAll(); } catch { /* best effort */ }
  for (const workspace of owned) { try { herdr(['workspace', 'close', workspace]); console.log(`Removed owned test workspace ${workspace}`); } catch { /* already gone */ } }
  rmSync(dir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
}
