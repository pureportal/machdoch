import type { RalphFlowScope, RalphRunSummary } from "../../../core/ralph.js";
import {
  getCatalogModelsForProvider,
  SUPPORTED_PROVIDER_ORDER,
  type ProviderModelCatalogSnapshot,
  type RuntimeProvider,
} from "../model-catalog";
import { getReasoningModesForProvider } from "../reasoning-options";
import {
  listRalphFlows,
  listRalphRuns,
  loadActiveDesktopTasks,
  resumeRalphRun,
  runRalphFlow,
  type ActiveDesktopTaskSummary,
  type FleetControlCommandEvent,
  type FleetShellRalphSnapshot,
  type RuntimeSnapshot,
} from "../runtime";
import {
  getRalphTaskAction,
  getRalphTaskFlowReference,
  getRalphTaskFlowScope,
  normalizeWorkspaceForTaskComparison,
  parseRalphRunTaskId,
} from "./_helpers/parse-ralph-run-task-id.helper";

const RECOVERABLE_STATUSES = new Set(["crashed", "blocked", "abandoned"]);

export interface FleetRalphCommandRuntime {
  workspace: string;
  provider: RuntimeProvider;
  model: string;
  reasoning: RuntimeSnapshot["reasoning"];
  scope: RalphFlowScope;
  taskId: string;
}

const toTimestamp = (value: string | undefined): number | undefined => {
  if (!value) return undefined;

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : undefined;
};

const getTaskTarget = (task: ActiveDesktopTaskSummary): string | null =>
  task.arguments[1]?.trim() || null;

const getFlowForReference = (
  flows: FleetShellRalphSnapshot["flows"],
  scope: RalphFlowScope,
  reference: string,
): FleetShellRalphSnapshot["flows"][number] | undefined =>
  flows.find(
    (flow) =>
      flow.scope === scope &&
      (flow.id === reference || flow.alias === reference),
  );

const createRunSnapshot = (
  run: RalphRunSummary,
  scope: RalphFlowScope,
  task?: ActiveDesktopTaskSummary,
): FleetShellRalphSnapshot["runs"][number] => {
  const finishedAt = task ? undefined : toTimestamp(run.finishedAt);
  const status = task ? "running" : run.status;
  return {
    id: run.id,
    flowId: run.flowId,
    flowName: run.flowName,
    scope,
    status,
    summary: run.summary,
    createdAt: toTimestamp(run.createdAt) ?? task?.startedAt ?? 0,
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    blockCount: run.blockCount,
    eventCount: run.eventCount,
    ...(task ? { taskId: task.id } : {}),
    cancellable: Boolean(task),
    recoverable:
      !task &&
      RECOVERABLE_STATUSES.has(run.status) &&
      run.recoverable,
  };
};

const takeTaskForRun = (
  tasks: ActiveDesktopTaskSummary[],
  run: RalphRunSummary,
  scope: RalphFlowScope,
  flows: FleetShellRalphSnapshot["flows"],
): ActiveDesktopTaskSummary | undefined => {
  const createdAt = toTimestamp(run.createdAt) ?? 0;
  const candidates = tasks.flatMap((task, index) => {
    if (getRalphTaskFlowScope(task) !== scope) return [];

    const action = getRalphTaskAction(task);
    const target = getTaskTarget(task);
    const matches =
      action === "resume"
        ? target === run.id
        : action === "run" &&
          run.status === "running" &&
          Boolean(
            target &&
            getFlowForReference(flows, scope, target)?.id === run.flowId,
          );

    return matches
      ? [{ index, distance: Math.abs(task.startedAt - createdAt) }]
      : [];
  });
  const match = candidates.sort(
    (left, right) => left.distance - right.distance,
  )[0];
  if (!match) return undefined;
  return tasks.splice(match.index, 1)[0];
};

const createActiveRunSnapshot = (
  task: ActiveDesktopTaskSummary,
  flows: FleetShellRalphSnapshot["flows"],
): FleetShellRalphSnapshot["runs"][number] | null => {
  const action = getRalphTaskAction(task);
  if (action !== "run" && action !== "resume") return null;

  const scope = getRalphTaskFlowScope(task);
  const target = getTaskTarget(task);
  if (!target) return null;

  const parsedTaskId = task.id.startsWith("ralph-fleet-")
    ? null
    : parseRalphRunTaskId(task.id);
  const flowReference = getRalphTaskFlowReference(task);
  const flow = flowReference
    ? getFlowForReference(flows, scope, flowReference)
    : parsedTaskId
      ? getFlowForReference(flows, scope, parsedTaskId.flowId)
      : undefined;
  const runId = action === "resume" ? target : task.id;
  const flowId = flow?.id ?? parsedTaskId?.flowId ?? target;

  return {
    id: runId,
    flowId,
    flowName: flow?.name ?? flowId,
    scope,
    status: "running",
    summary: "",
    createdAt: task.startedAt,
    blockCount: 0,
    eventCount: 0,
    taskId: task.id,
    cancellable: true,
    recoverable: false,
  };
};

export const loadFleetRalphSnapshot = async (
  workspaceRoot: string,
): Promise<FleetShellRalphSnapshot> => {
  const normalizedWorkspace =
    normalizeWorkspaceForTaskComparison(workspaceRoot);
  const [flowResults, runResults, activeTasks] = await Promise.all([
    Promise.all(
      (["workspace", "user"] as const).map(async (scope) => ({
        scope,
        result: await listRalphFlows(workspaceRoot, scope),
      })),
    ),
    Promise.all(
      (["workspace", "user"] as const).map(async (scope) => ({
        scope,
        result: await listRalphRuns(workspaceRoot, undefined, scope),
      })),
    ),
    loadActiveDesktopTasks(),
  ]);
  const unmatchedTasks = (activeTasks ?? []).filter(
    (task) =>
      task.kind === "ralph" &&
      normalizeWorkspaceForTaskComparison(task.workspaceRoot) ===
        normalizedWorkspace,
  );
  const flows = flowResults
    .flatMap(({ result, scope }) =>
      result.flows.map((flow) => ({
        id: flow.id,
        ...(flow.alias ? { alias: flow.alias } : {}),
        name: flow.name,
        scope,
        ...(flow.description ? { description: flow.description } : {}),
        blockCount: flow.blockCount,
        edgeCount: flow.edgeCount,
        variables: flow.variables,
        ...(flow.maxTransitions ? { maxTransitions: flow.maxTransitions } : {}),
      })),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  const runs = runResults.flatMap(({ result, scope }) =>
    result.runs.map((run) =>
      createRunSnapshot(
        run,
        scope,
        takeTaskForRun(unmatchedTasks, run, scope, flows),
      ),
    ),
  );

  for (const task of unmatchedTasks) {
    const run = createActiveRunSnapshot(task, flows);
    if (run) runs.push(run);
  }

  runs.sort((left, right) => right.createdAt - left.createdAt);

  return {
    workspaceRoot,
    loading: false,
    flows,
    runs,
    updatedAt: Date.now(),
  };
};

const requireCommandValue = (
  value: string | undefined,
  label: string,
): string => {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`RALPH ${label} is missing.`);
  return normalized;
};

export const resolveFleetRalphCommandRuntime = (
  command: FleetControlCommandEvent,
  modelCatalog: ProviderModelCatalogSnapshot | null,
): FleetRalphCommandRuntime => {
  if (command.kind !== "ralph-run" && command.kind !== "ralph-resume-run") {
    throw new Error("Unsupported RALPH command.");
  }

  const workspace = requireCommandValue(command.workspace, "workspace");
  const providerValue = requireCommandValue(command.provider, "provider");
  if (!SUPPORTED_PROVIDER_ORDER.includes(providerValue as RuntimeProvider)) {
    throw new Error("The selected RALPH provider is unavailable.");
  }
  const provider = providerValue as RuntimeProvider;
  const model = requireCommandValue(command.model, "model");
  const catalogModel = getCatalogModelsForProvider(provider, modelCatalog).find(
    (entry) => entry.id === model,
  );
  if (!catalogModel) {
    throw new Error("The selected RALPH model is unavailable.");
  }

  const reasoningValue = requireCommandValue(command.reasoning, "reasoning");
  const reasoningModes = getReasoningModesForProvider(
    provider,
    model,
    catalogModel.capabilities,
  );
  if (
    !reasoningModes.includes(reasoningValue as RuntimeSnapshot["reasoning"])
  ) {
    throw new Error("The selected RALPH reasoning mode is unavailable.");
  }
  const scope = command.scope;
  if (scope !== "workspace" && scope !== "user") {
    throw new Error("RALPH scope is missing.");
  }

  return {
    workspace,
    provider,
    model,
    reasoning: reasoningValue as RuntimeSnapshot["reasoning"],
    scope,
    taskId: `ralph-fleet-${command.commandId}`,
  };
};

export const executeFleetRalphCommand = async (
  command: FleetControlCommandEvent,
  runtime: FleetRalphCommandRuntime,
): Promise<void> => {
  const options = {
    scope: runtime.scope,
    mode: "machdoch" as const,
    provider: runtime.provider,
    model: runtime.model,
    reasoning: runtime.reasoning,
    taskId: runtime.taskId,
    ...(command.maxTransitions
      ? { maxTransitions: command.maxTransitions }
      : {}),
  };

  if (command.kind === "ralph-run") {
    await runRalphFlow(runtime.workspace, {
      ...options,
      name: requireCommandValue(command.flowId, "flow"),
      params: command.parameters ?? {},
    });
    return;
  }

  if (command.kind === "ralph-resume-run") {
    await resumeRalphRun(runtime.workspace, {
      ...options,
      runId: requireCommandValue(command.runId, "run"),
      retryCurrent: true,
    });
    return;
  }

  throw new Error("Unsupported RALPH command.");
};
