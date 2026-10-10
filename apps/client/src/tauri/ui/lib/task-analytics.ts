import { observeJob } from "@machdoch/analytics/browser";
import type { Feature } from "@machdoch/analytics/catalog";
import type {
  ActiveDesktopTaskSummary,
  RecentDesktopTaskResult,
} from "../../../shared/task-run-state.js";

const taskFeatures: Readonly<Record<string, Feature>> = {
  "chat-run": "chat",
  "prompt-enhancement": "chat",
  "task-interview": "chat",
  ralph: "ralph",
  scheduler: "scheduler",
};

export function observeDesktopTasks(
  tasks: readonly (ActiveDesktopTaskSummary | RecentDesktopTaskResult)[],
): void {
  for (const task of tasks) {
    if (!Object.hasOwn(taskFeatures, task.kind)) continue;
    const feature = taskFeatures[task.kind]!;
    const status =
      "outcome" in task
        ? task.outcome.status === "succeeded"
          ? "succeeded"
          : task.outcome.failure.kind === "cancelled"
            ? "cancelled"
            : "failed"
        : "running";
    observeJob(task.id, feature, status);
  }
}
