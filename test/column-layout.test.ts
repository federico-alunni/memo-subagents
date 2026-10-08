import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyColumnLayout,
  columnSplitTargets,
  nextColumnSplit,
  orderColumn,
  planColumnResize,
} from "../pi-extension/subagents/runtime/column-layout.ts";
import type { PaneLayoutSnapshot } from "../pi-extension/subagents/runtime/column-layout.ts";

// Layouts captured from Herdr 0.9.3 (`pane layout`): a right column of height 35 at x=70, width 69.
const pane = (pane_id: string, y: number, height: number, x = 70, width = 69) => ({ pane_id, rect: { x, y, width, height } });
const split = (id: string, ratio: number, y: number, height: number, direction = "down", x = 70, width = 69) => ({ id, direction, ratio, rect: { x, y, width, height } });

test("targets: the root keeps its share, the other members split the rest equally", () => {
  assert.deepEqual(columnSplitTargets(1, true), []);
  assert.deepEqual(columnSplitTargets(2, true), [0.5]);
  assert.deepEqual(columnSplitTargets(3, true), [0.5, 0.5]);
  const four = columnSplitTargets(4, true);
  assert.equal(four[0], 0.5);
  assert.ok(Math.abs(four[1] - 1 / 3) < 1e-9);
  assert.equal(four[2], 0.5);
  // Without a root (it ended): everybody equal.
  const equal = columnSplitTargets(3, false);
  assert.ok(Math.abs(equal[0] - 1 / 3) < 1e-9);
  assert.equal(equal[1], 0.5);
});

test("order: column members top to bottom, foreign panes and other columns ignored", () => {
  const layout: PaneLayoutSnapshot = {
    panes: [pane("main", 0, 35, 0, 70), pane("c2", 22, 13), pane("planner", 0, 18), pane("c1", 18, 4)],
    splits: [],
  };
  assert.deepEqual(orderColumn(["c2", "planner", "c1", "gone"], layout), ["planner", "c1", "c2"]);
});

test("next member: half of the bottom-most member", () => {
  assert.deepEqual(nextColumnSplit(["planner"]), { target: "planner", ratio: 0.5 });
  assert.deepEqual(nextColumnSplit(["planner", "c1", "c2"]), { target: "c2", ratio: 0.5 });
  assert.equal(nextColumnSplit([]), undefined);
});

test("resize plan: grow the upper member down, or the lower member up, by the ratio difference", () => {
  // planner 18 | c1 4 | c2 13 (the probe's state after `split c1 --ratio 0.25`).
  const layout: PaneLayoutSnapshot = {
    panes: [pane("main", 0, 35, 0, 70), pane("planner", 0, 18), pane("c1", 18, 4), pane("c2", 22, 13)],
    splits: [
      split("root", 0.5, 0, 35, "right", 0, 139),
      split("s1", 0.5, 0, 35),
      split("s2", 0.25, 18, 17),
    ],
  };
  const ops = planColumnResize(["planner", "c1", "c2"], layout, true);
  // planner/rest already 0.5; c1/c2 must go 0.25 -> 0.5: c1 grows down by 0.25.
  assert.deepEqual(ops, [{ pane: "c1", direction: "down", amount: 0.25 }]);

  const tooBig: PaneLayoutSnapshot = { ...layout, splits: [layout.splits[0], split("s1", 0.7, 0, 35), split("s2", 0.5, 25, 10)] };
  const shrink = planColumnResize(["planner", "c1", "c2"], {
    panes: [pane("main", 0, 35, 0, 70), pane("planner", 0, 25), pane("c1", 25, 5), pane("c2", 30, 5)],
    splits: tooBig.splits,
  }, true);
  // planner too big: the member below it grows up by 0.2.
  assert.equal(shrink.length, 1);
  assert.equal(shrink[0].pane, "c1");
  assert.equal(shrink[0].direction, "up");
  assert.ok(Math.abs(shrink[0].amount - 0.2) < 1e-9);
});

test("resize plan: nothing within tolerance, nothing when the chain is not ours", () => {
  const balanced: PaneLayoutSnapshot = {
    panes: [pane("planner", 0, 18), pane("c1", 18, 9), pane("c2", 27, 8)],
    splits: [split("s1", 0.5, 0, 35), split("s2", 0.51, 18, 17)],
  };
  assert.deepEqual(planColumnResize(["planner", "c1", "c2"], balanced, true), []);
  // A foreign split inside the column (different rect): that split is left alone.
  const foreign: PaneLayoutSnapshot = {
    panes: [pane("planner", 0, 18), pane("c1", 18, 9), pane("c2", 27, 8)],
    splits: [split("s1", 0.5, 0, 35), split("other", 0.25, 18, 12)],
  };
  assert.deepEqual(planColumnResize(["planner", "c1", "c2"], foreign, true), []);
  assert.deepEqual(planColumnResize(["planner"], balanced, true), []);
});

test("executor: reads the layout once and applies the planned resizes in order", async () => {
  const calls: string[][] = [];
  const layout: PaneLayoutSnapshot = {
    panes: [pane("planner", 0, 18), pane("c1", 18, 4), pane("c2", 22, 13)],
    splits: [split("s1", 0.5, 0, 35), split("s2", 0.25, 18, 17)],
  };
  await applyColumnLayout(["c2", "planner", "c1"], "planner", async (args) => {
    calls.push(args);
    if (args[1] === "layout") return { layout };
    return {};
  });
  assert.deepEqual(calls, [
    ["pane", "layout", "--pane", "c2"],
    ["pane", "resize", "--pane", "c1", "--direction", "down", "--amount", "0.25"],
  ]);
  // A failing Herdr never throws out of the executor (layout is cosmetic).
  await applyColumnLayout(["a", "b"], "a", async () => { throw new Error("herdr down"); });
});
