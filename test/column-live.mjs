// Real Herdr, shell panes only (no agents, no model calls): a column of panes under a root, built the way
// delegated spawns build it (split the bottom member in half, then rebalance) and rebalanced after closes.
// Creates and removes only its own workspace.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { applyColumnLayout, nextColumnSplit, orderColumn } from '../pi-extension/subagents/runtime/column-layout.ts';

const herdr = (args) => {
  const response = JSON.parse(execFileSync('herdr', args, { encoding: 'utf8' }));
  if (response.error) throw new Error(response.error.message);
  return response.result;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const layout = (pane) => herdr(['pane', 'layout', '--pane', pane]).layout;
const heights = (members, pane) => {
  const l = layout(pane);
  return orderColumn(members, l).map((id) => l.panes.find((p) => p.pane_id === id).rect.height);
};
/** Root keeps half (±1 row), the others are equal (±1 row). */
const assertShape = (label, members, root, pane) => {
  const h = heights(members, pane);
  const total = h.reduce((a, b) => a + b, 0);
  const rest = root ? h.slice(1) : h;
  if (root && h.length > 1) assert.ok(Math.abs(h[0] - total / 2) <= 1, `${label}: root keeps half (${h})`);
  assert.ok(Math.max(...rest) - Math.min(...rest) <= 1, `${label}: members equal (${h})`);
  console.log(`${label}: ${h.join(' | ')}`);
};

const ws = herdr(['workspace', 'create', '--label', 'column-live-owned', '--cwd', '/tmp', '--no-focus']);
const workspace = ws.workspace.workspace_id;
try {
  await sleep(1000);
  const main = ws.root_pane.pane_id;
  const root = herdr(['pane', 'split', main, '--direction', 'right', '--cwd', '/tmp', '--no-focus']).pane.pane_id;
  const members = [root];
  const add = async () => {
    const next = nextColumnSplit(orderColumn(members, layout(root)));
    const pane = herdr(['pane', 'split', next.target, '--direction', 'down', '--ratio', String(next.ratio), '--cwd', '/tmp', '--no-focus']).pane.pane_id;
    members.push(pane);
    await applyColumnLayout(members, root, herdr);
    return pane;
  };
  const research = await add();
  assertShape('planner + research', members, root, root);
  const challengerA = await add();
  assertShape('+ challenger A', members, root, root);
  await add();
  assertShape('+ challenger B', members, root, root);
  await add();
  assertShape('+ researcher A', members, root, root);

  // A member in the middle ends: Herdr gives its space back, the rebalance evens the rest.
  herdr(['pane', 'close', challengerA]);
  members.splice(members.indexOf(challengerA), 1);
  await sleep(300);
  await applyColumnLayout(members, root, herdr);
  assertShape('challenger A closed', members, root, root);

  // The root ends first: the members share the column equally.
  herdr(['pane', 'close', root]);
  members.splice(0, 1);
  await sleep(300);
  await applyColumnLayout(members, root, herdr);
  assertShape('root closed', members, undefined, research);
  console.log('PASS: column built, rebalanced after adds and closes (root half, members equal), only owned panes touched.');
} finally {
  herdr(['workspace', 'close', workspace]);
  console.log(`Removed owned test workspace ${workspace}`);
}
