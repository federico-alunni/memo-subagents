import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeInputKey, mirrorHeader, paletteTheme } from "../pi-extension/subagents/runtime/mirror-view.ts";
import type { MirrorTheme, MirrorView } from "../pi-extension/subagents/runtime/mirror-view.ts";

const C = { accent: "\x1b[38;5;1m", muted: "\x1b[38;5;2m", dim: "\x1b[38;5;3m", success: "\x1b[38;5;4m", error: "\x1b[38;5;5m", warning: "\x1b[38;5;6m", text: "\x1b[38;5;7m" };
const theme: MirrorTheme = paletteTheme(C);

const view = (patch: Partial<MirrorView> = {}): MirrorView => ({
  version: 1,
  paneId: "w2:p1",
  name: "fix-lock",
  agent: "worker",
  branch: "memo/fix",
  startedAt: 0,
  status: "question",
  attention: true,
  ...patch,
});

test("when attention is active, the header shows the interactive hint", () => {
  const header = mirrorHeader(view(), 80, theme, 0);
  assert.match(header, /\[rispondi qui\]/);
  // Narrow: drops branch, then agent, but preserves the hint.
  const narrow = mirrorHeader(view(), 44, theme, 0);
  assert.match(narrow, /\[rispondi qui\]/);
  // Without attention, no hint.
  const idle = mirrorHeader(view({ attention: false, status: "active" }), 80, theme, 0);
  assert.ok(!idle.includes("rispondi qui"));
});

test("decodeInputKey translates VT sequences into Herdr keys and printable text", () => {
  assert.deepEqual(decodeInputKey(Buffer.from([0x1b, 0x5b, 0x41])), { kind: "key", name: "up" });
  assert.deepEqual(decodeInputKey(Buffer.from([0x1b, 0x5b, 0x42])), { kind: "key", name: "down" });
  assert.deepEqual(decodeInputKey(Buffer.from([0x1b, 0x5b, 0x43])), { kind: "key", name: "right" });
  assert.deepEqual(decodeInputKey(Buffer.from([0x1b, 0x5b, 0x44])), { kind: "key", name: "left" });
  assert.deepEqual(decodeInputKey(Buffer.from([0x0d])), { kind: "key", name: "enter" });
  assert.deepEqual(decodeInputKey(Buffer.from([0x0a])), { kind: "key", name: "enter" });
  assert.deepEqual(decodeInputKey(Buffer.from([0x1b])), { kind: "key", name: "esc" });
  assert.deepEqual(decodeInputKey(Buffer.from([0x09])), { kind: "key", name: "tab" });
  assert.deepEqual(decodeInputKey(Buffer.from([0x7f])), { kind: "key", name: "backspace" });
  assert.deepEqual(decodeInputKey(Buffer.from([0x08])), { kind: "key", name: "backspace" });
  // Printable text (typing options, numbers, notes).
  assert.deepEqual(decodeInputKey(Buffer.from("1")), { kind: "text", text: "1" });
  assert.deepEqual(decodeInputKey(Buffer.from("a")), { kind: "text", text: "a" });
  assert.deepEqual(decodeInputKey(Buffer.from("Yes")), { kind: "text", text: "Yes" });
  // Control characters that shouldn't be forwarded (Ctrl+C, Ctrl+D).
  assert.equal(decodeInputKey(Buffer.from([0x03])), undefined);
  assert.equal(decodeInputKey(Buffer.from([0x04])), undefined);
});
