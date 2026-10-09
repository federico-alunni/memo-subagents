// A worktree agent opens in its own sub-space by default inside Herdr; callers can opt out.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { wantsWorktreeSpace } from "../pi-extension/subagents/index.ts";

function withHerdr<T>(on: boolean, fn: () => T): T {
  const saved = process.env.HERDR_ENV;
  process.env.HERDR_ENV = on ? "1" : "0";
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = saved;
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
