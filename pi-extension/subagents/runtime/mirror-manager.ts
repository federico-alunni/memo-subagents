// Main-side owner of the mirror viewer: a single read-only viewer pane for the right column,
// displaying all active worktree-space slots stacked vertically. Managed through the agent runtime
// so its identity and shutdown follow the same proof as any child. Ownership is persisted
// (`<stateDir>/mirrors/column-<pid>.json`) so crashed sessions' mirror panes are safely cleaned up.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { json, publish } from "./protocol.ts";
import type { AgentHandle } from "./protocol.ts";
import type { LaunchSpec } from "./agent-runtime.ts";
import type { MirrorView, MultiMirrorView } from "./mirror-view.ts";

export interface MirrorSlot {
  slotId: string;
  /** What to show now; `owner` is added by the manager. */
  view: Omit<MirrorView, "owner">;
}

export interface SyncOptions {
  selectedSlotId?: string;
}

interface MirrorRecord {
  version: 1;
  handle: AgentHandle;
  owner: { pid: number; identity: string };
  viewFile: string;
}

export interface MirrorManagerOptions {
  runtime: {
    launch(spec: LaunchSpec): Promise<AgentHandle>;
    stop(h: AgentHandle): Promise<void>;
    close(h: AgentHandle): Promise<void>;
  };
  stateDir: string;
  /** Absolute path of `runtime/mirror-viewer.ts`. */
  viewerScript: string;
  /** Working directory of the viewer panes (the main session's). */
  cwd: string;
  /** This process: pid and start/command identity (reused PIDs must not look alive). */
  owner: { pid: number; identity: string };
  ownerAlive: (owner: { pid: number; identity: string }) => Promise<boolean>;
  now?: () => number;
}

interface Open {
  handle: AgentHandle;
  viewFile: string;
  recordFile: string;
  written: string;
}

export class MirrorManager {
  private readonly options: MirrorManagerOptions;
  private active?: Open;
  private currentSlotIds = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: MirrorManagerOptions) {
    this.options = options;
  }

  private get dir(): string {
    return join(this.options.stateDir, "mirrors");
  }

  /** The shared pane of the mirror column (for the selector), while it is ours and open. */
  get paneId(): string | undefined {
    return this.active?.handle.paneId;
  }

  /** Pane of the slot's mirror viewer (shared by all active slots in the column). */
  paneFor(slotId: string): string | undefined {
    return this.active && this.currentSlotIds.has(slotId) ? this.active.handle.paneId : undefined;
  }

  /** Serialised: concurrent syncs never launch multiple column viewers. */
  sync(slots: MirrorSlot[], options?: SyncOptions): Promise<void> {
    const run = this.chain.then(() => this.syncOnce(slots, options));
    this.chain = run.catch(() => {});
    return run;
  }

  private async syncOnce(slots: MirrorSlot[], options?: SyncOptions): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });

    if (slots.length === 0) {
      if (this.active) await this.end(this.active);
      this.currentSlotIds.clear();
      return;
    }

    this.currentSlotIds = new Set(slots.map((s) => s.slotId));
    const multiView: MultiMirrorView = {
      version: 1,
      slots: slots.map((s) => ({ ...s.view, slotId: s.slotId })),
      selectedSlotId: options?.selectedSlotId,
      palette: slots[0]?.view.palette,
      owner: this.options.owner,
    };
    const text = JSON.stringify(multiView);

    if (this.active) {
      if (text !== this.active.written) {
        await publish(this.active.viewFile, multiView, false);
        this.active.written = text;
      }
      return;
    }

    // Launch single shared column viewer
    // One column per session: two sessions of the same user never share (or delete) each other's view.
    const own = `column-${this.options.owner.pid}`;
    const viewFile = join(this.dir, `${own}.view.json`);
    const recordFile = join(this.dir, `${own}.json`);
    await publish(viewFile, multiView, false);

    const label = `⧉ ${slots.map((s) => s.view.name).join(" │ ")}`;
    let handle: AgentHandle;
    try {
      handle = await this.options.runtime.launch({
        scope: "mirror",
        agentId: `mirror-col-${randomUUID().slice(0, 8)}`,
        attempt: 1,
        taskId: "task-1",
        prompt: "",
        cwd: this.options.cwd,
        model: "mirror/viewer",
        thinking: "off",
        tools: [],
        userInput: "takeover",
        placement: "auto",
        viewer: { script: this.options.viewerScript, env: { PI_MEMO_MIRROR_VIEW_FILE: viewFile } },
        display: { label },
      });
    } catch {
      await rm(viewFile, { force: true });
      return;
    }

    const record: MirrorRecord = { version: 1, handle, owner: this.options.owner, viewFile };
    await publish(recordFile, record, false);
    this.active = { handle, viewFile, recordFile, written: text };
  }

  private async end(open: Open): Promise<void> {
    try {
      await this.options.runtime.stop(open.handle);
      await this.options.runtime.close(open.handle);
    } catch {
      // Retried on the next sync if unproven
      return;
    }
    this.active = undefined;
    await rm(open.recordFile, { force: true });
    await rm(open.viewFile, { force: true });
  }

  /** Session quit: close the column viewer this process owns. */
  async closeAll(): Promise<void> {
    await this.sync([]);
  }

  /** Reconcile orphaned mirror panes from dead sessions. */
  async reconcile(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const run = this.chain.then(async () => {
      for (const name of await readdir(this.dir)) {
        if (!name.endsWith(".json") || name.endsWith(".view.json")) continue;
        const record = await json<MirrorRecord>(join(this.dir, name)).catch(() => undefined);
        if (!record || record.version !== 1 || !record.handle || !record.owner) continue;
        if (this.active?.recordFile === join(this.dir, name)) continue;
        if (record.owner.identity === this.options.owner.identity && record.owner.pid === this.options.owner.pid) continue;
        if (await this.options.ownerAlive(record.owner)) continue;
        try {
          await this.options.runtime.stop(record.handle);
          await this.options.runtime.close(record.handle);
        } catch {
          continue;
        }
        await rm(join(this.dir, name), { force: true });
        await rm(record.viewFile, { force: true });
      }
    });
    this.chain = run.catch(() => {});
    return run;
  }
}
