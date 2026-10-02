import { setTimeout } from "node:timers/promises";

const TRANSIENT_PERSISTENCE_ERROR_CODES = new Set([
  "EACCES",
  "EAGAIN",
  "EBUSY",
  "EMFILE",
  "ENFILE",
  "EPERM",
]);

export const retryRalphPersistenceOperation = async <T>(
  operation: () => Promise<T>,
  options: {
    retryWindowMs?: number;
    signal?: AbortSignal;
    onRetry?: (error: unknown) => void;
  } = {},
): Promise<T> => {
  const deadline = Date.now() + Math.max(0, options.retryWindowMs ?? 30_000);
  let retryDelayMs = 100;

  for (;;) {
    options.signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (
        !code ||
        !TRANSIENT_PERSISTENCE_ERROR_CODES.has(code) ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      options.onRetry?.(error);
      await setTimeout(
        Math.min(retryDelayMs, Math.max(0, deadline - Date.now())),
        undefined,
        { signal: options.signal },
      );
      retryDelayMs = Math.min(1_000, retryDelayMs * 2);
    }
  }
};
