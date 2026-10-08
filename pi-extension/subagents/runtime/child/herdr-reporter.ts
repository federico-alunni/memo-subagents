/**
 * Herdr agent state of an `isolated` runtime child. Isolated children start with `-ne`, so Herdr's own
 * pi integration (`~/.pi/agent/extensions/herdr-agent-state.ts`) is not loaded and Herdr would only read
 * the screen. This reporter tells Herdr working / idle / blocked directly. Never used for `profile`
 * children: their profile loads the integration, which already listens to `herdr:blocked`.
 *
 * Only the latest state is sent (one command in flight), `seq` grows from a timestamp, errors are ignored.
 */
import { execFile } from "node:child_process";
import type { Isolation } from "../protocol.ts";

export const HERDR_REPORT_SOURCE = "memo-subagents";

/** Runs `bin args…`; injectable for tests. */
export type HerdrExec = (bin: string, args: string[]) => Promise<unknown>;

export interface HerdrReporter {
  /** agent_start (true) / agent_settled idle (false). */
  agentActive(active: boolean): void;
  /** The child waits for the user (label shown by Herdr), or no longer (undefined). */
  attention(attention: { label?: string } | undefined): void;
  /** On quit: give the pane's agent state back to Herdr. Resolves when the queue is drained. */
  release(): Promise<void>;
}

const defaultExec: HerdrExec = (bin, args) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: 3000 }, () => resolve(undefined));
  });

function oneLine(text: string | undefined): string | undefined {
  const line = text?.replace(/\s+/g, " ").trim();
  return line ? line.slice(0, 200) : undefined;
}

/** A reporter only with `HERDR_ENV=1`, `HERDR_PANE_ID` and `isolated` children; undefined otherwise. */
export function createHerdrReporter(options: {
  isolation: Isolation | undefined;
  env?: NodeJS.ProcessEnv;
  exec?: HerdrExec;
  now?: () => number;
}): HerdrReporter | undefined {
  const env = options.env ?? process.env;
  const pane = env.HERDR_PANE_ID;
  if (env.HERDR_ENV !== "1" || !pane || options.isolation !== "isolated") return undefined;
  const bin = env.HERDR_BIN_PATH || "herdr";
  const exec = options.exec ?? defaultExec;
  const identity = ["--source", HERDR_REPORT_SOURCE, "--agent", "pi"];
  let seq = (options.now ?? Date.now)() * 1000;
  let active = false;
  let waiting: { label?: string } | undefined;
  let last: string | undefined;
  let queued: string[] | undefined;
  let draining: Promise<void> | undefined;

  const drain = async () => {
    while (queued) {
      const args = queued;
      queued = undefined;
      try {
        await exec(bin, args);
      } catch {
        // Herdr unavailable: the pane falls back to screen detection.
      }
    }
    draining = undefined;
  };
  const send = (args: string[]) => {
    queued = args; // Only the latest state matters.
    draining ??= drain();
  };
  const publish = () => {
    const state = waiting ? "blocked" : active ? "working" : "idle";
    const message = waiting ? oneLine(waiting.label) : undefined;
    const key = `${state}\0${message ?? ""}`;
    if (key === last) return;
    last = key;
    send([
      "pane",
      "report-agent",
      pane,
      ...identity,
      "--state",
      state,
      ...(message ? [`--message=${message}`] : []),
      "--seq",
      String(++seq),
    ]);
  };

  return {
    agentActive(value) {
      active = value;
      publish();
    },
    attention(value) {
      waiting = value;
      publish();
    },
    async release() {
      last = undefined;
      send(["pane", "release-agent", pane, ...identity, "--seq", String(++seq)]);
      await draining;
    },
  };
}
