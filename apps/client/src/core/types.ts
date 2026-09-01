import type {
  ModelProvider,
  ReasoningMode,
  RunMode,
  RuntimeMemoryKind,
  RuntimeMemoryScope,
  ToolName,
} from "./runtime-contract.generated.js";
import type { AgentToolDefinition } from "./_helpers/agent-tools-shared.js";
import type {
  FrozenInstructionSet,
  InstructionDeliveryPlan,
  InstructionDeliveryReceipt,
  InstructionSourceKind,
} from "./instruction-system/types.js";
import type { WorkspaceRunSnapshot } from "../shared/workspace-run.js";

export type ToolRiskLevel = "low" | "medium" | "high";

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

export interface ParsedMarkdownDocument {
  attributes: Record<string, FrontmatterValue>;
  body: string;
}

export type CustomizationScope = "user" | "workspace" | "github";

export interface CustomizationDiagnostic {
  level: "warning" | "error";
  code: string;
  message: string;
  path?: string;
}

export interface DiscoveredPrompt {
  path: string;
  name: string;
  scope?: CustomizationScope;
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
  scope?: CustomizationScope;
  description: string;
  argumentHint?: string;
  userInvocable: boolean;
  disableModelInvocation: boolean;
}

export interface CustomizationDiscoveryResult {
  workspaceRoot: string;
  prompts: DiscoveredPrompt[];
  skills: DiscoveredSkill[];
  diagnostics?: CustomizationDiagnostic[];
}

export interface TaskPlanStep {
  title: string;
  description: string;
}

export type ConversationRole = "user" | "assistant";

export type ConversationMemoryScope = RuntimeMemoryScope;
export type ConversationMemoryKind = RuntimeMemoryKind;

export type ReadOnlyInspectionTarget =
  | "workspace"
  | "runtime-config"
  | "tools"
  | "instructions"
  | "prompts"
  | "skills"
  | "customizations";

export type TaskDeterministicAction =
  | { kind: "inspect"; target: ReadOnlyInspectionTarget }
  | { kind: "inspect-path"; path: string }
  | { kind: "create-file"; path: string; content: string };

export type TaskResultProtocol =
  | { kind: "ralph-iteration" }
  | { kind: "ralph-validator" }
  | { kind: "ralph-route"; labels: string[] };

export type TaskExecutionControl =
  | { kind: "ralph-iteration"; decision: "DONE" | "CONTINUE" }
  | {
      kind: "ralph-validator";
      decision: "DONE" | "CONTINUE" | "RETRY" | "ERROR";
    }
  | { kind: "ralph-route"; label: string };

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
  sourceSessionId?: string;
  key: string;
  kind: ConversationMemoryKind;
  content: string;
  searchTerms: string[];
  importance: number;
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

export interface TaskConversationContext {
  sessionId?: string;
  workspace?: {
    selection: "selected" | "not-set";
    root?: string;
  };
  history: ConversationHistoryEntry[];
  sessionMemoryEnabled?: boolean;
  sessionMemory?: ConversationMemoryEntry[];
  globalMemoryEnabled?: boolean;
  globalMemory?: ConversationMemoryEntry[];
  uiControlEnabled?: boolean;
  uiControl?: UiControlRuntimeInfo;
  workspaceRun?: WorkspaceRunSnapshot;
}

export interface TaskExecutionMemoryUpdate {
  scope: ConversationMemoryScope;
  entry: ConversationMemoryEntry;
}

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
  reasoning?: ReasoningMode;
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

export type TaskExecutionRole = "executor" | "validator" | "generator";

export interface TaskInstructionSource {
  id: string;
  digest: string;
  kind: InstructionSourceKind;
  name: string;
  body: string;
  scopePath: string;
  precedence: number;
}

export interface TaskSuggestion {
  name: string;
  path: string;
  scope?: CustomizationScope;
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
  workspacePaths: string[];
  suggestedTools: ToolName[];
  executionRole: TaskExecutionRole;
  invokedPrompt?: ResolvedPromptInvocation;
  applicableInstructions: TaskInstructionSource[];
  instructionResolution?: FrozenInstructionSet;
}

export interface TaskRunPreview {
  task: string;
  mode: RunMode;
  summary: string;
  suggestedTools: ToolName[];
  invokedPrompt?: ResolvedPromptInvocation;
  suggestedPrompts: TaskSuggestion[];
  suggestedSkills: TaskSuggestion[];
  warnings: string[];
  notes: string[];
  steps: TaskPlanStep[];
  customizationCounts: {
    prompts: number;
    skills: number;
  };
}

export type TaskExecutionState =
  | "starting"
  | "resolving-context"
  | "checking-inputs"
  | "checking-tools"
  | "planning"
  | "executing"
  | "verifying"
  | "monitoring"
  | "planned"
  | "completed"
  | "blocked"
  | "unsupported"
  | "cancelled";

export type TaskExecutionStatus =
  | "planned"
  | "executed"
  | "blocked"
  | "cancelled"
  | "unsupported";

export interface TaskExecutionSection {
  title: string;
  lines: string[];
  audience?: "user" | "internal";
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
}

export interface TaskExecutionTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  toolUseInputTokens?: number;
  reasoningTokens?: number;
}

export type TaskModelCallStage =
  | "conversation-summary"
  | "executor"
  | "validator"
  | "memory-consolidation"
  | "mcp-sampling"
  | "external-agent";

export interface TaskModelRequestAttemptUsage {
  attempt: number;
  durationMs: number;
  status: "completed" | "failed";
  errorName?: string;
}

export interface TaskModelUsageCall {
  sequence: number;
  stage: TaskModelCallStage;
  provider: ModelProvider;
  model: string;
  executionPath: "api" | "cli";
  operation: string;
  status: "completed" | "failed";
  modelCallCount: number;
  modelCallCountReported: boolean;
  providerRequestCount: number;
  providerRequestCountReported: boolean;
  durationMs: number;
  requestBytes: number;
  responseBytes: number;
  toolDefinitionBytes: number;
  toolResultBytes: number;
  attempts: TaskModelRequestAttemptUsage[];
  retryCount: number;
  retryCountReported: boolean;
  usageReported: boolean;
  usage?: TaskExecutionTokenUsage;
}

export interface TaskModelUsageTotals extends TaskExecutionTokenUsage {
  callCount: number;
  modelCallCount: number;
  providerRequestCount: number;
  apiCallCount: number;
  cliCallCount: number;
  auxiliaryCallCount: number;
  retryCount: number;
  modelCallTelemetryUnavailableCallCount: number;
  providerRequestTelemetryUnavailableCallCount: number;
  retryTelemetryUnavailableCallCount: number;
  failedCallCount: number;
  failedRequestCount: number;
  usageReportedCallCount: number;
  usageUnavailableCallCount: number;
  requestBytes: number;
  responseBytes: number;
  toolDefinitionBytes: number;
  toolResultBytes: number;
  aggregateCallDurationMs: number;
}

export interface TaskModelUsageReport {
  version: 1;
  calls: TaskModelUsageCall[];
  totals: TaskModelUsageTotals;
}

export type TaskExecutionTimelineEventKind =
  | "state"
  | "model-call"
  | "tool-call"
  | "retry"
  | "validator"
  | "output";

export type TaskExecutionTimelineEventPhase =
  | "started"
  | "streaming"
  | "completed"
  | "failed"
  | "skipped"
  | "usage"
  | "passed"
  | "requested-continuation"
  | "rejected";

export interface TaskExecutionTimelineEvent {
  kind: TaskExecutionTimelineEventKind;
  phase: TaskExecutionTimelineEventPhase;
  label: string;
  detail?: string;
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
  provider?: ModelProvider;
  model?: string;
  toolName?: string;
  callId?: string;
  stream?: "stdout" | "stderr";
  tokenUsage?: TaskExecutionTokenUsage;
  metadata?: Record<string, string | number | boolean>;
}

export interface TaskExecutionTimeoutState {
  startedAt: number;
  lastActivityAt: number;
  idleTimeoutMs: number | null;
  absoluteTimeoutMs: number | null;
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
  timelineEvent?: TaskExecutionTimelineEvent;
  timeout?: TaskExecutionTimeoutState;
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

export type TaskExecutionFileChangeOperation =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "type-changed";

export type TaskExecutionFileEntryType =
  | "text"
  | "binary"
  | "gitlink"
  | "symlink"
  | "mode";

export type TaskExecutionFileLineAnalysis =
  | {
      state: "complete";
      additions: number;
      deletions: number;
    }
  | {
      state: "not-applicable";
      reason: "binary" | "gitlink" | "symlink" | "mode-only";
    }
  | {
      state: "failed";
      code: "git-failed";
      message: string;
    };

export type TaskExecutionFileChangeStage =
  | { state: "complete" }
  | { state: "failed"; code: string; message: string };

export interface TaskExecutionFileChangeCompleteness {
  discovery: TaskExecutionFileChangeStage;
  startSnapshots: TaskExecutionFileChangeStage;
  finishSnapshots: TaskExecutionFileChangeStage;
  renameAnalysis: TaskExecutionFileChangeStage;
  lineAnalysis: TaskExecutionFileChangeStage;
  persistence: TaskExecutionFileChangeStage;
}

export interface TaskExecutionFileChangeIssue {
  stage: keyof TaskExecutionFileChangeCompleteness;
  code: string;
  message: string;
  repositoryPath?: string;
}

export interface TaskExecutionChangedLineRange {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface TaskExecutionFileChange {
  path: string;
  oldPath?: string;
  operation: TaskExecutionFileChangeOperation;
  entryType: TaskExecutionFileEntryType;
  repositoryPath?: string;
  oldMode: string;
  newMode: string;
  oldObjectId?: string;
  newObjectId?: string;
  oldCommit?: string;
  newCommit?: string;
  lineAnalysis: TaskExecutionFileLineAnalysis;
  ranges?: TaskExecutionChangedLineRange[];
  hunkCount?: number;
  storedId?: number;
}

export interface TaskExecutionFileChanges {
  files: TaskExecutionFileChange[];
  changeSetId?: string;
  totalFiles: number;
  additions: number;
  deletions: number;
  binaryFiles: number;
  gitlinkFiles: number;
  symlinkFiles: number;
  modeOnlyFiles: number;
  failedFiles: number;
  status: "complete" | "partial" | "failed";
  completeness: TaskExecutionFileChangeCompleteness;
  attribution: "workspace-observed";
  repositoryCount: number;
  issues: TaskExecutionFileChangeIssue[];
}

export interface TaskExecutionOptions {
  signal?: AbortSignal;
  runId?: string;
  onStateChange?: TaskExecutionProgressHandler;
  onActionOutput?: TaskActionOutputHandler;
  onStreamActivity?: () => void;
  modelAdapter?: AgentModelAdapter;
  monitorModelAdapter?: AgentModelAdapter;
  additionalToolDefinitions?: AgentToolDefinition[];
  systemPromptSections?: string[];
  structuredOutput?: AgentModelStructuredOutput;
  executionRole?: TaskExecutionRole;
  /**
   * A run/flow-scoped immutable instruction snapshot. When omitted the
   * execution boundary resolves one before any provider call.
   */
  resolvedInstructions?: FrozenInstructionSet;
  instructionDeliveryPlan?: InstructionDeliveryPlan;
  instructionDeliveryReceipts?: InstructionDeliveryReceipt[];
  instructionFlow?: { id: string; guidance?: string };
  conversationContext?: TaskConversationContext;
  imageInputs?: AgentModelImageInput[];
  /** Optional absolute execution limit. Omit it or use `null` for no limit. */
  maxDurationMs?: number | null;
  /** Inactivity limit. Use `null` to disable it independently. */
  idleTimeoutMs?: number | null;
  /** Explicit local action selected by trusted application state. */
  deterministicAction?: TaskDeterministicAction;
  captureFileChanges?: boolean;
  /** Structured completion state required by an orchestrating protocol. */
  resultProtocol?: TaskResultProtocol;
}

export interface TaskExecutionResult {
  task: string;
  mode: RunMode;
  status: TaskExecutionStatus;
  summary: string;
  executedTools: ToolName[];
  reason?: string;
  metadata?: Record<string, unknown>;
  outputSections: TaskExecutionSection[];
  response?: TaskExecutionNarrative;
  fileChanges?: TaskExecutionFileChanges;
  autopilot?: TaskAutopilotReport;
  memoryUpdates?: TaskExecutionMemoryUpdate[];
  control?: TaskExecutionControl;
}
