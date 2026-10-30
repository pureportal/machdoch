import { setTimeout as delay } from "node:timers/promises";
import { isTransientRunnerError } from "../connection.ts";
import type { RunnerJournal } from "./journal.ts";

export interface TaskRunner {
  runNext(
    signal: AbortSignal,
  ): Promise<{ runId: string; state: string } | null>;
}

export async function runWorkerLoop(
  runner: TaskRunner,
  journal: RunnerJournal,
  options: {
    signal: AbortSignal;
    once: boolean;
    pollIntervalMs: number;
    onResult: (result: { runId: string; state: string }) => void;
    onError: (message: string) => void;
  },
): Promise<boolean> {
  const { signal } = options;
  let retryDelay = options.pollIntervalMs;
  let reportedError: string | null = null;
  try {
    do {
      let result;
      try {
        result = await runner.runNext(signal);
        retryDelay = options.pollIntervalMs;
        reportedError = null;
      } catch (error) {
        if (options.once || !isTransientRunnerError(error) || signal.aborted)
          throw error;
        const message =
          error instanceof Error ? error.message : "Cloud connection failed";
        if (reportedError !== message) options.onError(message);
        reportedError = message;
        await delay(retryDelay, undefined, { signal });
        retryDelay = Math.min(30000, retryDelay * 2);
        continue;
      }
      if (result) options.onResult(result);
      if (options.once) return !result || result.state === "succeeded";
      if (!signal.aborted)
        await delay(options.pollIntervalMs, undefined, { signal });
    } while (!signal.aborted);
    return true;
  } catch (error) {
    if (
      signal.aborted &&
      !journal.current() &&
      (error === signal.reason ||
        (error instanceof Error && error.name === "AbortError"))
    )
      return true;
    throw error;
  }
}
