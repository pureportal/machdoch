import {
  ArrowRight,
  FolderOpen,
  LoaderCircle,
  Plus,
  RefreshCw,
  Workflow,
} from "lucide-react";
import { useMemo } from "react";
import { getWorkspaceLabel } from "../../chat-session/_helpers/session-shell";
import {
  getRalphOverviewRuns,
  type RalphOverviewLibrary,
  type RalphOverviewSelection,
} from "../ralph-overview-model";
import type { ActiveDesktopTaskSummary } from "../../runtime";
import "./ralph-overview.css";
import { normalizeWorkspaceForTaskComparison } from "../_helpers/parse-ralph-run-task-id.helper";

interface RalphOverviewProps {
  libraries: readonly RalphOverviewLibrary[];
  tasks: readonly ActiveDesktopTaskSummary[];
  tasksLoaded: boolean;
  taskError: string | null;
  workspaceRoot: string | null;
  onOpen: (selection: RalphOverviewSelection) => void;
  onRefresh: () => void;
  onChooseWorkspace: () => void;
  onReturnToEditor?: () => void;
}

const statusLabels: Record<string, string> = {
  running: "Running",
  completed: "Completed",
  crashed: "Failed",
  blocked: "Blocked",
  stopped: "Stopped",
  abandoned: "Interrupted",
  partial: "Incomplete",
};

export const RalphOverview = ({
  libraries,
  tasks,
  tasksLoaded,
  taskError,
  workspaceRoot,
  onOpen,
  onRefresh,
  onChooseWorkspace,
  onReturnToEditor,
}: RalphOverviewProps) => {
  const runs = useMemo(
    () => getRalphOverviewRuns(libraries, tasks),
    [libraries, tasks],
  );
  const loading = libraries.some(
    (library) => library.loading || (!library.loaded && !library.error),
  );
  const failed = Boolean(
    taskError || libraries.some((library) => library.error),
  );
  const orderedLibraries = useMemo(
    () =>
      [...libraries].sort((left, right) => {
        if (left.scope !== right.scope)
          return left.scope === "workspace" ? -1 : 1;
        return (
          getWorkspaceLabel(left.workspaceRoot).localeCompare(
            getWorkspaceLabel(right.workspaceRoot),
          ) || left.key.localeCompare(right.key)
        );
      }),
    [libraries],
  );

  return (
    <div className="ralph-overview">
      <header className="ralph-overview-toolbar">
        <h1>
          <Workflow aria-hidden="true" /> RALPH
        </h1>
        <div>
          {onReturnToEditor ? (
            <button type="button" onClick={onReturnToEditor}>
              Back to editor
            </button>
          ) : null}
          <button type="button" onClick={onChooseWorkspace}>
            <Plus aria-hidden="true" /> Add workspace
          </button>
          <button type="button" aria-label="Refresh flows" onClick={onRefresh}>
            <RefreshCw aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="ralph-overview-content">
        <section
          className="ralph-overview-activity"
          aria-labelledby="ralph-running-heading"
        >
          <h2 id="ralph-running-heading">
            Running{runs.length > 0 ? <span>{runs.length}</span> : null}
          </h2>
          {taskError ? (
            <div className="ralph-overview-error" role="alert">
              {taskError}
              <button type="button" onClick={onRefresh}>
                Retry
              </button>
            </div>
          ) : null}
          {runs.length ? (
            <div className="ralph-overview-run-list">
              {runs.map((run) => {
                const targetWorkspace = run.workspaceRoot ?? workspaceRoot;
                return (
                  <button
                    key={run.key}
                    type="button"
                    className="ralph-overview-run"
                    aria-label={`Open ${run.flowName} in ${run.workspaceRoot ?? "global flows"}`}
                    disabled={
                      !targetWorkspace || (Boolean(run.runId) && !run.flowId)
                    }
                    title={
                      run.runId && !run.flowId
                        ? "Loading flow details"
                        : undefined
                    }
                    onClick={() => {
                      if (targetWorkspace)
                        onOpen({
                          workspaceRoot: targetWorkspace,
                          flowId: run.flowId,
                          scope: run.scope,
                          runId: run.runId,
                          running: true,
                        });
                    }}
                  >
                    <LoaderCircle
                      className="ralph-overview-running-icon"
                      aria-hidden="true"
                    />
                    <span className="ralph-overview-flow-name">
                      <strong>{run.flowName}</strong>
                      {run.scope === "user" ? <small>Global flow</small> : null}
                    </span>
                    <span className="ralph-overview-workspace">
                      <strong>
                        {run.workspaceRoot
                          ? getWorkspaceLabel(run.workspaceRoot)
                          : "Workspace unavailable"}
                      </strong>
                      {run.workspaceRoot ? (
                        <small title={run.workspaceRoot}>
                          {run.workspaceRoot}
                        </small>
                      ) : null}
                    </span>
                    <span
                      className="ralph-overview-status"
                      data-state={
                        run.error || taskError ? "unknown" : "running"
                      }
                    >
                      {run.error || taskError
                        ? "Status unavailable"
                        : run.status === "generating"
                          ? "Generating"
                          : "Running"}
                    </span>
                    <ArrowRight aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="ralph-overview-empty" role="status">
              {failed
                ? "Activity unavailable"
                : !tasksLoaded || loading
                  ? "Checking activity…"
                  : "No running flows"}
            </p>
          )}
        </section>
        <section aria-labelledby="ralph-workspaces-heading">
          <h2 id="ralph-workspaces-heading">Flows</h2>
          <div className="ralph-overview-libraries">
            {orderedLibraries.map((library) => {
              const label =
                library.scope === "user"
                  ? "Global flows"
                  : getWorkspaceLabel(library.workspaceRoot);
              const activeFlowIds = new Set(
                runs
                  .filter(
                    (run) =>
                      run.scope === library.scope &&
                      (library.scope === "user" ||
                        normalizeWorkspaceForTaskComparison(
                          run.workspaceRoot,
                        ) ===
                          normalizeWorkspaceForTaskComparison(
                            library.workspaceRoot,
                          )),
                  )
                  .map((run) => run.flowId),
              );
              const latestRunByFlow = new Map(
                [...library.runs]
                  .sort((left, right) =>
                    left.createdAt.localeCompare(right.createdAt),
                  )
                  .map((run) => [run.flowId, run]),
              );
              const flows = [...library.flows].sort(
                (left, right) =>
                  Number(activeFlowIds.has(right.id)) -
                    Number(activeFlowIds.has(left.id)) ||
                  left.name.localeCompare(right.name),
              );
              return (
                <section
                  key={library.key}
                  className="ralph-overview-library"
                  aria-label={
                    library.scope === "user" ? label : library.workspaceRoot
                  }
                >
                  <header>
                    <button
                      type="button"
                      aria-label={`Open ${label} workspace`}
                      onClick={() =>
                        onOpen({
                          workspaceRoot:
                            library.scope === "user"
                              ? (workspaceRoot ?? library.workspaceRoot)
                              : library.workspaceRoot,
                          scope: library.scope,
                        })
                      }
                    >
                      <FolderOpen aria-hidden="true" />
                      <span>
                        <strong>{label}</strong>
                        {library.scope === "workspace" ? (
                          <small title={library.workspaceRoot}>
                            {library.workspaceRoot}
                          </small>
                        ) : null}
                      </span>
                      <ArrowRight aria-hidden="true" />
                    </button>
                  </header>
                  {library.error ? (
                    <div className="ralph-overview-error" role="alert">
                      {library.error}
                      <button type="button" onClick={onRefresh}>
                        Retry
                      </button>
                    </div>
                  ) : null}
                  {flows.length ? (
                    <ul>
                      {flows.map((flow) => {
                        const status = activeFlowIds.has(flow.id)
                          ? "running"
                          : latestRunByFlow.get(flow.id)?.status;
                        return (
                          <li key={flow.id}>
                            <button
                              type="button"
                              aria-label={`Open ${flow.name} in ${label}`}
                              onClick={() =>
                                onOpen({
                                  workspaceRoot:
                                    library.scope === "user"
                                      ? (workspaceRoot ?? library.workspaceRoot)
                                      : library.workspaceRoot,
                                  flowId: flow.id,
                                  scope: library.scope,
                                })
                              }
                            >
                              <span>{flow.name}</span>
                              <span
                                className="ralph-overview-status"
                                data-state={
                                  library.error ? "unknown" : (status ?? "idle")
                                }
                              >
                                {library.error
                                  ? "Status unavailable"
                                  : status
                                    ? (statusLabels[status] ?? status)
                                    : "Idle"}
                              </span>
                              <ArrowRight aria-hidden="true" />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : !library.error ? (
                    <p className="ralph-overview-empty" role="status">
                      {library.loading ? "Loading flows…" : "No flows"}
                    </p>
                  ) : null}
                </section>
              );
            })}
          </div>
          {!libraries.length ? (
            <button
              type="button"
              className="ralph-overview-add"
              onClick={onChooseWorkspace}
            >
              <FolderOpen aria-hidden="true" /> Choose workspace
            </button>
          ) : null}
        </section>
      </div>
    </div>
  );
};
