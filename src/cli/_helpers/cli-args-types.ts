import type {
  ModelProvider,
  AgentCliProvider,
  ReasoningMode,
  RuntimeAgentLimitOverrides,
  RunMode,
  UserApiProvider,
} from "../../core/runtime-contract.generated.js";
import type { TaskDeterministicAction } from "../../core/types.js";

export type CommandName =
  | "run"
  | "chat"
  | "interview"
  | "ralph"
  | "scheduler"
  | "mcp"
  | "provider-sync"
  | "set-api"
  | "set-global-memory"
  | "inspect"
  | "instructions"
  | "config"
  | "memory"
  | "tools"
  | "set-default-model"
  | "help";

export type ConfigCliAction =
  | "show"
  | "list"
  | "get"
  | "set"
  | "unset"
  | "edit";

export interface ConfigCliOptions {
  action: ConfigCliAction;
  setting?: string;
  value?: string;
}

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
  | "run-all-due"
  | "poll-all"
  | "inspect-ralph"
  | "trigger"
  | "retry"
  | "cancel"
  | "sync-prompts"
  | "service"
  | "service-all";

export type RalphCliAction =
  | "list"
  | "show"
  | "validate"
  | "validate-json"
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
  | "cleanup"
  | "proxy"
  | "broker";

export type ProviderSyncCliAction =
  | "plan"
  | "enable"
  | "status"
  | "disable"
  | "refresh"
  | "doctor"
  | "daemon";

export type InstructionCliGroup =
  | "profiles"
  | "assignments"
  | "workspaces"
  | "transfer"
  | "recovery";
export type InstructionCliAction =
  | "validate"
  | "resolve"
  | "profile-list"
  | "profile-show"
  | "profile-create"
  | "profile-edit"
  | "profile-duplicate"
  | "profile-delete"
  | "assignment-list"
  | "assignment-set"
  | "assignment-relink"
  | "assignment-remove"
  | "workspace-list"
  | "workspace-configure"
  | "workspace-relink"
  | "workspace-remove"
  | "transfer-export"
  | "transfer-import"
  | "recovery-status"
  | "recovery-restore"
  | "recovery-export"
  | "recovery-reset";

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
  scheduledRalphProfile?: "unattended";
  scheduledRalphResumePolicy?: "never" | "recoverable";
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
  requestId?: string;
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
  expectedFingerprint?: string;
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
  instructionBoundaryPolicy?:
    | "require-match"
    | "original-boundary"
    | "new-boundary";
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

export interface ProviderSyncCliOptions {
  action: ProviderSyncCliAction;
  provider?: AgentCliProvider;
}

export interface InstructionCliOptions {
  action: InstructionCliAction;
  group?: InstructionCliGroup;
  subject?: string;
  secondarySubject?: string;
  name?: string;
  description?: string;
  profileIds?: string[];
  expectedRevision?: number;
  expectedDigest?: string;
  surface?: "api" | "cli";
  includeContent?: boolean;
  includeWorkspaces?: boolean;
  decisionsFile?: string;
  confirmAssignmentRemoval?: boolean;
  ralphFlow?: string;
  ralphFlowScope?: RalphCliScope;
  prompt?: string;
  promptFile?: string;
  path?: string;
  metadataJson?: string;
}

export interface ParsedCliArgs {
  command: CommandName;
  helpTopic?: string;
  task?: string;
  config?: ConfigCliOptions;
  interview?: TaskInterviewCliOptions;
  ralph?: RalphCliOptions;
  scheduler?: SchedulerCliOptions;
  mcp?: McpCliOptions;
  providerSync?: ProviderSyncCliOptions;
  instructions?: InstructionCliOptions;
  mode?: RunMode;
  provider?: UserApiProvider;
  runtimeProvider?: Exclude<ModelProvider, "unconfigured">;
  key?: string;
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
  deterministicAction?: TaskDeterministicAction;
  json: boolean;
  verbose: boolean;
  workspaceRoot: string;
}
