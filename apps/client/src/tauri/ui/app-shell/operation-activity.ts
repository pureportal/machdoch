import type { AppActivityState } from "./app-rail";

export const toAppActivityState = (
  running: boolean,
  completed: boolean,
): AppActivityState => {
  if (running && completed) {
    return "running-and-completed";
  }

  if (running) {
    return "running";
  }

  return completed ? "completed" : "idle";
};

export const getCompletedOperationIds = (
  previousOperationIds: ReadonlySet<string>,
  activeOperationIds: ReadonlySet<string>,
): string[] => {
  return [...previousOperationIds]
    .filter((operationId) => !activeOperationIds.has(operationId))
    .sort();
};
