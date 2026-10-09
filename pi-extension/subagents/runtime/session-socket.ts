// Private Unix domain socket server for script and CLI access to pi-memo-subagents.
// Exposes `spawn`, `list`, `send`, `interrupt` over newline-delimited JSON.
//
// Authentication is by token (`PI_SUBAGENT_SOCKET_TOKEN`) and the token decides who is calling:
//   - the session token (main session and its own tools): full rights; it may name a `callerId`;
//   - an agent token `<id>.<mac>` (given to each subagent's process): the caller IS that agent.
//     A subagent therefore always acts with its own rights, whatever `callerId` it sends.

import { createServer, Socket, Server } from "node:net";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** `callerId` is undefined for the session itself, else the subagent making the request. */
export interface SessionSocketHandlers {
  spawn(callerId: string | undefined, params: Record<string, unknown>): Promise<unknown>;
  list(callerId: string | undefined): Promise<unknown>;
  send(callerId: string | undefined, id: string, prompt: string, options?: { taskId?: string }): Promise<unknown>;
  interrupt(callerId: string | undefined, target: { id?: string; name?: string }): Promise<unknown>;
}

export interface SessionSocketServer {
  socketPath: string;
  /** Session token: full rights. Never give it to a subagent. */
  token: string;
  /** Token for the process of subagent `id`: requests made with it act as that subagent. */
  agentToken(id: string): string;
  close(): Promise<void>;
}

/** Who a token authenticates: the session (`{}`), a subagent (`{ agentId }`), or nobody (undefined). */
export function tokenCaller(sessionToken: string, secret: Buffer, presented: unknown): { agentId?: string } | undefined {
  if (typeof presented !== "string" || !presented) return undefined;
  const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  if (same(presented, sessionToken)) return {};
  const dot = presented.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const agentId = presented.slice(0, dot);
  return same(presented.slice(dot + 1), agentMac(secret, agentId)) ? { agentId } : undefined;
}

function agentMac(secret: Buffer, id: string): string {
  return createHmac("sha256", secret).update(id).digest("hex");
}

export async function startSessionSocket(handlers: SessionSocketHandlers): Promise<SessionSocketServer> {
  const token = randomBytes(16).toString("hex");
  const secret = randomBytes(32);
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

            const caller = tokenCaller(token, secret, req.token);
            if (!caller) {
              client.write(JSON.stringify({ id: reqId, ok: false, error: "invalid_token" }) + "\n");
              continue;
            }
            const requested = typeof req.callerId === "string" && req.callerId ? req.callerId : undefined;
            if (caller.agentId && requested && requested !== caller.agentId) {
              client.write(JSON.stringify({ id: reqId, ok: false, error: "caller_mismatch" }) + "\n");
              continue;
            }
            // A subagent always acts as itself; the session may act for a subagent it names.
            const callerId = caller.agentId ?? requested;

            const method = req.method;
            const params = (req.params ?? {}) as Record<string, unknown>;

            let result: unknown;
            if (method === "spawn") {
              result = await handlers.spawn(callerId, params);
            } else if (method === "list") {
              result = await handlers.list(callerId);
            } else if (method === "send") {
              const id = String(params.id ?? "");
              const prompt = String(params.prompt ?? "");
              const options = params.options as { taskId?: string } | undefined;
              result = await handlers.send(callerId, id, prompt, options);
            } else if (method === "interrupt") {
              result = await handlers.interrupt(callerId, params as { id?: string; name?: string });
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
    agentToken: (id: string) => `${id}.${agentMac(secret, id)}`,
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
