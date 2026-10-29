import type { AgentModelImageInput, AgentModelStructuredOutput, AgentModelAdapter, ParallelAgentMode } from "@machdoch/model-runtime/types";
import type { TaskExecutionFileChanges } from "@machdoch/fleet-protocol/task-file-changes";
import type {FinalAnswerStreamSnapshot} from "@machdoch/fleet-protocol/task-thinking";
import type { AgentControlEndpoint, AgentLiveState } from "@machdoch/fleet-protocol/task-thinking";
export type { AgentControlEndpoint, AgentLiveState } from "@machdoch/fleet-protocol/task-thinking";
export type {FinalAnswerStreamSnapshot} from "@machdoch/fleet-protocol/task-thinking";
export type {
  TaskExecutionChangedLineRange,
  TaskExecutionFileChange,
  TaskExecutionFileChangeCompleteness,
  TaskExecutionFileChangeIssue,
  TaskExecutionFileChangeOperation,
  TaskExecutionFileEntryType,
  TaskExecutionFileLineAnalysis,
  TaskExecutionFileChanges,
  TaskExecutionFileChangeStage,
} from "@machdoch/fleet-protocol/task-file-changes";
import type {
  ModelProvider,
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
import type { GoalMode, SessionGoal } from "../shared/goals.js";

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
  | { kind: "goal-evaluation" }
  | { kind: "ralph-iteration" }
  | { kind: "ralph-validator" }
  | { kind: "ralph-route"; labels: string[] };

export type TaskExecutionControl =
  | { kind: "goal-evaluation"; decision: "complete" | "continue" | "blocked" }
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
  applicability?: import("./memory-applicability.js").MemoryApplicability;
  createdAt: number;
  updatedAt: number;
}

export interface TaskAgentFeatures {
  /** Ask the provider for its fast service tier when the model offers one. */
  fastMode?: boolean;
  /** Ask the agent for short follow-up prompts to show as suggestions. */
  suggestFollowUps?: boolean;
  /** Review the workspace's uncommitted changes (natively where the CLI can). */
  reviewChanges?: boolean;
  /**
   * The host shows the run's live state and can steer it, answer its
   * questions and stop its tasks. Without it the run is unattended.
   */
  liveControl?: boolean;
}

export interface TaskConversationContext {
  contextWindow?: import("./runtime-contract.generated.js").ContextWindow;
  /** What the provider CLI reported for the selected model when the desktop host probed it. */
  modelCapabilities?: import("@machdoch/model-runtime/model-capabilities").DiscoveredModelCapabilities;
  /** Per-message provider features chosen in the composer. */
  agentFeatures?: TaskAgentFeatures;
  sessionId?: string;
  adaptiveControllerOverride?: boolean | null;
  parallelAgentMode?: ParallelAgentMode;
  goalMode?: GoalMode;
  goalObjective?: string;
  wasQueued?: boolean;
  chatType?: "pose";
  poseScene?: import("@machdoch/media-studio/core/media/contracts.js").MediaPoseMap;
  workspace?: {
    selection: "selected" | "not-set";
    root?: string;
  };
  earlierWorkspace?: string | null;
  history: ConversationHistoryEntry[];
  promptHistoryMessageLimit?: number;
  sessionMemoryEnabled?: boolean;
  sessionMemory?: ConversationMemoryEntry[];
  workspaceMemoryEnabled?: boolean;
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
  | "failed"
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
  | "agent"
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
  finalAnswerStream?:FinalAnswerStreamSnapshot;
  goal?: SessionGoal | null;
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
  /** Full snapshot of what the provider CLI reported live for this run. */
  agentLive?: AgentLiveState;
  /** Where the host can send input into the running turn; never persisted. */
  agentControl?: AgentControlEndpoint | null;
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
  nativeGoal?: string | undefined;
  captureGoalEvidence?: boolean;
  signal?: AbortSignal;
  runId?: string;
  skipUnreachableMcpServers?: boolean;
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
  failure?: { kind: "authentication"; retryable: false };
  response?: TaskExecutionNarrative;
  fileChanges?: TaskExecutionFileChanges;
  autopilot?: TaskAutopilotReport;
  memoryUpdates?: TaskExecutionMemoryUpdate[];
  control?: TaskExecutionControl;
}
