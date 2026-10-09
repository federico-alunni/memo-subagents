#!/usr/bin/env node

// CLI wrapper around the pi-memo-subagents session socket (see docs/socket.md).
// Plain JavaScript on purpose: Node does not strip TypeScript types under node_modules, so an installed
// package cannot import client.ts from here.

import { createConnection } from "node:net";

class SubagentClient {
  constructor() {
    this.socketPath = process.env.PI_SUBAGENT_SOCKET ?? "";
    this.token = process.env.PI_SUBAGENT_SOCKET_TOKEN ?? "";
    this.callerId = process.env.PI_SUBAGENT_ID;
    if (!this.socketPath) throw new Error("No subagent socket available (PI_SUBAGENT_SOCKET is not set)");
  }

  request(method, params = {}) {
    const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const payload = `${JSON.stringify({ id, token: this.token, callerId: this.callerId, method, params })}\n`;
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(payload));
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline).trim();
        socket.end();
        try {
          const response = JSON.parse(line);
          if (response.ok) resolve(response.result);
          else reject(new Error(response.error ?? "Subagent socket request failed"));
        } catch {
          reject(new Error(`Invalid response from subagent socket: ${line}`));
        }
      });
      socket.on("error", reject);
    });
  }

  spawn(params) { return this.request("spawn", params); }
  list() { return this.request("list"); }
  send(id, prompt) { return this.request("send", { id, prompt }); }
  interrupt(target) { return this.request("interrupt", target); }
}

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
