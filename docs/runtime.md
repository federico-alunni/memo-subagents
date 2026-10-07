# Agent runtime (`memo-subagents/runtime`)

A library for **code** (not for the model) that launches and controls pi children in Herdr panes with exact
identities and durable evidence. It is the single agent-launching infrastructure: the memo `subagent` tool and
other packages (pi-issue-round) are clients of it.

```ts
import { AgentRuntime, RuntimeError } from "memo-subagents/runtime";
```

The library imports no pi package at runtime (types only) and keeps no global state except two display/observer
registries keyed with `Symbol.for(...)` (see [Presence](#presence-widget) and [watch](#watch)). Everything
authoritative lives on disk under the caller's `stateDir`. The caller (coordinator) owns tasks, approvals,
scheduling and its own durable state; runtime records are **evidence**, not another state machine.

## Consuming it from another package

```json
"dependencies": { "memo-subagents": "file:../memo-subagents" }
```

Import only `memo-subagents/runtime` (never the extension entry). Under pi, extensions are loaded with jiti and
TypeScript works from anywhere. Node's own type stripping (e.g. `node --experimental-strip-types --test`) refuses
`.ts` files **inside `node_modules`**: a `file:` dependency is a symlink whose real path is outside `node_modules`,
so tests keep working; a copied install (git/npm tarball) needs a TypeScript loader in the test runner.

## Guarantees

1. **No replay.** Each `(scope, agentId, attempt)` gets one exclusive attempt directory (`mkdir`, never reused).
   An uncertain launch/dispatch is reported as uncertain with evidence, never retried.
2. **No prompt replay.** The child publishes an immutable `accepted` record *before* delivering a prompt;
   reloads and restarts never deliver it again.
3. **Exact identity.** Pane/terminal/tab/workspace returned by Herdr, shell PID + controlling tty + `ps lstart/command`,
   child PID + process identity, session id/path, cwd, model and thinking verified by the child itself.
   Any mismatch blocks control (`changed` / `cleanup_blocked`); nothing is adopted.
4. **Private, immutable evidence.** 0700 directories, 0600 records, atomic publication (temp + fsync + link),
   outside the child's cwd.
5. **Proven shutdown.** `stop` requires the child's acknowledgement **and** the observed exit of the exact PID;
   `close` requires the original empty shell and an observed `pane_not_found`. No broad kill, no forced close.
6. **User takeover** (typed input, user bash, model/thinking change in the child pane) blocks automatic control.
7. **Injectable runner.** Every external command (`herdr`, `pi`, `ps`) goes through `RuntimeConfig.runner`;
   tests never execute real binaries.

These are workflow guarantees, **not an OS sandbox**: children keep the user's permissions.

## Configuration

```ts
interface RuntimeConfig {
  /** Private (0700) state root, outside every child cwd. Attempts live in <stateDir>/runtime/<sha256>. */
  stateDir: string;
  /** PI_CODING_AGENT_DIR for children (models.json, auth). Default: private <stateDir>/runtime/profile. */
  agentDir?: string;
  /** Absolute extensions loaded with -e after the runtime child extension (e.g. a provider). */
  hostExtensions?: string[];
  /** Environment forwarded to children. MEMO_RUNTIME_* and PI_CODING_AGENT_DIR are refused. */
  hostEnv?: Record<string, string>;
  piExecutable?: string;       // "pi"
  herdrExecutable?: string;    // "herdr"
  runner?: Runner;             // nodeRunner (execFile, no shell)
  shellReadyTimeoutMs?: number; // 15000
  startupTimeoutMs?: number;    // 15000
  shutdownTimeoutMs?: number;   // 5000
}

/** MEMO_SUBAGENTS_CHILD_EXTENSIONS (':'-separated) / MEMO_SUBAGENTS_CHILD_ENV (comma-separated names). */
function hostCompositionFromEnv(env?: NodeJS.ProcessEnv): { hostExtensions: string[]; hostEnv: Record<string, string> };

type Runner = (input: { executable: string; argv: string[]; cwd?: string; env?: Record<string, string>; timeoutMs?: number })
  => Promise<{ stdout: string; stderr?: string; exitCode: number }>;
```

## Launch

```ts
interface LaunchSpec {
  scope: string;              // e.g. a round id; with agentId+attempt identifies the attempt
  agentId: string;
  attempt: number;            // positive integer
  labels?: Record<string, string | number>; // opaque (e.g. role, issue): stored in boot and handle, never interpreted
  taskId: string;
  prompt: string;             // private file input; never part of the shell command
  cwd: string;
  model: string;              // exact provider/model-id
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  isolation?: "isolated";     // -ne -ns -np --no-approve --no-themes (only mode in this version)
  tools: string[];            // allowlist: --tools, setActiveTools and a tool_call block in the child
  bash?: "unrestricted" | "readonly"; // readonly: one plain argv from an explicit read-only allowlist
  question?: boolean;         // enables the `question` tool (asks the human in the child's pane)
  delegatedTools?: DelegatedToolSpec[];
  appendSystemPrompt?: string[]; // files passed with --append-system-prompt
  placement?: "split-right" | "split-down" | "tab" | "worktree"; // default "tab"
  display: {
    label: string;            // widget row / tab label
    group?: string;           // widget group title (default group = generic subagents)
    agentsPanelName?: string; // Herdr Agents panel name (default: "└─ <label>" under the caller pane)
  };
}

interface DelegatedToolSpec {
  name: string;
  label?: string;
  description: string;
  parameters: object;          // JSON Schema of the arguments
  once?: "per-task";           // deterministic requestId `${taskToken}-${name}`: at most one request per task
  timeoutMs?: number;          // default 300000; afterwards the child gets an "outcome uncertain" error, never a retry
}
```

- `placement: "worktree"` opens the **existing** checkout `cwd` as a Herdr worktree space under the caller's
  workspace (`herdr worktree open`); a clean Herdr refusal falls back to a tab. The runtime never creates git
  worktrees.
- `tools` never implicitly includes delegated tools or `question`: they are added when declared/enabled.
- Launch requires the pi CLI to advertise `--session-id --session-dir --no-extensions --no-skills
  --no-prompt-templates --no-approve` before any pane is created.

## API

```ts
class AgentRuntime {
  constructor(config: RuntimeConfig);
  launch(spec: LaunchSpec): Promise<AgentHandle>;
  dispatch(h: AgentHandle, task: { taskId: string; prompt: string }): Promise<AgentHandle>;
  observe(h: AgentHandle): Promise<Observation>;
  watch(h: AgentHandle, onObservation: (o: Observation) => void | Promise<void>, intervalMs?: number): () => void;
  drainRequests(h: AgentHandle): Promise<ChildRecord[]>;
  respond(h: AgentHandle, requestId: string, result: unknown): Promise<void>;
  hasResponse(h: AgentHandle, requestId: string): Promise<boolean>;
  interrupt(h: AgentHandle): Promise<void>;
  stop(h: AgentHandle): Promise<void>;
  close(h: AgentHandle): Promise<void>;
  inspectShutdown(h: AgentHandle): Promise<{ acknowledged: boolean; exited: boolean; takenOver: boolean }>;
  focus(h: AgentHandle, target: "child" | "parent"): Promise<boolean>;
  annotate(h: AgentHandle, note: { status?: string; active?: boolean }): void; // display only
  forget(h: AgentHandle): void;                                                 // display only
  dispose(): void;                                                              // observers only, never kills children
}
```

| Method | Contract |
| --- | --- |
| `launch` | Persist your launch intent **before** calling and the returned handle **before** advancing. Errors: `unsupported` (nothing created), `launch_failed` (definitely not launched: nothing typed, our unused pane closed and observed gone), `launch_uncertain` (evidence `{protocolDir, paneId?, phase, evidenceError?}`; inspect, never relaunch the same attempt). |
| `dispatch` | Requires the current task to be observed `settled` and a never-used `taskId`. Returns a **new handle** (same pane/process/session, new `taskToken`) that must replace the stored one. `dispatch_uncertain` carries the next handle; never replay. Old handles observe `changed`. |
| `observe` | `kind`: `starting`, `active`, `settled`, `missing`, `unavailable`, `changed`, `taken-over`, `stopped`. Plus `accepted?`, `completion?` (`status: success \| error \| interrupted`, `summary?`, `error?`, `recordId`), `requests`, `question?` (`{id, text, pending}`), `exited?`. Completion is child evidence, not proof of correctness. Repeated observations return the same `recordId`. |
| `watch` | One observer per agent (process-wide); private directory events + bounded health probe; callback only on change. Dispose the old observer before watching a new handle of the same agent. |
| `drainRequests` | Non-destructive: valid delegated-tool requests of the **current** task (`kind: "request"`, `tool`, `params`, `requestId`). Deduplicate in your own durable store. |
| `respond` | Exclusive (`EEXIST` = already answered; acquire, never overwrite). Unknown/stale request → `busy`. |
| `interrupt` | Writes a correlated request; the child aborts once and acknowledges. Not proof: wait for `settled` with `interrupted`. |
| `stop` | Refuses active tasks: interrupt and observe settlement first. Timeout → `cleanup_uncertain` (pane retained). |
| `close` | After `stop`. Checks shell/tty/occupant, closes only that pane, verifies `pane_not_found`. |
| `focus` | Display only, split placements: moves focus between caller and child if the layout still matches. |

Error codes (`RuntimeError.code`): `unsupported`, `launch_uncertain`, `launch_failed`, `dispatch_uncertain`,
`cleanup_blocked`, `cleanup_uncertain`, `busy`.

### Handle

```ts
interface AgentHandle {
  scope: string; agentId: string; attempt: number; labels?: Record<string, string | number>;
  taskId: string; taskToken: string; nonce: string;
  sessionId: string; sessionPath: string;
  paneId: string; terminalId: string; tabId: string; workspaceId: string;
  pid: number; processIdentity: string; shellPid: number; shellProcessIdentity?: string; tty: string;
  cwd: string; protocolDir: string;
  parentPaneId?: string; placement?: "split-right" | "split-down"; // display/focus only
}
```

Persist handles verbatim. Helpers for reconciliation: `sameAgent`, `sameTask`, `validTask`, `taskKey`,
`readProcessTerminal`, `processIdentity`.

## Child side

Children run `pi --session-id <id> --session-dir <attempt>/sessions --model <m> --thinking <t> -ne -e <runtime child
extension> [-e host…] -ns -np --no-approve --no-themes --tools <allowlist> [--append-system-prompt <file>…]` with
`PI_CODING_AGENT_DIR=<agentDir>` and `MEMO_RUNTIME_PROTOCOL_DIR / _NONCE / _SCOPE / _AGENT_ID / _ATTEMPT`.

The child extension: verifies boot identity, model, thinking, session and cwd; publishes `ready`; accepts each task
exactly once; publishes `settled` only on `agent_settled` (provider errors and aborts stay distinct; no assistant
outcome is an error); handles interrupt/shutdown requests; records takeover; enforces the tool allowlist and the
read-only bash guard; registers the declared delegated tools and, if enabled, `question`.

## Evidence layout

`<stateDir>/runtime/<sha256(scope\0agentId\0attempt)>/`:
`launch-NNNN-<phase>.json` (launch phases), `boot.json`, `ready.json`, `task.json` (current, replaced),
`<key>.dispatch.json`, `<key>.accepted.json`, `<key>.settled.json` (key = sha256(taskId)),
`<key>.request.json` / `<key>.response.json` (key = sha256(requestId)), `interrupt.json` / `interrupt-ack.json`,
`shutdown.json` / `shutdown-ack.json`, `takeover.json`, `question.json`, `prompts/`, `sessions/`.

## Presence (widget)

Every agent launched by any `AgentRuntime` in the process appears in the memo-subagents widget. The registry
(`Symbol.for("memo-subagents/runtime-presence")`) is display-only and shared even if the module is loaded twice.
The runtime updates rows itself (launch, observe/watch, dispatch, stop, close); clients add workflow state with
`annotate` (e.g. `{ status: "in verifica", active: false }`) and can retire a row early with `forget`.
Rows are grouped by `display.group`. Rows of other clients are not selectable in the pane selector.

```ts
interface PresenceEntry {
  key: string; group?: string; label: string; model: string; thinking: string;
  paneId?: string; startedAt: number; state: Observation["kind"] | "launching" | "launch-uncertain";
  status?: string; active?: boolean; questionPending?: boolean; updatedAt: number;
}
function presence(): { list(): PresenceEntry[]; subscribe(listener: () => void): () => void };
```
