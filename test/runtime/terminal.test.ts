import test from "node:test";
import assert from "node:assert/strict";
import { readProcessTerminal, nodeRunner } from "../../pi-extension/subagents/runtime/index.ts";
import type { Runner } from "../../pi-extension/subagents/runtime/index.ts";

test("OS terminal snapshot validates PID, normalizes macOS/Linux names and keeps exact identity", async () => {
  const identity = "Tue Oct 6 00:00:00 2026 pi --session-id exact";
  for (const tty of ["ttys014", "/dev/ttys014", "pts/12", "/dev/pts/12"]) {
    const runner: Runner = async (input) => {
      assert.equal(input.executable, "ps");
      assert.deepEqual(input.argv, [
        "-p",
        "123",
        "-o",
        "tty=",
        "-o",
        "lstart=",
        "-o",
        "command=",
      ]);
      return { exitCode: 0, stdout: `  ${tty}   ${identity}\n` };
    };
    assert.deepEqual(await readProcessTerminal(runner, 123), {
      tty: tty.replace(/^\/dev\//, ""),
      identity,
    });
  }
});

test("unavailable, detached, malformed or multiple OS terminal records fail closed", async () => {
  for (const stdout of [
    "",
    "?  identity",
    "?? identity",
    "none identity",
    "unknown identity",
    "ttys1",
    "../ttys1 identity",
    "/dev/../../tty identity",
    "ttys1 identity\nttys2 identity",
  ]) {
    await assert.rejects(
      readProcessTerminal(async () => ({ exitCode: 0, stdout }), 123),
    );
  }
  await assert.rejects(
    readProcessTerminal(
      async () => ({ exitCode: 1, stdout: "ttys1 identity" }),
      123,
    ),
  );
  for (const pid of [0, -1, NaN, 1.5])
    await assert.rejects(
      readProcessTerminal(async () => {
        assert.fail("ps must not run");
      }, pid),
    );
});

test("actual read-only OS snapshot matches ps process identity when a terminal is attached", async (t) => {
  const ps = await nodeRunner({
    executable: "ps",
    argv: ["-p", String(process.pid), "-o", "tty="],
  });
  if (
    ps.exitCode !== 0 ||
    /^\?+$/.test(ps.stdout.trim()) ||
    !ps.stdout.trim()
  ) {
    t.skip("Test process has no controlling terminal");
    return;
  }
  const snapshot = await readProcessTerminal(nodeRunner, process.pid);
  const identity = await nodeRunner({
    executable: "ps",
    argv: ["-p", String(process.pid), "-o", "lstart=", "-o", "command="],
  });
  assert.equal(snapshot.tty, ps.stdout.trim().replace(/^\/dev\//, ""));
  assert.equal(snapshot.identity, identity.stdout.trim());
});

test("processIdentity distinguishes a free PID from an unreadable one", async () => {
  const { processIdentity } = await import("../../pi-extension/subagents/runtime/index.ts");
  assert.equal(
    await processIdentity(async () => ({ exitCode: 1, stdout: "", stderr: "" }), 123),
    undefined,
  );
  assert.equal(
    await processIdentity(async () => ({ exitCode: 0, stdout: "start cmd\n" }), 123),
    "start cmd",
  );
  await assert.rejects(
    processIdentity(async () => ({ exitCode: 2, stdout: "", stderr: "ps failed" }), 123),
  );
});
