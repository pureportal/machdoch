import type { ReadOnlyInspectionTarget } from "../task-inspection.js";
import type {
  CreateFilePathReference,
  TaskPathReference,
} from "../task-paths.js";
import type {
  ResolvedTaskContext,
  TaskExecutionOptions,
  TaskExecutionProgress,
  TaskExecutionResult,
  TaskExecutionSection,
  TaskExecutionState,
} from "../types.js";
import type {
  RuntimeConfig,
  ToolName,
} from "../runtime-contract.generated.js";
import { TASK_EXECUTION_TIMEOUT_REASON_PREFIX } from "./agent-runtime-types.js";
import { isTerminalTaskExecutionState } from "./execution-progress.js";
import { limitText } from "./runtime-text.js";

export interface TaskExecutionRuntime {
  taskContext: ResolvedTaskContext | undefined;
  contextSections: TaskExecutionSection[];
  explicitPathReference: TaskPathReference | undefined;
  createFileTarget: CreateFilePathReference | undefined;
  inspectionTarget: ReadOnlyInspectionTarget | undefined;
  pendingResult: TaskExecutionResult | undefined;
  executedTools: ToolName[];
}

const PROGRESS_ASSISTANT_TEXT_LIMIT = 4_000;

export const createExecutionResult = (
  base: Omit<TaskExecutionResult, "reason">,
  reason?: string,
): TaskExecutionResult => {
  return {
    ...base,
    ...(reason ? { reason } : {}),
  };
};

export const createInvariantViolationResult = (
  task: string,
  config: RuntimeConfig,
  runtime: TaskExecutionRuntime,
  summary: string,
  reason: string,
): TaskExecutionResult => {
  return createExecutionResult(
    {
      task,
      mode: config.mode,
      status: "blocked",
      summary,
      executedTools: runtime.executedTools,
      outputSections: runtime.contextSections,
    },
    reason,
  );
};

const createProgressSnapshot = (
  task: string,
  config: RuntimeConfig,
  state: TaskExecutionState,
  message: string,
  runtime: TaskExecutionRuntime,
  result?: TaskExecutionResult,
): TaskExecutionProgress => {
  const assistantText = result?.response?.markdown.trim();

  return {
    task,
    mode: config.mode,
    state,
    message,
    executedTools:
      result?.executedTools ??
      runtime.pendingResult?.executedTools ??
      runtime.executedTools,
    outputSections:
      result?.outputSections ??
      runtime.pendingResult?.outputSections ??
      runtime.contextSections,
    cancellable: !isTerminalTaskExecutionState(state),
    ...(result?.reason ? { reason: result.reason } : {}),
    ...(assistantText
      ? { assistantText: limitText(assistantText, PROGRESS_ASSISTANT_TEXT_LIMIT) }
      : {}),
  };
};

export const emitExecutionState = async (
  task: string,
  config: RuntimeConfig,
  state: TaskExecutionState,
  message: string,
  runtime: TaskExecutionRuntime,
  options: TaskExecutionOptions,
  result?: TaskExecutionResult,
): Promise<void> => {
  await options.onStateChange?.(
    createProgressSnapshot(task, config, state, message, runtime, result),
  );
};

const getCancellationReason = (signal: AbortSignal | undefined): string => {
  const reason = signal?.reason;

  if (reason instanceof Error && reason.message.trim().length > 0) {
    return reason.message;
  }

  if (typeof reason === "string" && reason.trim().length > 0) {
    return reason;
  }

  return "Execution cancelled by user.";
};

const createCancellationSection = (
  state: TaskExecutionState,
  message: string,
  reason: string,
): TaskExecutionSection => {
  return {
    title: reason.startsWith(TASK_EXECUTION_TIMEOUT_REASON_PREFIX)
      ? "Execution limit"
      : "Cancellation",
    lines: [`state: ${state}`, `message: ${message}`, `reason: ${reason}`],
  };
};

const createCancelledResult = (
  task: string,
  config: RuntimeConfig,
  state: TaskExecutionState,
  message: string,
  runtime: TaskExecutionRuntime,
  signal: AbortSignal | undefined,
): TaskExecutionResult => {
  const baseSections =
    runtime.pendingResult?.outputSections.length &&
    runtime.pendingResult.outputSections.length > 0
      ? runtime.pendingResult.outputSections
      : runtime.contextSections;
  const reason = getCancellationReason(signal);
  const timedOut = reason.startsWith(TASK_EXECUTION_TIMEOUT_REASON_PREFIX);

  return createExecutionResult(
    {
      task,
      mode: config.mode,
      status: "cancelled",
      summary: timedOut
        ? "Execution was stopped after running longer than the configured safety timeout."
        : "Execution was cancelled before the task completed.",
      executedTools:
        runtime.pendingResult?.executedTools ?? runtime.executedTools,
      outputSections: [
        ...baseSections,
        createCancellationSection(state, message, reason),
      ],
    },
    reason,
  );
};

export const maybeReturnCancelledResult = async (
  task: string,
  config: RuntimeConfig,
  state: TaskExecutionState,
  message: string,
  runtime: TaskExecutionRuntime,
  options: TaskExecutionOptions,
): Promise<TaskExecutionResult | undefined> => {
  if (!options.signal?.aborted) {
    return undefined;
  }

  const result = createCancelledResult(
    task,
    config,
    state,
    message,
    runtime,
    options.signal,
  );

  await emitExecutionState(
    task,
    config,
    "cancelled",
    result.summary,
    runtime,
    options,
    result,
  );

  return result;
};

export const emitTerminalResult = async (
  task: string,
  config: RuntimeConfig,
  state: TaskExecutionState,
  message: string,
  runtime: TaskExecutionRuntime,
  options: TaskExecutionOptions,
  result: TaskExecutionResult,
): Promise<TaskExecutionResult> => {
  runtime.pendingResult = result;
  runtime.executedTools = result.executedTools;

  await emitExecutionState(
    task,
    config,
    state,
    message,
    runtime,
    options,
    result,
  );

  return result;
};

export const verifyExecutedResult = (
  result: TaskExecutionResult,
): string | undefined => {
  if (result.outputSections.length === 0) {
    return "The executor completed without producing any observable output sections.";
  }

  return undefined;
};
