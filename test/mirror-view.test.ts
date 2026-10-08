import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  cropChatBar,
  mirrorHeader,
  paletteTheme,
  renderMirrorFrame,
  renderMirrorLines,
  splitScreen,
  stripAnsi,
  themePalette,
  truncateAnsi,
  visibleWidth,
} from "../pi-extension/subagents/runtime/mirror-view.ts";
import type { MirrorTheme, MirrorView } from "../pi-extension/subagents/runtime/mirror-view.ts";

// Real `herdr pane read <pane> --source visible --format ansi` captures of a pi child (sanitized).
const fixture = (name: string) =>
  splitScreen(readFileSync(fileURLToPath(new URL(`./fixtures/mirror/${name}.ansi`, import.meta.url)), "utf8"));
const plain = (lines: string[]) => lines.map((line) => stripAnsi(line).trimEnd());
const BORDER = /^─{10,}$/;

/** One distinct SGR per token, so styling assertions name the theme token that produced a cell. */
const C = { accent: "\x1b[38;5;1m", muted: "\x1b[38;5;2m", dim: "\x1b[38;5;3m", success: "\x1b[38;5;4m", error: "\x1b[38;5;5m", warning: "\x1b[38;5;6m", text: "\x1b[38;5;7m" };
const tagTheme: MirrorTheme = paletteTheme(C);
const fg = (token: keyof typeof C, text: string) => `${C[token]}${text}\x1b[39m`;
const b = (text: string) => `\x1b[1m${text}\x1b[22m`;
const it = (text: string) => `\x1b[3m${text}\x1b[23m`;

const view = (patch: Partial<MirrorView> = {}): MirrorView => ({
  version: 1,
  paneId: "w9:p2",
  name: "fix-lock",
  agent: "worker",
  branch: "memo/fix-lock-1a2b3c4d",
  startedAt: 0,
  status: "active",
  ...patch,
});

test("splitScreen keeps every terminal row of a capture", () => {
  const lines = fixture("pi-idle");
  assert.ok(lines.length >= 20);
  assert.ok(lines.every((line) => !line.includes("\r") && !line.includes("\n")));
  assert.match(plain(lines).at(-1)!, /⎇ main/);
});

test("idle child: the editor between the last two borders and the lower border are removed; status and footer stay", () => {
  const lines = fixture("pi-idle-typed");
  const { lines: out, cropped } = cropChatBar(lines);
  assert.equal(cropped, true);
  const text = plain(out);
  assert.ok(!text.some((line) => line.includes("draft line one, not sent")), "typed input is not mirrored");
  assert.equal(text.filter((line) => BORDER.test(line)).length, plain(lines).filter((line) => BORDER.test(line)).length - 1);
  assert.match(text.at(-1)!, /⎇ main │ .*prov-01 │ profile-flash · low/);
  assert.ok(BORDER.test(text.at(-2)!), "the upper border separates chat and footer");
  assert.equal(out.length, lines.length - 2);
});

test("working child: the Working status line and the footer stay, the empty editor goes", () => {
  for (const name of ["pi-working", "pi-working-tool"]) {
    const lines = fixture(name);
    const { lines: out, cropped } = cropChatBar(lines);
    assert.equal(cropped, true, name);
    const text = plain(out);
    assert.ok(text.some((line) => /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/.test(line) && line.includes("Working")), name);
    assert.match(text.at(-1)!, /⎇ main/);
    assert.equal(out.length, lines.length - 2, name);
  }
  // Tool output above the bar is untouched.
  assert.ok(plain(cropChatBar(fixture("pi-working-tool")).lines).some((line) => line.includes("$ sleep 6 && echo done")));
});

test("a Working label on the upper border is recognised as a border", () => {
  const lines = ["chat", "── ⠴ Working ──────────────────", "> typed", "──────────────────────────────", "~/repo (main)", "↑1 ↓2 $0.01"];
  const { lines: out, cropped } = cropChatBar(lines);
  assert.equal(cropped, true);
  assert.deepEqual(out, ["chat", "── ⠴ Working ──────────────────", "~/repo (main)", "↑1 ↓2 $0.01"]);
});

test("a child waiting for the user shows everything: pi renders the question inside the editor borders", () => {
  const lines = fixture("pi-question");
  // The real capture: the question dialog sits between the two editor borders.
  const text = plain(lines);
  const borders = text.map((line, i) => (BORDER.test(line) ? i : -1)).filter((i) => i >= 0);
  const between = text.slice(borders.at(-2)! + 1, borders.at(-1)!);
  assert.ok(between.some((line) => line.includes("Keep the old format?")));
  const { lines: out, cropped } = cropChatBar(lines, { attention: true });
  assert.equal(cropped, false);
  assert.deepEqual(out, lines);
});

test("without two borders near the bottom nothing is cropped", () => {
  assert.equal(cropChatBar(["a", "b", "──────────────────", "c"]).cropped, false);
  // Borders far from the bottom are not the editor (more than 4 footer lines).
  const far = ["──────────────────", "x", "──────────────────", "1", "2", "3", "4", "5"];
  assert.equal(cropChatBar(far).cropped, false);
  assert.equal(cropChatBar([]).cropped, false);
});

test("truncateAnsi cuts on visible width, keeps styles and resets them", () => {
  const styled = "\x1b[38;2;1;2;3mabcdef\x1b[0mghij";
  const cut = truncateAnsi(styled, 4);
  assert.equal(stripAnsi(cut), "abcd");
  assert.ok(cut.startsWith("\x1b[38;2;1;2;3m"));
  assert.ok(cut.endsWith("\x1b[0m"));
  assert.equal(visibleWidth(truncateAnsi("日本語テキスト", 5)), 4, "wide characters are never split");
  assert.equal(stripAnsi(truncateAnsi("short", 10)), "short");
  // Cursor movement sequences never reach the mirror; OSC 8 hyperlinks are kept as zero width.
  assert.equal(truncateAnsi("a\x1b[2Kb", 5), "ab\x1b[0m");
  const link = "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\";
  assert.equal(stripAnsi(truncateAnsi(link, 10)), "link");
});

test("header: status symbol, slot, agent, branch and duration in theme tokens; branch, then agent dropped when narrow", () => {
  const now = 192_000; // 03:12
  const wide = mirrorHeader(view(), 80, tagTheme, now);
  assert.equal(visibleWidth(stripTags(wide)), 80);
  assert.match(stripTags(wide), /^╭─ ● fix-lock │ worker │ ⎇ memo\/fix-lock-1a2b3c4d ─+ 03:12 ─╮$/);
  assert.ok(wide.startsWith(fg("accent", "╭─")));
  assert.ok(wide.includes(fg("accent", "●")));
  assert.ok(wide.includes(b(fg("text", "fix-lock"))));
  assert.ok(wide.includes(`${fg("muted", "│")} ${it("worker")}`));
  assert.ok(wide.includes(`${fg("accent", "⎇")} memo/fix-lock-1a2b3c4d`));
  assert.ok(wide.includes(fg("muted", "03:12")));
  assert.ok(wide.endsWith(fg("accent", "─╮")));
  assert.match(stripTags(mirrorHeader(view(), 40, tagTheme, now)), /^╭─ ● fix-lock │ worker ─+ 03:12 ─╮$/);
  assert.match(stripTags(mirrorHeader(view(), 28, tagTheme, now)), /^╭─ ● fix-lock ─+ 03:12 ─╮$/);
  assert.equal(visibleWidth(stripTags(mirrorHeader(view(), 12, tagTheme, now))), 12, "never wider than the pane");
});

test("header status symbols follow the #86 preview", () => {
  const symbol = (status: MirrorView["status"]) => stripTags(mirrorHeader(view({ status }), 60, tagTheme, 0)).slice(3, 4);
  assert.equal(symbol("active"), "●");
  assert.equal(symbol("starting"), "◐");
  assert.equal(symbol("waiting"), "○");
  assert.equal(symbol("question"), "?");
  assert.equal(symbol("stalled"), "●");
  assert.equal(symbol("done"), "✓");
  assert.equal(symbol("error"), "✗");
  assert.ok(mirrorHeader(view({ status: "question" }), 60, tagTheme, 0).includes(b(fg("warning", "?"))));
  assert.ok(mirrorHeader(view({ status: "stalled" }), 60, tagTheme, 0).includes(fg("error", "●")));
  assert.ok(mirrorHeader(view({ status: "done" }), 60, tagTheme, 0).includes(fg("success", "✓")));
  assert.ok(mirrorHeader(view({ status: "waiting" }), 60, tagTheme, 0).includes(fg("muted", "○")));
});

test("mirror lines: header, accent side borders, no bottom border, bottom anchored, truncated, exact size", () => {
  const screen = fixture("pi-working-tool");
  const lines = renderMirrorLines(view(), screen, 12, 50, tagTheme, 0);
  assert.equal(lines.length, 12);
  for (const line of lines) assert.equal(visibleWidth(stripTags(line)), 50);
  assert.match(stripTags(lines[0]), /^╭─/);
  for (const line of lines.slice(1)) {
    assert.ok(line.startsWith(fg("accent", "│")));
    assert.ok(line.endsWith(fg("accent", "│")));
  }
  assert.ok(!stripTags(lines.at(-1)!).includes("╰"));
  // The cropped screen is anchored at the bottom: the footer is the last mirrored row.
  assert.match(stripTags(lines.at(-1)!), /^│⎇ main/);
  // Short content is top aligned and padded with empty bordered rows.
  const short = renderMirrorLines(view(), ["one", "two"], 6, 20, tagTheme, 0);
  assert.equal(stripTags(short[1]), `│one${" ".repeat(15)}│`);
  assert.equal(stripTags(short[5]), `│${" ".repeat(18)}│`);
});

test("mirror lines without a pane yet, and with attention, keep the frame", () => {
  const waiting = renderMirrorLines(view({ paneId: undefined, status: "starting" }), [], 4, 30, tagTheme, 0);
  assert.equal(waiting.length, 4);
  const asked = renderMirrorLines(view({ status: "question", attention: true }), fixture("pi-question"), 40, 60, tagTheme, 0);
  assert.ok(asked.some((line) => stripTags(line).includes("Yes (Recommended)")));
});

test("frame: home, rows joined with CRLF, short rows erased to the end, full-width rows never erased", () => {
  // Rows shorter than the terminal are erased to their end (no stale tail after a shrink).
  assert.equal(
    renderMirrorFrame(["ab", "cd"], 5),
    "\x1b[H\x1b[0mab\x1b[0m\x1b[K\r\n\x1b[0mcd\x1b[0m\x1b[K\x1b[J",
  );
  // Regression (found on a real Herdr): with autowrap off the cursor rests on the last column, and an
  // erase-to-end-of-line there would wipe the right border of every full-width row.
  const full = renderMirrorFrame(["abcde", "fghij"], 5);
  assert.ok(!full.includes("\x1b[K"), "full-width rows are followed by no erase");
  assert.equal(full, "\x1b[H\x1b[0mabcde\x1b[0m\r\n\x1b[0mfghij\x1b[0m\x1b[J");
  // Styled rows count visible cells only.
  assert.ok(!renderMirrorFrame(["\x1b[31mabcde\x1b[39m"], 5).includes("\x1b[K"));
});

test("a painted mirror frame has no erase after any row (rows are exactly the terminal width)", async () => {
  const { nextFrame } = await import("../pi-extension/subagents/runtime/mirror-viewer.ts");
  const screen = readFileSync(fileURLToPath(new URL("./fixtures/mirror/pi-working.ansi", import.meta.url)), "utf8");
  const frame = nextFrame(undefined, view(), screen, 20, 60, 1_000)!;
  assert.ok(!frame.includes("\x1b[K"));
});

test("palette theme: SGR prefixes from the pi theme, reset to the default foreground", () => {
  const pi = { getFgAnsi: (token: string) => (token === "accent" ? "\x1b[38;2;235;203;139m" : "\x1b[38;5;8m") };
  const palette = themePalette(pi);
  assert.equal(palette.accent, "\x1b[38;2;235;203;139m");
  const theme = paletteTheme(palette);
  assert.equal(theme.fg("accent", "x"), "\x1b[38;2;235;203;139mx\x1b[39m");
  assert.equal(theme.bold("x"), "\x1b[1mx\x1b[22m");
  assert.equal(theme.italic("x"), "\x1b[3mx\x1b[23m");
  // Unknown or missing palette entries fall back to plain text.
  assert.equal(paletteTheme({}).fg("accent", "x"), "x");
  assert.equal(paletteTheme({ accent: "rm -rf" } as any).fg("accent", "x"), "x", "only SGR sequences are accepted");
});

function stripTags(text: string): string {
  return stripAnsi(text);
}

test("viewer: a frame is produced only when the screen, the view or the size changes", async () => {
  const { nextFrame, readView } = await import("../pi-extension/subagents/runtime/mirror-viewer.ts");
  const screen = readFileSync(fileURLToPath(new URL("./fixtures/mirror/pi-idle.ansi", import.meta.url)), "utf8");
  const first = nextFrame(undefined, view(), screen, 20, 60, 5_000);
  assert.ok(first);
  assert.ok(first.startsWith("\x1b[H"));
  assert.equal(nextFrame(first, view(), screen, 20, 60, 5_000), undefined, "identical screen: no repaint");
  const changed = screen.replace(/\r?\n$/, "") + "\r\nnew output line";
  assert.ok(nextFrame(first, view(), changed, 20, 60, 5_000), "a new last row changes the frame");
  assert.ok(nextFrame(first, view(), screen, 20, 70, 5_000), "resized pane");
  assert.ok(nextFrame(first, view({ status: "question" }), screen, 20, 60, 5_000), "changed status");
  // The duration is part of the frame, so it ticks once a second.
  assert.ok(nextFrame(first, view(), screen, 20, 60, 6_000), "header duration");
  // No view yet (the owner has not written it): a placeholder frame, never a crash.
  assert.ok(nextFrame(undefined, undefined, undefined, 5, 30, 0));
  assert.equal(await readView("/nonexistent/view.json"), undefined);
});
