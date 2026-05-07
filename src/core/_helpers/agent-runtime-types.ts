import type {
  AgentModelAdapter,
  ResolvedTaskContext,
  RuntimeAgentLimitOverrides,
  RuntimeAgentLimits,
  RuntimeConfig,
  TaskConversationContext,
  AgentModelImageInput,
  TaskExecutionMemoryUpdate,
  TaskExecutionNarrative,
  TaskActionOutputHandler,
  TaskExecutionProgressHandler,
  TaskExecutionResult,
  TaskExecutionSection,
  ToolName,
} from "../types.js";

export const DEFAULT_MAX_EXECUTOR_TURNS = 64;
export const DEFAULT_MAX_AUTOPILOT_EXECUTOR_ITERATIONS = 16;
export const MAX_CONSECUTIVE_IDENTICAL_TOOL_ERRORS = 2;
export const MAX_FINAL_RESPONSE_ITEMS = 4;
export const TASK_EXECUTION_TIMEOUT_MS = 20 * 60 * 1_000;
export const TASK_EXECUTION_TIMEOUT_REASON_PREFIX =
  "Execution stopped after exceeding the safety timeout";

export type TaskFinalResponseStatus = "completed" | "blocked";

const normalizePositiveIntegerLimit = (
  value: number | undefined,
  fallback: number,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.max(1, Math.trunc(value));
};

export const createDefaultAgentLimits = (): RuntimeAgentLimits => ({
  executorTurns: DEFAULT_MAX_EXECUTOR_TURNS,
  autopilotExecutorIterations: DEFAULT_MAX_AUTOPILOT_EXECUTOR_ITERATIONS,
});

export const normalizeAgentLimitOverrides = (
  overrides: RuntimeAgentLimitOverrides | undefined,
  fallback: RuntimeAgentLimits = createDefaultAgentLimits(),
): RuntimeAgentLimits => {
  if (!overrides) {
    return fallback;
  }

  if (overrides?.infinite) {
    return {
      executorTurns: null,
      autopilotExecutorIterations: null,
    };
  }

  return {
    executorTurns: normalizePositiveIntegerLimit(
      overrides?.executorTurns,
      fallback.executorTurns ?? DEFAULT_MAX_EXECUTOR_TURNS,
    ),
    autopilotExecutorIterations: normalizePositiveIntegerLimit(
      overrides?.autopilotExecutorIterations,
      fallback.autopilotExecutorIterations ??
        DEFAULT_MAX_AUTOPILOT_EXECUTOR_ITERATIONS,
    ),
  };
};

export const resolveRuntimeAgentLimits = (
  config: Pick<RuntimeConfig, "agentLimits">,
): RuntimeAgentLimits => {
  return config.agentLimits ?? createDefaultAgentLimits();
};

export interface AgentLoopState {
  executedTools: ToolName[];
  outputSections: TaskExecutionSection[];
  traceLines: string[];
  memoryUpdates: TaskExecutionMemoryUpdate[];
  lastAssistantText?: string;
  finalResponse?: TaskExecutionNarrative;
}

export interface TaskFinalResponsePayload {
  status: TaskFinalResponseStatus;
  blockerReason: string;
  summary: string;
  markdown: string;
  highlights: string[];
  relatedFiles: TaskExecutionNarrative["relatedFiles"];
  verification: string[];
  followUps: string[];
}

export interface ModelDrivenExecutionParams {
  task: string;
  config: RuntimeConfig;
  taskContext: ResolvedTaskContext;
  contextSections: TaskExecutionSection[];
  conversationContext?: TaskConversationContext;
  imageInputs?: AgentModelImageInput[];
  modelAdapter?: AgentModelAdapter;
  monitorModelAdapter?: AgentModelAdapter;
  onStateChange?: TaskExecutionProgressHandler;
  onActionOutput?: TaskActionOutputHandler;
  signal?: AbortSignal;
}

export interface ExecutorContinuationRequest {
  continuationIndex: number;
  rationale: string;
  missingRequirements: string[];
  requiredActions: string[];
}

export interface ExecutorCycleOutcome {
  loopState: AgentLoopState;
  result: TaskExecutionResult;
}
