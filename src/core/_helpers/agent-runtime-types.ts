import type {
  AgentModelAdapter,
  ResolvedTaskContext,
  RuntimeConfig,
  TaskConversationContext,
  TaskExecutionMemoryUpdate,
  TaskExecutionNarrative,
  TaskExecutionProgressHandler,
  TaskExecutionResult,
  TaskExecutionSection,
  ToolName,
} from "../types.js";

export const MAX_EXECUTOR_TURNS = 16;
export const MAX_AUTOPILOT_EXECUTOR_ITERATIONS = 4;
export const MAX_FINAL_RESPONSE_ITEMS = 4;

export interface AgentLoopState {
  executedTools: ToolName[];
  outputSections: TaskExecutionSection[];
  traceLines: string[];
  memoryUpdates: TaskExecutionMemoryUpdate[];
  lastAssistantText?: string;
  finalResponse?: TaskExecutionNarrative;
}

export interface TaskFinalResponsePayload extends TaskExecutionNarrative {
  summary: string;
}

export interface ModelDrivenExecutionParams {
  task: string;
  config: RuntimeConfig;
  taskContext: ResolvedTaskContext;
  contextSections: TaskExecutionSection[];
  conversationContext?: TaskConversationContext;
  modelAdapter?: AgentModelAdapter;
  monitorModelAdapter?: AgentModelAdapter;
  onStateChange?: TaskExecutionProgressHandler;
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
