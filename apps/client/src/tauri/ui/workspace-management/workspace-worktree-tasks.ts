import type { RalphFlowScope, RalphRunSummary } from "../../../core/ralph.js";
import { createWorkspaceRootKey } from "./workspace-management-model";

export interface WorktreeTask {
  runId: string;
  flowId: string;
  flowName: string;
  scope: RalphFlowScope;
}

export interface ScopedRalphRuns {
  scope: RalphFlowScope;
  runs: readonly RalphRunSummary[];
}

const isInside = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}/`);

export const matchWorktreeTasks = (
  worktreePaths: readonly string[],
  runLists: readonly ScopedRalphRuns[],
): Map<string, WorktreeTask> => {
  const runs = runLists
    .flatMap(({ scope, runs }) => runs.map((run) => ({ scope, run })))
    .filter(({ run }) => run.worktreePath)
    .sort((left, right) =>
      right.run.createdAt.localeCompare(left.run.createdAt),
    );
  const tasks = new Map<string, WorktreeTask>();
  for (const worktreePath of worktreePaths) {
    const root = createWorkspaceRootKey(worktreePath);
    const match = runs.find(({ run }) =>
      isInside(createWorkspaceRootKey(run.worktreePath ?? ""), root),
    );
    if (match) {
      tasks.set(worktreePath, {
        runId: match.run.id,
        flowId: match.run.flowId,
        flowName: match.run.flowName,
        scope: match.scope,
      });
    }
  }
  return tasks;
};
