// The mirror process: runs in a Herdr pane launched by the agent runtime with `viewer` (so it has an
// exact identity and an orderly shutdown like any child) and paints a read-only copy of another pane.
//
//   herdr pane read <pane> --source visible --format ansi   about once a second, repaint only on change
//   <view file>                                              what to show (written by the owner)
//
// It never writes to the watched pane, ignores all input (Ctrl+C included: the user promotes the agent with
// /subagent instead), and ends when the runtime asks it to (shutdown request) or its owner is gone.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ChildRuntime } from "./child/runtime.ts";
import { CHILD_ENV } from "./child/env.ts";
import { json, privateDirectory } from "./protocol.ts";
import type { Boot } from "./protocol.ts";
import { paletteTheme, renderMirrorFrame, renderMirrorLines, splitScreen } from "./mirror-view.ts";
import type { MirrorView } from "./mirror-view.ts";
import { realpathSync } from "node:fs";

export const VIEW_FILE_ENV = "PI_MEMO_MIRROR_VIEW_FILE";
export const MIRROR_POLL_MS = 1000;

type ReadPane = (paneId: string) => Promise<string | undefined>;

/** Whether the owner process of a view is still the same process (pid and start/command identity). */
export type OwnerAlive = (owner: NonNullable<MirrorView["owner"]>) => Promise<boolean>;

export async function readView(path: string): Promise<MirrorView | undefined> {
  try {
    const view = JSON.parse(await readFile(path, "utf8")) as MirrorView;
    return view?.version === 1 && typeof view.name === "string" ? view : undefined;
  } catch {
    return undefined;
  }
}

/** One repaint decision: the frame to write, or undefined when nothing changed. */
export function nextFrame(
  previous: string | undefined,
  view: MirrorView | undefined,
  screen: string | undefined,
  rows: number,
  columns: number,
  now: number,
): string | undefined {
  const theme = paletteTheme(view?.palette ?? {});
  const lines = view
    ? renderMirrorLines(view, screen ? splitScreen(screen) : [], rows, columns, theme, now)
    : renderMirrorLines(
        { version: 1, name: "mirror", startedAt: now, status: "starting" },
        [],
        rows,
        columns,
        theme,
        now,
      );
  const frame = renderMirrorFrame(lines, columns);
  return frame === previous ? undefined : frame;
}

function herdrReadPane(env: NodeJS.ProcessEnv = process.env): ReadPane {
  const bin = env.HERDR_BIN_PATH || "herdr";
  return (paneId) =>
    new Promise((resolve) => {
      execFile(
        bin,
        ["pane", "read", paneId, "--source", "visible", "--format", "ansi"],
        { encoding: "utf8", timeout: 4000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => resolve(error ? undefined : stdout),
      );
    });
}

function ownerAlive(): OwnerAlive {
  return (owner) =>
    new Promise((resolve) => {
      execFile("ps", ["-p", String(owner.pid), "-o", "lstart=", "-o", "command="], { encoding: "utf8", timeout: 4000 }, (error, stdout) =>
        resolve(!error && stdout.trim() === owner.identity),
      );
    });
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dir = env[CHILD_ENV.protocolDir];
  const viewFile = env[VIEW_FILE_ENV];
  if (!dir || !viewFile) throw new Error("Mirror viewer requires its protocol directory and view file");
  await privateDirectory(dir);
  const boot = await json<Boot>(join(dir, "boot.json"));
  if (!boot?.viewer || boot.nonce !== env[CHILD_ENV.nonce]) throw new Error("Not a mirror viewer boot");
  const out = process.stdout;
  const stdin = process.stdin;
  let stopped = false;
  const restore = () => out.write("\x1b[?7h\x1b[?25h\x1b[?1049l");
  const stop = () => {
    if (stopped) return;
    stopped = true;
    restore();
    process.exit(0);
  };
  // The runtime's identity contract: a ChildRuntime with a fake host (no model, no prompt, no session).
  const sessionPath = join(dir, "sessions", `${boot.sessionId}.jsonl`);
  const child = new ChildRuntime(boot, {
    cwd: realpathSync(process.cwd()),
    pid: process.pid,
    sessionId: boot.sessionId,
    sessionPath: boot.sessionFile ?? sessionPath,
    model: boot.model,
    effort: boot.effort,
    isIdle: () => true,
    sendPrompt: () => {},
    abort: () => {},
    shutdown: stop,
  });
  await child.start();

  // Alternate screen, no cursor, autowrap off; input is read raw and dropped.
  out.write("\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J");
  if (stdin.isTTY) {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", () => {});
  }
  process.on("SIGINT", () => {});
  process.on("SIGTERM", stop);
  process.on("exit", restore);

  const read = herdrReadPane(env);
  const alive = ownerAlive();
  let previous: string | undefined;
  let lastView: MirrorView | undefined;
  let deadChecks = 0;
  const tick = async () => {
    if (stopped) return;
    const view = (await readView(viewFile)) ?? lastView;
    lastView = view;
    if (view?.owner && !(await alive(view.owner))) {
      // The session that owns this mirror is gone: end through the orderly path, never touch other panes.
      if (++deadChecks >= 3) {
        await child.exitWith("done").catch(() => stop());
        return;
      }
    } else deadChecks = 0;
    const screen = view?.paneId && !view.ended ? await read(view.paneId) : undefined;
    const frame = nextFrame(previous, view, screen, out.rows || 24, out.columns || 80, Date.now());
    if (frame !== undefined) {
      out.write(frame);
      previous = frame;
    }
  };
  out.on("resize", () => {
    previous = undefined;
    void tick();
  });
  await tick();
  const timer = setInterval(() => void tick().catch(() => {}), MIRROR_POLL_MS);
  timer.unref?.();
}

if (process.env.PI_MEMO_MIRROR_VIEW === "1" && process.argv[1]?.endsWith("mirror-viewer.ts"))
  main().catch((error) => {
    process.stderr.write(`mirror viewer: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });

