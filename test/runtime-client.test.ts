import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { subagentEnd, superviseSubagent } from "../pi-extension/subagents/runtime-client.ts";

const exit = (reason: string, extra: object = {}) => ({ kind: "exit", reason, ...extra }) as any;
const obs = (kind: string, extra: object = {}) => ({ kind, requests: [], ...extra }) as any;

describe("subagent supervision on the agent runtime", () => {
  it("maps runtime observations to the end of a subagent", () => {
    assert.equal(subagentEnd(obs("active")), undefined);
    assert.equal(subagentEnd(obs("settled")), undefined);
    assert.equal(subagentEnd(obs("unavailable")), undefined); // Herdr read error: keep waiting
    // Exit record while the process is still exiting: wait for the observed exit.
    assert.equal(subagentEnd(obs("active", { exit: exit("done") })), undefined);
    assert.equal(subagentEnd(obs("stopped", { exit: exit("done") }))?.kind, "done");
    assert.deepEqual(subagentEnd(obs("stopped", { exit: exit("ping", { message: "help" }) }))?.kind, "ping");
    const failed = subagentEnd(obs("stopped", { exit: exit("error", { error: "overloaded" }) }));
    assert.equal(failed?.kind === "error" && failed.errorMessage, "overloaded");
    assert.deepEqual(subagentEnd(obs("unavailable", { exited: true })), { kind: "ended", reason: "user-quit" });
    assert.deepEqual(subagentEnd(obs("missing")), { kind: "ended", reason: "pane-closed" });
  });

  it("observes until the end, then closes the pane through the runtime", async () => {
    const handles = [{ agentId: "a" }, { agentId: "a", tabId: "moved" }];
    let observed = 0;
    const calls: string[] = [];
    const runtime = {
      async observe(h: any) {
        calls.push(`observe ${h.tabId ?? "-"}`);
        return ++observed < 3 ? obs("active") : obs("stopped", { exit: exit("done") });
      },
      async close(h: any) { calls.push(`close ${h.tabId ?? "-"}`); },
      forget() { calls.push("forget"); },
    };
    let current = handles[0];
    const outcome = await superviseSubagent({
      runtime: runtime as any,
      handle: () => current as any,
      signal: new AbortController().signal,
      intervalMs: 1,
      onObservation: () => { current = handles[1]; },
    });
    assert.equal(outcome.end.kind, "done");
    assert.equal(outcome.closed, true);
    // The selector replaced the handle: later observations and the close use the new one.
    assert.deepEqual(calls, ["observe -", "observe moved", "observe moved", "close moved"]);
  });

  it("reports a pane the runtime refuses to close, and retires its widget row", async () => {
    const calls: string[] = [];
    const runtime = {
      async observe() { return obs("unavailable", { exited: true }); },
      async close() { throw new Error("Pane has a different occupant"); },
      forget() { calls.push("forget"); },
    };
    const outcome = await superviseSubagent({
      runtime: runtime as any, handle: () => ({}) as any, signal: new AbortController().signal, intervalMs: 1,
    });
    assert.equal(outcome.closed, false);
    assert.match(outcome.closeError ?? "", /different occupant/);
    assert.deepEqual(calls, ["forget"]);
  });

  it("a pane closed by the user needs no close; cancelling retires only a settled child", async () => {
    const closedByUser = await superviseSubagent({
      runtime: { async observe() { return obs("missing"); }, forget() {} } as any,
      handle: () => ({}) as any, signal: new AbortController().signal, intervalMs: 1,
    });
    assert.deepEqual(closedByUser, { end: { kind: "ended", reason: "pane-closed" }, closed: true });
    const controller = new AbortController();
    const calls: string[] = [];
    const runtime = {
      async observe() { controller.abort(); return obs("active"); },
      async stop() { calls.push("stop"); throw new Error("Agent task is not settled; interrupt first"); },
      async close() { calls.push("close"); },
    };
    const cancelled = await superviseSubagent({
      runtime: runtime as any, handle: () => ({}) as any, signal: controller.signal, intervalMs: 1,
    });
    assert.equal(cancelled.end.kind, "cancelled");
    assert.deepEqual(calls, ["stop"]);
  });
});
