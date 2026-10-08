// Display-only registry of agents launched by any AgentRuntime in this process.
// Never consulted for control decisions. Shared through globalThis so that two copies of
// the module (a client's import and the extension loaded with -e) see the same rows.

export type PresenceState =
  | "launching"
  | "launch-uncertain"
  | "starting"
  | "active"
  | "settled"
  | "missing"
  | "unavailable"
  | "changed"
  | "taken-over"
  | "stopped";

export interface PresenceEntry {
  /** Attempt directory (stable per agent attempt). */
  key: string;
  group?: string;
  label: string;
  model: string;
  thinking: string;
  paneId?: string;
  startedAt: number;
  state: PresenceState;
  /** Workflow status set by the client with `annotate` (e.g. "in verifica"). */
  status?: string;
  /** Client override of the active/waiting accent; default derived from `state`. */
  active?: boolean;
  /** Kept for compatibility: a pending `question.json`. `attention` is the display source. */
  questionPending?: boolean;
  /** The agent waits for the user (question or bash approval): never counted as active. */
  attention?: PresenceAttention;
  updatedAt: number;
}

export interface PresenceAttention {
  kind: "question" | "approval" | "blocked";
  label?: string;
  since: number;
}

export interface PresenceRegistry {
  list(): PresenceEntry[];
  get(key: string): PresenceEntry | undefined;
  upsert(entry: Omit<PresenceEntry, "updatedAt">): void;
  update(key: string, patch: Partial<Omit<PresenceEntry, "key" | "updatedAt">>): void;
  remove(key: string): void;
  subscribe(listener: () => void): () => void;
}

const PRESENCE_KEY = Symbol.for("pi-memo-subagents/runtime-presence");

function createRegistry(): PresenceRegistry {
  const entries = new Map<string, PresenceEntry>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // Display listeners never break the runtime.
      }
    }
  };
  return {
    list: () => [...entries.values()].sort((a, b) => a.startedAt - b.startedAt),
    get: (key) => entries.get(key),
    upsert(entry) {
      entries.set(entry.key, { ...entry, updatedAt: Date.now() });
      notify();
    },
    update(key, patch) {
      const current = entries.get(key);
      if (!current) return;
      const next = { ...current, ...patch, updatedAt: Date.now() };
      if (JSON.stringify({ ...current, updatedAt: 0 }) === JSON.stringify({ ...next, updatedAt: 0 }))
        return;
      entries.set(key, next);
      notify();
    },
    remove(key) {
      if (entries.delete(key)) notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The process-wide presence registry. */
export function presence(): PresenceRegistry {
  const store = globalThis as unknown as Record<symbol, PresenceRegistry | undefined>;
  return (store[PRESENCE_KEY] ??= createRegistry());
}

/** Whether a row should use the "active" accent. */
export function presenceActive(entry: PresenceEntry): boolean {
  if (entry.attention) return false; // Waiting for the user outranks a client's `annotate({active: true})`.
  if (entry.active !== undefined) return entry.active;
  return entry.state === "launching" || entry.state === "starting" || entry.state === "active";
}
