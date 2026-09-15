import type { UserAgentLimitsSettings } from "../../../../core/runtime-contract.generated.js";
import type { ChatSessionTaskOutcomeStatus } from "../../chat-session.model";
import type { ExecutionAttempt } from "./execution-attempt";

export type AutomaticRetrySettings = Pick<
  UserAgentLimitsSettings,
  "automaticRetries" | "retryAttempts"
>;

export const getExecutionAttemptTaskId = (attempt: ExecutionAttempt): string =>
  attempt.retryNumber === 0
    ? attempt.rootTaskId
    : `${attempt.rootTaskId}-retry-${attempt.retryNumber}`;

export const createExecutionRetry = (
  previous: ExecutionAttempt,
  failure: {
    taskId: string;
    status: ChatSessionTaskOutcomeStatus;
    context: string;
    failedAt: number;
  },
  settings: AutomaticRetrySettings,
): { attempt: ExecutionAttempt; taskId: string; readyAt: number } | null => {
  const retryNumber = previous.retryNumber + 1;
  if (
    !settings.automaticRetries ||
    retryNumber > settings.retryAttempts ||
    !["failed", "crashed", "timed-out"].includes(failure.status)
  ) {
    return null;
  }

  const attempt: ExecutionAttempt = {
    rootTaskId: previous.rootTaskId,
    task: previous.task,
    retryNumber,
    retryLimit: settings.retryAttempts,
    previousTaskId: failure.taskId,
    failureContext: failure.context.slice(0, 8_000),
  };

  return {
    attempt,
    taskId: getExecutionAttemptTaskId(attempt),
    readyAt:
      failure.failedAt + Math.min(30_000, 2_000 * 2 ** (retryNumber - 1)),
  };
};
