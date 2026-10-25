import type { AgentToolDefinition } from "./agent-tools-shared.js";
import type { PreparedConversationPromptContext } from "./conversation-prompt-context.js";
import type { InstructionDeliveryPlan } from "../instruction-system/index.js";
import type { AgentModelAdapter, ParallelAgentMode } from "@machdoch/model-runtime/types";
import type { ResolvedTaskContext, TaskExecutionTimelineEvent } from "../types.js";
import type { RuntimeConfig } from "../runtime-contract.generated.js";

export interface ParallelWorkerPlan {
  id: string;
  objective: string;
  access: "read-only" | "write";
  readPaths: string[];
  writePaths: string[];
}

export interface ValidatedWorker extends ParallelWorkerPlan {
  canonicalReadPaths: string[];
  canonicalWritePaths: string[];
}

export interface ParallelAgentSessionOptions {
  config: RuntimeConfig;
  task: string;
  taskContext: ResolvedTaskContext;
  instructionDeliveryPlan?: InstructionDeliveryPlan;
  preparedConversationContext?: PreparedConversationPromptContext;
  mode: ParallelAgentMode;
  maxWorkers?: number;
  signal?: AbortSignal;
  createWorkerAdapter?: () => Promise<AgentModelAdapter>;
  onProgress?: (event: TaskExecutionTimelineEvent) => void | Promise<void>;
  onStreamActivity?: () => void;
}

export interface ParallelAgentSessionTool {
  definition: AgentToolDefinition;
  hasWorkerFailure(): boolean;
  getCompletionBlocker(): string | undefined;
}
