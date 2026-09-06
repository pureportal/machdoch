import type { SchedulerRunStatus } from "../runtime";
import type { WorkspaceSchedulerActivity } from "./scheduler-activity-runtime";

export const mergeSchedulerActivityStatuses = (
  previousStatuses: ReadonlyMap<string, SchedulerRunStatus>,
  workspaces: readonly WorkspaceSchedulerActivity[],
): Map<string, SchedulerRunStatus> => {
  const failedRoots = new Set(
    workspaces.flatMap((workspace) =>
      "error" in workspace ? [workspace.workspaceRoot] : [],
    ),
  );
  const statuses = new Map(
    [...previousStatuses].filter(([key]) =>
      failedRoots.has(key.split("\0")[0]),
    ),
  );

  for (const workspace of workspaces) {
    if ("runs" in workspace) {
      for (const run of workspace.runs) {
        statuses.set(`${workspace.workspaceRoot}\0${run.id}`, run.status);
      }
    }
  }

  return statuses;
};

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
