# Session socket

The main session serves a private Unix socket so scripts and CLIs (for example a workflow tool run from a
subagent's `bash`) can drive subagents without a model turn. The subagent tool stays the way an LLM uses it;
the socket is for programs.

```text
PI_SUBAGENT_SOCKET        path of the socket (directory 0700)
PI_SUBAGENT_SOCKET_TOKEN  token: the session's in the main session, the agent's own in a subagent
PI_SUBAGENT_ID            id of the subagent a process belongs to (unset in the main session)
```

## Protocol

Newline-delimited JSON, one response per request:

```json
{ "id": "r1", "token": "…", "callerId": "optional", "method": "spawn", "params": { … } }
{ "id": "r1", "ok": true, "result": … }            // or { "id": "r1", "ok": false, "error": "…" }
```

| Method | Params | Result |
|---|---|---|
| `spawn` | the `subagent` tool parameters, plus `worktreePath` and `group` | `{ id, name, surface, worktree, sessionFile }` (main) / `{ id }` (from a subagent) |
| `list` | – | running subagents: `id, name, agent, group, slot, worktree, sessionFile, lifecycle, status` |
| `send` | `{ id, prompt, options?: { taskId } }` | `{ ok, taskId }` (a new task for an idle subagent) |
| `interrupt` | `{ id }` or `{ name }` | `{ ok, id }` |

## Who is calling

The token decides it:

- **Session token** (main session and its tools): full rights. It may name a `callerId` to act for that subagent.
- **Agent token** `<id>.<mac>`, given to each subagent's process: the request acts as that subagent. A different
  `callerId` is refused (`caller_mismatch`). `spawn` follows the subagent's own rights, exactly like its
  `subagent` tool: `delegate` needs `spawning`, `wait`/`replace` need a worktree space. `send`/`interrupt` reach
  only the subagent itself and the agents it started.

Anything else is `invalid_token`.

## Groups

`group` (scripts only) tags an agent; the agents it starts inherit it. A panel supplied with the same `group`
(see [panel.md](panel.md)) shows them and stays visible while one of them is alive.

## Client

```ts
import { SubagentClient } from "pi-memo-subagents/client";
const client = new SubagentClient();             // reads the three variables above
await client.spawn({ name: "w1", task: "…", group: "run-42" });
```

CLI: `pi-subagent <method> '<json params>'` prints the JSON result.
