import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import childExtension, {
  CHILD_ENV,
} from "../../pi-extension/subagents/runtime/child/extension.ts";

function fakePi() {
  const tools: { name: string; parameters: any }[] = [];
  const events: string[] = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  return {
    tools,
    events,
    handlers,
    api: {
      registerShortcut: () => {},
      registerTool: (tool: any) => tools.push(tool),
      on: (event: string, handler: (...args: any[]) => any) => {
        events.push(event);
        handlers.set(event, handler);
      },
    } as any,
  };
}

test("child extension registers declared delegated tools and question from boot, nothing without identity", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "memo-runtime-child-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env[CHILD_ENV.protocolDir];
  t.after(() => {
    if (previous === undefined) delete process.env[CHILD_ENV.protocolDir];
    else process.env[CHILD_ENV.protocolDir] = previous;
  });
  await writeFile(
    join(dir, "boot.json"),
    JSON.stringify({
      policy: {
        tools: ["read"],
        bash: "readonly",
        question: true,
        delegatedTools: [
          {
            name: "ir_integrate",
            description: "Integrate.",
            parameters: { type: "object", properties: { taskId: { type: "string" } } },
            once: "per-task",
          },
        ],
      },
    }),
  );
  process.env[CHILD_ENV.protocolDir] = dir;
  const declared = fakePi();
  childExtension(declared.api);
  assert.deepEqual(declared.tools.map((tool) => tool.name), ["ir_integrate", "question"]);
  assert.deepEqual(declared.tools[0].parameters.properties, { taskId: { type: "string" } });
  for (const event of ["session_start", "tool_call", "input", "user_bash", "agent_settled"])
    assert.ok(declared.events.includes(event), event);
  delete process.env[CHILD_ENV.protocolDir];
  const bare = fakePi();
  childExtension(bare.api);
  assert.deepEqual(bare.tools, []);
});

test("child refuses to start when its private identity or policy does not match boot.json", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "memo-runtime-child-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const saved = Object.fromEntries(Object.values(CHILD_ENV).map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });
  const policy = { tools: ["read"], bash: "unrestricted", question: false, delegatedTools: [] };
  const boot = { scope: "s", agentId: "a", attempt: 1, nonce: "n", sessionId: "x", paneId: "p", cwd: dir, protocolDir: dir, model: "p/m", effort: "low", policy };
  await writeFile(join(dir, "boot.json"), JSON.stringify(boot));
  const env = { [CHILD_ENV.protocolDir]: dir, [CHILD_ENV.nonce]: "n", [CHILD_ENV.scope]: "s", [CHILD_ENV.agentId]: "a", [CHILD_ENV.attempt]: "1" };
  for (const [key, wrong] of [
    [CHILD_ENV.nonce, "other"],
    [CHILD_ENV.scope, "other"],
    [CHILD_ENV.agentId, "other"],
    [CHILD_ENV.attempt, "2"],
  ]) {
    Object.assign(process.env, env, { [key]: wrong });
    const pi = fakePi();
    childExtension(pi.api);
    await assert.rejects(pi.handlers.get("session_start")!({}, {}), /boot mismatch/, key);
  }
  // Policy changed after the extension registered its tools.
  Object.assign(process.env, env);
  const pi = fakePi();
  childExtension(pi.api);
  await writeFile(join(dir, "boot.json"), JSON.stringify({ ...boot, policy: { ...policy, tools: ["read", "bash"] } }));
  await assert.rejects(pi.handlers.get("session_start")!({}, {}), /boot mismatch/);
  delete process.env[CHILD_ENV.nonce];
  await assert.rejects(pi.handlers.get("session_start")!({}, {}), /private identity/);
});

test("skills and prompt are one run: follow-ups are queued only after the run started", async () => {
  const { createTaskDelivery } = await import("../../pi-extension/subagents/runtime/child/extension.ts");
  const sent: [string, object][] = [];
  const delivery = createTaskDelivery((text, options) => sent.push([text, options]));
  delivery.send("Do the task", ["pdf-tools", "review"]);
  assert.deepEqual(sent, [["/skill:pdf-tools", { expandPromptTemplates: true }]]);
  delivery.agentStarted();
  assert.deepEqual(sent.slice(1), [
    ["/skill:review", { expandPromptTemplates: true, deliverAs: "followUp" }],
    ["Do the task", { expandPromptTemplates: false, deliverAs: "followUp" }],
  ]);
  // Later runs (user turns) send nothing more.
  delivery.agentStarted();
  assert.equal(sent.length, 3);
  // Without skills the prompt is the only message, never expanded.
  const plain: [string, object][] = [];
  const single = createTaskDelivery((text, options) => plain.push([text, options]));
  single.send("$1 /skill:x literal");
  single.agentStarted();
  assert.deepEqual(plain, [["$1 /skill:x literal", { expandPromptTemplates: false }]]);
});
