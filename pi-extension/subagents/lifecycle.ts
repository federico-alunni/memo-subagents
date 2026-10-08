import type { ActivityReadResult, SubagentActivityScope, SubagentAttention } from "./activity.ts";
import type { CompletionResult } from "./completion.ts";

export type HerdrAgentStatus =
  | "idle"
  | "working"
  | "blocked"
  | "done"
  | "unknown";

export type PaneInspection =
  | {
      kind: "present";
      agent?: string;
      agentStatus: HerdrAgentStatus;
      observedAt: number;
    }
  | { kind: "missing"; error?: string }
  | { kind: "unavailable"; error?: string };

export type ProcessState =
  | { kind: "starting"; startedAt: number }
  | { kind: "running"; startedAt: number; confirmedAt: number }
  | { kind: "finalizing"; startedAt: number; detectedAt: number; completion: CompletionResult }
  | { kind: "completed"; startedAt: number; detectedAt: number; completedAt: number; completion: CompletionResult }
  | { kind: "failed"; startedAt: number; detectedAt: number; completedAt: number; error: string; exitCode?: number };

export type ActivityDetail =
  | { kind: "none"; observedAt: number }
  | { kind: "scope"; scope: SubagentActivityScope; label?: string; since: number; observedAt: number; sequence: number };

export type TurnState =
  | { kind: "unknown" }
  | { kind: "starting"; observedAt: number }
  | { kind: "active"; startedAt: number; source: "activity" | "herdr" | "fallback"; activity?: ActivityDetail }
  | { kind: "blocked"; startedAt: number; reason: BlockedReason; label?: string }
  | { kind: "waiting"; startedAt: number }
  | { kind: "interrupted"; requestedAt: number; previousActivitySequence: number | null };

/** Why a turn is blocked: the child's own attention (question/approval), or Herdr's status alone. */
export type BlockedReason = "question" | "approval" | "herdr";

export type ActivityHealth =
  | { kind: "unseen" }
  | { kind: "healthy"; observedAt: number }
  | { kind: "problem"; reason: "missing" | "invalid" | "wrong-id"; since: number; error?: string };

export type PaneObservation =
  | { kind: "unknown" }
  | { kind: "present"; observedAt: number; agentStatus: HerdrAgentStatus }
  | { kind: "read-error"; firstFailedAt: number; lastFailedAt: number; consecutiveFailures: number; error?: string }
  | { kind: "missing"; detectedAt: number; error?: string };

export type CompletionDelivery = "pending" | "delivered" | "suppressed";

export interface SubagentLifecycle {
  process: ProcessState;
  turn: TurnState;
  activityHealth: ActivityHealth;
  /** Latest optional Pi detail, independent of Herdr coarse turn state. */
  activityDetail: ActivityDetail | null;
  /** Latest attention reported by the child's activity (it waits for the user). */
  attention?: SubagentAttention | null;
  pane: PaneObservation;
  /** Durable across unavailable/missing observations. */
  hasWorked: boolean;
  lastActivitySequence: number | null;
  delivery: CompletionDelivery;
}

export interface LifecycleProjection {
  kind: "starting" | "running" | "active" | "blocked" | "waiting" | "interrupted" | "stalled" | "finalizing" | "completed" | "failed";
  label?: string;
  /** Only for `blocked`. */
  reason?: BlockedReason;
  runtimeEndedAt?: number;
  stateDurationSince?: number;
}

export function createLifecycle(startedAt: number): SubagentLifecycle {
  return {
    process: { kind: "starting", startedAt },
    turn: { kind: "unknown" },
    activityHealth: { kind: "unseen" },
    activityDetail: null,
    attention: null,
    pane: { kind: "unknown" },
    hasWorked: false,
    lastActivitySequence: null,
    delivery: "pending",
  };
}

function isTerminal(process: ProcessState): boolean {
  return process.kind === "completed" || process.kind === "failed";
}

function startedAt(process: ProcessState): number {
  return process.startedAt;
}

function attentionReason(attention: SubagentAttention): BlockedReason {
  return attention.kind === "approval" ? "approval" : attention.kind === "question" ? "question" : "herdr";
}

/** Attention counts only for a live child whose pane is still there. */
function liveAttention(lifecycle: SubagentLifecycle): SubagentAttention | null {
  if (lifecycle.process.kind === "finalizing" || isTerminal(lifecycle.process)) return null;
  if (lifecycle.pane.kind === "missing") return null;
  return lifecycle.attention ?? null;
}

/** The turn Herdr's coarse status implies (blocked without attention = reason "herdr"). */
function herdrTurn(
  lifecycle: SubagentLifecycle,
  agentStatus: HerdrAgentStatus,
  hasWorked: boolean,
  observedAt: number,
): TurnState {
  const current = lifecycle.turn;
  if (agentStatus === "blocked") {
    return hasWorked
      ? {
          kind: "blocked",
          startedAt: current.kind === "blocked" && current.reason === "herdr" ? current.startedAt : observedAt,
          reason: "herdr",
        }
      : { kind: "starting", observedAt: current.kind === "starting" ? current.observedAt : observedAt };
  }
  if (agentStatus === "working") {
    return {
      kind: "active",
      startedAt: current.kind === "active" ? current.startedAt : observedAt,
      source: "herdr",
      ...(lifecycle.activityDetail ? { activity: lifecycle.activityDetail } : {}),
    };
  }
  if (agentStatus === "done" || agentStatus === "idle") {
    return hasWorked
      ? { kind: "waiting", startedAt: current.kind === "waiting" ? current.startedAt : observedAt }
      : { kind: "starting", observedAt: current.kind === "starting" ? current.observedAt : observedAt };
  }
  return current;
}

/**
 * Precedence: interrupted > attention > Herdr status. While the child reports attention the turn is
 * blocked with its reason; once it clears, an attention-blocked turn falls back on Pi detail or Herdr.
 */
function applyAttention(lifecycle: SubagentLifecycle, observedAt: number): SubagentLifecycle {
  const turn = lifecycle.turn;
  if (turn.kind === "interrupted") return lifecycle;
  const attention = liveAttention(lifecycle);
  if (attention) {
    const reason = attentionReason(attention);
    return {
      ...lifecycle,
      hasWorked: true,
      turn: {
        kind: "blocked",
        startedAt: turn.kind === "blocked" && turn.reason === reason ? turn.startedAt : attention.since,
        reason,
        ...(attention.label ? { label: attention.label } : {}),
      },
    };
  }
  if (turn.kind !== "blocked" || turn.reason === "herdr") return lifecycle;
  const detail = lifecycle.activityDetail;
  if (detail?.kind === "scope")
    return {
      ...lifecycle,
      turn: {
        kind: "active",
        startedAt: detail.since,
        source: lifecycle.pane.kind === "present" ? "activity" : "fallback",
        activity: detail,
      },
    };
  if (lifecycle.pane.kind === "present" && lifecycle.pane.agentStatus !== "unknown")
    return { ...lifecycle, turn: herdrTurn(lifecycle, lifecycle.pane.agentStatus, lifecycle.hasWorked, observedAt) };
  return { ...lifecycle, turn: { kind: "waiting", startedAt: observedAt } };
}

export function observePaneInspection(
  lifecycle: SubagentLifecycle,
  inspection: PaneInspection,
  observedAt: number,
): SubagentLifecycle {
  if (isTerminal(lifecycle.process)) return lifecycle;
  if (lifecycle.process.kind === "finalizing") return lifecycle;

  if (inspection.kind === "unavailable") {
    const previous = lifecycle.pane.kind === "read-error" ? lifecycle.pane : null;
    return {
      ...lifecycle,
      pane: {
        kind: "read-error",
        firstFailedAt: previous?.firstFailedAt ?? observedAt,
        lastFailedAt: observedAt,
        consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
        error: inspection.error,
      },
    };
  }

  if (inspection.kind === "missing") {
    // A child whose pane is gone no longer waits for anyone.
    return applyAttention({
      ...lifecycle,
      pane: { kind: "missing", detectedAt: observedAt, ...(inspection.error ? { error: inspection.error } : {}) },
    }, observedAt);
  }

  const agentStatus = inspection.agentStatus;
  const hasWorked =
    lifecycle.hasWorked ||
    agentStatus === "working" ||
    agentStatus === "blocked" ||
    agentStatus === "done";

  const pane: PaneObservation = {
    kind: "present",
    observedAt,
    agentStatus,
  };

  const process: ProcessState = lifecycle.process.kind === "starting"
    ? { kind: "running", startedAt: lifecycle.process.startedAt, confirmedAt: observedAt }
    : lifecycle.process;

  // A local interrupt has higher precedence than coarse Herdr status. Herdr
  // can lag behind Escape; only newer Pi activity or completion clears it.
  if (lifecycle.turn.kind === "interrupted") {
    return { ...lifecycle, process, pane, hasWorked };
  }

  // The child's own attention outranks Herdr's coarse status (which may lag or read the screen).
  if (liveAttention(lifecycle)) {
    return applyAttention({ ...lifecycle, process, pane, hasWorked }, observedAt);
  }

  if (agentStatus === "unknown") {
    // Keep existing process/turn; only record observation.
    return { ...lifecycle, process, pane };
  }

  return {
    ...lifecycle,
    process,
    turn: herdrTurn(lifecycle, agentStatus, hasWorked, observedAt),
    pane,
    hasWorked,
  };
}

export function observeActivity(
  lifecycle: SubagentLifecycle,
  read: ActivityReadResult,
  observedAt: number,
): SubagentLifecycle {
  if (lifecycle.process.kind === "finalizing" || isTerminal(lifecycle.process)) return lifecycle;

  const detail: ActivityDetail | null = (() => {
    if (!read.ok) return null;
    const activity = read.activity;
    if (lifecycle.lastActivitySequence != null && activity.sequence < lifecycle.lastActivitySequence) {
      return null;
    }
    if (activity.phase !== "active") return null;
    if (activity.activeScope === "tool") {
      return {
        kind: "scope",
        scope: "tool",
        since: activity.toolStartedAt ?? activity.activeSince ?? activity.updatedAt,
        observedAt: activity.updatedAt,
        sequence: activity.sequence,
        ...(activity.toolName ? { label: activity.toolName } : {}),
      };
    }
    if (activity.activeScope === "provider") {
      return { kind: "scope", scope: "provider", since: activity.activeSince ?? activity.updatedAt, observedAt: activity.updatedAt, sequence: activity.sequence, label: "provider" };
    }
    if (activity.activeScope === "streaming") {
      return { kind: "scope", scope: "streaming", since: activity.activeSince ?? activity.updatedAt, observedAt: activity.updatedAt, sequence: activity.sequence, label: "streaming" };
    }
    if (activity.activeScope === "agent" || activity.activeScope === "turn") {
      return { kind: "scope", scope: activity.activeScope, since: activity.activeSince ?? activity.updatedAt, observedAt: activity.updatedAt, sequence: activity.sequence };
    }
    return null;
  })();

  if (!read.ok) {
    const since = lifecycle.activityHealth.kind === "problem"
      ? lifecycle.activityHealth.since
      : observedAt;
    return {
      ...lifecycle,
      activityHealth: { kind: "problem", reason: read.reason, since, ...(read.error ? { error: read.error } : {}) },
    };
  }

  // A stale snapshot never changes the attention already seen.
  const stale = lifecycle.lastActivitySequence != null && read.activity.sequence < lifecycle.lastActivitySequence;
  const attention = stale ? lifecycle.attention ?? null : read.activity.attention ?? null;

  if (!detail) {
    // Reading succeeded but no enrichable detail; clear any stale label.
    return applyAttention({
      ...lifecycle,
      activityDetail: null,
      attention,
      activityHealth: { kind: "healthy", observedAt },
      lastActivitySequence: Math.max(lifecycle.lastActivitySequence ?? -1, read.activity.sequence),
    }, observedAt);
  }

  let resumesInterruptedTurn = false;
  if (lifecycle.turn.kind === "interrupted") {
    const staleInterruptSnapshot = detail.observedAt < lifecycle.turn.requestedAt ||
      (detail.observedAt === lifecycle.turn.requestedAt &&
        lifecycle.turn.previousActivitySequence != null &&
        detail.sequence <= lifecycle.turn.previousActivitySequence);
    if (staleInterruptSnapshot) return lifecycle;
    resumesInterruptedTurn = true;
  }

  const process: ProcessState = lifecycle.process.kind === "starting"
    ? { kind: "running", startedAt: lifecycle.process.startedAt, confirmedAt: observedAt }
    : lifecycle.process;

  // Herdr owns coarse turn state. Pi detail may enrich an authoritative
  // Herdr-working turn, or provide a fallback only while pane status is unknown.
  let turn = lifecycle.turn;
  const sameDetail = lifecycle.activityDetail?.kind === "scope" &&
    lifecycle.activityDetail.scope === detail.scope &&
    lifecycle.activityDetail.label === detail.label;
  const detailStartedAt = sameDetail && lifecycle.turn.kind === "active"
    ? lifecycle.turn.startedAt
    : detail.since;

  if (resumesInterruptedTurn) {
    turn = {
      kind: "active",
      startedAt: detailStartedAt,
      source: "activity",
      activity: detail,
    };
  } else if (lifecycle.turn.kind !== "interrupted") {
    if (lifecycle.pane.kind === "present" && lifecycle.pane.agentStatus === "working") {
      turn = {
        kind: "active",
        startedAt: detailStartedAt,
        source: "activity",
        activity: detail,
      };
    } else if (lifecycle.pane.kind === "unknown" || lifecycle.pane.kind === "read-error") {
      turn = {
        kind: "active",
        startedAt: detailStartedAt,
        source: "fallback",
        activity: detail,
      };
    }
  }

  return applyAttention({
    ...lifecycle,
    process,
    turn,
    activityDetail: detail,
    attention,
    activityHealth: { kind: "healthy", observedAt },
    lastActivitySequence: detail.sequence,
  }, observedAt);
}

export function markProcessRunning(
  lifecycle: SubagentLifecycle,
  confirmedAt: number,
): SubagentLifecycle {
  if (lifecycle.process.kind !== "starting") return lifecycle;
  return {
    ...lifecycle,
    process: { kind: "running", startedAt: lifecycle.process.startedAt, confirmedAt },
  };
}

export function markInterruptRequested(
  lifecycle: SubagentLifecycle,
  requestedAt: number,
): SubagentLifecycle {
  if (lifecycle.process.kind === "finalizing" || isTerminal(lifecycle.process)) return lifecycle;
  return {
    ...lifecycle,
    turn: {
      kind: "interrupted",
      requestedAt,
      previousActivitySequence: lifecycle.lastActivitySequence,
    },
  };
}

export function markCompletionDetected(
  lifecycle: SubagentLifecycle,
  completion: CompletionResult,
  detectedAt: number,
): SubagentLifecycle {
  if (lifecycle.process.kind === "finalizing" || isTerminal(lifecycle.process)) return lifecycle;
  return {
    ...lifecycle,
    process: {
      kind: "finalizing",
      startedAt: startedAt(lifecycle.process),
      detectedAt: Math.max(startedAt(lifecycle.process), detectedAt),
      completion,
    },
  };
}

export function markCompleted(lifecycle: SubagentLifecycle, completedAt: number): SubagentLifecycle {
  if (isTerminal(lifecycle.process)) return lifecycle;
  if (lifecycle.process.kind !== "finalizing") return lifecycle;
  return {
    ...lifecycle,
    process: {
      kind: "completed",
      startedAt: lifecycle.process.startedAt,
      detectedAt: lifecycle.process.detectedAt,
      completedAt: Math.max(lifecycle.process.detectedAt, completedAt),
      completion: lifecycle.process.completion,
    },
  };
}

export function markFailed(
  lifecycle: SubagentLifecycle,
  error: string,
  detectedAt: number,
  exitCode?: number,
): SubagentLifecycle {
  if (isTerminal(lifecycle.process)) return lifecycle;
  const start = startedAt(lifecycle.process);
  const detected = lifecycle.process.kind === "finalizing"
    ? lifecycle.process.detectedAt
    : Math.max(start, detectedAt);
  return {
    ...lifecycle,
    process: {
      kind: "failed",
      startedAt: start,
      detectedAt: detected,
      completedAt: Math.max(detected, detectedAt),
      error,
      ...(exitCode == null ? {} : { exitCode }),
    },
  };
}

export function markDelivery(lifecycle: SubagentLifecycle, delivery: CompletionDelivery): SubagentLifecycle {
  if (lifecycle.delivery !== "pending") return lifecycle;
  return { ...lifecycle, delivery };
}

export function projectLifecycle(lifecycle: SubagentLifecycle, now: number): LifecycleProjection {
  const process = lifecycle.process;
  if (process.kind === "finalizing") return { kind: "finalizing", runtimeEndedAt: process.detectedAt };
  if (process.kind === "completed") return { kind: "completed", runtimeEndedAt: process.completedAt };
  if (process.kind === "failed") return { kind: "failed", label: process.error, runtimeEndedAt: process.completedAt };

  // Pi activity is optional enrichment. Only authoritative Herdr inspection
  // unavailability may produce a stalled projection, never while the child
  // itself reports that it waits for the user.
  const childWaits = lifecycle.turn.kind === "blocked" && lifecycle.turn.reason !== "herdr";
  if (
    !childWaits &&
    lifecycle.pane.kind === "read-error" &&
    now - lifecycle.pane.firstFailedAt >= 60_000
  ) {
    return { kind: "stalled", stateDurationSince: lifecycle.pane.firstFailedAt };
  }

  const turn = lifecycle.turn;
  switch (turn.kind) {
    case "interrupted":
      return { kind: "interrupted", stateDurationSince: turn.requestedAt };
    case "active": {
      if (turn.activity?.kind === "scope") {
        const label = turn.activity.label ?? turn.activity.scope;
        return { kind: "active", label, stateDurationSince: turn.startedAt };
      }
      return { kind: "active", label: turn.source === "herdr" ? "agent working" : "agent active", stateDurationSince: turn.startedAt };
    }
    case "blocked":
      return {
        kind: "blocked",
        reason: turn.reason,
        ...(turn.label ? { label: turn.label } : {}),
        stateDurationSince: turn.startedAt,
      };
    case "waiting":
      return { kind: "waiting", stateDurationSince: turn.startedAt };
    case "starting":
      return { kind: "starting", stateDurationSince: turn.observedAt };
    case "unknown":
      return process.kind === "running" ? { kind: "running" } : { kind: "starting" };
  }
}

export type LifecycleTransition = "stalled" | "recovered" | null;

/**
 * Steer-worthy transitions. `blocked` never produces one (the parent is not told that a child waits
 * for the user): callers keep the previous kind while blocked, see `transitionBaseline`.
 */
export function lifecycleTransition(
  previous: LifecycleProjection["kind"] | undefined,
  next: LifecycleProjection["kind"],
): LifecycleTransition {
  if (next === "blocked") return null;
  if (previous !== "stalled" && next === "stalled") return "stalled";
  if (
    previous === "stalled" &&
    (next === "active" ||
      next === "waiting" ||
      next === "interrupted" ||
      next === "running" ||
      next === "starting")
  ) {
    return "recovered";
  }
  return null;
}

/** Kind to compare the next projection with: `blocked` keeps the kind seen before it. */
export function transitionBaseline(
  previous: LifecycleProjection["kind"] | undefined,
  next: LifecycleProjection["kind"],
): LifecycleProjection["kind"] | undefined {
  return next === "blocked" ? previous : next;
}

export function formatLifecycleTransitionLine(
  name: string,
  projection: LifecycleProjection,
  transition: Exclude<LifecycleTransition, null>,
  now: number,
  startedAt: number,
  formatElapsed: (ms: number) => string,
): string {
  const runtime = formatElapsed(Math.max(0, now - startedAt));
  const duration = projection.stateDurationSince == null
    ? ""
    : ` ${formatElapsed(now - projection.stateDurationSince)}`;
  if (transition === "stalled") {
    return `${name} running ${runtime}, stalled${duration}.`;
  }
  if (projection.kind === "waiting") {
    return `${name} running ${runtime}, recovered; waiting${duration}.`;
  }
  if (projection.kind === "active") {
    const detail = projection.label ? ` (${projection.label}${duration})` : duration;
    return `${name} running ${runtime}, recovered; active${detail}.`;
  }
  if (projection.kind === "blocked") {
    return `${name} running ${runtime}, recovered; blocked${duration}.`;
  }
  if (projection.kind === "interrupted") {
    return `${name} running ${runtime}, recovered; interrupted${duration}.`;
  }
  return `${name} running ${runtime}, recovered; running.`;
}
