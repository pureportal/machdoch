import type { TaskExecutionProgress } from "../core/types.js";

export type DesktopTaskRunFailure =
  | { kind: "task-already-active"; taskId: string }
  | { kind: "operation-already-active"; activeTaskId: string }
  | { kind: "cancelled"; message: string }
  | {
      kind: "timed-out";
      timeoutKind: "idle" | "absolute";
      message: string;
    }
  | { kind: "runtime"; message: string };

export interface ActiveDesktopTaskSummary {
  progressEvents?: Array<{
    timestamp: number;
    progress: TaskExecutionProgress;
  }>;
  id: string;
  kind: string;
  workspaceRoot: string;
  arguments: string[];
  startedAt: number;
  sessionId?: string;
}

export type RecentDesktopTaskOutcome =
  | {
      status: "succeeded";
      response: unknown;
    }
  | {
      status: "failed";
      failure: DesktopTaskRunFailure;
    };

export interface RecentDesktopTaskResult {
  id: string;
  kind: string;
  sessionId?: string;
  workspaceRoot: string;
  arguments: string[];
  startedAt: number;
  finishedAt: number;
  outcome: RecentDesktopTaskOutcome;
}
