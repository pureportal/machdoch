import type {
  ModelProvider,
  RunMode,
  ToolName,
} from "./runtime-contract.generated.js";

export type {
  ModelProvider,
  ProviderAvailability,
  RuntimeAgentLimitOverrides,
  RuntimeAgentLimits,
  RuntimeConfig,
  RuntimeProfileSummary,
  RuntimeWebSearchConfig,
  RunMode,
  ToolName,
  WebSearchProvider,
  WebSearchProviderAvailability,
  WorkspaceCompatibilityConfig,
  WorkspaceConfigFile,
  WorkspaceProfileConfig,
} from "./runtime-contract.generated.js";

export type ToolRiskLevel = "low" | "medium" | "high";

export type ToolPolicyDecision = "allow" | "ask" | "blocked";

export type ToolCallEffect =
  | "read"
  | "write"
  | "external-read"
  | "external-side-effect";

export type FrontmatterValue = string | number | boolean | string[];

export interface ToolDefinition {
  name: ToolName;
  title: string;
  description: string;
  riskLevel: ToolRiskLevel;
  keywords: string[];
}

export interface ResolvedToolPolicy {
  tool: ToolDefinition;
  enabled: boolean;
  decision: ToolPolicyDecision;
  reason: string;
}

export interface ParsedMarkdownDocument {
  attributes: Record<string, FrontmatterValue>;
  body: string;
}

export interface DiscoveredInstruction {
  kind: "always-on" | "conditional";
  path: string;
  name: string;
  body: string;
  description?: string;
  applyTo?: string;
  keywords: string[];
  priority?: number;
}

export interface DiscoveredPrompt {
  path: string;
  name: string;
  description?: string;
  agent?: string;
  model?: string;
  argumentHint?: string;
  inputs: string[];
  tools: ToolName[];
  body: string;
}

export interface DiscoveredSkill {
  path: string;
  name: string;
  description: string;
  argumentHint?: string;
  userInvocable: boolean;
  disableModelInvocation: boolean;
}

export interface CustomizationDiscoveryResult {
  workspaceRoot: string;
  instructions: DiscoveredInstruction[];
  prompts: DiscoveredPrompt[];
  skills: DiscoveredSkill[];
}

export interface TaskPlanStep {
  title: string;
  description: string;
}

export type ConversationRole = "user" | "assistant";

export type ConversationMemoryScope = "session" | "global";

export type UiControlPlatform = "windows" | "macos" | "linux" | "unknown";

export interface UiControlAvailability {
  available: boolean;
  platform: UiControlPlatform;
  supportsScreenshots: boolean;
  supportsWindowEnumeration: boolean;
  supportsInput: boolean;
  supportsWindowHandles: boolean;
  reason?: string;
}

export interface UiControlRuntimeInfo extends UiControlAvailability {
  bridgeCommand?: string;
}

export interface ConversationHistoryEntry {
  role: ConversationRole;
  content: string;
  createdAt?: number;
}

export interface ConversationMemoryEntry {
  id: string;
  scope: ConversationMemoryScope;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface TaskConversationContext {
  history: ConversationHistoryEntry[];
  sessionMemoryEnabled?: boolean;
  sessionMemory?: ConversationMemoryEntry[];
  globalMemoryEnabled?: boolean;
  globalMemory?: ConversationMemoryEntry[];
  uiControlEnabled?: boolean;
  uiControl?: UiControlRuntimeInfo;
}

export interface TaskExecutionMemoryUpdate {
  scope: ConversationMemoryScope;
  entry: ConversationMemoryEntry;
}

export interface AgentModelToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AgentModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments?: string;
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
}

export interface AgentModelStreamUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  raw?: unknown;
}

export type AgentModelStreamEvent =
  | {
      type: "status";
      provider?: ModelProvider;
      status:
        | "starting"
        | "queued"
        | "in-progress"
        | "completed"
        | "stopped";
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

export interface AgentModelStartParams {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  imageInputs?: AgentModelImageInput[];
  tools: AgentModelToolSpec[];
  signal?: AbortSignal | undefined;
  onStreamEvent?: AgentModelStreamEventHandler;
}

export interface AgentModelContinueParams {
  toolResults: AgentModelToolResult[];
  signal?: AbortSignal | undefined;
  onStreamEvent?: AgentModelStreamEventHandler;
}

export interface AgentModelAdapter {
  startTurn(params: AgentModelStartParams): Promise<AgentModelTurn>;
  continueTurn(params: AgentModelContinueParams): Promise<AgentModelTurn>;
}

export interface TaskCustomizationMatch {
  kind: DiscoveredInstruction["kind"];
  name: string;
  path: string;
  priority: number;
  body: string;
  reason: string;
}

export interface TaskSuggestion {
  name: string;
  path: string;
  score: number;
  reason: string;
}

export interface ResolvedPromptInvocation extends DiscoveredPrompt {
  arguments: string;
  expectedInputs: string[];
  inputValues: Record<string, string>;
  missingInputs: string[];
  resolvedBody: string;
}

export interface ResolvedTaskContext {
  task: string;
  effectiveTask: string;
  taskContextText: string;
  instructionContextText: string;
  workspacePaths: string[];
  suggestedTools: ToolName[];
  blockedTools: ToolName[];
  approvalRequiredTools: ToolName[];
  toolPolicies: ResolvedToolPolicy[];
  invokedPrompt?: ResolvedPromptInvocation;
  applicableInstructions: TaskCustomizationMatch[];
}

export interface TaskRunPreview {
  task: string;
  mode: RunMode;
  summary: string;
  suggestedTools: ToolName[];
  blockedTools: ToolName[];
  toolPolicies: ResolvedToolPolicy[];
  invokedPrompt?: ResolvedPromptInvocation;
  applicableInstructions: TaskCustomizationMatch[];
  suggestedPrompts: TaskSuggestion[];
  suggestedSkills: TaskSuggestion[];
  warnings: string[];
  notes: string[];
  steps: TaskPlanStep[];
  customizationCounts: {
    instructions: number;
    prompts: number;
    skills: number;
  };
}

export type TaskExecutionState =
  | "starting"
  | "resolving-context"
  | "checking-inputs"
  | "checking-policies"
  | "planning"
  | "executing"
  | "verifying"
  | "monitoring"
  | "planned"
  | "completed"
  | "approval-required"
  | "blocked"
  | "unsupported"
  | "cancelled";

export type TaskExecutionStatus =
  | "planned"
  | "executed"
  | "approval-required"
  | "blocked"
  | "cancelled"
  | "unsupported";

export interface TaskExecutionSection {
  title: string;
  lines: string[];
  audience?: "user" | "internal";
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
}

export interface TaskExecutionProgress {
  task: string;
  mode: RunMode;
  state: TaskExecutionState;
  message: string;
  executedTools: ToolName[];
  outputSections: TaskExecutionSection[];
  cancellable: boolean;
  reason?: string;
  assistantText?: string;
  modelStream?: {
    kind: "assistant" | "tool-call" | "reasoning" | "status" | "tool-result";
    label: string;
    content: string;
    complete?: boolean;
  };
  actionOutput?: TaskActionOutput;
}

export type TaskExecutionProgressHandler = (
  progress: TaskExecutionProgress,
) => void | Promise<void>;

export interface TaskActionOutput {
  toolName: string;
  stream: "stdout" | "stderr";
  chunk: string;
}

export type TaskActionOutputHandler = (
  output: TaskActionOutput,
) => void | Promise<void>;

export interface TaskAutopilotDecision {
  pass: number;
  decision: "complete" | "continue";
  confidence: "low" | "medium" | "high";
  rationale: string;
  missingRequirements: string[];
  requiredActions: string[];
}

export interface TaskAutopilotReport {
  executorIterations: number;
  validatorPasses: number;
  continuationCount: number;
  maxExecutorIterations: number | null;
  decisions: TaskAutopilotDecision[];
}

export interface TaskExecutionFileReference {
  path: string;
  description: string;
}

export interface TaskExecutionNarrative {
  markdown: string;
  highlights: string[];
  relatedFiles: TaskExecutionFileReference[];
  verification: string[];
  followUps: string[];
}

export interface TaskExecutionOptions {
  signal?: AbortSignal;
  onStateChange?: TaskExecutionProgressHandler;
  onActionOutput?: TaskActionOutputHandler;
  modelAdapter?: AgentModelAdapter;
  monitorModelAdapter?: AgentModelAdapter;
  conversationContext?: TaskConversationContext;
  imageInputs?: AgentModelImageInput[];
  maxDurationMs?: number;
}

export interface TaskExecutionResult {
  task: string;
  mode: RunMode;
  status: TaskExecutionStatus;
  summary: string;
  executedTools: ToolName[];
  reason?: string;
  outputSections: TaskExecutionSection[];
  response?: TaskExecutionNarrative;
  autopilot?: TaskAutopilotReport;
  memoryUpdates?: TaskExecutionMemoryUpdate[];
}
