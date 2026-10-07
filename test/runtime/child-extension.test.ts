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
  return {
    tools,
    events,
    api: {
      registerTool: (tool: any) => tools.push(tool),
      on: (event: string) => events.push(event),
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
