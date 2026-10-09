import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSlotPanelData, isPanelData, markSelected, renderPanel } from "../pi-extension/subagents/runtime/panel.ts";
import type { PanelData } from "../pi-extension/subagents/runtime/panel.ts";
import { paletteTheme, stripAnsi, visibleWidth } from "../pi-extension/subagents/runtime/mirror-view.ts";
import type { MirrorTheme } from "../pi-extension/subagents/runtime/mirror-view.ts";

const golden = (scenario: number, width: number) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/panel/golden-${scenario}-w${width}.txt`, import.meta.url)), "utf8").trimEnd();

const C = { accent: "\x1b[38;2;235;203;139m", success: "\x1b[38;2;135;191;208m", error: "\x1b[38;2;190;97;106m", warning: "\x1b[38;2;235;203;139m", muted: "\x1b[38;2;79;79;79m", text: "\x1b[38;2;255;255;255m", dim: "\x1b[2m" };
const theme: MirrorTheme = paletteTheme(C);

// A staged workflow as a consumer would describe it: brand, stage columns, legend extras.
const STAGED = {
  icon: "⛟",
  label: "Pipeline",
  columns: [
    { key: "build", header: "B", legend: "build" },
    { key: "simplify", header: "S", legend: "simplify" },
    { key: "review", header: "R", legend: "review" },
    { key: "correction", header: "C", legend: "correction", width: 2 },
    { key: "checkpoint", header: "☑", legend: "checkpoint", glyphs: { done: "☑", pending: "☐" } },
  ],
  legend: [{ mark: "●", color: "error" as const, label: "stallo" }],
} satisfies Partial<PanelData>;

const marks = (build: string, simplify: string, review: string, checkpoint: boolean, correction?: number) => ({
  build, simplify, review,
  checkpoint: checkpoint ? "done" : "pending",
  ...(correction ? { correction: { text: `↺${correction}`, color: "warning" } } : {}),
}) as PanelData["items"] extends (infer _)[] | undefined ? any : never;

const SCENARIO_1: PanelData = {
  ...STAGED,
  title: "panel-refresh",
  phase: "pianificazione",
  done: 0,
  total: 6,
  rows: [
    { icon: "?", iconColor: "warning", label: "planner", text: "aspetta una tua risposta" },
    { icon: "✓", iconColor: "success", label: "research", text: "2 ricerche su 2 completate" },
    { icon: "◐", iconColor: "accent", label: "challenger", text: "critica il piano", extra: "secondo giro di revisione" },
  ],
};

const SCENARIO_2: PanelData = {
  ...STAGED,
  title: "panel-refresh",
  phase: "foundation",
  done: 2,
  total: 6,
  groups: [
    {
      name: "foundation",
      status: "active",
      items: [
        { id: "t1", name: "fix-core-lock", dot: "success", marks: marks("done", "done", "done", true) },
        { id: "t2", name: "feat-run-control", dot: "accent", marks: marks("done", "done", "active", false) },
        { id: "t3", name: "chore-pr-automation", dot: "error", marks: marks("done", "active", "pending", false), flag: "⚠12m" },
        { id: "t4", name: "feat-plan-view", dot: "success", marks: marks("done", "done", "done", true) },
      ],
    },
    {
      name: "runtime",
      status: "queued",
      items: [
        { id: "t5", name: "feat-planner-core", dot: "warning", marks: marks("done", "done", "done", false, 2) },
        { id: "t6", name: "docs-panel", dot: "muted", marks: marks("pending", "pending", "pending", false) },
      ],
    },
  ],
};

const SCENARIO_3: PanelData = {
  ...STAGED,
  title: "panel-refresh",
  phase: "foundation",
  done: 2,
  total: 6,
  compact: true,
  items: [
    { id: "t2", name: "feat-run-control", dot: "accent", marks: marks("done", "done", "active", false) },
    { id: "t3", name: "chore-pr-automation", dot: "error", marks: marks("done", "active", "pending", false), flag: "⚠12m" },
  ],
};

for (const width of [96, 140]) {
  for (const [n, label, data] of [[1, "free rows", SCENARIO_1], [2, "staged groups", SCENARIO_2], [3, "compact", SCENARIO_3]] as const) {
    test(`golden scenario ${n} (${label}) at W=${width}`, () => {
      const lines = renderPanel(data, width, theme);
      assert.equal(lines.map(stripAnsi).join("\n"), golden(n, width));
      for (const line of lines) assert.equal(visibleWidth(stripAnsi(line)), width);
    });
  }
}

test("theme tokens: border, progress, column glyphs and flag colors", () => {
  const lines = renderPanel(SCENARIO_2, 96, theme);
  assert.ok(lines[0].startsWith(C.accent + "╭─"));
  assert.ok(lines[0].includes(C.success + "▰"));
  assert.ok(lines[0].includes(C.muted + "▱"));
  assert.ok(lines[3].includes(C.success + "☑"));
  assert.ok(lines[3].includes(C.muted + "☐"));
  assert.ok(lines[4].includes(C.error + "⚠12m"));
});

test("selection marker ▸ sits in the free cell before the dot and keeps alignment", () => {
  const selected = markSelected(
    { ...SCENARIO_2, groups: [{ ...SCENARIO_2.groups![0], items: SCENARIO_2.groups![0].items.map((item, i) => ({ ...item, subagent: `w${i}` })) }] },
    "w0",
  );
  const before = renderPanel(SCENARIO_2, 96, theme);
  const after = renderPanel(selected, 96, theme);
  assert.ok(after[3].includes(C.accent + "▸"));
  assert.equal(stripAnsi(after[3]).length, stripAnsi(before[3]).length);
  assert.equal(selected.groups![0].items.filter((item) => item.selected).length, 1);
});

test("a flag starting with ? (waiting for an answer) is bold warning", () => {
  const data: PanelData = { ...SCENARIO_3, items: [{ ...SCENARIO_3.items![0], flag: "?40s" }, SCENARIO_3.items![1]] };
  const lines = renderPanel(data, 96, theme);
  assert.equal(visibleWidth(stripAnsi(lines[1])), 96);
  assert.ok(lines[1].includes("?40s"));
  assert.ok(lines[1].includes(C.warning));
});

test("detail row under the grid with a right-aligned hint", () => {
  const lines = renderPanel({ ...SCENARIO_2, detail: { branch: "memo/fix-core-lock-1a2b", status: "active · test 00:15" }, hint: "/subagent · Ctrl+Alt+X" }, 96, theme);
  const detail = stripAnsi(lines.at(-1)!);
  assert.equal(visibleWidth(detail), 96);
  assert.ok(detail.includes("⎇ memo/fix-core-lock-1a2b"));
  assert.ok(detail.includes("active · test 00:15"));
  assert.ok(detail.endsWith("/subagent · Ctrl+Alt+X │"));
});

test("defaults: generic brand, no progress without a total, free text without columns", () => {
  const lines = renderPanel({ groups: [{ name: "workers", status: "active", items: [{ id: "a", name: "worker-1", dot: "accent", text: "builder › reviewer" }] }] }, 96, theme);
  const plain = lines.map(stripAnsi);
  assert.match(plain[0], /^╭─ ⧉  Subagents ─+─╮$/);
  assert.equal(plain.length, 3); // no legend without columns
  assert.match(plain[1], /▾ workers ● attiva/);
  assert.match(plain[2], /● worker-1\s+builder › reviewer/);
  for (const line of plain) assert.equal(visibleWidth(line), 96);
});

test("isPanelData accepts panel shapes and rejects others", () => {
  assert.ok(isPanelData({}));
  assert.ok(isPanelData(SCENARIO_2));
  assert.ok(!isPanelData(null));
  assert.ok(!isPanelData("x"));
  assert.ok(!isPanelData({ groups: "x" }));
});

test("buildSlotPanelData: one item per worktree slot with dot, flag, chain and detail", () => {
  const lifecycle = (turn: any) => ({ turn, pane: { kind: "present" }, process: { kind: "running", startedAt: 1000, confirmedAt: 1000 }, hasWorked: true });
  const a1 = { id: "a1", name: "fix-core-lock", agent: "builder", startTime: 1000, slot: { id: "s1", name: "fix-core-lock", chain: ["builder", "reviewer"], worktree: { branch: "memo/fix" } }, lifecycle: lifecycle({ kind: "active", startedAt: 1000 }) };
  const a2 = { id: "a2", name: "chore-pr", startTime: 2000, slot: { id: "s2", name: "chore-pr", chain: ["chore-pr"], worktree: { branch: "memo/pr" } }, lifecycle: lifecycle({ kind: "blocked", startedAt: 2000, stateDurationSince: 2000 }) };
  const data = buildSlotPanelData([a1, a2], "s2", 5000);
  const items = data.groups![0].items;
  assert.equal(data.total, 2);
  assert.deepEqual(items.map((item) => [item.name, item.dot, item.flag, item.selected]), [["fix-core-lock", "accent", undefined, false], ["chore-pr", "warning", "?3s", true]]);
  assert.equal(items[0].text, "builder › reviewer");
  assert.equal(data.detail?.branch, "memo/pr");
  for (const line of renderPanel(data, 96, theme)) assert.equal(visibleWidth(stripAnsi(line)), 96);
});

describe("widget surfaces and supplied panels", () => {
  const worker = {
    id: "a1", name: "worker-1", startTime: 1000,
    slot: { id: "s1", name: "worker-1", startTime: 1000, chain: ["worker-1"], worktree: { branch: "memo/w1" } },
    lifecycle: {
      turn: { kind: "active", startedAt: 1000, source: "herdr" },
      pane: { kind: "present", agentStatus: "working" },
      process: { kind: "running", startedAt: 1000, confirmedAt: 1000 },
      hasWorked: true,
    },
  };
  const withSurface = async (mode: string | undefined, fn: (api: any) => void | Promise<void>) => {
    const { __test__ } = await import("../pi-extension/subagents/index.ts");
    const prev = process.env.PI_SUBAGENT_SURFACE;
    if (mode === undefined) delete process.env.PI_SUBAGENT_SURFACE;
    else process.env.PI_SUBAGENT_SURFACE = mode;
    try {
      await fn(__test__);
    } finally {
      if (prev !== undefined) process.env.PI_SUBAGENT_SURFACE = prev;
      else delete process.env.PI_SUBAGENT_SURFACE;
      for (const source of ["test", "claim", "lin"]) __test__.receivePanel({ source, data: null });
    }
  };

  it("selector (default) keeps the Subagents box; panel renders the slot grid", async () => {
    await withSurface(undefined, (api) => {
      const lines = api.renderWidgetLines([worker], [], 96);
      assert.match(lines[0], /Subagents/);
      assert.ok(!stripAnsi(lines[0]).startsWith("╭─ ⧉"));
    });
    await withSurface("panel", (api) => {
      const lines = api.renderWidgetLines([worker], [], 96, theme).map(stripAnsi);
      assert.match(lines[0], /^╭─ ⧉  Subagents │ phase running /);
      assert.match(lines.join("\n"), /▸● worker-1|▸ ● worker-1|● worker-1/);
    });
  });

  it("a supplied panel is rendered in any surface and claims the subagents it names; other agents fold in", async () => {
    await withSurface(undefined, (api) => {
      api.receivePanel({ source: "test", data: { ...SCENARIO_3, items: [{ ...SCENARIO_3.items![0], subagent: "worker-1" }] } });
      const lines = api.renderWidgetLines([worker], [], 96, theme).map(stripAnsi);
      assert.match(lines[0], /⛟  Pipeline │ panel-refresh/);
      assert.ok(!lines.some((line: string) => /Subagents/.test(line)), "worker-1 is shown only by the supplied panel");
      // An unnamed subagent folds into the same box as a trailing item or group.
      const other = { ...worker, id: "a2", name: "other", slot: undefined };
      const both = api.renderWidgetLines([worker, other], [], 96, theme).map(stripAnsi);
      assert.ok(both.some((line: string) => /other/.test(line)), "other subagent is folded into the panel");
      assert.ok(!both.some((line: string) => /Subagents/.test(line)), "no separate subagents box");
    });
  });

  it("supplied panel liveness: claims require a live agent or attention", async () => {
    await withSurface(undefined, (api) => {
      // Panel claiming worker-1 with NO live agents and no attention is NOT rendered
      api.receivePanel({ source: "claim", data: { ...SCENARIO_3, items: [{ ...SCENARIO_3.items![0], subagent: "worker-1" }] } });
      assert.equal(api.renderWidgetLines([], [], 96, theme).length, 0);

      // With attention: true, it IS rendered even with no live agents
      api.receivePanel({ source: "claim", data: { ...SCENARIO_3, attention: true, items: [{ ...SCENARIO_3.items![0], subagent: "worker-1" }] } });
      assert.ok(api.renderWidgetLines([], [], 96, theme).length > 0);

      // Group-based claiming: worker with group matches panel with same group
      api.receivePanel({ source: "claim", data: { ...SCENARIO_3, group: "test-run" } });
      assert.equal(api.renderWidgetLines([], [], 96, theme).length, 0); // no agents
      const runWorker = { ...worker, group: "test-run" };
      assert.ok(api.renderWidgetLines([runWorker], [], 96, theme).length > 0); // matched by group
      // An agent of another group never matches by name.
      api.receivePanel({ source: "claim", data: { ...SCENARIO_3, group: "test-run", items: [{ ...SCENARIO_3.items![0], subagent: "worker-1" }] } });
      const other = api.renderWidgetLines([{ ...worker, group: "elsewhere" }], [], 96, theme).map(stripAnsi);
      assert.ok(!other.some((line: string) => /Pipeline/.test(line)), "the panel stays hidden");
      assert.ok(other.some((line: string) => /Subagents/.test(line)), "the agent keeps its own row");
    });
  });

  it("supplied panel linger: visible for linger ms after its last live subagent", async () => {
    await withSurface(undefined, async (api) => {
      const runWorker = { ...worker, group: "run" };
      api.receivePanel({ source: "lin", data: { ...SCENARIO_3, group: "run", linger: 60_000 } });
      assert.ok(api.renderWidgetLines([runWorker], [], 96, theme).length > 0);
      assert.ok(api.renderWidgetLines([], [], 96, theme).length > 0, "still within the linger");
      api.receivePanel({ source: "lin", data: { ...SCENARIO_3, group: "run", linger: 5 } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(api.renderWidgetLines([], [], 96, theme).length, 0, "linger over");
      api.receivePanel({ source: "lin", data: null });
    });
  });

  it("receivePanel ignores malformed payloads and removes a panel on null", async () => {
    await withSurface(undefined, (api) => {
      api.receivePanel(undefined);
      api.receivePanel({ data: {} });
      api.receivePanel({ source: "test", data: { groups: "x" } });
      assert.equal(api.renderWidgetLines([], [], 96, theme).length, 0);
      api.receivePanel({ source: "test", data: { rows: [{ icon: "◐", iconColor: "accent", label: "x", text: "y" }] } });
      assert.equal(api.renderWidgetLines([], [], 96, theme).length, 2);
      api.receivePanel({ source: "test", data: null });
      assert.equal(api.renderWidgetLines([], [], 96, theme).length, 0);
      assert.equal(api.PANEL_EVENT, "subagents:panel");
    });
  });
});
