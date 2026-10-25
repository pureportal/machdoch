import {
  reasoningModeSchema,
  type ReasoningMode,
  type RuntimeProvider,
} from "@machdoch/fleet-protocol/runtime-options";
import type { FinalAnswerStreamSnapshot } from "@machdoch/fleet-protocol/task-thinking";
export type { ReasoningMode } from "@machdoch/fleet-protocol/runtime-options";
export type { FinalAnswerStreamSnapshot } from "@machdoch/fleet-protocol/task-thinking";
export type ModelProvider = RuntimeProvider | "unconfigured";
export type ConfiguredModelProvider = RuntimeProvider;
export type ReasoningExecutionMode = "standard" | "pro";
export const isReasoningMode = (value: unknown): value is ReasoningMode =>
  reasoningModeSchema.safeParse(value).success;
export type ParallelAgentMode =
  | "disabled"
  | "read-only"
  | "machdoch"
  | "native";

export interface AgentModelToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  strict?: boolean;
}

export interface AgentModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments?: string;
  argumentError?: string;
}

export interface AgentModelToolTextContent {
  type: "text";
  text: string;
}

export interface AgentModelToolImageContent {
  type: "image";
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string;
  detail?: "low" | "high" | "auto" | "original";
}

export type AgentModelToolResultContent =
  | AgentModelToolTextContent
  | AgentModelToolImageContent;

export interface AgentModelToolResult {
  callId: string;
  name: string;
  output: string;
  content?: AgentModelToolResultContent[];
  isError?: boolean;
}

export type AgentModelImageMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif"
  | "image/heic"
  | "image/heif";

export interface AgentModelImageInput {
  path: string;
  mediaType: AgentModelImageMediaType;
  data: string;
  detail?: "low" | "high" | "auto" | "original";
}

export interface AgentModelTurn {
  text: string;
  toolCalls: AgentModelToolCall[];
  stopReason?: string;
  usage?: AgentModelStreamUsage;
}

export interface AgentModelStreamUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  toolUseInputTokens?: number;
  reasoningTokens?: number;
  raw?: unknown;
}

export interface AgentModelRequestAttempt {
  provider: string;
  operation: string;
  attempt: number;
  elapsedMs: number;
  ok: boolean;
  errorName?: string;
  errorMessage?: string;
}

export type AgentModelRequestAttemptHandler = (
  attempt: AgentModelRequestAttempt,
) => void;

export type AgentModelStreamEvent =
  | {
      type: "final-answer";
      provider?: ModelProvider;
      snapshot: FinalAnswerStreamSnapshot;
    }
  | {
      type: "status";
      provider?: ModelProvider;
      status: "starting" | "queued" | "in-progress" | "completed" | "stopped";
      message?: string;
      rawEventType?: string;
    }
  | {
      type: "text-delta";
      delta: string;
      provider?: ModelProvider;
    }
  | {
      type: "reasoning-delta";
      delta: string;
      provider?: ModelProvider;
      signature?: string;
    }
  | {
      type: "tool-call-start";
      id?: string;
      name?: string;
      provider?: ModelProvider;
    }
  | {
      type: "tool-call-arguments-delta";
      id?: string;
      name?: string;
      delta: string;
      snapshot?: string;
      provider?: ModelProvider;
    }
  | {
      type: "tool-call-done";
      id?: string;
      name: string;
      argumentsText?: string;
      provider?: ModelProvider;
    }
  | {
      type: "tool-result";
      provider?: ModelProvider;
      id: string;
      name: string;
      output: string;
      isError?: boolean;
      content?: AgentModelToolResultContent[];
    }
  | {
      type: "usage";
      provider?: ModelProvider;
      usage: AgentModelStreamUsage;
    }
  | {
      type: "error";
      provider?: ModelProvider;
      message: string;
      code?: string;
      param?: string;
      recoverable?: boolean;
      raw?: unknown;
    };

export type AgentModelStreamEventHandler = (
  event: AgentModelStreamEvent,
) => void;

export interface AgentModelStructuredOutput {
  name: string;
  schema: unknown;
  strict?: boolean;
}

export interface AgentModelStartParams {
  model: string;
  maxOutputTokens?: number;
  maxRequestAttempts?: number;
  storeResponses?: boolean;
  toolChoice?: "auto" | "required";
  reasoning?: ReasoningMode;
  parallelAgentMode?: ParallelAgentMode;
  systemPrompt: string;
  userPrompt: string;
  imageInputs?: AgentModelImageInput[];
  tools: AgentModelToolSpec[];
  structuredOutput?: AgentModelStructuredOutput;
  signal?: AbortSignal | undefined;
  onStreamEvent?: AgentModelStreamEventHandler;
  onRequestAttempt?: AgentModelRequestAttemptHandler;
}

export interface AgentModelContinueParams {
  toolResults: AgentModelToolResult[];
  signal?: AbortSignal | undefined;
  onStreamEvent?: AgentModelStreamEventHandler;
  onRequestAttempt?: AgentModelRequestAttemptHandler;
}

export interface AgentModelAdapter {
  startTurn(params: AgentModelStartParams): Promise<AgentModelTurn>;
  continueTurn(params: AgentModelContinueParams): Promise<AgentModelTurn>;
}
