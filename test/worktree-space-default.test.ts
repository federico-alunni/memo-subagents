// A worktree agent opens in its own sub-space by default inside Herdr; callers can opt out.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wantsWorktreeSpace } from "../pi-extension/subagents/index.ts";

/**
 * Pin both conditions of the default (`HERDR_ENV` and the herdr binary on PATH), so the test says what the
 * default is instead of what this machine has installed. A fake herdr on PATH provides the binary.
 */
function withHerdr<T>(on: boolean, fn: () => T): T {
  const savedEnv = process.env.HERDR_ENV;
  const savedPath = process.env.PATH;
  process.env.HERDR_ENV = on ? "1" : "0";
  if (on) {
    const bin = join(tmpdir(), "memo-space-default-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  }
  try {
    return fn();
  } finally {
    if (savedEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = savedEnv;
    process.env.PATH = savedPath;
  }
}

describe("worktree sub-space default", () => {
  it("worktree: true opens a sub-space inside Herdr", () => {
    withHerdr(true, () => assert.equal(wantsWorktreeSpace({ worktree: true }), true));
  });
  it("outside Herdr there is no sub-space", () => {
    withHerdr(false, () => assert.equal(wantsWorktreeSpace({ worktree: true }), false));
  });
  it("worktreeSpace: false opts out, true is explicit", () => {
    withHerdr(true, () => {
      assert.equal(wantsWorktreeSpace({ worktree: true, worktreeSpace: false }), false);
      assert.equal(wantsWorktreeSpace({ worktree: true, worktreeSpace: true }), true);
    });
  });
  it("no worktree, fork or handoff never default to a sub-space", () => {
    withHerdr(true, () => {
      assert.equal(wantsWorktreeSpace({}), false);
      assert.equal(wantsWorktreeSpace({ worktree: true, fork: true }), false);
      assert.equal(wantsWorktreeSpace({ worktree: true, handoff: "replace" }), false);
    });
  });
});
