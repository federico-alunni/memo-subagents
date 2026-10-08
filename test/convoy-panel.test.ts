import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderConvoyPanel } from "../pi-extension/subagents/runtime/convoy-panel.ts";
import type { ConvoyPanelData } from "../pi-extension/subagents/runtime/convoy-panel.ts";
import { paletteTheme, stripAnsi, visibleWidth } from "../pi-extension/subagents/runtime/mirror-view.ts";
import type { MirrorTheme } from "../pi-extension/subagents/runtime/mirror-view.ts";

const golden = (scenario: number, width: number) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/convoy/golden-${scenario}-w${width}.txt`, import.meta.url)), "utf8").trimEnd();

const C = { accent: "\x1b[38;2;235;203;139m", success: "\x1b[38;2;135;191;208m", error: "\x1b[38;2;190;97;106m", warning: "\x1b[38;2;235;203;139m", muted: "\x1b[38;2;79;79;79m", text: "\x1b[38;2;255;255;255m", dim: "\x1b[2m" };
const theme: MirrorTheme = paletteTheme(C);

const SCENARIO_1: ConvoyPanelData = {
  title: "panel-refresh",
  phase: "pianificazione",
  done: 0,
  total: 6,
  planning: [
    { icon: "?", iconColor: "warning", label: "planner", text: "aspetta una tua risposta" },
    { icon: "✓", iconColor: "success", label: "research", text: "2 ricerche su 2 completate" },
    { icon: "◐", iconColor: "accent", label: "challenger", text: "critica il piano", extra: "secondo giro di revisione" },
  ],
};

const SCENARIO_2: ConvoyPanelData = {
  title: "panel-refresh",
  phase: "foundation",
  done: 2,
  total: 6,
  phases: [
    {
      name: "foundation",
      status: "active",
      tasks: [
        { id: "t1", name: "fix-core-lock", dot: "success", stages: { build: "completed", simplify: "completed", review: "completed", checkpoint: true } },
        { id: "t2", name: "feat-run-control", dot: "accent", stages: { build: "completed", simplify: "completed", review: "active", checkpoint: false } },
        { id: "t3", name: "chore-pr-automation", dot: "error", stages: { build: "completed", simplify: "active", review: "pending", checkpoint: false }, stall: "⚠12m" },
        { id: "t4", name: "feat-plan-view", dot: "success", stages: { build: "completed", simplify: "completed", review: "completed", checkpoint: true } },
      ],
    },
    {
      name: "runtime",
      status: "queued",
      tasks: [
        { id: "t5", name: "feat-planner-core", dot: "warning", stages: { build: "completed", simplify: "completed", review: "completed", correction: 2, checkpoint: false } },
        { id: "t6", name: "docs-panel", dot: "muted", stages: { build: "pending", simplify: "pending", review: "pending", checkpoint: false } },
      ],
    },
  ],
};

const SCENARIO_3: ConvoyPanelData = {
  title: "panel-refresh",
  phase: "foundation",
  done: 2,
  total: 6,
  compact: true,
  tasks: [
    { id: "t2", name: "feat-run-control", dot: "accent", stages: { build: "completed", simplify: "completed", review: "active", checkpoint: false } },
    { id: "t3", name: "chore-pr-automation", dot: "error", stages: { build: "completed", simplify: "active", review: "pending", checkpoint: false }, stall: "⚠12m" },
  ],
};

for (const width of [96, 140]) {
  test(`golden test Scenario 1 (pianificazione) at W=${width}`, () => {
    const lines = renderConvoyPanel(SCENARIO_1, width, theme);
    const plain = lines.map(stripAnsi).join("\n");
    assert.equal(plain, golden(1, width));
    for (const line of lines) assert.equal(visibleWidth(stripAnsi(line)), width);
  });

  test(`golden test Scenario 2 (esecuzione) at W=${width}`, () => {
    const lines = renderConvoyPanel(SCENARIO_2, width, theme);
    const plain = lines.map(stripAnsi).join("\n");
    assert.equal(plain, golden(2, width));
    for (const line of lines) assert.equal(visibleWidth(stripAnsi(line)), width);
  });

  test(`golden test Scenario 3 (compact) at W=${width}`, () => {
    const lines = renderConvoyPanel(SCENARIO_3, width, theme);
    const plain = lines.map(stripAnsi).join("\n");
    assert.equal(plain, golden(3, width));
    for (const line of lines) assert.equal(visibleWidth(stripAnsi(line)), width);
  });
}

test("theme tokens: header, dots, stages and border colors match theme", () => {
  const lines = renderConvoyPanel(SCENARIO_2, 96, theme);
  // Bar border in accent
  assert.ok(lines[0].startsWith(C.accent + "╭─"));
  // Progress in success + muted
  assert.ok(lines[0].includes(C.success + "▰"));
  assert.ok(lines[0].includes(C.muted + "▱"));
  // Checkpoint checkmark in success
  assert.ok(lines[3].includes(C.success + "☑"));
  // Checkpoint box in muted
  assert.ok(lines[3].includes(C.muted + "☐"));
  // Stall warning in error
  assert.ok(lines[4].includes(C.error + "⚠12m"));
});

test("extension: selection marker ▸ in free cell before dot preserves alignment", () => {
  const data: ConvoyPanelData = {
    ...SCENARIO_2,
    phases: [
      {
        ...SCENARIO_2.phases![0],
        tasks: [
          { ...SCENARIO_2.phases![0].tasks[0], selected: true }, // left cell selected
          { ...SCENARIO_2.phases![0].tasks[1], selected: false },
        ],
      },
    ],
  };
  const unselectedLines = renderConvoyPanel(SCENARIO_2, 96, theme);
  const selectedLines = renderConvoyPanel(data, 96, theme);
  // Widths identical
  assert.equal(visibleWidth(stripAnsi(selectedLines[3])), 96);
  // Line has ▸ in accent
  assert.ok(selectedLines[3].includes("▸"));
  assert.ok(selectedLines[3].includes(C.accent + "▸"));
  // Line structure preserves alignment (same length without ansi)
  assert.equal(stripAnsi(selectedLines[3]).length, stripAnsi(unselectedLines[3]).length);
});

test("extension: question stall in warning bold (?40s) in stall column", () => {
  const data: ConvoyPanelData = {
    ...SCENARIO_3,
    tasks: [
      { ...SCENARIO_3.tasks![0], stall: "?40s" },
      SCENARIO_3.tasks![1],
    ],
  };
  const lines = renderConvoyPanel(data, 96, theme);
  assert.equal(visibleWidth(stripAnsi(lines[1])), 96);
  assert.ok(lines[1].includes("?40s"));
  assert.ok(lines[1].includes(C.warning));
});

test("extension: selected detail row below grid", () => {
  const data: ConvoyPanelData = {
    ...SCENARIO_2,
    selectedDetail: {
      branch: "memo/fix-core-lock-1a2b",
      status: "active · test 00:15",
    },
    showHint: true,
  };
  const lines = renderConvoyPanel(data, 96, theme);
  const detail = lines.at(-1)!;
  assert.equal(visibleWidth(stripAnsi(detail)), 96);
  assert.ok(stripAnsi(detail).includes("⎇ memo/fix-core-lock-1a2b"));
  assert.ok(stripAnsi(detail).includes("active · test 00:15"));
  assert.ok(stripAnsi(detail).includes("/subagent · Ctrl+Alt+X"));
});

test("buildConvoyPanelDataFromAgents builds valid panel data from running subagent slots", async () => {
  const { buildConvoyPanelDataFromAgents } = await import("../pi-extension/subagents/runtime/convoy-panel.ts");
  const a1 = {
    id: "a1", name: "fix-core-lock", startTime: 1000,
    slot: { id: "s1", name: "fix-core-lock", startTime: 1000, chain: ["fix-core-lock"], worktree: { branch: "memo/fix" } },
    lifecycle: {
      turn: { kind: "active" as const, startedAt: 1000, source: "herdr" as const },
      pane: { kind: "present" as const, agentStatus: "working" as const },
      process: { kind: "running" as const, startedAt: 1000, confirmedAt: 1000 },
      hasWorked: true,
    },
  };
  const a2 = {
    id: "a2", name: "chore-pr", startTime: 2000,
    slot: { id: "s2", name: "chore-pr", startTime: 2000, chain: ["chore-pr"], worktree: { branch: "memo/pr" } },
    lifecycle: {
      turn: { kind: "blocked" as const, startedAt: 2000, reason: "question", stateDurationSince: 2000 },
      pane: { kind: "present" as const, agentStatus: "blocked" as const },
      process: { kind: "running" as const, startedAt: 2000, confirmedAt: 2000 },
      hasWorked: true,
    },
  };

  const data = buildConvoyPanelDataFromAgents([a1, a2] as any, "s2", 5000);
  assert.equal(data.total, 2);
  assert.equal(data.phases?.length, 1);
  const tasks = data.phases![0].tasks;
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].name, "fix-core-lock");
  assert.equal(tasks[0].dot, "accent");
  assert.equal(tasks[1].name, "chore-pr");
  assert.equal(tasks[1].dot, "warning");
  assert.equal(tasks[1].stall, "?3s");
  assert.equal(tasks[1].selected, true); // s2 was selected
  assert.equal(data.selectedDetail?.branch, "memo/pr");

  // Renders cleanly at W=96
  const lines = renderConvoyPanel(data, 96, theme);
  assert.ok(lines.length >= 4);
  for (const line of lines) assert.equal(visibleWidth(stripAnsi(line)), 96);
});

test("opt-in surfaceMode: convoy mode renders Convoy panel, default selector renders Subagents box", async () => {
  const { __test__ } = await import("../pi-extension/subagents/index.ts");
  const a1 = {
    id: "a1", name: "worker-1", startTime: 1000,
    slot: { id: "s1", name: "worker-1", startTime: 1000, chain: ["worker-1"], worktree: { branch: "memo/w1" } },
    lifecycle: {
      turn: { kind: "active" as const, startedAt: 1000, source: "herdr" as const },
      pane: { kind: "present" as const, agentStatus: "working" as const },
      process: { kind: "running" as const, startedAt: 1000, confirmedAt: 1000 },
      hasWorked: true,
    },
  };

  const prevEnv = process.env.PI_SUBAGENT_SURFACE;
  try {
    // Default / selector mode: invariant, unchanged
    delete process.env.PI_SUBAGENT_SURFACE;
    const defaultLines = __test__.renderWidgetLines([a1 as any], [], 96);
    assert.match(defaultLines[0], /Subagents/);
    assert.ok(!defaultLines[0].includes("⛟"));

    // Convoy mode: opt-in, renders the #86 panel
    process.env.PI_SUBAGENT_SURFACE = "convoy";
    const convoyLines = __test__.renderWidgetLines([a1 as any], [], 96, theme);
    assert.match(convoyLines[0], /⛟  Convoy/);
    assert.ok(!convoyLines[0].includes("Subagents"));
  } finally {
    if (prevEnv !== undefined) process.env.PI_SUBAGENT_SURFACE = prevEnv;
    else delete process.env.PI_SUBAGENT_SURFACE;
  }
});
