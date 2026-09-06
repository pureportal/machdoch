import { invoke, isTauri } from "@tauri-apps/api/core";
import type { SchedulerRunStatus } from "../runtime";

export type WorkspaceSchedulerActivity =
  | {
      workspaceRoot: string;
      runs: Array<{ id: string; status: SchedulerRunStatus }>;
    }
  | { workspaceRoot: string; error: string };

export const loadSchedulerActivity = (
  workspaceRoots: readonly string[],
): Promise<WorkspaceSchedulerActivity[]> => {
  if (!isTauri() || workspaceRoots.length === 0) {
    return Promise.resolve([]);
  }

  return invoke<WorkspaceSchedulerActivity[]>("get_scheduler_activity", {
    workspaceRoots: [...new Set(workspaceRoots)],
  });
};
