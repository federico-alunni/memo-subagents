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
import { decodeInputKey, paletteTheme, renderMirrorFrame, renderMirrorLines, renderStackedMirrors, splitScreen } from "./mirror-view.ts";
import type { MultiMirrorView } from "./mirror-view.ts";
import type { MirrorView } from "./mirror-view.ts";
import { realpathSync, watch } from "node:fs";

export const VIEW_FILE_ENV = "PI_MEMO_MIRROR_VIEW_FILE";
export const MIRROR_POLL_MS = 1000;
/** High-framerate polling (~10 fps) when the agent awaits user dialog interaction. */
export const MIRROR_ATTENTION_POLL_MS = 100;

type ReadPane = (paneId: string) => Promise<string | undefined>;

/** Whether the owner process of a view is still the same process (pid and start/command identity). */
export type OwnerAlive = (owner: NonNullable<MirrorView["owner"]>) => Promise<boolean>;

export function normalizeMultiView(raw: any): MultiMirrorView | undefined {
  if (!raw || raw.version !== 1) return undefined;
  if (Array.isArray(raw.slots)) {
    return {
      version: 1,
      slots: raw.slots.filter((s: any) => s && typeof s.name === "string"),
      selectedSlotId: typeof raw.selectedSlotId === "string" ? raw.selectedSlotId : undefined,
      palette: raw.palette ?? {},
      owner: raw.owner,
    };
  }
  if (typeof raw.name === "string") {
    return {
      version: 1,
      slots: [raw],
      selectedSlotId: raw.slotId,
      palette: raw.palette ?? {},
      owner: raw.owner,
    };
  }
  return undefined;
}

export async function readMultiView(path: string): Promise<MultiMirrorView | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    return normalizeMultiView(raw);
  } catch {
    return undefined;
  }
}

export async function readView(path: string): Promise<MirrorView | undefined> {
  const multi = await readMultiView(path);
  return multi?.slots[0];
}

/** One repaint decision for multiple stacked slots: the frame to write, or undefined when unchanged. */
export function nextMultiFrame(
  previous: string | undefined,
  multiView: MultiMirrorView | undefined,
  screens: Map<string, string>,
  rows: number,
  columns: number,
  now: number,
): string | undefined {
  const theme = paletteTheme(multiView?.palette ?? {});
  const splitMap = new Map<string, string[]>();
  for (const [k, v] of screens) splitMap.set(k, splitScreen(v));
  const slots = multiView?.slots ?? [];
  const lines = slots.length > 0
    ? renderStackedMirrors(slots, splitMap, rows, columns, theme, now)
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

/** One repaint decision: the frame to write, or undefined when nothing changed (backwards compatible). */
export function nextFrame(
  previous: string | undefined,
  view: MirrorView | undefined,
  screen: string | undefined,
  rows: number,
  columns: number,
  now: number,
): string | undefined {
  const multi: MultiMirrorView | undefined = view ? { version: 1, slots: [view], palette: view.palette, owner: view.owner } : undefined;
  const screens = new Map<string, string>();
  if (view?.paneId && screen) screens.set(view.paneId, screen);
  return nextMultiFrame(previous, multi, screens, rows, columns, now);
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


function herdrSendInput(env: NodeJS.ProcessEnv = process.env): (paneId: string, input: ReturnType<typeof decodeInputKey>) => Promise<void> {
  const bin = env.HERDR_BIN_PATH || "herdr";
  return (paneId, input) =>
    new Promise((resolve) => {
      if (!input) return resolve();
      const args = input.kind === "key"
        ? ["pane", "send-keys", paneId, input.name]
        : ["pane", "send-text", paneId, input.text];
      execFile(bin, args, { encoding: "utf8", timeout: 4000 }, () => resolve());
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
  const sendInput = herdrSendInput(env);
  let lastMultiView: MultiMirrorView | undefined;

  if (stdin.isTTY) {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", async (chunk: Buffer) => {
      if (stopped) return;
      const current = (await readMultiView(viewFile)) ?? lastMultiView;
      if (!current) return;
      // Find all slots with active dialog attention
      const attentionSlots = current.slots.filter((s) => s.attention && s.paneId);
      if (attentionSlots.length === 0) return; // Drop input outside dialogs

      // Route to selected slot if it has attention, otherwise to the first slot with attention
      const targetSlot =
        (current.selectedSlotId && attentionSlots.find((s) => s.slotId === current.selectedSlotId)) ||
        attentionSlots[0];

      if (!targetSlot?.paneId) return;
      const decoded = decodeInputKey(chunk);
      if (!decoded) return;
      await sendInput(targetSlot.paneId, decoded);
      // Fast-forward immediate repaints for snappy typing/navigation feedback
      setTimeout(() => void tick(), 30);
      setTimeout(() => void tick(), 100);
    });
  }
  process.on("SIGINT", () => {});
  process.on("SIGTERM", stop);
  process.on("exit", restore);

  const read = herdrReadPane(env);
  const alive = ownerAlive();
  let previous: string | undefined;
  let deadChecks = 0;

  const tick = async () => {
    if (stopped) return;
    const multi = (await readMultiView(viewFile)) ?? lastMultiView;
    lastMultiView = multi;
    if (multi?.owner && !(await alive(multi.owner))) {
      // The session that owns this mirror is gone: end through the orderly path, never touch other panes.
      if (++deadChecks >= 3) {
        await child.exitWith("done").catch(() => stop());
        return;
      }
    } else deadChecks = 0;

    // Read screens for all active, un-ended slots
    const screens = new Map<string, string>();
    const activePanes = (multi?.slots ?? []).map((s) => (!s.ended ? s.paneId : undefined)).filter((id): id is string => !!id);
    await Promise.all(
      activePanes.map(async (paneId) => {
        const ansi = await read(paneId);
        if (ansi !== undefined) screens.set(paneId, ansi);
      }),
    );

    const frame = nextMultiFrame(previous, multi, screens, out.rows || 24, out.columns || 80, Date.now());
    if (frame !== undefined) {
      out.write(frame);
      previous = frame;
    }
  };
  out.on("resize", () => {
    previous = undefined;
    void tick();
  });
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleNext = () => {
    if (stopped) return;
    if (pollTimer) clearTimeout(pollTimer);
    const hasAttention = (lastMultiView?.slots ?? []).some((s) => s.attention);
    const interval = hasAttention ? MIRROR_ATTENTION_POLL_MS : MIRROR_POLL_MS;
    pollTimer = setTimeout(async () => {
      await tick().catch(() => {});
      scheduleNext();
    }, interval);
    pollTimer.unref?.();
  };

  try {
    const watcher = watch(viewFile, () => {
      void tick().then(() => scheduleNext()).catch(() => {});
    });
    watcher.unref?.();
  } catch {
    // If watch is unavailable or unsupported on this platform, polling continues.
  }

  await tick();
  scheduleNext();
}

if (process.env.PI_MEMO_MIRROR_VIEW === "1" && process.argv[1]?.endsWith("mirror-viewer.ts"))
  main().catch((error) => {
    process.stderr.write(`mirror viewer: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });

