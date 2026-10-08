// Private Unix domain socket server for script and CLI access to pi-memo-subagents.
// Exposes `spawn`, `list`, `send`, `interrupt` over newline-delimited JSON.
// Guarded by a random token in `PI_SUBAGENT_SOCKET_TOKEN`.

import { createServer, Socket, Server } from "node:net";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface SessionSocketHandlers {
  spawn(callerId: string | undefined, params: Record<string, unknown>): Promise<unknown>;
  list(): Promise<unknown>;
  send(id: string, prompt: string, options?: { taskId?: string }): Promise<unknown>;
  interrupt(target: { id?: string; name?: string }): Promise<unknown>;
}

export interface SessionSocketServer {
  socketPath: string;
  token: string;
  close(): Promise<void>;
}

export async function startSessionSocket(handlers: SessionSocketHandlers): Promise<SessionSocketServer> {
  const token = randomBytes(16).toString("hex");
  const baseDir = join(tmpdir(), `pi-subagent-${process.pid}-${randomBytes(4).toString("hex")}`);
  mkdirSync(baseDir, { mode: 0o700, recursive: true });
  const socketPath = join(baseDir, "subagent.sock");

  let server: Server;
  await new Promise<void>((resolve, reject) => {
    server = createServer((client: Socket) => {
      client.unref();
      let buffer = "";
      client.setEncoding("utf8");

      client.on("data", async (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let reqId = "req";
          try {
            const req = JSON.parse(trimmed);
            reqId = typeof req.id === "string" ? req.id : "req";

            if (req.token !== token) {
              client.write(JSON.stringify({ id: reqId, ok: false, error: "invalid_token" }) + "\n");
              continue;
            }

            const method = req.method;
            const params = (req.params ?? {}) as Record<string, unknown>;
            const callerId = typeof req.callerId === "string" ? req.callerId : undefined;

            let result: unknown;
            if (method === "spawn") {
              result = await handlers.spawn(callerId, params);
            } else if (method === "list") {
              result = await handlers.list();
            } else if (method === "send") {
              const id = String(params.id ?? "");
              const prompt = String(params.prompt ?? "");
              const options = params.options as { taskId?: string } | undefined;
              result = await handlers.send(id, prompt, options);
            } else if (method === "interrupt") {
              result = await handlers.interrupt(params as { id?: string; name?: string });
            } else {
              client.write(JSON.stringify({ id: reqId, ok: false, error: `unknown_method: ${method}` }) + "\n");
              continue;
            }

            client.write(JSON.stringify({ id: reqId, ok: true, result }) + "\n");
          } catch (err: any) {
            client.write(
              JSON.stringify({
                id: reqId,
                ok: false,
                error: err?.message ?? String(err),
              }) + "\n",
            );
          }
        }
      });
    });

    server.on("error", reject);
    server.listen(socketPath, () => {
      server.unref();
      resolve();
    });
  });

  return {
    socketPath,
    token,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        if (existsSync(socketPath)) unlinkSync(socketPath);
        if (existsSync(baseDir)) rmSync(baseDir, { recursive: true, force: true });
      } catch {
        // cleanup best-effort
      }
    },
  };
}
