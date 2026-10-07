// AgentRuntime: launch and control pi children in Herdr panes with exact identities and durable
// evidence. Ported from pi-issue-round's HerdrTransport (same author, MIT; itself selectively
// adapted from pi-herdr-subagents) and made role-agnostic. Contract: docs/runtime.md.
import { watch as fsWatch, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  json,
  publish,
  taskFile,
  taskKey,
  requestFile,
  questionFile,
  sameAgent,
  sameTask,
  sameLabels,
  record,
  validTask,
  validPolicy,
  activeTools,
  within,
  privateDirectory,
  THINKING_LEVELS,
} from "./protocol.ts";
import type {
  AgentHandle,
  TaskCommand,
  ChildRecord,
  ChildPolicy,
  Ready,
  Boot,
  Labels,
  Placement,
  BashPolicy,
  DelegatedToolSpec,
  ThinkingLevel,
} from "./protocol.ts";
import {
  nodeRunner,
  readProcessTerminal,
  terminalName,
  processIdentity,
} from "./runner.ts";
import type { Runner, RunResult } from "./runner.ts";
import { presence } from "./presence.ts";
import type { PresenceState } from "./presence.ts";
import { CHILD_ENV } from "./child/env.ts";

export interface RuntimeConfig {
  /** Private (0700) state root, outside every child cwd. Attempts live in <stateDir>/runtime/<sha256>. */
  stateDir: string;
  /** PI_CODING_AGENT_DIR for children. Default: private <stateDir>/runtime/profile. */
  agentDir?: string;
  /** Absolute extensions loaded by every child after the runtime child extension (e.g. a provider). */
  hostExtensions?: string[];
  /** Environment forwarded to every child; no MEMO_RUNTIME_* or PI_CODING_AGENT_DIR. */
  hostEnv?: Record<string, string>;
  piExecutable?: string;
  herdrExecutable?: string;
  /** Test override of the runtime child extension path. */
  childExtension?: string;
  runner?: Runner;
  startupTimeoutMs?: number;
  shellReadyTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}
export interface LaunchSpec {
  scope: string;
  agentId: string;
  attempt: number;
  /** Opaque client metadata (e.g. role, issue): stored in boot and handle, never interpreted. */
  labels?: Labels;
  taskId: string;
  prompt: string;
  cwd: string;
  /** Exact provider/model-id. */
  model: string;
  thinking: ThinkingLevel;
  isolation?: "isolated";
  tools: string[];
  bash?: BashPolicy;
  question?: boolean;
  delegatedTools?: DelegatedToolSpec[];
  /** Absolute files passed with --append-system-prompt. */
  appendSystemPrompt?: string[];
  /** "worktree" opens the existing checkout `cwd` as a Herdr worktree space (falls back to "tab"
   * when Herdr refuses, e.g. older server or a non-Git caller space). Default "tab". */
  placement?: Placement;
  display: {
    label: string;
    group?: string;
    agentsPanelName?: string;
  };
}
/** Herdr Agents-panel name at `depth` (1 = direct child): "└─ name", "┊ └─ name", … */
export function treeDisplayName(name: string, depth: number): string {
  const label = name.replace(/[\r\n\t]+/g, " ").trim() || "agent";
  return `${"┊ ".repeat(Math.max(0, depth - 1))}└─ ${label}`;
}
export interface Observation {
  kind:
    | "active"
    | "settled"
    | "starting"
    | "missing"
    | "unavailable"
    | "changed"
    | "stopped"
    | "taken-over";
  accepted?: ChildRecord;
  completion?: ChildRecord;
  requests: ChildRecord[];
  error?: string;
  /** The exact child process is confirmed gone without an orderly shutdown ack (user quit, crash). */
  exited?: true;
  /** Latest human question of a triage/planner child (pending = awaiting the answer). */
  question?: { id: string; text: string; pending: boolean };
}
type RuntimeErrorCode =
  | "unsupported"
  | "launch_uncertain"
  /** Definitely not launched: no command was typed and the unused pane was closed and observed gone. */
  | "launch_failed"
  | "dispatch_uncertain"
  | "cleanup_blocked"
  | "cleanup_uncertain"
  | "busy";
export class RuntimeError extends Error {
  code: RuntimeErrorCode;
  evidence?: unknown;
  constructor(code: RuntimeErrorCode, message: string, evidence?: unknown) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
    this.evidence = evidence;
  }
}
interface Pane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  terminal_id: string;
}
interface Processes {
  pane_id: string;
  shell_pid: number;
  tty?: string;
  foreground_processes: { pid: number; name?: string; cmdline?: string }[];
}
const observerRegistry = globalThis as unknown as Record<
  symbol,
  Map<string, () => void> | undefined
>;
const observerKey = Symbol.for("memo-subagents/runtime-observers");
const observers = (observerRegistry[observerKey] ??= new Map<
  string,
  () => void
>());
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Runtime evidence only: the client owns tasks, approvals, handles and authoritative state. */
export class AgentRuntime {
  private config: RuntimeConfig;
  private runner: Runner;
  private root: string;
  private ownedObservers = new Set<() => void>();
  private pending = new Set<string>();
  constructor(config: RuntimeConfig) {
    this.config = config;
    this.root = resolve(config.stateDir, "runtime");
    this.runner = config.runner ?? nodeRunner;
  }
  private async run(
    executable: string,
    argv: string[],
    cwd?: string,
    env?: Record<string, string>,
    timeoutMs = 5000,
  ): Promise<RunResult> {
    return this.runner({ executable, argv, cwd, env, timeoutMs });
  }
  private async herdr(
    argv: string[],
    cwd?: string,
    timeoutMs = 5000,
  ): Promise<any> {
    const result = await this.run(
      this.config.herdrExecutable ?? "herdr",
      argv,
      cwd,
      undefined,
      timeoutMs,
    );
    // Herdr 0.9.x acknowledges a successful `pane run` with exit 0 and no output
    // (errors are still JSON on exit 1). Only that exact shape is accepted as success.
    if (
      argv[0] === "pane" &&
      argv[1] === "run" &&
      result.exitCode === 0 &&
      !result.stdout.trim() &&
      !result.stderr?.trim()
    )
      return {};
    let data: any;
    try {
      data = JSON.parse(result.stdout);
    } catch {
      // Herdr reports failures (exit 1) as a JSON error on stderr with empty stdout.
      let error: any;
      try {
        error = result.exitCode ? JSON.parse(result.stderr ?? "").error : undefined;
      } catch {
        error = undefined;
      }
      if (error && typeof error === "object")
        throw Object.assign(
          new Error(error.message ?? "Herdr command failed"),
          { herdrCode: error.code },
        );
      throw new Error(
        `Unsupported Herdr response (${argv.slice(0, 2).join(" ")}): ${result.stderr ?? ""}`,
      );
    }
    if (result.exitCode || data.error)
      throw Object.assign(
        new Error(
          data.error?.message ?? result.stderr ?? "Herdr command failed",
        ),
        { herdrCode: data.error?.code },
      );
    if (!data.result)
      throw new Error("Unsupported Herdr response: missing result");
    return data.result;
  }
  private checkHandle(h: AgentHandle): void {
    try {
      this.root = realpathSync(this.root);
    } catch {
      throw new RuntimeError(
        "cleanup_blocked",
        "Runtime evidence directory missing",
      );
    }
    if (
      !within(this.root, h.protocolDir) ||
      resolve(h.protocolDir) === this.root ||
      !h.nonce ||
      !h.taskToken ||
      !Number.isSafeInteger(h.pid) ||
      h.pid <= 0
    )
      throw new RuntimeError(
        "cleanup_blocked",
        "Invalid or foreign agent handle",
      );
  }
  private async guarded<T>(h: AgentHandle, fn: () => Promise<T>): Promise<T> {
    this.checkHandle(h);
    if (this.pending.has(h.protocolDir))
      throw new RuntimeError("busy", "An agent operation is already pending");
    this.pending.add(h.protocolDir);
    try {
      return await fn();
    } finally {
      this.pending.delete(h.protocolDir);
    }
  }
  private async process(pid: number): Promise<string | undefined> {
    return processIdentity(this.runner, pid);
  }
  private async pane(h: AgentHandle): Promise<Pane> {
    const pane = (await this.herdr(["pane", "get", h.paneId])).pane as Pane;
    if (
      !pane ||
      pane.pane_id !== h.paneId ||
      pane.terminal_id !== h.terminalId ||
      pane.tab_id !== h.tabId ||
      pane.workspace_id !== h.workspaceId
    )
      throw new RuntimeError(
        "cleanup_blocked",
        "Pane identity/terminal changed",
      );
    return pane;
  }
  private async processes(h: AgentHandle): Promise<Processes> {
    const info = (
      await this.herdr(["pane", "process-info", "--pane", h.paneId])
    ).process_info as Processes;
    if (
      !info ||
      info.pane_id !== h.paneId ||
      info.shell_pid !== h.shellPid ||
      !Array.isArray(info.foreground_processes)
    )
      throw new RuntimeError(
        "cleanup_blocked",
        "Pane process identity unavailable or changed",
      );
    try {
      const shell = await readProcessTerminal(this.runner, info.shell_pid);
      if (
        shell.tty !== terminalName(h.tty) ||
        (info.tty !== undefined && terminalName(info.tty) !== shell.tty) ||
        (h.shellProcessIdentity !== undefined &&
          shell.identity !== h.shellProcessIdentity)
      )
        throw new Error("Shell terminal/process identity changed");
    } catch (error) {
      throw new RuntimeError("cleanup_blocked", String(error));
    }
    return info;
  }
  private async ownership(h: AgentHandle): Promise<void> {
    await this.pane(h);
    const ready = await json<Ready>(join(h.protocolDir, "ready.json"));
    const boot = await json<Boot>(join(h.protocolDir, "boot.json"));
    if (
      !ready ||
      !boot ||
      !sameAgent(h, ready) ||
      !sameAgent(h, boot) ||
      !sameLabels(h.labels, boot.labels) ||
      ready.pid !== h.pid ||
      ready.sessionPath !== h.sessionPath ||
      ready.cwd !== h.cwd
    )
      throw new RuntimeError(
        "cleanup_blocked",
        "Child identity does not match owned handle",
      );
    if ((await this.process(h.pid)) !== h.processIdentity)
      throw new RuntimeError(
        "cleanup_blocked",
        "Exact child process changed or exited",
      );
    const info = await this.processes(h);
    const child = await readProcessTerminal(this.runner, h.pid);
    if (
      child.tty !== terminalName(h.tty) ||
      child.identity !== h.processIdentity
    )
      throw new RuntimeError(
        "cleanup_blocked",
        "Child terminal/process identity changed",
      );
    if (!info.foreground_processes.some((p) => p.pid === h.pid))
      throw new RuntimeError(
        "cleanup_blocked",
        "Child is not in this pane foreground",
      );
    if (await json(join(h.protocolDir, "takeover.json")))
      throw new RuntimeError(
        "cleanup_blocked",
        "Child taken over by interactive user",
      );
    const current = await json<TaskCommand>(join(h.protocolDir, "task.json"));
    if (!current || !sameTask(h, current))
      throw new RuntimeError("cleanup_blocked", "Task identity changed");
  }
  async launch(input: LaunchSpec): Promise<AgentHandle> {
    if (
      typeof input.model !== "string" ||
      !input.model.includes("/") ||
      !THINKING_LEVELS.includes(input.thinking) ||
      !Number.isSafeInteger(input.attempt) ||
      input.attempt < 1 ||
      !input.taskId ||
      !input.agentId ||
      !input.scope ||
      typeof input.prompt !== "string" ||
      !input.display?.label
    )
      throw new RuntimeError(
        "unsupported",
        "Explicit provider/model, thinking, positive attempt, identities, prompt and display label required",
      );
    if ((input.isolation ?? "isolated") !== "isolated")
      throw new RuntimeError("unsupported", "Only isolated children are supported");
    const policy: ChildPolicy = {
      tools: [...(input.tools ?? [])],
      bash: input.bash ?? "unrestricted",
      question: input.question === true,
      delegatedTools: [...(input.delegatedTools ?? [])],
    };
    if (!validPolicy(policy))
      throw new RuntimeError(
        "unsupported",
        "Invalid tool policy (names, bash policy, delegated tool specs or name clashes)",
      );
    const placement: Placement = input.placement ?? "tab";
    if (!["split-right", "split-down", "tab", "worktree"].includes(placement))
      throw new RuntimeError("unsupported", `Unknown placement: ${placement}`);
    for (const file of input.appendSystemPrompt ?? [])
      if (typeof file !== "string" || !file.startsWith("/"))
        throw new RuntimeError(
          "unsupported",
          "System prompt files must be absolute paths",
        );
    // Interactive zsh/bash startup (plugins, version managers) can take several seconds.
    const shellReadyTimeoutMs = this.config.shellReadyTimeoutMs ?? 15000;
    if (!Number.isFinite(shellReadyTimeoutMs) || shellReadyTimeoutMs <= 0)
      throw new RuntimeError(
        "unsupported",
        "Positive shell readiness timeout required",
      );
    const cwd = await privateCwd(input.cwd);
    await privateDirectory(this.root);
    if (within(cwd, await realpath(this.root)))
      throw new RuntimeError(
        "unsupported",
        "Runtime state must be outside the child cwd",
      );
    this.root = await realpath(this.root);
    const protocolDir = join(
      this.root,
      taskKey(`${input.scope}\0${input.agentId}\0${input.attempt}`),
    );
    const extension =
      this.config.childExtension ??
      fileURLToPath(new URL("./child/extension.ts", import.meta.url));
    const profile = this.config.agentDir
      ? resolve(this.config.agentDir)
      : join(this.root, "profile");
    await privateDirectory(profile);
    await readFile(extension, "utf8");
    for (const file of input.appendSystemPrompt ?? [])
      await readFile(file, "utf8").catch(() => {
        throw new RuntimeError(
          "unsupported",
          `System prompt file unavailable: ${file}`,
        );
      });
    const extraExtensions = this.config.hostExtensions ?? [];
    for (const extra of extraExtensions) {
      if (typeof extra !== "string" || !extra.startsWith("/"))
        throw new RuntimeError(
          "unsupported",
          "Child extensions must be absolute paths",
        );
      await stat(extra).catch(() => {
        throw new RuntimeError(
          "unsupported",
          `Child extension unavailable: ${extra}`,
        );
      });
    }
    const extraEnv = Object.entries(this.config.hostEnv ?? {});
    for (const [name, value] of extraEnv)
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
        name.startsWith("MEMO_RUNTIME_") ||
        name === "PI_CODING_AGENT_DIR" ||
        typeof value !== "string"
      )
        throw new RuntimeError(
          "unsupported",
          `Child environment variable not allowed: ${name}`,
        );
    const help = await this.run(
      this.config.piExecutable ?? "pi",
      ["-ne", "-ns", "-np", "--no-approve", "--help"],
      cwd,
      { PI_CODING_AGENT_DIR: profile },
    );
    for (const flag of [
      "--session-id",
      "--session-dir",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-approve",
    ])
      if (help.exitCode || !help.stdout.includes(flag))
        throw new RuntimeError(
          "unsupported",
          `Pi CLI lacks required ${flag}; no child launched`,
        );
    // Exclusive attempt allocation, only after every `unsupported` check: an uncertain spawn must never replay.
    await mkdir(protocolDir, { mode: 0o700 });
    let paneId: string | undefined;
    let phase = "parent";
    let readinessTimedOut = false;
    let createdPane: Pane | undefined; // Exact identity returned by our own tab creation.
    let sequence = 0;
    const evidence = async (kind: string, details: object = {}) => {
      await publish(
        join(
          protocolDir,
          `launch-${String(++sequence).padStart(4, "0")}-${kind}.json`,
        ),
        {
          version: 1,
          at: new Date().toISOString(),
          scope: input.scope,
          agentId: input.agentId,
          attempt: input.attempt,
          taskId: input.taskId,
          phase,
          paneId,
          ...details,
        },
      );
    };
    presence().upsert({
      key: protocolDir,
      ...(input.display.group ? { group: input.display.group } : {}),
      label: input.display.label,
      model: input.model,
      thinking: input.thinking,
      startedAt: Date.now(),
      state: "launching",
    });
    try {
      await evidence("intent");
      const parent = (await this.herdr(["pane", "current", "--current"], cwd))
        .pane;
      if (!parent?.workspace_id)
        throw new Error("Herdr current workspace missing");
      const split = placement === "split-right" || placement === "split-down";
      if (split && (!parent.pane_id || !parent.tab_id))
        throw new Error("Herdr current pane identity missing for split");
      const label = input.display.label.replace(/[\r\n\t]+/g, " ").trim();
      phase = "create";
      await evidence("create-intent", {
        workspaceId: parent.workspace_id,
        placement,
        ...(split ? { parentPaneId: parent.pane_id } : {}),
      });
      // Existing checkout as a Herdr worktree space under the caller's space. A clean
      // Herdr refusal has no effect and falls back to a background tab; a lost response
      // stays uncertain (never a second creation).
      let space: { workspaceId: string; fresh: boolean } | undefined;
      let created: any;
      if (placement === "worktree") {
        let opened: any;
        try {
          opened = await this.herdr(
            [
              "worktree",
              "open",
              "--workspace",
              parent.workspace_id,
              "--path",
              cwd,
              "--label",
              label,
              "--no-focus",
            ],
            cwd,
            15000, // Herdr inspects the Git checkout before opening the space.
          );
        } catch (error) {
          if (!(error as { herdrCode?: string }).herdrCode) throw error;
          await evidence("worktree-refused", {
            error: String(error),
            herdrCode: (error as { herdrCode?: string }).herdrCode,
          });
        }
        if (opened) {
          const ws = opened.workspace;
          const checkout = ws?.worktree?.checkout_path;
          if (
            typeof ws?.workspace_id !== "string" ||
            ws.workspace_id === parent.workspace_id ||
            typeof checkout !== "string" ||
            (await realpath(checkout).catch(() => undefined)) !== cwd
          )
            throw new Error("Herdr worktree space identity mismatch");
          space = { workspaceId: ws.workspace_id, fresh: !opened.already_open };
          await evidence("worktree-opened", { returned: opened });
          // A fresh space's root pane is ours; an already-open space gets its own tab.
          if (space.fresh) created = opened;
        }
      }
      if (!created) {
        const workspaceId = space?.workspaceId ?? parent.workspace_id;
        created = await this.herdr(
          split
            ? [
              "pane",
              "split",
              parent.pane_id,
              "--direction",
              placement === "split-down" ? "down" : "right",
              "--cwd",
              cwd,
              "--no-focus",
            ]
          : [
              "tab",
              "create",
              "--workspace",
              workspaceId,
              "--label",
              label,
              "--cwd",
              cwd,
              "--no-focus",
            ],
          cwd,
        );
      }
      const p = (split ? created.pane : created.root_pane) as Pane;
      paneId = p?.pane_id;
      await evidence("created", { returned: created });
      if (
        !paneId ||
        !p?.terminal_id ||
        !p.tab_id ||
        p.workspace_id !== (space?.workspaceId ?? parent.workspace_id) ||
        (split && (p.tab_id !== parent.tab_id || paneId === parent.pane_id))
      )
        throw new Error("Herdr lacks exact pane/terminal identity");
      // Cosmetic only; identity is the returned pane/terminal.
      if (split)
        await this.herdr(["pane", "rename", paneId, label], cwd).catch(() => {});
      else if (space?.fresh)
        await this.herdr(["tab", "rename", p.tab_id, label], cwd).catch(
          () => {},
        );
      // Display only: Herdr Agents panel tree under the caller pane, one level deeper than it.
      const parentDepth = Number(parent.tokens?.tree_depth);
      const depth =
        (Number.isSafeInteger(parentDepth) && parentDepth > 0 ? parentDepth : 0) + 1;
      await this.herdr(
        [
          "pane",
          "report-metadata",
          paneId,
          "--source",
          "memo-subagents",
          "--display-agent",
          input.display.agentsPanelName ?? treeDisplayName(label, depth),
          ...(parent.pane_id
            ? [
                "--token",
                `parent=${parent.pane_id}`,
                "--token",
                `tree_depth=${depth}`,
              ]
            : []),
        ],
        cwd,
      ).catch(() => {});
      presence().update(protocolDir, { paneId });
      createdPane = p;
      phase = "shell-readiness";
      const shellDeadline = Date.now() + shellReadyTimeoutMs;
      // Last foreground occupant seen while the shell was still starting (e.g. `locale` from .zshrc).
      let busyWith: string | undefined;
      const remaining = () => {
        const ms = shellDeadline - Date.now();
        if (ms <= 0) {
          readinessTimedOut = true;
          throw new Error(
            busyWith
              ? `New pane shell readiness timed out: foreground still busy (${busyWith})`
              : "New pane shell readiness timed out",
          );
        }
        return Math.min(5000, ms);
      };
      let shellPid: number | undefined;
      let shellIdentity: { tty: string; identity: string } | undefined;
      // Observe only the returned pane. Once seen, shell/OS identities cannot be replaced.
      const probe = async () => {
        let observedPane: Pane | undefined;
        let info: Processes | undefined;
        let osShell: { tty: string; identity: string } | undefined;
        let osError: string | undefined;
        try {
          observedPane = (
            await this.herdr(["pane", "get", paneId!], cwd, remaining())
          ).pane;
          if (
            !observedPane ||
            observedPane.pane_id !== p.pane_id ||
            observedPane.terminal_id !== p.terminal_id ||
            observedPane.tab_id !== p.tab_id ||
            observedPane.workspace_id !== p.workspace_id
          )
            throw new Error("New pane identity/terminal changed");
          info = (
            await this.herdr(
              ["pane", "process-info", "--pane", paneId!],
              cwd,
              remaining(),
            )
          ).process_info;
          if (!info || info.pane_id !== paneId)
            throw new Error("New pane process identity unavailable or changed");
          const hasPid =
            Number.isSafeInteger(info.shell_pid) && info.shell_pid > 0;
          if (hasPid) {
            if (shellPid !== undefined && shellPid !== info.shell_pid)
              throw new Error("New pane shell PID changed");
            shellPid = info.shell_pid;
          }
          if (
            info.foreground_processes !== undefined &&
            !Array.isArray(info.foreground_processes)
          )
            throw new Error("New pane foreground identity invalid");
          const foreground = info.foreground_processes ?? [];
          const occupants = foreground.filter(
            (proc) => !proc || !hasPid || proc.pid !== info!.shell_pid,
          );
          if (occupants.length) {
            // A fresh login shell runs startup commands in the foreground: not ready yet,
            // never a reason to type into it. Persisting occupants end in a readiness timeout.
            busyWith = occupants
              .map((proc) => String(proc?.cmdline ?? proc?.name ?? proc?.pid))
              .join(", ")
              .slice(0, 200);
            remaining();
            await evidence("shell-probe", {
              observedPane,
              processInfo: info,
              occupants: busyWith,
              ready: false,
            });
            return undefined;
          }
          busyWith = undefined;
          if (hasPid) {
            try {
              osShell = await readProcessTerminal(
                this.runner,
                info.shell_pid,
                remaining(),
              );
            } catch (error) {
              osError = String(error); // Shell may not yet have a controlling terminal.
            }
            if (osShell) {
              if (
                info.tty !== undefined &&
                terminalName(info.tty) !== osShell.tty
              )
                throw new Error(
                  "Herdr terminal differs from OS shell terminal",
                );
              if (
                shellIdentity &&
                (shellIdentity.tty !== osShell.tty ||
                  shellIdentity.identity !== osShell.identity)
              )
                throw new Error("New pane OS shell identity/terminal changed");
              shellIdentity = osShell;
            }
          }
          remaining();
          const ready = !!osShell && foreground.length > 0;
          await evidence("shell-probe", {
            observedPane,
            processInfo: info,
            shell: osShell,
            osError,
            ready,
          });
          return ready ? { processInfo: info, shell: osShell! } : undefined;
        } catch (error) {
          await evidence("shell-probe", {
            observedPane,
            processInfo: info,
            shell: osShell,
            osError,
            error: String(error),
            ready: false,
          });
          throw error;
        }
      };
      let previousReady = false;
      let snapshot: {
        processInfo: Processes;
        shell: { tty: string; identity: string };
      };
      for (;;) {
        const observed = await probe();
        if (observed && previousReady) {
          snapshot = observed;
          break;
        }
        previousReady = !!observed;
        await delay(Math.min(25, remaining()));
      }
      const { processInfo, shell } = snapshot;
      await evidence("shell-ready", { processInfo, shell });
      phase = "boot";
      const boot: Boot = {
        scope: input.scope,
        agentId: input.agentId,
        attempt: input.attempt,
        nonce: randomUUID(),
        sessionId: randomUUID(),
        paneId: paneId!,
        ...(input.labels ? { labels: { ...input.labels } } : {}),
        cwd,
        protocolDir,
        model: input.model,
        effort: input.thinking,
        policy,
        display: { ...input.display },
        launchedAt: Date.now(),
      };
      const task: TaskCommand = {
        scope: boot.scope,
        agentId: boot.agentId,
        attempt: boot.attempt,
        nonce: boot.nonce,
        sessionId: boot.sessionId,
        paneId: boot.paneId,
        kind: "task",
        taskId: input.taskId,
        taskToken: randomUUID(),
        previousToken: null,
        prompt: input.prompt,
      };
      await publish(join(protocolDir, "boot.json"), boot);
      await publish(join(protocolDir, "task.json"), task);
      await publish(taskFile(protocolDir, input.taskId, "dispatch"), task);
      const sessionDir = join(protocolDir, "sessions");
      await mkdir(sessionDir, { mode: 0o700 });
      const args = [
        "--session-id",
        boot.sessionId,
        "--session-dir",
        sessionDir,
        "--model",
        input.model,
        "--thinking",
        input.thinking,
        "-ne",
        "-e",
        extension,
        ...extraExtensions.flatMap((extra) => ["-e", extra]),
        "-ns",
        "-np",
        "--no-approve",
        "--no-themes",
        "--tools",
        activeTools(policy).join(","),
        ...(input.appendSystemPrompt ?? []).flatMap((file) => [
          "--append-system-prompt",
          file,
        ]),
      ];
      // pane run necessarily crosses a shell. All executable/path/argv values are POSIX quoted; task text never enters it.
      const command = `cd ${quote(cwd)} && env ${CHILD_ENV.protocolDir}=${quote(protocolDir)} ${CHILD_ENV.nonce}=${quote(boot.nonce)} ${CHILD_ENV.agentId}=${quote(input.agentId)} ${CHILD_ENV.scope}=${quote(input.scope)} ${CHILD_ENV.attempt}=${quote(String(input.attempt))} ${extraEnv.map(([name, value]) => `${name}=${quote(value)} `).join("")}PI_CODING_AGENT_DIR=${quote(profile)} ${quote(this.config.piExecutable ?? "pi")} ${args.map(quote).join(" ")}`;
      // Preparing private input is not permission to adopt a changed or no-longer-ready occupant.
      phase = "pre-run";
      if (!(await probe()))
        throw new Error("New pane shell no longer ready before run");
      phase = "run";
      await evidence("run-intent");
      remaining(); // Evidence fsync/preparation must not let an expired readiness budget authorize run.
      await this.herdr(["pane", "run", paneId, command], cwd);
      await evidence("run-returned");
      phase = "child-readiness";
      const deadline = Date.now() + (this.config.startupTimeoutMs ?? 15000);
      do {
        const ready = await json<Ready>(join(protocolDir, "ready.json"));
        if (ready) {
          if (
            !sameAgent(boot, ready) ||
            ready.cwd !== cwd ||
            !Number.isSafeInteger(ready.pid) ||
            ready.pid <= 0 ||
            !within(sessionDir, ready.sessionPath)
          )
            throw new Error("Child ready identity invalid");
          const processIdentity = await this.process(ready.pid);
          if (!processIdentity)
            throw new Error("Child exited before identity acquisition");
          const h: AgentHandle = {
            scope: task.scope,
            agentId: task.agentId,
            attempt: task.attempt,
            nonce: task.nonce,
            sessionId: task.sessionId,
            paneId: task.paneId,
            taskId: task.taskId,
            taskToken: task.taskToken,
            ...(boot.labels ? { labels: boot.labels } : {}),
            cwd,
            protocolDir,
            sessionPath: ready.sessionPath,
            pid: ready.pid,
            processIdentity,
            terminalId: p.terminal_id,
            tabId: p.tab_id,
            workspaceId: p.workspace_id,
            shellPid: processInfo.shell_pid,
            tty: shell.tty,
            shellProcessIdentity: shell.identity,
            // Display only: focus moves between caller and child, never identity.
            ...(split
              ? {
                  parentPaneId: parent.pane_id,
                  placement: placement as "split-right" | "split-down",
                }
              : {}),
          };
          await this.ownership(h);
          await evidence("ready", { pid: h.pid, sessionPath: h.sessionPath });
          presence().update(protocolDir, { state: "starting" });
          return h;
        }
        await delay(25);
      } while (Date.now() < deadline);
      throw new Error("Child readiness timed out; launch outcome uncertain");
    } catch (error) {
      // The shell never became ready and nothing was typed: retire our own unused pane
      // (exact identity only), so a failed launch leaves no hidden residual tab.
      let paneClosed = false;
      let closeError: string | undefined;
      if (readinessTimedOut && phase === "shell-readiness" && createdPane) {
        try {
          paneClosed = await this.closeUnusedPane(createdPane);
        } catch (failure) {
          closeError = String(failure);
        }
      }
      let evidenceError: string | undefined;
      try {
        await evidence("failed", {
          error: String(error),
          herdrCode: (error as { herdrCode?: string }).herdrCode,
          paneClosed,
          ...(closeError ? { closeError } : {}),
        });
      } catch (failure) {
        evidenceError = String(failure);
      }
      if (paneClosed) presence().remove(protocolDir);
      else presence().update(protocolDir, { state: "launch-uncertain" });
      throw new RuntimeError(
        paneClosed ? "launch_failed" : "launch_uncertain",
        String(error),
        {
          protocolDir,
          paneId,
          phase,
          paneClosed,
          ...(closeError ? { closeError } : {}),
          ...(evidenceError ? { evidenceError } : {}),
        },
      );
    }
  }
  /** Close a pane this runtime just created and never typed into. Exact identity or no effect. */
  private async closeUnusedPane(created: Pane): Promise<boolean> {
    const same = (pane: Pane | undefined) =>
      !!pane &&
      pane.pane_id === created.pane_id &&
      pane.terminal_id === created.terminal_id &&
      pane.tab_id === created.tab_id &&
      pane.workspace_id === created.workspace_id;
    const current = (await this.herdr(["pane", "get", created.pane_id])).pane;
    if (!same(current)) return false;
    await this.herdr(["pane", "close", created.pane_id]);
    try {
      await this.herdr(["pane", "get", created.pane_id]);
    } catch (error) {
      if (["pane_not_found", "not_found"].includes((error as any).herdrCode))
        return true; // Closure observed, not inferred from the acknowledgement.
      throw error;
    }
    return false;
  }
  async dispatch(
    h: AgentHandle,
    input: { taskId: string; prompt: string },
  ): Promise<AgentHandle> {
    return this.guarded(h, async () => {
      await this.ownership(h);
      if (!input.taskId || input.taskId === h.taskId)
        throw new RuntimeError("busy", "A fresh taskId is required");
      const observation = await this.observe(h);
      if (observation.kind !== "settled")
        throw new RuntimeError(
          "busy",
          "Previous task is not demonstrably settled",
        );
      const next: AgentHandle = {
        ...h,
        taskId: input.taskId,
        taskToken: randomUUID(),
      };
      const cmd: TaskCommand = {
        scope: next.scope,
        agentId: next.agentId,
        attempt: next.attempt,
        nonce: next.nonce,
        sessionId: next.sessionId,
        paneId: next.paneId,
        taskId: next.taskId,
        taskToken: next.taskToken,
        kind: "task",
        previousToken: h.taskToken,
        prompt: input.prompt,
      };
      await publish(taskFile(h.protocolDir, input.taskId, "dispatch"), cmd); // refuse old task IDs even after restart
      try {
        await publish(join(h.protocolDir, "task.json"), cmd, false);
      } catch (e) {
        throw new RuntimeError("dispatch_uncertain", String(e), next);
      }
      presence().update(h.protocolDir, { state: "starting", questionPending: false });
      return next; // Persist this handle before observing. No replay on timeout.
    });
  }
  /** Non-destructive: valid delegated-tool requests of the current task, oldest first. */
  async drainRequests(h: AgentHandle): Promise<ChildRecord[]> {
    this.checkHandle(h);
    let names: string[];
    try {
      names = (await readdir(h.protocolDir)).filter((n) =>
        n.endsWith(".request.json"),
      );
    } catch {
      return [];
    }
    const requests: ChildRecord[] = [];
    for (const name of names) {
      const request = await json<ChildRecord>(join(h.protocolDir, name)).catch(
        () => undefined,
      );
      if (
        validTask(request, h, "request") &&
        typeof request.requestId === "string" &&
        typeof request.tool === "string" &&
        join(h.protocolDir, name) ===
          requestFile(h.protocolDir, request.requestId, "request")
      )
        requests.push(request);
    }
    return requests.sort((a, b) => a.at.localeCompare(b.at));
  }
  async respond(
    h: AgentHandle,
    requestId: string,
    result: unknown,
  ): Promise<void> {
    await this.guarded(h, async () => {
      await this.ownership(h);
      const requests = await this.drainRequests(h);
      const request = requests.find((r) => r.requestId === requestId);
      if (!request)
        throw new RuntimeError("busy", "Unknown/stale delegated-tool request");
      await publish(
        requestFile(h.protocolDir, requestId, "response"),
        record(h, "response", { requestId, tool: request.tool, result }),
      );
    });
  }
  /** Whether a response to this request was already published (acquire it, never overwrite). */
  async hasResponse(h: AgentHandle, requestId: string): Promise<boolean> {
    this.checkHandle(h);
    const response = await json<ChildRecord>(
      requestFile(h.protocolDir, requestId, "response"),
    );
    return (
      validTask(response, h, "response") && response.requestId === requestId
    );
  }
  /** Shutdown evidence for reconciliation: exact ack, exact PID gone, user takeover. */
  async inspectShutdown(h: AgentHandle): Promise<{
    acknowledged: boolean;
    exited: boolean;
    pidReused: boolean;
    takenOver: boolean;
  }> {
    this.checkHandle(h);
    try {
      const ack = await json<ChildRecord>(
        join(h.protocolDir, "shutdown-ack.json"),
      );
      const current = await this.process(h.pid);
      return {
        acknowledged: validTask(ack, h, "shutdown-ack"),
        // The exact child is gone when its PID is free or now belongs to another process.
        exited: current !== h.processIdentity,
        pidReused: current !== undefined && current !== h.processIdentity,
        takenOver: !!(await json(join(h.protocolDir, "takeover.json"))),
      };
    } catch (error) {
      throw new RuntimeError("cleanup_uncertain", String(error));
    }
  }
  /** Display only: workflow status of the agent row in the memo-subagents widget. */
  annotate(h: AgentHandle, note: { status?: string; active?: boolean }): void {
    presence().update(h.protocolDir, {
      ...(note.status !== undefined ? { status: note.status } : {}),
      ...(note.active !== undefined ? { active: note.active } : {}),
    });
  }
  /** Display only: retire the agent row before close. */
  forget(h: AgentHandle): void {
    presence().remove(h.protocolDir);
  }
  async observe(h: AgentHandle): Promise<Observation> {
    const observation = await this.observeOnce(h);
    await this.reflectPresence(h, observation).catch(() => {});
    return observation;
  }
  /** Display only; the presence row never feeds back into control. */
  private async reflectPresence(h: AgentHandle, o: Observation): Promise<void> {
    // A superseded handle (before dispatch) must not repaint the agent's single row.
    const current = await json<TaskCommand>(join(h.protocolDir, "task.json"));
    if (!current || !sameTask(current, h)) return;
    const registry = presence();
    if (!registry.get(h.protocolDir)) {
      // Rebuild the row in a new process (cold restart) for a live agent only.
      if (!["starting", "active", "settled", "taken-over"].includes(o.kind)) return;
      const boot = await json<Boot>(join(h.protocolDir, "boot.json"));
      if (!boot?.display?.label || !sameAgent(boot, h)) return;
      registry.upsert({
        key: h.protocolDir,
        ...(boot.display.group ? { group: boot.display.group } : {}),
        label: boot.display.label,
        model: boot.model,
        thinking: boot.effort,
        paneId: h.paneId,
        startedAt: boot.launchedAt ?? Date.now(),
        state: o.kind as PresenceState,
      });
    }
    registry.update(h.protocolDir, {
      state: o.kind as PresenceState,
      questionPending: o.question?.pending === true,
    });
  }
  private async observeOnce(h: AgentHandle): Promise<Observation> {
    this.checkHandle(h);
    const requests = await this.drainRequests(h);
    const accepted = await json<ChildRecord>(
      taskFile(h.protocolDir, h.taskId, "accepted"),
    );
    const completion = await json<ChildRecord>(
      taskFile(h.protocolDir, h.taskId, "settled"),
    );
    const asked = await json<ChildRecord>(join(h.protocolDir, questionFile));
    const evidence = {
      requests,
      ...(validTask(asked, h, "question") || validTask(asked, h, "answer")
        ? {
            question: {
              id: asked.questionId!,
              text: asked.question ?? "",
              pending: asked.kind === "question",
            },
          }
        : {}),
      ...(validTask(accepted, h, "accepted") ? { accepted } : {}),
      ...(validTask(accepted, h, "accepted") &&
      validTask(completion, h, "settled") &&
      ["success", "error", "interrupted"].includes(completion.status ?? "")
        ? { completion }
        : {}),
    };
    try {
      if (await json(join(h.protocolDir, "takeover.json")))
        return { ...evidence, kind: "taken-over" };
      const current = await json<TaskCommand>(join(h.protocolDir, "task.json"));
      if (!current || !sameTask(h, current))
        return { ...evidence, kind: "changed", error: "Task identity changed" };
      await this.pane(h);
      const proc = await this.process(h.pid);
      if (!proc) {
        const ack = await json<ChildRecord>(
          join(h.protocolDir, "shutdown-ack.json"),
        );
        return {
          ...evidence,
          ...(validTask(ack, h, "shutdown-ack")
            ? { kind: "stopped" as const }
            : { kind: "unavailable" as const, exited: true as const }),
          error: "Child process exited",
        };
      }
      if (proc !== h.processIdentity)
        return {
          ...evidence,
          kind: "changed",
          error: "Process identity changed",
        };
      await this.ownership(h);
      if (evidence.completion) return { ...evidence, kind: "settled" };
      return { ...evidence, kind: evidence.accepted ? "active" : "starting" };
    } catch (error) {
      const code = (error as { herdrCode?: string }).herdrCode;
      return {
        ...evidence,
        kind:
          code === "pane_not_found" || code === "not_found"
            ? "missing"
            : error instanceof RuntimeError
              ? "changed"
              : "unavailable",
        error: String(error),
      };
    }
  }
  /** Best-effort, display-only focus move between the caller pane and a split child.
   * Herdr focuses by neighbor, so the exact neighbor identity is checked first;
   * a changed layout simply leaves focus where it is. Never affects ownership. */
  async focus(h: AgentHandle, target: "child" | "parent"): Promise<boolean> {
    this.checkHandle(h);
    if (!h.parentPaneId || !h.placement) return false;
    const forward = h.placement === "split-down" ? "down" : "right";
    const back = forward === "down" ? "up" : "left";
    const [from, to, direction] =
      target === "child"
        ? [h.parentPaneId, h.paneId, forward]
        : [h.paneId, h.parentPaneId, back];
    try {
      const neighbor = await this.herdr(
        ["pane", "neighbor", "--pane", from, "--direction", direction],
        h.cwd,
      );
      // Without a neighbor Herdr answers with the pane itself, never `to`.
      const id = neighbor?.neighbor?.pane_id;
      if (id !== to) return false;
      await this.herdr(
        ["pane", "focus", "--pane", from, "--direction", direction],
        h.cwd,
      );
      return true;
    } catch {
      return false;
    }
  }
  /** One observer per agent, installed by the client lifecycle. Evidence is never deleted. */
  watch(
    h: AgentHandle,
    onObservation: (o: Observation) => void | Promise<void>,
    intervalMs = 1000,
  ): () => void {
    this.checkHandle(h);
    if (observers.has(h.protocolDir))
      throw new RuntimeError("busy", "Agent already has an observer");
    let running = false,
      dirty = false,
      closed = false,
      previous = "";
    const tick = async () => {
      if (closed) return;
      if (running) {
        dirty = true;
        return;
      }
      running = true;
      try {
        const o = await this.observe(h);
        const signature = JSON.stringify(o);
        if (!closed && signature !== previous) {
          await onObservation(o);
          previous = signature;
        }
      } catch {
        /* callback failure leaves evidence for retry; no state/evidence consumption */
      } finally {
        running = false;
        if (dirty) {
          dirty = false;
          void tick();
        }
      }
    };
    const watcher = fsWatch(h.protocolDir, () => {
      void tick();
    });
    const timer = setInterval(
      () => {
        void tick();
      },
      Math.max(25, intervalMs),
    );
    timer.unref();
    const dispose = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      watcher.close();
      observers.delete(h.protocolDir);
      this.ownedObservers.delete(dispose);
    };
    observers.set(h.protocolDir, dispose);
    this.ownedObservers.add(dispose);
    void tick();
    return dispose;
  }
  dispose(): void {
    for (const stop of this.ownedObservers) stop();
  }
  async interrupt(h: AgentHandle): Promise<void> {
    await this.guarded(h, async () => {
      await this.ownership(h);
      await publish(
        join(h.protocolDir, "interrupt.json"),
        record(h, "interrupt-request"),
        false,
      );
    }); // request, not proof of interruption; await settled/interrupted evidence
  }
  async stop(h: AgentHandle): Promise<void> {
    await this.guarded(h, async () => {
      await this.stopOnce(h);
      presence().update(h.protocolDir, { state: "stopped" });
    });
  }
  private async stopOnce(h: AgentHandle): Promise<void> {
    {
      try {
        const existing = await json<ChildRecord>(
          join(h.protocolDir, "shutdown-ack.json"),
        );
        if (
          validTask(existing, h, "shutdown-ack") &&
          (await this.process(h.pid)) === undefined
        )
          return;
        await this.ownership(h);
        if ((await this.observe(h)).kind !== "settled")
          throw new RuntimeError(
            "cleanup_blocked",
            "Agent task is not settled; interrupt first",
          );
        const requestPath = join(h.protocolDir, "shutdown.json");
        const existingRequest = await json<ChildRecord>(requestPath);
        if (
          existingRequest &&
          !validTask(existingRequest, h, "shutdown-request")
        )
          throw new RuntimeError(
            "cleanup_blocked",
            "Shutdown identity changed",
          );
        if (!existingRequest)
          await publish(requestPath, record(h, "shutdown-request"));
        const deadline = Date.now() + (this.config.shutdownTimeoutMs ?? 5000);
        do {
          await this.pane(h);
          const ack = await json<ChildRecord>(
            join(h.protocolDir, "shutdown-ack.json"),
          );
          const proc = await this.process(h.pid);
          if (proc && proc !== h.processIdentity)
            throw new RuntimeError(
              "cleanup_blocked",
              "PID reused or child identity changed",
            );
          if (validTask(ack, h, "shutdown-ack") && proc === undefined) return;
          await delay(25);
        } while (Date.now() < deadline);
        throw new RuntimeError(
          "cleanup_uncertain",
          "Orderly shutdown not proven before timeout; pane retained",
        );
      } catch (error) {
        if (error instanceof RuntimeError) throw error;
        throw new RuntimeError("cleanup_uncertain", String(error));
      }
    }
  }
  async close(h: AgentHandle): Promise<void> {
    await this.guarded(h, async () => {
      const current = await json<TaskCommand>(join(h.protocolDir, "task.json"));
      if (!current || !sameTask(current, h))
        throw new RuntimeError(
          "cleanup_blocked",
          "Task identity changed before pane closure",
        );
      const ack = await json<ChildRecord>(
        join(h.protocolDir, "shutdown-ack.json"),
      );
      if (
        !validTask(ack, h, "shutdown-ack") ||
        (await this.process(h.pid)) !== undefined
      )
        throw new RuntimeError(
          "cleanup_blocked",
          "Exact child exit and shutdown acknowledgement required",
        );
      if (await json(join(h.protocolDir, "takeover.json")))
        throw new RuntimeError(
          "cleanup_blocked",
          "Ownership transferred to user",
        );
      try {
        await this.pane(h);
      } catch (error) {
        if (["pane_not_found", "not_found"].includes((error as any).herdrCode)) {
          presence().remove(h.protocolDir);
          return;
        }
        throw new RuntimeError("cleanup_blocked", String(error));
      }
      const info = await this.processes(h);
      if (info.foreground_processes.some((p) => p.pid !== h.shellPid))
        throw new RuntimeError(
          "cleanup_blocked",
          "Pane has a different occupant",
        );
      await this.herdr(["pane", "close", h.paneId]);
      // Do not infer closure merely from command acknowledgement.
      try {
        await this.pane(h);
      } catch (error) {
        if (
          ["pane_not_found", "not_found"].includes((error as any).herdrCode)
        ) {
          observers.get(h.protocolDir)?.();
          presence().remove(h.protocolDir);
          return;
        }
        throw new RuntimeError("cleanup_uncertain", String(error));
      }
      throw new RuntimeError(
        "cleanup_uncertain",
        "Pane closure not observed",
      );
    });
  }
}
async function privateCwd(path: string): Promise<string> {
  const { realpath, stat } = await import("node:fs/promises");
  const cwd = await realpath(resolve(path));
  if (!(await stat(cwd)).isDirectory())
    throw new Error("Child cwd is not a directory");
  return cwd;
}
