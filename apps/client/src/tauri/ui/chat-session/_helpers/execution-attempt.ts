export interface ExecutionAttempt {
  rootTaskId: string;
  task: string;
  retryNumber: number;
  retryLimit: number;
  previousTaskId?: string;
  failureContext?: string;
}

export const normalizeExecutionAttempt = (
  value: unknown,
): ExecutionAttempt | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.rootTaskId !== "string" ||
    !entry.rootTaskId.trim() ||
    typeof entry.task !== "string" ||
    !entry.task.trim() ||
    !Number.isSafeInteger(entry.retryNumber) ||
    (entry.retryNumber as number) < 0 ||
    !Number.isSafeInteger(entry.retryLimit) ||
    (entry.retryLimit as number) < 0
  )
    return undefined;
  return {
    rootTaskId: entry.rootTaskId,
    task: entry.task,
    retryNumber: entry.retryNumber as number,
    retryLimit: entry.retryLimit as number,
    ...(typeof entry.previousTaskId === "string"
      ? { previousTaskId: entry.previousTaskId }
      : {}),
    ...(typeof entry.failureContext === "string"
      ? { failureContext: entry.failureContext.slice(0, 8_000) }
      : {}),
  };
};
