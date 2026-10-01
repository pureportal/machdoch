import type { RecentDesktopTaskResult } from "../../runtime";
import { DesktopTaskRunProtocolError } from "../../desktop-task-error";

export interface RalphTaskCompletion {
  summary: string;
  runId?: string;
  generationStatus?: "created" | "blocked" | "failed";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const readRalphTaskCompletion = (
  task: RecentDesktopTaskResult,
): RalphTaskCompletion | null => {
  if (task.kind !== "ralph") return null;
  if (task.outcome.status === "failed") {
    return {
      summary: new DesktopTaskRunProtocolError(task.outcome.failure).message,
      generationStatus: "failed",
    };
  }
  const response = task.outcome.response;
  const execution = isRecord(response) ? response.execution : undefined;
  if (!isRecord(execution)) return null;
  if (isRecord(execution.run) && typeof execution.run.summary === "string") {
    return {
      summary: execution.run.summary,
      ...(typeof execution.run.runId === "string"
        ? { runId: execution.run.runId }
        : {}),
    };
  }
  if (
    (execution.status === "created" || execution.status === "blocked") &&
    typeof execution.summary === "string"
  ) {
    return { summary: execution.summary, generationStatus: execution.status };
  }
  return null;
};
