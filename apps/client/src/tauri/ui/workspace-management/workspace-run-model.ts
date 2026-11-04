import type {
  WorkspaceRunConfigurationStatus,
  WorkspaceRunFailure,
  WorkspaceRunInput,
  WorkspaceRunInputValue,
  WorkspaceRunInputValues,
  WorkspaceRunLifecycleState,
  WorkspaceRunLogBatch,
  WorkspaceRunLogEntry,
  WorkspaceRunSnapshot,
  WorkspaceRunType,
} from "../../../shared/workspace-run.js";
import { WORKSPACE_RUN_MAX_LOG_ENTRIES } from "../../../shared/workspace-run.js";
import {
  resolveWorkspaceRunInputText,
  workspaceRunDefaultInputValue,
  workspaceRunInputValueError,
  workspaceRunTaskInputIds,
} from "../../../shared/workspace-run-inputs.js";

export interface WorkspaceRunStatePresentation {
  label: string;
  tone: "idle" | "progress" | "success" | "warning" | "danger";
}

const STATE_PRESENTATION: Record<
  WorkspaceRunLifecycleState,
  WorkspaceRunStatePresentation
> = {
  stopped: { label: "Stopped", tone: "idle" },
  starting: { label: "Starting", tone: "progress" },
  running: { label: "Running", tone: "success" },
  unhealthy: { label: "Unhealthy", tone: "warning" },
  restarting: { label: "Restarting", tone: "progress" },
  crashed: { label: "Crashed", tone: "danger" },
  stopping: { label: "Stopping", tone: "progress" },
};

export const workspaceRunStatePresentation = (
  state: WorkspaceRunLifecycleState,
): WorkspaceRunStatePresentation => STATE_PRESENTATION[state];

export const workspaceRunConfigurationLabel = (
  status: WorkspaceRunConfigurationStatus,
  peers: readonly WorkspaceRunConfigurationStatus[],
): string => {
  const duplicateName = peers.some(
    (peer) =>
      peer.configuration.id !== status.configuration.id &&
      peer.configuration.name.localeCompare(
        status.configuration.name,
        undefined,
        {
          sensitivity: "accent",
        },
      ) === 0,
  );
  return duplicateName
    ? `${status.configuration.name} (${status.configuration.id})`
    : status.configuration.name;
};

const workspaceRunCompleted = (
  status: WorkspaceRunConfigurationStatus,
): boolean => {
  if (status.state !== "stopped" || status.startedAt === null) return false;
  if (status.configuration.kind === "task") return status.exitCode === 0;
  return (
    status.children.length > 0 && status.children.every(workspaceRunCompleted)
  );
};

export const workspaceRunType = (
  status: WorkspaceRunConfigurationStatus,
): WorkspaceRunType => {
  if (status.configuration.kind === "task") return status.configuration.runType;
  return status.children.length > 0 &&
    status.children.every((child) => workspaceRunType(child) === "job")
    ? "job"
    : "service";
};

export const workspaceRunStatusPresentation = (
  status: WorkspaceRunConfigurationStatus,
): WorkspaceRunStatePresentation => {
  if (workspaceRunCompleted(status)) {
    return { label: "Completed", tone: "success" };
  }
  if (workspaceRunType(status) === "job") {
    if (status.state === "crashed") return { label: "Failed", tone: "danger" };
    if (status.state === "stopped" && status.startedAt === null) {
      return { label: "Not run", tone: "idle" };
    }
  }
  return workspaceRunStatePresentation(status.state);
};

export const formatWorkspaceRunDuration = (milliseconds: number): string => {
  const seconds = Math.max(0, milliseconds) / 1_000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.floor(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

export const workspaceRunElapsed = (
  status: WorkspaceRunConfigurationStatus,
  now: number,
): number | null => {
  if (status.startedAt === null) return null;
  if (workspaceRunIsActive(status)) return now - status.startedAt;
  return status.stoppedAt !== null && status.stoppedAt >= status.startedAt
    ? status.stoppedAt - status.startedAt
    : null;
};

export interface WorkspaceRunListGroup {
  name: string | null;
  statuses: WorkspaceRunConfigurationStatus[];
}

export interface WorkspaceRunListSection {
  runType: WorkspaceRunType;
  groups: WorkspaceRunListGroup[];
}

const matchesWorkspaceRunQuery = (
  status: WorkspaceRunConfigurationStatus,
  query: string,
): boolean => {
  const { configuration } = status;
  return [
    configuration.name,
    configuration.id,
    configuration.group ?? "",
    configuration.kind === "task" ? configuration.command : "",
  ].some((value) => value.toLocaleLowerCase().includes(query));
};

export const workspaceRunListSections = (
  statuses: readonly WorkspaceRunConfigurationStatus[],
  query: string,
): WorkspaceRunListSection[] => {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return (["service", "job"] as const).flatMap((runType) => {
    const groups: WorkspaceRunListGroup[] = [];
    for (const status of statuses) {
      if (
        workspaceRunType(status) !== runType ||
        (normalizedQuery && !matchesWorkspaceRunQuery(status, normalizedQuery))
      ) {
        continue;
      }
      const name = status.configuration.group ?? null;
      const group = groups.find((candidate) => candidate.name === name);
      if (group) group.statuses.push(status);
      else groups.push({ name, statuses: [status] });
    }
    groups.sort(
      (left, right) => Number(left.name !== null) - Number(right.name !== null),
    );
    return groups.length > 0 ? [{ runType, groups }] : [];
  });
};

export const workspaceRunStatusInputs = (
  status: WorkspaceRunConfigurationStatus,
  inputs: readonly WorkspaceRunInput[],
): WorkspaceRunInput[] => {
  const ids =
    status.configuration.kind === "task"
      ? workspaceRunTaskInputIds(status.configuration)
      : Array.from(
          new Set(
            status.children.flatMap((child) =>
              child.configuration.kind === "task"
                ? workspaceRunTaskInputIds(child.configuration)
                : [],
            ),
          ),
        );
  return ids.flatMap((id) => inputs.filter((input) => input.id === id));
};

export const workspaceRunInitialInputValues = (
  inputs: readonly WorkspaceRunInput[],
): WorkspaceRunInputValues =>
  Object.fromEntries(
    inputs.map((input) => [input.id, workspaceRunDefaultInputValue(input)]),
  );

export const workspaceRunInputErrors = (
  inputs: readonly WorkspaceRunInput[],
  values: WorkspaceRunInputValues,
): Record<string, string> =>
  Object.fromEntries(
    inputs.flatMap((input) => {
      const error = workspaceRunInputValueError(
        input,
        values[input.id] ?? workspaceRunDefaultInputValue(input),
      );
      return error ? [[input.id, error] as const] : [];
    }),
  );

export const workspaceRunCommandPreview = (
  status: WorkspaceRunConfigurationStatus,
  inputs: readonly WorkspaceRunInput[],
  values: WorkspaceRunInputValues,
): string | null =>
  status.configuration.kind === "task"
    ? resolveWorkspaceRunInputText(status.configuration.command, inputs, values)
    : null;

export const workspaceRunInputValueLabel = (
  input: WorkspaceRunInput,
  value: WorkspaceRunInputValue,
): string => {
  if (input.type === "boolean") return value === true ? "On" : "Off";
  if (input.type === "select") {
    const option = input.options.find((candidate) => candidate.value === value);
    return option?.label ?? (option?.value || "None");
  }
  return String(value) || "Empty";
};

export const workspaceRunPrimaryStatus = (
  snapshot: WorkspaceRunSnapshot | null,
): WorkspaceRunConfigurationStatus | null => {
  if (!snapshot) return null;
  return (
    snapshot.configurations.find((status) => status.configuration.primary) ??
    null
  );
};

export const workspaceRunSupportsHotReload = (
  status: WorkspaceRunConfigurationStatus,
): boolean => {
  if (status.configuration.kind === "task") {
    return status.configuration.hotReload;
  }
  return (
    status.children.length > 0 &&
    status.children.every(workspaceRunSupportsHotReload)
  );
};

export const workspaceRunIsActive = (
  status: WorkspaceRunConfigurationStatus,
): boolean => {
  if (status.configuration.kind === "composite") {
    return (
      status.children.some(workspaceRunIsActive) ||
      ["starting", "restarting", "stopping"].includes(status.state)
    );
  }
  if (status.state === "unhealthy") return status.pid !== null;
  return ["starting", "running", "restarting", "stopping"].includes(
    status.state,
  );
};

export const workspaceRunDirectAction = (
  status: WorkspaceRunConfigurationStatus,
): "start" | "stop" | "none" => {
  if (status.state === "stopping") return "none";
  if (workspaceRunIsActive(status)) return "stop";
  return "start";
};

export const workspaceRunCanRestart = (
  status: WorkspaceRunConfigurationStatus,
): boolean =>
  workspaceRunIsActive(status) &&
  !["starting", "restarting", "stopping"].includes(status.state);

export interface WorkspaceRunCollectedLog {
  configurationId: string;
  label: string;
  entry: WorkspaceRunLogEntry;
}

export const collectWorkspaceRunLogs = (
  status: WorkspaceRunConfigurationStatus,
): WorkspaceRunCollectedLog[] => {
  if (status.configuration.kind === "task") {
    return status.logs.map((entry) => ({
      configurationId: status.configuration.id,
      label: status.configuration.name,
      entry,
    }));
  }
  return status.children
    .flatMap((child) =>
      collectWorkspaceRunLogs(child).map((log) => ({
        ...log,
        label: workspaceRunConfigurationLabel(child, status.children),
      })),
    )
    .sort(
      (left, right) =>
        left.entry.sequence - right.entry.sequence ||
        left.entry.at - right.entry.at,
    );
};

export const applyWorkspaceRunLogBatch = (
  snapshot: WorkspaceRunSnapshot,
  batch: WorkspaceRunLogBatch,
): WorkspaceRunSnapshot => {
  const entriesByConfiguration = new Map<
    string,
    WorkspaceRunLogBatch["entries"]
  >();
  for (const update of batch.entries) {
    const entries = entriesByConfiguration.get(update.configurationId) ?? [];
    entries.push(update);
    entriesByConfiguration.set(update.configurationId, entries);
  }

  const apply = (
    status: WorkspaceRunConfigurationStatus,
  ): WorkspaceRunConfigurationStatus => {
    const updates = entriesByConfiguration.get(status.configuration.id);
    const children = status.children.map(apply);
    if (status.configuration.kind === "composite") {
      return { ...status, children };
    }
    const currentUpdates = updates?.filter(
      (update) => update.startedAt === status.startedAt,
    );
    if (!currentUpdates?.length) return status;
    const bySequence = new Map(
      status.logs.map((entry) => [entry.sequence, entry] as const),
    );
    for (const { entry } of currentUpdates) {
      bySequence.set(entry.sequence, entry);
    }
    const logs = Array.from(bySequence.values())
      .sort((left, right) => left.sequence - right.sequence)
      .slice(-WORKSPACE_RUN_MAX_LOG_ENTRIES);
    return { ...status, logs, children };
  };

  return {
    ...snapshot,
    configurations: snapshot.configurations.map(apply),
  };
};

export const mergeWorkspaceRunSnapshotLogs = (
  previous: WorkspaceRunSnapshot,
  next: WorkspaceRunSnapshot,
): WorkspaceRunSnapshot => {
  const previousById = new Map(
    previous.configurations.map(
      (status) => [status.configuration.id, status] as const,
    ),
  );
  const mergeStatus = (
    status: WorkspaceRunConfigurationStatus,
    prior: WorkspaceRunConfigurationStatus | undefined,
  ): WorkspaceRunConfigurationStatus => {
    if (!prior || status.startedAt !== prior.startedAt) return status;
    const bySequence = new Map(
      prior.logs.map((entry) => [entry.sequence, entry] as const),
    );
    for (const entry of status.logs) bySequence.set(entry.sequence, entry);
    const priorChildren = new Map(
      prior.children.map((child) => [child.configuration.id, child] as const),
    );
    return {
      ...status,
      logs: Array.from(bySequence.values())
        .sort((left, right) => left.sequence - right.sequence)
        .slice(-WORKSPACE_RUN_MAX_LOG_ENTRIES),
      children: status.children.map((child) =>
        mergeStatus(child, priorChildren.get(child.configuration.id)),
      ),
    };
  };

  return {
    ...next,
    configurations: next.configurations.map((status) =>
      mergeStatus(status, previousById.get(status.configuration.id)),
    ),
  };
};

export const workspaceRunCurrentFailure = (
  status: WorkspaceRunConfigurationStatus,
): WorkspaceRunFailure | null => {
  const candidates = [status, ...status.children]
    .filter((candidate) => ["crashed", "unhealthy"].includes(candidate.state))
    .flatMap((candidate) => candidate.recentFailures)
    .sort((left, right) => right.at - left.at);
  return candidates[0] ?? null;
};

export const workspaceRunStatusPorts = (
  status: WorkspaceRunConfigurationStatus,
): number[] => {
  if (status.configuration.kind === "task") {
    return status.configuration.ports;
  }
  return Array.from(
    new Set(status.children.flatMap(workspaceRunStatusPorts)),
  ).sort((left, right) => left - right);
};

export const workspaceRunStatusUrls = (
  status: WorkspaceRunConfigurationStatus,
): string[] => {
  if (status.configuration.kind === "task") {
    return status.configuration.urls;
  }
  return Array.from(new Set(status.children.flatMap(workspaceRunStatusUrls)));
};
