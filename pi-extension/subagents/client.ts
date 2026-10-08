// Client for the pi-memo-subagents session socket (NDJSON over Unix domain socket).

import { createConnection, Socket } from "node:net";

export interface SubagentClientOptions {
  socketPath?: string;
  token?: string;
  callerId?: string;
}

export interface SubagentSpawnParams {
  name: string;
  task: string;
  agent?: string;
  model?: string;
  thinking?: string;
  tools?: string;
  skills?: string;
  systemPrompt?: string;
  cwd?: string;
  worktree?: boolean;
  worktreeSpace?: boolean;
  worktreeBranch?: string;
  worktreeBase?: string;
  worktreePath?: string;
  spawning?: boolean;
  spawningDepth?: number;
  handoff?: "wait" | "replace";
  fork?: boolean;
  interactive?: boolean;
  [key: string]: unknown;
}

export class SubagentClient {
  readonly socketPath: string;
  readonly token: string;
  readonly callerId?: string;

  constructor(options?: SubagentClientOptions) {
    this.socketPath = options?.socketPath ?? process.env.PI_SUBAGENT_SOCKET ?? "";
    this.token = options?.token ?? process.env.PI_SUBAGENT_SOCKET_TOKEN ?? "";
    this.callerId = options?.callerId ?? process.env.PI_SUBAGENT_ID;
    if (!this.socketPath) {
      throw new Error("No subagent socket available (PI_SUBAGENT_SOCKET is not set)");
    }
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const payload = JSON.stringify({
      id,
      token: this.token,
      callerId: this.callerId,
      method,
      params,
    }) + "\n";

    return new Promise<T>((resolve, reject) => {
      let client: Socket;
      try {
        client = createConnection(this.socketPath);
      } catch (err) {
        return reject(err);
      }

      let buffer = "";
      client.setEncoding("utf8");

      client.on("connect", () => {
        client.write(payload);
      });

      client.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          client.end();
          try {
            const resp = JSON.parse(line);
            if (resp.ok) {
              resolve(resp.result as T);
            } else {
              reject(new Error(resp.error ?? "Subagent socket request failed"));
            }
          } catch (err) {
            reject(new Error(`Invalid response from subagent socket: ${line}`));
          }
        }
      });

      client.on("error", (err) => {
        reject(err);
      });
    });
  }

  async spawn(params: SubagentSpawnParams): Promise<any> {
    return this.request("spawn", params as Record<string, unknown>);
  }

  async list(): Promise<any[]> {
    return this.request("list");
  }

  async send(id: string, prompt: string, options?: { taskId?: string }): Promise<void> {
    return this.request("send", { id, prompt, options });
  }

  async interrupt(target: { id?: string; name?: string }): Promise<void> {
    return this.request("interrupt", target);
  }
}
