# Agent runtime (`pi-memo-subagents/runtime`)

A library for **code** (not for the model) that launches and controls pi children in Herdr panes with exact
identities and durable evidence. It is the single agent-launching infrastructure: the memo `subagent` tool
(`isolation: "profile"`, `userInput: "allowed"`, exit `auto`/`tool`, seeded session files) and other packages
(pi-issue-round, isolated workflow agents) are clients of it, and all share the widget (see [Presence](#presence-widget)).

```ts
import { AgentRuntime, RuntimeError } from "pi-memo-subagents/runtime";
```

The library imports no pi package at runtime (types only) and keeps no global state except two display/observer
registries keyed with `Symbol.for(...)` (see [Presence](#presence-widget) and [watch](#watch)). Everything
authoritative lives on disk under the caller's `stateDir`. The caller (coordinator) owns tasks, approvals,
scheduling and its own durable state; runtime records are **evidence**, not another state machine.

## Consuming it from another package

```json
"dependencies": { "pi-memo-subagents": "git+https://github.com/federico-alunni/pi-memo-subagents.git#semver:^0.3.0" }
```

Import only `pi-memo-subagents/runtime` (never the extension entry). Under pi, extensions are loaded with jiti and
TypeScript works from anywhere. Node's own type stripping (e.g. `node --experimental-strip-types --test`) refuses
`.ts` files **inside `node_modules`**: a git/npm install, or a `file:` link whose real path is inside `node_modules`,
needs a TypeScript loader in the test runner (see `test/host-aliases.mjs` for a `registerHooks` + `stripTypeScriptTypes` one).

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
  /** Environment forwarded to children. PI_MEMO_RUNTIME_* and PI_CODING_AGENT_DIR are refused. */
  hostEnv?: Record<string, string>;
  piExecutable?: string;       // "pi"
  herdrExecutable?: string;    // "herdr"
  runner?: Runner;             // nodeRunner (execFile, no shell)
  shellReadyTimeoutMs?: number; // 15000
  startupTimeoutMs?: number;    // 15000
  shutdownTimeoutMs?: number;   // 5000
}

/** PI_MEMO_SUBAGENTS_CHILD_EXTENSIONS (':'-separated) / PI_MEMO_SUBAGENTS_CHILD_ENV (comma-separated names). */
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
  labels?: Record<string, string | number>; // opaque (e.g. role, issue): stored in boot and handle, part of the owned identity
  taskId: string;
  prompt: string;             // private file input; never part of the shell command
  cwd: string;
  model: string;              // exact provider/model-id
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  isolation?: "isolated" | "profile"; // isolated (default): -ne -ns -np --no-approve --no-themes; profile: normal profile
  agentDir?: string;          // PI_CODING_AGENT_DIR of this child (existing dir, used as is); overrides RuntimeConfig.agentDir
  tools?: string[];           // allowlist (--tools, setActiveTools, tool_call block); required when isolated
  denyTools?: string[];       // deactivated and blocked, also without an allowlist
  userInput?: "takeover" | "allowed"; // default takeover: manual input/user bash/model change blocks automatic control
  exit?: "parent" | "auto" | "tool";   // default parent: see "Exit policy"
  skills?: string[];          // sent as /skill:<name> messages before the first prompt, in the same run
  session?: { kind: "new" } | { kind: "file"; path: string }; // file: existing or seeded session, opened with --session
  env?: Record<string, string>; // extra child environment (same rules as hostEnv)
  bash?: "unrestricted" | "readonly"; // readonly: one plain argv from an explicit read-only allowlist
  bashAllow?: string[];       // readonly only: extra exact word prefixes, e.g. ["npm test", "gh issue view"]
  bashAsk?: boolean;          // readonly + userInput "allowed" only: ask the user instead of blocking (see "Bash policy")
  question?: boolean;         // isolated children: loads and allows the `question` tool (pi-memo-question)
  askParent?: boolean;        // userInput "allowed" only: the parent can be asked (see "Ask-parent"); default false
  askParentDefault?: boolean; // with askParent: questions without `to` and bash approvals go to the parent first; default false
  delegatedTools?: DelegatedToolSpec[];
  appendSystemPrompt?: string[]; // absolute, readable files passed with --append-system-prompt
  systemPrompt?: string;      // absolute, readable file passed with --system-prompt (replaces pi's prompt)
  placement?: "split-right" | "split-down" | "tab" | "worktree" | "auto" | "visible"; // default "tab"; see "Pane selector"
  splitTarget?: string;       // split placements only: target pane id to split (default caller pane)
  splitRatio?: number;        // split placements only: ratio (0..1 exclusive) the target keeps
  spaceRoot?: string;         // "worktree" placement only: root directory to open when cwd is a subdirectory
  viewer?: { script: string; args?: string[]; env?: Record<string, string> }; // read-only viewer program (no model/presence)
  display: {
    label: string;            // widget row / tab label
    group?: string;           // widget group title (default group = generic subagents)
    agentsPanelName?: string; // Herdr Agents panel name (default: "<caller workspace>-<caller tab>-sub<n>")
  };
}

interface DelegatedToolSpec {
  name: string;
  label?: string;
  description: string;
  parameters: object;          // JSON Schema of the arguments
  once?: "per-task";           // deterministic requestId `${taskToken}-${name}`: at most one request per task
  timeoutMs?: number;          // default 300000; afterwards the child gets an "outcome uncertain" error
}
```

- `placement: "worktree"` opens the **existing** checkout `cwd` as a Herdr worktree space under the caller's
  workspace (`herdr worktree open`); a clean Herdr refusal falls back to a tab. The runtime never creates git
  worktrees.
- `tools` never implicitly includes delegated tools or `question`: they are added when declared/enabled.
  `question` cannot be listed in `tools` together with `question: true`; delegated tool names must be unique and
  may not reuse a `tools` entry, `question`, an exit tool or a pi built-in (`read`, `bash`, `edit`, `write`, `grep`,
  `find`, `ls`).
- **Delegated tool arguments are untrusted model input.** The runtime only checks that the tool was declared and
  that the request belongs to the current task; the client validates `params` (e.g. `params.taskId === h.taskId`)
  and answers with an error result when they are wrong.
- `once: "per-task"` gives one request per task: a repeated call with the same arguments acquires the same answer,
  a call with other arguments fails in the child. Without `once`, every tool call is a new request (id
  `${taskToken}-${name}-${toolCallId}`): after an "outcome uncertain" timeout the model may call again, so such
  tools must be idempotent or deduplicated by the client.
- `unsupported` errors create nothing: the attempt directory is allocated only after every validation (policy,
  files, extensions, environment, pi CLI flags).
- `labels` are compared with `boot.json` on every ownership check: a handle with other labels is not this agent.
- Tool names (allowlist, deny list, delegated tools) are plain names `[A-Za-z0-9_-]`; patterns are not accepted.
- An empty task (no prompt, no skills — e.g. resuming a session without a message) sends nothing: it is accepted
  and settled at once with `success`, and the user drives the child.
- Skills are sent as `/skill:<name>` messages; the first message starts the run and the others (more skills, then
  the prompt) are queued as follow-ups once pi reports the run started, so the whole task is one run.
- Launch requires the pi CLI to advertise `--session-id --session-dir --no-extensions --no-skills
  --no-prompt-templates --no-approve` before any pane is created.

### Bash policy

- `bash: "readonly"` accepts one plain argv (no pipes, redirections, quotes, globs, `$`, `#` comments) from an
  explicit read-only allowlist (`git log/show/diff/status`, `rg`, `cat`, `ls`, …); anything else is blocked with
  guidance for the model.
- `bashAllow` adds exact word prefixes on top of it: `"npm test"` allows `npm test` and `npm test -- --grep x`,
  not `npm testx` or `npm run build`. The command must still be one plain argv. Entries are trimmed and
  whitespace-normalized; each must be plain words (`[A-Za-z0-9_./,:+=@%~^-]`). Non-empty `bashAllow` requires
  `bash: "readonly"`, otherwise `unsupported`.
- `bashAsk: true` (requires `bash: "readonly"` and `userInput: "allowed"`, otherwise `unsupported`): a plain
  command outside the allowlist and `bashAllow` is asked in the child's pane (`ctx.ui.select`), options in this
  order: `Rifiuta` (default), `Permetti una volta`, `Permetti sempre in questa sessione dell'agente`. "Always" allows
  later commands with the same first two words (or the same single word) for the rest of that child process only;
  it is never persisted. Questions are asked one at a time. No UI (`ctx.hasUI` false), cancel or abort → blocked;
  commands with shell grammar are blocked without asking. Workflow children (`takeover`) never ask.
- With `askParentDefault` the same `ask` command goes to the parent agent first (see [Ask-parent](#ask-parent)); the
  approvals stay serialized one at a time. A `block` command (shell grammar, outside the policy) is never sent. The
  child re-checks every decision that comes back against `bashDecision`: only a command it would have asked about
  may run, `once` passes that call only, and `always` is applied only when a user gave it (a parent agent's `always`
  is never applied). The bash result (allowed) or block reason records who decided.
- Boot records without `bashAllow`/`bashAsk` (0.2.0) mean `[]`/`false`; without `askParent`, `false`; without
  `askParentDefault`, the value of `askParent` (records written when ask-parent meant "parent first").

### Exit policy and user input

- `exit: "parent"` (workflow agents): the child never ends itself; the parent uses `stop` + `close`.
- `exit: "auto"`: after every normal run (a task or a user turn) the child publishes an immutable `exit` record
  (`reason: "done"`, or `"error"` with the provider error) and the usual `shutdown-ack`, then exits. An aborted run
  (Escape) leaves it open. It also gets the `subagent_done` and `caller_ping` tools.
- `exit: "tool"`: the child ends only through `subagent_done` (`reason: "done"`) or `caller_ping`
  (`reason: "ping"`, `message`), or when the user quits pi.
- `caller_ping` ends the child and hands the conversation to the parent. With `askParent` a question or bash
  approval does **not**: the child stays alive and waits for the correlated answer (no `exit` record).
- `observe` reports the record as `exit`; after it the agent observes `stopped` and `close` works as usual.
- `userInput: "allowed"` (user-driven subagents): typing, user bash and model/thinking changes in the child pane do
  not block control, and a child that ended because the user quit pi (no acknowledgement) can still be closed.
- `subagent_done` and `caller_ping` exist only through the exit policy; they cannot be listed in `tools` or
  declared as delegated tools.

### Question

There is one `question` tool, from the **pi-memo-question** package (a dependency of pi-memo-subagents, also installed
for the main agent). The runtime adds its extension with `-e` (real path, so pi loads it once even if the profile
installs the package too):

- isolated children: only with `question: true` (which also adds `question` to the allowlist); `question: true`
  without the package is `unsupported`;
- profile children: always, so a profile without the package (e.g. pi-ir's) still has it; it is usable when there is
  no allowlist or the allowlist lists `question`.

While its dialog is open the tool emits `memo-question` on `pi.events`; the child extension turns it into the
`question.json` record of the active task (pending, then answered with the chosen label or `""` when cancelled), so
`observe` reports `question` for every child, and the tool also emits `herdr:blocked`. The answer itself stays in
the child session.

The extension is always the **installed** pi-memo-question (resolved from the user's `settings.json` packages or pi's
git checkout; `config.questionExtension` overrides it): profile children get it with the profile and `-e` names the
same real path, so pi loads it once. The runtime never loads a copy of its own. With `askParent` the child extension
registers a router through the package's hook (`globalThis[Symbol.for("pi-memo-question/router")]`, pi-memo-question
`src/router.ts`): the tool asks it for `to: "parent"` (and without `to` when `askParentDefault`), the router sends the
question to the parent and returns the answer, or tells the tool to open its dialog in the child's pane when the parent
cannot answer. The result text says who answered (`The parent agent selected: 1. …`) and `details.answeredBy` /
`details.answeredByText` record it.

### Waiting for the user (`herdr:blocked`, attention)

`herdr:blocked` on `pi.events` is the one signal of a child that waits for the user:
`{ active: true, label?: string, kind?: string, target?: "parent" | "user" }` when a dialog opens, `{ active: false }`
when it closes (always, also on cancel, error or abort). The `question` tool emits it without `kind` (= `"question"`);
the bash approval of `bashAsk` emits `kind: "approval"` with the command as `label`; any other `kind` is shown as
`blocked`. Ask-parent waits add `target` (who the child waits for) and a label that names it (`→ parent · <text>`,
`→ user · <text>`), so Herdr's blocked label shows the target too; a wait that moves (escalation, fallback) opens the
new one before closing the old one.

- The child extension counts open waits (they may overlap) and writes `attention` into `activity.json` at once
  (no throttle): `{ kind: "question" | "approval" | "blocked", label?, target?, since }` while at least one is open
  (latest kind/label/target, `since` of the first), removed when none is. `phase` is unchanged.
- **Profile** children load Herdr's own pi integration with their profile; it listens to the same event and marks
  the pane `blocked`.
- **Isolated** children (`-ne`) do not load it. Inside Herdr (`HERDR_ENV=1`, `HERDR_PANE_ID`) the child extension
  reports the pane state itself: `"$HERDR_BIN_PATH"` (or `herdr`) `pane report-agent <pane> --source memo-subagents
  --agent pi --state working|idle|blocked [--message=<label>] --seq <n>` on `agent_start`, idle `agent_settled` and
  attention changes, and `pane release-agent` on quit. Only the latest state is sent, `seq` grows from a timestamp,
  errors are ignored. Never in profile children.
- The parent reads attention from `activity.json` (a pending `question.json` as fallback): the widget row shows
  `❓ question <duration>` / `❓ approval <duration>`, with a target `❓ question → parent <duration>` /
  `❓ approval → user <duration>` (Herdr `blocked` alone: `blocked <duration>`), the row is not counted as active even
  when annotated `active: true`. A wait for the user is never notified to the parent agent; ask-parent requests are
  (see below).

### Ask-parent

`askParent: true` (user-driven children only; `false` by default, so boot records written before it and other clients
such as pi-issue-round keep their behaviour) lets the child ask its parent: `question` calls with `to: "parent"`, and
with `askParentDefault: true` also questions without `to` and `bashAsk` approvals. The memo `subagent` tool turns
`askParent` on for every child; `askParentDefault` follows the spawn parameter `askParent`, else the agent frontmatter
`ask-parent`, else `false`.

Transport (same `publish`/`validTask` primitives as delegated tools, tool name `ask_parent`, never a delegated tool):

1. the child publishes `<key>.request.json` (`kind: "request"`, `tool: "ask_parent"`, `requestId`, `params`:
   `{ kind: "question" | "approval", childId, childName, text, options? , command?, prefix?, origin? }`) for its
   current task and waits — it keeps running, there is no exit record;
2. the parent picks it up (`markAsk(h, id, { kind: "received" })`, exclusive), notifies its agent and may move it
   (`markAsk(h, id, { kind: "escalated", escalation: { target: "user" | "parent", reason } })`, replaced on change);
3. one exclusive `<key>.response.json` answers it: `{ answer, custom?, note?, by }` (question),
   `{ decision: "deny" | "once" | "always" | "cancel", note?, by }` (approval) or `{ fallback: true, reason }` (ask the
   user in the child's pane). `by` is `{ who: "parent" | "user", name?, id?, where?, reason?, forwardedBy? }`;
4. liveness: the parent refreshes `parent.json` (`{ pid, at, name, id, closed? }`) every 2 s and writes `closed` on
   quit/reload. The child falls back to its own pane at once when the record is closed, stale (6 s) or its process is
   gone, and when nobody picked the request up within 5 s (parent extension not loaded). A child that falls back, or
   whose turn is aborted, first claims the response slot itself, so a late parent answer is refused (`busy`).

The `subagent` extension (parent side):

- delivers each request to the parent agent as a steer message (`customType: "subagent_request"`, `triggerTurn`,
  `deliverAs: "steer"`) with the child id/name, kind, text and options or command, `requestId` and how to answer;
- `subagent_answer({ id, requestId, answer? | decision?, escalate?, note? })` checks that the request is pending for
  that child and answers it once. The parent agent may answer questions, `deny` or allow `once`; `always` is the
  user's decision only and escalates;
- escalates to the user when the parent asks (`escalate: true`), for `always`, and when the parent has not answered
  within `PI_MEMO_SUBAGENTS_ASK_PARENT_TIMEOUT_MS` (default 60000; invalid values fall back to it). The user answers in
  the **parent session**: one dialog for every pending escalation (one or more children), `←`/`→` to browse, each
  naming its child; questions use `pi-memo-question/dialog`, approvals the three options of the child pane. No UI in
  the parent session → fallback to the child's pane;
- nested agents: a runtime child with `askParent` that is itself a parent forwards an escalation (or timeout) one
  level up through its own child runtime (`origin` lists the descendants, `by.forwardedBy` the relays) instead of
  asking its user; only an agent that is not a runtime child (or whose own parent cannot be asked) shows it to the
  user. Every level answers within the same limits;
- after a `/reload` the requests the old instance picked up are answered with a fallback (the child asks in its pane).

### Sessions

`session: { kind: "file", path }` opens an existing session (resume) or one seeded by the caller (lineage/fork) with
`--session`; its header `id` becomes the handle's `sessionId` and the child must report exactly that file.
pi runs a session in its header's `cwd`: launch the child with that cwd. Identity compares real paths (the child
resolves symlinks in its cwd).
The runtime never starts two children on purpose on the same file: preventing it is the caller's job.

## API

```ts
class AgentRuntime {
  constructor(config: RuntimeConfig);
  launch(spec: LaunchSpec): Promise<AgentHandle>;
  dispatch(h: AgentHandle, task: { taskId: string; prompt: string; skills?: string[] }): Promise<AgentHandle>;
  observe(h: AgentHandle): Promise<Observation>;
  watch(h: AgentHandle, onObservation: (o: Observation) => void | Promise<void>, intervalMs?: number): () => void;
  drainRequests(h: AgentHandle): Promise<ChildRecord[]>;
  respond(h: AgentHandle, requestId: string, result: unknown): Promise<void>;
  pendingAsks(h: AgentHandle): Promise<PendingAsk[]>;  // ask-parent requests without a response
  markAsk(h: AgentHandle, requestId: string, mark: { kind: "received" } | { kind: "escalated"; escalation: AskEscalation }): Promise<boolean>;
  answerAsk(h: AgentHandle, requestId: string, result: AskResult): Promise<void>;
  askHeartbeat(h: AgentHandle, beat: { name: string; id: string; closed?: boolean }): Promise<void>;
  hasResponse(h: AgentHandle, requestId: string): Promise<boolean>;
  interrupt(h: AgentHandle): Promise<void>;
  stop(h: AgentHandle): Promise<void>;
  close(h: AgentHandle): Promise<void>;
  inspectShutdown(h: AgentHandle): Promise<{ acknowledged: boolean; exited: boolean; pidReused: boolean; takenOver: boolean }>;
  focus(h: AgentHandle, target: "child" | "parent"): Promise<boolean>;
  move(h: AgentHandle, to: { newTab: { label: string } } | { split: { targetPane: string; tab?: string; direction?: "right" | "down"; ratio?: number } }): Promise<AgentHandle>;
  activity(h: AgentHandle): ActivityReadResult; // display-only phase/tool/provider snapshot
  annotate(h: AgentHandle, note: { status?: string; active?: boolean }): void; // display only
  forget(h: AgentHandle): void;                                                 // display only
  dispose(): void;                                                              // observers only, never kills children
}
```

| Method | Contract |
| --- | --- |
| `launch` | Persist your launch intent **before** calling and the returned handle **before** advancing. Errors: `unsupported` (nothing created), `launch_failed` (definitely not launched: nothing typed, our unused pane closed and observed gone), `launch_uncertain` (evidence `{protocolDir, paneId?, phase, evidenceError?}`; inspect, never relaunch the same attempt). |
| `attemptAllocated(scope, agentId, attempt)` | Read-only: whether `launch` ever allocated the attempt's exclusive directory. `false` proves that attempt created nothing (no pane, no process), so a failed or interrupted launch can be retried with the same attempt; `true` means only a new attempt may launch. Any filesystem error other than `ENOENT` is thrown: no proof either way. Call it only when no launch of that attempt is still in flight. |
| `dispatch` | Requires the current task to be observed `settled` and a never-used `taskId`. Returns a **new handle** (same pane/process/session, new `taskToken`) that must replace the stored one. `dispatch_uncertain` carries the next handle; never replay. Old handles observe `changed`. |
| `observe` | `kind`: `starting`, `active`, `settled`, `missing`, `unavailable`, `changed`, `taken-over`, `stopped`. Plus `accepted?`, `completion?` (`status: success \| error \| interrupted`, `summary?`, `error?`, `recordId`), `requests`, `question?` (`{id, text, pending}`), `exited?`. Completion is child evidence, not proof of correctness. Repeated observations return the same `recordId`. |
| `watch` | One observer per agent (process-wide); private directory events + bounded health probe; callback only on change. Dispose the old observer before watching a new handle of the same agent. |
| `drainRequests` | Non-destructive: valid delegated-tool requests of the **current** task (`kind: "request"`, `tool`, `params`, `requestId`). Deduplicate in your own durable store. Ask-parent requests are not included. |
| `pendingAsks` / `markAsk` / `answerAsk` / `askHeartbeat` | Ask-parent (see above): pending requests of the current task (params validated), the `received` (exclusive, `false` if already picked up) and `escalated` markers, the exclusive answer (unknown/stale/answered → `busy`), the parent's liveness record. |
| `respond` | Exclusive (`EEXIST` = already answered; acquire, never overwrite). Unknown/stale request → `busy`. |
| `interrupt` | Writes a correlated request; the child aborts once and acknowledges. Not proof: wait for `settled` with `interrupted`. |
| `stop` | Refuses active tasks: interrupt and observe settlement first. Timeout → `cleanup_uncertain` (pane retained). |
| `close` | After `stop`. Checks shell/tty/occupant, closes only that pane, verifies `pane_not_found`. |
| `inspectShutdown` | Reconciliation evidence: exact `shutdown-ack`, exact child gone (`exited` is true when the PID is free **or** reused by another process; `pidReused` tells which), user takeover. `ps` failures → `cleanup_uncertain`. |
| `focus` | Display only, split placements: moves focus between caller and child if the layout still matches. |
| `move` | Moves the child's pane to a new tab or beside a target pane (pane selector). The new tab is **observed** (a lost answer is resolved by `pane get`); pane, terminal and workspace must not change, and the move is recorded (`move-<uuid>.json`). Returns the handle with the new `tabId`; older handles of the same task stay valid by following the recorded moves (the pane selector may move an agent through another client's runtime), while a tab change nobody recorded is `changed`. Nothing changed after an error → `busy`. |

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

Persist handles verbatim. Clients never read protocol files directly; ask for a helper instead.

Other exports: `sameAgent`, `sameTask`, `validTask`, `taskKey`, `onceRequestId(taskToken, tool)`,
`THINKING_LEVELS`, `nodeRunner`, `readProcessTerminal`, `processIdentity`, `terminalName`,
`hostCompositionFromEnv`, `subagentPanelName(workspace, tab, n)`, `nextSubagentIndex(siblingNames)`, `presence`, `presenceActive`,
`askParentTimeoutMs(env)`, `answeredByText(by)` and the types (`PendingAsk`, `AskRequest`, `AskResult`, `AnsweredBy`, …).

## Child side

Isolated children run `pi --session-id <id> --session-dir <attempt>/sessions --model <m> --thinking <t> -ne -e <runtime
child extension> [-e host…] -ns -np --no-approve --no-themes --tools <allowlist> [--system-prompt <file>]
[--append-system-prompt <file>…]`. Profile children run `pi (--session <file> | --session-id … --session-dir …)
--model <m> --thinking <t> -e <runtime child extension> [-e host…] [--tools <allowlist>] [--system-prompt …]
[--append-system-prompt …]` and load their profile normally. Both get `PI_CODING_AGENT_DIR=<agentDir>`, the host and
per-launch environment and `PI_MEMO_RUNTIME_PROTOCOL_DIR / _NONCE / _SCOPE / _AGENT_ID / _ATTEMPT`.

The child extension: verifies boot identity, model, thinking, session and cwd; publishes `ready`; accepts each task
exactly once; publishes `settled` only on `agent_settled` (provider errors and aborts stay distinct; no assistant
outcome is an error); handles interrupt/shutdown requests; records takeover; enforces the tool allowlist and the
read-only bash guard (with `bashAllow`, and the user question for `bashAsk`, asked to the parent first with
`askParent`); registers the declared delegated tools and the exit tools; records `question` dialogs (pi-memo-question) in `question.json`; writes
display-only activity snapshots (0600) with `attention` while it waits for the user; in isolated children inside
Herdr, reports the pane's agent state (see [Waiting for the user](#waiting-for-the-user-herdrblocked-attention)). User-driven children (`userInput: "allowed"`) also get an identity widget
(label, tools, denied tools; Ctrl+J toggles the list); workflow children keep pi's own Ctrl+J.

For user-driven children the pane's **tab** is not identity: the user may move the pane (pane, terminal, workspace,
shell and process must still match). For workflow children any tab change not recorded by `move` is `changed`.

## Evidence layout

`<stateDir>/runtime/<sha256(scope\0agentId\0attempt)>/`:
`launch-NNNN-<phase>.json` (launch phases), `boot.json`, `ready.json`, `task.json` (current, replaced),
`<key>.dispatch.json`, `<key>.accepted.json`, `<key>.settled.json` (key = sha256(taskId)),
`<key>.request.json` / `<key>.response.json` (key = sha256(requestId)), `interrupt.json` / `interrupt-ack.json`,
`shutdown.json` / `shutdown-ack.json`, `takeover.json`, `question.json`, `exit.json`, `activity.json`,
`<key>.received.json` / `<key>.escalated.json` and `parent.json` (ask-parent),
`move-<uuid>.json`, `sessions/`. The prompt lives only in
`task.json` and the immutable `<key>.dispatch.json`. `boot.json` also keeps the policy, labels and display data.

## Presence (widget)

Every agent launched by any `AgentRuntime` in the process appears in the pi-memo-subagents widget. The registry
(`Symbol.for("pi-memo-subagents/runtime-presence")`) is display-only and shared even if the module is loaded twice.
The runtime updates rows itself (launch, observe/watch, dispatch, stop, close); clients add workflow state with
`annotate` (e.g. `{ status: "in verifica", active: false }`) and can retire a row early with `forget`.
A row with `attention` (the agent waits for the user, see [above](#waiting-for-the-user-herdrblocked-attention))
shows it instead of the status and is never active (`presenceActive` is false). Box headers read
`N active · N question · N open` (question = rows waiting for the user, approvals included); the border uses the
attention color when a row waits, else blue when one is active, else amber.
After a cold restart, observing a persisted handle of a live agent rebuilds its row from `boot.json`; a superseded
handle (before `dispatch`) never repaints the row, and a closed agent is not resurrected.
Rows are grouped by `display.group`; the agents shown in the column beside the caller are marked `▶`.

## Pane selector

One process-wide selector state (`selectorState()`, `Symbol.for("pi-subagents/pane-selector-v1")`, kept across
`/reload`) is shared by every `AgentRuntime` of the process, whatever the client (`subagent` tool, Issue Round):

- every launched agent whose pane is in the caller's workspace is **owned** (label) with a **control**: its latest
  handle and the `move` of the runtime that launched it. Observing a live agent registers it again (cold restart,
  `/reload`) and replaces the control's handle with a newer task's; `stopped`/`missing`/`changed`, `close` and
  `forget` remove it;
- `placement: "auto"`: a free slot of the agent column right of the caller — the empty column (`split-right` of the
  caller, `--ratio 1 − PI_SUBAGENT_COLUMN_RATIO`, default column 40%) or the bottom slot (`split-down` below the agent
  shown alone, `--ratio 0.5`) — when the caller tab holds only the caller and at most one owned agent and is not
  zoomed; otherwise a tab. Agents in background tabs do not matter;
- `placement: "visible"`: like `auto`; with both slots taken by owned agents the top one is first parked in a new tab
  through its own runtime and the new agent is split below the other one. A caller tab with another (foreign) split,
  a zoomed caller or reserved slots give a tab. Each slot is a synchronous check-and-set on the layout read just
  before (`reservedSlots`), so concurrent launches never create more than two agent panes: a bottom slot reserved
  while the top slot's launch has not created its pane waits for it (`placedPane`, bounded) and splits it. The handle
  carries the effective placement (`split-right`/`split-down` with `parentPaneId` the split pane, or none for a tab);
- the pi-memo-subagents `/subagent` menu and Ctrl+Alt+X list this session's subagents and every other owned agent of the
  caller's workspace, and move them through their controls (`PaneSelector.select`, `PaneSelector.cycle`, promotions);
  `slots` holds the shown agents, top first. Agents in other workspaces (e.g. Herdr worktree spaces) are never moved.

`RuntimeConfig.selector` replaces the shared state (tests).

Clients change rows only through `annotate`/`forget`; `presence()` is for display (`list`, `get`, `subscribe`).
Its `upsert`/`update`/`remove` are runtime internals.

```ts
interface PresenceEntry {
  key: string; group?: string; label: string; model: string; thinking: string;
  paneId?: string; startedAt: number; state: Observation["kind"] | "launching" | "launch-uncertain";
  status?: string; active?: boolean; questionPending?: boolean; updatedAt: number;
  attention?: { kind: "question" | "approval" | "blocked"; label?: string; target?: "parent" | "user"; since: number };
}
function presence(): { list(): PresenceEntry[]; get(key: string): PresenceEntry | undefined; subscribe(listener: () => void): () => void /* + runtime internals */ };
```
