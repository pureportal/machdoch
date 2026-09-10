import type {
  RalphFlowScope,
  RalphFlowSummary,
  RalphRunSummary,
} from "../../../core/ralph.js";
import type { ActiveDesktopTaskSummary } from "../runtime";
import {
  getRalphTaskAction,
  getRalphTaskFlowReference,
  getRalphTaskFlowScope,
  normalizeWorkspaceForTaskComparison,
  parseRalphRunTaskId,
} from "./_helpers/parse-ralph-run-task-id.helper";

export interface RalphOverviewLibrary {
  key: string;
  workspaceRoot: string;
  scope: RalphFlowScope;
  flows: RalphFlowSummary[];
  runs: RalphRunSummary[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

export interface RalphOverviewSelection {
  workspaceRoot: string;
  flowId?: string;
  scope: RalphFlowScope;
  runId?: string;
  running?: boolean;
}

export interface RalphOverviewRun {
  key: string;
  workspaceRoot: string | null;
  flowId?: string;
  flowName: string;
  scope: RalphFlowScope;
  runId?: string;
  taskId?: string;
  startedAt: number;
  status: "running" | "generating";
  error: string | null;
}

export const getRalphLibraryKey = (
  workspaceRoot: string,
  scope: RalphFlowScope,
): string =>
  scope === "user"
    ? "user"
    : `workspace:${normalizeWorkspaceForTaskComparison(workspaceRoot)}`;

export const isRalphActivityTask = (task: ActiveDesktopTaskSummary): boolean =>
  task.kind === "ralph" &&
  ["run", "resume", "create"].includes(getRalphTaskAction(task) ?? "");

export const getRalphOverviewRuns = (
  libraries: readonly RalphOverviewLibrary[],
  tasks: readonly ActiveDesktopTaskSummary[],
): RalphOverviewRun[] => {
  const byKey = new Map(libraries.map((library) => [library.key, library]));
  const matchedRuns = new Set<string>();
  const runs: RalphOverviewRun[] = [];

  for (const task of tasks.filter(isRalphActivityTask)) {
    const scope = getRalphTaskFlowScope(task);
    const action = getRalphTaskAction(task);
    const libraryKey = getRalphLibraryKey(task.workspaceRoot, scope);
    const library = byKey.get(libraryKey);
    const reference = getRalphTaskFlowReference(task);
    const flow = library?.flows.find(
      (entry) => entry.id === reference || entry.alias === reference,
    );
    const target = task.arguments[1];
    const candidates = (library?.runs ?? []).filter(
      (run) =>
        !matchedRuns.has(`${libraryKey}:${run.id}`) &&
        (action === "resume"
          ? run.id === target
          : action === "run" &&
            run.status === "running" &&
            run.flowId === (flow?.id ?? reference)) &&
        (!run.workspaceRoot ||
          normalizeWorkspaceForTaskComparison(run.workspaceRoot) ===
            normalizeWorkspaceForTaskComparison(task.workspaceRoot)),
    );
    candidates.sort(
      (left, right) =>
        Math.abs(Date.parse(left.createdAt) - task.startedAt) -
        Math.abs(Date.parse(right.createdAt) - task.startedAt),
    );
    const run = candidates[0];
    if (run) matchedRuns.add(`${libraryKey}:${run.id}`);
    const flowId =
      run?.flowId ??
      flow?.id ??
      reference ??
      parseRalphRunTaskId(task.id)?.flowId;
    runs.push({
      key: task.id,
      workspaceRoot: task.workspaceRoot,
      flowId: action === "create" ? undefined : flowId,
      flowName:
        run?.flowName ??
        flow?.name ??
        reference ??
        (action === "resume" ? "Resuming flow" : "Generating flow"),
      scope,
      runId: run?.id ?? (action === "resume" ? target : undefined),
      taskId: task.id,
      startedAt: task.startedAt,
      status: action === "create" ? "generating" : "running",
      error: null,
    });
  }

  for (const library of libraries) {
    for (const run of library.runs) {
      const key = `${library.key}:${run.id}`;
      if (run.status !== "running" || matchedRuns.has(key)) continue;
      runs.push({
        key,
        workspaceRoot:
          library.scope === "workspace"
            ? library.workspaceRoot
            : (run.workspaceRoot ?? null),
        flowId: run.flowId,
        flowName: run.flowName,
        scope: library.scope,
        runId: run.id,
        startedAt: Date.parse(run.createdAt),
        status: "running",
        error: library.error,
      });
    }
  }

  return runs.sort(
    (left, right) =>
      right.startedAt - left.startedAt || left.key.localeCompare(right.key),
  );
};
