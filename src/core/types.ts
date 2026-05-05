export type RunMode = "safe" | "ask" | "auto";

export type ToolName =
  | "filesystem"
  | "shell"
  | "network"
  | "browser"
  | "git"
  | "packages";

export type ToolRiskLevel = "low" | "medium" | "high";

export type ToolPolicyDecision = "allow" | "ask" | "blocked";

export type ModelProvider = "openai" | "anthropic" | "google" | "unconfigured";

export type WebSearchProvider = "none" | "perplexity" | "tavily" | "serper";

export type FrontmatterValue = string | number | boolean | string[];

export interface WorkspaceCompatibilityConfig {
  discoverGithubCustomizations?: boolean;
}

export interface WorkspaceProfileConfig {
  description?: string;
  mode?: RunMode;
  enabledTools?: ToolName[];
  provider?: Exclude<ModelProvider, "unconfigured">;
  model?: string;
  offline?: boolean;
  compatibility?: WorkspaceCompatibilityConfig;
}

export interface WorkspaceConfigFile {
  defaultProfile?: string;
  defaultMode?: RunMode;
  enabledTools?: ToolName[];
  provider?: Exclude<ModelProvider, "unconfigured">;
  model?: string;
  offline?: boolean;
  compatibility?: WorkspaceCompatibilityConfig;
  profiles?: Record<string, WorkspaceProfileConfig>;
}

export interface ProviderAvailability {
  provider: Exclude<ModelProvider, "unconfigured">;
  configured: boolean;
}

export interface WebSearchProviderAvailability {
  provider: Exclude<WebSearchProvider, "none">;
  configured: boolean;
}

export interface RuntimeWebSearchConfig {
  activeProvider: WebSearchProvider;
  providerAvailability: WebSearchProviderAvailability[];
}

export interface RuntimeConfig {
  workspaceRoot: string;
  workspaceConfigPath?: string;
  activeProfile?: string;
  availableProfiles: RuntimeProfileSummary[];
  mode: RunMode;
  enabledTools: ToolName[];
  provider: ModelProvider;
  model: string;
  offline: boolean;
  compatibility: WorkspaceCompatibilityConfig;
  providerAvailability: ProviderAvailability[];
  webSearch: RuntimeWebSearchConfig;
}

export interface ToolDefinition {
  name: ToolName;
  title: string;
  description: string;
  riskLevel: ToolRiskLevel;
  keywords: string[];
}

export interface RuntimeProfileSummary {
  name: string;
  description?: string;
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

export interface AgentModelTurn {
  text: string;
  toolCalls: AgentModelToolCall[];
  stopReason?: string;
}

export interface AgentModelStartParams {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  tools: AgentModelToolSpec[];
  signal?: AbortSignal | undefined;
}

export interface AgentModelContinueParams {
  toolResults: AgentModelToolResult[];
  signal?: AbortSignal | undefined;
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
  | "executing"
  | "verifying"
  | "monitoring"
  | "completed"
  | "approval-required"
  | "blocked"
  | "unsupported"
  | "cancelled";

export type TaskExecutionStatus =
  | "executed"
  | "approval-required"
  | "blocked"
  | "cancelled"
  | "unsupported";

export interface TaskExecutionSection {
  title: string;
  lines: string[];
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
}

export type TaskExecutionProgressHandler = (
  progress: TaskExecutionProgress,
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
  maxExecutorIterations: number;
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
  modelAdapter?: AgentModelAdapter;
  monitorModelAdapter?: AgentModelAdapter;
  conversationContext?: TaskConversationContext;
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
