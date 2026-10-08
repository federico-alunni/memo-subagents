// Main-side owner of the mirror viewers: one read-only viewer pane per slot (a worktree-space agent and
// its handoff chain), launched through the agent runtime so its identity and shutdown follow the same
// proof as any child. Ownership is persisted (`<stateDir>/mirrors/<slot>.json`) because the process that
// created a mirror may not be the one that finds it later: a record whose owner is gone is closed by
// whoever sees it, a live owner's record is never touched, and no pane that is not ours is ever closed.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { json, publish } from "./protocol.ts";
import type { AgentHandle } from "./protocol.ts";
import type { LaunchSpec } from "./agent-runtime.ts";
import type { MirrorView } from "./mirror-view.ts";

export interface MirrorSlot {
  slotId: string;
  /** What to show now; `owner` is added by the manager. */
  view: Omit<MirrorView, "owner">;
}

interface MirrorRecord {
  version: 1;
  slotId: string;
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

const safe = (slotId: string) => slotId.replace(/[^A-Za-z0-9_.-]/g, "_");

export class MirrorManager {
  private readonly options: MirrorManagerOptions;
  private readonly open = new Map<string, Open>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: MirrorManagerOptions) {
    this.options = options;
  }

  private get dir(): string {
    return join(this.options.stateDir, "mirrors");
  }

  /** Pane of the slot's mirror viewer (for the selector), while it is ours and open. */
  paneFor(slotId: string): string | undefined {
    return this.open.get(slotId)?.handle.paneId;
  }

  /** Serialised: concurrent syncs never launch two viewers for one slot. */
  sync(slots: MirrorSlot[]): Promise<void> {
    const run = this.chain.then(() => this.syncOnce(slots));
    this.chain = run.catch(() => {});
    return run;
  }

  private async syncOnce(slots: MirrorSlot[]): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const wanted = new Set(slots.map((slot) => slot.slotId));
    for (const slot of slots) {
      const current = this.open.get(slot.slotId);
      if (current) await this.writeView(current, slot);
      else await this.start(slot);
    }
    for (const [slotId, open] of [...this.open])
      if (!wanted.has(slotId)) await this.end(slotId, open);
  }

  private viewJson(slot: MirrorSlot): string {
    return JSON.stringify({ ...slot.view, version: 1, owner: this.options.owner });
  }

  private async writeView(open: Open, slot: MirrorSlot): Promise<void> {
    const text = this.viewJson(slot);
    if (text === open.written) return;
    await publish(open.viewFile, JSON.parse(text), false);
    open.written = text;
  }

  private async start(slot: MirrorSlot): Promise<void> {
    const file = safe(slot.slotId);
    const viewFile = join(this.dir, `${file}.view.json`);
    const recordFile = join(this.dir, `${file}.json`);
    const text = this.viewJson(slot);
    // The viewer reads its view as soon as it starts: write it first.
    await publish(viewFile, JSON.parse(text), false);
    let handle: AgentHandle;
    try {
      handle = await this.options.runtime.launch({
        scope: "mirror",
        agentId: `mirror-${file}-${randomUUID().slice(0, 8)}`,
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
        display: { label: `⧉ ${slot.view.name}` },
      });
    } catch {
      // Nothing is adopted; the next sync tries again with a new attempt identity.
      await rm(viewFile, { force: true });
      return;
    }
    const record: MirrorRecord = { version: 1, slotId: slot.slotId, handle, owner: this.options.owner, viewFile };
    await publish(recordFile, record, false);
    this.open.set(slot.slotId, { handle, viewFile, recordFile, written: text });
  }

  /** Stop and close through the runtime's proof; on failure the viewer stays ours and is retried. */
  private async end(slotId: string, open: Open): Promise<void> {
    try {
      await this.options.runtime.stop(open.handle);
      await this.options.runtime.close(open.handle);
    } catch {
      // Not proven yet (e.g. the exiting viewer is still a zombie for a few ms): still ours, retried by the next sync.
      return;
    }
    this.open.delete(slotId);
    await rm(open.recordFile, { force: true });
    await rm(open.viewFile, { force: true });
  }

  /** Session quit: close every viewer this process owns. */
  async closeAll(): Promise<void> {
    await this.sync([]);
  }

  /**
   * Close the viewers of owners that no longer exist (crash, killed session). A record of a live
   * owner, and our own, are left alone.
   */
  async reconcile(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const run = this.chain.then(async () => {
      for (const name of await readdir(this.dir)) {
        if (!name.endsWith(".json") || name.endsWith(".view.json")) continue;
        const record = await json<MirrorRecord>(join(this.dir, name)).catch(() => undefined);
        if (!record || record.version !== 1 || !record.handle || !record.owner) continue;
        if (this.open.has(record.slotId)) continue;
        if (record.owner.identity === this.options.owner.identity && record.owner.pid === this.options.owner.pid) continue;
        if (await this.options.ownerAlive(record.owner)) continue;
        try {
          await this.options.runtime.stop(record.handle);
          await this.options.runtime.close(record.handle);
        } catch {
          continue; // not proven: leave the record (and the pane) for a later look
        }
        await rm(join(this.dir, name), { force: true });
        await rm(record.viewFile, { force: true });
      }
    });
    this.chain = run.catch(() => {});
    return run;
  }
}
