import type {
  RuntimeConfig,
  TaskExecutionFileReference,
  TaskExecutionMemoryUpdate,
  TaskExecutionProgress,
  TaskExecutionProgressHandler,
  TaskExecutionResult,
  TaskExecutionState,
} from "../types.js";
import type { AgentLoopState } from "./agent-runtime-types.js";
import { isTerminalTaskExecutionState } from "./execution-progress.js";

export const createExecutionResult = (
  base: Omit<TaskExecutionResult, "reason">,
  reason?: string,
): TaskExecutionResult => {
  return {
    ...base,
    ...(reason ? { reason } : {}),
  };
};

export const emitAgentProgress = async (
  task: string,
  config: RuntimeConfig,
  state: TaskExecutionState,
  message: string,
  loopState: AgentLoopState,
  onStateChange: TaskExecutionProgressHandler | undefined,
  result?: TaskExecutionResult,
  progressExtras: Pick<
    TaskExecutionProgress,
    "actionOutput" | "assistantText" | "modelStream" | "timelineEvent"
  > = {},
): Promise<void> => {
  if (!onStateChange) {
    return;
  }

  await onStateChange({
    task,
    mode: config.mode,
    state,
    message,
    executedTools: result?.executedTools ?? loopState.executedTools,
    outputSections: result?.outputSections ?? loopState.outputSections,
    cancellable: !isTerminalTaskExecutionState(state),
    ...(result?.reason ? { reason: result.reason } : {}),
    ...progressExtras,
  });
};

export const normalizeFinalSummary = (text: string | undefined): string => {
  const normalized = text?.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "Completed the task with the model-driven execution loop.";
  }

  if (normalized.length <= 220) {
    return normalized;
  }

  return `${normalized.slice(0, 220)}…`;
};

export const coerceString = (
  record: Record<string, unknown>,
  field: string,
): string | undefined => {
  const value = record[field];

  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
};

export const coerceStringArray = (
  record: Record<string, unknown>,
  field: string,
): string[] | undefined => {
  const value = record[field];

  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.flatMap((entry) =>
    typeof entry === "string" && entry.trim().length > 0 ? [entry.trim()] : [],
  );
};

export const coerceFileReferenceArray = (
  record: Record<string, unknown>,
  field: string,
): TaskExecutionFileReference[] | undefined => {
  const value = record[field];

  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }

    const reference = entry as Record<string, unknown>;
    const path = coerceString(reference, "path");
    const description = coerceString(reference, "description");

    if (!path || !description) {
      return [];
    }

    return [{ path, description }];
  });
};

export const upsertMemoryUpdate = (
  updates: TaskExecutionMemoryUpdate[],
  nextUpdate: TaskExecutionMemoryUpdate,
): TaskExecutionMemoryUpdate[] => {
  const existingWithoutScope = updates.filter(
    (update) =>
      !(
        update.scope === nextUpdate.scope &&
        update.entry.content.toLowerCase() ===
          nextUpdate.entry.content.toLowerCase()
      ),
  );

  return [...existingWithoutScope, nextUpdate];
};
