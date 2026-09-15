import type { TaskExecutionResult } from "../../../../core/types.js";
import { getDesktopTaskRunFailure } from "../../desktop-task-error";
import { createExecutionRetryPrompt } from "./execution-retry";
import {
  createExecutionRetry,
  getExecutionAttemptTaskId,
  type AutomaticRetrySettings,
} from "./execution-retry-policy";
import type { PromptEnhancementAttempt } from "./prompt-enhancement-attempt";
import {
  extractEnhancedPrompt,
  PromptEnhancementCancellationError,
} from "./prompt-enhancement";

interface PromptEnhancementRunOptions {
  taskId: string;
  task: string;
  previousAttempt?: PromptEnhancementAttempt;
  signal: AbortSignal;
  getSettings: () => AutomaticRetrySettings;
  assertActive: () => void;
  persist: (attempt: PromptEnhancementAttempt) => Promise<void>;
  run: (
    task: string,
    taskId: string,
  ) => Promise<{
    execution: Pick<
      TaskExecutionResult,
      "status" | "summary" | "reason" | "response"
    >;
  }>;
}

class PromptEnhancementResultError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const waitForRetry = (delay: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const cancel = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reject(signal.reason);
    };
    const timer = setTimeout(
      () => {
        signal.removeEventListener("abort", cancel);
        resolve();
      },
      Math.max(0, delay),
    );
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });

export const runPromptEnhancement = async (
  options: PromptEnhancementRunOptions,
): Promise<string> => {
  let current: PromptEnhancementAttempt = options.previousAttempt ?? {
    execution: {
      rootTaskId: options.taskId,
      task: options.task,
      retryNumber: 0,
      retryLimit: options.getSettings().retryAttempts,
    },
    status: "running",
    updatedAt: Date.now(),
  };
  const assertActive = (): void => {
    if (options.signal.aborted) {
      throw new PromptEnhancementCancellationError(
        getExecutionAttemptTaskId(current.execution),
      );
    }
    options.assertActive();
  };
  const scheduleRetry = async (
    message: string,
    failedAt: number,
  ): Promise<void> => {
    const retry = createExecutionRetry(
      current.execution,
      {
        taskId: getExecutionAttemptTaskId(current.execution),
        status: "failed",
        context: message,
        failedAt,
      },
      options.getSettings(),
    );
    if (!retry) throw new Error(message);
    current = {
      execution: retry.attempt,
      status: "waiting",
      readyAt: retry.readyAt,
      failureMessage: message,
      updatedAt: Math.max(Date.now(), current.updatedAt + 1),
    };
    await options.persist(current);
  };

  try {
    assertActive();
    if (current.status === "cancelled") {
      throw new PromptEnhancementCancellationError(
        getExecutionAttemptTaskId(current.execution),
      );
    }
    if (current.status === "failed") {
      throw new Error(current.failureMessage ?? "Prompt enhancement failed.");
    }
    if (options.previousAttempt && current.status === "running") {
      await scheduleRetry(
        "Prompt enhancement was interrupted before it completed.",
        current.updatedAt,
      );
    }

    while (true) {
      assertActive();
      if (current.status === "waiting") {
        await waitForRetry(current.readyAt - Date.now(), options.signal);
        assertActive();
        const settings = options.getSettings();
        if (
          !settings.automaticRetries ||
          current.execution.retryNumber > settings.retryAttempts
        ) {
          throw new Error(
            current.failureMessage ?? "Prompt enhancement failed.",
          );
        }
      }
      current = {
        execution: current.execution,
        status: "running",
        updatedAt: Math.max(Date.now(), current.updatedAt + 1),
      };
      await options.persist(current);
      assertActive();

      let enhancedPrompt: string;
      try {
        const taskId = getExecutionAttemptTaskId(current.execution);
        const result = await options.run(
          current.execution.retryNumber > 0
            ? createExecutionRetryPrompt(current.execution)
            : current.execution.task,
          taskId,
        );
        assertActive();
        const execution = result.execution;
        if (execution.status === "cancelled") {
          throw new PromptEnhancementCancellationError(taskId);
        }
        if (execution.status !== "executed" && execution.status !== "planned") {
          throw new PromptEnhancementResultError(
            execution.reason ?? execution.summary,
            execution.status === "failed",
          );
        }
        enhancedPrompt = extractEnhancedPrompt(
          execution.response?.markdown ?? execution.summary,
        );
        if (!enhancedPrompt) {
          throw new Error(
            "Prompt enhancement did not return an enhanced prompt.",
          );
        }
      } catch (error) {
        assertActive();
        const failure = getDesktopTaskRunFailure(error);
        if (failure?.kind === "cancelled") {
          throw new PromptEnhancementCancellationError(
            getExecutionAttemptTaskId(current.execution),
          );
        }
        if (
          error instanceof PromptEnhancementCancellationError ||
          (error instanceof PromptEnhancementResultError && !error.retryable) ||
          failure?.kind === "task-already-active" ||
          failure?.kind === "operation-already-active"
        )
          throw error;
        await scheduleRetry(
          error instanceof Error ? error.message : String(error),
          Date.now(),
        );
        continue;
      }
      return enhancedPrompt;
    }
  } catch (error) {
    const cancelled =
      options.signal.aborted ||
      error instanceof PromptEnhancementCancellationError;
    const failure = cancelled
      ? new PromptEnhancementCancellationError(
          getExecutionAttemptTaskId(current.execution),
        )
      : error instanceof Error
        ? error
        : new Error(String(error));
    await options.persist({
      execution: current.execution,
      status: cancelled ? "cancelled" : "failed",
      failureMessage: failure.message,
      updatedAt: Math.max(Date.now(), current.updatedAt + 1),
    });
    throw failure;
  }
};
