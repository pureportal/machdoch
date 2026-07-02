import type {
  InstructionAudience,
  InstructionMode,
  InstructionScope,
} from "../../core/types.js";
import type {
  ModelProvider,
  ReasoningMode,
  RuntimeAgentLimitOverrides,
  RunMode,
  UserApiProvider,
} from "../../core/runtime-contract.generated.js";

export type CommandName =
  | "run"
  | "chat"
  | "interview"
  | "ralph"
  | "scheduler"
  | "mcp"
  | "set-api"
  | "set-config"
  | "set-global-memory"
  | "inspect"
  | "instructions"
  | "config"
  | "tools"
  | "set-default-model"
  | "help";

export type SchedulerCliAction =
  | "list"
  | "create"
  | "pause"
  | "resume"
  | "delete"
  | "runs"
  | "events"
  | "event"
  | "run-due"
  | "trigger"
  | "retry"
  | "cancel"
  | "sync-prompts"
  | "service";

export type RalphCliAction =
  | "list"
  | "show"
  | "validate"
  | "delete"
  | "save"
  | "run"
  | "resume"
  | "run-detail"
  | "runs"
  | "log"
  | "revisions"
  | "restore"
  | "create"
  | "interview"
  | "watches";
export type RalphCliGenerationMode = "do-it" | "interview";
export type RalphCliGenerationTarget = "flow" | "prompt-block" | "refactor";
export type RalphCliScope = "user" | "workspace";
export type RalphWatchCliAction = "list" | "create" | "delete" | "sync" | "run";

export type McpCliAction =
  | "servers"
  | "cache"
  | "discover"
  | "refresh"
  | "oauth-authorize"
  | "oauth-start"
  | "oauth-finish"
  | "call-tool"
  | "read-resource"
  | "get-prompt"
  | "usage"
  | "lifecycle-hook"
  | "cleanup";

export type InstructionCliAction =
  | "list"
  | "show"
  | "validate"
  | "create"
  | "save"
  | "generate";

export type InstructionCliScope = InstructionScope;

export interface SchedulerCliOptions {
  action: SchedulerCliAction;
  subject?: string;
  name?: string;
  cron?: string;
  triggers?: string[];
  triggerFilters?: string[];
  triggerRecoveryFilters?: string[];
  triggerFiringMode?: string;
  triggerCooldownMs?: number;
  triggerRepeatMs?: number;
  triggerDebounceMs?: number;
  triggerDedupeKeyTemplate?: string;
  triggerMaxEvents?: number;
  triggerWindowMs?: number;
  intervalMs?: number;
  delayMs?: number;
  runAt?: number;
  timezone?: string;
  schedulerTarget?: "prompt" | "ralph-flow";
  prompt?: string;
  promptFile?: string;
  scheduledRalphFlow?: string;
  scheduledRalphFlowScope?: "workspace" | "user";
  scheduledRalphParams?: string[];
  scheduledRalphRunLogScope?: "workspace" | "user";
  scheduledRalphMaxTransitions?: number;
  scheduledRalphAllowedRoots?: string[];
  scheduledRalphAllowCommands?: boolean;
  scheduledRalphAllowWrites?: boolean;
  scheduledRalphAllowNetwork?: boolean;
  scheduledRalphAllowMcpTools?: boolean;
  contextPacks?: string[];
  macros?: string[];
  missedRunPolicy?: string;
  missedRunGraceMs?: number;
  retryAttempts?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  retryFactor?: number;
  retryRandomize?: boolean;
  dedupeKey?: string;
  ttlMs?: number;
  maxDurationMs?: number;
  concurrencyKey?: string;
  concurrencyLimit?: number;
  historyLimit?: number;
  maxCatchUpRuns?: number;
  eventType?: string;
  eventKind?: string;
  eventSource?: string;
  eventPayloadJson?: string;
  eventDedupeKey?: string;
  eventOccurredAt?: number;
  servicePollMs?: number;
  serviceIdleShutdownMs?: number;
  serviceAbandonedRunStaleMs?: number;
  serviceMaxIterations?: number;
  serviceMaxRunsPerTick?: number;
  serviceStartEventType?: string;
  serviceStartEventKind?: string;
  serviceStartEventDedupeKey?: string;
}

export interface RalphCliOptions {
  action: RalphCliAction;
  subject?: string;
  scope?: RalphCliScope;
  name?: string;
  prompt?: string;
  promptFile?: string;
  flowJson?: string;
  flowJsonFile?: string;
  existingFlowJson?: string;
  existingFlowJsonFile?: string;
  revision?: string;
  generationMode?: RalphCliGenerationMode;
  target?: RalphCliGenerationTarget;
  params?: string[];
  paramsFile?: string;
  inputJson?: string;
  inputJsonFile?: string;
  retryCurrent?: boolean;
  maxRounds?: number;
  maxTransitions?: number;
  trace?: boolean;
  watchAction?: RalphWatchCliAction;
  watchJson?: string;
  watchJsonFile?: string;
}

export interface TaskInterviewCliOptions {
  prompt?: string;
  promptFile?: string;
  inputJson?: string;
  inputJsonFile?: string;
  maxRounds?: number;
}

export interface McpCliOptions {
  action: McpCliAction;
  serverId?: string;
  target?: string;
  argumentsJson?: string;
  includeDisabled?: boolean;
  agent?: string;
  phase?: string;
  unusedDays?: number;
  neverUsedDays?: number;
  apply?: boolean;
}

export interface InstructionCliOptions {
  action: InstructionCliAction;
  subject?: string;
  name?: string;
  scope?: InstructionCliScope;
  ralphFlow?: string;
  ralphFlowScope?: RalphCliScope;
  prompt?: string;
  promptFile?: string;
  path?: string;
  applyTo?: string[];
  exclude?: string[];
  keywords?: string[];
  mode?: InstructionMode;
  audience?: InstructionAudience;
  priority?: number;
  maxRounds?: number;
}

export interface ParsedCliArgs {
  command: CommandName;
  task?: string;
  interview?: TaskInterviewCliOptions;
  ralph?: RalphCliOptions;
  scheduler?: SchedulerCliOptions;
  mcp?: McpCliOptions;
  instructions?: InstructionCliOptions;
  mode?: RunMode;
  provider?: UserApiProvider;
  runtimeProvider?: Exclude<ModelProvider, "unconfigured">;
  key?: string;
  configSetting?: string;
  configValue?: string;
  model?: string;
  defaultModel?: string;
  reasoning?: ReasoningMode;
  sessionMemoryEnabled?: boolean;
  globalMemoryEnabled?: boolean;
  setGlobalMemoryEnabled?: boolean;
  agentLimits?: RuntimeAgentLimitOverrides;
  conversationContextFile?: string;
  contextPaths?: string[];
  imagePaths?: string[];
  json: boolean;
  verbose: boolean;
  workspaceRoot: string;
}
