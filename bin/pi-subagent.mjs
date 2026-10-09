#!/usr/bin/env node

// CLI wrapper around the pi-memo-subagents session socket.

import { SubagentClient } from "../pi-extension/subagents/client.ts";

function usage() {
  console.error(`Usage: pi-subagent <command> [args]
Commands:
  spawn --json '<params-json>'
  list [--json]
  send <id> <prompt>
  interrupt <id|name>
`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === "--help" || cmd === "-h") usage();

  let client;
  try {
    client = new SubagentClient();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  try {
    if (cmd === "spawn") {
      const jsonIdx = args.indexOf("--json");
      if (jsonIdx === -1 || !args[jsonIdx + 1]) {
        console.error("Error: spawn requires --json '<params-json>'");
        process.exit(1);
      }
      const params = JSON.parse(args[jsonIdx + 1]);
      const result = await client.spawn(params);
      console.log(JSON.stringify(result, null, 2));
    } else if (cmd === "list") {
      const list = await client.list();
      if (args.includes("--json")) {
        console.log(JSON.stringify(list, null, 2));
      } else {
        if (list.length === 0) {
          console.log("No running subagents.");
        } else {
          for (const item of list) {
            console.log(`- ${item.id} (${item.name}) status=${item.lifecycle?.turn?.kind ?? item.statusState?.activityLabel ?? "running"}`);
          }
        }
      }
    } else if (cmd === "send") {
      const id = args[1];
      const prompt = args.slice(2).join(" ");
      if (!id || !prompt) {
        console.error("Error: send requires <id> <prompt>");
        process.exit(1);
      }
      await client.send(id, prompt);
      console.log(`Sent task to ${id}`);
    } else if (cmd === "interrupt") {
      const target = args[1];
      if (!target) {
        console.error("Error: interrupt requires <id|name>");
        process.exit(1);
      }
      await client.interrupt({ id: target, name: target });
      console.log(`Interrupted ${target}`);
    } else {
      usage();
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
