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

export interface TaskExecutionOptions {
  signal?: AbortSignal;
  onStateChange?: TaskExecutionProgressHandler;
}

export interface TaskExecutionResult {
  task: string;
  mode: RunMode;
  status: TaskExecutionStatus;
  summary: string;
  executedTools: ToolName[];
  reason?: string;
  outputSections: TaskExecutionSection[];
}
