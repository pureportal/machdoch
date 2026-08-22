import type { SchedulerRunStatus } from "../runtime";

export const isSchedulerRunActive = (status: SchedulerRunStatus): boolean => {
  return status === "queued" || status === "running";
};

export const getCompletedSchedulerRunIds = (
  previousStatuses: ReadonlyMap<string, SchedulerRunStatus>,
  statuses: ReadonlyMap<string, SchedulerRunStatus>,
): string[] => {
  return [...previousStatuses]
    .flatMap(([runId, previousStatus]) => {
      const status = statuses.get(runId);
      return isSchedulerRunActive(previousStatus) &&
        (status === undefined || !isSchedulerRunActive(status))
        ? [runId]
        : [];
    })
    .sort();
};
