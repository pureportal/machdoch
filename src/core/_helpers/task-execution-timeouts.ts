import type {
  TaskExecutionOptions,
  TaskExecutionTimeoutState,
} from "../types.js";

export const TASK_EXECUTION_IDLE_TIMEOUT_MS = 20 * 60 * 1_000;
export const TASK_EXECUTION_TIMEOUT_REASON_PREFIX =
  "Execution stopped after exceeding the safety timeout";

export interface ResolvedTaskExecutionTimeouts {
  idleTimeoutMs: number | undefined;
  absoluteTimeoutMs: number | undefined;
}

export interface ManagedTaskExecutionTimeout {
  readonly signal: AbortSignal;
  markActivity(): void;
  getState(): TaskExecutionTimeoutState;
  cleanup(): void;
}

const unrefTimer = (handle: ReturnType<typeof setTimeout>): void => {
  const candidate = handle as ReturnType<typeof setTimeout> & {
    unref?: () => void;
  };

  candidate.unref?.();
};

const normalizePositiveDuration = (
  value: number | undefined,
  fallback?: number,
): number | undefined => {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.max(1, Math.round(value));
};

export const resolveTaskExecutionTimeouts = (
  options: Pick<TaskExecutionOptions, "maxDurationMs" | "idleTimeoutMs">,
): ResolvedTaskExecutionTimeouts => {
  const absoluteTimeoutMs =
    options.maxDurationMs === null
      ? undefined
      : normalizePositiveDuration(options.maxDurationMs);
  const idleTimeoutMs =
    options.idleTimeoutMs === null ||
    (options.maxDurationMs === null && options.idleTimeoutMs === undefined)
      ? undefined
      : normalizePositiveDuration(
          options.idleTimeoutMs,
          TASK_EXECUTION_IDLE_TIMEOUT_MS,
        );

  return {
    absoluteTimeoutMs,
    idleTimeoutMs:
      idleTimeoutMs !== undefined && absoluteTimeoutMs !== undefined
        ? Math.min(idleTimeoutMs, absoluteTimeoutMs)
        : idleTimeoutMs,
  };
};

const formatExecutionDuration = (durationMs: number): string => {
  if (durationMs % 60_000 === 0) {
    const minutes = durationMs / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  if (durationMs % 1_000 === 0) {
    const seconds = durationMs / 1_000;
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }

  return `${durationMs}ms`;
};

const createAbsoluteTimeoutReason = (durationMs: number): string => {
  return `${TASK_EXECUTION_TIMEOUT_REASON_PREFIX} of ${formatExecutionDuration(durationMs)}.`;
};

const createIdleTimeoutReason = (durationMs: number): string => {
  return `${TASK_EXECUTION_TIMEOUT_REASON_PREFIX} of ${formatExecutionDuration(durationMs)} without meaningful progress.`;
};

export const isTaskExecutionTimeoutReason = (reason: string): boolean => {
  return reason.startsWith(TASK_EXECUTION_TIMEOUT_REASON_PREFIX);
};

export const createManagedTaskExecutionTimeout = (
  sourceSignal: AbortSignal | undefined,
  timeouts: ResolvedTaskExecutionTimeouts,
): ManagedTaskExecutionTimeout => {
  const abortController = new AbortController();
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  let absoluteTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let idleTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let cleanedUp = false;

  const clearAbsoluteTimeout = (): void => {
    if (absoluteTimeoutHandle !== undefined) {
      clearTimeout(absoluteTimeoutHandle);
      absoluteTimeoutHandle = undefined;
    }
  };

  const clearIdleTimeout = (): void => {
    if (idleTimeoutHandle !== undefined) {
      clearTimeout(idleTimeoutHandle);
      idleTimeoutHandle = undefined;
    }
  };

  const clearTimeouts = (): void => {
    clearAbsoluteTimeout();
    clearIdleTimeout();
  };

  const abort = (reason: unknown): void => {
    if (abortController.signal.aborted) {
      return;
    }

    clearTimeouts();
    abortController.abort(reason);
  };

  const forwardAbort = (): void => {
    abort(sourceSignal?.reason);
  };

  const scheduleIdleTimeout = (): void => {
    const { idleTimeoutMs } = timeouts;

    if (
      idleTimeoutMs === undefined ||
      cleanedUp ||
      abortController.signal.aborted
    ) {
      return;
    }

    clearIdleTimeout();
    idleTimeoutHandle = setTimeout(() => {
      idleTimeoutHandle = undefined;
      abort(createIdleTimeoutReason(idleTimeoutMs));
    }, idleTimeoutMs);
    unrefTimer(idleTimeoutHandle);
  };

  if (sourceSignal?.aborted) {
    forwardAbort();
  } else if (sourceSignal) {
    sourceSignal.addEventListener("abort", forwardAbort, { once: true });
  }

  if (!abortController.signal.aborted && timeouts.absoluteTimeoutMs !== undefined) {
    const { absoluteTimeoutMs } = timeouts;

    absoluteTimeoutHandle = setTimeout(() => {
      absoluteTimeoutHandle = undefined;
      abort(createAbsoluteTimeoutReason(absoluteTimeoutMs));
    }, absoluteTimeoutMs);
    unrefTimer(absoluteTimeoutHandle);
  }

  scheduleIdleTimeout();

  return {
    signal: abortController.signal,
    markActivity: (): void => {
      if (cleanedUp || abortController.signal.aborted) {
        return;
      }

      lastActivityAt = Date.now();
      scheduleIdleTimeout();
    },
    getState: (): TaskExecutionTimeoutState => ({
      startedAt,
      lastActivityAt,
      idleTimeoutMs: timeouts.idleTimeoutMs ?? null,
      absoluteTimeoutMs: timeouts.absoluteTimeoutMs ?? null,
    }),
    cleanup: (): void => {
      if (cleanedUp) {
        return;
      }

      cleanedUp = true;
      clearTimeouts();
      sourceSignal?.removeEventListener("abort", forwardAbort);
    },
  };
};
