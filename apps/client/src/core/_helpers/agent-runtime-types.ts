import type { AgentModelAdapter, AgentModelToolCall, AgentModelStructuredOutput, AgentModelImageInput } from "@machdoch/model-runtime/types";
import type { ResolvedTaskContext, TaskConversationContext, TaskExecutionMemoryUpdate, TaskExecutionControl, TaskExecutionNarrative, TaskActionOutputHandler, TaskExecutionProgressHandler, TaskExecutionResult, TaskResultProtocol, TaskExecutionSection } from "../types.js";
import type {
  InstructionDeliveryPlan,
  InstructionDeliveryReceipt,
} from "../instruction-system/types.js";
import type {
  AgentToolDefinition,
  AgentToolExecutionResult,
} from "./agent-tools-shared.js";
import type {
  RuntimeAgentLimitOverrides,
  RuntimeAgentLimits,
  RuntimeConfig,
  ToolName,
} from "../runtime-contract.generated.js";
import {
  AGENT_LIMIT_BOUNDS,
  DEFAULT_USER_AGENT_LIMITS_SETTINGS,
} from "../runtime-contract.generated.js";

export const DEFAULT_MAX_EXECUTOR_TURNS =
  DEFAULT_USER_AGENT_LIMITS_SETTINGS.executorTurns;
export const DEFAULT_MAX_AUTOPILOT_EXECUTOR_ITERATIONS =
  DEFAULT_USER_AGENT_LIMITS_SETTINGS.autopilotExecutorIterations;
export const MAX_CONFIGURED_EXECUTOR_TURNS =
  AGENT_LIMIT_BOUNDS.executorTurns.max;
export const MAX_CONFIGURED_AUTOPILOT_ITERATIONS =
  AGENT_LIMIT_BOUNDS.autopilotExecutorIterations.max;
export const MAX_CONSECUTIVE_IDENTICAL_TOOL_ERRORS = 2;
export const MAX_FINAL_RESPONSE_ITEMS = 4;

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

const GOAL_LIMIT_KEYS = [
  "goalPasses",
  "goalStalledPasses",
  "goalVerificationMinutes",
  "goalBackgroundWaitMinutes",
  "goalUsageWaitMinutes",
] as const;

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

  const goalSettings: Partial<Record<(typeof GOAL_LIMIT_KEYS)[number], number>> =
    {};
  for (const key of GOAL_LIMIT_KEYS) {
    const value = overrides[key] ?? fallback[key];
    if (typeof value === "number") goalSettings[key] = value;
  }

  if (overrides?.infinite) {
    return {
      executorTurns: null,
      autopilotExecutorIterations: null,
      ...goalSettings,
      goalPasses: null,
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
    ...goalSettings,
  };
};

export const resolveRuntimeAgentLimits = (
  config: Pick<RuntimeConfig, "agentLimits">,
): RuntimeAgentLimits => {
  return config.agentLimits ?? createDefaultAgentLimits();
};

export interface GoalLimits {
  /** Automatic native goal passes; null means no limit. */
  passes: number | null;
  stalledPasses: number;
  verificationMs: number;
  backgroundWaitMs: number;
  usageWaitMs: number;
}

export const resolveGoalLimits = (
  config: Pick<RuntimeConfig, "agentLimits">,
): GoalLimits => {
  const limits = config.agentLimits;
  const defaults = DEFAULT_USER_AGENT_LIMITS_SETTINGS;
  return {
    passes:
      limits?.goalPasses === undefined ? defaults.goalPasses : limits.goalPasses,
    stalledPasses: limits?.goalStalledPasses ?? defaults.goalStalledPasses,
    verificationMs:
      (limits?.goalVerificationMinutes ?? defaults.goalVerificationMinutes) *
      60_000,
    backgroundWaitMs:
      (limits?.goalBackgroundWaitMinutes ??
        defaults.goalBackgroundWaitMinutes) * 60_000,
    usageWaitMs:
      (limits?.goalUsageWaitMinutes ?? defaults.goalUsageWaitMinutes) * 60_000,
  };
};

export interface AgentLoopState {
  executedTools: ToolName[];
  outputSections: TaskExecutionSection[];
  traceLines: string[];
  memoryUpdates: TaskExecutionMemoryUpdate[];
  lastAssistantText?: string;
  finalResponse?: TaskExecutionNarrative;
  control?: TaskExecutionControl;
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
  control?: TaskExecutionControl;
}

export interface ModelDrivenExecutionParams {
  nativeGoal?: string;
  captureGoalEvidence?: boolean;
  goalBackgroundWaitMs?: number;
  task: string;
  config: RuntimeConfig;
  taskContext: ResolvedTaskContext;
  contextSections: TaskExecutionSection[];
  conversationContext?: TaskConversationContext;
  imageInputs?: AgentModelImageInput[];
  modelAdapter?: AgentModelAdapter;
  monitorModelAdapter?: AgentModelAdapter;
  additionalToolDefinitions?: AgentToolDefinition[];
  scopedWorkerToolDefinitions?: AgentToolDefinition[];
  onScopedWorkerToolCall?: (call: AgentModelToolCall) => void;
  onScopedWorkerToolResult?: (
    name: string,
    result: AgentToolExecutionResult,
  ) => void;
  systemPromptSections?: string[];
  structuredOutput?: AgentModelStructuredOutput;
  resultProtocol?: TaskResultProtocol;
  instructionDeliveryPlan?: InstructionDeliveryPlan;
  instructionDeliveryReceipts?: InstructionDeliveryReceipt[];
  onStateChange?: TaskExecutionProgressHandler;
  onActionOutput?: TaskActionOutputHandler;
  onStreamActivity?: () => void;
  runId?: string;
  skipUnreachableMcpServers?: boolean;
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
