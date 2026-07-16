import type { TaskExecutionTimeoutState } from "../../../core/types.js";

export interface TaskTimeoutIndicator {
  kind: "idle" | "absolute";
  progress: number;
  progressPercent: number;
  remainingMs: number;
}

interface TimeoutCandidate extends TaskTimeoutIndicator {
  deadlineAt: number;
}

const createTimeoutCandidate = (
  kind: TaskTimeoutIndicator["kind"],
  startedAt: number,
  durationMs: number | null,
  currentTimeMs: number,
): TimeoutCandidate | undefined => {
  if (durationMs === null || durationMs <= 0) {
    return undefined;
  }

  const elapsedMs = Math.max(0, currentTimeMs - startedAt);
  const progress = Math.min(1, elapsedMs / durationMs);
  const deadlineAt = startedAt + durationMs;

  return {
    kind,
    deadlineAt,
    progress,
    progressPercent: Math.round(progress * 100),
    remainingMs: Math.max(0, deadlineAt - currentTimeMs),
  };
};

export const createTaskTimeoutIndicator = (
  timeout: TaskExecutionTimeoutState | undefined,
  currentTimeMs: number,
): TaskTimeoutIndicator | undefined => {
  if (!timeout) {
    return undefined;
  }

  const idleCandidate = createTimeoutCandidate(
    "idle",
    timeout.lastActivityAt,
    timeout.idleTimeoutMs,
    currentTimeMs,
  );
  const absoluteCandidate = createTimeoutCandidate(
    "absolute",
    timeout.startedAt,
    timeout.absoluteTimeoutMs,
    currentTimeMs,
  );
  const nextCandidate =
    idleCandidate && absoluteCandidate
      ? idleCandidate.deadlineAt <= absoluteCandidate.deadlineAt
        ? idleCandidate
        : absoluteCandidate
      : idleCandidate ?? absoluteCandidate;

  if (!nextCandidate) {
    return undefined;
  }

  return {
    kind: nextCandidate.kind,
    progress: nextCandidate.progress,
    progressPercent: nextCandidate.progressPercent,
    remainingMs: nextCandidate.remainingMs,
  };
};
