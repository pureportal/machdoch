import { createHash, randomUUID } from "node:crypto";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  truncate,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { normalizeOptionalString } from "../helpers/normalize-optional-string.helper.js";
import {
  FLOW_FILE_EXTENSION,
  normalizeFlowAlias,
  normalizeFlowId,
  normalizeRevisionId,
  normalizeRunId,
} from "./_helpers/ralph-flow-ids.helper.js";
import {
  createRalphRevisionFilePath,
  createRalphRunArtifactPaths,
  getRalphArtifactDirectory,
  getRalphFlowPath,
  getRalphFlowStorageDirectory,
  getRalphRevisionDirectory,
  getRalphRevisionPath,
  getRalphRunDirectory,
  type RalphFlowScope,
  type RalphRunLogPaths,
} from "./_helpers/create-ralph-storage-paths.helper.js";
import { withCooperativeFileLock } from "./_helpers/with-cooperative-file-lock.helper.js";
export {
  getRalphArtifactDirectory,
  getRalphFlowDirectory,
  getRalphFlowPath,
  getRalphFlowStorageDirectory,
  getRalphRevisionDirectory,
  getRalphRevisionPath,
  getRalphRunDirectory,
  getRalphStorageDirectory,
  getUserRalphDirectory,
} from "./_helpers/create-ralph-storage-paths.helper.js";
import {
  coerceRalphUtilityConfig,
  RALPH_UTILITY_TYPES,
} from "./_helpers/coerce-ralph-utility-config.helper.js";
import { parseRalphFlowRecord } from "./_helpers/parse-ralph-flow-record.helper.js";
import {
  createRalphRunRecord,
  createRalphRunSummaryFromRecord,
  isRalphRunRecord,
} from "./_helpers/create-ralph-run-record.helper.js";
import {
  createRalphBlockExecutionErrorResult,
  createRalphDecisionExecutionResult,
  createRalphPromptExecutionResult,
  createRalphValidatorExecutionResult,
} from "./_helpers/create-ralph-block-execution-result.helper.js";
import { createRalphFailureSignature } from "./_helpers/create-ralph-failure-signature.helper.js";
import {
  canonicalizeRalphValue,
  createRalphFlowFingerprint,
} from "./_helpers/create-ralph-flow-fingerprint.helper.js";
import {
  RALPH_FLOW_SCHEMA_VERSION,
  validateRalphFlow,
} from "./_helpers/validate-ralph-flow.helper.js";
import { isExecutableRalphBlock } from "./_helpers/get-ralph-block-outputs.helper.js";
import {
  findOutgoingRalphEdge,
  getRalphBlockById,
} from "./_helpers/validate-ralph-flow-graph.helper.js";
export {
  createValidationResult,
  getRalphUtilityOutputs,
  hasGraphCycle,
  isExecutableRalphBlock,
  isVisualRalphBlock,
  RALPH_FLOW_SCHEMA_VERSION,
  validateRalphFlow,
} from "./_helpers/validate-ralph-flow.helper.js";
import {
  evaluateRalphUtilityCondition,
  parseRalphUtilityJsonValue,
  readRalphUtilityValuePath,
} from "./_helpers/evaluate-ralph-utility-condition.helper.js";
import {
  assessRalphScopeRegistryAvailability,
  beginRalphScopeRegistryCycle,
  createDefaultRalphScopeRegistryPath,
  createRalphScopeRegistryMarkdownPath,
  discoverRalphScopeEvidence,
  formatRalphScopeRegistryMarkdown,
  isResolvedPathInside,
  isRalphScopeOutcome,
  markRalphScopeRegistryResult,
  normalizeRalphScopeSelectionStrategy,
  parseRalphScopeEvidence,
  parseRalphScopeExcludePaths,
  readRalphScopeRegistryFile,
  selectRalphScopeFromRegistry,
  updateRalphScopeRegistryFromEvidence,
  writeRalphScopeRegistryFile,
  type RalphScopeOutcome,
  type RalphScopeSelectionStrategy,
} from "./_helpers/ralph-scope-registry.helper.js";
import { resolveRalphRetryDecision } from "./_helpers/resolve-ralph-retry-decision.helper.js";
import {
  scavengeAtomicTemporaryFiles,
  writeFileAtomically,
  writeJsonAtomically,
} from "./_helpers/write-file-atomically.helper.js";
import {
  parseRalphWorkItemState,
  transitionRalphWorkItemState,
} from "./_helpers/transition-ralph-work-item-state.helper.js";
import {
  createRalphManagedServerCommandFingerprint,
  isRalphManagedServerOwnershipAlive,
  readRalphManagedServerOwnership,
  startRalphManagedServer,
  stopRalphManagedServer,
  stopRalphManagedServerOwnership,
  type RalphManagedServerOwnership,
  type RalphManagedServerHandle,
} from "./_helpers/ralph-managed-server.helper.js";
import {
  getRalphAutonomyBackoffSeconds,
  resolveRalphAutonomyPolicy,
  type ResolvedRalphAutonomyPolicy,
} from "./_helpers/resolve-ralph-autonomy-policy.helper.js";
import {
  discoverRalphFlowVariables,
  isPlainRalphVariableReference,
  parseRalphPlaceholderContent,
  RALPH_PLACEHOLDER_PATTERN,
  type ParsedRalphPlaceholder,
} from "./_helpers/ralph-placeholders.helper.js";
import {
  getRalphResultMarkdown as getResultMarkdown,
  truncateRalphResultText as truncateResultText,
} from "./_helpers/ralph-result-text.helper.js";
import {
  parseRalphValidatorJsonResult,
  RALPH_VALIDATOR_JSON_SCHEMA,
} from "./_helpers/parse-ralph-validator-json-result.helper.js";
import {
  getRalphInputFieldVariableNames,
  normalizeRalphInputResponseValues,
} from "./_helpers/normalize-ralph-input-response-values.helper.js";
import {
  applyInputValuesToContext,
  createInputRequest,
  createRunCheckpoint,
  getMatchingInputResponse,
  getPendingInputForBlock,
  isExpiredInputRequest,
  restoreRalphNumberMap,
  restoreRalphRepeatedFailureMap,
  restoreRalphResultMap,
} from "./_helpers/ralph-input-request-state.helper.js";
import {
  normalizeRalphInterviewGeneration,
  type RalphInterviewGeneration,
} from "./_helpers/normalize-ralph-interview-generation.helper.js";
import { appendRalphInterviewAnswers } from "./_helpers/append-ralph-interview-answers.helper.js";
import { createRalphInterviewQuestionTask } from "./_helpers/create-ralph-interview-question-task.helper.js";
import { createRalphInterviewTranscriptMarkdown } from "./_helpers/create-ralph-interview-transcript-markdown.helper.js";
import { extractRalphInterviewJsonObject } from "./_helpers/extract-ralph-interview-json-object.helper.js";
import { getRalphInterviewOutputVariableName } from "./_helpers/get-ralph-interview-output-variable-name.helper.js";
import {
  capLogText,
  createRalphLogLine,
  formatRalphSimpleMarkdownEntry,
  sanitizeTraceValue,
} from "./_helpers/format-ralph-run-log-entry.helper.js";
import {
  executeLocalCommand,
  formatLocalCommandError,
  getLocalCommandErrorDetails,
  normalizeLocalCommandCwd,
} from "./_helpers/process-execution.js";
import {
  collectRalphGitChangeSnapshot,
  type RalphGitChangeSnapshot,
  type RalphGitChangedFileSnapshot,
} from "./_helpers/ralph-git-change-snapshot.helper.js";
import {
  compareRalphVerificationObservations,
  createRalphVerificationObservation,
  type RalphVerificationObservation,
} from "./_helpers/ralph-verification.helper.js";
import {
  assessRalphProgress,
  createRalphProgressState,
  createRalphRepositoryProgressFingerprint,
  type RalphProgressState,
} from "./_helpers/ralph-progress.helper.js";
import {
  deriveRalphRunOutcome,
  type RalphRepositoryOutcomeEvidence,
  type RalphRunOutcome,
} from "./_helpers/ralph-autonomy-outcome.helper.js";
export type {
  RalphRepositoryOutcomeEvidence,
  RalphRunOutcome,
  RalphRunOutcomeEvidence,
  RalphRunOutcomeStatus,
} from "./_helpers/ralph-autonomy-outcome.helper.js";
import {
  assertRalphRepositoryContextUnchanged,
  resolveRalphRepositoryContext,
  type RalphRepositoryContext,
} from "./_helpers/ralph-repository-context.helper.js";
import {
  RalphRunStore,
  RalphRunStoreOwnershipError,
  type RalphRunStoreLeaseState,
} from "./_helpers/ralph-run-store.helper.js";
import { executeTask } from "./execution.js";
import { isAgentCliProvider } from "./_helpers/agent-cli-providers.js";
import { resolveReviewModelRuntimeConfig } from "./review-model.js";
import { isTaskModelUsageReport } from "./model-usage.js";
import { mcpClientManager } from "./mcp/client.js";
import {
  createImageInputUnsupportedModelMessage,
  getImageInputMediaTypeForPath,
  getSupportedImageInputExtensions,
  modelSupportsImageInput,
  providerSupportsImageInputMediaType,
} from "./model-capabilities.js";
import {
  getEnabledMcpServer,
  loadMcpDiscoveryCacheSync,
  loadMcpConfigSync,
} from "./mcp/config.js";
import type {
  McpConfigOverride,
  McpOperationCacheOptions,
  McpOperationOptions,
} from "./mcp/types.js";
import type {
  CustomizationDiscoveryResult,
  AgentModelImageInput,
  TaskExecutionOptions,
  TaskConversationContext,
  TaskActionOutput,
  TaskExecutionProgress,
  TaskExecutionProgressHandler,
  TaskExecutionResult,
  TaskExecutionTimelineEventKind,
  TaskExecutionTokenUsage,
} from "./types.js";
import type {
  ConfiguredModelProvider,
  ModelProvider,
  ReasoningMode,
  RuntimeConfig,
} from "./runtime-contract.generated.js";
import {
  adaptFrozenInstructionSet,
  canonicalDigest,
  resolveInstructionSet,
  type FrozenInstructionSet,
  type InstructionDeliveryPlan,
  type InstructionDeliveryReceipt,
} from "./instruction-system/index.js";
import { createInstructionDeliveryPlanForRuntime } from "./provider-enrollment/instruction-delivery-preflight.js";

const addFormats = (typeof addFormatsModule.default === "function"
  ? addFormatsModule.default
  : addFormatsModule) as unknown as FormatsPlugin;

export { discoverRalphFlowVariables } from "./_helpers/ralph-placeholders.helper.js";
export { createRalphFlowFingerprint } from "./_helpers/create-ralph-flow-fingerprint.helper.js";

type PlaywrightBrowser = import("playwright-core").Browser;
type PlaywrightPage = import("playwright-core").Page;
type PlaywrightRequest = import("playwright-core").Request;
type PlaywrightConsoleMessage = import("playwright-core").ConsoleMessage;
type PlaywrightBrowserChannel = (typeof RALPH_UI_BROWSER_CHANNELS)[number];

export const MAX_RALPH_SIMPLE_LOG_CHARS = 4_000;
const MAX_RALPH_BLOCK_PROGRESS_EVENTS = 160;
const MAX_RALPH_BLOCK_PROGRESS_CHARS = 8_000;
const RALPH_BLOCK_PROGRESS_TRUNCATION_MARKER = `\n[Ralph block progress truncated at ${MAX_RALPH_BLOCK_PROGRESS_CHARS} characters.]`;

const DEFAULT_RALPH_UTILITY_RESPONSE_LIMIT_BYTES = 1_000_000;
const DEFAULT_RALPH_UTILITY_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_RALPH_UTILITY_CHECK_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_RALPH_UTILITY_POLL_INTERVAL_SECONDS = 30;
const DEFAULT_RALPH_UTILITY_MAX_SEARCH_RESULTS = 100;
const DEFAULT_RALPH_REPEATED_FAILURE_LIMIT = 3;
const DEFAULT_RALPH_RUN_LEASE_DURATION_MS = 2 * 60_000;
const RALPH_RUN_PROJECTION_INTERVAL_MS = 15_000;
const RALPH_WORKSPACE_WRITER_LEASE_NAME = ".workspace-writer";
const MAX_RALPH_WORK_ITEM_STATE_HISTORY = 100;
const MAX_RALPH_JSON_TASK_ASSESSMENT_ITEMS = 100;
const MAX_RALPH_OPERATION_LEDGER_ENTRIES = 2_000;
const DEFAULT_RALPH_MCP_TIMEOUT_MS = 5 * 60_000;
const RALPH_MEDIA_BRIDGE_POLL_MS = 250;
const RALPH_MEDIA_BRIDGE_RESPONSE_TIMEOUT_MS = 30_000;
const RALPH_MEDIA_BRIDGE_REQUEST_PATH_ENV =
  "MACHDOCH_MEDIA_BRIDGE_REQUEST_PATH";
const RALPH_MEDIA_BRIDGE_RESPONSE_PATH_ENV =
  "MACHDOCH_MEDIA_BRIDGE_RESPONSE_PATH";
const RALPH_MEDIA_BRIDGE_TOKEN_ENV = "MACHDOCH_MEDIA_BRIDGE_TOKEN";
const DEFAULT_RALPH_WORK_ITEM_LEASE_MS = 10 * 60_000;
const DEFAULT_RALPH_WORK_ITEM_DEFER_MS = 30 * 60_000;
const MAX_RALPH_CHECKPOINT_BLOCK_RESULTS = 1_000;
const MAX_RALPH_CHECKPOINT_EVENTS = 2_000;
const MAX_RALPH_CHECKPOINT_LOG_ENTRIES = 1_000;
const DEFAULT_RALPH_SEARCH_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".machdoch",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

const DEFAULT_RALPH_UI_ANALYZE_VIEWPORTS: readonly RalphUiAnalyzeViewport[] = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 390, height: 844 },
  { name: "small-mobile", width: 320, height: 568 },
];
const DEFAULT_RALPH_UI_ANALYZE_TIMEOUT_MS = 30_000;
const MAX_RALPH_UI_ANALYZE_TEXT_CHARS = 20_000;
const MAX_RALPH_UI_ANALYZE_ISSUES = 80;
const RALPH_UI_BROWSER_CHANNELS =
  process.platform === "win32"
    ? (["msedge", "chrome", "chromium"] as const)
    : process.platform === "darwin"
      ? (["chrome", "msedge", "chromium"] as const)
      : (["chrome", "msedge", "chromium"] as const);

export const RALPH_BLOCK_TYPES = [
  "START",
  "PROMPT",
  "VALIDATOR",
  "DECISION",
  "PACK",
  "ASK_USER",
  "INTERVIEW",
  "UTILITY",
  "MCP_TOOL",
  "MCP_RESOURCE",
  "MCP_PROMPT",
  "MEDIA_FLOW",
  "NOTE",
  "GROUP",
  "END",
] as const;

export { RALPH_UTILITY_TYPES };

export const RALPH_VARIABLE_TYPES = [
  "string",
  "text",
  "path",
  "file",
  "files",
  "url",
  "number",
  "boolean",
  "image",
  "images",
  "model",
  "provider",
  "pack",
] as const;

export type RalphBlockType = (typeof RALPH_BLOCK_TYPES)[number];
export type RalphUtilityType = (typeof RALPH_UTILITY_TYPES)[number];
export type RalphDurableWorkOutcome =
  | "DONE"
  | "DEFER"
  | "STOP"
  | "BLOCKED"
  | "INVALID";
export type RalphVariableType = (typeof RALPH_VARIABLE_TYPES)[number];
export type {
  RalphFlowScope,
  RalphRunLogPaths,
} from "./_helpers/create-ralph-storage-paths.helper.js";
export type { RalphScopeSelectionStrategy } from "./_helpers/ralph-scope-registry.helper.js";
export type RalphValidatorDecision = "DONE" | "CONTINUE" | "RETRY" | "ERROR";
export type RalphExecutionOutput =
  | "SUCCESS"
  | "ERROR"
  | RalphValidatorDecision
  | string;
export type RalphInputFieldType =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "select"
  | "multiselect"
  | "url"
  | "path"
  | "file"
  | "files"
  | "image"
  | "images";
export type RalphInputValue = string | number | boolean | string[] | null;
export type RalphAskUserMode = "missingOnly" | "alwaysAsk" | "confirmOnly";
export type RalphMediaFlowRunPolicy = "wait" | "submit-and-continue";
export type RalphMediaFlowApprovalPolicy =
  | "inherit-workspace"
  | "always-review-preflight";

export type RalphMediaInputBinding =
  | { source: "variable"; variableName: string }
  | { source: "literal"; value: string | number | boolean }
  | { source: "path"; path: string }
  | { source: "media-asset"; assetId: string };

export interface RalphMediaOutputBinding {
  source:
    | "run-id"
    | "status"
    | "asset-ids"
    | "first-asset-id"
    | "quality-report-ids";
  variableName: string;
}

export { MAX_RALPH_RESULT_CHARS } from "./_helpers/ralph-result-text.helper.js";
export {
  FLOW_FILE_EXTENSION,
  normalizeFlowAlias,
  normalizeRunId,
} from "./_helpers/ralph-flow-ids.helper.js";
export {
  capLogText,
  createRalphLogLine,
  sanitizeTraceValue,
} from "./_helpers/format-ralph-run-log-entry.helper.js";
export type RalphRunStatus =
  | "running"
  | "completed"
  | "crashed"
  | "blocked"
  | "stopped"
  | "waiting-for-input";
export type RalphRunSummaryStatus = RalphRunStatus | "abandoned" | "partial";
export type RalphUtilityWaitMode =
  | "delay"
  | "until-time"
  | "condition"
  | "poll";
export type RalphUtilityConditionStyle = "simple" | "json-path" | "javascript";
export type RalphUiAnalyzeAdapter =
  | "auto"
  | "browser"
  | "image"
  | "playwright-mcp"
  | "tauri-mcp";
export type RalphUiAnalyzeServerMode = "existing" | "managed" | "none";
export type RalphUiAnalyzeWaitUntil =
  | "load"
  | "domcontentloaded"
  | "networkidle"
  | "commit";
export type RalphAnnotationTone =
  | "slate"
  | "amber"
  | "sky"
  | "lime"
  | "rose"
  | "violet";
export type RalphAnnotationLinkKind =
  | "explains"
  | "evidence"
  | "todo"
  | "related"
  | "risk";
export type RalphUtilityConditionOperator =
  | "exists"
  | "not-exists"
  | "truthy"
  | "falsy"
  | "equals"
  | "not-equals"
  | "contains"
  | "matches"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

export interface RalphPosition {
  x: number;
  y: number;
}

export interface RalphSize {
  width: number;
  height: number;
}

export interface RalphFlowVariable {
  name: string;
  type: RalphVariableType;
  default?: string;
  required: boolean;
}

export interface RalphInputOption {
  value: string;
  label: string;
}

export interface RalphInputFieldValidation {
  min?: number;
  max?: number;
  step?: number;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
}

export interface RalphInputField {
  id: string;
  label: string;
  type: RalphInputFieldType;
  required?: boolean;
  skippable?: boolean;
  placeholder?: string;
  help?: string;
  defaultValue?: RalphInputValue;
  options?: RalphInputOption[];
  validation?: RalphInputFieldValidation;
  variableName?: string;
}

export interface RalphInputRequest {
  id: string;
  runId: string;
  blockId: string;
  blockType: RalphBlockType;
  title: string;
  prompt?: string;
  fields: RalphInputField[];
  submitLabel?: string;
  cancelLabel?: string;
  createdAt: string;
  expiresAt?: string;
  interview?: {
    turn: number;
    maxTurns: number;
  };
  mediaFlow?: {
    stage: "preflight" | "human-review" | "provider-review";
    flowId: string;
    revisionId: string;
    runId: string;
  };
}

export interface RalphInputResponse {
  requestId: string;
  action: "submit" | "cancel";
  values?: Record<string, RalphInputValue>;
}

export interface RalphWorkspaceSetting {
  mode: "default" | "custom";
  path?: string;
}

export interface RalphRetryPolicy {
  mode: "infinite" | "finite";
  maxRetries?: number | null;
  delaySeconds?: number;
}

export interface RalphAutonomyBackoffPolicy {
  initialDelaySeconds?: number;
  multiplier?: number;
  maxDelaySeconds?: number;
}

export interface RalphAutonomyPolicy {
  enabled?: boolean;
  recoverFailedEnd?: boolean;
  maxRecoveryAttempts?: number;
  backoff?: RalphAutonomyBackoffPolicy;
  transitionExhaustion?: "checkpoint" | "crash";
  recoveryExhaustion?: "defer" | "block";
  deferToBlockId?: string;
  maxStagnantTransitions?: number;
  maxRepeatedCycle?: number;
}

export type RalphAutonomySetting = boolean | RalphAutonomyPolicy;

export interface RalphAutonomyRecoveryAttempt {
  blockId: string;
  output: RalphExecutionOutput;
  failedEndBlockId: string;
  attempt: number;
  maxAttempts: number;
  delaySeconds: number;
  reason: string;
}

export interface RalphAutonomyRecoveredBlock {
  blockId: string;
  attempts: number;
  output: RalphExecutionOutput;
}

export interface RalphAutonomyDeferredWork {
  blockId: string;
  output: RalphExecutionOutput;
  failedEndBlockId?: string;
  attempts: number;
  reason: string;
  routedToBlockId?: string;
}

export interface RalphAutonomyExhaustion {
  kind: "max-transitions" | "recovery" | "repeated-failure" | "stagnation";
  blockId: string;
  recoverable: boolean;
  limit: number;
  totalTransitions?: number;
  output?: RalphExecutionOutput;
  reason: string;
}

export interface RalphRunAutonomyMetadata {
  enabled: true;
  policy: {
    recoverFailedEnd: boolean;
    maxRecoveryAttempts: number;
    backoff: {
      initialDelaySeconds: number;
      multiplier: number;
      maxDelaySeconds: number;
    };
    transitionExhaustion: "checkpoint" | "crash";
    recoveryExhaustion: "defer" | "block";
    deferToBlockId?: string;
    maxStagnantTransitions: number;
    maxRepeatedCycle: number;
  };
  recoveryAttempts: RalphAutonomyRecoveryAttempt[];
  recovered: RalphAutonomyRecoveredBlock[];
  deferred: RalphAutonomyDeferredWork[];
  totalTransitions: number;
  exhaustion?: RalphAutonomyExhaustion;
}

export interface RalphAttachmentReference {
  id?: string;
  source: "path" | "variable";
  value: string;
  kind?: "file" | "directory" | "image" | "other";
  mediaType?: string;
}

export interface RalphUtilityCondition {
  style: RalphUtilityConditionStyle;
  expression?: string;
  path?: string;
  operator?: RalphUtilityConditionOperator;
  value?: string;
}

export interface RalphUiAnalyzeViewport {
  name?: string;
  width: number;
  height: number;
}

export interface RalphUiAnalyzeChecks {
  screenshots?: boolean;
  accessibility?: boolean;
  console?: boolean;
  network?: boolean;
  responsive?: boolean;
  trace?: boolean;
}

export interface RalphUiAnalyzeServer {
  mode?: RalphUiAnalyzeServerMode;
  healthUrl?: string;
  command?: string;
  cwd?: string;
  reuseExisting?: boolean;
}

export interface RalphUtilityConfig {
  type: RalphUtilityType;
  replayPolicy?: "safe" | "at-most-once";
  workOutcome?: RalphDurableWorkOutcome;
  mode?: RalphUtilityWaitMode;
  delaySeconds?: number;
  runAt?: string;
  intervalSeconds?: number;
  backoffMultiplier?: number;
  maxAttempts?: number | null | string;
  condition?: RalphUtilityCondition;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  outputPath?: string;
  markdownPath?: string;
  path?: string;
  registryPath?: string;
  jsonPath?: string;
  rootPath?: string;
  content?: string;
  append?: boolean;
  encoding?: BufferEncoding;
  pattern?: string;
  glob?: string;
  maxResults?: number | string;
  order?: "oldest" | "newest";
  maxTasks?: number | string;
  maxDepth?: number | string;
  excludePaths?: string;
  flowAlias?: string;
  strategy?: RalphScopeSelectionStrategy | string;
  scopeId?: string;
  scopeOutcome?: RalphScopeOutcome;
  taskId?: string;
  status?: string;
  result?: string;
  includeMarkdown?: boolean;
  forceNew?: boolean;
  reset?: boolean;
  enforce?: boolean;
  jsonPatchMode?: "merge" | "replace";
  counterName?: string;
  counterKey?: string;
  command?: string;
  fallbackCommand?: string;
  verificationRole?: "baseline" | "candidate" | "supplemental";
  baselineBlockId?: string;
  verificationPlanId?: string;
  cwd?: string;
  env?: Record<string, string>;
  adapter?: RalphUiAnalyzeAdapter;
  targetUrl?: string;
  screenshotPath?: string;
  server?: RalphUiAnalyzeServer;
  viewports?: RalphUiAnalyzeViewport[];
  checks?: RalphUiAnalyzeChecks;
  fullPage?: boolean;
  waitUntil?: RalphUiAnalyzeWaitUntil;
  mcpServerId?: string;
  mcpToolName?: string;
  mcpArguments?: Record<string, unknown>;
  acceptedExitCodes?: number[];
  timeoutSeconds?: number;
  maxOutputBytes?: number;
  variableName?: string;
  value?: string;
  input?: string;
  baseline?: string;
  expression?: string;
  prompt?: string;
  schema?: unknown;
  structuredOutput?: boolean;
  message?: string;
  ignoreErrors?: boolean;
}

export interface RalphBlockSettings {
  workspace?: RalphWorkspaceSetting;
  provider?: ModelProvider | "default";
  model?: string;
  reasoning?: ReasoningMode;
  webAccess?: boolean;
  fileAccess?: boolean;
  attachments?: RalphAttachmentReference[];
  packs?: string[];
  maxIterations?: number;
  timeoutSeconds?: number | null;
  temperature?: number | null;
  internalValidatorEnabled?: boolean;
  retry?: RalphRetryPolicy;
  mcp?: McpConfigOverride;
}

export interface RalphBaseBlock {
  id: string;
  type: RalphBlockType;
  title: string;
  position?: RalphPosition;
  size?: RalphSize;
  locked?: boolean;
  parentGroupId?: string;
  settings?: RalphBlockSettings;
  groupBoundary?: boolean;
}

export interface RalphStartBlock extends RalphBaseBlock {
  type: "START";
}

export interface RalphPromptBlock extends RalphBaseBlock {
  type: "PROMPT";
  prompt: string;
}

export interface RalphValidatorBlock extends RalphBaseBlock {
  type: "VALIDATOR";
  prompt: string;
  validationScope?: RalphValidationScope;
}

export interface RalphDecisionBlock extends RalphBaseBlock {
  type: "DECISION";
  prompt: string;
  labels: string[];
}

export interface RalphPackBlock extends RalphBaseBlock {
  type: "PACK";
  packIds: string[];
  propagationMode?: "nextBlockOnly" | "untilOverridden";
}

export interface RalphAskUserBlock extends RalphBaseBlock {
  type: "ASK_USER";
  mode?: RalphAskUserMode;
  prompt?: string;
  fields: RalphInputField[];
  submitLabel?: string;
  cancelLabel?: string;
  timeoutSeconds?: number | null;
}

export interface RalphInterviewBlock extends RalphBaseBlock {
  type: "INTERVIEW";
  prompt: string;
  completionCriteria?: string;
  maxTurns?: number;
  questionsPerTurn?: number;
  outputVariableName?: string;
  submitLabel?: string;
  cancelLabel?: string;
}

export interface RalphUtilityBlock extends RalphBaseBlock {
  type: "UTILITY";
  utility: RalphUtilityConfig;
}

export interface RalphMcpToolBlock extends RalphBaseBlock {
  type: "MCP_TOOL";
  serverId: string;
  toolName: string;
  arguments?: Record<string, unknown>;
}

export interface RalphMcpResourceBlock extends RalphBaseBlock {
  type: "MCP_RESOURCE";
  serverId: string;
  uri: string;
}

export interface RalphMcpPromptBlock extends RalphBaseBlock {
  type: "MCP_PROMPT";
  serverId: string;
  promptName: string;
  arguments?: Record<string, unknown>;
}

export interface RalphMediaFlowBlock extends RalphBaseBlock {
  type: "MEDIA_FLOW";
  flowId: string;
  revisionId: string;
  inputBindings: Record<string, RalphMediaInputBinding>;
  outputBindings: Record<string, RalphMediaOutputBinding>;
  runPolicy: RalphMediaFlowRunPolicy;
  approvalPolicy: RalphMediaFlowApprovalPolicy;
}

export interface RalphNoteBlock extends RalphBaseBlock {
  type: "NOTE";
  text: string;
  tone?: RalphAnnotationTone;
  tags?: string[];
  collapsed?: boolean;
  pinnedBlockIds?: string[];
}

export interface RalphGroupExecutionBoundary {
  mode: "none" | "firstExecutableChild" | "selectedChild";
  blockId?: string;
}

export interface RalphGroupBlock extends RalphBaseBlock {
  type: "GROUP";
  tone?: RalphAnnotationTone;
  description?: string;
  childBlockIds: string[];
  collapsed?: boolean;
  moveChildren?: boolean;
  maxDepth?: number;
  layoutMode?: "freeform" | "stack" | "swimlane";
  executionBoundary?: RalphGroupExecutionBoundary;
}

export interface RalphEndBlock extends RalphBaseBlock {
  type: "END";
  status?: "success" | "failed" | "cancelled" | "review";
  outcome?:
    | "succeeded"
    | "no-op"
    | "deferred"
    | "blocked"
    | "failed"
    | "cancelled";
}

export type RalphFlowBlock =
  | RalphStartBlock
  | RalphPromptBlock
  | RalphValidatorBlock
  | RalphDecisionBlock
  | RalphPackBlock
  | RalphAskUserBlock
  | RalphInterviewBlock
  | RalphUtilityBlock
  | RalphMcpToolBlock
  | RalphMcpResourceBlock
  | RalphMcpPromptBlock
  | RalphMediaFlowBlock
  | RalphNoteBlock
  | RalphGroupBlock
  | RalphEndBlock;

export interface RalphValidationScope {
  mode: "sinceLastValidator" | "previousBlock" | "selectedBlocks" | "wholeFlow";
  blockIds?: string[];
}

export interface RalphFlowEdge {
  id: string;
  from: string;
  fromOutput: RalphExecutionOutput;
  to: string;
}

export interface RalphAnnotationLink {
  id: string;
  from: string;
  to: string;
  kind: RalphAnnotationLinkKind;
}

export interface RalphFlowSettings {
  maxTransitions?: number;
  autonomy?: RalphAutonomySetting;
}

export interface RalphFlowSource {
  kind: "starter";
  id: string;
  version: number;
  importedAt?: string;
  templateFingerprint?: string;
  templateVariableDefaults?: Record<string, string | undefined>;
  templateSnapshot?: Omit<RalphFlow, "source" | "createdAt" | "updatedAt">;
}

export interface RalphFlow {
  schemaVersion: typeof RALPH_FLOW_SCHEMA_VERSION;
  id: string;
  alias?: string;
  name: string;
  description?: string;
  guidance?: string;
  createdAt?: string;
  updatedAt?: string;
  source?: RalphFlowSource;
  settings?: RalphFlowSettings;
  variables?: RalphFlowVariable[];
  blocks: RalphFlowBlock[];
  edges: RalphFlowEdge[];
  annotationLinks?: RalphAnnotationLink[];
}

export interface RalphFlowSummary {
  id: string;
  alias?: string;
  name: string;
  scope?: RalphFlowScope;
  path: string;
  description?: string;
  source?: RalphFlowSource;
  blockCount: number;
  edgeCount: number;
  variableCount: number;
}

export interface RalphFlowRevisionSummary {
  id: string;
  path: string;
  createdAt: string;
  flowName: string;
  blockCount: number;
  edgeCount: number;
  valid: boolean;
}

export interface RalphFlowReadOptions {
  allowInvalid?: boolean;
  scope?: RalphFlowScope;
}

export interface RalphFlowWriteOptions {
  createRevision?: boolean;
  reason?: string;
  allowInvalid?: boolean;
  scope?: RalphFlowScope;
  expectedFingerprint?: string;
}

export interface RalphFlowDeleteOptions {
  scope?: RalphFlowScope;
  expectedFingerprint?: string;
}

export interface RalphFlowListOptions {
  scope?: RalphFlowScope | "all";
}

export interface RalphValidationIssue {
  code: string;
  message: string;
  blockId?: string;
  edgeId?: string;
}

export interface RalphValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  errorIssues: RalphValidationIssue[];
  warningIssues: RalphValidationIssue[];
  variables: RalphFlowVariable[];
}

export interface RalphBlockExecutionResult {
  blockId: string;
  operationId?: string;
  output: RalphExecutionOutput;
  status: "completed" | "error" | "skipped";
  attempt: number;
  durationMs?: number;
  result?: TaskExecutionResult;
  progress?: RalphRunRecordBlockProgressEvent[];
  data?: unknown;
  summary: string;
  markdown?: string;
  error?: string;
  failure?: RalphBlockFailure;
  recovery?: {
    disposition: "retrying" | "recovered" | "deferred" | "exhausted";
    attempt?: number;
    maxAttempts?: number;
    failedEndBlockId?: string;
  };
}

export interface RalphBlockFailure {
  kind: "persistence" | "terminal-decision";
  retryable: false;
}

export interface RalphRunRecordBlockProgressEvent {
  timestamp: string;
  kind: "model-stream" | "timeline" | "action-output" | "message";
  label: string;
  timelineKind?: TaskExecutionTimelineEventKind;
  streamKind?: NonNullable<TaskExecutionProgress["modelStream"]>["kind"];
  phase?: NonNullable<TaskExecutionProgress["timelineEvent"]>["phase"];
  tone?: NonNullable<TaskExecutionProgress["timelineEvent"]>["tone"];
  provider?: ModelProvider;
  model?: string;
  complete?: boolean;
  toolName?: string;
  stream?: TaskActionOutput["stream"];
  content?: string;
  detail?: string;
  tokenUsage?: TaskExecutionTokenUsage;
  metadata?: Record<string, string | number | boolean>;
}

export type RalphRunEvent =
  | {
      type: "block-start";
      blockId: string;
      attempt: number;
    }
  | {
      type: "block-output";
      blockId: string;
      output: RalphExecutionOutput;
      summary: string;
    }
  | {
      type: "edge-route";
      from: string;
      output: RalphExecutionOutput;
      to: string;
      edgeId?: string;
      deferred?: RalphAutonomyDeferredWork;
    }
  | {
      type: "retry";
      blockId: string;
      attempt: number;
      reason: string;
      recovery?: RalphAutonomyRecoveryAttempt;
    }
  | {
      type: "input-required";
      blockId: string;
      request: RalphInputRequest;
    }
  | {
      type: "input-submitted";
      blockId: string;
      requestId: string;
    }
  | {
      type: "input-cancelled";
      blockId: string;
      requestId: string;
    }
  | {
      type: "crash";
      blockId: string;
      output: RalphExecutionOutput;
      reason: string;
    }
  | {
      type: "progress";
      blockId: string;
      meaningful: boolean;
      channel: string;
      consecutiveNoProgress: number;
      summary: string;
    }
  | {
      type: "end";
      blockId: string;
      status: RalphRunStatus;
      summary: string;
      autonomy?: RalphRunAutonomyMetadata;
      exhaustion?: RalphAutonomyExhaustion;
      deferred?: RalphAutonomyDeferredWork;
    };

export type RalphLogEntryKind =
  | "run-start"
  | "run-end"
  | "block-start"
  | "block-input"
  | "block-output"
  | "edge-route"
  | "retry"
  | "input-required"
  | "input-submitted"
  | "crash"
  | "progress"
  | "action-output"
  | "generation";

export interface RalphSimpleLogEntry {
  sequence: number;
  createdAt: string;
  runId: string;
  kind: RalphLogEntryKind;
  message: string;
  flowId?: string;
  flowName?: string;
  blockId?: string;
  blockTitle?: string;
  blockType?: RalphBlockType;
  attempt?: number;
  output?: RalphExecutionOutput | string;
  status?:
    | RalphRunStatus
    | RalphBlockExecutionResult["status"]
    | TaskExecutionResult["status"];
  durationMs?: number;
  from?: string;
  to?: string;
  route?: string;
  provider?: ModelProvider;
  model?: string;
  inputPreview?: string;
  outputPreview?: string;
}

export interface RalphTraceLogEntry {
  sequence: number;
  createdAt: string;
  runId: string;
  kind: RalphLogEntryKind | "trace";
  message: string;
  flowId?: string;
  blockId?: string;
  blockTitle?: string;
  blockType?: RalphBlockType;
  attempt?: number;
  provider?: ModelProvider;
  model?: string;
  details?: unknown;
}

export interface RalphRunLogger {
  runId: string;
  paths?: RalphRunLogPaths;
  activate?(): void;
  simple(
    entry: Omit<RalphSimpleLogEntry, "sequence" | "createdAt" | "runId">,
  ): void;
  trace(
    entry: Omit<RalphTraceLogEntry, "sequence" | "createdAt" | "runId">,
  ): void;
  flush(): Promise<void>;
}

export interface RalphRunOptions {
  variableValues?: Record<string, string>;
  conversationContext?: TaskConversationContext;
  onStateChange?: TaskExecutionProgressHandler;
  onEvent?: (event: RalphRunEvent) => void | Promise<void>;
  checkpoint?: RalphRunCheckpoint;
  inputResponse?: RalphInputResponse;
  runId?: string;
  logger?: RalphRunLogger;
  signal?: AbortSignal;
  maxTransitions?: number | null;
  maxTotalTransitions?: number | null;
  repeatedFailureLimit?: number | null;
  autonomy?: RalphAutonomySetting;
  leaseOwnerId?: string;
  leaseDurationMs?: number;
  forceLeaseTakeover?: boolean;
  resolvedInstructions?: FrozenInstructionSet;
  instructionDeliveryPlan?: InstructionDeliveryPlan;
  instructionDeliveryReceipts?: InstructionDeliveryReceipt[];
  instructionBoundaryPolicy?:
    | "require-match"
    | "original-boundary"
    | "new-boundary";
  instructionBoundaries?: Record<string, RalphInstructionBoundary>;
}

export interface RalphExecutionOptionsSource {
  runId?: string;
  logger?: RalphRunLogger;
  signal?: AbortSignal;
  onStateChange?: TaskExecutionProgressHandler;
  resolvedInstructions?: FrozenInstructionSet;
  instructionDeliveryPlan?: InstructionDeliveryPlan;
  instructionDeliveryReceipts?: InstructionDeliveryReceipt[];
  instructionBoundaries?: Record<string, RalphInstructionBoundary>;
}

export interface RalphInstructionBoundary {
  resolution: FrozenInstructionSet;
  plan: InstructionDeliveryPlan;
  receipts: InstructionDeliveryReceipt[];
}

export interface RalphRunResult {
  runId?: string;
  startedAt?: string;
  finishedAt?: string;
  flow: string;
  status: RalphRunStatus;
  summary: string;
  events: RalphRunEvent[];
  blockResults: RalphBlockExecutionResult[];
  missingVariables: string[];
  unknownVariables: string[];
  validation: RalphValidationResult;
  pendingInput?: RalphInputRequest;
  checkpoint?: RalphRunCheckpoint;
  autonomy?: RalphRunAutonomyMetadata;
  outcome?: RalphRunOutcome;
  progress?: RalphProgressState;
  durability?: RalphRunDurability;
}

export interface RalphRunDurability {
  status: "healthy" | "degraded";
  required: boolean;
  lastPersistedAt?: string;
  error?: string;
}

export interface RalphRunLease {
  ownerId: string;
  generation: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  releasedAt?: string;
}

export interface RalphOperationLedgerEntry {
  id: string;
  blockId: string;
  attempt: number;
  state: "started" | "completed" | "reconciled" | "routed";
  startedAt: string;
  completedAt?: string;
  output?: RalphExecutionOutput;
  summary?: string;
  routedAt?: string;
  routedToBlockId?: string;
}

export interface RalphMediaRunCheckpoint {
  blockId: string;
  flowId: string;
  revisionId: string;
  runId: string;
  inputBindings: Record<string, RalphMediaResolvedInputBinding>;
  submittedAt?: string;
}

export interface RalphMediaResolvedInputBinding {
  source: "literal" | "path" | "media-asset";
  value: string | number | boolean;
}

export interface RalphFinalReportCheckpointArtifact {
  blockId: string;
  jsonPath?: string;
  markdownPath?: string;
}

export interface RalphRunRecordBlock {
  blockId: string;
  operationId?: string;
  output: RalphExecutionOutput;
  status: RalphBlockExecutionResult["status"];
  attempt: number;
  durationMs?: number;
  task?: string;
  executionStatus?: TaskExecutionResult["status"];
  reason?: string;
  executedTools?: TaskExecutionResult["executedTools"];
  outputSections?: TaskExecutionResult["outputSections"];
  response?: TaskExecutionResult["response"];
  progress?: RalphRunRecordBlockProgressEvent[];
  data?: unknown;
  summary: string;
  markdown?: string;
  error?: string;
  failure?: RalphBlockFailure;
  instructionDelivery?: {
    resolutionId: string;
    canonicalDigest: string;
    environmentDigest: string;
    planId: string;
    grade: string;
    sources: unknown[];
    nativeInventory: unknown[];
    mcpInitializationInstructions: unknown[];
    diagnostics: unknown[];
    plans: unknown[];
    adapterEvidence?: unknown;
    receipts: unknown[];
  };
}

export interface RalphInterviewState {
  turn: number;
  transcript: Array<{
    question: string;
    answer?: RalphInputValue;
    fieldId?: string;
  }>;
}

export interface RalphRunCheckpoint {
  currentBlockId: string;
  transitions: number;
  variables: Record<string, string>;
  resultsByBlock: Record<string, RalphBlockExecutionResult>;
  runLog: string[];
  blockResults: RalphBlockExecutionResult[];
  events: RalphRunEvent[];
  errorCounts: Record<string, number>;
  attemptCounts?: Record<string, number>;
  repeatedFailures: Record<string, RalphRepeatedFailureState>;
  recoveryCounts?: Record<string, number>;
  totalTransitions?: number;
  transitionBase?: number;
  autonomy?: RalphRunAutonomyMetadata;
  progress?: RalphProgressState;
  repositoryContext?: RalphRepositoryContext;
  repositoryBaseline?: RalphGitChangeSnapshot;
  pendingInput?: RalphInputRequest;
  interviewStates?: Record<string, RalphInterviewState>;
  runId?: string;
  startedAt?: string;
  flowId?: string;
  flowFingerprint?: string;
  instructionCanonicalDigest?: string;
  instructionEnvironmentDigests?: Record<string, string>;
  lease?: RalphRunLease;
  nextRetryAt?: string;
  segment?: number;
  operationLedger?: Record<string, RalphOperationLedgerEntry>;
  mediaRuns?: Record<string, RalphMediaRunCheckpoint>;
  finalReports?: RalphFinalReportCheckpointArtifact[];
  history?: {
    simpleJsonlPath?: string;
    traceJsonlPath?: string;
    blockResultCount: number;
    eventCount: number;
  };
  durability?: RalphRunDurability;
}

export interface RalphRunRecord {
  schemaVersion: typeof RALPH_FLOW_SCHEMA_VERSION;
  id: string;
  createdAt: string;
  finishedAt?: string;
  flowId: string;
  flowName: string;
  flowRevisionId?: string | null;
  status: RalphRunStatus;
  summary: string;
  variableValues: Record<string, string>;
  logPaths?: Pick<
    RalphRunLogPaths,
    "simpleJsonlPath" | "simpleMarkdownPath" | "traceJsonlPath"
  >;
  events: RalphRunEvent[];
  blockResults: RalphRunRecordBlock[];
  checkpoint?: RalphRunCheckpoint;
  validation: Pick<RalphValidationResult, "valid" | "errors" | "warnings">;
  durability?: RalphRunDurability;
  autonomy?: RalphRunAutonomyMetadata;
  outcome?: RalphRunOutcome;
  progress?: RalphProgressState;
}

export interface RalphRunRecordWriteResult {
  id: string;
  path: string;
  paths: RalphRunLogPaths;
  record: RalphRunRecord;
}

export interface RalphRunSummary {
  id: string;
  path: string;
  createdAt: string;
  finishedAt?: string;
  flowId: string;
  flowName: string;
  status: RalphRunSummaryStatus;
  outcome?: RalphRunOutcome;
  summary: string;
  simpleLogPath?: string;
  traceLogPath?: string;
  blockCount: number;
  eventCount: number;
}

export interface RalphRunLogReadResult {
  id: string;
  path: string;
  kind: "simple" | "trace";
  content: string;
}

export interface RalphFlowDeleteResult {
  id: string;
  path: string;
  revisionDirectory: string;
  deletedRevisions: boolean;
}

interface ResolvedVariableValues {
  values: Record<string, string>;
  missing: string[];
  unknown: string[];
}

interface RalphResultContext {
  runId: string;
  artifactRoot?: string;
  runWorkspaceRoot: string;
  lastResult?: RalphBlockExecutionResult;
  resultsByBlock: Map<string, RalphBlockExecutionResult>;
  runLog: string[];
  variables: Record<string, string>;
  interviewStates: Map<string, RalphInterviewState>;
  executionHistory?: RalphBlockExecutionResult[];
  events?: RalphRunEvent[];
  autonomy?: RalphRunAutonomyMetadata;
  progress?: RalphProgressState;
  repositoryContext?: RalphRepositoryContext;
  repositoryBaseline?: RalphGitChangeSnapshot;
  finalReports?: RalphFinalReportArtifact[];
  operationLedger?: Map<string, RalphOperationLedgerEntry>;
  mediaRuns?: Map<string, RalphMediaRunCheckpoint>;
  currentOperationId?: string;
}

export interface RalphRepeatedFailureState {
  signature: string;
  count: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export interface RalphFlowReferenceResolution {
  id: string;
  scope: RalphFlowScope;
  path: string;
  flow: RalphFlow;
}

export class RalphFlowNotFoundError extends Error {
  readonly reference: string;
  readonly scope: RalphFlowScope;

  constructor(reference: string, scope: RalphFlowScope) {
    super(`Ralph flow \`${reference}\` was not found.`);
    this.name = "RalphFlowNotFoundError";
    this.reference = reference;
    this.scope = scope;
  }
}

export class RalphFlowAliasConflictError extends Error {
  readonly alias: string;
  readonly conflictingFlowId: string;
  readonly conflictingFlowName: string;

  constructor(input: {
    alias: string;
    conflictingFlowId: string;
    conflictingFlowName: string;
  }) {
    super(
      `Ralph flow alias \`${input.alias}\` is already used by \`${input.conflictingFlowName}\`.`,
    );
    this.name = "RalphFlowAliasConflictError";
    this.alias = input.alias;
    this.conflictingFlowId = input.conflictingFlowId;
    this.conflictingFlowName = input.conflictingFlowName;
  }
}

const readRalphFlowFile = async (path: string): Promise<RalphFlow> => {
  return parseRalphFlowJson(await readFile(path, "utf8"));
};

export const resolveRalphFlowReference = async (
  workspaceRoot: string,
  reference: string,
  options: { scope?: RalphFlowScope } = {},
): Promise<RalphFlowReferenceResolution> => {
  const scope = options.scope ?? "workspace";
  const normalizedReference = normalizeFlowId(reference);

  if (!normalizedReference) {
    throw new Error("Expected Ralph flow id or alias.");
  }

  const directPath = getRalphFlowPath(
    workspaceRoot,
    normalizedReference,
    scope,
  );

  if (existsSync(directPath)) {
    const flow = await readRalphFlowFile(directPath);

    return {
      id: normalizeOptionalString(flow.id) ?? normalizedReference,
      scope,
      path: directPath,
      flow,
    };
  }

  const directory = getRalphFlowStorageDirectory(workspaceRoot, scope);

  if (!existsSync(directory)) {
    throw new RalphFlowNotFoundError(reference, scope);
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const matches: RalphFlowReferenceResolution[] = [];

  for (const entry of entries) {
    if (
      !entry.isFile() ||
      entry.name.startsWith(".") ||
      extname(entry.name) !== FLOW_FILE_EXTENSION
    ) {
      continue;
    }

    const path = join(directory, entry.name);

    try {
      const flow = await readRalphFlowFile(path);
      const alias = flow.alias ? normalizeFlowAlias(flow.alias) : "";

      if (alias === normalizedReference) {
        matches.push({
          id:
            normalizeOptionalString(flow.id) ??
            basename(entry.name, FLOW_FILE_EXTENSION),
          scope,
          path,
          flow,
        });
      }
    } catch {
      // Invalid flow files cannot participate in alias resolution.
    }
  }

  if (matches.length > 1) {
    throw new Error(`Ralph flow alias \`${reference}\` is not unique.`);
  }

  const match = matches[0];

  if (!match) {
    throw new RalphFlowNotFoundError(reference, scope);
  }

  return match;
};

export const parseRalphFlowJson = (raw: string): RalphFlow => {
  const parsed: unknown = JSON.parse(raw);
  return parseRalphFlowRecord(parsed);
};

export const readRalphFlow = async (
  workspaceRoot: string,
  id: string,
  options: RalphFlowReadOptions = {},
): Promise<RalphFlow> => {
  const flowReference = await resolveRalphFlowReference(workspaceRoot, id, {
    scope: options.scope ?? "workspace",
  });
  const flow = flowReference.flow;
  const validation = validateRalphFlow(flow);

  if (!options.allowInvalid && !validation.valid) {
    throw new Error(
      `Ralph flow \`${id}\` is invalid: ${validation.errors.join(" ")}`,
    );
  }

  return flow;
};

const assertRalphFlowAliasAvailable = async (
  workspaceRoot: string,
  flow: RalphFlow,
  scope: RalphFlowScope,
): Promise<void> => {
  const alias = flow.alias ? normalizeFlowAlias(flow.alias) : "";

  if (!alias) {
    return;
  }

  const directory = getRalphFlowStorageDirectory(workspaceRoot, scope);

  if (!existsSync(directory)) {
    return;
  }

  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (
      !entry.isFile() ||
      entry.name.startsWith(".") ||
      extname(entry.name) !== FLOW_FILE_EXTENSION
    ) {
      continue;
    }

    const path = join(directory, entry.name);

    const existingFlow = await readRalphFlowFile(path).catch(() => undefined);
    if (!existingFlow) {
      continue;
    }
    const existingId =
      normalizeOptionalString(existingFlow.id) ??
      basename(entry.name, FLOW_FILE_EXTENSION);

    if (existingId === flow.id) {
      continue;
    }

    const existingAlias = existingFlow.alias
      ? normalizeFlowAlias(existingFlow.alias)
      : "";

    if (existingId === alias || existingAlias === alias) {
      throw new RalphFlowAliasConflictError({
        alias: flow.alias ?? alias,
        conflictingFlowId: existingId,
        conflictingFlowName: existingFlow.name || existingId,
      });
    }
  }
};

export const writeRalphFlow = async (
  workspaceRoot: string,
  flow: RalphFlow,
  options: RalphFlowWriteOptions = {},
): Promise<string> => {
  const scope = options.scope ?? "workspace";
  const validation = validateRalphFlow(flow);

  if (!options.allowInvalid && !validation.valid) {
    throw new Error(`Ralph flow is invalid: ${validation.errors.join(" ")}`);
  }

  const directory = getRalphFlowStorageDirectory(workspaceRoot, scope);
  await mkdir(directory, { recursive: true });
  const boundaryPath = join(directory, ".ralph-flow-directory");
  const writeFlow = async (): Promise<string> => {
    const directoryLock = await acquireRalphFileMutationLock(
      boundaryPath,
      `flow:${process.pid}:${randomUUID()}`,
    );

    try {
      await assertRalphFlowAliasAvailable(workspaceRoot, flow, scope);
      const flowPath = getRalphFlowPath(workspaceRoot, flow.id, scope);
      const mutationLock = await acquireRalphFileMutationLock(
        flowPath,
        `flow:${process.pid}:${randomUUID()}`,
      );

      try {
        if (options.expectedFingerprint !== undefined) {
          if (!existsSync(flowPath)) {
            throw new Error(
              "Ralph flow CAS conflict: the expected flow no longer exists.",
            );
          }
          const actualFingerprint = createRalphFlowFingerprint(
            await readRalphFlowFile(flowPath),
          );
          if (actualFingerprint !== options.expectedFingerprint) {
            throw new Error(
              `Ralph flow CAS conflict: expected fingerprint ${options.expectedFingerprint}, found ${actualFingerprint}.`,
            );
          }
        }

        const now = new Date().toISOString();
        const storedFlow: RalphFlow = {
          ...flow,
          variables: validation.variables,
          createdAt: flow.createdAt ?? now,
          updatedAt: now,
        };

        if (options.createRevision && existsSync(flowPath)) {
          const revisionDirectory = getRalphRevisionDirectory(
            workspaceRoot,
            flow.id,
            scope,
          );
          await mkdir(revisionDirectory, { recursive: true });
          const revisionPath = createRalphRevisionFilePath(
            revisionDirectory,
            now,
          );
          await writeFileAtomically(
            revisionPath,
            await readFile(flowPath, "utf8"),
            "utf8",
          );
        }

        await writeJsonAtomically(flowPath, storedFlow);
        return flowPath;
      } finally {
        await mutationLock.release();
      }
    } finally {
      await directoryLock.release();
    }
  };

  return scope === "user"
    ? await withCooperativeFileLock(boundaryPath, writeFlow)
    : await writeFlow();
};

export const listRalphFlows = async (
  workspaceRoot: string,
  options: RalphFlowListOptions = {},
): Promise<RalphFlowSummary[]> => {
  const scopes: RalphFlowScope[] =
    options.scope === "all"
      ? ["workspace", "user"]
      : [options.scope ?? "workspace"];
  const summaries: RalphFlowSummary[] = [];
  const includeScope = options.scope !== undefined;

  for (const scope of scopes) {
    const directory = getRalphFlowStorageDirectory(workspaceRoot, scope);

    if (!existsSync(directory)) {
      continue;
    }

    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (
        !entry.isFile() ||
        entry.name.startsWith(".") ||
        extname(entry.name) !== FLOW_FILE_EXTENSION
      ) {
        continue;
      }

      const path = join(directory, entry.name);

      try {
        const flow = parseRalphFlowJson(await readFile(path, "utf8"));
        const variables = discoverRalphFlowVariables(flow);
        const alias = normalizeOptionalString(flow.alias);
        summaries.push({
          id:
            normalizeOptionalString(flow.id) ??
            basename(entry.name, FLOW_FILE_EXTENSION),
          ...(alias ? { alias } : {}),
          name:
            normalizeOptionalString(flow.name) ??
            basename(entry.name, FLOW_FILE_EXTENSION),
          ...(includeScope ? { scope } : {}),
          path,
          ...(flow.description ? { description: flow.description } : {}),
          ...(flow.source ? { source: flow.source } : {}),
          blockCount: flow.blocks.length,
          edgeCount: flow.edges.length,
          variableCount: variables.length,
        });
      } catch {
        summaries.push({
          id: basename(entry.name, FLOW_FILE_EXTENSION),
          name: basename(entry.name, FLOW_FILE_EXTENSION),
          ...(includeScope ? { scope } : {}),
          path,
          blockCount: 0,
          edgeCount: 0,
          variableCount: 0,
        });
      }
    }
  }

  return summaries.sort((left, right) =>
    (left.alias ?? left.name ?? left.id).localeCompare(
      right.alias ?? right.name ?? right.id,
    ),
  );
};

export const deleteRalphFlow = async (
  workspaceRoot: string,
  reference: string,
  options: RalphFlowDeleteOptions = {},
): Promise<RalphFlowDeleteResult> => {
  const scope = options.scope ?? "workspace";
  const normalizedReference = normalizeFlowId(reference);

  if (!normalizedReference) {
    throw new Error("Expected Ralph flow id or alias.");
  }

  const directory = getRalphFlowStorageDirectory(workspaceRoot, scope);
  await mkdir(directory, { recursive: true });
  const boundaryPath = join(directory, ".ralph-flow-directory");
  const deleteFlow = async (): Promise<RalphFlowDeleteResult> => {
    const directoryLock = await acquireRalphFileMutationLock(
      boundaryPath,
      `flow-delete:${process.pid}:${randomUUID()}`,
    );

    try {
      const directPath = getRalphFlowPath(
        workspaceRoot,
        normalizedReference,
        scope,
      );
      let flowId: string;
      let flowPath: string;

      if (existsSync(directPath)) {
        flowPath = directPath;
        let storedFlowId: string | undefined;

        try {
          const flow = await readRalphFlowFile(directPath);
          storedFlowId = normalizeOptionalString(flow.id);
        } catch {
          storedFlowId = undefined;
        }

        flowId = storedFlowId ?? normalizedReference;
      } else {
        const resolution = await resolveRalphFlowReference(
          workspaceRoot,
          reference,
          { scope },
        );
        flowId = normalizeOptionalString(resolution.flow.id) ?? resolution.id;
        flowPath = resolution.path;
      }

      const mutationLock = await acquireRalphFileMutationLock(
        flowPath,
        `flow-delete:${process.pid}:${randomUUID()}`,
      );
      try {
        if (options.expectedFingerprint !== undefined) {
          const actualFingerprint = createRalphFlowFingerprint(
            await readRalphFlowFile(flowPath),
          );
          if (actualFingerprint !== options.expectedFingerprint) {
            throw new Error(
              `Ralph flow CAS conflict: expected fingerprint ${options.expectedFingerprint}, found ${actualFingerprint}.`,
            );
          }
        }

        await unlink(flowPath);

        const revisionDirectory = getRalphRevisionDirectory(
          workspaceRoot,
          flowId,
          scope,
        );
        const deletedRevisions = existsSync(revisionDirectory);
        await rm(revisionDirectory, { recursive: true, force: true });

        return {
          id: flowId,
          path: flowPath,
          revisionDirectory,
          deletedRevisions,
        };
      } finally {
        await mutationLock.release();
      }
    } finally {
      await directoryLock.release();
    }
  };

  return scope === "user"
    ? await withCooperativeFileLock(boundaryPath, deleteFlow)
    : await deleteFlow();
};

export const listRalphFlowRevisions = async (
  workspaceRoot: string,
  flowId: string,
  options: { scope?: RalphFlowScope } = {},
): Promise<RalphFlowRevisionSummary[]> => {
  const scope = options.scope ?? "workspace";
  const flowReference = await resolveRalphFlowReference(workspaceRoot, flowId, {
    scope,
  });
  const directory = getRalphRevisionDirectory(
    workspaceRoot,
    flowReference.flow.id,
    scope,
  );

  if (!existsSync(directory)) {
    return [];
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const revisions: RalphFlowRevisionSummary[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name) !== FLOW_FILE_EXTENSION) {
      continue;
    }

    const id = basename(entry.name, FLOW_FILE_EXTENSION);
    const path = getRalphRevisionPath(workspaceRoot, flowId, id, scope);
    const metadata = await stat(path);

    try {
      const flow = parseRalphFlowJson(await readFile(path, "utf8"));
      const validation = validateRalphFlow(flow);
      revisions.push({
        id,
        path,
        createdAt: metadata.mtime.toISOString(),
        flowName: flow.name,
        blockCount: flow.blocks.length,
        edgeCount: flow.edges.length,
        valid: validation.valid,
      });
    } catch {
      revisions.push({
        id,
        path,
        createdAt: metadata.mtime.toISOString(),
        flowName: id,
        blockCount: 0,
        edgeCount: 0,
        valid: false,
      });
    }
  }

  return revisions.sort((left, right) => right.id.localeCompare(left.id));
};

export const restoreRalphFlowRevision = async (
  workspaceRoot: string,
  flowId: string,
  revisionId: string,
  options: { scope?: RalphFlowScope; expectedFingerprint?: string } = {},
): Promise<{
  path: string;
  flow: RalphFlow;
  validation: RalphValidationResult;
  revision: RalphFlowRevisionSummary;
}> => {
  const scope = options.scope ?? "workspace";
  const flowReference = await resolveRalphFlowReference(workspaceRoot, flowId, {
    scope,
  });
  const path = getRalphRevisionPath(
    workspaceRoot,
    flowReference.flow.id,
    revisionId,
    scope,
  );
  const revisionMetadata = await stat(path);
  const flow = parseRalphFlowJson(await readFile(path, "utf8"));
  const revisionValidation = validateRalphFlow(flow);

  if (normalizeFlowId(flow.id) !== normalizeFlowId(flowReference.flow.id)) {
    throw new Error(
      `Ralph revision \`${revisionId}\` belongs to flow \`${flow.id}\`, not \`${flowReference.flow.id}\`.`,
    );
  }

  const restoredPath = await writeRalphFlow(workspaceRoot, flow, {
    createRevision: true,
    reason: "restore-revision",
    allowInvalid: true,
    scope,
    ...(options.expectedFingerprint
      ? { expectedFingerprint: options.expectedFingerprint }
      : {}),
  });
  const restoredFlow = await readRalphFlow(
    workspaceRoot,
    flowReference.flow.id,
    {
      allowInvalid: true,
      scope,
    },
  );

  return {
    path: restoredPath,
    flow: restoredFlow,
    validation: validateRalphFlow(restoredFlow),
    revision: {
      id: normalizeRevisionId(revisionId),
      path,
      createdAt: revisionMetadata.mtime.toISOString(),
      flowName: flow.name,
      blockCount: flow.blocks.length,
      edgeCount: flow.edges.length,
      valid: revisionValidation.valid,
    },
  };
};

export const createLogTimestamp = (): string => new Date().toISOString();

class RalphFileRunLogger implements RalphRunLogger {
  public readonly runId: string;
  public readonly paths: RalphRunLogPaths;
  private sequence = 0;
  private pending: Promise<void> = Promise.resolve();
  private failure: unknown;
  private suspended: boolean;
  private readonly suspendedWrites: Array<() => Promise<void>> = [];

  public constructor(
    paths: RalphRunLogPaths,
    initialSequence = 0,
    suspended = false,
  ) {
    this.runId = paths.id;
    this.paths = paths;
    this.sequence = initialSequence;
    this.suspended = suspended;
  }

  public activate(): void {
    if (!this.suspended) {
      return;
    }

    this.suspended = false;
    for (const write of this.suspendedWrites.splice(0)) {
      this.enqueue(write);
    }
  }

  public simple(
    entry: Omit<RalphSimpleLogEntry, "sequence" | "createdAt" | "runId">,
  ): void {
    const completedEntry: RalphSimpleLogEntry = {
      sequence: this.nextSequence(),
      createdAt: createLogTimestamp(),
      runId: this.runId,
      ...entry,
      message: capLogText(entry.message, MAX_RALPH_SIMPLE_LOG_CHARS),
      ...(entry.inputPreview
        ? {
            inputPreview: capLogText(
              entry.inputPreview,
              MAX_RALPH_SIMPLE_LOG_CHARS,
            ),
          }
        : {}),
      ...(entry.outputPreview
        ? {
            outputPreview: capLogText(
              entry.outputPreview,
              MAX_RALPH_SIMPLE_LOG_CHARS,
            ),
          }
        : {}),
    };

    this.enqueue(async () => {
      await appendFile(
        this.paths.simpleJsonlPath,
        createRalphLogLine(completedEntry),
        "utf8",
      );
      await appendFile(
        this.paths.simpleMarkdownPath,
        `${formatRalphSimpleMarkdownEntry(completedEntry)}\n`,
        "utf8",
      );
    });
  }

  public trace(
    entry: Omit<RalphTraceLogEntry, "sequence" | "createdAt" | "runId">,
  ): void {
    const completedEntry: RalphTraceLogEntry = {
      sequence: this.nextSequence(),
      createdAt: createLogTimestamp(),
      runId: this.runId,
      ...entry,
      message: capLogText(entry.message, MAX_RALPH_SIMPLE_LOG_CHARS),
      ...(entry.details !== undefined
        ? { details: sanitizeTraceValue(entry.details) }
        : {}),
    };

    this.enqueue(async () => {
      await appendFile(
        this.paths.traceJsonlPath,
        createRalphLogLine(completedEntry),
        "utf8",
      );
    });
  }

  public async flush(): Promise<void> {
    await this.pending;
    if (this.failure !== undefined) {
      throw this.failure;
    }
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private enqueue(write: () => Promise<void>): void {
    if (this.failure !== undefined) {
      return;
    }
    if (this.suspended) {
      this.suspendedWrites.push(write);
      return;
    }

    this.pending = this.pending.then(write).catch((error: unknown) => {
      this.failure = error;
    });
  }
}

const readLastRalphLogSequence = async (
  paths: RalphRunLogPaths,
): Promise<number> => {
  const contents = await Promise.all(
    [paths.simpleJsonlPath, paths.traceJsonlPath].map((path) =>
      readFile(path, "utf8").catch(() => ""),
    ),
  );
  let maximum = 0;

  for (const content of contents) {
    for (const line of content.trim().split(/\r?\n/u)) {
      if (!line) {
        continue;
      }
      try {
        const value = JSON.parse(line) as unknown;
        if (isRecord(value) && typeof value.sequence === "number") {
          maximum = Math.max(maximum, value.sequence);
        }
      } catch {
        // A partial tail is ignored; subsequent entries continue after the last valid sequence.
      }
    }
  }

  return maximum;
};

export const pruneRalphRunArtifacts = async (
  workspaceRoot: string,
  options: {
    scope?: RalphFlowScope;
    maxRuns?: number;
    maxAgeDays?: number;
    preserveRunId?: string;
  } = {},
): Promise<{ removed: string[] }> => {
  const runDirectory = getRalphRunDirectory(
    workspaceRoot,
    options.scope ?? "workspace",
  );
  const entries = await readdir(runDirectory, { withFileTypes: true }).catch(
    () => [],
  );
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(runDirectory, entry.name);
        const metadata = await stat(path).catch(() => undefined);
        const record = await readRalphRunRecordFile(join(path, "run.json"));
        return { id: entry.name, path, metadata, record };
      }),
  );
  candidates.sort(
    (left, right) =>
      (right.metadata?.mtimeMs ?? 0) - (left.metadata?.mtimeMs ?? 0),
  );
  const maxRuns = Math.max(1, options.maxRuns ?? 500);
  const cutoff =
    Date.now() - Math.max(1, options.maxAgeDays ?? 90) * 24 * 60 * 60_000;
  const removed: string[] = [];

  for (const [index, candidate] of candidates.entries()) {
    if (
      candidate.id === options.preserveRunId ||
      candidate.record?.status === "running" ||
      !candidate.metadata ||
      (index < maxRuns && candidate.metadata.mtimeMs >= cutoff)
    ) {
      continue;
    }
    if (!isResolvedPathInside(candidate.path, runDirectory)) {
      continue;
    }
    await rm(candidate.path, { recursive: true, force: true });
    removed.push(candidate.id);
  }

  return { removed };
};

const getRalphExecutionHistoryPath = (paths: RalphRunLogPaths): string =>
  join(paths.directory, "execution-history.jsonl");

const appendFileDurably = async (
  path: string,
  content: string | NodeJS.ArrayBufferView,
  encoding: BufferEncoding = "utf8",
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  try {
    if (typeof content === "string") {
      await handle.writeFile(content, encoding);
    } else {
      await handle.writeFile(
        new Uint8Array(content.buffer, content.byteOffset, content.byteLength),
      );
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const appendRalphExecutionHistoryResult = async (
  paths: RalphRunLogPaths,
  result: RalphBlockExecutionResult,
): Promise<void> => {
  await appendFileDurably(
    getRalphExecutionHistoryPath(paths),
    `${JSON.stringify({ kind: "block-result", result })}\n`,
  );
};

export const readRalphExecutionHistoryResults = async (
  paths: RalphRunLogPaths | undefined,
): Promise<RalphBlockExecutionResult[]> => {
  if (!paths) {
    return [];
  }
  const historyPath = getRalphExecutionHistoryPath(paths);
  let content: string;
  try {
    content = await readFile(historyPath, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return [];
    }
    throw new Error(
      `Could not read Ralph execution history at ${historyPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const results: RalphBlockExecutionResult[] = [];
  const seen = new Set<string>();
  const lines = content.split(/\r?\n/u);
  const hasTerminatingNewline = content.endsWith("\n");

  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as unknown;
      const result =
        isRecord(entry) &&
        entry.kind === "block-result" &&
        isRecord(entry.result)
          ? (entry.result as unknown as RalphBlockExecutionResult)
          : undefined;
      if (
        !result ||
        typeof result.blockId !== "string" ||
        typeof result.output !== "string"
      ) {
        throw new Error("entry is not a Ralph block-result record");
      }
      const key =
        result.operationId ??
        `${results.length}:${result.blockId}:${result.attempt}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push(result);
      }
    } catch (error) {
      const isPartialCrashTail =
        index === lines.length - 1 && !hasTerminatingNewline;
      if (isPartialCrashTail) {
        break;
      }
      throw new Error(
        `Corrupt Ralph execution history at ${historyPath}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  return results;
};

export interface RalphFileMutationLock {
  path: string;
  assertOwnership(): Promise<void>;
  release(): Promise<void>;
}

export class RalphMutationLeaseActiveError extends Error {
  readonly targetPath: string;

  constructor(targetPath: string, cause?: unknown) {
    super(`Ralph mutation lease is active for ${targetPath}.`, { cause });
    this.name = "RalphMutationLeaseActiveError";
    this.targetPath = targetPath;
  }
}

const activeRalphFileMutationLocks = new Map<
  string,
  { ownerId: string; ownerGroupId?: string; lock: RalphFileMutationLock }
>();

export const releaseActiveRalphFileMutationLocks = async (
  leaseOwnerId: string,
): Promise<void> => {
  const ownedLocks = [...activeRalphFileMutationLocks.values()].filter(
    ({ ownerId, ownerGroupId }) =>
      ownerId === leaseOwnerId || ownerGroupId === leaseOwnerId,
  );
  const releases = await Promise.allSettled(
    ownedLocks.map(({ lock }) => lock.release()),
  );
  const failure = releases.find(
    (release): release is PromiseRejectedResult =>
      release.status === "rejected",
  );
  if (failure) {
    throw failure.reason;
  }
};

const RALPH_TRANSIENT_MUTATION_LEASE_ERROR_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EPERM",
]);

const retryRalphMutationLeaseOperation = async <T>(
  operation: () => Promise<T>,
  retryWindowMs: number,
): Promise<T> => {
  const deadline = Date.now() + retryWindowMs;
  let retryDelayMs = 20;

  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (
        !RALPH_TRANSIENT_MUTATION_LEASE_ERROR_CODES.has(
          (error as NodeJS.ErrnoException).code ?? "",
        ) ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await new Promise((resolveDelay) =>
        setTimeout(
          resolveDelay,
          Math.min(retryDelayMs, Math.max(0, deadline - Date.now())),
        ),
      );
      retryDelayMs = Math.min(250, retryDelayMs * 2);
    }
  }
};

const isRalphMutationLockProcessAlive = (pid: unknown): boolean => {
  if (!Number.isInteger(pid) || Number(pid) <= 0) {
    return false;
  }
  if (Number(pid) === process.pid) {
    return true;
  }

  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

export const acquireRalphFileMutationLock = async (
  targetPath: string,
  ownerId: string,
  staleAfterMs = DEFAULT_RALPH_WORK_ITEM_LEASE_MS,
  options: { reapLiveOwner?: boolean; ownerGroupId?: string } = {},
): Promise<RalphFileMutationLock> => {
  const lockPath = `${targetPath}.ralph.lock`;
  await mkdir(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const token = randomUUID();
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(
          `${JSON.stringify({ token, ownerId, ...(options.ownerGroupId ? { ownerGroupId: options.ownerGroupId } : {}), pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
          "utf8",
        );
        await handle.sync();
      } catch (error) {
        await rm(lockPath, { force: true }).catch(() => undefined);
        throw error;
      } finally {
        await handle.close().catch(() => undefined);
      }
      let compromiseError: unknown;
      const retryWindowMs = Math.max(
        250,
        Math.min(5_000, Math.floor(staleAfterMs / 6)),
      );
      const assertOwnership = async (): Promise<void> => {
        if (compromiseError) {
          throw compromiseError;
        }
        const record = await retryRalphMutationLeaseOperation(
          async () =>
            JSON.parse(await readFile(lockPath, "utf8")) as {
              token?: unknown;
            },
          retryWindowMs,
        ).catch((error: unknown) => {
          throw new Error(`Ralph mutation lease was lost for ${targetPath}.`, {
            cause: error,
          });
        });
        if (record.token !== token) {
          throw new Error(
            `Ralph mutation lease was replaced for ${targetPath}.`,
          );
        }
      };
      await assertOwnership();
      let heartbeatPending = Promise.resolve();
      const heartbeatHandle = setInterval(
        () => {
          heartbeatPending = heartbeatPending
            .then(async () => {
              await assertOwnership();
              await retryRalphMutationLeaseOperation(async () => {
                const now = new Date();
                await utimes(lockPath, now, now);
              }, retryWindowMs);
            })
            .catch((error: unknown) => {
              compromiseError ??= error;
            });
        },
        Math.max(1_000, Math.floor(staleAfterMs / 3)),
      );

      let lock: RalphFileMutationLock;
      lock = {
        path: lockPath,
        assertOwnership,
        release: async () => {
          clearInterval(heartbeatHandle);
          await heartbeatPending.catch(() => undefined);
          const record = await retryRalphMutationLeaseOperation(
            async () =>
              JSON.parse(await readFile(lockPath, "utf8")) as {
                token?: unknown;
              },
            retryWindowMs,
          ).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              return undefined;
            }
            throw error;
          });
          if (record?.token === token) {
            await retryRalphMutationLeaseOperation(
              () => rm(lockPath, { force: true }),
              retryWindowMs,
            );
          }
          if (activeRalphFileMutationLocks.get(lockPath)?.lock === lock) {
            activeRalphFileMutationLocks.delete(lockPath);
          }
        },
      };
      activeRalphFileMutationLocks.set(lockPath, {
        ownerId,
        ...(options.ownerGroupId ? { ownerGroupId: options.ownerGroupId } : {}),
        lock,
      });
      return lock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      const metadata = await stat(lockPath).catch(() => undefined);
      if (
        attempt === 0 &&
        metadata &&
        Date.now() - metadata.mtimeMs >= staleAfterMs
      ) {
        const staleToken = await readFile(lockPath, "utf8").catch(
          () => undefined,
        );
        if (staleToken !== undefined) {
          const staleOwner = (() => {
            try {
              return JSON.parse(staleToken) as {
                pid?: unknown;
                token?: unknown;
              };
            } catch {
              return undefined;
            }
          })();
          if (
            options.reapLiveOwner === false &&
            isRalphMutationLockProcessAlive(staleOwner?.pid)
          ) {
            throw new RalphMutationLeaseActiveError(targetPath, error);
          }
          const confirmedToken = await readFile(lockPath, "utf8").catch(
            () => undefined,
          );
          if (confirmedToken === staleToken) {
            const confirmedMetadata = await stat(lockPath).catch(
              () => undefined,
            );
            if (
              confirmedMetadata &&
              Date.now() - confirmedMetadata.mtimeMs >= staleAfterMs
            ) {
              const finalToken = await readFile(lockPath, "utf8").catch(
                () => undefined,
              );
              if (finalToken === staleToken) {
                await rm(lockPath, { force: true });
                continue;
              }
            }
          }
        }
      }

      throw new RalphMutationLeaseActiveError(targetPath, error);
    }
  }

  throw new Error(`Could not acquire Ralph mutation lease for ${targetPath}.`);
};

export const createRalphRunLogger = async (
  workspaceRoot: string,
  flow: RalphFlow,
  options: {
    runId?: string;
    variableValues?: Record<string, string>;
    paths?: RalphRunLogPaths;
    append?: boolean;
    forceTakeover?: boolean;
    deferWritesUntilActivated?: boolean;
    scope?: RalphFlowScope;
  } = {},
): Promise<RalphRunLogger> => {
  const createdAt = createLogTimestamp();
  const paths =
    options.paths ??
    createRalphRunArtifactPaths(
      getRalphRunDirectory(workspaceRoot, options.scope ?? "workspace"),
      createdAt,
      options.runId,
    );

  if (
    !options.append &&
    !options.forceTakeover &&
    existsSync(paths.recordPath)
  ) {
    let existing: unknown;
    try {
      existing = JSON.parse(
        await readFile(paths.recordPath, "utf8"),
      ) as unknown;
    } catch (error) {
      throw new Error(
        `Ralph logger refused to overwrite unreadable existing run record ${paths.recordPath}.`,
        { cause: error },
      );
    }
    if (!isRalphRunRecord(existing, RALPH_FLOW_SCHEMA_VERSION)) {
      throw new Error(
        `Ralph logger refused to overwrite invalid existing run record ${paths.recordPath}.`,
      );
    }
    const lease = existing.checkpoint?.lease;
    const leaseIsLive = Boolean(
      lease && !lease.releasedAt && Date.parse(lease.expiresAt) > Date.now(),
    );
    if (existing.status === "running" || leaseIsLive) {
      throw new Error(
        `Ralph logger refused to overwrite active run ${paths.id}; resume with append mode or explicitly take it over.`,
      );
    }
  }
  if (!options.append) {
    await pruneRalphRunArtifacts(workspaceRoot, {
      scope: options.scope ?? "workspace",
      ...(options.runId ? { preserveRunId: options.runId } : {}),
    }).catch(() => undefined);
  }

  await mkdir(paths.directory, { recursive: true });
  await scavengeAtomicTemporaryFiles(paths.directory).catch(() => undefined);
  const logger = new RalphFileRunLogger(
    paths,
    options.append ? await readLastRalphLogSequence(paths) : 0,
    options.deferWritesUntilActivated === true,
  );
  if (options.append) {
    if (!options.deferWritesUntilActivated) {
      await appendFile(
        paths.simpleMarkdownPath,
        [``, `## Resumed ${createdAt}`, ``].join("\n"),
        "utf8",
      );
    }
  } else {
    await writeFile(
      paths.simpleMarkdownPath,
      [
        `# Ralph Run ${paths.id}`,
        "",
        `Flow: ${flow.name} (${flow.id})`,
        `Started: ${createdAt}`,
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(paths.simpleJsonlPath, "", "utf8");
    await writeFile(paths.traceJsonlPath, "", "utf8");
    await writeFile(getRalphExecutionHistoryPath(paths), "", "utf8");
  }
  if (options.append && options.deferWritesUntilActivated) {
    logger.simple({
      kind: "run-start",
      message: `Ralph run ${paths.id} resumed.`,
      flowId: flow.id,
      flowName: flow.name,
    });
  }
  logger.trace({
    kind: "run-start",
    message: options.append
      ? `Ralph run ${paths.id} resumed.`
      : `Ralph run ${paths.id} created.`,
    flowId: flow.id,
    details: {
      flow,
      variableValues: options.variableValues ?? {},
    },
  });

  return logger;
};

export const writeRalphRunRecord = async (
  workspaceRoot: string,
  flow: RalphFlow,
  result: RalphRunResult,
  options: {
    variableValues?: Record<string, string>;
    runId?: string;
    paths?: RalphRunLogPaths;
    scope?: RalphFlowScope;
  } = {},
): Promise<RalphRunRecordWriteResult> => {
  const createdAt = new Date().toISOString();
  const runDirectory = getRalphRunDirectory(
    workspaceRoot,
    options.scope ?? "workspace",
  );
  await mkdir(runDirectory, { recursive: true });

  const paths =
    options.paths ??
    createRalphRunArtifactPaths(
      runDirectory,
      result.startedAt ?? createdAt,
      options.runId ?? result.runId,
    );
  await mkdir(paths.directory, { recursive: true });
  const record = createRalphRunRecord(
    RALPH_FLOW_SCHEMA_VERSION,
    paths.id,
    result.startedAt ?? createdAt,
    flow,
    result,
    options.variableValues ?? {},
    paths,
  );

  await writeJsonAtomically(paths.recordPath, record);

  return { id: paths.id, path: paths.recordPath, paths, record };
};

const readRalphRunRecordFile = async (
  path: string,
): Promise<RalphRunRecord | null> => {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isRalphRunRecord(value, RALPH_FLOW_SCHEMA_VERSION) ? value : null;
  } catch {
    return null;
  }
};

const isRalphSimpleLogEntry = (
  value: unknown,
): value is RalphSimpleLogEntry => {
  return (
    isRecord(value) &&
    typeof value.sequence === "number" &&
    typeof value.createdAt === "string" &&
    typeof value.runId === "string" &&
    typeof value.kind === "string" &&
    typeof value.message === "string"
  );
};

const readRalphSimpleLogEntries = async (
  path: string,
): Promise<RalphSimpleLogEntry[]> => {
  try {
    const content = await readFile(path, "utf8");

    return content
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          const value = JSON.parse(line) as unknown;
          return isRalphSimpleLogEntry(value) ? [value] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
};

const getPartialRalphRunLogPath = (
  runDirectory: string,
  runId: string,
  kind: "simple" | "trace",
): string | null => {
  const directRunDirectory = join(runDirectory, runId);
  const partialRunDirectory = existsSync(directRunDirectory)
    ? directRunDirectory
    : join(runDirectory, normalizeRunId(runId));

  if (kind === "trace") {
    const tracePath = join(partialRunDirectory, "trace.jsonl");
    return existsSync(tracePath) ? tracePath : null;
  }

  const simpleMarkdownPath = join(partialRunDirectory, "simple.md");
  if (existsSync(simpleMarkdownPath)) {
    return simpleMarkdownPath;
  }

  const simpleJsonlPath = join(partialRunDirectory, "simple.jsonl");
  return existsSync(simpleJsonlPath) ? simpleJsonlPath : null;
};

const createPartialRalphRunSummary = async (
  directory: string,
  id: string,
): Promise<RalphRunSummary | null> => {
  const simpleJsonlPath = join(directory, "simple.jsonl");
  const simpleMarkdownPath = join(directory, "simple.md");
  const traceJsonlPath = join(directory, "trace.jsonl");

  if (
    !existsSync(simpleJsonlPath) &&
    !existsSync(simpleMarkdownPath) &&
    !existsSync(traceJsonlPath)
  ) {
    return null;
  }

  const entries = existsSync(simpleJsonlPath)
    ? await readRalphSimpleLogEntries(simpleJsonlPath)
    : [];
  const firstEntry = entries[0];
  const lastEntry = entries[entries.length - 1];
  const directoryStat = await stat(directory).catch(() => null);
  const createdAt =
    firstEntry?.createdAt ??
    (directoryStat
      ? new Date(
          directoryStat.birthtimeMs || directoryStat.mtimeMs,
        ).toISOString()
      : createLogTimestamp());
  const flowEntry = entries.find((entry) => entry.flowId || entry.flowName);
  const blockCount = entries.filter(
    (entry) => entry.kind === "block-output",
  ).length;
  const lastBlockLabel =
    lastEntry?.blockTitle ?? lastEntry?.blockId ?? lastEntry?.kind;
  const summary = lastEntry
    ? lastEntry.kind === "run-end"
      ? `Partial Ralph run without run.json: ${lastEntry.message}`
      : `Partial Ralph run without run.json; last log ${lastBlockLabel}: ${lastEntry.message}`
    : "Partial Ralph run without run.json.";

  return {
    id,
    path: directory,
    createdAt,
    flowId: flowEntry?.flowId ?? "unknown",
    flowName: flowEntry?.flowName ?? "Unknown Ralph flow",
    status: "partial",
    summary,
    ...(existsSync(simpleMarkdownPath)
      ? { simpleLogPath: simpleMarkdownPath }
      : existsSync(simpleJsonlPath)
        ? { simpleLogPath: simpleJsonlPath }
        : {}),
    ...(existsSync(traceJsonlPath) ? { traceLogPath: traceJsonlPath } : {}),
    blockCount,
    eventCount: entries.length,
  };
};

const resolveRalphRunRecordPath = async (
  workspaceRoot: string,
  runId: string,
  scope: RalphFlowScope = "workspace",
): Promise<string> => {
  const normalizedRunId = normalizeRunId(runId);
  const runDirectory = getRalphRunDirectory(workspaceRoot, scope);
  const directoryRecordPath = join(runDirectory, normalizedRunId, "run.json");
  const flatRecordPath = join(runDirectory, `${normalizedRunId}.json`);

  if (existsSync(directoryRecordPath)) {
    return directoryRecordPath;
  }

  if (existsSync(flatRecordPath)) {
    return flatRecordPath;
  }

  throw new Error(`Ralph run \`${runId}\` was not found.`);
};

export const readRalphRunRecord = async (
  workspaceRoot: string,
  runId: string,
  options: { scope?: RalphFlowScope } = {},
): Promise<{
  path: string;
  record: RalphRunRecord;
  effectiveStatus: RalphRunSummaryStatus;
}> => {
  const path = await resolveRalphRunRecordPath(
    workspaceRoot,
    runId,
    options.scope ?? "workspace",
  );
  const record = await readRalphRunRecordFile(path);

  if (!record) {
    throw new Error(`Ralph run \`${runId}\` is not a valid run record.`);
  }

  const artifactDirectory =
    basename(path) === "run.json" ? dirname(path) : undefined;
  const summary = await createLiveAwareRalphRunSummary(
    record,
    path,
    artifactDirectory,
  );

  return { path, record, effectiveStatus: summary.status };
};

const createLiveAwareRalphRunSummary = async (
  record: RalphRunRecord,
  path: string,
  artifactDirectory?: string,
): Promise<RalphRunSummary> => {
  const summary = createRalphRunSummaryFromRecord(record, path);
  if (record.status !== "running") {
    return summary;
  }

  if (artifactDirectory) {
    try {
      const independentLease = await new RalphRunStore(
        artifactDirectory,
      ).readLease(0);
      if (independentLease) {
        if (
          independentLease.lease.runId !== record.id ||
          independentLease.lease.flowId !== record.flowId
        ) {
          return summary;
        }
        return independentLease.active
          ? summary
          : { ...summary, status: "abandoned" };
      }
    } catch {
      // An unreadable lease is not evidence that the owner is gone.
      return summary;
    }
  }

  const checkpointLease = record.checkpoint?.lease;
  if (
    checkpointLease &&
    !checkpointLease.releasedAt &&
    Date.parse(checkpointLease.expiresAt) > Date.now()
  ) {
    return summary;
  }

  const metadata = await stat(path).catch(() => undefined);
  if (
    metadata &&
    Date.now() - metadata.mtimeMs <= DEFAULT_RALPH_RUN_LEASE_DURATION_MS
  ) {
    return summary;
  }

  return { ...summary, status: "abandoned" };
};

export const listRalphRunRecords = async (
  workspaceRoot: string,
  options: {
    flowId?: string;
    limit?: number;
    scope?: RalphFlowScope;
  } = {},
): Promise<RalphRunSummary[]> => {
  const runDirectory = getRalphRunDirectory(
    workspaceRoot,
    options.scope ?? "workspace",
  );

  if (!existsSync(runDirectory)) {
    return [];
  }

  const entries = await readdir(runDirectory, { withFileTypes: true });
  const summaries: RalphRunSummary[] = [];
  const normalizedFlowId = options.flowId
    ? normalizeFlowId(options.flowId)
    : undefined;

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const directory = join(runDirectory, entry.name);
      const path = join(directory, "run.json");

      if (!existsSync(path)) {
        const partialSummary = await createPartialRalphRunSummary(
          directory,
          entry.name,
        );

        if (
          partialSummary &&
          (!normalizedFlowId ||
            normalizeFlowId(partialSummary.flowId) === normalizedFlowId)
        ) {
          summaries.push(partialSummary);
        }

        continue;
      }

      const record = await readRalphRunRecordFile(path);

      if (!record) {
        const partialSummary = await createPartialRalphRunSummary(
          directory,
          entry.name,
        );

        if (
          partialSummary &&
          (!normalizedFlowId ||
            normalizeFlowId(partialSummary.flowId) === normalizedFlowId)
        ) {
          summaries.push(partialSummary);
        }

        continue;
      }

      if (
        normalizedFlowId &&
        normalizeFlowId(record.flowId) !== normalizedFlowId
      ) {
        continue;
      }

      summaries.push(
        await createLiveAwareRalphRunSummary(record, path, directory),
      );
      continue;
    }

    const path =
      entry.isFile() && entry.name.endsWith(".json")
        ? join(runDirectory, entry.name)
        : undefined;

    if (!path || !existsSync(path)) {
      continue;
    }

    const record = await readRalphRunRecordFile(path);

    if (!record) {
      continue;
    }

    if (
      normalizedFlowId &&
      normalizeFlowId(record.flowId) !== normalizedFlowId
    ) {
      continue;
    }

    summaries.push(await createLiveAwareRalphRunSummary(record, path));
  }

  return summaries
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, options.limit ?? 50);
};

export const readRalphRunLog = async (
  workspaceRoot: string,
  runId: string,
  kind: "simple" | "trace" = "simple",
  options: { scope?: RalphFlowScope } = {},
): Promise<RalphRunLogReadResult> => {
  const scope = options.scope ?? "workspace";

  try {
    const { path: recordPath, record } = await readRalphRunRecord(
      workspaceRoot,
      runId,
      {
        scope,
      },
    );
    const logPath =
      kind === "trace"
        ? record.logPaths?.traceJsonlPath
        : record.logPaths?.simpleMarkdownPath;
    const fallbackPath =
      kind === "trace"
        ? join(dirname(recordPath), "trace.jsonl")
        : join(dirname(recordPath), "simple.md");
    const path = logPath && existsSync(logPath) ? logPath : fallbackPath;

    if (!existsSync(path)) {
      throw new Error(`Ralph ${kind} log for run \`${runId}\` was not found.`);
    }

    return {
      id: record.id,
      path,
      kind,
      content: await readFile(path, "utf8"),
    };
  } catch (error) {
    const runDirectory = getRalphRunDirectory(workspaceRoot, scope);
    const partialLogPath = getPartialRalphRunLogPath(runDirectory, runId, kind);

    if (!partialLogPath) {
      throw error;
    }

    return {
      id: normalizeRunId(runId),
      path: partialLogPath,
      kind,
      content: await readFile(partialLogPath, "utf8"),
    };
  }
};

const resolveVariableValues = (
  variables: RalphFlowVariable[],
  supplied: Record<string, string> = {},
): ResolvedVariableValues => {
  const values: Record<string, string> = {};
  const variableNames = new Set(variables.map((variable) => variable.name));
  const missing: string[] = [];
  const unknown = Object.keys(supplied).filter(
    (name) => !variableNames.has(name),
  );

  for (const variable of variables) {
    const suppliedValue = supplied[variable.name];

    if (
      suppliedValue !== undefined &&
      !(suppliedValue === "" && variable.default !== undefined)
    ) {
      values[variable.name] = suppliedValue;
      continue;
    }

    if (variable.default !== undefined) {
      values[variable.name] = variable.default;
      continue;
    }

    if (variable.required) {
      missing.push(variable.name);
    } else {
      values[variable.name] = "";
    }
  }

  return { values, missing, unknown };
};

const resolvePlaceholder = (
  placeholder: ParsedRalphPlaceholder,
  context: RalphResultContext,
  strict = false,
): string => {
  if (placeholder.variable) {
    const value = context.variables[placeholder.variable.name];

    return value !== undefined && value !== ""
      ? value
      : (placeholder.variable.default ?? "");
  }

  if (placeholder.builtin === "lastResult") {
    return placeholder.builtin && context.lastResult?.markdown
      ? context.lastResult.markdown
      : "";
  }

  if (placeholder.builtin === "lastResultSummary") {
    return context.lastResult?.summary ?? "";
  }

  if (placeholder.builtin === "lastError") {
    return context.lastResult?.error ?? "";
  }

  if (placeholder.builtin === "lastData") {
    return context.lastResult?.data !== undefined
      ? JSON.stringify(context.lastResult.data)
      : "";
  }

  if (placeholder.builtin === "runLog") {
    return context.runLog.join("\n");
  }

  if (placeholder.builtin === "run:id") {
    return context.runId;
  }

  if (placeholder.builtin === "run:artifactRoot") {
    return context.artifactRoot ?? "";
  }

  const reference = placeholder.blockReference;
  if (!reference) {
    return placeholder.raw;
  }

  const result = context.resultsByBlock.get(reference.blockId);
  if (!result) {
    if (strict) {
      throw new Error(
        `Unresolved Ralph block reference ${placeholder.raw}: block has no result.`,
      );
    }
    return "";
  }

  if (reference.kind === "summary") {
    return result.summary;
  }

  if (reference.kind === "error") {
    return result.error ?? "";
  }

  if (reference.kind === "data") {
    const value = readRalphUtilityValuePath(result.data, reference.path);

    if (value === undefined) {
      if (strict) {
        throw new Error(
          `Unresolved Ralph data reference ${placeholder.raw}: path was not found.`,
        );
      }
      return "";
    }

    return typeof value === "string" ? value : JSON.stringify(value);
  }

  return result.markdown ?? result.summary;
};

const MAX_RALPH_TEMPLATE_RESOLUTION_PASSES = 5;

const containsRalphPlaceholder = (value: string): boolean => {
  RALPH_PLACEHOLDER_PATTERN.lastIndex = 0;
  const contains = RALPH_PLACEHOLDER_PATTERN.test(value);
  RALPH_PLACEHOLDER_PATTERN.lastIndex = 0;
  return contains;
};

const resolveTemplateText = (
  text: string,
  context: RalphResultContext,
  strict = false,
): string => {
  let resolved = text;
  const seen = new Set<string>([resolved]);

  for (let pass = 0; pass < MAX_RALPH_TEMPLATE_RESOLUTION_PASSES; pass += 1) {
    const next = resolved.replace(
      RALPH_PLACEHOLDER_PATTERN,
      (raw: string, content: string) =>
        resolvePlaceholder(
          parseRalphPlaceholderContent(raw, content.trim()),
          context,
          strict,
        ),
    );

    if (next === resolved || seen.has(next)) {
      if (strict && containsRalphPlaceholder(next)) {
        throw new Error(
          `Ralph template contains an unresolved or cyclic placeholder: ${next}.`,
        );
      }
      return next;
    }

    seen.add(next);
    resolved = next;
  }

  if (strict && containsRalphPlaceholder(resolved)) {
    throw new Error(
      `Ralph template exceeded placeholder resolution depth: ${resolved}.`,
    );
  }
  return resolved;
};

interface ResolvedRalphAttachment {
  source: RalphAttachmentReference["source"];
  value: string;
  kind?: RalphAttachmentReference["kind"];
  mediaType?: string;
}

const resolveAttachmentReference = (
  attachment: RalphAttachmentReference,
  context: RalphResultContext,
): ResolvedRalphAttachment | null => {
  const rawValue = attachment.value.trim();

  if (!rawValue) {
    return null;
  }

  const resolvedValue =
    attachment.source === "variable" && isPlainRalphVariableReference(rawValue)
      ? (context.variables[rawValue] ?? "")
      : resolveTemplateText(rawValue, context);
  const value = resolvedValue.trim();

  if (!value) {
    return null;
  }

  return {
    source: attachment.source,
    value,
    ...(attachment.kind ? { kind: attachment.kind } : {}),
    ...(attachment.mediaType ? { mediaType: attachment.mediaType } : {}),
  };
};

const getResolvedBlockAttachments = (
  block: RalphFlowBlock,
  context: RalphResultContext,
): ResolvedRalphAttachment[] => {
  return (
    block.settings?.attachments?.flatMap((attachment) => {
      const resolved = resolveAttachmentReference(attachment, context);

      return resolved ? [resolved] : [];
    }) ?? []
  );
};

const getAttachmentTaskLabel = (
  attachment: ResolvedRalphAttachment,
): "file" | "folder" | "image" | "path" => {
  if (
    attachment.kind === "image" ||
    attachment.mediaType ||
    getImageInputMediaTypeForPath(attachment.value)
  ) {
    return "image";
  }

  if (attachment.kind === "directory") {
    return "folder";
  }

  if (attachment.kind === "file") {
    return "file";
  }

  return "path";
};

const createAttachmentsTaskBlock = (
  attachments: ResolvedRalphAttachment[],
): string => {
  if (attachments.length === 0) {
    return "";
  }

  if (attachments.length === 1) {
    const [attachment] = attachments;

    if (!attachment) {
      return "";
    }

    return `Use this ${getAttachmentTaskLabel(attachment)}: "${attachment.value}"`;
  }

  return [
    "Use these paths:",
    ...attachments.map(
      (attachment) =>
        `- ${getAttachmentTaskLabel(attachment)}: "${attachment.value}"`,
    ),
  ].join("\n");
};

const resolveAttachmentPath = (path: string, workspaceRoot: string): string => {
  return isAbsolute(path) ? path : resolve(workspaceRoot, path);
};

const createImageInputsFromAttachments = async (
  attachments: ResolvedRalphAttachment[],
  config: Pick<RuntimeConfig, "model" | "provider" | "workspaceRoot">,
): Promise<AgentModelImageInput[]> => {
  const imageAttachments = attachments.filter(
    (attachment) => getAttachmentTaskLabel(attachment) === "image",
  );

  if (imageAttachments.length === 0) {
    return [];
  }

  if (!modelSupportsImageInput(config.provider, config.model)) {
    throw new Error(
      createImageInputUnsupportedModelMessage(config.provider, config.model),
    );
  }

  return await Promise.all(
    imageAttachments.map(async (attachment) => {
      const resolvedPath = resolveAttachmentPath(
        attachment.value,
        config.workspaceRoot,
      );
      const mediaType =
        getImageInputMediaTypeForPath(attachment.value) ??
        getImageInputMediaTypeForPath(resolvedPath);

      if (!mediaType) {
        throw new Error(
          `Unsupported image attachment format for \`${attachment.value}\`. Supported extensions for provider \`${config.provider}\`: ${getSupportedImageInputExtensions(
            config.provider,
            config.model,
          ).join(", ")}.`,
        );
      }

      if (
        !providerSupportsImageInputMediaType(
          config.provider,
          mediaType,
          config.model,
        )
      ) {
        throw new Error(
          `Unsupported image attachment format for \`${attachment.value}\`. Supported extensions for provider \`${config.provider}\`: ${getSupportedImageInputExtensions(
            config.provider,
            config.model,
          ).join(", ")}.`,
        );
      }

      const metadata = await stat(resolvedPath);

      if (!metadata.isFile()) {
        throw new Error(
          `Expected image attachment \`${attachment.value}\` to be a file.`,
        );
      }

      const fileContents = await readFile(resolvedPath);

      return {
        path: resolvedPath,
        mediaType,
        data: fileContents.toString("base64"),
      };
    }),
  );
};

const delay = async (
  seconds: number,
  signal: AbortSignal | undefined,
): Promise<void> => {
  if (seconds <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let abort = (): void => {};
    const handle = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, seconds * 1000);

    abort = (): void => {
      clearTimeout(handle);
      signal?.removeEventListener("abort", abort);
      reject(new Error("Ralph run stopped."));
    };

    if (signal?.aborted) {
      abort();
      return;
    }

    signal?.addEventListener("abort", abort, { once: true });
  });
};

const createBlockConfig = (
  baseConfig: RuntimeConfig,
  block: RalphFlowBlock,
  context?: RalphResultContext,
): RuntimeConfig => {
  const settings = block.settings;
  const usesProjectWorkspace =
    block.type === "PROMPT" ||
    block.type === "VALIDATOR" ||
    block.type === "DECISION" ||
    block.type === "INTERVIEW" ||
    (block.type === "UTILITY" &&
      (block.utility.type === "PROMPT_JSON" ||
        block.utility.type === "VALIDATOR_JSON"));

  return {
    ...baseConfig,
    workspaceRoot:
      settings?.workspace?.mode === "custom" && settings.workspace.path
        ? settings.workspace.path
        : usesProjectWorkspace && context?.repositoryContext
          ? context.repositoryContext.projectRoot
          : baseConfig.workspaceRoot,
    provider:
      settings?.provider && settings.provider !== "default"
        ? settings.provider
        : baseConfig.provider,
    model:
      settings?.model && settings.model !== "default"
        ? settings.model
        : baseConfig.model,
    reasoning:
      settings?.reasoning && settings.reasoning !== "default"
        ? settings.reasoning
        : baseConfig.reasoning,
    mode: "machdoch",
  };
};

const createPromptTask = (
  flow: RalphFlow,
  block: RalphPromptBlock,
  context: RalphResultContext,
): string => {
  const attachmentsBlock = createAttachmentsTaskBlock(
    getResolvedBlockAttachments(block, context),
  );

  return [
    `Ralph flow: ${flow.name}`,
    `Block: ${block.title} (${block.id})`,
    "",
    resolveTemplateText(block.prompt, context),
    ...(attachmentsBlock ? ["", attachmentsBlock] : []),
  ].join("\n");
};

const createValidatorTask = (
  flow: RalphFlow,
  block: RalphValidatorBlock,
  context: RalphResultContext,
): string => {
  const attachmentsBlock = createAttachmentsTaskBlock(
    getResolvedBlockAttachments(block, context),
  );

  return [
    `Validate Ralph flow: ${flow.name}`,
    `Validator block: ${block.title} (${block.id})`,
    "",
    resolveTemplateText(block.prompt, context),
    ...(attachmentsBlock ? ["", attachmentsBlock] : []),
  ].join("\n");
};

const createDecisionTask = (
  flow: RalphFlow,
  block: RalphDecisionBlock,
  context: RalphResultContext,
): string => {
  const attachmentsBlock = createAttachmentsTaskBlock(
    getResolvedBlockAttachments(block, context),
  );

  return [
    `Classify Ralph flow route: ${flow.name}`,
    `Decision block: ${block.title} (${block.id})`,
    "",
    `Allowed labels: ${block.labels.join(", ")}`,
    resolveTemplateText(block.prompt, context),
    ...(attachmentsBlock ? ["", attachmentsBlock] : []),
  ].join("\n");
};

interface RalphBlockTaskExecutionOptions extends TaskExecutionOptions {
  ralphProgressEvents: RalphRunRecordBlockProgressEvent[];
}

const createRalphProgressMetadata = (
  block: RalphFlowBlock,
): NonNullable<
  NonNullable<TaskExecutionProgress["timelineEvent"]>["metadata"]
> => ({
  ralphBlockId: block.id,
  ralphBlockTitle: block.title,
  ralphBlockType: block.type,
  ralphActiveBlockId: block.id,
  ralphActiveBlockTitle: block.title,
});

const withRalphProgressBlockMetadata = (
  progress: TaskExecutionProgress,
  block: RalphFlowBlock | undefined,
): TaskExecutionProgress => {
  if (!block) {
    return progress;
  }

  const blockMetadata = createRalphProgressMetadata(block);

  return {
    ...progress,
    timelineEvent: progress.timelineEvent
      ? {
          ...progress.timelineEvent,
          metadata: {
            ...blockMetadata,
            ...(progress.timelineEvent.metadata ?? {}),
          },
        }
      : {
          kind: "state",
          phase: "streaming",
          label: progress.message,
          tone: "info",
          metadata: blockMetadata,
        },
  };
};

const createRalphBlockProgressEvent = (
  progress: TaskExecutionProgress,
): RalphRunRecordBlockProgressEvent | undefined => {
  const timestamp = new Date().toISOString();

  if (progress.modelStream) {
    return {
      timestamp,
      kind: "model-stream",
      label: progress.modelStream.label,
      streamKind: progress.modelStream.kind,
      content: truncateRalphBlockProgressText(progress.modelStream.content),
      ...(progress.modelStream.complete !== undefined
        ? { complete: progress.modelStream.complete }
        : {}),
    };
  }

  if (progress.actionOutput) {
    return {
      timestamp,
      kind: "action-output",
      label: `${progress.actionOutput.toolName} ${progress.actionOutput.stream}`,
      toolName: progress.actionOutput.toolName,
      stream: progress.actionOutput.stream,
      content: truncateRalphBlockProgressText(progress.actionOutput.chunk),
    };
  }

  if (progress.timelineEvent) {
    return {
      timestamp,
      kind: "timeline",
      label: progress.timelineEvent.label,
      timelineKind: progress.timelineEvent.kind,
      phase: progress.timelineEvent.phase,
      ...(progress.timelineEvent.tone
        ? { tone: progress.timelineEvent.tone }
        : {}),
      ...(progress.timelineEvent.provider
        ? { provider: progress.timelineEvent.provider }
        : {}),
      ...(progress.timelineEvent.model
        ? { model: progress.timelineEvent.model }
        : {}),
      ...(progress.timelineEvent.toolName
        ? { toolName: progress.timelineEvent.toolName }
        : {}),
      ...(progress.timelineEvent.detail
        ? {
            detail: truncateRalphBlockProgressText(
              progress.timelineEvent.detail,
            ),
          }
        : {}),
      ...(progress.timelineEvent.tokenUsage
        ? { tokenUsage: progress.timelineEvent.tokenUsage }
        : {}),
      ...(progress.timelineEvent.metadata
        ? { metadata: progress.timelineEvent.metadata }
        : {}),
    };
  }

  if (!progress.message.trim()) {
    return undefined;
  }

  return {
    timestamp,
    kind: "message",
    label: progress.message,
    detail: truncateRalphBlockProgressText(progress.message),
  };
};

const appendRalphBlockProgressEvent = (
  progressEvents: RalphRunRecordBlockProgressEvent[],
  event: RalphRunRecordBlockProgressEvent | undefined,
): void => {
  if (!event) {
    return;
  }

  progressEvents.push(event);

  if (progressEvents.length > MAX_RALPH_BLOCK_PROGRESS_EVENTS) {
    progressEvents.splice(
      0,
      progressEvents.length - MAX_RALPH_BLOCK_PROGRESS_EVENTS,
    );
  }
};

const appendRalphBlockProgressEvents = (
  progressEvents: RalphRunRecordBlockProgressEvent[],
  events: readonly RalphRunRecordBlockProgressEvent[],
): void => {
  for (const event of events) {
    appendRalphBlockProgressEvent(progressEvents, event);
  }
};

const truncateRalphBlockProgressText = (value: string): string => {
  return value.length > MAX_RALPH_BLOCK_PROGRESS_CHARS
    ? `${value.slice(0, MAX_RALPH_BLOCK_PROGRESS_CHARS)}${RALPH_BLOCK_PROGRESS_TRUNCATION_MARKER}`
    : value;
};

const withRalphBlockProgress = (
  result: RalphBlockExecutionResult,
  progressEvents: readonly RalphRunRecordBlockProgressEvent[],
): RalphBlockExecutionResult => {
  return progressEvents.length > 0
    ? { ...result, progress: [...progressEvents] }
    : result;
};

const getRalphBlockMaxDurationMs = (
  block: RalphFlowBlock | undefined,
): number | undefined => {
  if (!block) {
    return undefined;
  }

  const timeoutSeconds = block.settings?.timeoutSeconds;

  return typeof timeoutSeconds === "number" &&
    Number.isFinite(timeoutSeconds) &&
    timeoutSeconds > 0
    ? timeoutSeconds * 1000
    : undefined;
};

const createRalphInstructionBoundaryKey = (
  providerId: ConfiguredModelProvider,
  model: string,
  reasoning: ReasoningMode,
): string => `${providerId}\u0000${model}\u0000${reasoning}`;

const getConfiguredInstructionProvider = (
  config: RuntimeConfig,
): ConfiguredModelProvider =>
  config.provider === "unconfigured" ? "openai" : config.provider;

const isModelBackedRalphBlock = (block: RalphFlowBlock): boolean =>
  block.type === "PROMPT" ||
  block.type === "VALIDATOR" ||
  block.type === "DECISION" ||
  block.type === "INTERVIEW" ||
  (block.type === "UTILITY" &&
    ["PROMPT_JSON", "VALIDATOR_JSON"].includes(block.utility.type));

const preflightRalphInstructionBoundaries = async (
  flow: RalphFlow,
  config: RuntimeConfig,
  options: RalphRunOptions,
): Promise<Record<string, RalphInstructionBoundary>> => {
  const executionConfigs = flow.blocks
    .filter(isModelBackedRalphBlock)
    .map((block) => createBlockConfig(config, block));
  if (executionConfigs.length === 0) {
    return {};
  }
  const seedConfig = executionConfigs[0] as RuntimeConfig;
  const baseProvider = getConfiguredInstructionProvider(seedConfig);
  const baseSurface = isAgentCliProvider(baseProvider) ? "cli" : "api";
  const baseResolution =
    options.resolvedInstructions ??
    (await resolveInstructionSet({
      workspaceRoot: config.workspaceRoot,
      providerId: baseProvider,
      surface: baseSurface,
      model: seedConfig.model,
      flow: {
        id: flow.id,
        ...(flow.guidance === undefined ? {} : { guidance: flow.guidance }),
      },
    }));
  const configs = executionConfigs.flatMap((blockConfig) => [
    blockConfig,
    resolveReviewModelRuntimeConfig(blockConfig),
  ]);
  const boundaries: Record<string, RalphInstructionBoundary> = {};
  for (const blockConfig of configs) {
    const providerId = getConfiguredInstructionProvider(blockConfig);
    const key = createRalphInstructionBoundaryKey(
      providerId,
      blockConfig.model,
      blockConfig.reasoning,
    );
    if (boundaries[key]) continue;
    const surface = isAgentCliProvider(providerId) ? "cli" : "api";
    const resolution =
      providerId === baseResolution.providerId &&
      surface === baseResolution.surface &&
      blockConfig.model === baseResolution.model
        ? baseResolution
        : await adaptFrozenInstructionSet(baseResolution, {
            workspaceRoot: config.workspaceRoot,
            providerId,
            surface,
            model: blockConfig.model,
          });
    const plan =
      options.instructionDeliveryPlan &&
      options.instructionDeliveryPlan.providerId === providerId &&
      options.instructionDeliveryPlan.resolutionId === resolution.resolutionId
        ? options.instructionDeliveryPlan
        : await createInstructionDeliveryPlanForRuntime(resolution, {
            workspaceRoot: config.workspaceRoot,
            reasoning: blockConfig.reasoning,
          });
    boundaries[key] = {
      resolution,
      plan,
      receipts:
        providerId === baseProvider && blockConfig.model === seedConfig.model
          ? (options.instructionDeliveryReceipts ?? [])
          : [],
    };
  }
  return boundaries;
};

const createExecutionOptions = async (
  options: RalphExecutionOptionsSource,
  config: RuntimeConfig,
  context?: RalphResultContext,
  block?: RalphFlowBlock,
  conversationContext?: TaskConversationContext,
): Promise<RalphBlockTaskExecutionOptions> => {
  const runId = context?.runId ?? options.runId;
  const fallbackContext: RalphResultContext = {
    runId: runId ?? "ralph-unscoped",
    runWorkspaceRoot: config.workspaceRoot,
    resultsByBlock: new Map(),
    runLog: [],
    variables: {},
    interviewStates: new Map(),
  };
  const attachments = block
    ? getResolvedBlockAttachments(block, context ?? fallbackContext)
    : [];
  const imageInputs =
    attachments.length > 0
      ? await createImageInputsFromAttachments(attachments, config)
      : [];
  const logger = options.logger;
  const baseOnStateChange = options.onStateChange;
  const progressEvents: RalphRunRecordBlockProgressEvent[] = [];
  const onStateChange: TaskExecutionProgressHandler | undefined =
    baseOnStateChange || logger
      ? async (progress) => {
          const enrichedProgress = withRalphProgressBlockMetadata(
            progress,
            block,
          );
          appendRalphBlockProgressEvent(
            progressEvents,
            block ? createRalphBlockProgressEvent(enrichedProgress) : undefined,
          );
          logger?.trace({
            kind: "progress",
            message: enrichedProgress.message,
            ...(block
              ? {
                  blockId: block.id,
                  blockTitle: block.title,
                  blockType: block.type,
                }
              : {}),
            provider: config.provider,
            model: config.model,
            details: enrichedProgress,
          });
          await baseOnStateChange?.(enrichedProgress);
        }
      : undefined;
  const onActionOutput: TaskExecutionOptions["onActionOutput"] =
    logger || baseOnStateChange
      ? (output: TaskActionOutput): void => {
          const safeOutput: TaskActionOutput = {
            ...output,
            chunk: capLogText(output.chunk, MAX_RALPH_SIMPLE_LOG_CHARS),
          };

          logger?.trace({
            kind: "action-output",
            message: `${safeOutput.toolName} ${safeOutput.stream}`,
            ...(block
              ? {
                  blockId: block.id,
                  blockTitle: block.title,
                  blockType: block.type,
                }
              : {}),
            provider: config.provider,
            model: config.model,
            details: safeOutput,
          });
          const progress: TaskExecutionProgress =
            withRalphProgressBlockMetadata(
              {
                task: "Ralph agent output",
                mode: config.mode,
                state: "executing",
                message: `${safeOutput.toolName} ${safeOutput.stream}`,
                executedTools: [],
                outputSections: [],
                cancellable: Boolean(options.signal),
                actionOutput: safeOutput,
                timelineEvent: {
                  kind: "output",
                  phase: "streaming",
                  label: `${safeOutput.toolName} ${safeOutput.stream}`,
                  tone: safeOutput.stream === "stderr" ? "warning" : "neutral",
                  provider: config.provider,
                  model: config.model,
                  toolName: safeOutput.toolName,
                  stream: safeOutput.stream,
                },
              },
              block,
            );

          appendRalphBlockProgressEvent(
            progressEvents,
            block ? createRalphBlockProgressEvent(progress) : undefined,
          );
          void baseOnStateChange?.(progress);
        }
      : undefined;
  const maxDurationMs = getRalphBlockMaxDurationMs(block);
  const providerId = getConfiguredInstructionProvider(config);
  const instructionBoundary =
    options.instructionBoundaries?.[
      createRalphInstructionBoundaryKey(
        providerId,
        config.model,
        config.reasoning,
      )
    ];

  return {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(runId ? { runId } : {}),
    ...(onStateChange ? { onStateChange } : {}),
    ...(onActionOutput ? { onActionOutput } : {}),
    ...(conversationContext ? { conversationContext } : {}),
    ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
    ...(imageInputs.length > 0 ? { imageInputs } : {}),
    ...(instructionBoundary
      ? {
          resolvedInstructions: instructionBoundary.resolution,
          instructionDeliveryPlan: instructionBoundary.plan,
          instructionDeliveryReceipts: instructionBoundary.receipts,
        }
      : options.resolvedInstructions
        ? {
            resolvedInstructions: options.resolvedInstructions,
            ...(options.instructionDeliveryPlan === undefined
              ? {}
              : { instructionDeliveryPlan: options.instructionDeliveryPlan }),
            ...(options.instructionDeliveryReceipts === undefined
              ? {}
              : {
                  instructionDeliveryReceipts:
                    options.instructionDeliveryReceipts,
                }),
          }
        : {}),
    ralphProgressEvents: progressEvents,
  };
};

export const createRalphTaskExecutionOptions = async (
  options: RalphExecutionOptionsSource,
  config: RuntimeConfig,
): Promise<TaskExecutionOptions> => {
  return createExecutionOptions(options, config);
};

const emitRunEvent = async (
  events: RalphRunEvent[],
  event: RalphRunEvent,
  onEvent: RalphRunOptions["onEvent"],
): Promise<void> => {
  events.push(event);
  try {
    await onEvent?.(event);
  } catch {
    // Ralph events are progress/reporting side effects. Execution must continue.
  }
};

interface RalphInputWaitStepResult {
  kind: "input-wait";
  request: RalphInputRequest;
  summary: string;
}

type RalphExecutionStepResult =
  | RalphBlockExecutionResult
  | RalphInputWaitStepResult;

const isRalphInputWaitStepResult = (
  result: RalphExecutionStepResult,
): result is RalphInputWaitStepResult => {
  return "kind" in result && result.kind === "input-wait";
};

const getBlockLogFields = (
  flow: RalphFlow,
  block: RalphFlowBlock,
  config?: RuntimeConfig,
): Pick<
  RalphSimpleLogEntry,
  | "flowId"
  | "flowName"
  | "blockId"
  | "blockTitle"
  | "blockType"
  | "provider"
  | "model"
> => ({
  flowId: flow.id,
  flowName: flow.name,
  blockId: block.id,
  blockTitle: block.title,
  blockType: block.type,
  ...(config ? { provider: config.provider, model: config.model } : {}),
});

const logBlockInput = (
  logger: RalphRunLogger | undefined,
  flow: RalphFlow,
  block: RalphFlowBlock,
  config: RuntimeConfig,
  task: string,
  attempt = 1,
): void => {
  logger?.simple({
    kind: "block-input",
    message: `Prepared input for ${block.title}.`,
    ...getBlockLogFields(flow, block, config),
    attempt,
    inputPreview: task,
  });
  logger?.trace({
    kind: "block-input",
    message: `Resolved prompt input for ${block.title}.`,
    ...getBlockLogFields(flow, block, config),
    attempt,
    details: {
      task,
      config: {
        provider: config.provider,
        model: config.model,
        mode: config.mode,
        reasoning: config.reasoning,
        workspaceRoot: config.workspaceRoot,
      },
      settings: block.settings,
    },
  });
};

const executePromptBlock = async (
  flow: RalphFlow,
  block: RalphPromptBlock,
  config: RuntimeConfig,
  customizations: CustomizationDiscoveryResult,
  context: RalphResultContext,
  options: RalphRunOptions,
): Promise<RalphBlockExecutionResult> => {
  const blockConfig = createBlockConfig(config, block, context);
  const maxIterations = block.settings?.maxIterations ?? 1;
  let result: TaskExecutionResult | undefined;
  const blockProgressEvents: RalphRunRecordBlockProgressEvent[] = [];
  const conversationContext: TaskConversationContext = {
    ...(options.conversationContext ?? { history: [] }),
    history: [...(options.conversationContext?.history ?? [])],
  };

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const task = createPromptTask(flow, block, context);
    logBlockInput(options.logger, flow, block, blockConfig, task, iteration);
    let executionOptions: RalphBlockTaskExecutionOptions | undefined;
    try {
      executionOptions = await createExecutionOptions(
        options,
        blockConfig,
        context,
        block,
        conversationContext,
      );

      result = await executeTask(task, blockConfig, customizations, {
        ...executionOptions,
        conversationContext,
        ...(maxIterations > 1
          ? { resultProtocol: { kind: "ralph-iteration" as const } }
          : {}),
      });
    } catch (error) {
      if (executionOptions) {
        appendRalphBlockProgressEvents(
          blockProgressEvents,
          executionOptions.ralphProgressEvents,
        );
      }

      return withRalphBlockProgress(
        createRalphBlockExecutionErrorResult(block, error, iteration),
        blockProgressEvents,
      );
    }

    appendRalphBlockProgressEvents(
      blockProgressEvents,
      executionOptions.ralphProgressEvents,
    );
    conversationContext.history.push({ role: "user", content: task });
    conversationContext.history.push({
      role: "assistant",
      content: getResultMarkdown(result),
    });

    if (result.status !== "executed") {
      return withRalphBlockProgress(
        createRalphPromptExecutionResult(block, result, iteration),
        blockProgressEvents,
      );
    }

    if (maxIterations === 1) {
      return withRalphBlockProgress(
        createRalphPromptExecutionResult(block, result, iteration),
        blockProgressEvents,
      );
    }

    if (result.control?.kind !== "ralph-iteration") {
      return withRalphBlockProgress(
        createRalphBlockExecutionErrorResult(
          block,
          new Error(
            "The prompt block did not return its structured iteration decision.",
          ),
          iteration,
        ),
        blockProgressEvents,
      );
    }

    if (result.control.decision === "DONE") {
      return withRalphBlockProgress(
        createRalphPromptExecutionResult(block, result, iteration),
        blockProgressEvents,
      );
    }

    if (iteration === maxIterations) {
      return withRalphBlockProgress(
        createRalphBlockExecutionErrorResult(
          block,
          new Error(
            `The prompt requested another iteration after reaching its ${maxIterations}-iteration limit.`,
          ),
          iteration,
        ),
        blockProgressEvents,
      );
    }
  }

  return withRalphBlockProgress(
    createRalphBlockExecutionErrorResult(
      block,
      new Error("The prompt iteration loop ended without a decision."),
      maxIterations,
    ),
    blockProgressEvents,
  );
};

const executeValidatorBlock = async (
  flow: RalphFlow,
  block: RalphValidatorBlock,
  config: RuntimeConfig,
  customizations: CustomizationDiscoveryResult,
  context: RalphResultContext,
  options: RalphRunOptions,
): Promise<RalphBlockExecutionResult> => {
  const blockConfig = createBlockConfig(config, block, context);
  let result: TaskExecutionResult;
  const task = createValidatorTask(flow, block, context);
  logBlockInput(options.logger, flow, block, blockConfig, task);
  let executionOptions: RalphBlockTaskExecutionOptions | undefined;

  try {
    executionOptions = await createExecutionOptions(
      options,
      blockConfig,
      context,
      block,
      options.conversationContext,
    );
    result = await executeTask(task, blockConfig, customizations, {
      ...executionOptions,
      resultProtocol: { kind: "ralph-validator" },
    });
  } catch (error) {
    return withRalphBlockProgress(
      createRalphBlockExecutionErrorResult(block, error),
      executionOptions?.ralphProgressEvents ?? [],
    );
  }

  return withRalphBlockProgress(
    createRalphValidatorExecutionResult(block, result),
    executionOptions.ralphProgressEvents,
  );
};

const executeDecisionBlock = async (
  flow: RalphFlow,
  block: RalphDecisionBlock,
  config: RuntimeConfig,
  customizations: CustomizationDiscoveryResult,
  context: RalphResultContext,
  options: RalphRunOptions,
): Promise<RalphBlockExecutionResult> => {
  const blockConfig = createBlockConfig(config, block, context);
  let result: TaskExecutionResult;
  const task = createDecisionTask(flow, block, context);
  logBlockInput(options.logger, flow, block, blockConfig, task);
  let executionOptions: RalphBlockTaskExecutionOptions | undefined;

  try {
    executionOptions = await createExecutionOptions(
      options,
      blockConfig,
      context,
      block,
      options.conversationContext,
    );
    result = await executeTask(task, blockConfig, customizations, {
      ...executionOptions,
      resultProtocol: { kind: "ralph-route", labels: [...block.labels] },
    });
  } catch (error) {
    return withRalphBlockProgress(
      createRalphBlockExecutionErrorResult(block, error),
      executionOptions?.ralphProgressEvents ?? [],
    );
  }

  return withRalphBlockProgress(
    createRalphDecisionExecutionResult(block, result),
    executionOptions.ralphProgressEvents,
  );
};

const parseContextVariableAsInputValue = (
  field: RalphInputField,
  value: string | undefined,
): RalphInputValue | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (
    field.type === "multiselect" ||
    field.type === "files" ||
    field.type === "images"
  ) {
    const trimmedValue = value.trim();

    if (trimmedValue.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmedValue) as unknown;

        if (Array.isArray(parsed)) {
          return parsed.filter(
            (entry): entry is string => typeof entry === "string",
          );
        }
      } catch {
        return value;
      }
    }
  }

  return value;
};

const getInputFieldContextValue = (
  field: RalphInputField,
  context: RalphResultContext,
): RalphInputValue | undefined => {
  for (const variableName of getRalphInputFieldVariableNames(field)) {
    if (Object.hasOwn(context.variables, variableName)) {
      return parseContextVariableAsInputValue(
        field,
        context.variables[variableName],
      );
    }
  }

  return undefined;
};

const createKnownInputValues = (
  fields: RalphInputField[],
  context: RalphResultContext,
): Record<string, RalphInputValue> => {
  return Object.fromEntries(
    fields.map((field) => [
      field.id,
      getInputFieldContextValue(field, context) ?? field.defaultValue ?? null,
    ]),
  );
};

const createAutonomousInputValue = (
  field: RalphInputField,
): RalphInputValue => {
  if (field.defaultValue !== undefined) {
    return field.defaultValue;
  }
  switch (field.type) {
    case "boolean":
      return false;
    case "number":
      return 0;
    case "multiselect":
    case "files":
    case "images":
      return [];
    case "select":
      return field.options?.[0]?.value ?? field.label;
    case "url":
      return "http://127.0.0.1";
    case "path":
    case "file":
    case "image":
      return ".";
    default:
      return field.placeholder?.trim() || field.label;
  }
};

const createAutonomousInputValues = (
  fields: RalphInputField[],
  context: RalphResultContext,
): Record<string, RalphInputValue> =>
  Object.fromEntries(
    fields.map((field) => [
      field.id,
      getInputFieldContextValue(field, context) ??
        createAutonomousInputValue(field),
    ]),
  );

const applyNormalizedInputValuesToContext = (
  context: RalphResultContext,
  fields: RalphInputField[],
  values: Record<string, RalphInputValue>,
): void => {
  applyInputValuesToContext(context, fields, values);
};

const createAskUserRequest = (
  block: RalphAskUserBlock,
  context: RalphResultContext,
): RalphInputRequest => {
  return createInputRequest(block, context, block.fields, resolveTemplateText, {
    ...(block.prompt ? { prompt: block.prompt } : {}),
    ...(block.submitLabel ? { submitLabel: block.submitLabel } : {}),
    ...(block.cancelLabel ? { cancelLabel: block.cancelLabel } : {}),
    ...(block.timeoutSeconds !== undefined
      ? { timeoutSeconds: block.timeoutSeconds }
      : {}),
  });
};

const executeAskUserBlock = (
  block: RalphAskUserBlock,
  context: RalphResultContext,
  options: RalphRunOptions,
): RalphExecutionStepResult => {
  const pendingInput = getPendingInputForBlock(block, options);
  const response = getMatchingInputResponse(block, options);
  const mode = block.mode ?? "missingOnly";
  const unattended = Boolean(context.autonomy);

  if (pendingInput && !response && !unattended) {
    return {
      kind: "input-wait",
      request: pendingInput,
      summary: `${block.title} is waiting for input.`,
    };
  }

  if (!response) {
    const request = createAskUserRequest(block, context);

    if (unattended) {
      const normalized = normalizeRalphInputResponseValues(
        request.fields,
        createAutonomousInputValues(request.fields, context),
      );
      if (normalized.errors.length === 0) {
        applyNormalizedInputValuesToContext(
          context,
          request.fields,
          normalized.values,
        );
        return {
          blockId: block.id,
          output: "SUCCESS",
          status: "completed",
          attempt: 1,
          summary: `${block.title} autonomously resolved input.`,
          data: {
            mode,
            values: normalized.values,
            skipped: normalized.skipped,
            autonomous: true,
          },
          markdown: `\`\`\`json\n${JSON.stringify(normalized.values, null, 2)}\n\`\`\``,
        };
      }
    }

    if (mode === "missingOnly") {
      const knownValues = createKnownInputValues(request.fields, context);
      const normalized = normalizeRalphInputResponseValues(
        request.fields,
        knownValues,
      );

      if (normalized.errors.length === 0) {
        applyNormalizedInputValuesToContext(
          context,
          request.fields,
          normalized.values,
        );

        return {
          blockId: block.id,
          output: "SUCCESS",
          status: "completed",
          attempt: 1,
          summary: `${block.title} already has the required input.`,
          data: {
            mode,
            values: normalized.values,
            skipped: normalized.skipped,
          },
          markdown: `\`\`\`json\n${JSON.stringify(normalized.values, null, 2)}\n\`\`\``,
        };
      }
    }

    return {
      kind: "input-wait",
      request,
      summary: `${block.title} is waiting for input.`,
    };
  }

  if (!pendingInput) {
    return {
      blockId: block.id,
      output: "ERROR",
      status: "error",
      attempt: 1,
      summary: `${block.title} received an input response but no input request is pending.`,
      error: "No pending input request matched the response.",
    };
  }

  if (isExpiredInputRequest(pendingInput)) {
    return {
      blockId: block.id,
      output: "TIMEOUT",
      status: "completed",
      attempt: 1,
      summary: `${block.title} input timed out.`,
      data: { requestId: pendingInput.id },
    };
  }

  if (response.action === "cancel") {
    return {
      blockId: block.id,
      output: "CANCELLED",
      status: "completed",
      attempt: 1,
      summary: `${block.title} input was cancelled.`,
      data: { requestId: pendingInput.id },
    };
  }

  const normalized = normalizeRalphInputResponseValues(
    pendingInput.fields,
    response.values,
  );

  if (normalized.errors.length > 0) {
    return {
      blockId: block.id,
      output: "ERROR",
      status: "error",
      attempt: 1,
      summary: `${block.title} input was invalid: ${normalized.errors.join(" ")}`,
      error: normalized.errors.join("\n"),
      data: {
        requestId: pendingInput.id,
        errors: normalized.errors,
      },
    };
  }

  applyNormalizedInputValuesToContext(
    context,
    pendingInput.fields,
    normalized.values,
  );

  return {
    blockId: block.id,
    output: "SUCCESS",
    status: "completed",
    attempt: 1,
    summary: `${block.title} input captured.`,
    data: {
      requestId: pendingInput.id,
      values: normalized.values,
      skipped: normalized.skipped,
    },
    markdown: `\`\`\`json\n${JSON.stringify(normalized.values, null, 2)}\n\`\`\``,
  };
};

const executeInterviewBlock = async (
  flow: RalphFlow,
  block: RalphInterviewBlock,
  config: RuntimeConfig,
  customizations: CustomizationDiscoveryResult,
  context: RalphResultContext,
  options: RalphRunOptions,
): Promise<RalphExecutionStepResult> => {
  const maxTurns = block.maxTurns ?? 5;
  const pendingInput = getPendingInputForBlock(block, options);
  const response = getMatchingInputResponse(block, options);
  let state = context.interviewStates.get(block.id) ?? {
    turn: 0,
    transcript: [],
  };

  if (context.autonomy && !response) {
    const summary = [
      "Interview autonomously resolved without human input.",
      resolveTemplateText(block.prompt, context),
    ].join("\n\n");
    context.variables[getRalphInterviewOutputVariableName(block)] = summary;
    return {
      blockId: block.id,
      output: "DONE",
      status: "completed",
      attempt: 1,
      summary: `${block.title} autonomously skipped human interview input.`,
      data: { autonomous: true, transcript: state.transcript },
      markdown: summary,
    };
  }

  if (pendingInput && !response) {
    return {
      kind: "input-wait",
      request: pendingInput,
      summary: `${block.title} is waiting for interview answers.`,
    };
  }

  if (response && !pendingInput) {
    return {
      blockId: block.id,
      output: "ERROR",
      status: "error",
      attempt: 1,
      summary: `${block.title} received interview answers but no interview request is pending.`,
      error: "No pending interview request matched the response.",
    };
  }

  if (response && pendingInput) {
    if (isExpiredInputRequest(pendingInput)) {
      const markdown = createRalphInterviewTranscriptMarkdown(state);

      return {
        blockId: block.id,
        output: "INCOMPLETE",
        status: "completed",
        attempt: 1,
        summary: `${block.title} interview timed out before completion.`,
        data: { requestId: pendingInput.id, transcript: state.transcript },
        markdown,
      };
    }

    if (response.action === "cancel") {
      const markdown = createRalphInterviewTranscriptMarkdown(state);

      return {
        blockId: block.id,
        output: "CANCELLED",
        status: "completed",
        attempt: 1,
        summary: `${block.title} interview was cancelled.`,
        data: { requestId: pendingInput.id, transcript: state.transcript },
        markdown,
      };
    }

    const normalized = normalizeRalphInputResponseValues(
      pendingInput.fields,
      response.values,
    );

    if (normalized.errors.length > 0) {
      return {
        blockId: block.id,
        output: "ERROR",
        status: "error",
        attempt: 1,
        summary: `${block.title} interview answers were invalid: ${normalized.errors.join(" ")}`,
        error: normalized.errors.join("\n"),
        data: {
          requestId: pendingInput.id,
          errors: normalized.errors,
        },
      };
    }

    state = appendRalphInterviewAnswers(state, pendingInput, normalized.values);
    context.interviewStates.set(block.id, state);
  }

  if (state.turn >= maxTurns) {
    const markdown = createRalphInterviewTranscriptMarkdown(state);
    context.variables[getRalphInterviewOutputVariableName(block)] = markdown;

    return {
      blockId: block.id,
      output: "INCOMPLETE",
      status: "completed",
      attempt: 1,
      summary: `${block.title} reached ${maxTurns} interview turn${maxTurns === 1 ? "" : "s"} without completion.`,
      data: {
        transcript: state.transcript,
        maxTurns,
      },
      markdown,
    };
  }

  const blockConfig = createBlockConfig(config, block, context);
  const task = createRalphInterviewQuestionTask({
    flow,
    block,
    goal: resolveTemplateText(block.prompt, context),
    ...(block.completionCriteria
      ? {
          completionCriteria: resolveTemplateText(
            block.completionCriteria,
            context,
          ),
        }
      : {}),
    state,
  });
  logBlockInput(options.logger, flow, block, blockConfig, task, state.turn + 1);

  let result: TaskExecutionResult;
  let executionOptions: RalphBlockTaskExecutionOptions | undefined;
  try {
    executionOptions = await createExecutionOptions(
      options,
      blockConfig,
      context,
      block,
      options.conversationContext,
    );
    result = await executeTask(
      task,
      blockConfig,
      customizations,
      executionOptions,
    );
  } catch (error) {
    return withRalphBlockProgress(
      createRalphBlockExecutionErrorResult(block, error),
      executionOptions?.ralphProgressEvents ?? [],
    );
  }

  if (result.status !== "executed") {
    return withRalphBlockProgress(
      createRalphBlockExecutionErrorResult(
        block,
        new Error(
          getResultMarkdown(result) ||
            "Interview AI question generation failed.",
        ),
      ),
      executionOptions.ralphProgressEvents,
    );
  }

  let generation: RalphInterviewGeneration;
  try {
    generation = normalizeRalphInterviewGeneration(
      extractRalphInterviewJsonObject(getResultMarkdown(result)),
      block,
    );
  } catch (error) {
    return withRalphBlockProgress(
      createRalphBlockExecutionErrorResult(block, error),
      executionOptions.ralphProgressEvents,
    );
  }

  if (generation.complete) {
    const summary =
      generation.summary ??
      (state.transcript.length > 0
        ? createRalphInterviewTranscriptMarkdown(state)
        : `${block.title} completed without additional questions.`);
    context.variables[getRalphInterviewOutputVariableName(block)] = summary;

    return withRalphBlockProgress(
      {
        blockId: block.id,
        output: "DONE",
        status: "completed",
        attempt: 1,
        result,
        summary: `${block.title} interview complete.`,
        data: {
          summary,
          transcript: state.transcript,
        },
        markdown: summary,
      },
      executionOptions.ralphProgressEvents,
    );
  }

  if (generation.fields.length === 0) {
    generation = {
      complete: false,
      ...(generation.summary ? { summary: generation.summary } : {}),
      fields: [
        {
          id: "clarification",
          label:
            generation.summary ??
            "What else should be clarified before continuing?",
          type: "textarea",
          required: false,
          skippable: true,
        },
      ],
    };
  }

  const nextTurn = state.turn + 1;
  const request = createInputRequest(
    block,
    context,
    generation.fields,
    resolveTemplateText,
    {
      prompt:
        generation.summary ??
        `Answer the interview questions for ${block.title}.`,
      submitLabel: block.submitLabel ?? "Continue",
      cancelLabel: block.cancelLabel ?? "Cancel interview",
      interview: {
        turn: nextTurn,
        maxTurns,
      },
    },
  );
  state = { ...state, turn: nextTurn };
  context.interviewStates.set(block.id, state);

  return {
    kind: "input-wait",
    request,
    summary: `${block.title} generated ${generation.fields.length} interview question${generation.fields.length === 1 ? "" : "s"}.`,
  };
};

const resolveTemplateValue = (
  value: unknown,
  context: RalphResultContext,
  strict = true,
): unknown => {
  if (typeof value === "string") {
    return resolveTemplateText(value, context, strict);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolveTemplateValue(entry, context, strict));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        resolveTemplateValue(
          entry,
          context,
          key === "prompt" || key === "message" ? false : strict,
        ),
      ]),
    );
  }

  return value;
};

const resolveMcpArguments = (
  value: Record<string, unknown> | undefined,
  context: RalphResultContext,
): Record<string, unknown> => {
  const resolved = resolveTemplateValue(value ?? {}, context);

  return isRecord(resolved) ? resolved : {};
};

const resolveMcpPromptArguments = (
  value: Record<string, unknown> | undefined,
  context: RalphResultContext,
): Record<string, string> => {
  return Object.fromEntries(
    Object.entries(resolveMcpArguments(value, context)).map(([key, entry]) => [
      key,
      typeof entry === "string" ? entry : JSON.stringify(entry),
    ]),
  );
};

const formatMcpBlockResult = (value: unknown): string => {
  return truncateResultText(JSON.stringify(value, null, 2));
};

const isMcpCallError = (value: unknown): boolean => {
  return isRecord(value) && value.isError === true;
};

const createMcpErrorBlockResult = (
  block: RalphFlowBlock,
  error: unknown,
): RalphBlockExecutionResult => {
  const message = error instanceof Error ? error.message : String(error);

  return {
    blockId: block.id,
    output: "ERROR",
    status: "error",
    attempt: 1,
    summary: message,
    error: message,
  };
};

const resolveUtilityConfig = (
  utility: RalphUtilityConfig,
  context: RalphResultContext,
): RalphUtilityConfig => {
  return coerceRalphUtilityConfig(resolveTemplateValue(utility, context));
};

const formatUtilityData = (value: unknown): string => {
  return truncateResultText(JSON.stringify(value, null, 2));
};

const createUtilityResult = (
  block: RalphUtilityBlock,
  output: RalphExecutionOutput,
  summary: string,
  data?: unknown,
  status: RalphBlockExecutionResult["status"] = output === "SUCCESS"
    ? "completed"
    : "error",
): RalphBlockExecutionResult => {
  return {
    blockId: block.id,
    output,
    status,
    attempt: 1,
    ...(data !== undefined ? { data, markdown: formatUtilityData(data) } : {}),
    summary,
    ...(status === "error" ? { error: summary } : {}),
  };
};

const getUtilityTimeoutMs = (
  utility: RalphUtilityConfig,
  fallbackMs: number,
): number => {
  return utility.timeoutSeconds !== undefined
    ? Math.max(0, utility.timeoutSeconds * 1000)
    : fallbackMs;
};

const resolveUtilityPath = (
  path: string | undefined,
  workspaceRoot: string,
): string => {
  const candidate = path?.trim() || workspaceRoot;

  return isAbsolute(candidate) ? candidate : resolve(workspaceRoot, candidate);
};

const isResolvedPathInsideWorkspace = (
  path: string,
  workspaceRoot: string,
): boolean => {
  const workspacePath = resolve(normalizeLocalCommandCwd(workspaceRoot));
  const relativePath = relative(
    workspacePath,
    resolve(normalizeLocalCommandCwd(path)),
  );

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
};

const resolveWorkspaceContainedUtilityPath = (
  path: string | undefined,
  workspaceRoot: string,
): string => {
  const resolvedPath = resolveUtilityPath(path, workspaceRoot);

  if (!isResolvedPathInsideWorkspace(resolvedPath, workspaceRoot)) {
    throw new Error("Utility path must stay inside the workspace.");
  }

  return resolvedPath;
};

const resolvePathThroughExistingAncestors = async (
  path: string,
): Promise<string> => {
  const missingSegments: string[] = [];
  let currentPath = path;

  for (;;) {
    try {
      const resolvedBasePath = await realpath(currentPath);

      return missingSegments.reduce(
        (resolvedPath, segment) => resolve(resolvedPath, segment),
        resolvedBasePath,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }

      const parentPath = dirname(currentPath);
      if (parentPath === currentPath) {
        throw error;
      }

      missingSegments.unshift(basename(currentPath));
      currentPath = parentPath;
    }
  }
};

const resolveWorkspaceContainedMutationPath = async (
  path: string | undefined,
  workspaceRoot: string,
  options: { preserveRequestedPath?: boolean } = {},
): Promise<string> => {
  const resolvedPath = resolveUtilityPath(path, workspaceRoot);
  const [resolvedWorkspacePath, resolvedMutationPath] = await Promise.all([
    realpath(normalizeLocalCommandCwd(workspaceRoot)),
    resolvePathThroughExistingAncestors(normalizeLocalCommandCwd(resolvedPath)),
  ]);

  if (
    !isResolvedPathInsideWorkspace(resolvedMutationPath, resolvedWorkspacePath)
  ) {
    throw new Error("Utility path must stay inside the workspace.");
  }

  return options.preserveRequestedPath ? resolvedPath : resolvedMutationPath;
};

const delayWithBackoff = async (
  intervalSeconds: number,
  backoffMultiplier: number | undefined,
  attempt: number,
  signal: AbortSignal | undefined,
): Promise<void> => {
  const multiplier =
    backoffMultiplier && backoffMultiplier > 0
      ? backoffMultiplier ** Math.max(0, attempt - 1)
      : 1;

  await delay(intervalSeconds * multiplier, signal);
};

const readLimitedResponseText = async (
  response: Response,
  limitBytes: number,
): Promise<string> => {
  const reader = response.body?.getReader();

  if (!reader) {
    return "";
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    if (!value) {
      continue;
    }

    totalBytes += value.byteLength;
    if (totalBytes > limitBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Response exceeded ${limitBytes} bytes.`);
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
};

interface RalphHttpUtilityResponseData {
  url: string;
  method: string;
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: unknown;
  bodyText: string;
  outputPath?: string;
}

const executeUtilityHttpRequest = async (
  utility: RalphUtilityConfig,
  context: RalphResultContext,
  workspaceRoot: string,
  signal: AbortSignal | undefined,
): Promise<RalphHttpUtilityResponseData> => {
  const url = utility.url?.trim();

  if (!url) {
    throw new Error("HTTP utility requires url.");
  }

  const parsedUrl = new URL(url);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("HTTP utility only supports HTTP and HTTPS URLs.");
  }

  const abortController = new AbortController();
  const timeoutMs = getUtilityTimeoutMs(utility, 30_000);
  const timeoutHandle =
    timeoutMs > 0
      ? setTimeout(() => {
          abortController.abort();
        }, timeoutMs)
      : undefined;
  const abortFromRun = (): void => {
    abortController.abort();
  };

  signal?.addEventListener("abort", abortFromRun, { once: true });

  try {
    const response = await fetch(parsedUrl, {
      method: utility.method?.trim() || "GET",
      ...(utility.headers ? { headers: utility.headers } : {}),
      ...(utility.body !== undefined ? { body: utility.body } : {}),
      signal: abortController.signal,
    });
    const bodyText = await readLimitedResponseText(
      response,
      utility.maxOutputBytes ?? DEFAULT_RALPH_UTILITY_RESPONSE_LIMIT_BYTES,
    );
    const outputPath = utility.outputPath?.trim()
      ? resolveUtilityPath(utility.outputPath, workspaceRoot)
      : undefined;

    if (outputPath) {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, bodyText, "utf8");
    }

    return {
      url: parsedUrl.toString(),
      method: utility.method?.trim() || "GET",
      status: response.status,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries()),
      body: parseRalphUtilityJsonValue(bodyText),
      bodyText,
      ...(outputPath ? { outputPath } : {}),
    };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    signal?.removeEventListener("abort", abortFromRun);
  }
};

const executeWaitUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  context: RalphResultContext,
  options: RalphRunOptions,
): Promise<RalphBlockExecutionResult> => {
  const mode = utility.mode ?? "delay";

  if (mode === "delay") {
    await delay(utility.delaySeconds ?? 0, options.signal);
    return createUtilityResult(block, "SUCCESS", `${block.title} waited.`, {
      mode,
      delaySeconds: utility.delaySeconds ?? 0,
    });
  }

  if (mode === "until-time") {
    const runAt = new Date(utility.runAt ?? "");
    const delayMs = Math.max(0, runAt.getTime() - Date.now());

    if (Number.isFinite(delayMs)) {
      await delay(delayMs / 1000, options.signal);
    }

    return createUtilityResult(
      block,
      "SUCCESS",
      `${block.title} reached runAt.`,
      {
        mode,
        runAt: utility.runAt,
      },
    );
  }

  const condition = utility.condition;
  if (!condition) {
    return createUtilityResult(
      block,
      "SUCCESS",
      `${block.title} has no condition.`,
      {
        mode,
      },
    );
  }

  let attempt = 1;
  while (true) {
    if (evaluateRalphUtilityCondition(condition, context)) {
      return createUtilityResult(
        block,
        "SUCCESS",
        `${block.title} condition matched.`,
        {
          mode,
          attempts: attempt,
        },
      );
    }

    await delayWithBackoff(
      utility.intervalSeconds ?? DEFAULT_RALPH_UTILITY_POLL_INTERVAL_SECONDS,
      utility.backoffMultiplier,
      attempt,
      options.signal,
    );
    attempt += 1;
  }
};

const executeFetchUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  context: RalphResultContext,
  config: RuntimeConfig,
  options: RalphRunOptions,
): Promise<RalphBlockExecutionResult> => {
  try {
    const data = await executeUtilityHttpRequest(
      utility,
      context,
      config.workspaceRoot,
      options.signal,
    );
    const output = data.ok ? "SUCCESS" : "HTTP_ERROR";

    return createUtilityResult(
      block,
      output,
      `${block.title} fetched ${data.status}.`,
      data,
      output === "SUCCESS" ? "completed" : "error",
    );
  } catch (error) {
    const output =
      error instanceof Error && error.name === "AbortError"
        ? "TIMEOUT"
        : "ERROR";
    const summary = error instanceof Error ? error.message : String(error);

    return createUtilityResult(block, output, summary);
  }
};

const executePollUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  context: RalphResultContext,
  config: RuntimeConfig,
  options: RalphRunOptions,
): Promise<RalphBlockExecutionResult> => {
  const condition = utility.condition;

  if (!condition) {
    return createUtilityResult(
      block,
      "ERROR",
      "POLL utility requires condition.",
    );
  }

  let attempt = 1;
  let lastData: unknown;
  const maxAttempts =
    typeof utility.maxAttempts === "number"
      ? utility.maxAttempts
      : utility.maxAttempts === null
        ? null
        : undefined;

  while (
    maxAttempts === null ||
    maxAttempts === undefined ||
    attempt <= maxAttempts
  ) {
    try {
      const data = await executeUtilityHttpRequest(
        utility,
        context,
        config.workspaceRoot,
        options.signal,
      );
      lastData = data;

      if (evaluateRalphUtilityCondition(condition, context, data)) {
        return createUtilityResult(
          block,
          "SUCCESS",
          `${block.title} matched after ${attempt} attempt(s).`,
          data,
        );
      }
    } catch (error) {
      if (!utility.ignoreErrors) {
        const summary = error instanceof Error ? error.message : String(error);
        return createUtilityResult(block, "ERROR", summary, lastData);
      }
    }

    await delayWithBackoff(
      utility.intervalSeconds ?? DEFAULT_RALPH_UTILITY_POLL_INTERVAL_SECONDS,
      utility.backoffMultiplier,
      attempt,
      options.signal,
    );
    attempt += 1;
  }

  return createUtilityResult(
    block,
    "TIMEOUT",
    `${block.title} did not match after ${maxAttempts} attempt(s).`,
    lastData,
  );
};

let cachedWindowsShellExecutable: string | undefined;

const resolveWindowsShellExecutable = (): string => {
  if (cachedWindowsShellExecutable !== undefined) {
    return cachedWindowsShellExecutable;
  }

  const result = spawnSync(
    "pwsh.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$PSVersionTable.PSVersion.Major",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );

  cachedWindowsShellExecutable =
    result.error || result.status !== 0 ? "powershell.exe" : "pwsh.exe";

  return cachedWindowsShellExecutable;
};

const getShellInvocation = (
  command: string,
): { executable: string; args: string[] } => {
  return process.platform === "win32"
    ? {
        executable: resolveWindowsShellExecutable(),
        args: ["-NoProfile", "-NonInteractive", "-Command", command],
      }
    : { executable: "/bin/sh", args: ["-lc", command] };
};

const WINDOWS_POWERSHELL_FAILURE_GUARD =
  "if (-not $? -or ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0)) { if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1 }";

const createPowerShellFailFastCommand = (commands: string[]): string => {
  return commands
    .map((command) => `${command}; ${WINDOWS_POWERSHELL_FAILURE_GUARD}`)
    .join("; ");
};

const createVerificationCommand = (commands: string[]): string => {
  const uniqueCommands = commands.filter(
    (command, index, all) => all.indexOf(command) === index,
  );

  if (process.platform !== "win32") {
    return uniqueCommands.join(" && ");
  }

  return createPowerShellFailFastCommand(uniqueCommands);
};

const attachRalphVerificationEvidence = (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  context: RalphResultContext | undefined,
  observation: RalphVerificationObservation,
  data: Record<string, unknown>,
): RalphBlockExecutionResult | undefined => {
  if (!utility.verificationRole) {
    return undefined;
  }
  const verification: Record<string, unknown> = {
    role: utility.verificationRole,
    planId: utility.verificationPlanId ?? block.id,
    observation,
  };
  data.verification = verification;
  if (utility.verificationRole !== "candidate") {
    return undefined;
  }

  const baselineBlockId = utility.baselineBlockId;
  const baselineResult = baselineBlockId
    ? context?.resultsByBlock.get(baselineBlockId)
    : undefined;
  const baselineVerification = isRecord(baselineResult?.data)
    ? baselineResult.data.verification
    : undefined;
  const baselineObservation =
    isRecord(baselineVerification) && isRecord(baselineVerification.observation)
      ? (baselineVerification.observation as unknown as RalphVerificationObservation)
      : undefined;

  if (!baselineObservation) {
    verification.comparison = {
      disposition: "INCONCLUSIVE",
      reason: `No frozen baseline observation was available from \`${baselineBlockId ?? "an unspecified block"}\`.`,
      candidateFingerprint: observation.outputFingerprint,
    };
    return createUtilityResult(
      block,
      "INCONCLUSIVE",
      `${block.title} could not be compared with its frozen baseline.`,
      data,
    );
  }

  const baselinePlanId =
    isRecord(baselineVerification) &&
    typeof baselineVerification.planId === "string"
      ? baselineVerification.planId
      : undefined;
  const candidatePlanId = utility.verificationPlanId ?? block.id;
  const comparison =
    baselinePlanId && baselinePlanId !== candidatePlanId
      ? {
          disposition: "INCONCLUSIVE" as const,
          reason: "Baseline and candidate used different verification plans.",
          baselineFingerprint: baselineObservation.outputFingerprint,
          candidateFingerprint: observation.outputFingerprint,
        }
      : compareRalphVerificationObservations(baselineObservation, observation);
  verification.comparison = comparison;
  const output =
    comparison.disposition === "REGRESSION"
      ? "FAILED"
      : comparison.disposition === "INCONCLUSIVE" ||
          comparison.disposition === "ENVIRONMENT_UNAVAILABLE" ||
          comparison.disposition === "TIMEOUT"
        ? "INCONCLUSIVE"
        : "SUCCESS";
  return createUtilityResult(
    block,
    output,
    `${block.title}: ${comparison.reason}`,
    data,
    output === "FAILED" ? "error" : "completed",
  );
};

const executeCommandUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  checkMode: boolean,
  signal?: AbortSignal,
  operationId?: string,
  context?: RalphResultContext,
): Promise<RalphBlockExecutionResult> => {
  const command = utility.command?.trim() || utility.fallbackCommand?.trim();

  if (!command) {
    return createUtilityResult(
      block,
      "ERROR",
      "Command utility requires command.",
    );
  }

  const invocation = getShellInvocation(command);
  const cwd = normalizeLocalCommandCwd(
    resolveUtilityPath(utility.cwd, config.workspaceRoot),
  );
  const acceptedExitCodes = checkMode
    ? Array.from({ length: 256 }, (_, index) => index)
    : (utility.acceptedExitCodes ?? [0]);

  try {
    const result = await executeLocalCommand(
      invocation.executable,
      invocation.args,
      {
        cwd,
        timeoutMs: getUtilityTimeoutMs(
          utility,
          checkMode
            ? DEFAULT_RALPH_UTILITY_CHECK_TIMEOUT_MS
            : DEFAULT_RALPH_UTILITY_COMMAND_TIMEOUT_MS,
        ),
        maxBufferBytes:
          utility.maxOutputBytes ?? DEFAULT_RALPH_UTILITY_RESPONSE_LIMIT_BYTES,
        acceptedExitCodes,
        ...(signal ? { signal } : {}),
        ...(utility.env || operationId
          ? {
              env: {
                ...process.env,
                ...(utility.env ?? {}),
                ...(operationId ? { RALPH_OPERATION_ID: operationId } : {}),
              },
            }
          : {}),
      },
    );
    const data: Record<string, unknown> = {
      command,
      cwd,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };

    if (checkMode && utility.verificationRole) {
      const observation = createRalphVerificationObservation({
        command,
        cwd,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      const verificationResult = attachRalphVerificationEvidence(
        block,
        utility,
        context,
        observation,
        data,
      );
      if (verificationResult) {
        return verificationResult;
      }
    }

    if (checkMode && result.exitCode !== 0) {
      return createUtilityResult(
        block,
        "FAILED",
        `${block.title} failed with exit code ${result.exitCode}.`,
        data,
      );
    }

    return createUtilityResult(
      block,
      "SUCCESS",
      `${block.title} completed.`,
      data,
    );
  } catch (error) {
    const details = getLocalCommandErrorDetails(error);
    const summary = formatLocalCommandError(`${block.title} failed.`, error);
    const data: Record<string, unknown> = {
      command,
      cwd,
      ...details,
    };
    if (checkMode && utility.verificationRole) {
      const observation = createRalphVerificationObservation({
        command,
        cwd,
        exitCode: details.exitCode ?? null,
        stdout: details.stdout,
        stderr: details.stderr,
        executionError: summary,
        ...(details.timedOut ? { timedOut: true } : {}),
      });
      const verificationResult = attachRalphVerificationEvidence(
        block,
        utility,
        context,
        observation,
        data,
      );
      if (verificationResult) {
        return verificationResult;
      }
      return createUtilityResult(block, "INCONCLUSIVE", summary, data);
    }
    return createUtilityResult(block, "ERROR", summary, data);
  }
};

const isFileNotFoundError = (error: unknown): boolean => {
  return isRecord(error) && error.code === "ENOENT";
};

const executeConditionUtilityBlock = (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  context: RalphResultContext,
): RalphBlockExecutionResult => {
  const condition = utility.condition;

  if (!condition) {
    return createUtilityResult(
      block,
      "ERROR",
      "Condition utility requires condition.",
    );
  }

  try {
    const matched = evaluateRalphUtilityCondition(condition, context);
    const output = matched ? "MATCH" : "NO_MATCH";

    return createUtilityResult(
      block,
      output,
      matched
        ? `${block.title} condition matched.`
        : `${block.title} condition did not match.`,
      { matched },
      "completed",
    );
  } catch (error) {
    return createRalphBlockExecutionErrorResult(block, error);
  }
};

const executeReadFileUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
): Promise<RalphBlockExecutionResult> => {
  try {
    const path = resolveUtilityPath(utility.path, config.workspaceRoot);
    const content = await readFile(path, utility.encoding ?? "utf8");

    return createUtilityResult(
      block,
      "SUCCESS",
      `${block.title} read ${path}.`,
      {
        path,
        content,
      },
    );
  } catch (error) {
    return createRalphBlockExecutionErrorResult(block, error);
  }
};

const executeWriteFileUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
): Promise<RalphBlockExecutionResult> => {
  try {
    const path = resolveUtilityPath(utility.path, config.workspaceRoot);
    const content = utility.content ?? "";
    const encoding = utility.encoding ?? "utf8";

    if (utility.append) {
      await appendFileDurably(path, content, encoding);
    } else {
      await writeFileAtomically(path, content, encoding);
    }

    return createUtilityResult(
      block,
      "SUCCESS",
      `${block.title} wrote ${path}.`,
      {
        path,
        bytes: Buffer.byteLength(content, encoding),
        append: utility.append === true,
      },
    );
  } catch (error) {
    return createRalphBlockExecutionErrorResult(block, error);
  }
};

const parseStrictJsonText = (text: string): unknown => {
  return JSON.parse(text) as unknown;
};

const readJsonFile = async (path: string): Promise<unknown> => {
  return parseStrictJsonText(await readFile(path, "utf8"));
};

const stringifyJson = (value: unknown): string => {
  return `${JSON.stringify(value, null, 2)}\n`;
};

const getWritableJsonInput = (
  utility: RalphUtilityConfig,
  context: RalphResultContext,
): unknown => {
  if (utility.input !== undefined) {
    return parseStrictJsonText(utility.input);
  }

  if (utility.content !== undefined) {
    return parseStrictJsonText(utility.content);
  }

  return context.lastResult?.data ?? {};
};

const validateUtilityJsonValue = (
  value: unknown,
  schema: unknown,
): JsonSchemaValidationResult => {
  return schema === undefined
    ? { valid: true, errors: [] }
    : validateJsonAgainstSchema(value, schema);
};

const writeUtilityJsonOutput = async (
  path: string,
  value: unknown,
): Promise<void> => {
  await writeFileAtomically(path, stringifyJson(value), "utf8");
};

const deepMergeJson = (base: unknown, patch: unknown): unknown => {
  if (!isRecord(base) || !isRecord(patch)) {
    return patch;
  }

  const merged: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(patch)) {
    merged[key] = Object.hasOwn(base, key)
      ? deepMergeJson(base[key], value)
      : value;
  }

  return merged;
};

const executeReadJsonUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
): Promise<RalphBlockExecutionResult> => {
  const rawPath = utility.path?.trim();

  if (!rawPath) {
    return createUtilityResult(
      block,
      "ERROR",
      "Read JSON utility requires path.",
    );
  }

  const path = resolveUtilityPath(rawPath, config.workspaceRoot);

  try {
    const json = await readJsonFile(path);
    const validation = validateUtilityJsonValue(json, utility.schema);

    return createUtilityResult(
      block,
      validation.valid ? "SUCCESS" : "INVALID",
      validation.valid
        ? `${block.title} read JSON from ${path}.`
        : `${block.title} read invalid JSON schema data from ${path}.`,
      { path, json, validation },
      validation.valid ? "completed" : "error",
    );
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return createUtilityResult(
        block,
        "NOT_FOUND",
        `${block.title} did not find ${path}.`,
        { path },
        "completed",
      );
    }

    if (error instanceof SyntaxError) {
      return createUtilityResult(
        block,
        "INVALID",
        `${block.title} could not parse JSON at ${path}.`,
        { path, error: error.message },
      );
    }

    return createRalphBlockExecutionErrorResult(block, error);
  }
};

const executeWriteJsonUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  context: RalphResultContext,
): Promise<RalphBlockExecutionResult> => {
  const rawPath = utility.path?.trim();

  if (!rawPath) {
    return createUtilityResult(
      block,
      "ERROR",
      "Write JSON utility requires path.",
    );
  }

  let mutationLock: RalphFileMutationLock | undefined;
  try {
    const path = await resolveWorkspaceContainedMutationPath(
      rawPath,
      config.workspaceRoot,
    );
    mutationLock = await acquireRalphFileMutationLock(path, context.runId);
    const json = getWritableJsonInput(utility, context);
    const validation = validateUtilityJsonValue(json, utility.schema);

    if (!validation.valid) {
      return createUtilityResult(
        block,
        "INVALID",
        `${block.title} JSON did not match schema.`,
        { path, json, validation },
      );
    }

    await writeUtilityJsonOutput(path, json);

    return createUtilityResult(
      block,
      "SUCCESS",
      `${block.title} wrote ${path}.`,
      {
        path,
        json,
        validation,
      },
    );
  } catch (error) {
    return createRalphBlockExecutionErrorResult(block, error);
  } finally {
    await mutationLock?.release();
  }
};

const executePatchJsonUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  context: RalphResultContext,
): Promise<RalphBlockExecutionResult> => {
  const rawPath = utility.path?.trim();

  if (!rawPath) {
    return createUtilityResult(
      block,
      "ERROR",
      "Patch JSON utility requires path.",
    );
  }

  const path = await resolveWorkspaceContainedMutationPath(
    rawPath,
    config.workspaceRoot,
  );

  try {
    const current = await readJsonFile(path);
    const patch = getWritableJsonInput(utility, context);
    const json =
      utility.jsonPatchMode === "replace"
        ? patch
        : deepMergeJson(current, patch);
    const validation = validateUtilityJsonValue(json, utility.schema);

    if (!validation.valid) {
      return createUtilityResult(
        block,
        "INVALID",
        `${block.title} patched JSON did not match schema.`,
        { path, current, patch, json, validation },
      );
    }

    await writeUtilityJsonOutput(path, json);

    return createUtilityResult(
      block,
      "SUCCESS",
      `${block.title} patched ${path}.`,
      {
        path,
        mode: utility.jsonPatchMode ?? "merge",
        patch,
        json,
        validation,
      },
    );
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return createUtilityResult(
        block,
        "NOT_FOUND",
        `${block.title} did not find ${path}.`,
        { path },
        "completed",
      );
    }

    if (error instanceof SyntaxError) {
      return createUtilityResult(
        block,
        "INVALID",
        `${block.title} could not parse JSON at ${path}.`,
        { path, error: error.message },
      );
    }

    return createRalphBlockExecutionErrorResult(block, error);
  }
};

const executeAppendJsonlUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  context: RalphResultContext,
): Promise<RalphBlockExecutionResult> => {
  const rawPath = utility.path?.trim();

  if (!rawPath) {
    return createUtilityResult(
      block,
      "ERROR",
      "Append JSONL utility requires path.",
    );
  }

  let mutationLock: RalphFileMutationLock | undefined;
  try {
    const path = await resolveWorkspaceContainedMutationPath(
      rawPath,
      config.workspaceRoot,
    );
    mutationLock = await acquireRalphFileMutationLock(path, context.runId);
    const json = getWritableJsonInput(utility, context);
    const validation = validateUtilityJsonValue(json, utility.schema);

    if (!validation.valid) {
      return createUtilityResult(
        block,
        "INVALID",
        `${block.title} JSONL entry did not match schema.`,
        { path, json, validation },
      );
    }

    const line = `${JSON.stringify(json)}\n`;
    const lineBytes = Buffer.from(line, "utf8");
    const lineSha256 = createHash("sha256").update(lineBytes).digest("hex");
    const operationId = context.currentOperationId;
    const ledgerPath = `${path}.ralph-operations.json`;
    let operations: Record<string, Record<string, unknown>> = {};
    if (operationId) {
      let storedLedger: unknown;
      try {
        storedLedger = await readJsonFile(ledgerPath);
      } catch (error) {
        if (!isFileNotFoundError(error)) {
          throw new Error(
            `Could not read APPEND_JSONL operation ledger at ${ledgerPath}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }
      if (storedLedger !== undefined) {
        if (!isRecord(storedLedger) || !isRecord(storedLedger.operations)) {
          throw new Error(
            `Invalid APPEND_JSONL operation ledger at ${ledgerPath}.`,
          );
        }
        const operationEntries = Object.entries(storedLedger.operations);
        if (operationEntries.some(([, entry]) => !isRecord(entry))) {
          throw new Error(
            `Invalid APPEND_JSONL operation entry at ${ledgerPath}.`,
          );
        }
        operations = Object.fromEntries(operationEntries) as Record<
          string,
          Record<string, unknown>
        >;
      }
      const prior = operations[operationId];
      if (prior?.state === "completed") {
        return createUtilityResult(
          block,
          "SUCCESS",
          `${block.title} reconciled ${path}.`,
          {
            path,
            json,
            validation,
            operationId,
            reconciled: true,
            ...(utility.workOutcome
              ? { workOutcome: utility.workOutcome }
              : {}),
          },
        );
      }
      if (prior && prior.state !== "started" && prior.state !== "completed") {
        return createUtilityResult(
          block,
          "ERROR",
          `${block.title} found an indeterminate operation-ledger state for ${operationId}.`,
          {
            path,
            operationId,
            reconciliation: "indeterminate",
            ledgerState: prior.state,
          },
        );
      }
      if (prior?.state === "started") {
        const start = prior.priorSize;
        if (!Number.isSafeInteger(start) || (start as number) < 0) {
          return createUtilityResult(
            block,
            "ERROR",
            `${block.title} found an invalid prior byte offset for ${operationId}.`,
            { path, operationId, reconciliation: "indeterminate" },
          );
        }
        if (
          (typeof prior.lineLength === "number" &&
            prior.lineLength !== lineBytes.length) ||
          (typeof prior.lineSha256 === "string" &&
            prior.lineSha256 !== lineSha256)
        ) {
          return createUtilityResult(
            block,
            "ERROR",
            `${block.title} cannot reconcile ${operationId} because its intended JSONL entry changed.`,
            { path, operationId, reconciliation: "indeterminate" },
          );
        }
        let content: Buffer;
        let pathExists = true;
        try {
          content = await readFile(path);
        } catch (error) {
          if (!isFileNotFoundError(error) || start !== 0) {
            throw new Error(
              `Could not reconcile APPEND_JSONL target at ${path}: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            );
          }
          content = Buffer.alloc(0);
          pathExists = false;
        }
        if (content.length < (start as number)) {
          return createUtilityResult(
            block,
            "ERROR",
            `${block.title} cannot reconcile ${operationId} because ${path} is shorter than its recorded byte offset.`,
            { path, operationId, reconciliation: "indeterminate" },
          );
        }
        const tail = content.subarray(start as number);
        if (tail.length === lineBytes.length && tail.equals(lineBytes)) {
          operations[operationId] = {
            ...prior,
            state: "completed",
            completedAt: createLogTimestamp(),
          };
          await writeJsonAtomically(ledgerPath, {
            operations: Object.fromEntries(
              Object.entries(operations).slice(-2_000),
            ),
          });
          return createUtilityResult(
            block,
            "SUCCESS",
            `${block.title} reconciled ${path}.`,
            {
              path,
              json,
              validation,
              operationId,
              reconciled: true,
              ...(utility.workOutcome
                ? { workOutcome: utility.workOutcome }
                : {}),
            },
          );
        }
        const isExactPrefix =
          tail.length < lineBytes.length &&
          tail.equals(lineBytes.subarray(0, tail.length));
        if (!isExactPrefix) {
          return createUtilityResult(
            block,
            "ERROR",
            `${block.title} found bytes that do not match the intended entry for ${operationId}; refusing to append again.`,
            {
              path,
              operationId,
              reconciliation: "indeterminate",
              priorSize: start,
              tailLength: tail.length,
            },
          );
        }
        if (pathExists) {
          await truncate(path, start as number);
        }
      }
      if (!prior) {
        let priorSize = 0;
        try {
          priorSize = (await stat(path)).size;
        } catch (error) {
          if (!isFileNotFoundError(error)) {
            throw error;
          }
        }
        operations[operationId] = {
          state: "started",
          priorSize,
          lineLength: lineBytes.length,
          lineSha256,
          startedAt: createLogTimestamp(),
        };
        await writeJsonAtomically(ledgerPath, {
          operations: Object.fromEntries(
            Object.entries(operations).slice(-2_000),
          ),
        });
      }
    }

    await appendFileDurably(path, line);
    if (operationId) {
      operations[operationId] = {
        ...operations[operationId],
        state: "completed",
        completedAt: createLogTimestamp(),
      };
      await writeJsonAtomically(ledgerPath, {
        operations: Object.fromEntries(
          Object.entries(operations).slice(-2_000),
        ),
      });
    }

    return createUtilityResult(
      block,
      "SUCCESS",
      `${block.title} appended ${path}.`,
      {
        path,
        json,
        validation,
        ...(operationId ? { operationId } : {}),
        ...(utility.workOutcome ? { workOutcome: utility.workOutcome } : {}),
      },
    );
  } catch (error) {
    return createRalphBlockExecutionErrorResult(block, error);
  } finally {
    await mutationLock?.release();
  }
};

interface JsonlEntry {
  line: number;
  value: unknown;
}

const readJsonlEntries = async (
  path: string,
): Promise<{
  entries: JsonlEntry[];
  invalid: Array<{ line: number; error: string }>;
}> => {
  const content = await readFile(path, "utf8");
  const entries: JsonlEntry[] = [];
  const invalid: Array<{ line: number; error: string }> = [];

  content.split(/\r?\n/u).forEach((line, index) => {
    const trimmed = line.trim();

    if (!trimmed) {
      return;
    }

    try {
      entries.push({ line: index + 1, value: parseStrictJsonText(trimmed) });
    } catch (error) {
      invalid.push({
        line: index + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return { entries, invalid };
};

const validateJsonlEntries = (
  entries: readonly JsonlEntry[],
  schema: unknown,
): JsonSchemaValidationResult => {
  const errors = entries.flatMap((entry) =>
    validateUtilityJsonValue(entry.value, schema).errors.map(
      (error) => `line ${entry.line}: ${error}`,
    ),
  );

  return { valid: errors.length === 0, errors };
};

const executeReadJsonlUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
): Promise<RalphBlockExecutionResult> => {
  const rawPath = utility.path?.trim();

  if (!rawPath) {
    return createUtilityResult(
      block,
      "ERROR",
      "Read JSONL utility requires path.",
    );
  }

  const path = resolveUtilityPath(rawPath, config.workspaceRoot);

  try {
    const { entries, invalid } = await readJsonlEntries(path);

    if (invalid.length > 0) {
      return createUtilityResult(
        block,
        "INVALID",
        `${block.title} found invalid JSONL at ${path}.`,
        { path, invalid },
      );
    }

    const validation = validateJsonlEntries(entries, utility.schema);
    if (!validation.valid) {
      return createUtilityResult(
        block,
        "INVALID",
        `${block.title} read JSONL entries that failed schema validation.`,
        { path, validation },
      );
    }

    const limit =
      typeof utility.maxResults === "number" && utility.maxResults >= 0
        ? utility.maxResults
        : entries.length;
    const selectedEntries = entries.slice(0, limit);
    const output = selectedEntries.length > 0 ? "SUCCESS" : "EMPTY";

    return createUtilityResult(
      block,
      output,
      selectedEntries.length > 0
        ? `${block.title} read ${selectedEntries.length} JSONL entr${selectedEntries.length === 1 ? "y" : "ies"}.`
        : `${block.title} found no JSONL entries.`,
      {
        path,
        count: selectedEntries.length,
        totalCount: entries.length,
        entries: selectedEntries.map((entry) => entry.value),
        lineNumbers: selectedEntries.map((entry) => entry.line),
        validation,
      },
      "completed",
    );
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return createUtilityResult(
        block,
        "NOT_FOUND",
        `${block.title} did not find ${path}.`,
        { path },
        "completed",
      );
    }

    return createRalphBlockExecutionErrorResult(block, error);
  }
};

const executeQueryJsonlUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  context: RalphResultContext,
): Promise<RalphBlockExecutionResult> => {
  const rawPath = utility.path?.trim();

  if (!rawPath) {
    return createUtilityResult(
      block,
      "ERROR",
      "Query JSONL utility requires path.",
    );
  }

  const path = resolveUtilityPath(rawPath, config.workspaceRoot);

  try {
    const { entries, invalid } = await readJsonlEntries(path);

    if (invalid.length > 0) {
      return createUtilityResult(
        block,
        "INVALID",
        `${block.title} found invalid JSONL at ${path}.`,
        { path, invalid },
      );
    }

    const validation = validateJsonlEntries(entries, utility.schema);
    if (!validation.valid) {
      return createUtilityResult(
        block,
        "INVALID",
        `${block.title} read JSONL entries that failed schema validation.`,
        { path, validation },
      );
    }

    const matchedEntries = utility.condition
      ? entries.filter((entry) =>
          evaluateRalphUtilityCondition(
            utility.condition!,
            context,
            entry.value,
          ),
        )
      : entries;
    const limit =
      typeof utility.maxResults === "number" && utility.maxResults >= 0
        ? utility.maxResults
        : matchedEntries.length;
    const orderedEntries =
      utility.order === "newest"
        ? [...matchedEntries].reverse()
        : matchedEntries;
    const selectedEntries = orderedEntries.slice(0, limit);
    const output = selectedEntries.length > 0 ? "SUCCESS" : "EMPTY";

    return createUtilityResult(
      block,
      output,
      selectedEntries.length > 0
        ? `${block.title} matched ${selectedEntries.length} JSONL entr${selectedEntries.length === 1 ? "y" : "ies"}.`
        : `${block.title} matched no JSONL entries.`,
      {
        path,
        count: selectedEntries.length,
        totalCount: entries.length,
        entries: selectedEntries.map((entry) => entry.value),
        lineNumbers: selectedEntries.map((entry) => entry.line),
        validation,
      },
      "completed",
    );
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return createUtilityResult(
        block,
        "NOT_FOUND",
        `${block.title} did not find ${path}.`,
        { path },
        "completed",
      );
    }

    return createRalphBlockExecutionErrorResult(block, error);
  }
};

const readMutableJsonPath = (
  value: unknown,
  path: string | undefined,
): unknown => {
  return readRalphUtilityValuePath(value, path?.trim() || "tasks");
};

const getJsonTaskArray = (
  json: unknown,
  jsonPath: string | undefined,
): { tasks: Record<string, unknown>[]; normalizedPath: string } | undefined => {
  const normalizedPath = jsonPath?.trim() || "tasks";
  const value =
    normalizedPath === "$" || normalizedPath === "."
      ? json
      : readMutableJsonPath(json, normalizedPath);

  if (!Array.isArray(value)) {
    return undefined;
  }

  const tasks = value.filter(isRecord);

  return tasks.length === value.length ? { tasks, normalizedPath } : undefined;
};

const getJsonTaskStatus = (
  task: Record<string, unknown>,
): ReturnType<typeof parseRalphWorkItemState> => {
  return parseRalphWorkItemState(task.status);
};

const getJsonTaskId = (task: Record<string, unknown>): string | undefined => {
  return typeof task.id === "string" && task.id.trim()
    ? task.id.trim()
    : undefined;
};

const getJsonTaskContractError = (
  tasks: readonly Record<string, unknown>[],
): string | undefined => {
  const taskIds = new Set<string>();

  for (const [index, task] of tasks.entries()) {
    const taskId = getJsonTaskId(task);
    if (!taskId) {
      return `Task at index ${index} must have a non-empty id.`;
    }
    if (taskIds.has(taskId)) {
      return `Task id ${taskId} is duplicated.`;
    }
    taskIds.add(taskId);

    if (!parseRalphWorkItemState(task.status)) {
      return `Task ${taskId} has unsupported status \`${String(task.status)}\`.`;
    }
  }

  return undefined;
};

const getJsonTaskStringList = (
  task: Record<string, unknown>,
  keys: readonly string[],
): string[] => {
  const values: string[] = [];

  for (const key of keys) {
    const value = task[key];

    if (typeof value === "string" && value.trim()) {
      values.push(value.trim());
      continue;
    }

    if (Array.isArray(value)) {
      values.push(
        ...value.filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.trim().length > 0,
        ),
      );
    }
  }

  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
};

const getJsonTaskDependencies = (task: Record<string, unknown>): string[] => {
  return getJsonTaskStringList(task, ["dependencies"]);
};

const getJsonTaskBatchKey = (
  task: Record<string, unknown>,
): string | undefined => {
  const [batchKey] = getJsonTaskStringList(task, ["batchKey"]);

  return batchKey?.toLowerCase();
};

const getJsonTaskLikelyFiles = (task: Record<string, unknown>): string[] => {
  return getJsonTaskStringList(task, ["likelyFiles"]).map((value) =>
    value.replace(/\\/gu, "/").toLowerCase(),
  );
};

const isCompletedJsonTask = (task: Record<string, unknown>): boolean => {
  return getJsonTaskStatus(task) === "completed";
};

interface RalphJsonTaskLease {
  ownerId: string;
  generation: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

const readJsonTaskLease = (
  task: Record<string, unknown>,
): RalphJsonTaskLease | undefined => {
  const lease = isRecord(task.lease) ? task.lease : undefined;
  return lease &&
    typeof lease.ownerId === "string" &&
    typeof lease.generation === "number" &&
    typeof lease.acquiredAt === "string" &&
    typeof lease.heartbeatAt === "string" &&
    typeof lease.expiresAt === "string"
    ? (lease as unknown as RalphJsonTaskLease)
    : undefined;
};

const isJsonTaskLeaseActive = (
  lease: RalphJsonTaskLease | undefined,
  now = Date.now(),
): boolean => Boolean(lease && Date.parse(lease.expiresAt) > now);

const isJsonTaskEligibleForRun = (
  task: Record<string, unknown>,
  runId: string,
  now = Date.now(),
): boolean => {
  const status = getJsonTaskStatus(task);
  const nextEligibleAt =
    typeof task.nextEligibleAt === "string"
      ? Date.parse(task.nextEligibleAt)
      : Number.NaN;
  if (status === "deferred") {
    if (!Number.isFinite(nextEligibleAt) || nextEligibleAt > now) {
      return false;
    }
  }

  const lease = readJsonTaskLease(task);
  return !isJsonTaskLeaseActive(lease, now) || lease?.ownerId === runId;
};

const appendJsonTaskStateHistory = (
  task: Record<string, unknown>,
  entry: Record<string, unknown>,
): void => {
  const history = Array.isArray(task.stateHistory) ? task.stateHistory : [];
  task.stateHistory = [...history, entry].slice(
    -MAX_RALPH_WORK_ITEM_STATE_HISTORY,
  );
};

const isInProgressJsonTask = (task: Record<string, unknown>): boolean => {
  const status = getJsonTaskStatus(task);

  return (
    status === "implementing" ||
    status === "verifying" ||
    status === "repairing"
  );
};

const isSelectableJsonTask = (task: Record<string, unknown>): boolean => {
  return getJsonTaskStatus(task) !== "completed";
};

interface JsonTaskCandidate {
  task: Record<string, unknown>;
  index: number;
}

const haveSharedJsonTaskFiles = (
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean => {
  const leftFiles = new Set(getJsonTaskLikelyFiles(left));

  return getJsonTaskLikelyFiles(right).some((file) => leftFiles.has(file));
};

const areJsonTaskDependenciesSatisfied = (
  task: Record<string, unknown>,
  doneIds: ReadonlySet<string>,
  selectedIds: ReadonlySet<string> = new Set(),
): boolean => {
  return getJsonTaskDependencies(task).every(
    (dependency) => doneIds.has(dependency) || selectedIds.has(dependency),
  );
};

const sortJsonTaskCandidatesByStrategy = (
  candidates: JsonTaskCandidate[],
  strategy: string | undefined,
): JsonTaskCandidate[] => {
  switch (strategy) {
    case "random":
    case "random-seeded":
      return [...candidates];
    case "end-to-start":
      return [...candidates].sort((left, right) => right.index - left.index);
    case "priority":
      return [...candidates].sort(
        (left, right) =>
          Number(right.task.priority ?? 0) - Number(left.task.priority ?? 0),
      );
    case "least-recent":
    case "least-validated":
      return [...candidates].sort((left, right) =>
        String(left.task.updatedAt ?? left.task.selectedAt ?? "").localeCompare(
          String(right.task.updatedAt ?? right.task.selectedAt ?? ""),
        ),
      );
    case "risk-first": {
      const riskScore = (task: Record<string, unknown>): number => {
        switch (task.risk) {
          case "high":
            return 3;
          case "medium":
            return 2;
          case "low":
            return 1;
          default:
            return 0;
        }
      };

      return [...candidates].sort(
        (left, right) => riskScore(right.task) - riskScore(left.task),
      );
    }
    case "start-to-end":
    case "round-robin":
    default:
      return [...candidates].sort((left, right) => left.index - right.index);
  }
};

const selectJsonTaskCandidate = (
  candidates: JsonTaskCandidate[],
  strategy: string | undefined,
  seed: string,
): JsonTaskCandidate | undefined => {
  if (candidates.length === 0) {
    return undefined;
  }

  if (strategy === "random") {
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  if (strategy === "random-seeded") {
    return [...candidates].sort((left, right) => {
      const score = (candidate: JsonTaskCandidate): string =>
        createHash("sha256")
          .update(
            `${seed}\0${getJsonTaskId(candidate.task) ?? candidate.index}`,
          )
          .digest("hex");
      return score(left).localeCompare(score(right));
    })[0];
  }

  return sortJsonTaskCandidatesByStrategy(candidates, strategy)[0];
};

const getJsonTaskBatchCandidateOrder = (
  candidates: JsonTaskCandidate[],
  primary: JsonTaskCandidate,
  strategy: string | undefined,
): JsonTaskCandidate[] => {
  if (strategy === "end-to-start") {
    return candidates
      .filter((candidate) => candidate.index < primary.index)
      .sort((left, right) => right.index - left.index);
  }

  if (strategy === "start-to-end" || strategy === "round-robin" || !strategy) {
    return candidates
      .filter((candidate) => candidate.index > primary.index)
      .sort((left, right) => left.index - right.index);
  }

  return sortJsonTaskCandidatesByStrategy(
    candidates.filter((candidate) => candidate.index !== primary.index),
    strategy,
  );
};

const isJsonTaskBatchCompatible = (
  primary: JsonTaskCandidate,
  candidate: JsonTaskCandidate,
  selected: readonly JsonTaskCandidate[],
  strategy: string | undefined,
): boolean => {
  const primaryBatchKey = getJsonTaskBatchKey(primary.task);
  const candidateBatchKey = getJsonTaskBatchKey(candidate.task);

  if (primaryBatchKey || candidateBatchKey) {
    return (
      primaryBatchKey !== undefined && primaryBatchKey === candidateBatchKey
    );
  }

  if (haveSharedJsonTaskFiles(primary.task, candidate.task)) {
    return true;
  }

  const lastSelected = selected.at(-1) ?? primary;
  if (strategy === "end-to-start") {
    return candidate.index === lastSelected.index - 1;
  }

  if (strategy === "start-to-end" || strategy === "round-robin" || !strategy) {
    return candidate.index === lastSelected.index + 1;
  }

  return (
    strategy === "priority" ||
    strategy === "risk-first" ||
    strategy === "least-recent" ||
    strategy === "least-validated"
  );
};

const selectJsonTaskCandidates = (
  tasks: Record<string, unknown>[],
  strategy: string | undefined,
  maxTasks: number,
  runId: string,
  now = Date.now(),
): JsonTaskCandidate[] => {
  const candidates = tasks
    .map((task, index) => ({ task, index }))
    .filter(
      (candidate) =>
        isSelectableJsonTask(candidate.task) &&
        isJsonTaskEligibleForRun(candidate.task, runId, now),
    );
  const doneIds = new Set(
    tasks
      .filter(isCompletedJsonTask)
      .map(getJsonTaskId)
      .filter((id): id is string => id !== undefined),
  );
  const primaryCandidates = candidates.filter((candidate) =>
    areJsonTaskDependenciesSatisfied(candidate.task, doneIds),
  );
  const primary = selectJsonTaskCandidate(primaryCandidates, strategy, runId);

  if (!primary) {
    return [];
  }

  const batchLimit = Math.max(1, Math.trunc(maxTasks));
  if (batchLimit === 1 || isInProgressJsonTask(primary.task)) {
    return [primary];
  }

  const selected: JsonTaskCandidate[] = [primary];
  const selectedIds = new Set<string>();
  const primaryId = getJsonTaskId(primary.task);
  if (primaryId) {
    selectedIds.add(primaryId);
  }

  for (const candidate of getJsonTaskBatchCandidateOrder(
    candidates,
    primary,
    strategy,
  )) {
    if (selected.length >= batchLimit) {
      break;
    }

    if (isInProgressJsonTask(candidate.task)) {
      continue;
    }

    if (!isJsonTaskBatchCompatible(primary, candidate, selected, strategy)) {
      continue;
    }

    if (
      !areJsonTaskDependenciesSatisfied(candidate.task, doneIds, selectedIds)
    ) {
      continue;
    }

    selected.push(candidate);
    const taskId = getJsonTaskId(candidate.task);
    if (taskId) {
      selectedIds.add(taskId);
    }
  }

  return selected;
};

const getJsonTaskMaxTasks = (utility: RalphUtilityConfig): number => {
  return typeof utility.maxTasks === "number" &&
    Number.isFinite(utility.maxTasks)
    ? Math.max(1, Math.trunc(utility.maxTasks))
    : 1;
};

const getJsonTaskCandidatesForRun = (
  tasks: Record<string, unknown>[],
  strategy: string | undefined,
  maxTasks: number,
  runId: string,
  now = Date.now(),
): JsonTaskCandidate[] => {
  const sameRunLeasedTasks = tasks
    .map((task, index) => ({ task, index }))
    .filter(
      ({ task }) =>
        isSelectableJsonTask(task) &&
        readJsonTaskLease(task)?.ownerId === runId,
    );

  return sameRunLeasedTasks.length > 0
    ? sameRunLeasedTasks
    : selectJsonTaskCandidates(tasks, strategy, maxTasks, runId, now);
};

const createJsonTaskSelectionBlockers = (
  tasks: readonly Record<string, unknown>[],
  runId: string,
  now = Date.now(),
): {
  blockers: Array<Record<string, unknown>>;
  dependencyCycles: string[][];
} => {
  const tasksById = new Map(
    tasks.flatMap((task) => {
      const id = getJsonTaskId(task);
      return id ? [[id, task] as const] : [];
    }),
  );
  const dependencyCycles: string[][] = [];
  const visiting: string[] = [];
  const visited = new Set<string>();

  const visit = (id: string): void => {
    const cycleIndex = visiting.indexOf(id);
    if (cycleIndex >= 0) {
      const cycle = [...visiting.slice(cycleIndex), id];
      const signature = cycle.join("->");
      if (!dependencyCycles.some((entry) => entry.join("->") === signature)) {
        dependencyCycles.push(cycle);
      }
      return;
    }
    if (visited.has(id)) {
      return;
    }
    const task = tasksById.get(id);
    if (!task) {
      return;
    }
    visiting.push(id);
    for (const dependency of getJsonTaskDependencies(task)) {
      if (tasksById.has(dependency)) {
        visit(dependency);
      }
    }
    visiting.pop();
    visited.add(id);
  };

  for (const id of tasksById.keys()) {
    visit(id);
  }

  const blockers = tasks.filter(isSelectableJsonTask).map((task) => {
    const id = getJsonTaskId(task)!;
    const dependencies = getJsonTaskDependencies(task);
    const missingDependencyIds = dependencies.filter(
      (dependency) => !tasksById.has(dependency),
    );
    const incompleteDependencyIds = dependencies.filter((dependency) => {
      const dependencyTask = tasksById.get(dependency);
      return (
        dependencyTask !== undefined && !isCompletedJsonTask(dependencyTask)
      );
    });
    const deferredDependencyIds = incompleteDependencyIds.filter(
      (dependency) =>
        getJsonTaskStatus(tasksById.get(dependency)!) === "deferred",
    );
    const lease = readJsonTaskLease(task);
    const nextEligibleAt =
      typeof task.nextEligibleAt === "string" ? task.nextEligibleAt : undefined;
    const nextEligibleTimestamp = nextEligibleAt
      ? Date.parse(nextEligibleAt)
      : Number.NaN;
    const hasInvalidNextEligibleAt =
      getJsonTaskStatus(task) === "deferred" &&
      nextEligibleAt !== undefined &&
      !Number.isFinite(nextEligibleTimestamp);
    const reasons = [
      ...(missingDependencyIds.length > 0 ? ["missing-dependency"] : []),
      ...(incompleteDependencyIds.length > 0 ? ["incomplete-dependency"] : []),
      ...(deferredDependencyIds.length > 0 ? ["deferred-dependency"] : []),
      ...(getJsonTaskStatus(task) === "deferred" &&
      (!Number.isFinite(nextEligibleTimestamp) || nextEligibleTimestamp > now)
        ? ["deferred"]
        : []),
      ...(hasInvalidNextEligibleAt ? ["invalid-next-eligible-at"] : []),
      ...(isJsonTaskLeaseActive(lease, now) && lease?.ownerId !== runId
        ? ["foreign-lease"]
        : []),
      ...(dependencyCycles.some((cycle) => cycle.includes(id))
        ? ["dependency-cycle"]
        : []),
    ];
    return {
      taskId: id,
      status: getJsonTaskStatus(task),
      reasons,
      ...(missingDependencyIds.length > 0 ? { missingDependencyIds } : {}),
      ...(incompleteDependencyIds.length > 0
        ? { incompleteDependencyIds }
        : {}),
      ...(deferredDependencyIds.length > 0 ? { deferredDependencyIds } : {}),
      ...(nextEligibleAt ? { nextEligibleAt } : {}),
      ...(lease ? { lease } : {}),
    };
  });

  return { blockers, dependencyCycles };
};

type JsonTaskSelectionStatus = "ready" | "complete" | "deferred" | "blocked";

interface JsonTaskSelectionAssessment {
  status: JsonTaskSelectionStatus;
  candidates: JsonTaskCandidate[];
  blockerState: ReturnType<typeof createJsonTaskSelectionBlockers>;
  blockers: Array<Record<string, unknown>>;
  structurallyBlocked: boolean;
  nextRetryTimestamp?: number;
}

const assessJsonTaskSelection = (
  tasks: Record<string, unknown>[],
  strategy: string | undefined,
  maxTasks: number,
  runId: string,
  now = Date.now(),
): JsonTaskSelectionAssessment => {
  const candidates = getJsonTaskCandidatesForRun(
    tasks,
    strategy,
    maxTasks,
    runId,
    now,
  );
  const blockerState = createJsonTaskSelectionBlockers(tasks, runId, now);
  const blockers = blockerState.blockers.filter(
    (entry) => Array.isArray(entry.reasons) && entry.reasons.length > 0,
  );
  const retryTimes = tasks.flatMap((task) => {
    if (!isSelectableJsonTask(task)) {
      return [];
    }

    const retryAt: number[] = [];
    if (typeof task.nextEligibleAt === "string") {
      const parsed = Date.parse(task.nextEligibleAt);
      if (Number.isFinite(parsed) && parsed > now) {
        retryAt.push(parsed);
      }
    }

    const lease = readJsonTaskLease(task);
    if (lease && lease.ownerId !== runId && isJsonTaskLeaseActive(lease, now)) {
      retryAt.push(Date.parse(lease.expiresAt));
    }
    return retryAt;
  });
  const structurallyBlocked = blockers.some((entry) => {
    const reasons = Array.isArray(entry.reasons) ? entry.reasons : [];
    return (
      reasons.includes("missing-dependency") ||
      reasons.includes("dependency-cycle") ||
      reasons.includes("invalid-next-eligible-at") ||
      (reasons.includes("deferred") && typeof entry.nextEligibleAt !== "string")
    );
  });
  const nextRetryTimestamp =
    retryTimes.length > 0 ? Math.min(...retryTimes) : undefined;
  const unfinishedCount = tasks.filter(isSelectableJsonTask).length;
  const status: JsonTaskSelectionStatus =
    candidates.length > 0
      ? "ready"
      : unfinishedCount === 0
        ? "complete"
        : !structurallyBlocked && nextRetryTimestamp !== undefined
          ? "deferred"
          : "blocked";

  return {
    status,
    candidates,
    blockerState,
    blockers,
    structurallyBlocked,
    ...(nextRetryTimestamp !== undefined ? { nextRetryTimestamp } : {}),
  };
};

const createJsonTaskAssessmentItem = (
  task: Record<string, unknown>,
): Record<string, unknown> => {
  const dependencies = getJsonTaskDependencies(task);
  const lease = readJsonTaskLease(task);

  return {
    id: getJsonTaskId(task)!,
    status: getJsonTaskStatus(task),
    ...(dependencies.length > 0
      ? {
          dependencies: dependencies.slice(
            0,
            MAX_RALPH_JSON_TASK_ASSESSMENT_ITEMS,
          ),
          ...(dependencies.length > MAX_RALPH_JSON_TASK_ASSESSMENT_ITEMS
            ? {
                omittedDependencyCount:
                  dependencies.length - MAX_RALPH_JSON_TASK_ASSESSMENT_ITEMS,
              }
            : {}),
        }
      : {}),
    ...(typeof task.nextEligibleAt === "string"
      ? { nextEligibleAt: task.nextEligibleAt }
      : {}),
    ...(lease
      ? {
          lease: {
            ownerId: lease.ownerId,
            expiresAt: lease.expiresAt,
          },
        }
      : {}),
  };
};

const executeAssessJsonTasksUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  context: RalphResultContext,
): Promise<RalphBlockExecutionResult> => {
  const rawPath = utility.path?.trim();

  if (!rawPath) {
    return createUtilityResult(
      block,
      "ERROR",
      "Assess JSON tasks utility requires path.",
    );
  }

  const path = resolveWorkspaceContainedUtilityPath(
    rawPath,
    config.workspaceRoot,
  );

  try {
    const json = await readJsonFile(path);
    const validation = validateUtilityJsonValue(json, utility.schema);

    if (!validation.valid) {
      return createUtilityResult(
        block,
        "INVALID",
        `${block.title} JSON did not match schema.`,
        { path, validation },
      );
    }

    const taskArray = getJsonTaskArray(json, utility.jsonPath);
    if (!taskArray) {
      return createUtilityResult(
        block,
        "INVALID",
        `${block.title} could not find a task array at ${utility.jsonPath ?? "tasks"}.`,
        { path, jsonPath: utility.jsonPath ?? "tasks" },
      );
    }

    const contractError = getJsonTaskContractError(taskArray.tasks);
    if (contractError) {
      return createUtilityResult(
        block,
        "INVALID",
        `${block.title} found an invalid task record: ${contractError}`,
        {
          path,
          jsonPath: taskArray.normalizedPath,
          error: contractError,
        },
      );
    }

    const statusCounts: Record<string, number> = {};
    for (const task of taskArray.tasks) {
      const status = getJsonTaskStatus(task);
      if (!status) {
        return createUtilityResult(
          block,
          "INVALID",
          `${block.title} found a task with an unsupported status.`,
          {
            path,
            jsonPath: taskArray.normalizedPath,
          },
        );
      }
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    }
    const completedCount = taskArray.tasks.filter(isCompletedJsonTask).length;
    const unfinishedCount = taskArray.tasks.length - completedCount;
    const maxTasks = getJsonTaskMaxTasks(utility);
    const assessmentStrategy =
      utility.strategy === "random" ? "random-seeded" : utility.strategy;
    const now = Date.now();
    const selection = assessJsonTaskSelection(
      taskArray.tasks,
      assessmentStrategy,
      maxTasks,
      context.runId,
      now,
    );
    const tasks = taskArray.tasks
      .slice(0, MAX_RALPH_JSON_TASK_ASSESSMENT_ITEMS)
      .map(createJsonTaskAssessmentItem);
    const boundedCandidates = selection.candidates.slice(
      0,
      MAX_RALPH_JSON_TASK_ASSESSMENT_ITEMS,
    );
    const boundedBlockers = selection.blockers
      .slice(0, MAX_RALPH_JSON_TASK_ASSESSMENT_ITEMS)
      .map((entry) => {
        const boundedEntry: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(entry)) {
          if (Array.isArray(value)) {
            boundedEntry[key] = value.slice(
              0,
              MAX_RALPH_JSON_TASK_ASSESSMENT_ITEMS,
            );
            if (value.length > MAX_RALPH_JSON_TASK_ASSESSMENT_ITEMS) {
              boundedEntry[
                `omitted${key[0]!.toUpperCase()}${key.slice(1)}Count`
              ] = value.length - MAX_RALPH_JSON_TASK_ASSESSMENT_ITEMS;
            }
            continue;
          }
          boundedEntry[key] = value;
        }
        return boundedEntry;
      });
    const boundedDependencyCycles = selection.blockerState.dependencyCycles
      .slice(0, MAX_RALPH_JSON_TASK_ASSESSMENT_ITEMS)
      .map((cycle) => cycle.slice(0, MAX_RALPH_JSON_TASK_ASSESSMENT_ITEMS));
    const data = {
      path,
      jsonPath: taskArray.normalizedPath,
      totalCount: taskArray.tasks.length,
      completedCount,
      unfinishedCount,
      completionRatio:
        taskArray.tasks.length > 0
          ? completedCount / taskArray.tasks.length
          : 0,
      statusCounts,
      tasks,
      tasksTruncated:
        taskArray.tasks.length > MAX_RALPH_JSON_TASK_ASSESSMENT_ITEMS,
      omittedTaskCount: Math.max(
        0,
        taskArray.tasks.length - MAX_RALPH_JSON_TASK_ASSESSMENT_ITEMS,
      ),
      nextTaskIds: boundedCandidates.map((candidate) =>
        getJsonTaskId(candidate.task)!,
      ),
      nextTaskIndexes: boundedCandidates.map((candidate) => candidate.index),
      nextTasksTruncated:
        selection.candidates.length > MAX_RALPH_JSON_TASK_ASSESSMENT_ITEMS,
      omittedNextTaskCount: Math.max(
        0,
        selection.candidates.length - MAX_RALPH_JSON_TASK_ASSESSMENT_ITEMS,
      ),
      maxTasks,
      blockers: boundedBlockers,
      blockersTruncated:
        selection.blockers.length > MAX_RALPH_JSON_TASK_ASSESSMENT_ITEMS,
      omittedBlockerCount: Math.max(
        0,
        selection.blockers.length - MAX_RALPH_JSON_TASK_ASSESSMENT_ITEMS,
      ),
      dependencyCycles: boundedDependencyCycles,
      dependencyCyclesTruncated:
        selection.blockerState.dependencyCycles.length >
          MAX_RALPH_JSON_TASK_ASSESSMENT_ITEMS ||
        selection.blockerState.dependencyCycles.some(
          (cycle) => cycle.length > MAX_RALPH_JSON_TASK_ASSESSMENT_ITEMS,
        ),
      omittedDependencyCycleCount: Math.max(
        0,
        selection.blockerState.dependencyCycles.length -
          MAX_RALPH_JSON_TASK_ASSESSMENT_ITEMS,
      ),
      availability: selection.status,
      structurallyBlocked: selection.structurallyBlocked,
      retryable: selection.status === "deferred",
      ...(selection.nextRetryTimestamp !== undefined
        ? {
            nextRetryAt: new Date(selection.nextRetryTimestamp).toISOString(),
          }
        : {}),
    };

    if (taskArray.tasks.length === 0) {
      return createUtilityResult(
        block,
        "EMPTY",
        `${block.title} found an empty task plan; empty plans are not complete.`,
        data,
        "completed",
      );
    }
    if (unfinishedCount === 0) {
      return createUtilityResult(
        block,
        "COMPLETE",
        `${block.title} confirmed all ${completedCount} task(s) are complete.`,
        data,
        "completed",
      );
    }
    if (selection.status === "ready") {
      return createUtilityResult(
        block,
        "READY",
        `${block.title} found ${selection.candidates.length} task(s) ready for the next bounded claim.`,
        data,
        "completed",
      );
    }

    if (selection.status === "deferred") {
      return createUtilityResult(
        block,
        "DEFERRED",
        `${block.title} found ${unfinishedCount} temporarily unavailable task(s); retry after ${new Date(selection.nextRetryTimestamp!).toISOString()}.`,
        data,
        "completed",
      );
    }

    return createUtilityResult(
      block,
      "BLOCKED",
      selection.structurallyBlocked
        ? `${block.title} found ${unfinishedCount} unfinished task(s) with structural blockers.`
        : `${block.title} found ${unfinishedCount} unfinished task(s), but none can be selected.`,
      data,
      "completed",
    );
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return createUtilityResult(
        block,
        "NOT_FOUND",
        `${block.title} did not find ${path}.`,
        { path },
        "completed",
      );
    }

    if (error instanceof SyntaxError) {
      return createUtilityResult(
        block,
        "INVALID",
        `${block.title} could not parse JSON at ${path}.`,
        { path, error: error.message },
      );
    }

    return createRalphBlockExecutionErrorResult(block, error);
  }
};

const executeSelectJsonTaskUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  context: RalphResultContext,
): Promise<RalphBlockExecutionResult> => {
  const rawPath = utility.path?.trim();

  if (!rawPath) {
    return createUtilityResult(
      block,
      "ERROR",
      "Select JSON task utility requires path.",
    );
  }

  const path = await resolveWorkspaceContainedMutationPath(
    rawPath,
    config.workspaceRoot,
  );
  let mutationLock: RalphFileMutationLock | undefined;

  try {
    mutationLock = await acquireRalphFileMutationLock(path, context.runId);
    const json = await readJsonFile(path);
    const validation = validateUtilityJsonValue(json, utility.schema);

    if (!validation.valid) {
      return createUtilityResult(
        block,
        "INVALID",
        `${block.title} JSON did not match schema.`,
        { path, validation },
      );
    }

    const taskArray = getJsonTaskArray(json, utility.jsonPath);

    if (!taskArray) {
      return createUtilityResult(
        block,
        "INVALID",
        `${block.title} could not find a task array at ${utility.jsonPath ?? "tasks"}.`,
        { path, jsonPath: utility.jsonPath ?? "tasks" },
      );
    }

    const contractError = getJsonTaskContractError(taskArray.tasks);
    if (contractError) {
      return createUtilityResult(
        block,
        "INVALID",
        `${block.title} found an invalid task record: ${contractError}`,
        {
          path,
          jsonPath: taskArray.normalizedPath,
          error: contractError,
        },
      );
    }

    const maxTasks = getJsonTaskMaxTasks(utility);
    const selection = assessJsonTaskSelection(
      taskArray.tasks,
      utility.strategy,
      maxTasks,
      context.runId,
    );
    const selectedTasks = selection.candidates;

    if (selectedTasks.length === 0) {
      const unfinishedTasks = taskArray.tasks.filter(isSelectableJsonTask);
      if (unfinishedTasks.length > 0) {
        return createUtilityResult(
          block,
          selection.status === "deferred" ? "DEFERRED" : "BLOCKED",
          selection.status === "deferred"
            ? `${block.title} found only temporarily unavailable tasks.`
            : `${block.title} found unfinished tasks with structural blockers.`,
          {
            path,
            jsonPath: taskArray.normalizedPath,
            blockers: selection.blockers,
            dependencyCycles: selection.blockerState.dependencyCycles,
            structurallyBlocked: selection.structurallyBlocked,
            retryable: selection.status === "deferred",
            ...(selection.nextRetryTimestamp !== undefined
              ? {
                  nextRetryAt: new Date(
                    selection.nextRetryTimestamp,
                  ).toISOString(),
                }
              : {}),
          },
          "completed",
        );
      }
      return createUtilityResult(
        block,
        "EMPTY",
        `${block.title} found no selectable task.`,
        { path, jsonPath: taskArray.normalizedPath, tasks: taskArray.tasks },
        "completed",
      );
    }

    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(
      Date.now() + DEFAULT_RALPH_WORK_ITEM_LEASE_MS,
    ).toISOString();
    for (const selected of selectedTasks) {
      const currentAttempts =
        typeof selected.task.attempts === "number" ? selected.task.attempts : 0;
      const currentState = parseRalphWorkItemState(selected.task.status);
      const selectedState =
        currentState === "implementing" ||
        currentState === "verifying" ||
        currentState === "repairing"
          ? currentState
          : "implementing";
      const transition = transitionRalphWorkItemState(
        selected.task.status,
        selectedState,
      );
      const workItemId = getJsonTaskId(selected.task)!;
      const priorLease = readJsonTaskLease(selected.task);
      const isNewClaim =
        priorLease?.ownerId !== context.runId ||
        !isJsonTaskLeaseActive(priorLease);

      selected.task.status = transition.to;
      delete selected.task.deferredAt;
      delete selected.task.nextEligibleAt;
      selected.task.workItemId = workItemId;
      selected.task.runId = context.runId;
      selected.task.lease = {
        ownerId: context.runId,
        generation: (priorLease?.generation ?? 0) + (isNewClaim ? 1 : 0),
        acquiredAt: isNewClaim ? now : (priorLease?.acquiredAt ?? now),
        heartbeatAt: now,
        expiresAt: leaseExpiresAt,
      } satisfies RalphJsonTaskLease;
      if (transition.changed) {
        appendJsonTaskStateHistory(selected.task, {
          from: transition.from,
          to: transition.to,
          changed: true,
          at: now,
          runId: context.runId,
          blockId: block.id,
        });
      }
      selected.task.selectedAt = now;
      selected.task.updatedAt = now;
      selected.task.attempts = currentAttempts + (isNewClaim ? 1 : 0);
    }

    await writeUtilityJsonOutput(path, json);

    const taskIds = selectedTasks.map((selected) =>
      getJsonTaskId(selected.task)!,
    );

    return createUtilityResult(
      block,
      "SELECTED",
      selectedTasks.length === 1
        ? `${block.title} selected ${taskIds[0]}.`
        : `${block.title} selected ${selectedTasks.length} task(s): ${taskIds.join(", ")}.`,
      {
        path,
        jsonPath: taskArray.normalizedPath,
        tasks: selectedTasks.map((selected) => selected.task),
        indexes: selectedTasks.map((selected) => selected.index),
        taskIds,
        count: selectedTasks.length,
        maxTasks,
        remainingCount: taskArray.tasks.filter(
          (task) =>
            isSelectableJsonTask(task) &&
            isJsonTaskEligibleForRun(task, context.runId),
        ).length,
        json,
      },
      "completed",
    );
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return createUtilityResult(
        block,
        "NOT_FOUND",
        `${block.title} did not find ${path}.`,
        { path },
        "completed",
      );
    }

    if (error instanceof SyntaxError) {
      return createUtilityResult(
        block,
        "INVALID",
        `${block.title} could not parse JSON at ${path}.`,
        { path, error: error.message },
      );
    }

    return createRalphBlockExecutionErrorResult(block, error);
  } finally {
    await mutationLock?.release();
  }
};

const getJsonTaskIdsFromInput = (
  utility: RalphUtilityConfig,
  context: RalphResultContext,
): string[] => {
  if (utility.taskId?.trim()) {
    return [utility.taskId.trim()];
  }

  const input =
    utility.input !== undefined
      ? parseRalphUtilityJsonValue(utility.input)
      : context.lastResult?.data;
  if (!isRecord(input)) {
    return [];
  }

  const ids: string[] = [];
  const addId = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) {
      ids.push(value.trim());
    }
  };
  for (const value of Array.isArray(input.taskIds) ? input.taskIds : []) {
    addId(value);
  }

  return [...new Set(ids)];
};

const executeMarkJsonTaskUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  context: RalphResultContext,
): Promise<RalphBlockExecutionResult> => {
  const rawPath = utility.path?.trim();

  if (!rawPath) {
    return createUtilityResult(
      block,
      "ERROR",
      "Mark JSON task utility requires path.",
    );
  }

  const path = await resolveWorkspaceContainedMutationPath(
    rawPath,
    config.workspaceRoot,
  );
  let mutationLock: RalphFileMutationLock | undefined;

  try {
    mutationLock = await acquireRalphFileMutationLock(path, context.runId);
    const json = await readJsonFile(path);
    const validation = validateUtilityJsonValue(json, utility.schema);

    if (!validation.valid) {
      return createUtilityResult(
        block,
        "INVALID",
        `${block.title} JSON did not match schema.`,
        { path, validation },
      );
    }

    const taskArray = getJsonTaskArray(json, utility.jsonPath);

    if (!taskArray) {
      return createUtilityResult(
        block,
        "INVALID",
        `${block.title} could not find a task array at ${utility.jsonPath ?? "tasks"}.`,
        { path, jsonPath: utility.jsonPath ?? "tasks" },
      );
    }

    const contractError = getJsonTaskContractError(taskArray.tasks);
    if (contractError) {
      return createUtilityResult(
        block,
        "INVALID",
        `${block.title} found an invalid task record: ${contractError}`,
        {
          path,
          jsonPath: taskArray.normalizedPath,
          error: contractError,
        },
      );
    }

    const requestedTaskIds = getJsonTaskIdsFromInput(utility, context);
    const candidates =
      requestedTaskIds.length > 0
        ? requestedTaskIds.flatMap((taskId) => {
            const task = taskArray.tasks.find(
              (candidate) => candidate.id === taskId,
            );
            return task ? [task] : [];
          })
        : taskArray.tasks
            .filter(
              (task) =>
                isInProgressJsonTask(task) &&
                readJsonTaskLease(task)?.ownerId === context.runId,
            )
            .slice(0, 1);

    if (
      candidates.length === 0 ||
      candidates.length !== (requestedTaskIds.length || 1)
    ) {
      return createUtilityResult(
        block,
        "NOT_FOUND",
        `${block.title} found no matching task.`,
        {
          path,
          jsonPath: taskArray.normalizedPath,
          taskIds: requestedTaskIds,
          missingTaskIds: requestedTaskIds.filter(
            (taskId) =>
              !candidates.some((candidate) => candidate.id === taskId),
          ),
        },
        "completed",
      );
    }

    const now = new Date().toISOString();
    const status = utility.status?.trim();
    if (!status) {
      return createUtilityResult(
        block,
        "ERROR",
        "Mark JSON task utility requires status.",
      );
    }

    const activeForeignLease = candidates.find((candidate) => {
      const lease = readJsonTaskLease(candidate);
      return isJsonTaskLeaseActive(lease) && lease?.ownerId !== context.runId;
    });
    if (activeForeignLease) {
      return createUtilityResult(
        block,
        "INVALID",
        `${block.title} cannot mutate a task leased by another run.`,
        {
          path,
          taskId: activeForeignLease.id,
          lease: activeForeignLease.lease,
        },
      );
    }

    let transitions: ReturnType<typeof transitionRalphWorkItemState>[];
    try {
      transitions = candidates.map((candidate) =>
        transitionRalphWorkItemState(candidate.status, status),
      );
    } catch (error) {
      return createUtilityResult(
        block,
        "INVALID",
        error instanceof Error ? error.message : String(error),
        {
          path,
          jsonPath: taskArray.normalizedPath,
          taskIds: candidates.map((candidate) => candidate.id),
          requestedStatus: status,
        },
      );
    }

    for (const [index, candidate] of candidates.entries()) {
      const transition = transitions[index]!;
      const workItemId = getJsonTaskId(candidate)!;
      candidate.status = transition.to;
      candidate.workItemId = workItemId;
      candidate.runId = context.runId;
      candidate.updatedAt = now;
      if (transition.changed) {
        appendJsonTaskStateHistory(candidate, {
          from: transition.from,
          to: transition.to,
          changed: true,
          at: now,
          runId: context.runId,
          blockId: block.id,
        });
      }
      if (transition.to === "completed") {
        candidate.completedAt = now;
        delete candidate.deferredAt;
        delete candidate.nextEligibleAt;
        delete candidate.lease;
      } else if (transition.to === "deferred") {
        candidate.deferredAt = now;
        const deferMs = Math.max(
          0,
          Number.isFinite(utility.delaySeconds)
            ? Number(utility.delaySeconds) * 1_000
            : DEFAULT_RALPH_WORK_ITEM_DEFER_MS,
        );
        candidate.nextEligibleAt = new Date(Date.now() + deferMs).toISOString();
        delete candidate.lease;
      } else {
        delete candidate.deferredAt;
        delete candidate.nextEligibleAt;
        const lease = readJsonTaskLease(candidate);
        candidate.lease = {
          ownerId: context.runId,
          generation: lease?.generation ?? 1,
          acquiredAt: lease?.acquiredAt ?? now,
          heartbeatAt: now,
          expiresAt: new Date(
            Date.now() + DEFAULT_RALPH_WORK_ITEM_LEASE_MS,
          ).toISOString(),
        } satisfies RalphJsonTaskLease;
      }
    }

    for (const candidate of candidates) {
      candidate.lastResult = {
        blockId: context.lastResult?.blockId,
        output: context.lastResult?.output,
        summary: context.lastResult?.summary,
      };
    }

    await writeUtilityJsonOutput(path, json);
    const primary = candidates[0]!;
    const finalStatus = String(primary.status ?? status);
    const taskIds = candidates.map((candidate) => String(candidate.id));

    return createUtilityResult(
      block,
      "SUCCESS",
      candidates.length === 1
        ? `${block.title} marked ${String(primary.id ?? "task")} as ${finalStatus}.`
        : `${block.title} marked ${candidates.length} tasks as ${finalStatus}.`,
      {
        path,
        jsonPath: taskArray.normalizedPath,
        tasks: candidates,
        taskIds,
        status: finalStatus,
        json,
      },
    );
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return createUtilityResult(
        block,
        "NOT_FOUND",
        `${block.title} did not find ${path}.`,
        { path },
        "completed",
      );
    }

    if (error instanceof SyntaxError) {
      return createUtilityResult(
        block,
        "INVALID",
        `${block.title} could not parse JSON at ${path}.`,
        { path, error: error.message },
      );
    }

    return createRalphBlockExecutionErrorResult(block, error);
  } finally {
    await mutationLock?.release();
  }
};

interface RalphJsonTaskClaim {
  path: string;
  jsonPath?: string;
  taskIds: Set<string>;
}

const collectRalphJsonTaskClaims = (
  flow: RalphFlow,
  context: RalphResultContext,
): RalphJsonTaskClaim[] => {
  const blockMap = getRalphBlockById(flow);
  const claims = new Map<string, RalphJsonTaskClaim>();
  const results = [
    ...(context.executionHistory ?? []),
    ...context.resultsByBlock.values(),
  ];

  for (const result of results) {
    const block = blockMap.get(result.blockId);
    if (
      block?.type !== "UTILITY" ||
      block.utility.type !== "SELECT_JSON_TASK" ||
      result.output !== "SELECTED" ||
      !isRecord(result.data) ||
      typeof result.data.path !== "string"
    ) {
      continue;
    }
    const jsonPath =
      typeof result.data.jsonPath === "string"
        ? result.data.jsonPath
        : undefined;
    const key = `${result.data.path}\0${jsonPath ?? ""}`;
    const claim = claims.get(key) ?? {
      path: result.data.path,
      ...(jsonPath ? { jsonPath } : {}),
      taskIds: new Set<string>(),
    };
    const addId = (value: unknown): void => {
      if (typeof value === "string" && value) {
        claim.taskIds.add(value);
      }
    };
    for (const id of Array.isArray(result.data.taskIds)
      ? result.data.taskIds
      : []) {
      addId(id);
    }
    claims.set(key, claim);
  }

  return [...claims.values()].filter((claim) => claim.taskIds.size > 0);
};

const refreshRalphJsonTaskLeases = async (
  flow: RalphFlow,
  context: RalphResultContext,
  workspaceRoot: string,
): Promise<number> => {
  let refreshed = 0;

  for (const claim of collectRalphJsonTaskClaims(flow, context)) {
    const claimPath = await resolveWorkspaceContainedMutationPath(
      claim.path,
      workspaceRoot,
    );
    const mutationLock = await acquireRalphFileMutationLock(
      claimPath,
      context.runId,
    );
    try {
      const json = await readJsonFile(claimPath);
      const taskArray = getJsonTaskArray(json, claim.jsonPath);
      if (!taskArray) {
        throw new Error(
          `Could not refresh JSON task leases because ${claim.jsonPath ?? "tasks"} is missing in ${claimPath}.`,
        );
      }
      const now = new Date().toISOString();
      const expiresAt = new Date(
        Date.now() + DEFAULT_RALPH_WORK_ITEM_LEASE_MS,
      ).toISOString();
      let changed = false;
      for (const task of taskArray.tasks) {
        const id = getJsonTaskId(task);
        const lease = readJsonTaskLease(task);
        if (
          !id ||
          !claim.taskIds.has(id) ||
          lease?.ownerId !== context.runId ||
          !isInProgressJsonTask(task)
        ) {
          continue;
        }
        task.lease = {
          ...lease,
          heartbeatAt: now,
          expiresAt,
        } satisfies RalphJsonTaskLease;
        task.updatedAt = now;
        changed = true;
        refreshed += 1;
      }
      if (changed) {
        await writeUtilityJsonOutput(claimPath, json);
      }
    } finally {
      await mutationLock.release();
    }
  }

  return refreshed;
};

const executeFileExistsUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
): Promise<RalphBlockExecutionResult> => {
  const rawPath = utility.path?.trim();

  if (!rawPath) {
    return createUtilityResult(
      block,
      "ERROR",
      "File exists utility requires path.",
    );
  }

  const path = resolveUtilityPath(rawPath, config.workspaceRoot);

  try {
    const fileStat = await stat(path);
    const kind = fileStat.isDirectory()
      ? "directory"
      : fileStat.isFile()
        ? "file"
        : "other";

    return createUtilityResult(
      block,
      "EXISTS",
      `${block.title} found ${path}.`,
      {
        path,
        kind,
        size: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString(),
      },
      "completed",
    );
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return createUtilityResult(
        block,
        "MISSING",
        `${block.title} did not find ${path}.`,
        { path },
        "completed",
      );
    }

    return createRalphBlockExecutionErrorResult(block, error);
  }
};

const executeDeleteFileUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
): Promise<RalphBlockExecutionResult> => {
  const rawPath = utility.path?.trim();

  if (!rawPath) {
    return createUtilityResult(
      block,
      "ERROR",
      "Delete file utility requires path.",
    );
  }

  try {
    const path = await resolveWorkspaceContainedMutationPath(
      rawPath,
      config.workspaceRoot,
      { preserveRequestedPath: true },
    );
    const fileStat = await lstat(path);

    if (fileStat.isDirectory()) {
      return createUtilityResult(
        block,
        "ERROR",
        `${block.title} requires a file path, but ${path} is a directory.`,
      );
    }

    await unlink(path);

    return createUtilityResult(
      block,
      "SUCCESS",
      `${block.title} deleted ${path}.`,
      { path },
    );
  } catch (error) {
    if (isFileNotFoundError(error)) {
      const path = await resolveWorkspaceContainedMutationPath(
        rawPath,
        config.workspaceRoot,
        { preserveRequestedPath: true },
      );

      return createUtilityResult(
        block,
        "NOT_FOUND",
        `${block.title} did not find ${path}.`,
        { path },
        "completed",
      );
    }

    return createRalphBlockExecutionErrorResult(block, error);
  }
};

const executeMoveFileUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
): Promise<RalphBlockExecutionResult> => {
  const rawPath = utility.path?.trim();
  const rawOutputPath = utility.outputPath?.trim();

  if (!rawPath || !rawOutputPath) {
    return createUtilityResult(
      block,
      "ERROR",
      "Move file utility requires path and outputPath.",
    );
  }

  const from = await resolveWorkspaceContainedMutationPath(
    rawPath,
    config.workspaceRoot,
    { preserveRequestedPath: true },
  );
  const to = await resolveWorkspaceContainedMutationPath(
    rawOutputPath,
    config.workspaceRoot,
    { preserveRequestedPath: true },
  );

  try {
    const fileStat = await lstat(from);

    if (fileStat.isDirectory()) {
      return createUtilityResult(
        block,
        "ERROR",
        `${block.title} requires a file path, but ${from} is a directory.`,
      );
    }

    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);

    return createUtilityResult(
      block,
      "SUCCESS",
      `${block.title} moved ${from}.`,
      {
        from,
        to,
      },
    );
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return createUtilityResult(
        block,
        "NOT_FOUND",
        `${block.title} did not find ${from}.`,
        { from, to },
        "completed",
      );
    }

    return createRalphBlockExecutionErrorResult(block, error);
  }
};

const createArchiveFilePath = async (
  sourcePath: string,
  utility: RalphUtilityConfig,
  workspaceRoot: string,
): Promise<string> => {
  const rawOutputPath = utility.outputPath?.trim();

  if (rawOutputPath) {
    return resolveWorkspaceContainedMutationPath(rawOutputPath, workspaceRoot, {
      preserveRequestedPath: true,
    });
  }

  const archiveRoot = await resolveWorkspaceContainedMutationPath(
    utility.rootPath?.trim() || ".machdoch/ralph/archive",
    workspaceRoot,
    { preserveRequestedPath: true },
  );
  const parsedName = basename(sourcePath);
  const extension = extname(parsedName);
  const stem = extension ? parsedName.slice(0, -extension.length) : parsedName;
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");

  return join(archiveRoot, `${stem}-${timestamp}${extension}`);
};

const executeArchiveFileUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
): Promise<RalphBlockExecutionResult> => {
  const rawPath = utility.path?.trim();

  if (!rawPath) {
    return createUtilityResult(
      block,
      "ERROR",
      "Archive file utility requires path.",
    );
  }

  const from = await resolveWorkspaceContainedMutationPath(
    rawPath,
    config.workspaceRoot,
    { preserveRequestedPath: true },
  );
  const to = await createArchiveFilePath(from, utility, config.workspaceRoot);

  try {
    const fileStat = await lstat(from);

    if (fileStat.isDirectory()) {
      return createUtilityResult(
        block,
        "ERROR",
        `${block.title} requires a file path, but ${from} is a directory.`,
      );
    }

    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);

    return createUtilityResult(
      block,
      "SUCCESS",
      `${block.title} archived ${from}.`,
      {
        from,
        to,
      },
    );
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return createUtilityResult(
        block,
        "NOT_FOUND",
        `${block.title} did not find ${from}.`,
        { from, to },
        "completed",
      );
    }

    return createRalphBlockExecutionErrorResult(block, error);
  }
};

interface RalphCounterFile {
  counters?: Record<string, Record<string, RalphCounterState>>;
}

interface RalphCounterState {
  count: number;
  updatedAt: string;
}

const readCounterFile = async (path: string): Promise<RalphCounterFile> => {
  try {
    const value = await readJsonFile(path);

    return isRecord(value) ? (value as RalphCounterFile) : {};
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return {};
    }

    throw error;
  }
};

const executeLoopCounterUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  context: RalphResultContext,
): Promise<RalphBlockExecutionResult> => {
  const path = await resolveWorkspaceContainedMutationPath(
    utility.path?.trim() || ".machdoch/ralph/counters.json",
    config.workspaceRoot,
  );
  const counterName = utility.counterName?.trim() || block.id;
  const counterKey = utility.counterKey?.trim() || context.runId;
  let mutationLock: RalphFileMutationLock | undefined;

  try {
    mutationLock = await acquireRalphFileMutationLock(path, context.runId);
    const file = await readCounterFile(path);
    const counters = isRecord(file.counters) ? { ...file.counters } : {};
    const retentionCutoff = Date.now() - 30 * 24 * 60 * 60_000;
    for (const [name, rawGroup] of Object.entries(counters)) {
      if (!isRecord(rawGroup)) {
        delete counters[name];
        continue;
      }
      const retainedEntries = Object.entries(rawGroup)
        .filter(([, state]) => {
          if (!isRecord(state) || typeof state.updatedAt !== "string") {
            return true;
          }
          const updatedAt = Date.parse(state.updatedAt);
          return !Number.isFinite(updatedAt) || updatedAt >= retentionCutoff;
        })
        .slice(-10_000);
      counters[name] = Object.fromEntries(retainedEntries);
    }
    const group = isRecord(counters[counterName])
      ? { ...counters[counterName] }
      : {};
    const currentState = isRecord(group[counterKey])
      ? group[counterKey]
      : undefined;
    const currentCount =
      typeof currentState?.count === "number" &&
      Number.isFinite(currentState.count)
        ? currentState.count
        : 0;
    const limit =
      typeof utility.maxAttempts === "number" ? utility.maxAttempts : null;
    const limitReached =
      !utility.reset && limit !== null && currentCount >= limit;
    const count = utility.reset
      ? 0
      : limitReached
        ? currentCount
        : currentCount + 1;

    group[counterKey] = {
      count,
      updatedAt: new Date().toISOString(),
    };
    counters[counterName] = group;
    await writeUtilityJsonOutput(path, { counters });

    return createUtilityResult(
      block,
      limitReached ? "LIMIT_REACHED" : "CONTINUE",
      limitReached
        ? `${block.title} reached loop limit ${limit}.`
        : `${block.title} counted ${count}.`,
      {
        path,
        counterName,
        counterKey,
        count,
        limit,
        reset: utility.reset === true,
      },
      "completed",
    );
  } catch (error) {
    return createRalphBlockExecutionErrorResult(block, error);
  } finally {
    await mutationLock?.release();
  }
};

const getScopeRegistryFlowAlias = (utility: RalphUtilityConfig): string => {
  return utility.flowAlias?.trim() || "ralph-flow";
};

const getScopeRegistryStrategy = (
  utility: RalphUtilityConfig,
): RalphScopeSelectionStrategy => {
  return (
    normalizeRalphScopeSelectionStrategy(utility.strategy) ?? "round-robin"
  );
};

const resolveScopeRegistryUtilityPath = async (
  utility: RalphUtilityConfig,
  workspaceRoot: string,
): Promise<string> => {
  const flowAlias = getScopeRegistryFlowAlias(utility);
  const path =
    utility.registryPath?.trim() ||
    utility.path?.trim() ||
    createDefaultRalphScopeRegistryPath(flowAlias);

  return resolveWorkspaceContainedMutationPath(path, workspaceRoot);
};

const resolveScopeScanRootPath = (
  utility: RalphUtilityConfig,
  workspaceRoot: string,
): string => {
  const path = resolveUtilityPath(
    utility.rootPath?.trim() || ".",
    workspaceRoot,
  );

  if (!isResolvedPathInside(path, workspaceRoot)) {
    throw new Error("Scope scan root must stay inside the workspace.");
  }

  const relativePath = relative(resolve(workspaceRoot), path);

  return relativePath ? relativePath.replace(/\\/gu, "/") : ".";
};

const getScopeEvidenceInput = (
  utility: RalphUtilityConfig,
  context: RalphResultContext,
) => {
  const input =
    utility.input !== undefined
      ? parseRalphUtilityJsonValue(utility.input)
      : context.lastResult?.data;
  const evidence = parseRalphScopeEvidence(input);

  if (evidence) {
    return evidence;
  }

  if (isRecord(input)) {
    return parseRalphScopeEvidence(input.evidence);
  }

  return undefined;
};

const maybeWriteScopeRegistryMarkdown = async (
  utility: RalphUtilityConfig,
  registryPath: string,
  registry: Awaited<ReturnType<typeof readRalphScopeRegistryFile>>,
  workspaceRoot: string,
): Promise<string | undefined> => {
  if (!utility.includeMarkdown && !utility.outputPath?.trim()) {
    return undefined;
  }

  const markdownPath = await resolveWorkspaceContainedMutationPath(
    utility.outputPath?.trim() ||
      createRalphScopeRegistryMarkdownPath(registryPath),
    workspaceRoot,
  );

  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFileAtomically(
    markdownPath,
    formatRalphScopeRegistryMarkdown(registry),
    "utf8",
  );

  return markdownPath;
};

const executeScanScopeEvidenceUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
): Promise<RalphBlockExecutionResult> => {
  try {
    const rootPath = resolveScopeScanRootPath(utility, config.workspaceRoot);
    const resultLimit =
      typeof utility.maxResults === "number"
        ? Math.max(1, Math.min(100_000, Math.trunc(utility.maxResults)))
        : undefined;
    const scanOptions: Parameters<typeof discoverRalphScopeEvidence>[1] = {
      rootPath,
      excludePaths: parseRalphScopeExcludePaths(utility.excludePaths),
    };

    if (typeof utility.maxDepth === "number") {
      scanOptions.maxDepth = Math.max(
        0,
        Math.min(64, Math.trunc(utility.maxDepth)),
      );
    }

    if (resultLimit !== undefined) {
      scanOptions.maxResults = resultLimit + 1;
    }

    const discoveredEvidence = await discoverRalphScopeEvidence(
      config.workspaceRoot,
      scanOptions,
    );
    const truncated =
      resultLimit !== undefined &&
      discoveredEvidence.scopes.length > resultLimit;
    const evidence = {
      ...discoveredEvidence,
      scopes:
        resultLimit === undefined
          ? discoveredEvidence.scopes
          : discoveredEvidence.scopes.slice(0, resultLimit),
      truncated,
      ...(resultLimit !== undefined ? { limit: resultLimit } : {}),
      ...(typeof utility.maxDepth === "number"
        ? {
            depthLimit: Math.max(0, Math.min(64, Math.trunc(utility.maxDepth))),
          }
        : {}),
    };
    const output = evidence.scopes.length > 0 ? "SUCCESS" : "EMPTY";

    return createUtilityResult(
      block,
      output,
      `${block.title} discovered ${evidence.scopes.length} scope(s)${truncated ? ` (truncated at ${resultLimit})` : ""}.`,
      evidence,
      output === "SUCCESS" ? "completed" : "completed",
    );
  } catch (error) {
    return createRalphBlockExecutionErrorResult(block, error);
  }
};

const executeUpdateScopeRegistryUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  context: RalphResultContext,
): Promise<RalphBlockExecutionResult> => {
  let mutationLock: RalphFileMutationLock | undefined;
  try {
    const evidence = getScopeEvidenceInput(utility, context);
    if (!evidence || evidence.scopes.length === 0) {
      return createUtilityResult(
        block,
        "EMPTY",
        `${block.title} did not receive scope evidence.`,
        { evidence },
        "completed",
      );
    }

    const flowAlias = getScopeRegistryFlowAlias(utility);
    const strategy = getScopeRegistryStrategy(utility);
    const registryPath = await resolveScopeRegistryUtilityPath(
      utility,
      config.workspaceRoot,
    );
    mutationLock = await acquireRalphFileMutationLock(
      registryPath,
      context.runId,
    );
    const existingRegistry = await readRalphScopeRegistryFile(registryPath, {
      flowAlias,
      strategy,
    });
    const update = updateRalphScopeRegistryFromEvidence(
      existingRegistry,
      evidence,
      { flowAlias, strategy },
    );

    await writeRalphScopeRegistryFile(registryPath, update.registry);
    const markdownPath = await maybeWriteScopeRegistryMarkdown(
      utility,
      registryPath,
      update.registry,
      config.workspaceRoot,
    );

    return createUtilityResult(
      block,
      "SUCCESS",
      `${block.title} wrote ${update.registry.scopes.filter((scope) => scope.status === "active").length} active scope(s).`,
      {
        registryPath,
        ...(markdownPath ? { markdownPath } : {}),
        added: update.added,
        updated: update.updated,
        removed: update.removed,
        registry: update.registry,
      },
    );
  } catch (error) {
    return createRalphBlockExecutionErrorResult(block, error);
  } finally {
    await mutationLock?.release();
  }
};

const executeBeginScopeCycleUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  context: RalphResultContext,
): Promise<RalphBlockExecutionResult> => {
  let mutationLock: RalphFileMutationLock | undefined;
  try {
    const flowAlias = getScopeRegistryFlowAlias(utility);
    const strategy = getScopeRegistryStrategy(utility);
    const registryPath = await resolveScopeRegistryUtilityPath(
      utility,
      config.workspaceRoot,
    );
    mutationLock = await acquireRalphFileMutationLock(
      registryPath,
      context.runId,
    );
    const registry = await readRalphScopeRegistryFile(registryPath, {
      flowAlias,
      strategy,
    });
    const cycle = beginRalphScopeRegistryCycle(registry);

    await writeRalphScopeRegistryFile(registryPath, cycle.registry);
    const markdownPath = await maybeWriteScopeRegistryMarkdown(
      utility,
      registryPath,
      cycle.registry,
      config.workspaceRoot,
    );

    return createUtilityResult(
      block,
      "SUCCESS",
      cycle.cycleStarted
        ? `${block.title} started scope cycle ${cycle.registry.selection.cycle}.`
        : `${block.title} retained the current scope cycle.`,
      {
        registryPath,
        ...(markdownPath ? { markdownPath } : {}),
        cycleStarted: cycle.cycleStarted,
        cycle: cycle.registry.selection.cycle,
        registry: cycle.registry,
      },
      "completed",
    );
  } catch (error) {
    return createRalphBlockExecutionErrorResult(block, error);
  } finally {
    await mutationLock?.release();
  }
};

const executeSelectScopeUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  context: RalphResultContext,
): Promise<RalphBlockExecutionResult> => {
  let mutationLock: RalphFileMutationLock | undefined;
  try {
    const flowAlias = getScopeRegistryFlowAlias(utility);
    const strategy = getScopeRegistryStrategy(utility);
    const registryPath = await resolveScopeRegistryUtilityPath(
      utility,
      config.workspaceRoot,
    );
    mutationLock = await acquireRalphFileMutationLock(
      registryPath,
      context.runId,
    );
    const registry = await readRalphScopeRegistryFile(registryPath, {
      flowAlias,
      strategy,
    });
    const selectionOptions: Parameters<typeof selectRalphScopeFromRegistry>[1] =
      {
        strategy,
      };

    if (utility.forceNew !== undefined) {
      selectionOptions.forceNew = utility.forceNew;
    }
    const selection = selectRalphScopeFromRegistry(registry, selectionOptions);
    const availability = assessRalphScopeRegistryAvailability(
      selection.registry,
    );

    await writeRalphScopeRegistryFile(registryPath, selection.registry);

    if (!selection.scope) {
      if (availability.status === "ready") {
        throw new Error(
          `${block.title} reported ready scope availability without selecting a scope.`,
        );
      }

      return createUtilityResult(
        block,
        availability.status === "exhausted" ? "EXHAUSTED" : "DEFERRED",
        availability.status === "exhausted"
          ? `${block.title} confirmed the current scope cycle is exhausted.`
          : `${block.title} found only temporarily unavailable scopes.`,
        { registryPath, registry: selection.registry, availability },
        "completed",
      );
    }

    return createUtilityResult(
      block,
      "SELECTED",
      `${block.title} selected ${selection.scope.id}.`,
      {
        registryPath,
        scope: selection.scope,
        ...(selection.scopeCluster
          ? { scopeCluster: selection.scopeCluster }
          : {}),
        strategy,
        reusedCurrentScope: selection.reusedCurrentScope,
        cycle: selection.registry.selection.cycle,
        availability,
      },
      "completed",
    );
  } catch (error) {
    return createRalphBlockExecutionErrorResult(block, error);
  } finally {
    await mutationLock?.release();
  }
};

const executeMarkScopeResultUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  context: RalphResultContext,
): Promise<RalphBlockExecutionResult> => {
  let mutationLock: RalphFileMutationLock | undefined;
  try {
    const flowAlias = getScopeRegistryFlowAlias(utility);
    const strategy = getScopeRegistryStrategy(utility);
    const registryPath = await resolveScopeRegistryUtilityPath(
      utility,
      config.workspaceRoot,
    );
    mutationLock = await acquireRalphFileMutationLock(
      registryPath,
      context.runId,
    );
    const registry = await readRalphScopeRegistryFile(registryPath, {
      flowAlias,
      strategy,
    });
    if (!isRalphScopeOutcome(utility.scopeOutcome)) {
      throw new Error(`${block.title} requires a valid scope outcome.`);
    }

    const markOptions: Parameters<typeof markRalphScopeRegistryResult>[1] = {
      outcome: utility.scopeOutcome,
    };

    if (utility.scopeId !== undefined) {
      markOptions.scopeId = utility.scopeId;
    }

    if (context.lastResult?.summary !== undefined) {
      markOptions.summary = context.lastResult.summary;
    }

    const result = markRalphScopeRegistryResult(registry, markOptions);

    if (!result.scope) {
      return createUtilityResult(
        block,
        "NOT_FOUND",
        `${block.title} did not find the current scope.`,
        { registryPath, registry },
        "completed",
      );
    }

    await writeRalphScopeRegistryFile(registryPath, result.registry);
    const markdownPath = await maybeWriteScopeRegistryMarkdown(
      utility,
      registryPath,
      result.registry,
      config.workspaceRoot,
    );

    return createUtilityResult(
      block,
      "SUCCESS",
      `${block.title} marked ${result.scope.id}.`,
      {
        registryPath,
        ...(markdownPath ? { markdownPath } : {}),
        scope: result.scope,
        cycleCompleted: result.cycleCompleted,
        registry: result.registry,
      },
    );
  } catch (error) {
    return createRalphBlockExecutionErrorResult(block, error);
  } finally {
    await mutationLock?.release();
  }
};

const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
};

const globToRegExp = (glob: string): RegExp => {
  const normalized = glob.replace(/\\/gu, "/");
  let pattern = "";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (char === "*" && next === "*") {
      if (normalized[index + 2] === "/") {
        pattern += "(?:.*/)?";
        index += 2;
      } else {
        pattern += ".*";
        index += 1;
      }
      continue;
    }

    if (char === "*") {
      pattern += "[^/]*";
      continue;
    }

    if (char === "?") {
      pattern += "[^/]";
      continue;
    }

    pattern += escapeRegExp(char ?? "");
  }

  return new RegExp(`^${pattern}$`, "iu");
};

const searchFilesRecursive = async (
  rootPath: string,
  options: {
    basePath: string;
    normalizedPattern?: string;
    glob?: RegExp;
    maxResults: number;
    signal?: AbortSignal;
  },
  results: string[],
): Promise<void> => {
  if (options.signal?.aborted) {
    throw new Error("Ralph run stopped.");
  }

  if (results.length >= options.maxResults) {
    return;
  }

  const entries = await readdir(rootPath, { withFileTypes: true });

  for (const entry of entries) {
    const path = join(rootPath, entry.name);

    if (entry.isDirectory()) {
      if (DEFAULT_RALPH_SEARCH_EXCLUDED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      await searchFilesRecursive(path, options, results);

      if (results.length >= options.maxResults) {
        return;
      }

      continue;
    }

    const matchesPattern =
      options.normalizedPattern === undefined ||
      entry.name.toLowerCase().includes(options.normalizedPattern) ||
      path.toLowerCase().includes(options.normalizedPattern);
    const relativeFilePath = relative(options.basePath, path).replace(
      /\\/gu,
      "/",
    );
    const matchesGlob =
      options.glob === undefined ||
      options.glob.test(relativeFilePath) ||
      options.glob.test(entry.name);

    if (entry.isFile() && matchesPattern && matchesGlob) {
      results.push(path);

      if (results.length >= options.maxResults) {
        return;
      }
    }
  }
};

const executeSearchFilesUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  signal?: AbortSignal,
): Promise<RalphBlockExecutionResult> => {
  try {
    const rootPath = resolveUtilityPath(utility.rootPath, config.workspaceRoot);
    const results: string[] = [];
    const limit =
      typeof utility.maxResults === "number"
        ? Math.max(1, Math.trunc(utility.maxResults))
        : DEFAULT_RALPH_UTILITY_MAX_SEARCH_RESULTS;

    await searchFilesRecursive(
      rootPath,
      {
        basePath: rootPath,
        ...(utility.pattern
          ? { normalizedPattern: utility.pattern.toLowerCase() }
          : {}),
        ...(utility.glob ? { glob: globToRegExp(utility.glob) } : {}),
        maxResults: limit + 1,
        ...(signal ? { signal } : {}),
      },
      results,
    );

    const truncated = results.length > limit;
    const retainedResults = results.slice(0, limit);
    const data = {
      rootPath,
      results: retainedResults,
      count: retainedResults.length,
      truncated,
      limit,
    };

    return createUtilityResult(
      block,
      retainedResults.length > 0 ? "SUCCESS" : "EMPTY",
      `${block.title} found ${retainedResults.length} file(s)${truncated ? ` (truncated at ${limit})` : ""}.`,
      data,
      "completed",
    );
  } catch (error) {
    return createRalphBlockExecutionErrorResult(block, error);
  }
};

interface RalphUiAnalyzeIssue {
  severity: "error" | "warning" | "info";
  category: string;
  message: string;
  selector?: string;
  evidence?: Record<string, unknown>;
}

interface RalphUiAnalyzeElementSummary {
  selector?: string;
  text?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

interface RalphUiAnalyzeHeadingSummary {
  level: number;
  text: string;
}

interface RalphUiAnalyzeViewportAnalysis {
  viewport: {
    width: number;
    height: number;
    scrollWidth: number;
    scrollHeight: number;
    horizontalOverflowPixels: number;
  };
  viewportMeta: {
    present: boolean;
    content?: string;
    hasDeviceWidth: boolean;
    hasInitialScale: boolean;
    warnings: string[];
  };
  structure: {
    headings: RalphUiAnalyzeHeadingSummary[];
    h1Count: number;
    landmarkCounts: Record<string, number>;
    navigationCount: number;
    mainCount: number;
    formCount: number;
    interactiveCount: number;
    imageCount: number;
    missingAltImageCount: number;
  };
  textDensity: {
    characterCount: number;
    wordCount: number;
    blockCount: number;
    denseBlockCount: number;
    maxBlockCharacters: number;
    denseBlocks: RalphUiAnalyzeElementSummary[];
  };
  layout: {
    hasHorizontalOverflow: boolean;
    clippedElementCount: number;
    clippedElements: RalphUiAnalyzeElementSummary[];
    overflowElementCount: number;
    overflowElements: RalphUiAnalyzeElementSummary[];
    overlapCandidateCount: number;
    overlapCandidates: Array<{
      first: RalphUiAnalyzeElementSummary;
      second: RalphUiAnalyzeElementSummary;
      overlapArea: number;
    }>;
  };
  interaction: {
    smallTargetCount: number;
    smallTargets: RalphUiAnalyzeElementSummary[];
  };
  contrast: {
    checkedTextElementCount: number;
    lowContrastCount: number;
    lowContrastElements: Array<
      RalphUiAnalyzeElementSummary & {
        contrastRatio: number;
        requiredRatio: number;
      }
    >;
  };
}

interface RalphUiAnalyzeEvaluation {
  issues: RalphUiAnalyzeIssue[];
  analysis?: RalphUiAnalyzeViewportAnalysis;
}

interface RalphUiAnalyzeViewportData {
  name: string;
  width: number;
  height: number;
  url: string;
  title: string;
  screenshotPath?: string;
  ariaSnapshot?: string;
  visibleText?: string;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  issues: RalphUiAnalyzeIssue[];
  analysis?: RalphUiAnalyzeViewportAnalysis;
}

interface RalphUiAnalyzeData {
  adapter: RalphUiAnalyzeAdapter | "browser";
  targetUrl?: string;
  screenshotPath?: string;
  server: {
    mode: RalphUiAnalyzeServerMode;
    healthUrl?: string;
    ready?: boolean;
    status?: number;
    error?: string;
    started?: boolean;
    reused?: boolean;
    pid?: number;
  };
  viewports: RalphUiAnalyzeViewportData[];
  artifacts: {
    directory?: string;
    screenshots: string[];
  };
  issues: Array<RalphUiAnalyzeIssue & { viewport?: string }>;
  mcpResult?: unknown;
  summary: string;
}

const sanitizeArtifactName = (value: string): string => {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 80) || "artifact"
  );
};

const createUiAnalyzeArtifactDirectory = async (
  workspaceRoot: string,
  runId: string | undefined,
  blockId: string,
): Promise<string> => {
  const directory = join(
    getRalphArtifactDirectory(workspaceRoot),
    sanitizeArtifactName(runId ?? `run-${Date.now()}`),
    sanitizeArtifactName(blockId),
  );

  await mkdir(directory, { recursive: true });

  return directory;
};

const getUiAnalyzeChecks = (
  utility: RalphUtilityConfig,
): Required<RalphUiAnalyzeChecks> => ({
  screenshots: utility.checks?.screenshots ?? true,
  accessibility: utility.checks?.accessibility ?? true,
  console: utility.checks?.console ?? true,
  network: utility.checks?.network ?? true,
  responsive: utility.checks?.responsive ?? true,
  trace: utility.checks?.trace ?? false,
});

const getUiAnalyzeViewports = (
  utility: RalphUtilityConfig,
): RalphUiAnalyzeViewport[] => {
  return utility.viewports && utility.viewports.length > 0
    ? utility.viewports
    : DEFAULT_RALPH_UI_ANALYZE_VIEWPORTS.map((viewport) => ({ ...viewport }));
};

const resolveUiAnalyzeAdapter = (
  utility: RalphUtilityConfig,
): RalphUiAnalyzeAdapter | "browser" => {
  if (utility.adapter && utility.adapter !== "auto") {
    return utility.adapter;
  }

  if (utility.targetUrl?.trim() || utility.url?.trim()) {
    return "browser";
  }

  if (utility.screenshotPath?.trim()) {
    return "image";
  }

  return "browser";
};

const resolveUiAnalyzeTargetUrl = (
  utility: RalphUtilityConfig,
): string | undefined => {
  return utility.targetUrl?.trim() || utility.url?.trim() || undefined;
};

const isReadyHttpStatus = (status: number): boolean => {
  return (
    (status >= 200 && status < 400) ||
    status === 400 ||
    status === 401 ||
    status === 402 ||
    status === 403
  );
};

const checkUiAnalyzeServerReady = async (
  url: string | undefined,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ ready: boolean; status?: number; error?: string }> => {
  if (!url) {
    return { ready: true };
  }

  const abortController = new AbortController();
  const timeoutHandle =
    timeoutMs > 0
      ? setTimeout(() => {
          abortController.abort();
        }, timeoutMs)
      : undefined;
  const abortFromRun = (): void => {
    abortController.abort();
  };

  signal?.addEventListener("abort", abortFromRun, { once: true });

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: abortController.signal,
    });

    return {
      ready: isReadyHttpStatus(response.status),
      status: response.status,
    };
  } catch (error) {
    return {
      ready: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    signal?.removeEventListener("abort", abortFromRun);
  }
};

const launchUiAnalyzeBrowser = async (): Promise<{
  browser: PlaywrightBrowser;
  channel: PlaywrightBrowserChannel;
}> => {
  const playwrightModuleName: string = "playwright-core";
  const { chromium } = (await import(
    /* @vite-ignore */ playwrightModuleName
  )) as typeof import("playwright-core");
  const errors: string[] = [];

  for (const channel of RALPH_UI_BROWSER_CHANNELS) {
    let browser: PlaywrightBrowser | undefined;

    try {
      browser = await chromium.launch({
        channel,
        headless: true,
      });

      return { browser, channel };
    } catch (error) {
      if (browser) {
        await browser.close().catch(() => undefined);
      }

      errors.push(
        `${channel}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new Error(
    [
      "Could not launch an installed Chromium-based browser for UI analysis.",
      "Install Microsoft Edge or Google Chrome, or use a Tauri/Playwright MCP adapter.",
      ...errors,
    ].join("\n"),
  );
};

const normalizeUiAnalyzeIssue = (
  value: unknown,
): RalphUiAnalyzeIssue | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const severity = value.severity;
  const category = value.category;
  const message = value.message;

  if (severity !== "error" && severity !== "warning" && severity !== "info") {
    return undefined;
  }

  if (typeof category !== "string" || typeof message !== "string") {
    return undefined;
  }

  return {
    severity,
    category,
    message,
    ...(typeof value.selector === "string" ? { selector: value.selector } : {}),
    ...(isRecord(value.evidence) ? { evidence: value.evidence } : {}),
  };
};

const shouldIncludeUiAnalyzeIssue = (
  issue: RalphUiAnalyzeIssue,
  checks: Required<RalphUiAnalyzeChecks>,
): boolean => {
  if (
    issue.category === "accessibility" ||
    issue.category === "contrast" ||
    issue.category === "structure"
  ) {
    return checks.accessibility;
  }

  if (
    issue.category === "responsive" ||
    issue.category === "layout" ||
    issue.category === "interaction" ||
    issue.category === "text-density" ||
    issue.category === "viewport-meta"
  ) {
    return checks.responsive;
  }

  return checks.accessibility || checks.responsive;
};

const evaluateUiHeuristics = async (
  page: PlaywrightPage,
  checks: Required<RalphUiAnalyzeChecks>,
): Promise<RalphUiAnalyzeEvaluation> => {
  const evaluation = await page.evaluate(`(() => {
    const MAX_ISSUES = ${MAX_RALPH_UI_ANALYZE_ISSUES};
    const MAX_SAMPLES = 12;
    const issues = [];
    const round = (value) => Math.round(value * 100) / 100;
    const cssEscape = (value) => {
      if (window.CSS && typeof window.CSS.escape === "function") {
        return window.CSS.escape(value);
      }
      return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
    };
    const rectSummary = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: round(rect.x),
        y: round(rect.y),
        width: round(rect.width),
        height: round(rect.height),
      };
    };
    const textSnippet = (element) => {
      const text = (element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim();
      return text ? text.slice(0, 140) : undefined;
    };
    const selectorFor = (element) => {
      if (!element || !element.tagName) {
        return undefined;
      }
      const tag = element.tagName.toLowerCase();
      if (element.id) {
        return tag + "#" + cssEscape(element.id);
      }
      const testId = element.getAttribute("data-testid") || element.getAttribute("data-test-id");
      if (testId) {
        return tag + "[data-testid=\\"" + testId.replace(/"/g, "\\\\\\"") + "\\"]";
      }
      const ariaLabel = element.getAttribute("aria-label");
      if (ariaLabel && ariaLabel.length < 80) {
        return tag + "[aria-label=\\"" + ariaLabel.replace(/"/g, "\\\\\\"") + "\\"]";
      }
      const parts = [];
      let current = element;
      while (current && current !== document.body && parts.length < 4) {
        const currentTag = current.tagName.toLowerCase();
        let part = currentTag;
        const stableClass = Array.from(current.classList || [])
          .filter((className) => /^[a-zA-Z][a-zA-Z0-9_-]{1,40}$/.test(className))
          .slice(0, 2);
        if (stableClass.length > 0) {
          part += "." + stableClass.map(cssEscape).join(".");
        }
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(
            (sibling) => sibling.tagName === current.tagName,
          );
          if (siblings.length > 1) {
            part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
          }
        }
        parts.unshift(part);
        current = parent;
      }
      return parts.join(" > ") || tag;
    };
    const summarizeElement = (element, extra = {}) => {
      return {
        selector: selectorFor(element),
        text: textSnippet(element),
        ...rectSummary(element),
        ...extra,
      };
    };
    const add = (severity, category, message, element, evidence = {}) => {
      if (issues.length >= MAX_ISSUES) {
        return;
      }
      const selector = element ? selectorFor(element) : undefined;
      issues.push({
        severity,
        category,
        message,
        ...(selector ? { selector } : {}),
        evidence: {
          ...(element ? rectSummary(element) : {}),
          ...evidence,
        },
      });
    };
    const isVisible = (element) => {
      if (!element || !element.getBoundingClientRect) {
        return false;
      }
      const style = window.getComputedStyle(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number.parseFloat(style.opacity || "1") <= 0.01
      ) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const isDisabled = (element) => {
      return Boolean(
        element.disabled ||
          element.getAttribute("aria-disabled") === "true" ||
          element.closest("[aria-disabled='true']"),
      );
    };
    const body = document.body;
    const documentElement = document.documentElement;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const visibleText = body ? (body.innerText || "").trim() : "";

    if (!body || !visibleText) {
      add("warning", "content", "Page body has no visible text.");
    }

    const viewportMetaElement = document.querySelector("meta[name='viewport']");
    const viewportMetaContent = viewportMetaElement?.getAttribute("content")?.trim() || "";
    const viewportMetaWarnings = [];
    if (!viewportMetaElement) {
      viewportMetaWarnings.push("Missing viewport meta tag.");
      add("warning", "viewport-meta", "Page is missing a viewport meta tag.");
    } else {
      if (!/width\\s*=\\s*device-width/i.test(viewportMetaContent)) {
        viewportMetaWarnings.push("Viewport meta does not set width=device-width.");
        add("warning", "viewport-meta", "Viewport meta does not set width=device-width.", viewportMetaElement, {
          content: viewportMetaContent,
        });
      }
      if (!/initial-scale\\s*=\\s*1(?:\\.0+)?/i.test(viewportMetaContent)) {
        viewportMetaWarnings.push("Viewport meta does not set initial-scale=1.");
      }
    }

    const headingElements = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))
      .filter(isVisible);
    const headings = headingElements.slice(0, 24).map((heading) => ({
      level: Number.parseInt(heading.tagName.slice(1), 10),
      text: textSnippet(heading) || "",
    }));
    const h1Count = document.querySelectorAll("h1").length;
    if (h1Count === 0) {
      add("info", "structure", "Page has no h1 heading.");
    }
    if (h1Count > 1) {
      add("info", "structure", "Page has multiple h1 headings.", undefined, {
        h1Count,
      });
    }

    const imageElements = Array.from(document.images);
    const missingAltImages = imageElements.filter((image) => !image.hasAttribute("alt"));
    for (const image of missingAltImages.slice(0, MAX_SAMPLES)) {
      add("warning", "accessibility", "Image is missing an alt attribute.", image, {
        src: image.currentSrc || image.src || undefined,
      });
    }

    const interactiveSelector = [
      "button",
      "a[href]",
      "input",
      "textarea",
      "select",
      "summary",
      "[role='button']",
      "[role='link']",
      "[role='menuitem']",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    const interactiveElements = Array.from(document.querySelectorAll(interactiveSelector))
      .filter((element) => isVisible(element) && !isDisabled(element));
    for (const element of interactiveElements.slice(0, 80)) {
      const ariaLabel = element.getAttribute("aria-label") || element.getAttribute("aria-labelledby");
      const text = element.textContent ||
        element.getAttribute("value") ||
        element.getAttribute("placeholder") ||
        element.getAttribute("title") ||
        "";
      if (!ariaLabel && !text.trim()) {
        add("warning", "accessibility", "Interactive element may not have an accessible name.", element);
      }
    }

    for (const input of Array.from(document.querySelectorAll("input, textarea, select")).filter(isVisible)) {
      const id = input.id;
      const hasLabel = Boolean(
        input.getAttribute("aria-label") ||
        input.getAttribute("aria-labelledby") ||
        (id && document.querySelector("label[for='" + cssEscape(id) + "']")) ||
        input.closest("label")
      );
      if (!hasLabel) {
        add("warning", "accessibility", "Form control may be missing a label.", input);
      }
    }

    const horizontalOverflowPixels = Math.max(
      0,
      documentElement.scrollWidth - viewportWidth,
    );
    if (horizontalOverflowPixels > 2) {
      add("warning", "responsive", "Page has horizontal overflow.", undefined, {
        scrollWidth: documentElement.scrollWidth,
        viewportWidth,
        overflowPixels: horizontalOverflowPixels,
      });
    }

    const allVisibleElements = Array.from(document.querySelectorAll("body *")).filter(isVisible);
    const overflowElements = [];
    const clippedElements = [];
    for (const element of allVisibleElements) {
      if (overflowElements.length < MAX_SAMPLES) {
        const rect = element.getBoundingClientRect();
        if (rect.left < -1 || rect.right > viewportWidth + 1) {
          overflowElements.push(summarizeElement(element));
          add("warning", "layout", "Element extends beyond the viewport horizontally.", element, {
            viewportWidth,
          });
        }
      }

      if (clippedElements.length < MAX_SAMPLES) {
        const style = window.getComputedStyle(element);
        const clipsX = (style.overflowX === "hidden" || style.overflowX === "clip") &&
          element.scrollWidth > element.clientWidth + 2;
        const clipsY = (style.overflowY === "hidden" || style.overflowY === "clip") &&
          element.scrollHeight > element.clientHeight + 2;
        if (clipsX || clipsY) {
          clippedElements.push(summarizeElement(element, {
            scrollWidth: element.scrollWidth,
            scrollHeight: element.scrollHeight,
            clientWidth: element.clientWidth,
            clientHeight: element.clientHeight,
          }));
          add("warning", "layout", "Element content may be clipped by overflow settings.", element, {
            clipsX,
            clipsY,
            scrollWidth: element.scrollWidth,
            scrollHeight: element.scrollHeight,
            clientWidth: element.clientWidth,
            clientHeight: element.clientHeight,
          });
        }
      }
    }

    const smallTargets = [];
    for (const element of interactiveElements) {
      if (smallTargets.length >= MAX_SAMPLES) {
        break;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width < 44 || rect.height < 44) {
        smallTargets.push(summarizeElement(element));
        add("warning", "interaction", "Interactive target may be smaller than 44 by 44 CSS pixels.", element, {
          width: round(rect.width),
          height: round(rect.height),
        });
      }
    }

    const overlapCandidates = [];
    const overlapElements = interactiveElements.slice(0, 80);
    for (let firstIndex = 0; firstIndex < overlapElements.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < overlapElements.length; secondIndex += 1) {
        if (overlapCandidates.length >= MAX_SAMPLES) {
          break;
        }
        const first = overlapElements[firstIndex];
        const second = overlapElements[secondIndex];
        if (first.contains(second) || second.contains(first)) {
          continue;
        }
        const firstRect = first.getBoundingClientRect();
        const secondRect = second.getBoundingClientRect();
        const overlapWidth = Math.max(
          0,
          Math.min(firstRect.right, secondRect.right) - Math.max(firstRect.left, secondRect.left),
        );
        const overlapHeight = Math.max(
          0,
          Math.min(firstRect.bottom, secondRect.bottom) - Math.max(firstRect.top, secondRect.top),
        );
        const overlapArea = overlapWidth * overlapHeight;
        if (overlapArea > 8) {
          const candidate = {
            first: summarizeElement(first),
            second: summarizeElement(second),
            overlapArea: round(overlapArea),
          };
          overlapCandidates.push(candidate);
          add("warning", "layout", "Interactive elements appear to overlap.", first, {
            otherSelector: selectorFor(second),
            overlapArea: candidate.overlapArea,
          });
        }
      }
      if (overlapCandidates.length >= MAX_SAMPLES) {
        break;
      }
    }

    const textBlockElements = Array.from(document.querySelectorAll(
      "p,li,td,th,label,button,a,h1,h2,h3,h4,h5,h6,[role='button'],[role='link']",
    )).filter(isVisible);
    const textBlocks = textBlockElements.map((element) => {
      const text = textSnippet(element) || "";
      const fullText = (element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim();
      const words = fullText ? fullText.split(/\\s+/).length : 0;
      return {
        element,
        characters: fullText.length,
        words,
      };
    }).filter((entry) => entry.characters > 0);
    const denseBlocks = textBlocks
      .filter((entry) => entry.characters > 280 || entry.words > 70)
      .slice(0, MAX_SAMPLES)
      .map((entry) => summarizeElement(entry.element, {
        characters: entry.characters,
        words: entry.words,
      }));
    for (const block of denseBlocks.slice(0, 6)) {
      issues.push({
        severity: "info",
        category: "text-density",
        message: "Large dense text block may reduce scanability.",
        ...(block.selector ? { selector: block.selector } : {}),
        evidence: block,
      });
    }

    const parseColor = (value) => {
      const match = String(value).match(/rgba?\\(([^)]+)\\)/i);
      if (!match) {
        return undefined;
      }
      const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
      if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) {
        return undefined;
      }
      return {
        r: parts[0],
        g: parts[1],
        b: parts[2],
        a: Number.isFinite(parts[3]) ? parts[3] : 1,
      };
    };
    const relativeLuminance = (color) => {
      const transform = (channel) => {
        const value = channel / 255;
        return value <= 0.03928
          ? value / 12.92
          : Math.pow((value + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * transform(color.r) +
        0.7152 * transform(color.g) +
        0.0722 * transform(color.b);
    };
    const contrastRatio = (foreground, background) => {
      const foregroundLuminance = relativeLuminance(foreground);
      const backgroundLuminance = relativeLuminance(background);
      const lighter = Math.max(foregroundLuminance, backgroundLuminance);
      const darker = Math.min(foregroundLuminance, backgroundLuminance);
      return (lighter + 0.05) / (darker + 0.05);
    };
    const solidBackgroundFor = (element) => {
      let current = element;
      while (current && current !== document.documentElement) {
        const background = parseColor(window.getComputedStyle(current).backgroundColor);
        if (background && background.a >= 0.95) {
          return background;
        }
        current = current.parentElement;
      }
      const documentBackground = parseColor(window.getComputedStyle(document.body).backgroundColor);
      return documentBackground && documentBackground.a >= 0.95
        ? documentBackground
        : undefined;
    };
    const textElementsForContrast = allVisibleElements
      .filter((element) => {
        const text = textSnippet(element);
        return Boolean(text && text.length > 0);
      })
      .slice(0, 160);
    const lowContrastElements = [];
    let checkedTextElementCount = 0;
    for (const element of textElementsForContrast) {
      if (lowContrastElements.length >= MAX_SAMPLES) {
        break;
      }
      const style = window.getComputedStyle(element);
      const foreground = parseColor(style.color);
      const background = solidBackgroundFor(element);
      if (!foreground || !background) {
        continue;
      }
      checkedTextElementCount += 1;
      const fontSize = Number.parseFloat(style.fontSize || "16");
      const fontWeight = Number.parseInt(style.fontWeight || "400", 10);
      const requiredRatio = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700)
        ? 3
        : 4.5;
      const ratio = contrastRatio(foreground, background);
      if (ratio < requiredRatio) {
        const summary = summarizeElement(element, {
          contrastRatio: round(ratio),
          requiredRatio,
        });
        lowContrastElements.push(summary);
        add("warning", "contrast", "Text may not meet computed contrast requirements.", element, {
          contrastRatio: summary.contrastRatio,
          requiredRatio,
        });
      }
    }

    const landmarkCounts = {
      header: document.querySelectorAll("header,[role='banner']").length,
      nav: document.querySelectorAll("nav,[role='navigation']").length,
      main: document.querySelectorAll("main,[role='main']").length,
      aside: document.querySelectorAll("aside,[role='complementary']").length,
      footer: document.querySelectorAll("footer,[role='contentinfo']").length,
      search: document.querySelectorAll("[role='search']").length,
    };
    const words = visibleText ? visibleText.split(/\\s+/).length : 0;
    const analysis = {
      viewport: {
        width: viewportWidth,
        height: viewportHeight,
        scrollWidth: documentElement.scrollWidth,
        scrollHeight: documentElement.scrollHeight,
        horizontalOverflowPixels,
      },
      viewportMeta: {
        present: Boolean(viewportMetaElement),
        ...(viewportMetaContent ? { content: viewportMetaContent } : {}),
        hasDeviceWidth: /width\\s*=\\s*device-width/i.test(viewportMetaContent),
        hasInitialScale: /initial-scale\\s*=\\s*1(?:\\.0+)?/i.test(viewportMetaContent),
        warnings: viewportMetaWarnings,
      },
      structure: {
        headings,
        h1Count,
        landmarkCounts,
        navigationCount: landmarkCounts.nav,
        mainCount: landmarkCounts.main,
        formCount: document.forms.length,
        interactiveCount: interactiveElements.length,
        imageCount: imageElements.length,
        missingAltImageCount: missingAltImages.length,
      },
      textDensity: {
        characterCount: visibleText.length,
        wordCount: words,
        blockCount: textBlocks.length,
        denseBlockCount: denseBlocks.length,
        maxBlockCharacters: textBlocks.reduce(
          (max, entry) => Math.max(max, entry.characters),
          0,
        ),
        denseBlocks,
      },
      layout: {
        hasHorizontalOverflow: horizontalOverflowPixels > 2,
        clippedElementCount: clippedElements.length,
        clippedElements,
        overflowElementCount: overflowElements.length,
        overflowElements,
        overlapCandidateCount: overlapCandidates.length,
        overlapCandidates,
      },
      interaction: {
        smallTargetCount: smallTargets.length,
        smallTargets,
      },
      contrast: {
        checkedTextElementCount,
        lowContrastCount: lowContrastElements.length,
        lowContrastElements,
      },
    };

    return {
      issues: issues.slice(0, MAX_ISSUES),
      analysis,
    };
  })()`);

  if (!isRecord(evaluation)) {
    return { issues: [] };
  }

  const rawIssues = Array.isArray(evaluation.issues) ? evaluation.issues : [];
  const issues = rawIssues
    .map(normalizeUiAnalyzeIssue)
    .filter((issue): issue is RalphUiAnalyzeIssue => Boolean(issue))
    .filter((issue) => shouldIncludeUiAnalyzeIssue(issue, checks))
    .slice(0, MAX_RALPH_UI_ANALYZE_ISSUES);

  return {
    issues,
    ...(isRecord(evaluation.analysis)
      ? {
          analysis:
            evaluation.analysis as unknown as RalphUiAnalyzeViewportAnalysis,
        }
      : {}),
  };
};

const captureUiAnalyzeViewport = async (
  browser: PlaywrightBrowser,
  targetUrl: string,
  viewport: RalphUiAnalyzeViewport,
  utility: RalphUtilityConfig,
  artifactDirectory: string,
  signal: AbortSignal | undefined,
): Promise<RalphUiAnalyzeViewportData> => {
  if (signal?.aborted) {
    throw new Error("Ralph run stopped.");
  }

  const timeoutMs = getUtilityTimeoutMs(
    utility,
    DEFAULT_RALPH_UI_ANALYZE_TIMEOUT_MS,
  );
  const checks = getUiAnalyzeChecks(utility);
  const context = await browser.newContext({
    viewport: {
      width: viewport.width,
      height: viewport.height,
    },
  });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];

  if (checks.console) {
    page.on("console", (message: PlaywrightConsoleMessage) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    page.on("pageerror", (error: Error) => {
      pageErrors.push(error.message);
    });
  }

  if (checks.network) {
    page.on("requestfailed", (request: PlaywrightRequest) => {
      failedRequests.push(
        `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`.trim(),
      );
    });
  }

  try {
    page.setDefaultTimeout(timeoutMs);
    await page.goto(targetUrl, {
      waitUntil: utility.waitUntil ?? "domcontentloaded",
      timeout: timeoutMs,
    });

    const viewportName = sanitizeArtifactName(
      viewport.name ?? `${viewport.width}x${viewport.height}`,
    );
    const screenshotPath = checks.screenshots
      ? join(artifactDirectory, `${viewportName}.png`)
      : undefined;

    if (screenshotPath) {
      await page.screenshot({
        path: screenshotPath,
        fullPage: utility.fullPage ?? true,
        animations: "disabled",
        caret: "hide",
      });
    }

    const [title, visibleText, ariaSnapshot, evaluation] = await Promise.all([
      page.title(),
      page
        .locator("body")
        .innerText({ timeout: timeoutMs })
        .catch(() => ""),
      checks.accessibility
        ? page
            .locator("body")
            .ariaSnapshot({ mode: "ai", depth: 8, timeout: timeoutMs })
            .catch(
              (error: unknown) =>
                `ARIA snapshot unavailable: ${error instanceof Error ? error.message : String(error)}`,
            )
        : Promise.resolve(undefined),
      checks.responsive || checks.accessibility
        ? evaluateUiHeuristics(page, checks)
        : Promise.resolve<RalphUiAnalyzeEvaluation>({ issues: [] }),
    ]);

    return {
      name: viewport.name ?? `${viewport.width}x${viewport.height}`,
      width: viewport.width,
      height: viewport.height,
      url: page.url(),
      title,
      ...(screenshotPath ? { screenshotPath } : {}),
      ...(ariaSnapshot ? { ariaSnapshot } : {}),
      visibleText:
        visibleText.length > MAX_RALPH_UI_ANALYZE_TEXT_CHARS
          ? `${visibleText.slice(0, MAX_RALPH_UI_ANALYZE_TEXT_CHARS)}\n[UI analysis text truncated at ${MAX_RALPH_UI_ANALYZE_TEXT_CHARS} characters.]`
          : visibleText,
      consoleErrors: consoleErrors.slice(0, MAX_RALPH_UI_ANALYZE_ISSUES),
      pageErrors: pageErrors.slice(0, MAX_RALPH_UI_ANALYZE_ISSUES),
      failedRequests: failedRequests.slice(0, MAX_RALPH_UI_ANALYZE_ISSUES),
      issues: evaluation.issues,
      ...(evaluation.analysis ? { analysis: evaluation.analysis } : {}),
    };
  } finally {
    await context.close().catch(() => undefined);
  }
};

const executeUiAnalyzeImageUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
): Promise<RalphBlockExecutionResult> => {
  const screenshotPath = utility.screenshotPath
    ? resolveUtilityPath(utility.screenshotPath, config.workspaceRoot)
    : undefined;

  if (!screenshotPath) {
    return createUtilityResult(
      block,
      "ERROR",
      `${block.title} image analysis requires screenshotPath.`,
    );
  }

  try {
    const screenshotStat = await stat(screenshotPath);
    const data: RalphUiAnalyzeData = {
      adapter: "image",
      screenshotPath,
      server: { mode: "none", ready: true },
      viewports: [],
      artifacts: {
        screenshots: [screenshotPath],
      },
      issues: [],
      summary: `${block.title} loaded screenshot evidence (${screenshotStat.size} bytes).`,
    };

    return createUtilityResult(block, "SUCCESS", data.summary, data);
  } catch (error) {
    const summary = `${block.title} screenshot is unavailable: ${
      error instanceof Error ? error.message : String(error)
    }`;

    return createUtilityResult(
      block,
      "UNAVAILABLE",
      summary,
      {
        adapter: "image",
        screenshotPath,
        server: { mode: "none", ready: false, error: summary },
        viewports: [],
        artifacts: { screenshots: [] },
        issues: [],
        summary,
      } satisfies RalphUiAnalyzeData,
      "error",
    );
  }
};

const executeUiAnalyzeMcpUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  context: RalphResultContext,
  options: RalphRunOptions,
): Promise<RalphBlockExecutionResult> => {
  const serverId = utility.mcpServerId?.trim();
  const toolName = utility.mcpToolName?.trim();

  if (!serverId || !toolName) {
    return createUtilityResult(
      block,
      "ERROR",
      `${block.title} MCP analysis requires mcpServerId and mcpToolName.`,
    );
  }

  const args = resolveMcpArguments(utility.mcpArguments, context);
  const targetUrl = resolveUiAnalyzeTargetUrl(utility);

  try {
    const result = await withRalphDeadline(
      getUtilityTimeoutMs(utility, DEFAULT_RALPH_MCP_TIMEOUT_MS),
      options.signal,
      (signal) =>
        mcpClientManager.callTool(
          config.workspaceRoot,
          serverId,
          toolName,
          args,
          {
            signal,
            ...(block.settings?.mcp
              ? { configOverride: block.settings.mcp }
              : {}),
          },
        ),
    );
    const data: RalphUiAnalyzeData = {
      adapter: utility.adapter ?? "playwright-mcp",
      ...(targetUrl ? { targetUrl } : {}),
      ...(utility.screenshotPath
        ? { screenshotPath: utility.screenshotPath }
        : {}),
      server: { mode: "existing", ready: true },
      viewports: [],
      artifacts: { screenshots: [] },
      issues: [],
      mcpResult: result,
      summary: `${block.title} collected UI evidence from ${serverId}.${toolName}.`,
    };

    return createUtilityResult(
      block,
      isMcpCallError(result) ? "ERROR" : "SUCCESS",
      data.summary,
      data,
      isMcpCallError(result) ? "error" : "completed",
    );
  } catch (error) {
    const summary = `${block.title} MCP UI evidence is unavailable: ${
      error instanceof Error ? error.message : String(error)
    }`;

    return createUtilityResult(
      block,
      "UNAVAILABLE",
      summary,
      {
        adapter: utility.adapter ?? "playwright-mcp",
        ...(targetUrl ? { targetUrl } : {}),
        ...(utility.screenshotPath
          ? { screenshotPath: utility.screenshotPath }
          : {}),
        server: { mode: "existing", ready: false, error: summary },
        viewports: [],
        artifacts: { screenshots: [] },
        issues: [],
        summary,
      } satisfies RalphUiAnalyzeData,
      "error",
    );
  }
};

const executeUiAnalyzeBrowserUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  context: RalphResultContext,
  options: RalphRunOptions,
): Promise<RalphBlockExecutionResult> => {
  const targetUrl = resolveUiAnalyzeTargetUrl(utility);

  if (!targetUrl) {
    return createUtilityResult(
      block,
      "ERROR",
      `${block.title} browser analysis requires targetUrl.`,
    );
  }

  const serverMode = utility.server?.mode ?? "existing";
  const timeoutMs = getUtilityTimeoutMs(
    utility,
    DEFAULT_RALPH_UI_ANALYZE_TIMEOUT_MS,
  );
  const overallDeadline = Date.now() + timeoutMs;
  const healthUrl =
    serverMode === "none"
      ? undefined
      : (utility.server?.healthUrl ?? targetUrl);
  let managedServer: RalphManagedServerHandle | undefined;
  let managedServerReused = false;
  let reusedManagedServerOwnership: RalphManagedServerOwnership | undefined;
  let managedServerRegistryPath: string | undefined;
  let browser: PlaywrightBrowser | undefined;

  try {
    let health: { ready: boolean; status?: number; error?: string };

    if (serverMode === "managed") {
      const reuseExisting = utility.server?.reuseExisting ?? true;
      const configuredCommand = utility.server?.command?.trim();
      const configuredCwd = resolveWorkspaceContainedUtilityPath(
        utility.server?.cwd ?? utility.cwd ?? ".",
        config.workspaceRoot,
      );
      const serverIdentity = createHash("sha256")
        .update(healthUrl ?? targetUrl ?? configuredCommand ?? block.id)
        .digest("hex")
        .slice(0, 24);
      const registryPath = join(
        config.workspaceRoot,
        ".machdoch",
        "ralph",
        "managed-servers",
        `${serverIdentity}.json`,
      );
      managedServerRegistryPath = registryPath;
      const ownership = await readRalphManagedServerOwnership(registryPath);
      const ownershipMatches = Boolean(
        configuredCommand &&
        ownership &&
        isRalphManagedServerOwnershipAlive(ownership) &&
        ownership?.commandFingerprint ===
          createRalphManagedServerCommandFingerprint(
            configuredCommand,
            configuredCwd,
          ),
      );
      const existingHealth =
        reuseExisting && ownershipMatches
          ? await checkUiAnalyzeServerReady(
              healthUrl,
              Math.min(timeoutMs, 1_000),
              options.signal,
            )
          : { ready: false as const };

      if (existingHealth.ready) {
        managedServerReused = true;
        reusedManagedServerOwnership = ownership;
        health = existingHealth;
      } else {
        const command = configuredCommand;

        if (!command) {
          health = {
            ready: false,
            error: `${block.title} managed server requires server.command.`,
          };
        } else {
          const cwd = configuredCwd;

          try {
            managedServer = await startRalphManagedServer({
              command,
              cwd,
              env: { ...process.env, ...(utility.env ?? {}) },
              ownerId: context.runId,
              registryPath,
              ...(options.signal ? { signal: options.signal } : {}),
            });
            health = healthUrl
              ? await waitForManagedUiAnalyzeServer(
                  managedServer,
                  healthUrl,
                  timeoutMs,
                  options.signal,
                )
              : { ready: true };
          } catch (error) {
            health = {
              ready: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }
      }
    } else {
      health = await checkUiAnalyzeServerReady(
        healthUrl,
        timeoutMs,
        options.signal,
      );
    }

    if (!health.ready) {
      const summary = `${block.title} target is unavailable before browser analysis.`;

      return createUtilityResult(
        block,
        "UNAVAILABLE",
        summary,
        {
          adapter: "browser",
          targetUrl,
          server: {
            mode: serverMode,
            ...(healthUrl ? { healthUrl } : {}),
            ready: false,
            ...(serverMode === "managed"
              ? {
                  started: Boolean(managedServer),
                  reused: managedServerReused,
                  ...(managedServer?.pid !== undefined
                    ? { pid: managedServer.pid }
                    : {}),
                }
              : {}),
            ...(health.status !== undefined ? { status: health.status } : {}),
            ...(health.error ? { error: health.error } : {}),
          },
          viewports: [],
          artifacts: { screenshots: [] },
          issues: [],
          summary,
        } satisfies RalphUiAnalyzeData,
        "error",
      );
    }

    const launch = await launchUiAnalyzeBrowser();
    browser = launch.browser;
    const artifactDirectory = await createUiAnalyzeArtifactDirectory(
      config.workspaceRoot,
      options.runId,
      block.id,
    );
    const viewports: RalphUiAnalyzeViewportData[] = [];

    for (const viewport of getUiAnalyzeViewports(utility)) {
      const remainingMs = overallDeadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `${block.title} exceeded its overall UI analysis deadline.`,
        );
      }
      viewports.push(
        await captureUiAnalyzeViewport(
          browser,
          targetUrl,
          viewport,
          { ...utility, timeoutSeconds: Math.max(0.001, remainingMs / 1_000) },
          artifactDirectory,
          options.signal,
        ),
      );
    }

    const issues = viewports.flatMap((viewport) => [
      ...viewport.issues.map((issue) => ({
        ...issue,
        viewport: viewport.name,
      })),
      ...viewport.consoleErrors.map((message) => ({
        severity: "error" as const,
        category: "console",
        message,
        viewport: viewport.name,
      })),
      ...viewport.pageErrors.map((message) => ({
        severity: "error" as const,
        category: "pageerror",
        message,
        viewport: viewport.name,
      })),
      ...viewport.failedRequests.map((message) => ({
        severity: "warning" as const,
        category: "network",
        message,
        viewport: viewport.name,
      })),
    ]);
    const screenshots = viewports.flatMap((viewport) =>
      viewport.screenshotPath ? [viewport.screenshotPath] : [],
    );
    const summary =
      issues.length > 0
        ? `${block.title} captured ${viewports.length} viewport(s) with ${issues.length} finding(s).`
        : `${block.title} captured ${viewports.length} viewport(s) without findings.`;
    const data: RalphUiAnalyzeData = {
      adapter: "browser",
      targetUrl,
      server: {
        mode: serverMode,
        ...(healthUrl ? { healthUrl } : {}),
        ready: true,
        ...(serverMode === "managed"
          ? {
              started: Boolean(managedServer),
              reused: managedServerReused,
              ...(managedServer?.pid !== undefined
                ? { pid: managedServer.pid }
                : {}),
            }
          : {}),
        ...(health.status !== undefined ? { status: health.status } : {}),
      },
      viewports,
      artifacts: {
        directory: artifactDirectory,
        screenshots,
      },
      issues,
      summary,
    };

    return createUtilityResult(block, "SUCCESS", summary, data);
  } catch (error) {
    return createRalphBlockExecutionErrorResult(block, error);
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    if (managedServer) {
      await stopRalphManagedServer(managedServer).catch(() => undefined);
    } else if (
      managedServerReused &&
      reusedManagedServerOwnership &&
      managedServerRegistryPath
    ) {
      await stopRalphManagedServerOwnership(
        reusedManagedServerOwnership,
        managedServerRegistryPath,
      ).catch(() => undefined);
    }
  }
};

const executeUiAnalyzeUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  context: RalphResultContext,
  options: RalphRunOptions,
): Promise<RalphBlockExecutionResult> => {
  const adapter = resolveUiAnalyzeAdapter(utility);

  if (adapter === "image") {
    return executeUiAnalyzeImageUtilityBlock(block, utility, config);
  }

  if (adapter === "playwright-mcp" || adapter === "tauri-mcp") {
    return executeUiAnalyzeMcpUtilityBlock(
      block,
      utility,
      config,
      context,
      options,
    );
  }

  return executeUiAnalyzeBrowserUtilityBlock(
    block,
    utility,
    config,
    context,
    options,
  );
};

const executeGitStatusUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  signal?: AbortSignal,
): Promise<RalphBlockExecutionResult> => {
  return executeCommandUtilityBlock(
    block,
    {
      ...utility,
      type: "RUN_COMMAND",
      command: "git status --short",
      cwd: utility.cwd ?? config.workspaceRoot,
    },
    config,
    false,
    signal,
  );
};

const collectUtilityGitChangeSnapshot = async (
  cwd: string,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  signal?: AbortSignal,
): Promise<RalphGitChangeSnapshot> => {
  return collectRalphGitChangeSnapshot({
    cwd,
    workspaceRoot: config.workspaceRoot,
    timeoutMs: getUtilityTimeoutMs(
      utility,
      DEFAULT_RALPH_UTILITY_COMMAND_TIMEOUT_MS,
    ),
    maxOutputBytes:
      utility.maxOutputBytes ?? DEFAULT_RALPH_UTILITY_RESPONSE_LIMIT_BYTES,
    ...(signal ? { signal } : {}),
  });
};

const maybeWriteJsonArtifact = async (
  path: string | undefined,
  workspaceRoot: string,
  value: unknown,
  runArtifactOwnership?: {
    artifactRoot: string;
    workspaceRoot: string;
  },
): Promise<string | undefined> => {
  if (!path?.trim()) {
    return undefined;
  }

  const requestedPath = resolveUtilityPath(path, workspaceRoot);
  let resolvedPath: string;
  if (
    runArtifactOwnership &&
    isResolvedPathInsideWorkspace(
      requestedPath,
      runArtifactOwnership.artifactRoot,
    )
  ) {
    const [resolvedArtifactRoot, resolvedArtifactPath] = await Promise.all([
      resolveWorkspaceContainedMutationPath(
        runArtifactOwnership.artifactRoot,
        runArtifactOwnership.workspaceRoot,
      ),
      resolveWorkspaceContainedMutationPath(
        requestedPath,
        runArtifactOwnership.workspaceRoot,
      ),
    ]);
    if (
      !isResolvedPathInsideWorkspace(resolvedArtifactPath, resolvedArtifactRoot)
    ) {
      throw new Error(
        "JSON artifact path must stay inside the run artifact root.",
      );
    }
    resolvedPath = resolvedArtifactPath;
  } else {
    resolvedPath = await resolveWorkspaceContainedMutationPath(
      requestedPath,
      workspaceRoot,
    );
  }
  await writeUtilityJsonOutput(resolvedPath, value);

  return resolvedPath;
};

const executeGitSnapshotUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  signal?: AbortSignal,
): Promise<RalphBlockExecutionResult> => {
  const cwd = normalizeLocalCommandCwd(
    resolveUtilityPath(utility.cwd, config.workspaceRoot),
  );

  try {
    const data = await collectUtilityGitChangeSnapshot(
      cwd,
      utility,
      config,
      signal,
    );
    const snapshotData = {
      evidenceKind: "ralph-git-snapshot-v1" as const,
      ...data,
    };
    const outputPath = await maybeWriteJsonArtifact(
      utility.outputPath,
      config.workspaceRoot,
      snapshotData,
    );

    return createUtilityResult(
      block,
      "SUCCESS",
      `${block.title} captured git snapshot.`,
      {
        ...snapshotData,
        ...(outputPath ? { outputPath } : {}),
      },
    );
  } catch (error) {
    return createUtilityResult(
      block,
      "ERROR",
      formatLocalCommandError(`${block.title} failed.`, error),
    );
  }
};

const executeGitDiffSummaryUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  signal?: AbortSignal,
): Promise<RalphBlockExecutionResult> => {
  const cwd = normalizeLocalCommandCwd(
    resolveUtilityPath(utility.cwd, config.workspaceRoot),
  );

  try {
    const data = await collectUtilityGitChangeSnapshot(
      cwd,
      utility,
      config,
      signal,
    );
    const hasChanges =
      data.status.trim().length > 0 ||
      data.diffStat.trim().length > 0 ||
      data.stagedDiffStat.trim().length > 0;
    const outputPath = await maybeWriteJsonArtifact(
      utility.outputPath,
      config.workspaceRoot,
      data,
    );

    return createUtilityResult(
      block,
      hasChanges ? "SUCCESS" : "EMPTY",
      hasChanges
        ? `${block.title} summarized git changes.`
        : `${block.title} found no git changes.`,
      { ...data, ...(outputPath ? { outputPath } : {}) },
      "completed",
    );
  } catch (error) {
    return createUtilityResult(
      block,
      "ERROR",
      formatLocalCommandError(`${block.title} failed.`, error),
    );
  }
};

const normalizeWorkspaceRelativePath = (
  path: string,
  workspaceRoot: string,
): string => {
  const relativePath = isAbsolute(path)
    ? relative(resolve(workspaceRoot), resolve(path))
    : path;

  return relativePath.replace(/\\/gu, "/").replace(/^\.\/+/u, "");
};

const extractScopeGuardInput = (
  utility: RalphUtilityConfig,
  context: RalphResultContext,
): unknown => {
  if (utility.input !== undefined) {
    return parseRalphUtilityJsonValue(utility.input);
  }

  return context.lastResult?.data;
};

const extractStringListField = (value: unknown, field: string): string[] => {
  if (!isRecord(value) || !Array.isArray(value[field])) {
    return [];
  }

  return value[field].filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0,
  );
};

const extractScopeGuardRules = (
  input: unknown,
): { paths: string[]; globs: string[] } => {
  const source = isRecord(input) && isRecord(input.scope) ? input.scope : input;
  const extraSource =
    isRecord(input) && isRecord(input.scope) ? input : undefined;

  return {
    paths: [
      ...extractStringListField(source, "paths"),
      ...extractStringListField(source, "allowedPaths"),
      ...extractStringListField(extraSource, "allowedPaths"),
    ],
    globs: [
      ...extractStringListField(source, "globs"),
      ...extractStringListField(source, "allowedGlobs"),
      ...extractStringListField(extraSource, "allowedGlobs"),
    ],
  };
};

const extractGitSummaryFiles = (
  value: unknown,
  workspaceRoot: string,
): RalphGitChangedFileSnapshot[] => {
  if (!isRecord(value)) {
    return [];
  }

  if (Array.isArray(value.files)) {
    return value.files.flatMap((entry): RalphGitChangedFileSnapshot[] => {
      if (!isRecord(entry) || typeof entry.path !== "string") {
        return [];
      }

      const path = normalizeWorkspaceRelativePath(entry.path, workspaceRoot);
      const status = typeof entry.status === "string" ? entry.status : "??";
      const indexStatus =
        typeof entry.indexStatus === "string"
          ? entry.indexStatus
          : (status[0] ?? "?");
      const worktreeStatus =
        typeof entry.worktreeStatus === "string"
          ? entry.worktreeStatus
          : (status[1] ?? "?");
      const worktreeHash =
        typeof entry.worktreeHash === "string" ? entry.worktreeHash : undefined;
      const indexOid =
        typeof entry.indexOid === "string" ? entry.indexOid : undefined;
      const signature =
        typeof entry.signature === "string"
          ? entry.signature
          : [
              `status=${status}`,
              `index=${indexOid ?? "missing"}`,
              `worktree=${worktreeHash ?? "missing"}`,
            ].join(";");

      return [
        {
          path,
          status,
          indexStatus,
          worktreeStatus,
          staged: Boolean(entry.staged),
          unstaged: Boolean(entry.unstaged),
          untracked: Boolean(entry.untracked),
          deleted: Boolean(entry.deleted),
          ...(worktreeHash ? { worktreeHash } : {}),
          ...(indexOid ? { indexOid } : {}),
          signature,
        },
      ];
    });
  }

  return [];
};

const extractGitChangeSnapshot = (
  value: unknown,
  workspaceRoot: string,
): RalphGitChangeSnapshot | undefined => {
  if (
    !isRecord(value) ||
    typeof value.cwd !== "string" ||
    typeof value.root !== "string" ||
    typeof value.head !== "string" ||
    typeof value.capturedAt !== "string" ||
    typeof value.status !== "string" ||
    typeof value.diffStat !== "string" ||
    typeof value.stagedDiffStat !== "string" ||
    !Array.isArray(value.changedFiles) ||
    !Array.isArray(value.diffFiles) ||
    !Array.isArray(value.stagedDiffFiles) ||
    !Array.isArray(value.files) ||
    typeof value.outputPath === "string"
  ) {
    return undefined;
  }

  const files = extractGitSummaryFiles(value, workspaceRoot);
  if (files.length !== value.files.length) {
    return undefined;
  }

  const stringList = (entries: unknown[]): string[] | undefined => {
    return entries.every((entry) => typeof entry === "string")
      ? entries
      : undefined;
  };
  const changedFiles = stringList(value.changedFiles);
  const diffFiles = stringList(value.diffFiles);
  const stagedDiffFiles = stringList(value.stagedDiffFiles);

  if (!changedFiles || !diffFiles || !stagedDiffFiles) {
    return undefined;
  }

  return {
    cwd: value.cwd,
    root: value.root,
    head: value.head,
    capturedAt: value.capturedAt,
    status: value.status,
    changedFiles,
    diffStat: value.diffStat,
    stagedDiffStat: value.stagedDiffStat,
    diffFiles,
    stagedDiffFiles,
    files,
  };
};

interface ScopeGuardBaseline {
  files: RalphGitChangedFileSnapshot[];
  source: "configured" | "block";
  blockId?: string;
}

const extractScopeGuardBaseline = (
  utility: RalphUtilityConfig,
  workspaceRoot: string,
  context: RalphResultContext,
): ScopeGuardBaseline | undefined => {
  if (utility.baseline !== undefined) {
    const files = extractGitSummaryFiles(
      parseRalphUtilityJsonValue(utility.baseline),
      workspaceRoot,
    );

    if (files.length > 0) {
      return { files, source: "configured" };
    }
  }

  if (!utility.baselineBlockId) {
    return undefined;
  }

  const result = context.resultsByBlock.get(utility.baselineBlockId);
  if (
    !result ||
    result.status !== "completed" ||
    result.output !== "SUCCESS" ||
    !isRecord(result.data) ||
    result.data.evidenceKind !== "ralph-git-snapshot-v1"
  ) {
    return undefined;
  }

  const files = extractGitSummaryFiles(result.data, workspaceRoot);
  return files.length > 0
    ? {
        files,
        source: "block",
        blockId: utility.baselineBlockId,
      }
    : undefined;
};

const doesPathMatchScopeGuard = (
  filePath: string,
  allowedPaths: readonly string[],
  allowedGlobs: readonly string[],
  workspaceRoot: string,
): boolean => {
  const normalizedAllowedPaths = allowedPaths.map((allowedPath) =>
    normalizeWorkspaceRelativePath(allowedPath, workspaceRoot).replace(
      /\/+$/u,
      "",
    ),
  );
  const normalizedAllowedGlobs = allowedGlobs.map((allowedGlob) =>
    normalizeWorkspaceRelativePath(allowedGlob, workspaceRoot),
  );

  if (
    normalizedAllowedPaths.includes(".") ||
    normalizedAllowedPaths.includes("")
  ) {
    return true;
  }

  const pathMatched = normalizedAllowedPaths.some(
    (normalized) =>
      filePath === normalized ||
      filePath.startsWith(`${normalized}/`) ||
      (normalized.includes("*") && globToRegExp(normalized).test(filePath)),
  );

  if (pathMatched) {
    return true;
  }

  return normalizedAllowedGlobs.some((glob) =>
    globToRegExp(glob).test(filePath),
  );
};

const executeChangeScopeGuardUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  context: RalphResultContext,
  signal?: AbortSignal,
): Promise<RalphBlockExecutionResult> => {
  const cwd = normalizeLocalCommandCwd(
    resolveUtilityPath(utility.cwd, config.workspaceRoot),
  );

  try {
    const snapshot = await collectRalphGitChangeSnapshot({
      cwd,
      workspaceRoot: config.workspaceRoot,
      timeoutMs: getUtilityTimeoutMs(
        utility,
        DEFAULT_RALPH_UTILITY_COMMAND_TIMEOUT_MS,
      ),
      maxOutputBytes:
        utility.maxOutputBytes ?? DEFAULT_RALPH_UTILITY_RESPONSE_LIMIT_BYTES,
      includeDiffs: false,
      includeHead: false,
      ...(signal ? { signal } : {}),
    });
    const snapshotEvidence = {
      snapshotCapturedAt: snapshot.capturedAt,
    };
    const changedFileEntries = snapshot.files;
    const changedFiles = changedFileEntries.map((file) => file.path);

    if (changedFiles.length === 0) {
      return createUtilityResult(
        block,
        "EMPTY",
        `${block.title} found no changed files.`,
        { cwd, changedFiles, ...snapshotEvidence },
        "completed",
      );
    }

    const baseline = extractScopeGuardBaseline(
      utility,
      config.workspaceRoot,
      context,
    );
    const baselineFileEntries = baseline?.files ?? [];
    const baselineFileMap = new Map(
      baselineFileEntries.map((file) => [file.path, file]),
    );
    const ignoredBaselineFiles: string[] = [];
    const changedSinceBaselineFiles: string[] = [];
    const guardedFileEntries = changedFileEntries.filter((file) => {
      const baselineFile = baselineFileMap.get(file.path);

      if (!baselineFile) {
        return true;
      }

      if (baselineFile.signature === file.signature) {
        ignoredBaselineFiles.push(file.path);
        return false;
      }

      changedSinceBaselineFiles.push(file.path);
      return true;
    });
    const guardedFiles = guardedFileEntries.map((file) => file.path);
    const baselineFiles = baselineFileEntries.map((file) => file.path);

    if (guardedFiles.length === 0) {
      return createUtilityResult(
        block,
        "EMPTY",
        `${block.title} found no changed files beyond the configured baseline.`,
        {
          cwd,
          changedFiles,
          guardedFiles,
          baselineFiles,
          ...(baseline ? { baselineSource: baseline.source } : {}),
          ...(baseline?.blockId ? { baselineBlockId: baseline.blockId } : {}),
          ignoredBaselineFiles,
          changedSinceBaselineFiles,
          files: changedFileEntries,
          ...snapshotEvidence,
        },
        "completed",
      );
    }

    const rules = extractScopeGuardRules(
      extractScopeGuardInput(utility, context),
    );

    if (rules.paths.length === 0 && rules.globs.length === 0) {
      return createUtilityResult(
        block,
        "IN_SCOPE",
        `${block.title} found no configured scope restrictions.`,
        {
          cwd,
          changedFiles,
          guardedFiles,
          baselineFiles,
          ...(baseline ? { baselineSource: baseline.source } : {}),
          ...(baseline?.blockId ? { baselineBlockId: baseline.blockId } : {}),
          ignoredBaselineFiles,
          changedSinceBaselineFiles,
          files: changedFileEntries,
          allowedPaths: [],
          allowedGlobs: [],
          ...snapshotEvidence,
        },
        "completed",
      );
    }

    const outOfScopeFiles = guardedFileEntries
      .filter(
        (file) =>
          !doesPathMatchScopeGuard(
            file.path,
            rules.paths,
            rules.globs,
            config.workspaceRoot,
          ),
      )
      .map((file) => file.path);
    const isEnforced = utility.enforce === true;
    const output =
      outOfScopeFiles.length > 0 && isEnforced ? "OUT_OF_SCOPE" : "IN_SCOPE";
    const blockingOutOfScopeFiles = isEnforced ? outOfScopeFiles : [];
    const advisoryOutOfScopeFiles = isEnforced ? [] : outOfScopeFiles;

    return createUtilityResult(
      block,
      output,
      outOfScopeFiles.length > 0
        ? isEnforced
          ? `${block.title} found ${outOfScopeFiles.length} out-of-scope file(s).`
          : `${block.title} confirmed scoped flow can continue and recorded ${outOfScopeFiles.length} unrelated workspace file(s).`
        : `${block.title} confirmed changed files stay in scope.`,
      {
        cwd,
        changedFiles,
        guardedFiles,
        baselineFiles,
        ...(baseline ? { baselineSource: baseline.source } : {}),
        ...(baseline?.blockId ? { baselineBlockId: baseline.blockId } : {}),
        ignoredBaselineFiles,
        changedSinceBaselineFiles,
        outOfScopeFiles: blockingOutOfScopeFiles,
        advisoryOutOfScopeFiles,
        unrelatedWorkspaceFiles: advisoryOutOfScopeFiles,
        files: changedFileEntries,
        allowedPaths: rules.paths,
        allowedGlobs: rules.globs,
        enforcement: isEnforced ? "blocking" : "advisory",
        ...snapshotEvidence,
      },
      output === "IN_SCOPE" ? "completed" : "error",
    );
  } catch (error) {
    return createUtilityResult(
      block,
      "ERROR",
      formatLocalCommandError(`${block.title} failed.`, error),
    );
  }
};

const getPackageManagerCommand = (
  rootPath: string,
  packageJson: Record<string, unknown>,
  workspaceRoot: string,
): string => {
  const packageManager =
    typeof packageJson.packageManager === "string"
      ? packageJson.packageManager.split("@")[0]
      : undefined;

  if (packageManager) {
    return packageManager;
  }

  let currentPath = resolve(rootPath);
  const normalizedWorkspaceRoot = resolve(workspaceRoot);

  while (isResolvedPathInsideWorkspace(currentPath, normalizedWorkspaceRoot)) {
    if (existsSync(join(currentPath, "pnpm-lock.yaml"))) {
      return "pnpm";
    }

    if (existsSync(join(currentPath, "yarn.lock"))) {
      return "yarn";
    }

    if (existsSync(join(currentPath, "package-lock.json"))) {
      return "npm";
    }

    if (currentPath === normalizedWorkspaceRoot) {
      break;
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }
    currentPath = parentPath;
  }

  return "npm";
};

const createPackageScriptCommand = (
  packageManager: string,
  scriptName: string,
): string => {
  return packageManager === "npm"
    ? `npm run ${scriptName}`
    : `${packageManager} ${scriptName}`;
};

const PROJECT_COMMAND_MANIFESTS = [
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
] as const;

const getExistingDirectoryForProjectCommandDetection = async (
  path: string,
): Promise<string> => {
  const metadata = await stat(path).catch(() => null);

  if (metadata?.isFile()) {
    return dirname(path);
  }

  if (metadata?.isDirectory()) {
    return path;
  }

  return path;
};

const findProjectCommandRoot = async (
  requestedRootPath: string,
  workspaceRoot: string,
): Promise<string> => {
  const normalizedWorkspaceRoot = resolve(workspaceRoot);
  let currentPath = resolve(
    await getExistingDirectoryForProjectCommandDetection(requestedRootPath),
  );

  while (isResolvedPathInsideWorkspace(currentPath, normalizedWorkspaceRoot)) {
    if (
      PROJECT_COMMAND_MANIFESTS.some((manifest) =>
        existsSync(join(currentPath, manifest)),
      )
    ) {
      return currentPath;
    }

    if (currentPath === normalizedWorkspaceRoot) {
      break;
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }
    currentPath = parentPath;
  }

  return resolve(requestedRootPath);
};

const executeDetectProjectCommandsUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
): Promise<RalphBlockExecutionResult> => {
  const requestedRootPath = resolveUtilityPath(
    utility.rootPath?.trim() || utility.cwd,
    config.workspaceRoot,
  );

  try {
    if (
      !isResolvedPathInsideWorkspace(requestedRootPath, config.workspaceRoot)
    ) {
      throw new Error(
        "Project command detection root must stay inside the workspace.",
      );
    }

    const rootPath = await findProjectCommandRoot(
      requestedRootPath,
      config.workspaceRoot,
    );
    const repositoryContext = await resolveRalphRepositoryContext({
      workspaceRoot: config.workspaceRoot,
      projectPath: rootPath,
      timeoutMs: getUtilityTimeoutMs(
        utility,
        DEFAULT_RALPH_UTILITY_COMMAND_TIMEOUT_MS,
      ),
    }).catch(() => undefined);
    const repositoryBaseline = repositoryContext
      ? await collectRalphGitChangeSnapshot({
          cwd: repositoryContext.worktreeRoot,
          workspaceRoot: config.workspaceRoot,
          timeoutMs: getUtilityTimeoutMs(
            utility,
            DEFAULT_RALPH_UTILITY_COMMAND_TIMEOUT_MS,
          ),
          maxOutputBytes:
            utility.maxOutputBytes ??
            DEFAULT_RALPH_UTILITY_RESPONSE_LIMIT_BYTES,
          includeDiffs: false,
        }).catch(() => undefined)
      : undefined;
    const manifests: string[] = [];
    const commands: Array<{
      kind: "typecheck" | "lint" | "test" | "build" | "format";
      command: string;
      source: string;
      confidence: "high" | "medium";
    }> = [];
    let serveCommand: string | undefined;
    let serveCommandSource: string | undefined;
    let targetUrl: string | undefined;
    const packageJsonPath = join(rootPath, "package.json");

    if (existsSync(packageJsonPath)) {
      const packageJson = await readJsonFile(packageJsonPath);
      if (isRecord(packageJson)) {
        manifests.push("package.json");
        const scripts = isRecord(packageJson.scripts)
          ? packageJson.scripts
          : {};
        const packageManager = getPackageManagerCommand(
          rootPath,
          packageJson,
          config.workspaceRoot,
        );

        for (const [kind, candidates] of [
          ["typecheck", ["typecheck", "check:types", "tsc"]],
          ["lint", ["lint", "check:lint"]],
          ["test", ["test", "test:run", "unit"]],
          ["build", ["build"]],
          ["format", ["format:check", "prettier:check"]],
        ] as const) {
          const scriptName = candidates.find(
            (candidate) => typeof scripts[candidate] === "string",
          );

          if (scriptName) {
            commands.push({
              kind,
              command: createPackageScriptCommand(packageManager, scriptName),
              source: `package.json#scripts.${scriptName}`,
              confidence: "high",
            });
          }
        }

        const serveScriptName = [
          "preview:ui",
          "preview",
          "dev:ui",
          "dev",
          "start",
        ].find((candidate) => typeof scripts[candidate] === "string");
        if (serveScriptName) {
          serveCommand = createPackageScriptCommand(
            packageManager,
            serveScriptName,
          );
          serveCommandSource = `package.json#scripts.${serveScriptName}`;
          const script = String(scripts[serveScriptName]);
          const explicitPort = script.match(
            /(?:--port(?:=|\s+)|\bPORT\s*=\s*)(\d{2,5})\b/iu,
          )?.[1];
          const port =
            explicitPort ??
            (/(?:vite\s+preview|\bpreview\b)/iu.test(script)
              ? "4173"
              : /(?:vite|dev:ui)/iu.test(script)
                ? "5173"
                : "3000");
          targetUrl = `http://127.0.0.1:${port}`;
        }
      }
    }

    if (existsSync(join(rootPath, "Cargo.toml"))) {
      manifests.push("Cargo.toml");
      commands.push(
        {
          kind: "typecheck",
          command: "cargo check",
          source: "Cargo.toml",
          confidence: "high",
        },
        {
          kind: "build",
          command: "cargo build",
          source: "Cargo.toml",
          confidence: "high",
        },
        {
          kind: "test",
          command: "cargo test",
          source: "Cargo.toml",
          confidence: "high",
        },
      );
    }

    if (existsSync(join(rootPath, "pyproject.toml"))) {
      manifests.push("pyproject.toml");
      commands.push({
        kind: "test",
        command: "python -m pytest",
        source: "pyproject.toml",
        confidence: "medium",
      });
    }

    if (existsSync(join(rootPath, "go.mod"))) {
      manifests.push("go.mod");
      commands.push(
        {
          kind: "test",
          command: "go test ./...",
          source: "go.mod",
          confidence: "high",
        },
        {
          kind: "build",
          command: "go build ./...",
          source: "go.mod",
          confidence: "high",
        },
      );
    }

    const verificationCommands = commands
      .filter(
        (entry) =>
          entry.kind === "typecheck" ||
          entry.kind === "lint" ||
          entry.kind === "test",
      )
      .map((entry) => entry.command);
    const typecheckCommands = commands
      .filter((entry) => entry.kind === "typecheck")
      .map((entry) => entry.command);
    const lintCommands = commands
      .filter((entry) => entry.kind === "lint")
      .map((entry) => entry.command);
    const testCommands = commands
      .filter((entry) => entry.kind === "test")
      .map((entry) => entry.command);
    const focusedVerificationCommands =
      typecheckCommands.length > 0
        ? typecheckCommands
        : testCommands.length > 0
          ? testCommands.slice(0, 1)
          : verificationCommands.slice(0, 1);
    let standardVerificationCommands = [
      ...typecheckCommands,
      ...(lintCommands.length > 0 ? lintCommands : testCommands.slice(0, 1)),
    ];
    let broadVerificationCommands = verificationCommands;
    const cargoOnly = manifests.length === 1 && manifests[0] === "Cargo.toml";
    if (cargoOnly) {
      standardVerificationCommands = ["cargo test"];
      broadVerificationCommands = ["cargo test --all-targets"];
    } else if (manifests.includes("Cargo.toml")) {
      if (!standardVerificationCommands.includes("cargo test")) {
        standardVerificationCommands.push("cargo test");
      }
      broadVerificationCommands = broadVerificationCommands
        .filter((command) => command !== "cargo check")
        .map((command) =>
          command === "cargo test" ? "cargo test --all-targets" : command,
        );
    }
    const data = {
      rootPath,
      requestedRootPath,
      ...(repositoryContext ? { repositoryContext } : {}),
      ...(repositoryBaseline ? { repositoryBaseline } : {}),
      manifests,
      commands,
      ...(serveCommand ? { serveCommand } : {}),
      ...(serveCommandSource ? { serveCommandSource } : {}),
      ...(targetUrl ? { targetUrl } : {}),
      focusedVerificationCommand: createVerificationCommand(
        focusedVerificationCommands,
      ),
      standardVerificationCommand: createVerificationCommand(
        standardVerificationCommands.length > 0
          ? standardVerificationCommands
          : focusedVerificationCommands,
      ),
      broadVerificationCommand: createVerificationCommand(
        broadVerificationCommands,
      ),
      verificationCommand: createVerificationCommand(broadVerificationCommands),
      detectedAt: new Date().toISOString(),
    };
    const outputPath = await maybeWriteJsonArtifact(
      utility.outputPath,
      config.workspaceRoot,
      data,
    );

    return createUtilityResult(
      block,
      manifests.length > 0 || commands.length > 0 ? "SUCCESS" : "EMPTY",
      `${block.title} detected ${commands.length} command(s).`,
      { ...data, ...(outputPath ? { outputPath } : {}) },
      "completed",
    );
  } catch (error) {
    return createRalphBlockExecutionErrorResult(block, error);
  }
};

const addTokenUsage = (
  total: TaskExecutionTokenUsage,
  usage: TaskExecutionTokenUsage | undefined,
): TaskExecutionTokenUsage => {
  if (!usage) {
    return total;
  }

  return {
    inputTokens: (total.inputTokens ?? 0) + (usage.inputTokens ?? 0),
    outputTokens: (total.outputTokens ?? 0) + (usage.outputTokens ?? 0),
    totalTokens: (total.totalTokens ?? 0) + (usage.totalTokens ?? 0),
    cachedInputTokens:
      (total.cachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0),
    cacheReadInputTokens:
      (total.cacheReadInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0),
    cacheWriteInputTokens:
      (total.cacheWriteInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0),
    toolUseInputTokens:
      (total.toolUseInputTokens ?? 0) + (usage.toolUseInputTokens ?? 0),
    reasoningTokens:
      (total.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
  };
};

const omitEmptyTokenUsage = (
  usage: TaskExecutionTokenUsage,
): TaskExecutionTokenUsage | undefined => {
  const entries = Object.entries(usage).filter(
    ([, value]) => typeof value === "number" && value > 0,
  );

  return entries.length > 0
    ? (Object.fromEntries(entries) as TaskExecutionTokenUsage)
    : undefined;
};

const getNumericMetadata = (
  metadata: Record<string, string | number | boolean> | undefined,
  key: string,
): number => {
  const value = metadata?.[key];

  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

const createBlockPerformanceMetrics = (
  result: RalphBlockExecutionResult,
): Record<string, unknown> => {
  const progress = result.progress ?? [];
  const modelUsageValue = result.result?.metadata?.modelUsage;
  const modelUsageReport = isTaskModelUsageReport(modelUsageValue)
    ? modelUsageValue
    : undefined;
  let modelCallCount = 0;
  let monitorPassCount = 0;
  let modelCallDurationMs = 0;
  let toolCallDurationMs = 0;
  let tokenUsage: TaskExecutionTokenUsage = {};

  for (const event of progress) {
    if (event.timelineKind === "model-call" && event.phase === "started") {
      modelCallCount += 1;
    }

    if (event.timelineKind === "validator" && event.phase === "started") {
      monitorPassCount += 1;
    }

    if (
      event.timelineKind === "model-call" &&
      (event.phase === "completed" || event.phase === "failed")
    ) {
      modelCallDurationMs += getNumericMetadata(event.metadata, "durationMs");
    }

    if (
      event.timelineKind === "tool-call" &&
      (event.phase === "completed" || event.phase === "failed")
    ) {
      toolCallDurationMs += getNumericMetadata(event.metadata, "durationMs");
    }

    tokenUsage = addTokenUsage(tokenUsage, event.tokenUsage);
  }

  if (modelUsageReport) {
    modelCallCount = modelUsageReport.totals.modelCallCount;
    monitorPassCount = modelUsageReport.calls
      .filter((call) => call.stage === "validator")
      .reduce((count, call) => count + call.modelCallCount, 0);
    modelCallDurationMs = modelUsageReport.totals.aggregateCallDurationMs;
    tokenUsage = addTokenUsage({}, modelUsageReport.totals);
  }

  const modelUsageMetrics = modelUsageReport
    ? {
        providerRequestCount: modelUsageReport.totals.providerRequestCount,
        apiCallCount: modelUsageReport.totals.apiCallCount,
        cliCallCount: modelUsageReport.totals.cliCallCount,
        auxiliaryCallCount: modelUsageReport.totals.auxiliaryCallCount,
        retryCount: modelUsageReport.totals.retryCount,
        modelCallTelemetryUnavailableCallCount:
          modelUsageReport.totals.modelCallTelemetryUnavailableCallCount,
        providerRequestTelemetryUnavailableCallCount:
          modelUsageReport.totals.providerRequestTelemetryUnavailableCallCount,
        retryTelemetryUnavailableCallCount:
          modelUsageReport.totals.retryTelemetryUnavailableCallCount,
        failedModelCallCount: modelUsageReport.totals.failedCallCount,
        failedProviderRequestCount: modelUsageReport.totals.failedRequestCount,
        usageReportedCallCount: modelUsageReport.totals.usageReportedCallCount,
        usageUnavailableCallCount:
          modelUsageReport.totals.usageUnavailableCallCount,
        modelRequestBytes: modelUsageReport.totals.requestBytes,
        modelResponseBytes: modelUsageReport.totals.responseBytes,
        toolDefinitionBytes: modelUsageReport.totals.toolDefinitionBytes,
        toolResultBytes: modelUsageReport.totals.toolResultBytes,
      }
    : {};

  const metrics = {
    ...(result.durationMs !== undefined
      ? { durationMs: result.durationMs }
      : {}),
    ...(isRecord(result.data) && typeof result.data.command === "string"
      ? { commandDurationMs: result.durationMs ?? 0 }
      : {}),
    ...(modelCallCount > 0 ? { modelCallCount } : {}),
    ...(monitorPassCount > 0 ? { monitorPassCount } : {}),
    ...(modelCallDurationMs > 0 ? { modelCallDurationMs } : {}),
    ...(toolCallDurationMs > 0 ? { toolCallDurationMs } : {}),
    ...modelUsageMetrics,
    ...(omitEmptyTokenUsage(tokenUsage)
      ? { tokenUsage: omitEmptyTokenUsage(tokenUsage) }
      : {}),
  };

  return metrics;
};

const getStringArrayLength = (
  value: Record<string, unknown>,
  key: string,
): number => {
  const entry = value[key];

  return Array.isArray(entry)
    ? entry.filter((item) => typeof item === "string").length
    : 0;
};

const getChangedFileCount = (result: RalphBlockExecutionResult): number => {
  if (!isRecord(result.data)) {
    return 0;
  }

  const counts = [
    getStringArrayLength(result.data, "changedFiles"),
    getStringArrayLength(result.data, "changedSinceBaselineFiles"),
    Array.isArray(result.data.files) ? result.data.files.length : 0,
  ];

  return Math.max(...counts);
};

const getOutputRecord = (
  result: RalphBlockExecutionResult | undefined,
): Record<string, unknown> | undefined => {
  if (!isRecord(result?.data)) {
    return undefined;
  }

  return isRecord(result.data.output) ? result.data.output : undefined;
};

const createFinalReportPerformanceSummary = (
  blockResults: readonly RalphBlockExecutionResult[],
): Record<string, unknown> => {
  let totalDurationMs = 0;
  let commandDurationMs = 0;
  let modelCallCount = 0;
  let monitorPassCount = 0;
  let modelCallDurationMs = 0;
  let toolCallDurationMs = 0;
  let providerRequestCount = 0;
  let apiCallCount = 0;
  let cliCallCount = 0;
  let auxiliaryCallCount = 0;
  let retryCount = 0;
  let modelCallTelemetryUnavailableCallCount = 0;
  let providerRequestTelemetryUnavailableCallCount = 0;
  let retryTelemetryUnavailableCallCount = 0;
  let failedModelCallCount = 0;
  let failedProviderRequestCount = 0;
  let usageReportedCallCount = 0;
  let usageUnavailableCallCount = 0;
  let modelRequestBytes = 0;
  let modelResponseBytes = 0;
  let toolDefinitionBytes = 0;
  let toolResultBytes = 0;
  let tokenUsage: TaskExecutionTokenUsage = {};
  let changedFileCount = 0;
  let validationTier = "";
  let validationCommand = "";

  for (const result of blockResults) {
    const metrics = createBlockPerformanceMetrics(result);

    totalDurationMs += result.durationMs ?? 0;
    commandDurationMs +=
      typeof metrics.commandDurationMs === "number"
        ? metrics.commandDurationMs
        : 0;
    modelCallCount +=
      typeof metrics.modelCallCount === "number" ? metrics.modelCallCount : 0;
    monitorPassCount +=
      typeof metrics.monitorPassCount === "number"
        ? metrics.monitorPassCount
        : 0;
    modelCallDurationMs +=
      typeof metrics.modelCallDurationMs === "number"
        ? metrics.modelCallDurationMs
        : 0;
    toolCallDurationMs +=
      typeof metrics.toolCallDurationMs === "number"
        ? metrics.toolCallDurationMs
        : 0;
    providerRequestCount +=
      typeof metrics.providerRequestCount === "number"
        ? metrics.providerRequestCount
        : 0;
    apiCallCount +=
      typeof metrics.apiCallCount === "number" ? metrics.apiCallCount : 0;
    cliCallCount +=
      typeof metrics.cliCallCount === "number" ? metrics.cliCallCount : 0;
    auxiliaryCallCount +=
      typeof metrics.auxiliaryCallCount === "number"
        ? metrics.auxiliaryCallCount
        : 0;
    retryCount +=
      typeof metrics.retryCount === "number" ? metrics.retryCount : 0;
    modelCallTelemetryUnavailableCallCount +=
      typeof metrics.modelCallTelemetryUnavailableCallCount === "number"
        ? metrics.modelCallTelemetryUnavailableCallCount
        : 0;
    providerRequestTelemetryUnavailableCallCount +=
      typeof metrics.providerRequestTelemetryUnavailableCallCount === "number"
        ? metrics.providerRequestTelemetryUnavailableCallCount
        : 0;
    retryTelemetryUnavailableCallCount +=
      typeof metrics.retryTelemetryUnavailableCallCount === "number"
        ? metrics.retryTelemetryUnavailableCallCount
        : 0;
    failedModelCallCount +=
      typeof metrics.failedModelCallCount === "number"
        ? metrics.failedModelCallCount
        : 0;
    failedProviderRequestCount +=
      typeof metrics.failedProviderRequestCount === "number"
        ? metrics.failedProviderRequestCount
        : 0;
    usageReportedCallCount +=
      typeof metrics.usageReportedCallCount === "number"
        ? metrics.usageReportedCallCount
        : 0;
    usageUnavailableCallCount +=
      typeof metrics.usageUnavailableCallCount === "number"
        ? metrics.usageUnavailableCallCount
        : 0;
    modelRequestBytes +=
      typeof metrics.modelRequestBytes === "number"
        ? metrics.modelRequestBytes
        : 0;
    modelResponseBytes +=
      typeof metrics.modelResponseBytes === "number"
        ? metrics.modelResponseBytes
        : 0;
    toolDefinitionBytes +=
      typeof metrics.toolDefinitionBytes === "number"
        ? metrics.toolDefinitionBytes
        : 0;
    toolResultBytes +=
      typeof metrics.toolResultBytes === "number" ? metrics.toolResultBytes : 0;
    tokenUsage = addTokenUsage(
      tokenUsage,
      isRecord(metrics.tokenUsage)
        ? (metrics.tokenUsage as TaskExecutionTokenUsage)
        : undefined,
    );
    changedFileCount = Math.max(changedFileCount, getChangedFileCount(result));

    const output = getOutputRecord(result);
    if (!validationTier && typeof output?.tier === "string") {
      validationTier = output.tier;
    }
    if (!validationCommand && typeof output?.command === "string") {
      validationCommand = output.command;
    }
  }

  return {
    blockCount: blockResults.length,
    totalDurationMs,
    commandDurationMs,
    modelCallCount,
    monitorPassCount,
    modelCallDurationMs,
    toolCallDurationMs,
    providerRequestCount,
    apiCallCount,
    cliCallCount,
    auxiliaryCallCount,
    retryCount,
    modelCallTelemetryUnavailableCallCount,
    providerRequestTelemetryUnavailableCallCount,
    retryTelemetryUnavailableCallCount,
    failedModelCallCount,
    failedProviderRequestCount,
    usageReportedCallCount,
    usageUnavailableCallCount,
    modelRequestBytes,
    modelResponseBytes,
    toolDefinitionBytes,
    toolResultBytes,
    changedFileCount,
    ...(validationTier ? { validationTier } : {}),
    ...(validationCommand ? { validationCommand } : {}),
    ...(omitEmptyTokenUsage(tokenUsage)
      ? { tokenUsage: omitEmptyTokenUsage(tokenUsage) }
      : {}),
  };
};

const waitForManagedUiAnalyzeServer = async (
  handle: RalphManagedServerHandle,
  url: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ ready: boolean; status?: number; error?: string }> => {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let lastHealth: { ready: boolean; status?: number; error?: string } = {
    ready: false,
  };

  while (Date.now() <= deadline) {
    if (signal?.aborted) {
      return { ready: false, error: "Ralph run stopped." };
    }

    if (handle.hasExited()) {
      const exit = await handle.exited;
      return {
        ready: false,
        error: `Managed server exited before becoming ready (code ${String(exit.code)}, signal ${String(exit.signal)}).`,
      };
    }

    const remainingMs = Math.max(1, deadline - Date.now());
    lastHealth = await checkUiAnalyzeServerReady(
      url,
      Math.min(1_000, remainingMs),
      signal,
    );

    if (lastHealth.ready) {
      return lastHealth;
    }

    const nextDelayMs = Math.min(250, Math.max(0, deadline - Date.now()));
    if (nextDelayMs <= 0) {
      break;
    }
    await delay(nextDelayMs / 1_000, signal).catch(() => undefined);
  }

  return {
    ...lastHealth,
    ready: false,
    error:
      lastHealth.error ??
      `Managed server did not become ready within ${timeoutMs}ms.`,
  };
};

interface RalphFinalReportArtifact {
  flow: RalphFlow;
  block: RalphUtilityBlock;
  report: Record<string, unknown>;
  jsonPath?: string;
  markdownPath?: string;
}

const RALPH_RESERVED_RUN_ARTIFACT_NAMES = new Set([
  "run.json",
  "simple.jsonl",
  "simple.md",
  "trace.jsonl",
  "execution-history.jsonl",
  "journal.jsonl",
  "run-lease.json",
  "autonomy-evidence.json",
]);

const assertRalphFinalReportPathAvailable = async (
  path: string,
  context: Pick<RalphResultContext, "artifactRoot">,
): Promise<void> => {
  const artifactName =
    process.platform === "win32"
      ? (basename(path).split(":", 1)[0] ?? "").replace(/[ .]+$/u, "")
      : basename(path);
  const resolvedArtifactRoot = context.artifactRoot
    ? await resolvePathThroughExistingAncestors(
        normalizeLocalCommandCwd(context.artifactRoot),
      )
    : undefined;

  if (
    resolvedArtifactRoot &&
    isResolvedPathInsideWorkspace(dirname(path), resolvedArtifactRoot) &&
    isResolvedPathInsideWorkspace(resolvedArtifactRoot, dirname(path)) &&
    RALPH_RESERVED_RUN_ARTIFACT_NAMES.has(artifactName.toLowerCase())
  ) {
    throw new Error(
      `Final report cannot overwrite reserved run artifact ${artifactName}.`,
    );
  }
};

const restoreRalphFinalReportArtifacts = async (
  flow: RalphFlow,
  descriptors: readonly RalphFinalReportCheckpointArtifact[] | undefined,
  workspaceRoot: string,
  artifactRoot: string,
): Promise<RalphFinalReportArtifact[]> => {
  if (!descriptors?.length) {
    return [];
  }
  const blocks = getRalphBlockById(flow);
  const artifacts: RalphFinalReportArtifact[] = [];

  for (const descriptor of descriptors) {
    const block = blocks.get(descriptor.blockId);
    if (block?.type !== "UTILITY" || block.utility.type !== "FINAL_REPORT") {
      continue;
    }
    const jsonPath = descriptor.jsonPath
      ? await resolveWorkspaceContainedMutationPath(
          descriptor.jsonPath,
          workspaceRoot,
        )
      : undefined;
    const markdownPath = descriptor.markdownPath
      ? await resolveWorkspaceContainedMutationPath(
          descriptor.markdownPath,
          workspaceRoot,
        )
      : undefined;
    if (jsonPath) {
      await assertRalphFinalReportPathAvailable(jsonPath, { artifactRoot });
    }
    if (markdownPath) {
      await assertRalphFinalReportPathAvailable(markdownPath, { artifactRoot });
    }
    let report: Record<string, unknown> = {
      flowId: flow.id,
      flowName: flow.name,
      generatedAt: new Date().toISOString(),
      outcome: { status: "recovering" },
    };
    if (jsonPath) {
      const restored = await readFile(jsonPath, "utf8")
        .then((text) => JSON.parse(text) as unknown)
        .catch(() => undefined);
      if (isRecord(restored)) {
        report = restored;
      }
    }
    artifacts.push({
      flow,
      block,
      report,
      ...(jsonPath ? { jsonPath } : {}),
      ...(markdownPath ? { markdownPath } : {}),
    });
  }

  return artifacts;
};

const createFinalReportExecutionHistory = (
  blockResults: readonly RalphBlockExecutionResult[],
): Array<Record<string, unknown>> => {
  return blockResults.map((result, index) => ({
    sequence: index + 1,
    blockId: result.blockId,
    output: result.output,
    status: result.status,
    attempt: result.attempt,
    ...(result.durationMs !== undefined
      ? { durationMs: result.durationMs }
      : {}),
    summary: result.summary,
    ...(result.error ? { error: result.error } : {}),
    ...(result.failure ? { failure: { ...result.failure } } : {}),
    ...(result.recovery ? { recovery: { ...result.recovery } } : {}),
    metrics: createBlockPerformanceMetrics(result),
  }));
};

const createFinalReportMarkdown = (
  flow: RalphFlow,
  block: RalphUtilityBlock,
  report: Record<string, unknown>,
): string => {
  const blockResults = Array.isArray(report.blockResults)
    ? report.blockResults
    : [];
  const lines = [
    `# ${flow.name} Final Report`,
    "",
    `- Block: ${block.title} (${block.id})`,
    `- Run: ${String(report.runId ?? "")}`,
    `- Generated: ${String(report.generatedAt ?? "")}`,
    "",
    "## Outcome",
    "",
    "```json",
    JSON.stringify(report.outcome ?? { status: "running" }, null, 2),
    "```",
    "",
    "## Performance",
    "",
    "```json",
    JSON.stringify(report.performance ?? null, null, 2),
    "```",
    "",
    "## Last Result",
    "",
    "```json",
    JSON.stringify(report.lastResult ?? null, null, 2),
    "```",
    "",
    "## Block Results",
    "",
    ...blockResults.map((entry) => {
      if (!isRecord(entry)) {
        return "- Unknown block result";
      }

      const duration =
        typeof entry.durationMs === "number" ? ` (${entry.durationMs} ms)` : "";

      return `- ${String(entry.blockId ?? "unknown")}: ${String(entry.output ?? "")}${duration} - ${String(entry.summary ?? "")}`;
    }),
    "",
  ];

  return `${lines.join("\n")}\n`;
};

const executeFinalReportUtilityBlock = async (
  flow: RalphFlow,
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  context: RalphResultContext,
): Promise<RalphBlockExecutionResult> => {
  try {
    const rawBlockResults =
      context.executionHistory ?? Array.from(context.resultsByBlock.values());
    const executionHistory = createFinalReportExecutionHistory(rawBlockResults);
    const report: Record<string, unknown> = {
      flowId: flow.id,
      flowName: flow.name,
      runId: context.runId,
      generatedAt: new Date().toISOString(),
      variables: context.variables,
      lastResult: context.lastResult,
      performance: createFinalReportPerformanceSummary(rawBlockResults),
      blockResults: executionHistory,
      executionHistory,
      runLog: context.runLog,
      events: [...(context.events ?? [])],
      outcome: {
        status: "running",
        currentBlockId: block.id,
      },
      ...(context.autonomy
        ? { autonomy: cloneRalphRunAutonomyMetadata(context.autonomy) }
        : {}),
    };
    const resolvedJsonPath = utility.path?.trim()
      ? await resolveWorkspaceContainedMutationPath(
          utility.path,
          config.workspaceRoot,
        )
      : undefined;
    if (resolvedJsonPath) {
      await assertRalphFinalReportPathAvailable(resolvedJsonPath, context);
    }
    const jsonPath = await maybeWriteJsonArtifact(
      resolvedJsonPath,
      config.workspaceRoot,
      report,
    );
    const markdownPath = utility.markdownPath ?? utility.outputPath;
    let resolvedMarkdownPath: string | undefined;

    if (markdownPath?.trim()) {
      resolvedMarkdownPath = await resolveWorkspaceContainedMutationPath(
        markdownPath,
        config.workspaceRoot,
      );
      await assertRalphFinalReportPathAvailable(resolvedMarkdownPath, context);
      await mkdir(dirname(resolvedMarkdownPath), { recursive: true });
      await writeFileAtomically(
        resolvedMarkdownPath,
        createFinalReportMarkdown(flow, block, report),
        "utf8",
      );
    }

    context.finalReports?.push({
      flow,
      block,
      report,
      ...(jsonPath ? { jsonPath } : {}),
      ...(resolvedMarkdownPath ? { markdownPath: resolvedMarkdownPath } : {}),
    });

    return createUtilityResult(
      block,
      "SUCCESS",
      `${block.title} wrote report.`,
      {
        ...report,
        ...(jsonPath ? { jsonPath } : {}),
        ...(resolvedMarkdownPath ? { markdownPath: resolvedMarkdownPath } : {}),
      },
    );
  } catch (error) {
    return createRalphBlockExecutionErrorResult(block, error);
  }
};

const finalizeRalphFinalReportArtifacts = async (
  context: RalphResultContext,
  runResult: RalphRunResult,
): Promise<void> => {
  if (!context.finalReports || context.finalReports.length === 0) {
    return;
  }

  const executionHistory = createFinalReportExecutionHistory(
    runResult.blockResults,
  );

  for (const artifact of context.finalReports) {
    Object.assign(artifact.report, {
      finishedAt: runResult.finishedAt,
      lastResult: context.lastResult,
      performance: createFinalReportPerformanceSummary(runResult.blockResults),
      blockResults: executionHistory,
      executionHistory,
      runLog: [...context.runLog],
      events: [...runResult.events],
      outcome: runResult.outcome ?? {
        status: runResult.status,
        summary: runResult.summary,
      },
      lifecycle: {
        status: runResult.status,
        startedAt: runResult.startedAt,
        ...(runResult.finishedAt ? { finishedAt: runResult.finishedAt } : {}),
        ...(runResult.pendingInput
          ? { pendingInputId: runResult.pendingInput.id }
          : {}),
      },
      ...(runResult.autonomy
        ? { autonomy: cloneRalphRunAutonomyMetadata(runResult.autonomy) }
        : {}),
    });

    if (artifact.jsonPath) {
      await writeJsonAtomically(artifact.jsonPath, artifact.report);
    }
    if (artifact.markdownPath) {
      await writeFileAtomically(
        artifact.markdownPath,
        createFinalReportMarkdown(
          artifact.flow,
          artifact.block,
          artifact.report,
        ),
        "utf8",
      );
    }

    const reportResult = [...runResult.blockResults]
      .reverse()
      .find((result) => result.blockId === artifact.block.id);
    if (reportResult && isRecord(reportResult.data)) {
      Object.assign(reportResult.data, artifact.report);
      reportResult.markdown = formatUtilityData(reportResult.data);
    }
  }
};

const writeRalphFallbackFinalReportArtifact = async (
  flow: RalphFlow,
  context: RalphResultContext,
  runResult: RalphRunResult,
): Promise<string | undefined> => {
  if (!context.artifactRoot || (context.finalReports?.length ?? 0) > 0) {
    return undefined;
  }
  const reportBlockCount = flow.blocks.filter(
    (block) =>
      block.type === "UTILITY" && block.utility.type === "FINAL_REPORT",
  ).length;
  if (reportBlockCount < 2) {
    return undefined;
  }
  const executionHistory = createFinalReportExecutionHistory(
    runResult.blockResults,
  );
  const path = join(context.artifactRoot, "final-report.json");
  await writeJsonAtomically(path, {
    flowId: flow.id,
    flowName: flow.name,
    runId: context.runId,
    generatedAt: createLogTimestamp(),
    variables: context.variables,
    lastResult: context.lastResult,
    performance: createFinalReportPerformanceSummary(runResult.blockResults),
    blockResults: executionHistory,
    executionHistory,
    runLog: [...context.runLog],
    events: [...runResult.events],
    outcome: runResult.outcome ?? {
      status: runResult.status,
      summary: runResult.summary,
    },
    lifecycle: {
      status: runResult.status,
      startedAt: runResult.startedAt,
      ...(runResult.finishedAt ? { finishedAt: runResult.finishedAt } : {}),
    },
    fallback: {
      reason:
        "No branch-specific final-report block executed before the run ended.",
    },
    ...(runResult.autonomy
      ? { autonomy: cloneRalphRunAutonomyMetadata(runResult.autonomy) }
      : {}),
  });
  return path;
};

const ensureRalphFinalReportArtifacts = async (
  flow: RalphFlow,
  config: RuntimeConfig,
  context: RalphResultContext,
): Promise<void> => {
  const existingIds = new Set(
    (context.finalReports ?? []).map((artifact) => artifact.block.id),
  );
  const reportBlocks = flow.blocks.filter(
    (block): block is RalphUtilityBlock =>
      block.type === "UTILITY" && block.utility.type === "FINAL_REPORT",
  );
  // Only a sole graph-wide report is safe to synthesize for paths that did
  // not reach it. Multiple reports are branch-specific and are finalized only
  // when their persisted descriptor proves they executed.
  if (reportBlocks.length !== 1 || existingIds.has(reportBlocks[0]!.id)) {
    return;
  }
  const block = reportBlocks[0]!;
  const result = await executeFinalReportUtilityBlock(
    flow,
    block,
    resolveUtilityConfig(block.utility, context),
    config,
    context,
  );
  if (result.status === "error") {
    throw new Error(result.error ?? result.summary);
  }
};

const executeSetVariableUtilityBlock = (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  context: RalphResultContext,
): RalphBlockExecutionResult => {
  const name = utility.variableName?.trim();

  if (!name) {
    return createUtilityResult(
      block,
      "SUCCESS",
      `${block.title} had no variable.`,
      {},
    );
  }

  const value = utility.value ?? "";
  context.variables[name] = value;

  return createUtilityResult(block, "SUCCESS", `${block.title} set ${name}.`, {
    name,
    value,
  });
};

const getUtilityJsonInput = (
  utility: RalphUtilityConfig,
  context: RalphResultContext,
): unknown => {
  if (utility.input !== undefined) {
    return JSON.parse(utility.input);
  }

  return context.lastResult?.data ?? {};
};

const executeTransformJsonUtilityBlock = (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  context: RalphResultContext,
): RalphBlockExecutionResult => {
  try {
    const input = getUtilityJsonInput(utility, context);
    const evaluator = new Function(
      "input",
      "variables",
      "lastResult",
      "context",
      `"use strict"; return (${utility.expression ?? "input"});`,
    ) as (
      input: unknown,
      variables: Record<string, string>,
      lastResult: RalphBlockExecutionResult | undefined,
      context: RalphResultContext,
    ) => unknown;
    const output = evaluator(
      input,
      context.variables,
      context.lastResult,
      context,
    );

    return createUtilityResult(
      block,
      "SUCCESS",
      `${block.title} transformed JSON.`,
      {
        input,
        output,
      },
    );
  } catch (error) {
    return createRalphBlockExecutionErrorResult(block, error);
  }
};

interface JsonSchemaValidationResult {
  valid: boolean;
  errors: string[];
}

const ralphJsonSchemaValidator = new Ajv2020({
  allErrors: true,
  strict: false,
  allowUnionTypes: true,
  verbose: true,
});
addFormats(ralphJsonSchemaValidator);

const formatRalphJsonSchemaError = (error: ErrorObject): string => {
  const path = error.instancePath ? `$${error.instancePath}` : "$";
  if (error.keyword === "additionalProperties") {
    const property = (error.params as { additionalProperty?: unknown })
      .additionalProperty;
    return `${path}.${String(property ?? "unknown")} is not allowed.`;
  }
  if (error.keyword === "type") {
    const expected = (error.params as { type?: unknown }).type;
    const data = (error as ErrorObject & { data?: unknown }).data;
    const actual =
      data === null ? "null" : Array.isArray(data) ? "array" : typeof data;
    return `${path} expected ${String(expected ?? "configured type")}, got ${actual}.`;
  }
  return `${path} ${error.message ?? "failed JSON Schema validation"}.`;
};

export const validateJsonAgainstSchema = (
  value: unknown,
  schema: unknown,
  path = "$",
): JsonSchemaValidationResult => {
  if (schema === undefined) {
    return { valid: true, errors: [] };
  }
  try {
    const validate = ralphJsonSchemaValidator.compile(
      schema as object | boolean,
    );
    const valid = validate(value);
    return {
      valid: Boolean(valid),
      errors: valid
        ? []
        : (validate.errors ?? []).map(formatRalphJsonSchemaError),
    };
  } catch (error) {
    return {
      valid: false,
      errors: [
        `${path} uses an invalid JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
};

export const hasUnsupportedStrictJsonSchemaKeyword = (
  schema: unknown,
): boolean => {
  if (!isRecord(schema)) {
    return false;
  }

  if (
    Object.hasOwn(schema, "oneOf") ||
    Object.hasOwn(schema, "allOf") ||
    Object.hasOwn(schema, "not")
  ) {
    return true;
  }

  const nestedSchemas: unknown[] = [];
  for (const key of [
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
    "dependentSchemas",
  ] as const) {
    if (isRecord(schema[key])) {
      nestedSchemas.push(...Object.values(schema[key]));
    }
  }
  for (const key of [
    "items",
    "contains",
    "additionalProperties",
    "unevaluatedProperties",
    "propertyNames",
    "if",
    "then",
    "else",
  ] as const) {
    if (schema[key] !== undefined) {
      nestedSchemas.push(schema[key]);
    }
  }
  if (Array.isArray(schema.prefixItems)) {
    nestedSchemas.push(...schema.prefixItems);
  }

  return nestedSchemas.some(hasUnsupportedStrictJsonSchemaKeyword);
};

const executeValidateJsonUtilityBlock = (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  context: RalphResultContext,
): RalphBlockExecutionResult => {
  try {
    const input = getUtilityJsonInput(utility, context);
    const validation = validateJsonAgainstSchema(input, utility.schema);

    return createUtilityResult(
      block,
      validation.valid ? "SUCCESS" : "INVALID",
      validation.valid
        ? `${block.title} JSON is valid.`
        : `${block.title} JSON is invalid.`,
      { input, validation },
      validation.valid ? "completed" : "error",
    );
  } catch (error) {
    return createRalphBlockExecutionErrorResult(block, error);
  }
};

const parseJsonFromText = (text: string): unknown => {
  const trimmed = text.trim();

  if (!trimmed) {
    throw new SyntaxError("No JSON content found.");
  }

  try {
    return parseStrictJsonText(trimmed);
  } catch {
    // Continue with fenced and embedded JSON extraction.
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (fencedMatch?.[1]) {
    return parseStrictJsonText(fencedMatch[1].trim());
  }

  const starts = [trimmed.indexOf("{"), trimmed.indexOf("[")]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right);

  for (const start of starts) {
    const candidates = [trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]")]
      .filter((end) => end > start)
      .sort((left, right) => right - left);

    for (const end of candidates) {
      try {
        return parseStrictJsonText(trimmed.slice(start, end + 1));
      } catch {
        // Try the next candidate boundary.
      }
    }
  }

  throw new SyntaxError("Could not extract JSON from model response.");
};

const jsonSchemaAllowsNull = (schema: unknown): boolean => {
  if (!isRecord(schema)) {
    return true;
  }

  return (
    schema.type === "null" ||
    (Array.isArray(schema.type) && schema.type.includes("null")) ||
    (Array.isArray(schema.enum) && schema.enum.includes(null)) ||
    (Array.isArray(schema.anyOf) && schema.anyOf.some(jsonSchemaAllowsNull))
  );
};

const normalizeStrictStructuredOutputValue = (
  value: unknown,
  schema: unknown,
): unknown => {
  if (!isRecord(schema)) {
    return value;
  }

  if (Array.isArray(value)) {
    return schema.items === undefined
      ? value
      : value.map((entry) =>
          normalizeStrictStructuredOutputValue(entry, schema.items),
        );
  }

  const properties = schema.properties;

  if (!isRecord(value) || !isRecord(properties)) {
    return value;
  }

  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
  );

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const propertySchema = properties[key];

      if (
        entry === null &&
        !required.has(key) &&
        propertySchema !== undefined &&
        !jsonSchemaAllowsNull(propertySchema)
      ) {
        return [];
      }

      return [
        [key, normalizeStrictStructuredOutputValue(entry, propertySchema)],
      ];
    }),
  );
};

const createPromptJsonTask = (
  flow: RalphFlow,
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  context: RalphResultContext,
  repairFeedback: string | undefined,
): string => {
  const schemaText =
    utility.schema === undefined
      ? "No schema was configured. Return a single valid JSON value."
      : JSON.stringify(utility.schema, null, 2);
  const prompt = utility.prompt ?? utility.message ?? utility.input ?? "";

  return [
    `Ralph flow: ${flow.name}`,
    `Structured JSON utility block: ${block.title} (${block.id})`,
    "",
    "Return only one JSON value. Do not include markdown, code fences, comments, or prose.",
    "The JSON must satisfy this schema when one is configured:",
    schemaText,
    ...(repairFeedback
      ? ["", "Previous JSON validation failed:", repairFeedback]
      : []),
    "",
    resolveTemplateText(prompt, context),
  ].join("\n");
};

const executePromptJsonUtilityBlock = async (
  flow: RalphFlow,
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  customizations: CustomizationDiscoveryResult,
  context: RalphResultContext,
  options: RalphRunOptions,
): Promise<RalphBlockExecutionResult> => {
  const prompt = utility.prompt ?? utility.message ?? utility.input ?? "";

  if (!prompt.trim()) {
    return createUtilityResult(
      block,
      "ERROR",
      "Prompt JSON utility requires prompt.",
    );
  }

  const maxAttempts =
    utility.maxAttempts === null
      ? 1
      : typeof utility.maxAttempts === "number"
        ? utility.maxAttempts
        : 2;
  let lastText = "";
  let lastValidation: JsonSchemaValidationResult | undefined;
  let repairFeedback: string | undefined;
  const progressEvents: RalphRunRecordBlockProgressEvent[] = [];
  const runArtifactOwnership = context.artifactRoot
    ? {
        artifactRoot: context.artifactRoot,
        workspaceRoot: context.runWorkspaceRoot,
      }
    : undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const task = createPromptJsonTask(
      flow,
      block,
      utility,
      context,
      repairFeedback,
    );
    const executionOptions = await createExecutionOptions(
      options,
      config,
      context,
      block,
      options.conversationContext,
    );
    const taskExecutionOptions =
      utility.schema === undefined || utility.structuredOutput === false
        ? executionOptions
        : {
            ...executionOptions,
            structuredOutput: {
              name: `ralph_${block.id}`,
              schema: utility.schema,
              strict: !hasUnsupportedStrictJsonSchemaKeyword(utility.schema),
            },
          };

    logBlockInput(options.logger, flow, block, config, task, attempt);

    let json: unknown;
    let validation: JsonSchemaValidationResult;
    try {
      const result = await executeTask(
        task,
        config,
        customizations,
        taskExecutionOptions,
      );
      appendRalphBlockProgressEvents(
        progressEvents,
        taskExecutionOptions.ralphProgressEvents,
      );
      lastText = getResultMarkdown(result);

      if (result.status !== "executed") {
        return withRalphBlockProgress(
          createUtilityResult(
            block,
            "ERROR",
            result.summary || `${block.title} did not execute.`,
            { result },
          ),
          progressEvents,
        );
      }

      const parsedJson = parseJsonFromText(lastText);
      json = taskExecutionOptions.structuredOutput?.strict
        ? normalizeStrictStructuredOutputValue(parsedJson, utility.schema)
        : parsedJson;
      validation = validateUtilityJsonValue(json, utility.schema);
      lastValidation = validation;

      if (!validation.valid) {
        repairFeedback = validation.errors.join("\n");
        continue;
      }
    } catch (error) {
      appendRalphBlockProgressEvents(
        progressEvents,
        taskExecutionOptions.ralphProgressEvents,
      );

      if (attempt >= maxAttempts) {
        return withRalphBlockProgress(
          createRalphBlockExecutionErrorResult(block, error, attempt),
          progressEvents,
        );
      }

      repairFeedback = error instanceof Error ? error.message : String(error);
      continue;
    }

    let outputPath: string | undefined;
    try {
      outputPath = await maybeWriteJsonArtifact(
        utility.outputPath,
        config.workspaceRoot,
        json,
        runArtifactOwnership,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return withRalphBlockProgress(
        {
          ...createUtilityResult(
            block,
            "ERROR",
            `${block.title} produced schema-valid JSON but could not persist its artifact: ${message}`,
            {
              output: json,
              validation,
              attempts: attempt,
              persistence: {
                status: "failed",
                path: utility.outputPath,
                error: message,
              },
            },
          ),
          failure: { kind: "persistence", retryable: false },
        },
        progressEvents,
      );
    }

    return withRalphBlockProgress(
      createUtilityResult(block, "SUCCESS", `${block.title} produced JSON.`, {
        output: json,
        validation,
        attempts: attempt,
        ...(outputPath ? { outputPath } : {}),
      }),
      progressEvents,
    );
  }

  return withRalphBlockProgress(
    createUtilityResult(
      block,
      "INVALID",
      `${block.title} did not produce schema-valid JSON.`,
      {
        raw: lastText,
        validation: lastValidation ?? {
          valid: false,
          errors: ["No JSON parsed."],
        },
      },
    ),
    progressEvents,
  );
};

const executeValidatorJsonUtilityBlock = async (
  flow: RalphFlow,
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  customizations: CustomizationDiscoveryResult,
  context: RalphResultContext,
  options: RalphRunOptions,
): Promise<RalphBlockExecutionResult> => {
  const promptResult = await executePromptJsonUtilityBlock(
    flow,
    block,
    {
      ...utility,
      type: "PROMPT_JSON",
      schema: utility.schema ?? RALPH_VALIDATOR_JSON_SCHEMA,
      structuredOutput: utility.structuredOutput ?? true,
    },
    config,
    customizations,
    context,
    options,
  );

  if (promptResult.output !== "SUCCESS") {
    return {
      ...promptResult,
      output: promptResult.output === "ERROR" ? "ERROR" : "INVALID",
      status: promptResult.output === "ERROR" ? "error" : "error",
    };
  }

  const data = isRecord(promptResult.data) ? promptResult.data : {};
  const output = parseRalphValidatorJsonResult(data.output);

  if (!output) {
    return withRalphBlockProgress(
      createUtilityResult(
        block,
        "INVALID",
        `${block.title} did not return a valid validator decision.`,
        { output },
      ),
      promptResult.progress ?? [],
    );
  }

  const decision: RalphValidatorDecision = output.decision;

  const result = createUtilityResult(
    block,
    decision,
    output.summary,
    {
      output,
      decision,
      confidence: output.confidence,
      evidence: output.evidence,
      remainingWork: output.remainingWork,
    },
    decision === "ERROR" ? "error" : "completed",
  );

  return withRalphBlockProgress(
    decision === "ERROR"
      ? {
          ...result,
          failure: { kind: "terminal-decision", retryable: false },
        }
      : result,
    promptResult.progress ?? [],
  );
};

const executeUtilityBlock = async (
  flow: RalphFlow,
  block: RalphUtilityBlock,
  config: RuntimeConfig,
  customizations: CustomizationDiscoveryResult,
  context: RalphResultContext,
  options: RalphRunOptions,
): Promise<RalphBlockExecutionResult> => {
  const blockConfig = createBlockConfig(config, block, context);
  let utility: RalphUtilityConfig;
  try {
    utility = resolveUtilityConfig(block.utility, context);
  } catch (error) {
    return createRalphBlockExecutionErrorResult(block, error);
  }
  options.logger?.simple({
    kind: "block-input",
    message: `Prepared ${utility.type} utility.`,
    blockId: block.id,
    blockTitle: block.title,
    blockType: block.type,
    provider: blockConfig.provider,
    model: blockConfig.model,
    inputPreview: utility.type,
  });
  options.logger?.trace({
    kind: "block-input",
    message: `Resolved ${utility.type} utility configuration.`,
    blockId: block.id,
    blockTitle: block.title,
    blockType: block.type,
    provider: blockConfig.provider,
    model: blockConfig.model,
    details: {
      utility,
      settings: block.settings,
    },
  });

  switch (utility.type) {
    case "WAIT":
      return executeWaitUtilityBlock(block, utility, context, options);
    case "HTTP_FETCH":
      return executeFetchUtilityBlock(
        block,
        utility,
        context,
        blockConfig,
        options,
      );
    case "POLL":
      return executePollUtilityBlock(
        block,
        utility,
        context,
        blockConfig,
        options,
      );
    case "CONDITION":
      return executeConditionUtilityBlock(block, utility, context);
    case "RUN_COMMAND":
      return executeCommandUtilityBlock(
        block,
        utility,
        blockConfig,
        false,
        options.signal,
        context.currentOperationId,
      );
    case "RUN_CHECK":
      return executeCommandUtilityBlock(
        block,
        utility,
        blockConfig,
        true,
        options.signal,
        context.currentOperationId,
        context,
      );
    case "UI_ANALYZE":
      return executeUiAnalyzeUtilityBlock(
        block,
        utility,
        blockConfig,
        context,
        options,
      );
    case "READ_FILE":
      return executeReadFileUtilityBlock(block, utility, blockConfig);
    case "WRITE_FILE":
      return executeWriteFileUtilityBlock(block, utility, blockConfig);
    case "READ_JSON":
      return executeReadJsonUtilityBlock(block, utility, blockConfig);
    case "WRITE_JSON":
      return executeWriteJsonUtilityBlock(block, utility, blockConfig, context);
    case "PATCH_JSON":
      return executePatchJsonUtilityBlock(block, utility, blockConfig, context);
    case "APPEND_JSONL":
      return executeAppendJsonlUtilityBlock(
        block,
        utility,
        blockConfig,
        context,
      );
    case "READ_JSONL":
      return executeReadJsonlUtilityBlock(block, utility, blockConfig);
    case "QUERY_JSONL":
      return executeQueryJsonlUtilityBlock(
        block,
        utility,
        blockConfig,
        context,
      );
    case "FILE_EXISTS":
      return executeFileExistsUtilityBlock(block, utility, blockConfig);
    case "DELETE_FILE":
      return executeDeleteFileUtilityBlock(block, utility, blockConfig);
    case "MOVE_FILE":
      return executeMoveFileUtilityBlock(block, utility, blockConfig);
    case "ARCHIVE_FILE":
      return executeArchiveFileUtilityBlock(block, utility, blockConfig);
    case "LOOP_COUNTER":
      return executeLoopCounterUtilityBlock(
        block,
        utility,
        blockConfig,
        context,
      );
    case "PROMPT_JSON":
      return executePromptJsonUtilityBlock(
        flow,
        block,
        utility,
        blockConfig,
        customizations,
        context,
        options,
      );
    case "VALIDATOR_JSON":
      return executeValidatorJsonUtilityBlock(
        flow,
        block,
        utility,
        blockConfig,
        customizations,
        context,
        options,
      );
    case "ASSESS_JSON_TASKS":
      return executeAssessJsonTasksUtilityBlock(
        block,
        utility,
        blockConfig,
        context,
      );
    case "SELECT_JSON_TASK":
      return executeSelectJsonTaskUtilityBlock(
        block,
        utility,
        blockConfig,
        context,
      );
    case "MARK_JSON_TASK":
      return executeMarkJsonTaskUtilityBlock(
        block,
        utility,
        blockConfig,
        context,
      );
    case "CHANGE_SCOPE_GUARD":
      return executeChangeScopeGuardUtilityBlock(
        block,
        utility,
        blockConfig,
        context,
        options.signal,
      );
    case "SCAN_SCOPE_EVIDENCE":
      return executeScanScopeEvidenceUtilityBlock(block, utility, blockConfig);
    case "UPDATE_SCOPE_REGISTRY":
      return executeUpdateScopeRegistryUtilityBlock(
        block,
        utility,
        blockConfig,
        context,
      );
    case "BEGIN_SCOPE_CYCLE":
      return executeBeginScopeCycleUtilityBlock(
        block,
        utility,
        blockConfig,
        context,
      );
    case "SELECT_SCOPE":
      return executeSelectScopeUtilityBlock(
        block,
        utility,
        blockConfig,
        context,
      );
    case "MARK_SCOPE_RESULT":
      return executeMarkScopeResultUtilityBlock(
        block,
        utility,
        blockConfig,
        context,
      );
    case "SEARCH_FILES":
      return executeSearchFilesUtilityBlock(
        block,
        utility,
        blockConfig,
        options.signal,
      );
    case "GIT_STATUS":
      return executeGitStatusUtilityBlock(
        block,
        utility,
        blockConfig,
        options.signal,
      );
    case "GIT_SNAPSHOT":
      return executeGitSnapshotUtilityBlock(
        block,
        utility,
        blockConfig,
        options.signal,
      );
    case "GIT_DIFF_SUMMARY":
      return executeGitDiffSummaryUtilityBlock(
        block,
        utility,
        blockConfig,
        options.signal,
      );
    case "DETECT_PROJECT_COMMANDS":
      return executeDetectProjectCommandsUtilityBlock(
        block,
        utility,
        blockConfig,
      );
    case "SET_VARIABLE":
      return executeSetVariableUtilityBlock(block, utility, context);
    case "TRANSFORM_JSON":
      return executeTransformJsonUtilityBlock(block, utility, context);
    case "VALIDATE_JSON":
      return executeValidateJsonUtilityBlock(block, utility, context);
    case "FINAL_REPORT":
      return executeFinalReportUtilityBlock(
        flow,
        block,
        utility,
        blockConfig,
        context,
      );
    case "NOTIFY":
      return createUtilityResult(
        block,
        "SUCCESS",
        utility.message ?? block.title,
        {
          message: utility.message ?? block.title,
        },
      );
  }
};

const isReadOnlyMcpToolEffect = (effect: unknown): boolean => {
  return effect === "read" || effect === "external-read";
};

const isRalphMcpToolReadOnly = (
  workspaceRoot: string,
  serverId: string,
  toolName: string,
  configOverride: McpConfigOverride | undefined,
): boolean => {
  try {
    const config = loadMcpConfigSync(workspaceRoot, configOverride);
    const server = getEnabledMcpServer(config, serverId);

    if (!server) {
      return false;
    }

    const overrideEffect = server.toolOverrides?.[toolName]?.effect;

    if (overrideEffect) {
      return isReadOnlyMcpToolEffect(overrideEffect);
    }

    const discovery =
      loadMcpDiscoveryCacheSync(workspaceRoot).servers[server.id];
    const tool = discovery?.tools.find(
      (candidate) => candidate.name === toolName,
    );

    return tool?.annotations?.readOnlyHint === true;
  } catch {
    return false;
  }
};

const createRalphMcpOperationOptions = (
  block: RalphFlowBlock,
  context: RalphResultContext,
  options: RalphRunOptions,
  operation?: McpOperationCacheOptions["operation"],
  readOnly = true,
): McpOperationOptions => {
  const cache: McpOperationCacheOptions | undefined =
    operation && (operation !== "tool" || readOnly)
      ? {
          runId: context.runId,
          operation,
          readOnly,
        }
      : undefined;

  return {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(block.settings?.mcp ? { configOverride: block.settings.mcp } : {}),
    ...(cache ? { cache } : {}),
  };
};

const executeMcpToolBlock = async (
  block: RalphMcpToolBlock,
  config: RuntimeConfig,
  context: RalphResultContext,
  options: RalphRunOptions,
): Promise<RalphBlockExecutionResult> => {
  const blockConfig = createBlockConfig(config, block, context);
  const serverId = resolveTemplateText(block.serverId, context).trim();
  const toolName = resolveTemplateText(block.toolName, context).trim();
  const argumentsValue = resolveMcpArguments(block.arguments, context);
  options.logger?.trace({
    kind: "block-input",
    message: `Resolved MCP tool ${serverId}.${toolName}.`,
    blockId: block.id,
    blockTitle: block.title,
    blockType: block.type,
    provider: blockConfig.provider,
    model: blockConfig.model,
    details: {
      serverId,
      toolName,
      arguments: argumentsValue,
      settings: block.settings,
    },
  });

  if (!serverId || !toolName) {
    return createMcpErrorBlockResult(
      block,
      "MCP tool block requires resolved serverId and toolName.",
    );
  }

  try {
    const readOnly = isRalphMcpToolReadOnly(
      blockConfig.workspaceRoot,
      serverId,
      toolName,
      block.settings?.mcp,
    );
    const result = await withRalphDeadline(
      getRalphMcpTimeoutMs(block),
      options.signal,
      (signal) =>
        mcpClientManager.callTool(
          blockConfig.workspaceRoot,
          serverId,
          toolName,
          argumentsValue,
          createRalphMcpOperationOptions(
            block,
            context,
            { ...options, signal },
            "tool",
            readOnly,
          ),
        ),
    );
    const markdown = formatMcpBlockResult(result);
    const failed = isMcpCallError(result);

    return {
      blockId: block.id,
      output: failed ? "ERROR" : "SUCCESS",
      status: failed ? "error" : "completed",
      attempt: 1,
      summary: failed
        ? `MCP tool ${serverId}.${toolName} returned an error.`
        : `MCP tool ${serverId}.${toolName} completed.`,
      markdown,
      ...(failed ? { error: markdown } : {}),
    };
  } catch (error) {
    return createMcpErrorBlockResult(block, error);
  }
};

const executeMcpResourceBlock = async (
  block: RalphMcpResourceBlock,
  config: RuntimeConfig,
  context: RalphResultContext,
  options: RalphRunOptions,
): Promise<RalphBlockExecutionResult> => {
  const blockConfig = createBlockConfig(config, block, context);
  const serverId = resolveTemplateText(block.serverId, context).trim();
  const uri = resolveTemplateText(block.uri, context).trim();
  options.logger?.trace({
    kind: "block-input",
    message: `Resolved MCP resource ${serverId}.${uri}.`,
    blockId: block.id,
    blockTitle: block.title,
    blockType: block.type,
    provider: blockConfig.provider,
    model: blockConfig.model,
    details: {
      serverId,
      uri,
      settings: block.settings,
    },
  });

  if (!serverId || !uri) {
    return createMcpErrorBlockResult(
      block,
      "MCP resource block requires resolved serverId and uri.",
    );
  }

  try {
    const result = await withRalphDeadline(
      getRalphMcpTimeoutMs(block),
      options.signal,
      (signal) =>
        mcpClientManager.readResource(
          blockConfig.workspaceRoot,
          serverId,
          uri,
          createRalphMcpOperationOptions(
            block,
            context,
            { ...options, signal },
            "resource",
          ),
        ),
    );
    const markdown = formatMcpBlockResult(result);

    return {
      blockId: block.id,
      output: "SUCCESS",
      status: "completed",
      attempt: 1,
      summary: `MCP resource ${serverId}.${uri} read.`,
      markdown,
    };
  } catch (error) {
    return createMcpErrorBlockResult(block, error);
  }
};

const executeMcpPromptBlock = async (
  block: RalphMcpPromptBlock,
  config: RuntimeConfig,
  context: RalphResultContext,
  options: RalphRunOptions,
): Promise<RalphBlockExecutionResult> => {
  const blockConfig = createBlockConfig(config, block, context);
  const serverId = resolveTemplateText(block.serverId, context).trim();
  const promptName = resolveTemplateText(block.promptName, context).trim();
  const argumentsValue = resolveMcpPromptArguments(block.arguments, context);
  options.logger?.trace({
    kind: "block-input",
    message: `Resolved MCP prompt ${serverId}.${promptName}.`,
    blockId: block.id,
    blockTitle: block.title,
    blockType: block.type,
    provider: blockConfig.provider,
    model: blockConfig.model,
    details: {
      serverId,
      promptName,
      arguments: argumentsValue,
      settings: block.settings,
    },
  });

  if (!serverId || !promptName) {
    return createMcpErrorBlockResult(
      block,
      "MCP prompt block requires resolved serverId and promptName.",
    );
  }

  try {
    const result = await withRalphDeadline(
      getRalphMcpTimeoutMs(block),
      options.signal,
      (signal) =>
        mcpClientManager.getPrompt(
          blockConfig.workspaceRoot,
          serverId,
          promptName,
          argumentsValue,
          createRalphMcpOperationOptions(
            block,
            context,
            { ...options, signal },
            "prompt",
          ),
        ),
    );
    const markdown = formatMcpBlockResult(result);

    return {
      blockId: block.id,
      output: "SUCCESS",
      status: "completed",
      attempt: 1,
      summary: `MCP prompt ${serverId}.${promptName} fetched.`,
      markdown,
    };
  } catch (error) {
    return createMcpErrorBlockResult(block, error);
  }
};

interface RalphMediaBridgeAsset {
  id: string;
  kind: "image" | "report";
}

interface RalphMediaBridgeHumanReview {
  status: "queued" | "pending" | "approved" | "rejected";
  selectedAssetIds: string[];
}

interface RalphMediaBridgeRunDetail {
  id: string;
  status:
    | "queued"
    | "running"
    | "needs-review"
    | "waiting-for-review"
    | "canceling"
    | "completed"
    | "failed"
    | "canceled";
  currentStep: string;
  error: string | null;
  assets: RalphMediaBridgeAsset[];
  humanReviews: RalphMediaBridgeHumanReview[];
}

interface RalphMediaBridgeResponse {
  schemaVersion: 1;
  requestId: string;
  ok: boolean;
  detail?: RalphMediaBridgeRunDetail;
  error?: string;
}

type RalphMediaBridgeRequest =
  | {
      action: "ensure-run";
      runId: string;
      flowId: string;
      revisionId: string;
      inputBindings: Record<string, RalphMediaResolvedInputBinding>;
      approvalPolicy: RalphMediaFlowApprovalPolicy;
    }
  | { action: "inspect-run"; runId: string };

const waitForRalphMediaBridgePoll = async (
  signal?: AbortSignal,
): Promise<void> => {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const finish = (callback: () => void): void => {
      if (handle) clearTimeout(handle);
      signal?.removeEventListener("abort", handleAbort);
      callback();
    };
    const handleAbort = (): void => {
      finish(() =>
        rejectPromise(
          signal?.reason ?? new Error("Ralph media wait was cancelled."),
        ),
      );
    };
    const handle = setTimeout(
      () => finish(resolvePromise),
      RALPH_MEDIA_BRIDGE_POLL_MS,
    );
    if (signal?.aborted) {
      handleAbort();
      return;
    }
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
};

const removeRalphMediaBridgeFile = async (path: string): Promise<void> => {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
};

const requestRalphMediaBridge = async (
  request: RalphMediaBridgeRequest,
  signal?: AbortSignal,
): Promise<RalphMediaBridgeRunDetail> => {
  const requestPath = process.env[RALPH_MEDIA_BRIDGE_REQUEST_PATH_ENV]?.trim();
  const responsePath =
    process.env[RALPH_MEDIA_BRIDGE_RESPONSE_PATH_ENV]?.trim();
  const token = process.env[RALPH_MEDIA_BRIDGE_TOKEN_ENV]?.trim();
  if (!requestPath || !responsePath || !token) {
    throw new Error(
      "Media Studio is unavailable in this Ralph runtime. Run the flow from the desktop app.",
    );
  }

  const requestId = randomUUID();
  const temporaryPath = `${requestPath}.${process.pid}.${requestId}.tmp`;
  await removeRalphMediaBridgeFile(responsePath);
  await writeFile(
    temporaryPath,
    JSON.stringify({
      schemaVersion: 1,
      requestId,
      token,
      ...request,
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  await rename(temporaryPath, requestPath);

  const deadline = Date.now() + RALPH_MEDIA_BRIDGE_RESPONSE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw (
        signal.reason ?? new Error("Ralph media bridge request was cancelled.")
      );
    }
    try {
      const raw = await readFile(responsePath, "utf8");
      const response = JSON.parse(raw) as RalphMediaBridgeResponse;
      if (response.requestId !== requestId) {
        await waitForRalphMediaBridgePoll(signal);
        continue;
      }
      await removeRalphMediaBridgeFile(responsePath);
      if (!response.ok || !response.detail) {
        throw new Error(
          response.error || "Media Studio rejected the Ralph bridge request.",
        );
      }
      return response.detail;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await waitForRalphMediaBridgePoll(signal);
  }

  throw new Error(
    "Media Studio did not answer the Ralph bridge request within 30 seconds.",
  );
};

const resolveRalphMediaInputBindings = (
  block: RalphMediaFlowBlock,
  config: RuntimeConfig,
  context: RalphResultContext,
): Record<string, RalphMediaResolvedInputBinding> => {
  return Object.fromEntries(
    Object.entries(block.inputBindings).map(([inputId, binding]) => {
      if (binding.source === "variable") {
        const value = context.variables[binding.variableName];
        if (value === undefined) {
          throw new Error(
            `Media input ${inputId} references unavailable Ralph variable ${binding.variableName}.`,
          );
        }
        return [inputId, { source: "literal", value }] as const;
      }
      if (binding.source === "literal") {
        const value =
          typeof binding.value === "string"
            ? resolveTemplateText(binding.value, context)
            : binding.value;
        return [inputId, { source: "literal", value }] as const;
      }
      if (binding.source === "path") {
        const path = resolveWorkspaceContainedUtilityPath(
          resolveTemplateText(binding.path, context),
          config.workspaceRoot,
        );
        return [inputId, { source: "path", value: path }] as const;
      }
      const assetId = binding.assetId.trim();
      if (!assetId) {
        throw new Error(`Media input ${inputId} requires a stable asset id.`);
      }
      return [inputId, { source: "media-asset", value: assetId }] as const;
    }),
  );
};

const createRalphMediaInputRequest = (
  block: RalphMediaFlowBlock,
  context: RalphResultContext,
  runId: string,
  stage: NonNullable<RalphInputRequest["mediaFlow"]>["stage"],
): RalphInputRequest => ({
  id: randomUUID(),
  runId: context.runId,
  blockId: block.id,
  blockType: block.type,
  title:
    stage === "preflight"
      ? `Review ${block.title} preflight`
      : `Review ${block.title} in Media Studio`,
  prompt:
    stage === "preflight"
      ? "Confirm this pinned Media Studio revision before Ralph enqueues a durable run."
      : "The media run released its compute lease and is waiting for a decision in Media Studio. Return here after resolving it.",
  fields: [],
  submitLabel:
    stage === "preflight" ? "Approve and run" : "Check review status",
  cancelLabel: stage === "preflight" ? "Cancel" : "Stop waiting",
  createdAt: new Date().toISOString(),
  mediaFlow: {
    stage,
    flowId: block.flowId,
    revisionId: block.revisionId,
    runId,
  },
});

const getRalphMediaPublishedAssetIds = (
  detail: RalphMediaBridgeRunDetail,
): string[] => {
  const approvedIds = detail.humanReviews.flatMap((review) =>
    review.status === "approved" ? review.selectedAssetIds : [],
  );
  if (detail.humanReviews.length > 0) {
    return [...new Set(approvedIds)];
  }
  return detail.assets
    .filter((asset) => asset.kind === "image")
    .map((asset) => asset.id);
};

const applyRalphMediaOutputBindings = (
  block: RalphMediaFlowBlock,
  detail: RalphMediaBridgeRunDetail,
  context: RalphResultContext,
): Record<string, string> => {
  const assetIds = getRalphMediaPublishedAssetIds(detail);
  const reportIds = detail.assets
    .filter((asset) => asset.kind === "report")
    .map((asset) => asset.id);
  const values: Record<string, string> = {};
  for (const binding of Object.values(block.outputBindings)) {
    const value =
      binding.source === "run-id"
        ? detail.id
        : binding.source === "status"
          ? detail.status
          : binding.source === "first-asset-id"
            ? (assetIds[0] ?? "")
            : JSON.stringify(
                binding.source === "quality-report-ids" ? reportIds : assetIds,
              );
    context.variables[binding.variableName] = value;
    values[binding.variableName] = value;
  }
  return values;
};

const executeMediaFlowBlock = async (
  block: RalphMediaFlowBlock,
  config: RuntimeConfig,
  context: RalphResultContext,
  options: RalphRunOptions,
): Promise<RalphExecutionStepResult> => {
  const operationKey =
    context.currentOperationId ?? `${context.runId}:${block.id}`;
  const generatedRunId = `ralph-media-${createHash("sha256")
    .update(
      `${context.runId}\0${block.id}\0${block.revisionId}\0${operationKey}`,
    )
    .digest("hex")
    .slice(0, 48)}`;
  const checkpoint = context.mediaRuns?.get(block.id);
  if (
    checkpoint &&
    (checkpoint.flowId !== block.flowId ||
      checkpoint.revisionId !== block.revisionId)
  ) {
    return {
      blockId: block.id,
      output: "ERROR",
      status: "error",
      attempt: 1,
      summary: `${block.title} cannot resume because its pinned Media Studio revision changed.`,
      error: "The durable media checkpoint does not match this block revision.",
    };
  }
  const runId = checkpoint?.runId ?? generatedRunId;
  const pendingInput = getPendingInputForBlock(block, options);
  const response = getMatchingInputResponse(block, options);

  if (pendingInput?.mediaFlow?.stage === "preflight") {
    if (!response) {
      return {
        kind: "input-wait",
        request: pendingInput,
        summary: `${block.title} is waiting for Media Studio preflight approval.`,
      };
    }
    if (response.action === "cancel") {
      return {
        blockId: block.id,
        output: "CANCELLED",
        status: "completed",
        attempt: 1,
        summary: `${block.title} preflight was cancelled.`,
      };
    }
  } else if (
    block.approvalPolicy === "always-review-preflight" &&
    !checkpoint
  ) {
    return {
      kind: "input-wait",
      request: createRalphMediaInputRequest(block, context, runId, "preflight"),
      summary: `${block.title} is waiting for Media Studio preflight approval.`,
    };
  }

  const inputBindings =
    checkpoint?.inputBindings ??
    resolveRalphMediaInputBindings(block, config, context);
  context.mediaRuns?.set(block.id, {
    blockId: block.id,
    flowId: block.flowId,
    revisionId: block.revisionId,
    runId,
    inputBindings,
    submittedAt: checkpoint?.submittedAt ?? new Date().toISOString(),
  });

  let detail = await requestRalphMediaBridge(
    checkpoint
      ? { action: "inspect-run", runId }
      : {
          action: "ensure-run",
          runId,
          flowId: block.flowId,
          revisionId: block.revisionId,
          inputBindings,
          approvalPolicy: block.approvalPolicy,
        },
    options.signal,
  );

  if (block.runPolicy === "submit-and-continue") {
    return {
      blockId: block.id,
      output: "SUCCESS",
      status: "completed",
      attempt: 1,
      summary: `${block.title} submitted detached Media Studio run ${runId}.`,
      data: {
        mediaRun: {
          source: "media-run",
          workspaceRoot: config.workspaceRoot,
          runId,
        },
        detached: true,
      },
    };
  }

  while (["queued", "running", "canceling"].includes(detail.status)) {
    await waitForRalphMediaBridgePoll(options.signal);
    detail = await requestRalphMediaBridge(
      { action: "inspect-run", runId },
      options.signal,
    );
  }

  if (
    detail.status === "waiting-for-review" ||
    detail.status === "needs-review"
  ) {
    if (response?.action === "cancel") {
      return {
        blockId: block.id,
        output: "CANCELLED",
        status: "completed",
        attempt: 1,
        summary: `${block.title} stopped waiting; Media Studio still owns run ${runId}.`,
        data: { runId, mediaRunContinues: true },
      };
    }
    const stage =
      detail.status === "waiting-for-review"
        ? "human-review"
        : "provider-review";
    return {
      kind: "input-wait",
      request:
        pendingInput?.mediaFlow?.runId === runId
          ? pendingInput
          : createRalphMediaInputRequest(block, context, runId, stage),
      summary: `${block.title} requires a Media Studio review for run ${runId}.`,
    };
  }

  if (detail.status === "canceled") {
    return {
      blockId: block.id,
      output: "CANCELLED",
      status: "completed",
      attempt: 1,
      summary: `${block.title} media run was canceled.`,
      data: { runId },
    };
  }
  if (detail.status === "failed") {
    return {
      blockId: block.id,
      output: "ERROR",
      status: "error",
      attempt: 1,
      summary: `${block.title} media run failed: ${detail.error ?? detail.currentStep}`,
      error: detail.error ?? detail.currentStep,
      data: { runId },
    };
  }

  const boundOutputs = applyRalphMediaOutputBindings(block, detail, context);
  const assetIds = getRalphMediaPublishedAssetIds(detail);
  return {
    blockId: block.id,
    output:
      assetIds.length > 0 || Object.keys(block.outputBindings).length === 0
        ? "SUCCESS"
        : "PARTIAL",
    status: "completed",
    attempt: 1,
    summary: `${block.title} completed Media Studio run ${runId} with ${assetIds.length} published asset${assetIds.length === 1 ? "" : "s"}.`,
    data: {
      mediaRun: {
        source: "media-run",
        workspaceRoot: config.workspaceRoot,
        runId,
        outputAssetIds: assetIds,
      },
      outputs: boundOutputs,
    },
  };
};

const executeBlock = async (
  flow: RalphFlow,
  block: RalphFlowBlock,
  config: RuntimeConfig,
  customizations: CustomizationDiscoveryResult,
  context: RalphResultContext,
  options: RalphRunOptions,
): Promise<RalphExecutionStepResult> => {
  switch (block.type) {
    case "START":
      return {
        blockId: block.id,
        output: "SUCCESS",
        status: "skipped",
        attempt: 1,
        summary: "Start.",
      };
    case "PROMPT":
      return executePromptBlock(
        flow,
        block,
        config,
        customizations,
        context,
        options,
      );
    case "VALIDATOR":
      return executeValidatorBlock(
        flow,
        block,
        config,
        customizations,
        context,
        options,
      );
    case "DECISION":
      return executeDecisionBlock(
        flow,
        block,
        config,
        customizations,
        context,
        options,
      );
    case "PACK":
      return {
        blockId: block.id,
        output: "SUCCESS",
        status: "skipped",
        attempt: 1,
        summary: `Applied pack block ${block.title}.`,
      };
    case "ASK_USER":
      return executeAskUserBlock(block, context, options);
    case "INTERVIEW":
      return executeInterviewBlock(
        flow,
        block,
        config,
        customizations,
        context,
        options,
      );
    case "UTILITY":
      return executeUtilityBlock(
        flow,
        block,
        config,
        customizations,
        context,
        options,
      );
    case "MCP_TOOL":
      return executeMcpToolBlock(block, config, context, options);
    case "MCP_RESOURCE":
      return executeMcpResourceBlock(block, config, context, options);
    case "MCP_PROMPT":
      return executeMcpPromptBlock(block, config, context, options);
    case "MEDIA_FLOW":
      return executeMediaFlowBlock(block, config, context, options);
    case "NOTE":
    case "GROUP":
      return {
        blockId: block.id,
        output: "ERROR",
        status: "error",
        attempt: 1,
        summary: `${block.title} is a visual Ralph block and cannot be executed.`,
        error: "Visual Ralph blocks are not executable.",
      };
    case "END": {
      const endStatus = getRunStatusForEndBlock(block);
      return {
        blockId: block.id,
        output:
          endStatus === "completed"
            ? "SUCCESS"
            : endStatus === "stopped"
              ? "CANCELLED"
              : "ERROR",
        status:
          endStatus === "completed"
            ? "completed"
            : endStatus === "stopped"
              ? "skipped"
              : "error",
        attempt: 1,
        summary: `Reached ${block.title} with run status ${endStatus}.`,
      };
    }
  }
};

const getValidatorGroupStart = (
  flow: RalphFlow,
  validatorBlockId: string,
): string | undefined => {
  const validatorIndex = flow.blocks.findIndex(
    (block) => block.id === validatorBlockId,
  );

  if (validatorIndex <= 0) {
    return undefined;
  }

  let boundaryIndex = -1;
  for (let index = validatorIndex - 1; index >= 0; index -= 1) {
    const block = flow.blocks[index];

    if (
      block &&
      (block.type === "START" ||
        block.type === "VALIDATOR" ||
        block.type === "DECISION" ||
        block.groupBoundary)
    ) {
      boundaryIndex = index;
      break;
    }
  }

  for (let index = boundaryIndex + 1; index < validatorIndex; index += 1) {
    const block = flow.blocks[index];

    if (block && isExecutableRalphBlock(block)) {
      return block.id;
    }
  }

  return undefined;
};

const updateResultContext = (
  context: RalphResultContext,
  result: RalphBlockExecutionResult,
): void => {
  const repositoryContext =
    isRecord(result.data) && isRecord(result.data.repositoryContext)
      ? (result.data.repositoryContext as unknown as RalphRepositoryContext)
      : undefined;
  if (repositoryContext?.digest) {
    if (context.repositoryContext) {
      assertRalphRepositoryContextUnchanged(
        context.repositoryContext,
        repositoryContext,
      );
    }
    context.repositoryContext = repositoryContext;
  }
  const repositoryBaseline =
    isRecord(result.data) && isRecord(result.data.repositoryBaseline)
      ? (result.data.repositoryBaseline as unknown as RalphGitChangeSnapshot)
      : undefined;
  if (
    repositoryBaseline?.root &&
    (!context.repositoryBaseline ||
      normalizeComparableRepositoryPath(context.repositoryBaseline.root) !==
        normalizeComparableRepositoryPath(repositoryBaseline.root))
  ) {
    context.repositoryBaseline = repositoryBaseline;
    if (context.progress) {
      context.progress.channelFingerprints.repository =
        createRalphRepositoryProgressFingerprint(repositoryBaseline);
    }
  }
  context.lastResult = result;
  context.resultsByBlock.set(result.blockId, result);
  context.runLog.push(
    `${result.blockId}: ${result.output} - ${result.summary}`,
  );
};

const normalizeComparableRepositoryPath = (value: string): string => {
  const normalized = resolve(normalizeLocalCommandCwd(value))
    .replace(/\\/gu, "/")
    .replace(/\/+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const hasRalphGitMetadata = (path: string, workspaceRoot: string): boolean => {
  const normalizedWorkspace = resolve(normalizeLocalCommandCwd(workspaceRoot));
  let current = resolve(normalizeLocalCommandCwd(path));
  while (isResolvedPathInsideWorkspace(current, normalizedWorkspace)) {
    if (existsSync(join(current, ".git"))) {
      return true;
    }
    if (
      normalizeComparableRepositoryPath(current) ===
      normalizeComparableRepositoryPath(normalizedWorkspace)
    ) {
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return false;
};

const createRalphRepositorySnapshotFingerprint = (
  snapshot: RalphGitChangeSnapshot,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        root: normalizeComparableRepositoryPath(snapshot.root),
        head: snapshot.head,
        files: [...snapshot.files]
          .map((file) => ({ path: file.path, signature: file.signature }))
          .sort((left, right) => left.path.localeCompare(right.path)),
      }),
    )
    .digest("hex");

export const compareRalphRepositorySnapshots = (
  baseline: RalphGitChangeSnapshot,
  final: RalphGitChangeSnapshot,
): RalphRepositoryOutcomeEvidence => {
  const baselineFingerprint =
    createRalphRepositorySnapshotFingerprint(baseline);
  const finalFingerprint = createRalphRepositorySnapshotFingerprint(final);
  if (
    normalizeComparableRepositoryPath(baseline.root) !==
    normalizeComparableRepositoryPath(final.root)
  ) {
    return {
      known: false,
      root: baseline.root,
      changedFiles: [],
      headChanged: false,
      baselineFingerprint,
      finalFingerprint,
      reason: `Repository evidence root changed from ${baseline.root} to ${final.root}.`,
    };
  }

  const baselineFiles = new Map(
    baseline.files.map((file) => [file.path, file.signature]),
  );
  const finalFiles = new Map(
    final.files.map((file) => [file.path, file.signature]),
  );
  const changedFiles = [
    ...new Set([...baselineFiles.keys(), ...finalFiles.keys()]),
  ]
    .filter((path) => baselineFiles.get(path) !== finalFiles.get(path))
    .sort();

  return {
    known: true,
    root: baseline.root,
    changedFiles,
    headChanged: baseline.head !== final.head,
    baselineFingerprint,
    finalFingerprint,
  };
};

const doesBlockPreserveRepositorySnapshot = (
  block: RalphFlowBlock,
): boolean => {
  if (
    block.type === "START" ||
    block.type === "END" ||
    block.type === "NOTE" ||
    block.type === "GROUP" ||
    block.type === "PACK"
  ) {
    return true;
  }

  if (block.type !== "UTILITY") {
    return false;
  }

  if (block.utility.type === "CHANGE_SCOPE_GUARD") {
    return true;
  }
  if (block.utility.type === "FINAL_REPORT") {
    return (
      !block.utility.path?.trim() &&
      !block.utility.markdownPath?.trim() &&
      !block.utility.outputPath?.trim()
    );
  }
  if (
    block.utility.type === "GIT_STATUS" ||
    block.utility.type === "GIT_SNAPSHOT" ||
    block.utility.type === "GIT_DIFF_SUMMARY"
  ) {
    return !block.utility.outputPath?.trim();
  }

  return false;
};

const findReusableFinalRepositorySnapshot = (
  flow: RalphFlow,
  blockResults: readonly RalphBlockExecutionResult[],
  repositoryRoot: string,
  workspaceRoot: string,
): { blockId: string; snapshot: RalphGitChangeSnapshot } | undefined => {
  const blocksById = new Map(flow.blocks.map((block) => [block.id, block]));

  for (let index = blockResults.length - 1; index >= 0; index -= 1) {
    const result = blockResults[index];
    const producer = result ? blocksById.get(result.blockId) : undefined;
    const isRepositorySnapshotProducer =
      producer?.type === "UTILITY" &&
      (producer.utility.type === "GIT_STATUS" ||
        producer.utility.type === "GIT_SNAPSHOT" ||
        producer.utility.type === "GIT_DIFF_SUMMARY");
    const snapshot = isRepositorySnapshotProducer
      ? extractGitChangeSnapshot(result?.data, workspaceRoot)
      : undefined;

    if (
      !result ||
      !snapshot ||
      normalizeComparableRepositoryPath(snapshot.root) !==
        normalizeComparableRepositoryPath(repositoryRoot)
    ) {
      continue;
    }

    const laterResults = blockResults.slice(index + 1);
    if (
      laterResults.every((laterResult) => {
        const block = blocksById.get(laterResult.blockId);
        return block ? doesBlockPreserveRepositorySnapshot(block) : false;
      })
    ) {
      return { blockId: result.blockId, snapshot };
    }

    return undefined;
  }

  return undefined;
};

const getRunStatusForEndBlock = (block: RalphEndBlock): RalphRunStatus => {
  if (block.outcome === "deferred" || block.outcome === "blocked") {
    return "blocked";
  }
  if (block.outcome === "cancelled") {
    return "stopped";
  }
  switch (block.status) {
    case "failed":
    case "review":
      return "blocked";
    case "cancelled":
      return "stopped";
    case "success":
    case undefined:
      return "completed";
    default:
      return "completed";
  }
};

const RECOVERABLE_RALPH_OUTPUTS = new Set<RalphExecutionOutput>([
  "ERROR",
  "FAILED",
  "INVALID",
  "INCONCLUSIVE",
  "OUT_OF_SCOPE",
  "TIMEOUT",
  "HTTP_ERROR",
  "EMPTY",
  "NOT_FOUND",
]);

const isRecoverableRalphBlockResult = (
  block: RalphFlowBlock,
  result: RalphBlockExecutionResult,
): boolean => {
  return (
    block.type !== "END" &&
    result.failure?.retryable !== false &&
    (result.status === "error" || RECOVERABLE_RALPH_OUTPUTS.has(result.output))
  );
};

const withRalphDeadline = async <Value>(
  timeoutMs: number,
  outerSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<Value>,
): Promise<Value> => {
  const controller = new AbortController();
  const handleOuterAbort = (): void => {
    controller.abort(outerSignal?.reason ?? new Error("Ralph run stopped."));
  };
  if (outerSignal?.aborted) {
    handleOuterAbort();
  } else {
    outerSignal?.addEventListener("abort", handleOuterAbort, { once: true });
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(
      () => {
        const error = new Error(
          `Ralph operation timed out after ${timeoutMs}ms.`,
        );
        controller.abort(error);
        reject(error);
      },
      Math.max(1, timeoutMs),
    );
  });

  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    outerSignal?.removeEventListener("abort", handleOuterAbort);
  }
};

const getRalphMcpTimeoutMs = (block: RalphFlowBlock): number => {
  const seconds = block.settings?.timeoutSeconds;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? seconds * 1_000
    : DEFAULT_RALPH_MCP_TIMEOUT_MS;
};

const isRalphBlockReplaySafe = (block: RalphFlowBlock): boolean => {
  if (
    block.type === "START" ||
    block.type === "END" ||
    block.type === "NOTE" ||
    block.type === "GROUP" ||
    block.type === "PACK" ||
    block.type === "ASK_USER" ||
    block.type === "INTERVIEW"
  ) {
    return true;
  }
  if (block.type === "MCP_RESOURCE" || block.type === "MCP_PROMPT") {
    return true;
  }
  if (block.type === "MEDIA_FLOW") {
    return true;
  }
  if (block.type !== "UTILITY") {
    return false;
  }

  if (block.utility.type === "WRITE_FILE") {
    return block.utility.append !== true;
  }
  if (block.utility.type === "HTTP_FETCH" || block.utility.type === "POLL") {
    return block.utility.replayPolicy === "safe";
  }

  return [
    "WAIT",
    "CONDITION",
    "READ_FILE",
    "READ_JSON",
    "READ_JSONL",
    "QUERY_JSONL",
    "ASSESS_JSON_TASKS",
    "APPEND_JSONL",
    "FILE_EXISTS",
    "SCAN_SCOPE_EVIDENCE",
    "SEARCH_FILES",
    "GIT_STATUS",
    "GIT_SNAPSHOT",
    "GIT_DIFF_SUMMARY",
    "DETECT_PROJECT_COMMANDS",
    "WRITE_JSON",
    "SELECT_JSON_TASK",
    "MARK_JSON_TASK",
    "SET_VARIABLE",
    "TRANSFORM_JSON",
    "VALIDATE_JSON",
    "FINAL_REPORT",
    "NOTIFY",
  ].includes(block.utility.type);
};

const cloneRalphRunAutonomyMetadata = (
  metadata: RalphRunAutonomyMetadata,
): RalphRunAutonomyMetadata => ({
  ...metadata,
  policy: {
    ...metadata.policy,
    backoff: { ...metadata.policy.backoff },
  },
  recoveryAttempts: metadata.recoveryAttempts.map((attempt) => ({
    ...attempt,
  })),
  recovered: metadata.recovered.map((recovered) => ({ ...recovered })),
  deferred: metadata.deferred.map((deferred) => ({ ...deferred })),
  ...(metadata.exhaustion ? { exhaustion: { ...metadata.exhaustion } } : {}),
});

const createRalphRunAutonomyMetadata = (
  policy: ResolvedRalphAutonomyPolicy,
  restored: RalphRunAutonomyMetadata | undefined,
): RalphRunAutonomyMetadata | undefined => {
  if (!policy.enabled) {
    return undefined;
  }

  const metadata = restored
    ? cloneRalphRunAutonomyMetadata(restored)
    : {
        enabled: true as const,
        policy: {
          recoverFailedEnd: policy.recoverFailedEnd,
          maxRecoveryAttempts: policy.maxRecoveryAttempts,
          backoff: { ...policy.backoff },
          transitionExhaustion: policy.transitionExhaustion,
          recoveryExhaustion: policy.recoveryExhaustion,
          maxStagnantTransitions: policy.maxStagnantTransitions,
          maxRepeatedCycle: policy.maxRepeatedCycle,
          ...(policy.deferToBlockId
            ? { deferToBlockId: policy.deferToBlockId }
            : {}),
        },
        recoveryAttempts: [],
        recovered: [],
        deferred: [],
        totalTransitions: 0,
      };

  metadata.policy = {
    recoverFailedEnd: policy.recoverFailedEnd,
    maxRecoveryAttempts: policy.maxRecoveryAttempts,
    backoff: { ...policy.backoff },
    transitionExhaustion: policy.transitionExhaustion,
    recoveryExhaustion: policy.recoveryExhaustion,
    maxStagnantTransitions: policy.maxStagnantTransitions,
    maxRepeatedCycle: policy.maxRepeatedCycle,
    ...(policy.deferToBlockId ? { deferToBlockId: policy.deferToBlockId } : {}),
  };

  return metadata;
};

const getDirectFailedEndBlock = (
  flow: RalphFlow,
  blockMap: ReadonlyMap<string, RalphFlowBlock>,
  block: RalphFlowBlock,
  result: RalphBlockExecutionResult,
): { edge: RalphFlowEdge; block: RalphEndBlock } | undefined => {
  if (!isRecoverableRalphBlockResult(block, result)) {
    return undefined;
  }

  const edge = findOutgoingRalphEdge(flow, block.id, result.output);
  const target = edge ? blockMap.get(edge.to) : undefined;

  return edge &&
    target?.type === "END" &&
    getRunStatusForEndBlock(target) === "blocked"
    ? { edge, block: target }
    : undefined;
};

const createBlockedRunResult = (
  flow: RalphFlow,
  validation: RalphValidationResult,
  summary: string,
  missingVariables: string[] = [],
  unknownVariables: string[] = [],
): RalphRunResult => {
  return {
    flow: flow.id,
    status: "blocked",
    summary,
    events: [],
    blockResults: [],
    missingVariables,
    unknownVariables,
    validation,
  };
};

const createRalphRunLease = (
  ownerId: string,
  previous: RalphRunLease | undefined,
  durationMs: number,
): RalphRunLease => {
  const now = new Date();
  const sameOwner = previous?.ownerId === ownerId;
  return {
    ownerId,
    generation: sameOwner
      ? previous.generation
      : (previous?.generation ?? 0) + 1,
    acquiredAt: sameOwner ? previous.acquiredAt : now.toISOString(),
    heartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + durationMs).toISOString(),
  };
};

const acquireRalphRunLeaseGeneration = (
  ownerId: string,
  previous: RalphRunLease | undefined,
  durationMs: number,
): RalphRunLease => {
  const now = new Date();

  return {
    ownerId,
    generation: (previous?.generation ?? 0) + 1,
    acquiredAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + durationMs).toISOString(),
  };
};

class RalphRunOwnershipLostError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RalphRunOwnershipLostError";
  }
}

const createRalphCheckpointFence = (
  checkpoint: RalphRunCheckpoint | undefined,
): string | undefined => {
  if (!checkpoint) {
    return undefined;
  }

  const comparable = {
    ...checkpoint,
    ...(checkpoint.lease
      ? {
          lease: {
            ownerId: checkpoint.lease.ownerId,
            generation: checkpoint.lease.generation,
            acquiredAt: checkpoint.lease.acquiredAt,
            ...(checkpoint.lease.releasedAt
              ? { releasedAt: checkpoint.lease.releasedAt }
              : {}),
          },
        }
      : {}),
  };
  delete comparable.durability;

  return createHash("sha256")
    .update(JSON.stringify(canonicalizeRalphValue(comparable)))
    .digest("hex");
};

const isLiveForeignRalphRunLease = (
  lease: RalphRunLease | undefined,
  ownerId: string,
): boolean =>
  Boolean(
    lease &&
    !lease.releasedAt &&
    lease.ownerId !== ownerId &&
    Date.parse(lease.expiresAt) > Date.now(),
  );

const runRalphFlowImpl = async (
  flow: RalphFlow,
  config: RuntimeConfig,
  customizations: CustomizationDiscoveryResult,
  options: RalphRunOptions = {},
): Promise<RalphRunResult> => {
  options = { ...options };
  const logger = options.logger;
  const runStore = logger?.paths
    ? new RalphRunStore(dirname(logger.paths.recordPath))
    : undefined;
  let runStoreInitializationError: unknown;
  let checkpoint = options.checkpoint;
  let checkpointRestoredFromRunStore = false;
  if (runStore) {
    try {
      await runStore.initialize();
      const restored = await runStore.readLatestCheckpoint();
      const restoredTransitions =
        restored?.checkpoint.totalTransitions ??
        (restored?.checkpoint.transitionBase ?? 0) +
          (restored?.checkpoint.transitions ?? 0);
      const suppliedTransitions =
        checkpoint?.totalTransitions ??
        (checkpoint?.transitionBase ?? 0) + (checkpoint?.transitions ?? 0);
      if (
        restored?.checkpoint.flowId === flow.id &&
        (!options.runId || restored.checkpoint.runId === options.runId) &&
        (!checkpoint ||
          (checkpoint.flowId === restored.checkpoint.flowId &&
            checkpoint.runId === restored.checkpoint.runId &&
            restoredTransitions >= suppliedTransitions))
      ) {
        checkpoint = restored.checkpoint;
        options.checkpoint = checkpoint;
        checkpointRestoredFromRunStore = true;
      }
    } catch (error) {
      runStoreInitializationError = error;
    }
  }
  const runId =
    logger?.runId ??
    options.runId ??
    checkpoint?.runId ??
    `ralph-${flow.id}-${randomUUID()}`;
  const startedAt = checkpoint?.startedAt ?? createLogTimestamp();
  const flowFingerprint = createRalphFlowFingerprint(flow);
  const leaseOwnerId = options.leaseOwnerId ?? `${process.pid}:${randomUUID()}`;
  const leaseDurationMs = Math.max(
    1_000,
    options.leaseDurationMs ?? DEFAULT_RALPH_RUN_LEASE_DURATION_MS,
  );
  let runLease = createRalphRunLease(
    leaseOwnerId,
    checkpoint?.lease,
    leaseDurationMs,
  );
  const durability: RalphRunDurability = checkpoint?.durability
    ? { ...checkpoint.durability }
    : { status: "healthy", required: Boolean(logger?.paths) };
  const logRunStart = (): void => {
    logger?.simple({
      kind: "run-start",
      message: `Started Ralph flow ${flow.name}.`,
      flowId: flow.id,
      flowName: flow.name,
      provider: config.provider,
      model: config.model,
    });
    logger?.trace({
      kind: "run-start",
      message: `Started Ralph flow ${flow.name}.`,
      flowId: flow.id,
      provider: config.provider,
      model: config.model,
      details: {
        flow,
        config: {
          provider: config.provider,
          model: config.model,
          mode: config.mode,
          reasoning: config.reasoning,
          workspaceRoot: config.workspaceRoot,
        },
        variableValues: options.variableValues ?? {},
      },
    });
  };
  const variables = discoverRalphFlowVariables(flow);
  const variableNames = new Set(variables.map((variable) => variable.name));
  const suppliedVariableValues = checkpoint
    ? Object.fromEntries(
        Object.entries({
          ...(options.variableValues ?? {}),
          ...checkpoint.variables,
        }).filter(([name]) => variableNames.has(name)),
      )
    : options.variableValues;
  const resolvedVariables = resolveVariableValues(
    variables,
    suppliedVariableValues,
  );
  const validation = validateRalphFlow(flow, {
    config,
    variableValues: resolvedVariables.values,
  });
  let instructionBoundaryError: unknown;
  try {
    options.instructionBoundaries = await preflightRalphInstructionBoundaries(
      flow,
      config,
      options,
    );
  } catch (error) {
    instructionBoundaryError = error;
  }
  const instructionBoundaries = Object.entries(
    options.instructionBoundaries ?? {},
  );
  const activeInstructionCanonicalDigest =
    instructionBoundaries[0]?.[1].resolution.canonicalDigest;
  const activeInstructionEnvironmentDigests = Object.fromEntries(
    instructionBoundaries.map(([key, boundary]) => [
      key,
      canonicalDigest({
        environmentDigest: boundary.resolution.environmentDigest,
        deliveryPlanId: boundary.plan.planId,
      }),
    ]),
  );
  const instructionCanonicalChanged =
    checkpoint !== undefined &&
    checkpoint.instructionCanonicalDigest !== activeInstructionCanonicalDigest;
  const instructionEnvironmentChanged =
    checkpoint !== undefined &&
    JSON.stringify(
      canonicalizeRalphValue(checkpoint.instructionEnvironmentDigests ?? {}),
    ) !==
      JSON.stringify(
        canonicalizeRalphValue(activeInstructionEnvironmentDigests),
      );
  const instructionBoundaryChanged =
    instructionCanonicalChanged || instructionEnvironmentChanged;
  const autonomyPolicy = resolveRalphAutonomyPolicy(
    flow.settings?.autonomy,
    options.autonomy,
  );
  const autonomyMetadata = createRalphRunAutonomyMetadata(
    autonomyPolicy,
    checkpoint?.autonomy,
  );
  const requiresRepositoryEvidence = flow.blocks.some(
    (block) =>
      (block.type === "UTILITY" &&
        block.utility.type === "RUN_CHECK" &&
        block.utility.verificationRole === "candidate") ||
      (block.type === "END" && block.outcome !== undefined),
  );
  const runtimeState: {
    resultContext?: RalphResultContext;
    latestCheckpoint?: RalphRunCheckpoint;
    latestNonTerminalCheckpoint?: RalphRunCheckpoint;
  } = {};
  const markDurabilityDegraded = (error: unknown): void => {
    durability.status = "degraded";
    durability.error = error instanceof Error ? error.message : String(error);
  };
  if (runStoreInitializationError) {
    markDurabilityDegraded(runStoreInitializationError);
  }
  let ownedLeaseGeneration: number | undefined;
  let storedLeaseGeneration: number | undefined;
  let ownershipLost: RalphRunOwnershipLostError | undefined;
  let workspaceWriterLease: RalphFileMutationLock | undefined;
  const markOwnershipLost = (error: unknown): RalphRunOwnershipLostError => {
    const message = error instanceof Error ? error.message : String(error);
    const ownershipError =
      error instanceof RalphRunOwnershipLostError
        ? error
        : new RalphRunOwnershipLostError(
            `Ralph durable run ownership lost: ${message}`,
            error instanceof Error ? { cause: error } : undefined,
          );
    ownershipLost ??= ownershipError;
    durability.status = "degraded";
    durability.error = ownershipError.message;
    return ownershipError;
  };
  const assertWorkspaceWriterOwnership = async (): Promise<void> => {
    if (!workspaceWriterLease) {
      return;
    }

    try {
      await workspaceWriterLease.assertOwnership();
    } catch (error) {
      throw markOwnershipLost(
        new RalphRunOwnershipLostError(
          `Ralph durable run ownership lost: workspace writer lease was lost for ${config.workspaceRoot}.`,
          error instanceof Error ? { cause: error } : undefined,
        ),
      );
    }
  };
  const releaseWorkspaceWriterLease = async (
    assertOwnership = true,
  ): Promise<void> => {
    const lease = workspaceWriterLease;
    if (!lease) {
      return;
    }

    try {
      if (assertOwnership) {
        await lease.assertOwnership();
      }
    } finally {
      await lease.release();
      if (workspaceWriterLease === lease) {
        workspaceWriterLease = undefined;
      }
    }
  };
  const getOwnershipLostMessage = (): string =>
    ownershipLost?.message ??
    "Ralph durable run ownership was lost; the stale owner stopped without finalizing artifacts.";
  const readCurrentDurableRunRecord = async (): Promise<
    RalphRunRecord | undefined
  > => {
    const recordPath = logger?.paths?.recordPath;
    if (!recordPath) {
      return undefined;
    }

    let raw: string;
    try {
      raw = await readFile(recordPath, "utf8");
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return undefined;
      }
      throw new RalphRunOwnershipLostError(
        `Could not read the durable Ralph run record at ${recordPath}.`,
        { cause: error },
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new RalphRunOwnershipLostError(
        `The durable Ralph run record at ${recordPath} is unreadable.`,
        { cause: error },
      );
    }
    if (!isRalphRunRecord(value, RALPH_FLOW_SCHEMA_VERSION)) {
      throw new RalphRunOwnershipLostError(
        `The durable Ralph run record at ${recordPath} is invalid.`,
      );
    }

    return value;
  };
  const assertOrAcquireDurableRunOwnership = (
    current: RalphRunRecord | undefined,
    independentLease: RalphRunStoreLeaseState | undefined,
  ): void => {
    if (current && (current.id !== runId || current.flowId !== flow.id)) {
      throw new RalphRunOwnershipLostError(
        `Ralph durable run identity changed from ${runId}/${flow.id} to ${current.id}/${current.flowId}.`,
      );
    }
    if (
      current?.checkpoint?.flowFingerprint &&
      current.checkpoint.flowFingerprint !== flowFingerprint
    ) {
      throw new RalphRunOwnershipLostError(
        "Ralph durable run flow revision changed while acquiring ownership.",
      );
    }

    const checkpointLease = current?.checkpoint?.lease;
    const storedLease = independentLease?.lease;
    if (
      storedLease &&
      (storedLease.runId !== runId || storedLease.flowId !== flow.id)
    ) {
      throw new RalphRunOwnershipLostError(
        `Ralph independent lease identity changed from ${runId}/${flow.id} to ${storedLease.runId}/${storedLease.flowId}.`,
      );
    }
    if (
      checkpointLease &&
      storedLease &&
      checkpointLease.generation === storedLease.generation &&
      checkpointLease.ownerId !== storedLease.ownerId
    ) {
      throw new RalphRunOwnershipLostError(
        `Ralph checkpoint and independent leases disagree on generation ${storedLease.generation} ownership.`,
      );
    }
    const independentCheckpointLease: RalphRunLease | undefined =
      independentLease
        ? {
            ownerId: independentLease.lease.ownerId,
            generation: independentLease.lease.generation,
            acquiredAt: independentLease.lease.acquiredAt,
            heartbeatAt: independentLease.heartbeatAt,
            expiresAt: new Date(
              Date.parse(independentLease.heartbeatAt) +
                independentLease.lease.durationMs,
            ).toISOString(),
            ...(independentLease.lease.releasedAt
              ? { releasedAt: independentLease.lease.releasedAt }
              : {}),
          }
        : undefined;
    const currentLease =
      independentCheckpointLease &&
      (!checkpointLease ||
        independentCheckpointLease.generation >= checkpointLease.generation)
        ? independentCheckpointLease
        : checkpointLease;
    if (ownedLeaseGeneration !== undefined) {
      if (
        !currentLease ||
        currentLease.ownerId !== leaseOwnerId ||
        currentLease.generation !== ownedLeaseGeneration ||
        currentLease.releasedAt
      ) {
        throw new RalphRunOwnershipLostError(
          `Ralph durable run ownership was lost; expected ${leaseOwnerId} generation ${ownedLeaseGeneration}, found ${currentLease ? `${currentLease.ownerId} generation ${currentLease.generation}${currentLease.releasedAt ? " (released)" : ""}` : "no active lease"}.`,
        );
      }
      return;
    }

    if (current) {
      if (!checkpoint) {
        throw new RalphRunOwnershipLostError(
          `Ralph durable run ${runId} already exists; refusing an unversioned overwrite.`,
        );
      }
      if (
        createRalphCheckpointFence(current.checkpoint) !==
          createRalphCheckpointFence(checkpoint) &&
        !checkpointRestoredFromRunStore
      ) {
        throw new RalphRunOwnershipLostError(
          `Ralph durable run ${runId} advanced after its resume checkpoint was read.`,
        );
      }
      if (
        !options.forceLeaseTakeover &&
        isLiveForeignRalphRunLease(currentLease, leaseOwnerId)
      ) {
        throw new RalphRunOwnershipLostError(
          `Ralph run is leased by ${currentLease!.ownerId} until ${currentLease!.expiresAt}.`,
        );
      }
    } else if (checkpoint) {
      throw new RalphRunOwnershipLostError(
        `Ralph durable run ${runId} disappeared after its resume checkpoint was read.`,
      );
    }

    runLease = acquireRalphRunLeaseGeneration(
      leaseOwnerId,
      currentLease,
      leaseDurationMs,
    );
    ownedLeaseGeneration = runLease.generation;
  };
  const withDurableRunOwnership = async <T>(
    operation: (
      current: RalphRunRecord | undefined,
      assertLockOwnership: () => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> => {
    const recordPath = logger?.paths?.recordPath;
    if (!recordPath) {
      return operation(undefined, async () => undefined);
    }

    let mutationLock: RalphFileMutationLock;
    try {
      mutationLock = await acquireRalphFileMutationLock(
        recordPath,
        `ralph-run:${leaseOwnerId}`,
        Math.max(30_000, leaseDurationMs),
        { reapLiveOwner: false, ownerGroupId: leaseOwnerId },
      );
    } catch (error) {
      throw markOwnershipLost(error);
    }

    try {
      const current = await readCurrentDurableRunRecord();
      let independentLease:
        | Awaited<ReturnType<RalphRunStore["readLease"]>>
        | undefined;
      try {
        independentLease = await runStore?.readLease();
      } catch (error) {
        if (!options.forceLeaseTakeover) {
          throw error;
        }
        logger?.trace({
          kind: "trace",
          message:
            "Forced Ralph takeover is replacing an unreadable independent lease.",
          flowId: flow.id,
          details: error instanceof Error ? error.message : String(error),
        });
      }
      if (
        independentLease?.active &&
        independentLease.lease.ownerId !== leaseOwnerId &&
        !options.forceLeaseTakeover
      ) {
        throw new RalphRunOwnershipLostError(
          `Ralph run is actively leased by ${independentLease.lease.ownerId}; the independent heartbeat was renewed at ${independentLease.heartbeatAt}.`,
        );
      }
      assertOrAcquireDurableRunOwnership(current, independentLease);
      if (runStore && storedLeaseGeneration !== runLease.generation) {
        await runStore.acquireLease(
          {
            runId,
            flowId: flow.id,
            ownerId: leaseOwnerId,
            generation: runLease.generation,
            acquiredAt: runLease.acquiredAt,
          },
          leaseDurationMs,
        );
        storedLeaseGeneration = runLease.generation;
      }
      logger.activate?.();
      await mutationLock.assertOwnership();
      const result = await operation(current, mutationLock.assertOwnership);
      await mutationLock.assertOwnership();
      return result;
    } catch (error) {
      if (error instanceof RalphRunOwnershipLostError) {
        throw markOwnershipLost(error);
      }
      throw error;
    } finally {
      await mutationLock.release().catch((error: unknown) => {
        markOwnershipLost(error);
      });
    }
  };
  const releaseOwnedCheckpoint = (
    value: RalphRunCheckpoint | undefined,
  ): RalphRunCheckpoint | undefined =>
    value?.lease?.ownerId === leaseOwnerId
      ? {
          ...value,
          lease: {
            ...value.lease,
            releasedAt: value.lease.releasedAt ?? createLogTimestamp(),
          },
        }
      : value;
  const finishRunWithWorkspaceWriterLease = async (
    result: RalphRunResult,
  ): Promise<RalphRunResult> => {
    const createOwnershipLostResult = (): RalphRunResult => {
      const unfencedResult = { ...result };
      delete unfencedResult.checkpoint;

      return {
        ...unfencedResult,
        runId,
        startedAt,
        finishedAt: createLogTimestamp(),
        status: "crashed",
        summary: getOwnershipLostMessage(),
        durability: { ...durability },
      };
    };
    if (ownershipLost) {
      return createOwnershipLostResult();
    }
    try {
      await assertWorkspaceWriterOwnership();
    } catch {
      return createOwnershipLostResult();
    }

    const terminalBlockIds = new Set(
      flow.blocks.flatMap((block) => (block.type === "END" ? [block.id] : [])),
    );
    const terminalEvent = [...result.events]
      .reverse()
      .find(
        (event): event is Extract<RalphRunEvent, { type: "end" }> =>
          event.type === "end" && terminalBlockIds.has(event.blockId),
      );
    const terminalBlockId = terminalEvent?.blockId;
    let repositoryEvidence: RalphRepositoryOutcomeEvidence | undefined;
    const repositoryBaseline = runtimeState.resultContext?.repositoryBaseline;
    if (repositoryBaseline) {
      const baselineFingerprint =
        createRalphRepositorySnapshotFingerprint(repositoryBaseline);
      try {
        const reusableSnapshot = findReusableFinalRepositorySnapshot(
          flow,
          result.blockResults,
          repositoryBaseline.root,
          config.workspaceRoot,
        );
        const finalSnapshot =
          reusableSnapshot?.snapshot ??
          (await collectRalphGitChangeSnapshot({
            cwd: repositoryBaseline.root,
            workspaceRoot: config.workspaceRoot,
            timeoutMs: DEFAULT_RALPH_UTILITY_COMMAND_TIMEOUT_MS,
            maxOutputBytes: DEFAULT_RALPH_UTILITY_RESPONSE_LIMIT_BYTES,
            includeDiffs: false,
          }));
        repositoryEvidence = {
          ...compareRalphRepositorySnapshots(repositoryBaseline, finalSnapshot),
          finalCapturedAt: finalSnapshot.capturedAt,
          ...(reusableSnapshot
            ? { finalSnapshotBlockId: reusableSnapshot.blockId }
            : {}),
        };
      } catch (error) {
        repositoryEvidence = {
          known: false,
          root: repositoryBaseline.root,
          changedFiles: [],
          headChanged: false,
          baselineFingerprint,
          reason: `Final repository evidence could not be captured: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    const deriveOutcome = (
      lifecycleStatus: RalphRunStatus,
      blockResults: readonly RalphBlockExecutionResult[],
    ): RalphRunOutcome =>
      deriveRalphRunOutcome({
        flow,
        lifecycleStatus,
        ...(terminalBlockId ? { terminalBlockId } : {}),
        blockResults,
        ...(autonomyMetadata
          ? { autonomy: cloneRalphRunAutonomyMetadata(autonomyMetadata) }
          : {}),
        ...(runtimeState.resultContext?.progress
          ? { progress: runtimeState.resultContext.progress }
          : {}),
        ...(repositoryEvidence ? { repositoryEvidence } : {}),
      });
    let outcome =
      result.outcome ?? deriveOutcome(result.status, result.blockResults);
    const lifecycleStatus =
      result.status === "completed" &&
      outcome.status !== "succeeded" &&
      outcome.status !== "no-op"
        ? "blocked"
        : result.status;
    const finishedAt =
      lifecycleStatus === "waiting-for-input"
        ? undefined
        : createLogTimestamp();
    let runResult: RalphRunResult = {
      ...result,
      status: lifecycleStatus,
      runId,
      startedAt,
      ...(finishedAt ? { finishedAt } : {}),
      ...(autonomyMetadata
        ? { autonomy: cloneRalphRunAutonomyMetadata(autonomyMetadata) }
        : {}),
      outcome,
      ...(runtimeState.resultContext?.progress
        ? {
            progress: createRalphProgressState(
              runtimeState.resultContext.progress,
            ),
          }
        : {}),
      durability: { ...durability },
    };
    delete runResult.checkpoint;

    try {
      const persistedHistory = await readRalphExecutionHistoryResults(
        logger?.paths,
      );
      if (persistedHistory.length > runResult.blockResults.length) {
        runResult.blockResults = persistedHistory;
        outcome = deriveOutcome(runResult.status, persistedHistory);
        runResult.outcome = outcome;
        if (
          runResult.status === "completed" &&
          outcome.status !== "succeeded" &&
          outcome.status !== "no-op"
        ) {
          runResult.status = "blocked";
        }
      }
    } catch (error) {
      markDurabilityDegraded(error);
    }

    const shouldRetainCheckpoint =
      result.status !== "completed" || runResult.outcome?.retryable === true;
    const checkpointCandidates = [
      result.checkpoint,
      runtimeState.latestNonTerminalCheckpoint,
      runtimeState.latestCheckpoint,
      checkpoint,
    ].filter(
      (candidate): candidate is RalphRunCheckpoint => candidate !== undefined,
    );
    const retainedCheckpoint = shouldRetainCheckpoint
      ? checkpointCandidates.find(
          (candidate) => !terminalBlockIds.has(candidate.currentBlockId),
        )
      : undefined;
    const releasedCheckpoint = releaseOwnedCheckpoint(retainedCheckpoint);
    if (releasedCheckpoint) {
      runResult.checkpoint = releasedCheckpoint;
    }

    const synchronizeTerminalReporting = (detail?: string): void => {
      if (!terminalBlockId || !runResult.outcome) {
        return;
      }
      runResult.summary = `Ralph flow \`${flow.name}\` finished with outcome \`${runResult.outcome.status}\`: ${runResult.outcome.reason}${detail ? ` ${detail}` : ""}`;
      for (let index = runResult.events.length - 1; index >= 0; index -= 1) {
        const event = runResult.events[index];
        if (event?.type === "end" && event.blockId === terminalBlockId) {
          runResult.events[index] = {
            ...event,
            status: runResult.status,
            summary: runResult.summary,
          };
          break;
        }
      }
    };
    const crashCompletedRunForDurability = (detail: string): void => {
      if (runResult.status !== "completed") {
        return;
      }
      runResult.status = "crashed";
      runResult.outcome = deriveOutcome("crashed", runResult.blockResults);
      synchronizeTerminalReporting(detail);
      const recoveryCheckpoint = [
        runtimeState.latestNonTerminalCheckpoint,
        ...checkpointCandidates,
      ].find(
        (candidate) =>
          candidate !== undefined &&
          !terminalBlockIds.has(candidate.currentBlockId),
      );
      if (recoveryCheckpoint) {
        runResult.checkpoint = recoveryCheckpoint;
      } else {
        delete runResult.checkpoint;
      }
    };
    synchronizeTerminalReporting();

    const finalizeOwnedRun = async (
      assertLockOwnership: () => Promise<void> = async () => undefined,
    ): Promise<void> => {
      await assertLockOwnership();
      try {
        await logger?.flush();
      } catch (error) {
        markDurabilityDegraded(error);
      }
      await assertLockOwnership();

      if (durability.status === "degraded") {
        crashCompletedRunForDurability(
          `Durability failed: ${durability.error ?? "unknown persistence error"}`,
        );
      }
      runResult.durability = { ...durability };

      if (runtimeState.resultContext) {
        try {
          await assertLockOwnership();
          await ensureRalphFinalReportArtifacts(
            flow,
            config,
            runtimeState.resultContext,
          );
          await finalizeRalphFinalReportArtifacts(
            runtimeState.resultContext,
            runResult,
          );
          await writeRalphFallbackFinalReportArtifact(
            flow,
            runtimeState.resultContext,
            runResult,
          );
          await assertLockOwnership();
        } catch (error) {
          markDurabilityDegraded(error);
          runResult.durability = { ...durability };
          crashCompletedRunForDurability(
            `Final-report persistence failed: ${durability.error}.`,
          );
        }
      }
      logger?.simple({
        kind: "run-end",
        message: runResult.summary,
        flowId: flow.id,
        flowName: flow.name,
        provider: config.provider,
        model: config.model,
        status: runResult.status,
      });
      logger?.trace({
        kind: "run-end",
        message: runResult.summary,
        flowId: flow.id,
        provider: config.provider,
        model: config.model,
        details: runResult,
      });
      try {
        await logger?.flush();
      } catch (error) {
        markDurabilityDegraded(error);
        runResult.durability = { ...durability };
        crashCompletedRunForDurability(
          `Run-log persistence failed: ${durability.error}.`,
        );
      }
      await assertLockOwnership();
      await assertWorkspaceWriterOwnership();
      await releaseWorkspaceWriterLease(false);
      if (runResult.checkpoint && ownedLeaseGeneration !== undefined) {
        runResult.checkpoint = {
          ...runResult.checkpoint,
          lease: runLease,
        };
      }
      if (runResult.checkpoint) {
        const releasedCheckpoint = releaseOwnedCheckpoint(runResult.checkpoint);
        if (releasedCheckpoint) {
          runResult.checkpoint = releasedCheckpoint;
        }
      }
      if (logger?.paths) {
        await assertLockOwnership();
        if (runStore && runResult.checkpoint) {
          await runStore.persistCheckpoint(
            runResult.checkpoint,
            `Final ${runResult.status} checkpoint: ${runResult.summary}`,
          );
          await assertLockOwnership();
        }
        await runStore?.appendJournal({
          kind: "outcome",
          summary: `${runResult.outcome?.status ?? runResult.status}: ${runResult.summary}`,
          ...(terminalBlockId ? { blockId: terminalBlockId } : {}),
        });
        await assertLockOwnership();
        await writeJsonAtomically(
          join(dirname(logger.paths.recordPath), "autonomy-evidence.json"),
          {
            schemaVersion: 1,
            runId,
            flowId: flow.id,
            recordedAt: createLogTimestamp(),
            outcome: runResult.outcome,
            ...(runResult.progress ? { progress: runResult.progress } : {}),
            ...(runtimeState.resultContext?.repositoryContext
              ? {
                  repositoryContext:
                    runtimeState.resultContext.repositoryContext,
                }
              : {}),
            ...(repositoryEvidence ? { repositoryEvidence } : {}),
          },
          { beforeCommit: assertLockOwnership },
        );
        await assertLockOwnership();
        if (runStore && ownedLeaseGeneration !== undefined) {
          await runStore.releaseLease({
            runId,
            flowId: flow.id,
            ownerId: leaseOwnerId,
            generation: ownedLeaseGeneration,
          });
        }
        await assertLockOwnership();
        durability.lastPersistedAt = createLogTimestamp();
        runResult.durability = { ...durability };
        const record = createRalphRunRecord(
          RALPH_FLOW_SCHEMA_VERSION,
          logger.runId,
          startedAt,
          flow,
          runResult,
          runtimeState.resultContext?.variables ?? resolvedVariables.values,
          logger.paths,
        );
        await writeJsonAtomically(logger.paths.recordPath, record, {
          beforeCommit: assertLockOwnership,
        });
        await assertLockOwnership();
      }
    };

    try {
      if (logger?.paths) {
        await withDurableRunOwnership(async (_current, assertLockOwnership) =>
          finalizeOwnedRun(assertLockOwnership),
        );
      } else {
        await finalizeOwnedRun();
      }
    } catch (error) {
      if (error instanceof RalphRunOwnershipLostError || ownershipLost) {
        markOwnershipLost(error);
        return createOwnershipLostResult();
      }

      markDurabilityDegraded(error);
      runResult.durability = { ...durability };
      crashCompletedRunForDurability(
        `Final run-record persistence failed: ${durability.error}.`,
      );
      const recoveryCheckpoint = [
        runtimeState.latestNonTerminalCheckpoint,
        ...checkpointCandidates,
      ].find(
        (candidate) =>
          candidate !== undefined &&
          !terminalBlockIds.has(candidate.currentBlockId),
      );
      if (recoveryCheckpoint) {
        const releasedCheckpoint = releaseOwnedCheckpoint(recoveryCheckpoint);
        if (releasedCheckpoint) {
          runResult.checkpoint = releasedCheckpoint;
        }
      } else {
        delete runResult.checkpoint;
      }
    }

    if (ownershipLost) {
      return createOwnershipLostResult();
    }

    return runResult;
  };
  const finishRun = async (result: RalphRunResult): Promise<RalphRunResult> => {
    let finishedResult: RalphRunResult | undefined;
    try {
      finishedResult = await finishRunWithWorkspaceWriterLease(result);
    } finally {
      await releaseWorkspaceWriterLease(false).catch((error: unknown) => {
        markDurabilityDegraded(error);
        if (finishedResult) {
          finishedResult.durability = { ...durability };
        }
      });
    }
    return finishedResult;
  };

  if (
    !options.forceLeaseTakeover &&
    isLiveForeignRalphRunLease(checkpoint?.lease, leaseOwnerId)
  ) {
    return {
      ...createBlockedRunResult(
        flow,
        validation,
        `Ralph run is leased by ${checkpoint!.lease!.ownerId} until ${checkpoint!.lease!.expiresAt}.`,
      ),
      runId,
      startedAt,
      checkpoint: checkpoint!,
      durability: { ...durability },
    };
  }

  if (instructionBoundaryError) {
    const message =
      instructionBoundaryError instanceof Error
        ? instructionBoundaryError.message
        : String(instructionBoundaryError);
    return finishRun(
      createBlockedRunResult(
        flow,
        validation,
        `Ralph instruction preflight failed before the first block: ${message}`,
      ),
    );
  }
  if (
    instructionBoundaryChanged &&
    options.instructionBoundaryPolicy !== "new-boundary"
  ) {
    const originalUnavailable =
      options.instructionBoundaryPolicy === "original-boundary";
    return finishRun({
      ...createBlockedRunResult(
        flow,
        validation,
        originalUnavailable
          ? "The checkpoint's original instruction boundary is not retained with recoverable bodies, so original-boundary resume is unavailable. Restart the flow or explicitly choose a new boundary."
          : "Ralph instruction boundary changed since the checkpoint. Resume is paused: restart the flow, supply the original retained boundary when available, or explicitly choose a new boundary.",
      ),
      checkpoint: checkpoint!,
    });
  }

  logRunStart();

  if (checkpoint?.runId && checkpoint.runId !== runId) {
    return finishRun({
      ...createBlockedRunResult(
        flow,
        validation,
        `Ralph checkpoint run mismatch: expected ${checkpoint.runId}, received ${runId}.`,
      ),
      checkpoint,
    });
  }
  if (checkpoint?.flowId && checkpoint.flowId !== flow.id) {
    return finishRun({
      ...createBlockedRunResult(
        flow,
        validation,
        `Ralph checkpoint flow mismatch: expected ${checkpoint.flowId}, received ${flow.id}.`,
      ),
      checkpoint,
    });
  }
  if (
    checkpoint?.flowFingerprint &&
    checkpoint.flowFingerprint !== flowFingerprint
  ) {
    return finishRun({
      ...createBlockedRunResult(
        flow,
        validation,
        "Ralph checkpoint flow revision mismatch; resume requires the exact pinned graph revision.",
      ),
      checkpoint,
    });
  }
  if (resolvedVariables.unknown.length > 0) {
    return finishRun(
      createBlockedRunResult(
        flow,
        validation,
        `Unknown Ralph variable(s): ${resolvedVariables.unknown.join(", ")}.`,
        [],
        resolvedVariables.unknown,
      ),
    );
  }

  if (resolvedVariables.missing.length > 0) {
    return finishRun(
      createBlockedRunResult(
        flow,
        validation,
        `Missing Ralph variable(s): ${resolvedVariables.missing.join(", ")}.`,
        resolvedVariables.missing,
      ),
    );
  }

  if (!validation.valid) {
    return finishRun(
      createBlockedRunResult(
        flow,
        validation,
        `Ralph flow is invalid: ${validation.errors.join(" ")}`,
      ),
    );
  }

  const blockMap = getRalphBlockById(flow);
  const start = flow.blocks.find(
    (block): block is RalphStartBlock => block.type === "START",
  );
  if (!start) {
    return finishRun(
      createBlockedRunResult(
        flow,
        validation,
        "Ralph flow has no START block.",
      ),
    );
  }

  const events: RalphRunEvent[] = checkpoint ? [...checkpoint.events] : [];
  let persistedExecutionHistory: RalphBlockExecutionResult[];
  try {
    persistedExecutionHistory = await readRalphExecutionHistoryResults(
      logger?.paths,
    );
  } catch (error) {
    markDurabilityDegraded(error);
    return finishRun({
      flow: flow.id,
      status: "crashed",
      summary: `Ralph refused to resume from unreadable execution history: ${durability.error}.`,
      events,
      blockResults: checkpoint ? [...checkpoint.blockResults] : [],
      missingVariables: [],
      unknownVariables: [],
      validation,
      ...(checkpoint ? { checkpoint } : {}),
    });
  }
  const blockResults: RalphBlockExecutionResult[] =
    persistedExecutionHistory.length > 0
      ? persistedExecutionHistory
      : checkpoint
        ? [...checkpoint.blockResults]
        : [];
  const historyByOperationId = new Map(
    blockResults.flatMap((result) =>
      result.operationId ? [[result.operationId, result] as const] : [],
    ),
  );
  const artifactRoot = join(
    getRalphRunDirectory(config.workspaceRoot, "workspace"),
    normalizeRunId(runId),
  );
  let restoredFinalReports: RalphFinalReportArtifact[];
  try {
    restoredFinalReports = await restoreRalphFinalReportArtifacts(
      flow,
      checkpoint?.finalReports,
      config.workspaceRoot,
      artifactRoot,
    );
  } catch (error) {
    markDurabilityDegraded(error);
    return finishRun({
      flow: flow.id,
      status: "crashed",
      summary: `Ralph refused to resume from unsafe final-report metadata: ${durability.error}.`,
      events,
      blockResults,
      missingVariables: [],
      unknownVariables: [],
      validation,
      ...(checkpoint ? { checkpoint } : {}),
    });
  }
  const resultContext: RalphResultContext = {
    runId,
    artifactRoot,
    runWorkspaceRoot: config.workspaceRoot,
    resultsByBlock: restoreRalphResultMap(checkpoint),
    runLog: checkpoint ? [...checkpoint.runLog] : [],
    variables: {
      ...resolvedVariables.values,
      ...(checkpoint?.variables ?? {}),
    },
    interviewStates: new Map(Object.entries(checkpoint?.interviewStates ?? {})),
    executionHistory: blockResults,
    events,
    ...(autonomyMetadata ? { autonomy: autonomyMetadata } : {}),
    ...(autonomyMetadata
      ? { progress: createRalphProgressState(checkpoint?.progress) }
      : {}),
    ...(checkpoint?.repositoryContext
      ? { repositoryContext: { ...checkpoint.repositoryContext } }
      : {}),
    ...(checkpoint?.repositoryBaseline
      ? { repositoryBaseline: { ...checkpoint.repositoryBaseline } }
      : {}),
    finalReports: restoredFinalReports,
    operationLedger: new Map(Object.entries(checkpoint?.operationLedger ?? {})),
    mediaRuns: new Map(Object.entries(checkpoint?.mediaRuns ?? {})),
  };
  if (
    resultContext.progress &&
    resultContext.repositoryBaseline &&
    !resultContext.progress.channelFingerprints.repository
  ) {
    resultContext.progress.channelFingerprints.repository =
      createRalphRepositoryProgressFingerprint(
        resultContext.repositoryBaseline,
      );
  }
  if (autonomyMetadata) {
    try {
      workspaceWriterLease = await acquireRalphFileMutationLock(
        join(
          getRalphRunDirectory(config.workspaceRoot, "workspace"),
          RALPH_WORKSPACE_WRITER_LEASE_NAME,
        ),
        `${runId}:${leaseOwnerId}`,
        leaseDurationMs,
        { reapLiveOwner: false, ownerGroupId: leaseOwnerId },
      );
      logger?.trace({
        kind: "trace",
        message: "Acquired the Ralph workspace writer lease.",
        flowId: flow.id,
        provider: config.provider,
        model: config.model,
        details: { path: workspaceWriterLease.path },
      });
    } catch (error) {
      return finishRun(
        createBlockedRunResult(
          flow,
          validation,
          `RALPH could not acquire the workspace writer lease. Another autonomous run may be changing this workspace: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
  runtimeState.resultContext = resultContext;
  if (
    !checkpoint &&
    autonomyMetadata &&
    requiresRepositoryEvidence &&
    !resultContext.repositoryBaseline &&
    hasRalphGitMetadata(
      resultContext.repositoryContext?.worktreeRoot ?? config.workspaceRoot,
      config.workspaceRoot,
    )
  ) {
    try {
      resultContext.repositoryBaseline = await collectRalphGitChangeSnapshot({
        cwd:
          resultContext.repositoryContext?.worktreeRoot ?? config.workspaceRoot,
        workspaceRoot: config.workspaceRoot,
        timeoutMs: DEFAULT_RALPH_UTILITY_COMMAND_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_RALPH_UTILITY_RESPONSE_LIMIT_BYTES,
        includeDiffs: false,
      });
      if (resultContext.progress) {
        resultContext.progress.channelFingerprints.repository =
          createRalphRepositoryProgressFingerprint(
            resultContext.repositoryBaseline,
          );
      }
    } catch {
      // Non-repository autonomy flows can still provide explicit graph evidence.
    }
  }
  if (checkpoint?.repositoryContext) {
    try {
      const currentRepositoryContext = await resolveRalphRepositoryContext({
        workspaceRoot: config.workspaceRoot,
        projectPath: checkpoint.repositoryContext.projectRoot,
        timeoutMs: DEFAULT_RALPH_UTILITY_COMMAND_TIMEOUT_MS,
      });
      assertRalphRepositoryContextUnchanged(
        checkpoint.repositoryContext,
        currentRepositoryContext,
      );
      resultContext.repositoryContext = currentRepositoryContext;
    } catch (error) {
      return finishRun({
        flow: flow.id,
        status: "blocked",
        summary: `RALPH refused to resume in a different repository context: ${error instanceof Error ? error.message : String(error)}`,
        events,
        blockResults,
        missingVariables: [],
        unknownVariables: [],
        validation,
        checkpoint,
      });
    }
  }
  const errorCounts = restoreRalphNumberMap(checkpoint?.errorCounts);
  const attemptCounts = restoreRalphNumberMap(checkpoint?.attemptCounts);
  const repeatedFailures = restoreRalphRepeatedFailureMap(
    checkpoint?.repeatedFailures,
  );
  const recoveryCounts = restoreRalphNumberMap(checkpoint?.recoveryCounts);
  let currentBlockId: string | undefined =
    checkpoint?.currentBlockId ?? start.id;
  let transitions = checkpoint?.transitions ?? 0;
  const transitionBase =
    checkpoint?.transitionBase ?? checkpoint?.totalTransitions ?? 0;
  const segment =
    (checkpoint?.segment ?? 1) +
    (instructionBoundaryChanged &&
    options.instructionBoundaryPolicy === "new-boundary"
      ? 1
      : 0);
  const syncTotalTransitions = (): number => {
    const totalTransitions = transitionBase + transitions;

    if (autonomyMetadata) {
      autonomyMetadata.totalTransitions = totalTransitions;
    }

    return totalTransitions;
  };
  const maxTransitions =
    options.maxTransitions === null
      ? null
      : (options.maxTransitions ?? flow.settings?.maxTransitions);
  const maxTotalTransitions = options.maxTotalTransitions ?? null;
  const repeatedFailureLimit =
    options.repeatedFailureLimit === null
      ? null
      : (options.repeatedFailureLimit ?? DEFAULT_RALPH_REPEATED_FAILURE_LIMIT);
  let lastRecoverableCheckpoint: RalphRunCheckpoint | undefined;
  let nextRetryAt = checkpoint?.nextRetryAt;
  const createCheckpoint = (
    blockId: string,
    pendingInput?: RalphInputRequest,
    checkpointTransitions = transitions,
    checkpointTransitionBase = transitionBase,
  ): RalphRunCheckpoint => {
    const checkpoint = createRunCheckpoint(
      blockId,
      checkpointTransitions,
      resultContext,
      blockResults,
      events,
      errorCounts,
      repeatedFailures,
      pendingInput,
    );

    return {
      ...checkpoint,
      runLog: checkpoint.runLog.slice(-MAX_RALPH_CHECKPOINT_LOG_ENTRIES),
      blockResults: checkpoint.blockResults.slice(
        -MAX_RALPH_CHECKPOINT_BLOCK_RESULTS,
      ),
      events: checkpoint.events.slice(-MAX_RALPH_CHECKPOINT_EVENTS),
      recoveryCounts: Object.fromEntries(recoveryCounts.entries()),
      attemptCounts: Object.fromEntries(attemptCounts.entries()),
      totalTransitions: checkpointTransitionBase + checkpointTransitions,
      transitionBase: checkpointTransitionBase,
      runId,
      startedAt,
      flowId: flow.id,
      flowFingerprint,
      ...(activeInstructionCanonicalDigest === undefined
        ? {}
        : {
            instructionCanonicalDigest: activeInstructionCanonicalDigest,
          }),
      ...(Object.keys(activeInstructionEnvironmentDigests).length === 0
        ? {}
        : {
            instructionEnvironmentDigests: activeInstructionEnvironmentDigests,
          }),
      lease: runLease,
      segment,
      ...(nextRetryAt ? { nextRetryAt } : {}),
      operationLedger: Object.fromEntries(
        [...(resultContext.operationLedger ?? [])].slice(
          -MAX_RALPH_OPERATION_LEDGER_ENTRIES,
        ),
      ),
      mediaRuns: Object.fromEntries(resultContext.mediaRuns ?? []),
      finalReports: (resultContext.finalReports ?? []).map((artifact) => ({
        blockId: artifact.block.id,
        ...(artifact.jsonPath ? { jsonPath: artifact.jsonPath } : {}),
        ...(artifact.markdownPath
          ? { markdownPath: artifact.markdownPath }
          : {}),
      })),
      history: {
        ...(logger?.paths?.simpleJsonlPath
          ? { simpleJsonlPath: logger.paths.simpleJsonlPath }
          : {}),
        ...(logger?.paths?.traceJsonlPath
          ? { traceJsonlPath: logger.paths.traceJsonlPath }
          : {}),
        blockResultCount: blockResults.length,
        eventCount: events.length,
      },
      durability: { ...durability },
      ...(autonomyMetadata
        ? { autonomy: cloneRalphRunAutonomyMetadata(autonomyMetadata) }
        : {}),
      ...(resultContext.progress
        ? { progress: createRalphProgressState(resultContext.progress) }
        : {}),
      ...(resultContext.repositoryContext
        ? { repositoryContext: { ...resultContext.repositoryContext } }
        : {}),
      ...(resultContext.repositoryBaseline
        ? { repositoryBaseline: { ...resultContext.repositoryBaseline } }
        : {}),
    };
  };

  let lastRunProjectionAt = 0;
  const persistRunBoundary = async (
    blockId: string,
    summary: string,
    beforeCheckpoint?: () => Promise<void>,
    forceProjection = false,
  ): Promise<void> => {
    const refreshTaskLeases = async (): Promise<void> => {
      try {
        await refreshRalphJsonTaskLeases(
          flow,
          resultContext,
          config.workspaceRoot,
        );
      } catch (error) {
        markDurabilityDegraded(error);
        logger?.trace({
          kind: "trace",
          message: "Failed to refresh Ralph JSON task leases.",
          flowId: flow.id,
          blockId,
          details: durability.error,
        });
      }
    };
    if (!logger?.paths) {
      await refreshTaskLeases();
      await beforeCheckpoint?.();
      runLease = createRalphRunLease(leaseOwnerId, runLease, leaseDurationMs);
      runtimeState.latestCheckpoint = createCheckpoint(blockId);
      if (blockMap.get(blockId)?.type !== "END") {
        runtimeState.latestNonTerminalCheckpoint =
          runtimeState.latestCheckpoint;
      }
      return;
    }

    try {
      await withDurableRunOwnership(async (current, assertLockOwnership) => {
        await refreshTaskLeases();
        await assertLockOwnership();
        await beforeCheckpoint?.();
        await assertLockOwnership();
        runLease = createRalphRunLease(leaseOwnerId, runLease, leaseDurationMs);
        const checkpoint = createCheckpoint(blockId);
        await assertLockOwnership();
        await runStore?.persistCheckpoint(checkpoint, summary);
        await assertLockOwnership();
        if (
          forceProjection ||
          !current ||
          Date.now() - lastRunProjectionAt >= RALPH_RUN_PROJECTION_INTERVAL_MS
        ) {
          const partialResult: RalphRunResult = {
            runId,
            startedAt,
            flow: flow.id,
            status: "running",
            summary,
            events: checkpoint.events,
            blockResults: checkpoint.blockResults,
            missingVariables: [],
            unknownVariables: [],
            validation,
            checkpoint,
            ...(autonomyMetadata
              ? { autonomy: cloneRalphRunAutonomyMetadata(autonomyMetadata) }
              : {}),
            durability: { ...durability },
          };
          const record = createRalphRunRecord(
            RALPH_FLOW_SCHEMA_VERSION,
            logger.runId,
            startedAt,
            flow,
            partialResult,
            resultContext.variables,
            logger.paths!,
          );
          await writeJsonAtomically(logger.paths!.recordPath, record, {
            beforeCommit: assertLockOwnership,
          });
          lastRunProjectionAt = Date.now();
          await assertLockOwnership();
        }
        runtimeState.latestCheckpoint = checkpoint;
        if (blockMap.get(blockId)?.type !== "END") {
          runtimeState.latestNonTerminalCheckpoint = checkpoint;
        }
      });
      durability.lastPersistedAt = createLogTimestamp();
    } catch (error) {
      if (error instanceof RalphRunOwnershipLostError) {
        markOwnershipLost(error);
      } else {
        markDurabilityDegraded(error);
        logger.trace({
          kind: "trace",
          message: "Failed to persist Ralph block-boundary checkpoint.",
          flowId: flow.id,
          blockId,
          details: durability.error,
        });
      }
    }
  };
  const heartbeatRunOwnership = async (): Promise<void> => {
    await refreshRalphJsonTaskLeases(flow, resultContext, config.workspaceRoot);
    if (runStore && ownedLeaseGeneration !== undefined) {
      await withDurableRunOwnership(async (_current, assertLockOwnership) => {
        await assertLockOwnership();
        await runStore.heartbeat(
          {
            runId,
            flowId: flow.id,
            ownerId: leaseOwnerId,
            generation: ownedLeaseGeneration!,
          },
          Math.min(55_000, Math.max(250, Math.floor(leaseDurationMs / 2))),
        );
        await assertLockOwnership();
      });
    }
    runLease = createRalphRunLease(leaseOwnerId, runLease, leaseDurationMs);
    durability.lastPersistedAt = createLogTimestamp();
  };

  const markOperationRouted = (
    operationId: string,
    toBlockId: string,
  ): void => {
    const operation = resultContext.operationLedger?.get(operationId);
    if (!operation) {
      return;
    }
    resultContext.operationLedger?.set(operationId, {
      ...operation,
      state: "routed",
      routedAt: createLogTimestamp(),
      routedToBlockId: toBlockId,
    });
  };

  const createRetryCheckpoint = (blockId: string): RalphRunCheckpoint => {
    const retryCheckpoint = createCheckpoint(blockId);
    const entries = Object.entries(retryCheckpoint.operationLedger ?? {});
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [operationId, operation] = entries[index]!;
      if (
        operation.blockId === blockId &&
        (operation.state === "completed" || operation.state === "reconciled")
      ) {
        retryCheckpoint.operationLedger![operationId] = {
          ...operation,
          state: "routed",
          routedAt: createLogTimestamp(),
          routedToBlockId: blockId,
        };
        break;
      }
    }
    return retryCheckpoint;
  };

  if (checkpoint) {
    for (let index = blockResults.length - 1; index >= 0; index -= 1) {
      const priorResult = blockResults[index];
      const priorBlock = priorResult
        ? blockMap.get(priorResult.blockId)
        : undefined;
      if (
        priorResult &&
        priorBlock &&
        isRecoverableRalphBlockResult(priorBlock, priorResult)
      ) {
        lastRecoverableCheckpoint = createRetryCheckpoint(priorBlock.id);
        break;
      }
    }
  }

  runtimeState.latestCheckpoint = createCheckpoint(currentBlockId);
  if (blockMap.get(currentBlockId)?.type !== "END") {
    runtimeState.latestNonTerminalCheckpoint = runtimeState.latestCheckpoint;
  }

  syncTotalTransitions();

  while (currentBlockId) {
    if (durability.status === "degraded" && durability.required) {
      const summary = `Ralph durability failed; execution stopped before further side effects: ${durability.error ?? "unknown persistence error"}.`;
      return finishRun({
        flow: flow.id,
        status: "crashed",
        summary,
        events,
        blockResults,
        missingVariables: [],
        unknownVariables: [],
        validation,
        checkpoint: runtimeState.latestCheckpoint,
      });
    }

    if (options.signal?.aborted) {
      const summary = "Ralph run stopped.";
      await emitRunEvent(
        events,
        { type: "end", blockId: currentBlockId, status: "stopped", summary },
        options.onEvent,
      );
      return finishRun({
        flow: flow.id,
        status: "stopped",
        summary,
        events,
        blockResults,
        missingVariables: [],
        unknownVariables: [],
        validation,
        checkpoint: runtimeState.latestCheckpoint,
      });
    }

    if (nextRetryAt) {
      const remainingMs = Date.parse(nextRetryAt) - Date.now();
      if (remainingMs > 0) {
        await delay(remainingMs / 1_000, options.signal).catch(() => undefined);
      }
      nextRetryAt = undefined;
    }

    const totalTransitions = syncTotalTransitions();
    const totalTransitionLimitReached =
      maxTotalTransitions !== null &&
      maxTotalTransitions !== undefined &&
      totalTransitions >= maxTotalTransitions;
    const transitionLimitReached =
      maxTransitions !== null &&
      maxTransitions !== undefined &&
      transitions >= maxTransitions;

    if (totalTransitionLimitReached || transitionLimitReached) {
      const limit = totalTransitionLimitReached
        ? maxTotalTransitions
        : maxTransitions;
      const summary = totalTransitionLimitReached
        ? `Ralph flow reached maxTotalTransitions (${limit}).`
        : `Ralph flow reached maxTransitions (${limit}).`;

      if (autonomyMetadata) {
        autonomyMetadata.exhaustion = {
          kind: "max-transitions",
          blockId: currentBlockId,
          recoverable: autonomyPolicy.transitionExhaustion === "checkpoint",
          limit: limit!,
          totalTransitions,
          reason: summary,
        };
      }

      await emitRunEvent(
        events,
        {
          type: "crash",
          blockId: currentBlockId,
          output: "ERROR",
          reason: summary,
        },
        options.onEvent,
      );
      logger?.simple({
        kind: "crash",
        message: summary,
        flowId: flow.id,
        flowName: flow.name,
        blockId: currentBlockId,
        output: "ERROR",
      });
      return finishRun({
        flow: flow.id,
        status: "crashed",
        summary,
        events,
        blockResults,
        missingVariables: [],
        unknownVariables: [],
        validation,
        checkpoint: runtimeState.latestCheckpoint,
      });
    }

    if (autonomyMetadata?.exhaustion?.kind === "max-transitions") {
      delete autonomyMetadata.exhaustion;
    }

    try {
      await assertWorkspaceWriterOwnership();
    } catch {
      return finishRun({
        flow: flow.id,
        status: "crashed",
        summary: getOwnershipLostMessage(),
        events,
        blockResults,
        missingVariables: [],
        unknownVariables: [],
        validation,
        checkpoint: runtimeState.latestCheckpoint,
      });
    }

    const block = blockMap.get(currentBlockId);
    if (!block) {
      const summary = `Ralph flow routed to missing block \`${currentBlockId}\`.`;
      logger?.simple({
        kind: "crash",
        message: summary,
        flowId: flow.id,
        flowName: flow.name,
        blockId: currentBlockId,
        output: "ERROR",
      });
      return finishRun({
        flow: flow.id,
        status: "crashed",
        summary,
        events,
        blockResults,
        missingVariables: [],
        unknownVariables: [],
        validation,
      });
    }

    const pendingOperation = [
      ...(resultContext.operationLedger?.values() ?? []),
    ]
      .reverse()
      .find((entry) => entry.blockId === block.id && entry.state === "started");
    const completedUnroutedOperation = [
      ...(resultContext.operationLedger?.values() ?? []),
    ]
      .reverse()
      .find(
        (entry) =>
          entry.blockId === block.id &&
          (entry.state === "completed" || entry.state === "reconciled") &&
          historyByOperationId.has(entry.id),
      );
    const resumableOperation = pendingOperation ?? completedUnroutedOperation;
    const attempt =
      resumableOperation?.attempt ?? (attemptCounts.get(block.id) ?? 0) + 1;
    const operationId =
      resumableOperation?.id ??
      createHash("sha256")
        .update(
          `${runId}\0${block.id}\0${attempt}\0${syncTotalTransitions()}\0${segment}`,
        )
        .digest("hex");
    const operationWasPending = pendingOperation?.state === "started";
    const replaySafe = isRalphBlockReplaySafe(block);
    if (!resumableOperation) {
      attemptCounts.set(block.id, attempt);
      resultContext.operationLedger?.set(operationId, {
        id: operationId,
        blockId: block.id,
        attempt,
        state: "started",
        startedAt: createLogTimestamp(),
      });
      if (!replaySafe) {
        await persistRunBoundary(
          block.id,
          `Persisted operation intent ${operationId} for \`${block.id}\`.`,
          undefined,
          true,
        );
        if (durability.status === "degraded" && durability.required) {
          continue;
        }
      }
    }
    resultContext.currentOperationId = operationId;
    const blockStartedAt = Date.now();
    logger?.simple({
      kind: "block-start",
      message: `Running ${block.title}.`,
      ...getBlockLogFields(flow, block, config),
      attempt,
    });
    logger?.trace({
      kind: "block-start",
      message: `Running ${block.title}.`,
      ...getBlockLogFields(flow, block, config),
      attempt,
      details: {
        block,
        context: {
          variables: resultContext.variables,
          lastResult: resultContext.lastResult,
          runLog: resultContext.runLog,
        },
      },
    });
    await emitRunEvent(
      events,
      {
        type: "block-start",
        blockId: block.id,
        attempt,
      },
      options.onEvent,
    );

    const reconciledResult = historyByOperationId.get(operationId);
    const blockAbortController = new AbortController();
    const abortBlockFromOuterSignal = (): void => {
      blockAbortController.abort(options.signal?.reason);
    };
    if (options.signal?.aborted) {
      abortBlockFromOuterSignal();
    } else {
      options.signal?.addEventListener("abort", abortBlockFromOuterSignal, {
        once: true,
      });
    }
    let heartbeatPending = Promise.resolve();
    const heartbeatHandle = setInterval(
      () => {
        heartbeatPending = heartbeatPending
          .then(async () => {
            await assertWorkspaceWriterOwnership();
            await heartbeatRunOwnership();
          })
          .catch((error: unknown) => {
            if (
              error instanceof RalphRunOwnershipLostError ||
              error instanceof RalphRunStoreOwnershipError
            ) {
              markOwnershipLost(error);
            } else {
              markDurabilityDegraded(error);
            }
            if (durability.required) {
              blockAbortController.abort(error);
            }
          });
      },
      Math.max(250, Math.floor(leaseDurationMs / 3)),
    );
    let stepResult: RalphExecutionStepResult;
    try {
      stepResult =
        reconciledResult ??
        (operationWasPending && !isRalphBlockReplaySafe(block)
          ? createUtilityResult(
              {
                id: block.id,
                type: "UTILITY",
                title: block.title,
                utility: { type: "NOTIFY" },
              },
              "ERROR",
              `${block.title} has an indeterminate prior side effect for operation ${operationId}; routing through recovery instead of replaying it blindly.`,
              { operationId, reconciliation: "indeterminate" },
            )
          : await executeBlock(
              flow,
              block,
              config,
              customizations,
              resultContext,
              { ...options, signal: blockAbortController.signal },
            ).catch((error: unknown) =>
              createRalphBlockExecutionErrorResult(block, error, attempt),
            ));
    } finally {
      clearInterval(heartbeatHandle);
      await heartbeatPending;
      options.signal?.removeEventListener("abort", abortBlockFromOuterSignal);
    }

    if (durability.status === "degraded" && durability.required) {
      const summary = `Ralph aborted \`${block.id}\` after its durable lease heartbeat failed: ${durability.error ?? "unknown persistence error"}`;
      await emitRunEvent(
        events,
        { type: "crash", blockId: block.id, output: "ERROR", reason: summary },
        options.onEvent,
      );
      return finishRun({
        flow: flow.id,
        status: "crashed",
        summary,
        events,
        blockResults,
        missingVariables: [],
        unknownVariables: [],
        validation,
        checkpoint: runtimeState.latestCheckpoint,
      });
    }

    if (isRalphInputWaitStepResult(stepResult)) {
      await emitRunEvent(
        events,
        {
          type: "input-required",
          blockId: block.id,
          request: stepResult.request,
        },
        options.onEvent,
      );
      logger?.simple({
        kind: "input-required",
        message: stepResult.summary,
        ...getBlockLogFields(flow, block, config),
        attempt,
      });
      logger?.trace({
        kind: "input-required",
        message: stepResult.summary,
        ...getBlockLogFields(flow, block, config),
        attempt,
        details: stepResult.request,
      });

      const runCheckpoint = createCheckpoint(block.id, stepResult.request);

      return finishRun({
        flow: flow.id,
        status: "waiting-for-input",
        summary: stepResult.summary,
        events,
        blockResults,
        missingVariables: [],
        unknownVariables: [],
        validation,
        pendingInput: stepResult.request,
        checkpoint: runCheckpoint,
      });
    }

    const blockDurationMs = Date.now() - blockStartedAt;
    const result: RalphBlockExecutionResult = {
      ...stepResult,
      operationId,
      attempt,
      durationMs: reconciledResult?.durationMs ?? blockDurationMs,
    };
    const consumedInput = getPendingInputForBlock(block, options);

    if (
      consumedInput &&
      options.inputResponse?.requestId === consumedInput.id
    ) {
      const eventType =
        options.inputResponse.action === "cancel"
          ? "input-cancelled"
          : "input-submitted";
      await emitRunEvent(
        events,
        {
          type: eventType,
          blockId: block.id,
          requestId: consumedInput.id,
        },
        options.onEvent,
      );
      logger?.simple({
        kind: "input-submitted",
        message:
          eventType === "input-cancelled"
            ? `${block.title} input was cancelled.`
            : `${block.title} input was submitted.`,
        ...getBlockLogFields(flow, block, config),
        attempt,
      });
    }

    const appendResultToHistory = !historyByOperationId.has(operationId);
    if (appendResultToHistory) {
      blockResults.push(result);
      historyByOperationId.set(operationId, result);
    }
    resultContext.operationLedger?.set(operationId, {
      id: operationId,
      blockId: block.id,
      attempt,
      state: reconciledResult ? "reconciled" : "completed",
      startedAt: resumableOperation?.startedAt ?? createLogTimestamp(),
      completedAt: createLogTimestamp(),
      output: result.output,
      summary: result.summary,
    });
    updateResultContext(resultContext, result);
    let progressAssessment =
      autonomyMetadata && block.type !== "END" && resultContext.progress
        ? assessRalphProgress(
            resultContext.progress,
            block,
            result,
            syncTotalTransitions() + 1,
            {
              maxStagnantTransitions: autonomyPolicy.maxStagnantTransitions,
              maxRepeatedCycle: autonomyPolicy.maxRepeatedCycle,
            },
          )
        : undefined;
    if (
      progressAssessment?.stalled &&
      resultContext.progress &&
      resultContext.repositoryBaseline
    ) {
      try {
        const repositorySnapshot = await collectRalphGitChangeSnapshot({
          cwd: resultContext.repositoryBaseline.root,
          workspaceRoot: config.workspaceRoot,
          timeoutMs: DEFAULT_RALPH_UTILITY_COMMAND_TIMEOUT_MS,
          maxOutputBytes: DEFAULT_RALPH_UTILITY_RESPONSE_LIMIT_BYTES,
          includeDiffs: false,
        });
        const repositoryAssessment = assessRalphProgress(
          resultContext.progress,
          {
            id: block.id,
            type: "UTILITY",
            title: block.title,
            utility: { type: "GIT_SNAPSHOT" },
          },
          {
            ...result,
            data: {
              files: repositorySnapshot.files,
              head: repositorySnapshot.head,
            },
          },
          syncTotalTransitions() + 1,
          {
            maxStagnantTransitions: autonomyPolicy.maxStagnantTransitions,
            maxRepeatedCycle: autonomyPolicy.maxRepeatedCycle,
          },
        );
        if (repositoryAssessment.evidence.meaningful) {
          progressAssessment = repositoryAssessment;
        }
      } catch (error) {
        logger?.trace({
          kind: "trace",
          message:
            "RALPH could not inspect repository progress before declaring stagnation.",
          flowId: flow.id,
          blockId: block.id,
          details: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (progressAssessment) {
      resultContext.progress = progressAssessment.state;
      await emitRunEvent(
        events,
        {
          type: "progress",
          blockId: block.id,
          meaningful: progressAssessment.evidence.meaningful,
          channel: progressAssessment.evidence.channel,
          consecutiveNoProgress: progressAssessment.state.consecutiveNoProgress,
          summary: progressAssessment.evidence.reason,
        },
        options.onEvent,
      );
      logger?.simple({
        kind: "progress",
        message: progressAssessment.evidence.reason,
        ...getBlockLogFields(flow, block, config),
        output: progressAssessment.evidence.meaningful
          ? "PROGRESS"
          : "NO_PROGRESS",
      });
    }
    if (appendResultToHistory && logger?.paths) {
      try {
        await appendRalphExecutionHistoryResult(logger.paths, result);
      } catch (error) {
        markDurabilityDegraded(error);
      }
    }
    if (!replaySafe) {
      await persistRunBoundary(
        block.id,
        `Persisted completion of operation ${operationId} for \`${block.id}\`.`,
        undefined,
        true,
      );
    }
    if (ownershipLost) {
      return finishRun({
        flow: flow.id,
        status: "crashed",
        summary: getOwnershipLostMessage(),
        events,
        blockResults,
        missingVariables: [],
        unknownVariables: [],
        validation,
      });
    }
    logger?.simple({
      kind: "block-output",
      message: result.summary,
      ...getBlockLogFields(flow, block, config),
      attempt: result.attempt,
      output: result.output,
      status: result.status,
      durationMs: blockDurationMs,
      outputPreview: result.markdown ?? result.error ?? result.summary,
    });
    logger?.trace({
      kind: "block-output",
      message: result.summary,
      ...getBlockLogFields(flow, block, config),
      attempt: result.attempt,
      provider: config.provider,
      model: config.model,
      details: {
        durationMs: blockDurationMs,
        result,
      },
    });
    await emitRunEvent(
      events,
      {
        type: "block-output",
        blockId: block.id,
        output: result.output,
        summary: result.summary,
      },
      options.onEvent,
    );
    if (progressAssessment?.stalled) {
      const summary =
        progressAssessment.state.stalledReason ??
        "RALPH stopped after detecting stagnation.";
      autonomyMetadata!.exhaustion = {
        kind: "stagnation",
        blockId: block.id,
        recoverable: true,
        limit: autonomyPolicy.maxStagnantTransitions,
        output: result.output,
        reason: summary,
      };
      return finishRun({
        flow: flow.id,
        status: "blocked",
        summary,
        events,
        blockResults,
        missingVariables: [],
        unknownVariables: [],
        validation,
        checkpoint: createCheckpoint(block.id),
      });
    }

    const directFailedEnd =
      autonomyMetadata && autonomyPolicy.recoverFailedEnd
        ? getDirectFailedEndBlock(flow, blockMap, block, result)
        : undefined;
    let autonomyDeferToBlockId: string | undefined;
    const priorRecoveryCount = recoveryCounts.get(block.id) ?? 0;

    if (autonomyMetadata && priorRecoveryCount > 0 && !directFailedEnd) {
      const recovered: RalphAutonomyRecoveredBlock = {
        blockId: block.id,
        attempts: priorRecoveryCount,
        output: result.output,
      };
      autonomyMetadata.recovered.push(recovered);
      if (autonomyMetadata.exhaustion?.kind === "recovery") {
        delete autonomyMetadata.exhaustion;
      }
      recoveryCounts.delete(block.id);
      result.recovery = {
        disposition: "recovered",
        attempt: priorRecoveryCount,
      };
    }

    const failureSignature = createRalphFailureSignature(result);
    if (failureSignature) {
      const priorFailure = repeatedFailures.get(block.id);
      const nextFailureState: RalphRepeatedFailureState =
        priorFailure?.signature === failureSignature
          ? { signature: failureSignature, count: priorFailure.count + 1 }
          : { signature: failureSignature, count: 1 };
      repeatedFailures.set(block.id, nextFailureState);

      if (
        repeatedFailureLimit !== null &&
        nextFailureState.count >= repeatedFailureLimit &&
        !directFailedEnd
      ) {
        const summary = `Ralph flow stopped at \`${block.id}\` after ${nextFailureState.count} identical non-success result(s): ${result.summary}`;

        if (
          autonomyMetadata &&
          autonomyPolicy.recoveryExhaustion === "defer" &&
          autonomyPolicy.deferToBlockId
        ) {
          autonomyDeferToBlockId = autonomyPolicy.deferToBlockId;
          const deferred: RalphAutonomyDeferredWork = {
            blockId: block.id,
            output: result.output,
            attempts: nextFailureState.count,
            reason: summary,
            routedToBlockId: autonomyDeferToBlockId,
          };
          autonomyMetadata.deferred.push(deferred);
          autonomyMetadata.exhaustion = {
            kind: "repeated-failure",
            blockId: block.id,
            recoverable: true,
            limit: repeatedFailureLimit,
            output: result.output,
            reason: summary,
          };
          result.recovery = {
            disposition: "deferred",
            attempt: nextFailureState.count,
          };
          repeatedFailures.delete(block.id);
        } else {
          await emitRunEvent(
            events,
            {
              type: "crash",
              blockId: block.id,
              output: result.output,
              reason: summary,
            },
            options.onEvent,
          );
          logger?.simple({
            kind: "crash",
            message: summary,
            ...getBlockLogFields(flow, block, config),
            output: result.output,
          });

          return finishRun({
            flow: flow.id,
            status: "blocked",
            summary,
            events,
            blockResults,
            missingVariables: [],
            unknownVariables: [],
            validation,
            checkpoint: createCheckpoint(block.id),
          });
        }
      }
    } else {
      repeatedFailures.delete(block.id);
    }

    if (isRecoverableRalphBlockResult(block, result)) {
      lastRecoverableCheckpoint = createRetryCheckpoint(block.id);
    }

    if (block.type === "END") {
      const status = getRunStatusForEndBlock(block);
      const summary = `Ralph flow \`${flow.name}\` reached terminal block \`${block.id}\`.`;
      const deferred = [...(autonomyMetadata?.deferred ?? [])]
        .reverse()
        .find((entry) => entry.failedEndBlockId === block.id);
      await emitRunEvent(
        events,
        {
          type: "end",
          blockId: block.id,
          status,
          summary,
          ...(autonomyMetadata
            ? { autonomy: cloneRalphRunAutonomyMetadata(autonomyMetadata) }
            : {}),
          ...(autonomyMetadata?.exhaustion
            ? { exhaustion: { ...autonomyMetadata.exhaustion } }
            : {}),
          ...(deferred ? { deferred: { ...deferred } } : {}),
        },
        options.onEvent,
      );
      return finishRun({
        flow: flow.id,
        status,
        summary,
        events,
        blockResults,
        missingVariables: [],
        unknownVariables: [],
        validation,
        ...(lastRecoverableCheckpoint
          ? { checkpoint: lastRecoverableCheckpoint }
          : {}),
      });
    }

    if (directFailedEnd && autonomyMetadata) {
      const recoveryAttempt = priorRecoveryCount + 1;
      const reason = result.error ?? result.summary;
      recoveryCounts.set(block.id, recoveryAttempt);

      if (recoveryAttempt <= autonomyPolicy.maxRecoveryAttempts) {
        const delaySeconds = getRalphAutonomyBackoffSeconds(
          autonomyPolicy,
          recoveryAttempt,
        );
        const recovery: RalphAutonomyRecoveryAttempt = {
          blockId: block.id,
          output: result.output,
          failedEndBlockId: directFailedEnd.block.id,
          attempt: recoveryAttempt,
          maxAttempts: autonomyPolicy.maxRecoveryAttempts,
          delaySeconds,
          reason,
        };
        autonomyMetadata.recoveryAttempts.push(recovery);
        delete autonomyMetadata.exhaustion;
        result.recovery = {
          disposition: "retrying",
          attempt: recoveryAttempt,
          maxAttempts: autonomyPolicy.maxRecoveryAttempts,
          failedEndBlockId: directFailedEnd.block.id,
        };
        await emitRunEvent(
          events,
          {
            type: "retry",
            blockId: block.id,
            attempt: recoveryAttempt + 1,
            reason,
            recovery: { ...recovery },
          },
          options.onEvent,
        );
        logger?.simple({
          kind: "retry",
          message: `Autonomy recovery ${recoveryAttempt}/${autonomyPolicy.maxRecoveryAttempts}: ${reason}`,
          ...getBlockLogFields(flow, block, config),
          attempt: recoveryAttempt + 1,
          output: result.output,
        });
        nextRetryAt = new Date(Date.now() + delaySeconds * 1_000).toISOString();
        markOperationRouted(operationId, block.id);
        await persistRunBoundary(
          block.id,
          `Autonomy recovery will retry \`${block.id}\`.`,
        );
        if (ownershipLost) {
          return finishRun({
            flow: flow.id,
            status: "crashed",
            summary: getOwnershipLostMessage(),
            events,
            blockResults,
            missingVariables: [],
            unknownVariables: [],
            validation,
          });
        }
        await delay(delaySeconds, options.signal).catch(() => undefined);
        if (!options.signal?.aborted) {
          nextRetryAt = undefined;
        }
        transitions += 1;
        syncTotalTransitions();
        continue;
      }

      const exhaustion: RalphAutonomyExhaustion = {
        kind: "recovery",
        blockId: block.id,
        recoverable: true,
        limit: autonomyPolicy.maxRecoveryAttempts,
        output: result.output,
        reason,
      };
      autonomyMetadata.exhaustion = exhaustion;
      result.recovery = {
        disposition:
          autonomyPolicy.recoveryExhaustion === "defer"
            ? "deferred"
            : "exhausted",
        attempt: recoveryAttempt,
        maxAttempts: autonomyPolicy.maxRecoveryAttempts,
        failedEndBlockId: directFailedEnd.block.id,
      };

      if (autonomyPolicy.recoveryExhaustion === "defer") {
        autonomyDeferToBlockId = autonomyPolicy.deferToBlockId;
        const deferred: RalphAutonomyDeferredWork = {
          blockId: block.id,
          output: result.output,
          failedEndBlockId: directFailedEnd.block.id,
          attempts: autonomyPolicy.maxRecoveryAttempts,
          reason,
          ...(autonomyDeferToBlockId
            ? { routedToBlockId: autonomyDeferToBlockId }
            : {}),
        };
        autonomyMetadata.deferred.push(deferred);
        recoveryCounts.delete(block.id);
        repeatedFailures.delete(block.id);
      }

      lastRecoverableCheckpoint = createRetryCheckpoint(block.id);
    }

    if (
      result.output === "ERROR" &&
      !directFailedEnd &&
      !autonomyDeferToBlockId
    ) {
      const nextErrorCount = (errorCounts.get(block.id) ?? 0) + 1;
      errorCounts.set(block.id, nextErrorCount);
      const hasExplicitErrorRoute = Boolean(
        findOutgoingRalphEdge(flow, block.id, "ERROR"),
      );
      const retryDecision = resolveRalphRetryDecision({
        block,
        currentErrorCount: nextErrorCount,
        hasExplicitErrorRoute,
        ...(result.failure
          ? { resultRetryable: result.failure.retryable }
          : {}),
      });

      if (retryDecision.shouldRetry) {
        await emitRunEvent(
          events,
          {
            type: "retry",
            blockId: block.id,
            attempt: retryDecision.nextAttempt ?? nextErrorCount + 1,
            reason: result.error ?? result.summary,
          },
          options.onEvent,
        );
        logger?.simple({
          kind: "retry",
          message: result.error ?? result.summary,
          ...getBlockLogFields(flow, block, config),
          attempt: retryDecision.nextAttempt ?? nextErrorCount + 1,
          output: result.output,
        });
        nextRetryAt = new Date(
          Date.now() + retryDecision.delaySeconds * 1_000,
        ).toISOString();
        markOperationRouted(operationId, block.id);
        await persistRunBoundary(block.id, `Retrying \`${block.id}\`.`);
        if (ownershipLost) {
          return finishRun({
            flow: flow.id,
            status: "crashed",
            summary: getOwnershipLostMessage(),
            events,
            blockResults,
            missingVariables: [],
            unknownVariables: [],
            validation,
          });
        }
        await delay(retryDecision.delaySeconds, options.signal).catch(
          () => undefined,
        );
        if (!options.signal?.aborted) {
          nextRetryAt = undefined;
        }
        transitions += 1;
        syncTotalTransitions();
        continue;
      }
    }

    const edge = autonomyDeferToBlockId
      ? undefined
      : findOutgoingRalphEdge(flow, block.id, result.output);
    let nextBlockId = autonomyDeferToBlockId ?? edge?.to;

    if (
      block.type === "VALIDATOR" &&
      result.output === "RETRY" &&
      !nextBlockId
    ) {
      nextBlockId = getValidatorGroupStart(flow, block.id);
    }

    if (!nextBlockId) {
      const summary = `Ralph flow crashed at \`${block.id}\`: no edge handles output ${result.output}.`;
      await emitRunEvent(
        events,
        {
          type: "crash",
          blockId: block.id,
          output: result.output,
          reason: summary,
        },
        options.onEvent,
      );
      logger?.simple({
        kind: "crash",
        message: summary,
        ...getBlockLogFields(flow, block, config),
        output: result.output,
      });
      return finishRun({
        flow: flow.id,
        status: "crashed",
        summary,
        events,
        blockResults,
        missingVariables: [],
        unknownVariables: [],
        validation,
      });
    }

    if (result.output !== "ERROR") {
      errorCounts.delete(block.id);
    }

    await emitRunEvent(
      events,
      {
        type: "edge-route",
        from: block.id,
        output: result.output,
        to: nextBlockId,
        ...(edge ? { edgeId: edge.id } : {}),
        ...(autonomyDeferToBlockId && autonomyMetadata?.deferred.length
          ? {
              deferred: {
                ...autonomyMetadata.deferred[
                  autonomyMetadata.deferred.length - 1
                ]!,
              },
            }
          : {}),
      },
      options.onEvent,
    );
    logger?.simple({
      kind: "edge-route",
      message: `Routing ${result.output} to ${blockMap.get(nextBlockId)?.title ?? nextBlockId}.`,
      ...getBlockLogFields(flow, block, config),
      output: result.output,
      from: block.id,
      to: nextBlockId,
      route: `${block.id}.${result.output} -> ${nextBlockId}`,
    });
    logger?.trace({
      kind: "edge-route",
      message: `Routing ${result.output} from ${block.id} to ${nextBlockId}.`,
      ...getBlockLogFields(flow, block, config),
      details: {
        edge,
        from: block.id,
        output: result.output,
        to: nextBlockId,
      },
    });

    markOperationRouted(operationId, nextBlockId);
    currentBlockId = nextBlockId;
    transitions += 1;
    syncTotalTransitions();
    await persistRunBoundary(
      currentBlockId,
      `Routed to \`${currentBlockId}\` after ${transitions} transition(s).`,
    );
    if (ownershipLost) {
      return finishRun({
        flow: flow.id,
        status: "crashed",
        summary: getOwnershipLostMessage(),
        events,
        blockResults,
        missingVariables: [],
        unknownVariables: [],
        validation,
      });
    }
  }

  return finishRun({
    flow: flow.id,
    status: "crashed",
    summary: "Ralph flow stopped without reaching an END block.",
    events,
    blockResults,
    missingVariables: [],
    unknownVariables: [],
    validation,
  });
};

const createUnexpectedRalphRunResult = (
  flow: RalphFlow,
  validation: RalphValidationResult,
  options: {
    runId: string;
    startedAt: string;
    reason: string;
    checkpoint?: RalphRunCheckpoint;
    durabilityRequired: boolean;
  },
): RalphRunResult => {
  const terminalBlockIds = new Set(
    flow.blocks.flatMap((block) => (block.type === "END" ? [block.id] : [])),
  );
  const checkpoint =
    options.checkpoint &&
    !terminalBlockIds.has(options.checkpoint.currentBlockId)
      ? {
          ...options.checkpoint,
          ...(options.checkpoint.lease
            ? {
                lease: {
                  ...options.checkpoint.lease,
                  releasedAt:
                    options.checkpoint.lease.releasedAt ?? createLogTimestamp(),
                },
              }
            : {}),
        }
      : undefined;
  const summary = `Ralph flow \`${flow.name}\` crashed unexpectedly: ${options.reason}`;
  const priorEvents = checkpoint?.events ?? [];
  const blockResults = checkpoint?.blockResults ?? [];
  const events: RalphRunEvent[] = [
    ...priorEvents,
    {
      type: "crash",
      blockId: checkpoint?.currentBlockId ?? "run",
      output: "ERROR",
      reason: summary,
    },
  ];
  const autonomy = checkpoint?.autonomy
    ? cloneRalphRunAutonomyMetadata(checkpoint.autonomy)
    : undefined;
  const outcome = deriveRalphRunOutcome({
    flow,
    lifecycleStatus: "crashed",
    blockResults,
    ...(autonomy ? { autonomy } : {}),
    ...(checkpoint?.progress ? { progress: checkpoint.progress } : {}),
  });

  return {
    runId: options.runId,
    startedAt: options.startedAt,
    finishedAt: createLogTimestamp(),
    flow: flow.id,
    status: "crashed",
    summary,
    events,
    blockResults,
    missingVariables: [],
    unknownVariables: [],
    validation,
    ...(checkpoint ? { checkpoint } : {}),
    ...(autonomy ? { autonomy } : {}),
    outcome,
    ...(checkpoint?.progress
      ? { progress: createRalphProgressState(checkpoint.progress) }
      : {}),
    durability: {
      status: "degraded",
      required: options.durabilityRequired,
      error: options.reason,
    },
  };
};

export const runRalphFlow = async (
  flow: RalphFlow,
  config: RuntimeConfig,
  customizations: CustomizationDiscoveryResult,
  options: RalphRunOptions = {},
): Promise<RalphRunResult> => {
  const leaseOwnerId = options.leaseOwnerId ?? `${process.pid}:${randomUUID()}`;
  const startedAt = options.checkpoint?.startedAt ?? createLogTimestamp();
  const runId =
    options.logger?.runId ??
    options.runId ??
    options.checkpoint?.runId ??
    `ralph-${flow.id}-${randomUUID()}`;

  try {
    return await runRalphFlowImpl(flow, config, customizations, {
      ...options,
      leaseOwnerId,
      runId,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    let cleanupError: string | undefined;
    try {
      await releaseActiveRalphFileMutationLocks(leaseOwnerId);
    } catch (releaseError) {
      cleanupError =
        releaseError instanceof Error
          ? releaseError.message
          : String(releaseError);
    }

    const failureReason = cleanupError
      ? `${reason} Lock cleanup also failed: ${cleanupError}`
      : reason;
    const validation = validateRalphFlow(flow, {
      config,
      ...(options.variableValues
        ? { variableValues: options.variableValues }
        : {}),
    });
    let recoveryCheckpoint = options.checkpoint;
    const paths = options.logger?.paths;
    let mutationLock: RalphFileMutationLock | undefined;

    try {
      if (paths && !cleanupError) {
        mutationLock = await acquireRalphFileMutationLock(
          paths.recordPath,
          `ralph-crash:${leaseOwnerId}`,
          30_000,
          { reapLiveOwner: false, ownerGroupId: leaseOwnerId },
        );
        const currentRaw = await readFile(paths.recordPath, "utf8").catch(
          (readError: unknown) => {
            if (isFileNotFoundError(readError)) {
              return undefined;
            }
            throw readError;
          },
        );
        const currentValue = currentRaw
          ? (JSON.parse(currentRaw) as unknown)
          : undefined;
        const current =
          currentValue === undefined
            ? undefined
            : isRalphRunRecord(currentValue, RALPH_FLOW_SCHEMA_VERSION)
              ? currentValue
              : (() => {
                  throw new Error(
                    `The interrupted Ralph run record at ${paths.recordPath} is invalid.`,
                  );
                })();
        const runStore = new RalphRunStore(paths.directory);
        await runStore.initialize();
        const storedCheckpoint = await runStore.readLatestCheckpoint();
        const independentLease = await runStore.readLease();
        const latestCheckpoint = storedCheckpoint?.checkpoint;
        const currentLease = current?.checkpoint?.lease;
        const latestLease = latestCheckpoint?.lease;
        const hasForeignOwner =
          (currentLease &&
            !currentLease.releasedAt &&
            currentLease.ownerId !== leaseOwnerId) ||
          (latestLease &&
            !latestLease.releasedAt &&
            latestLease.ownerId !== leaseOwnerId) ||
          (independentLease?.active &&
            independentLease.lease.ownerId !== leaseOwnerId);
        const canFinalize =
          !hasForeignOwner &&
          (!current ||
            (current.status === "running" &&
              current.id === runId &&
              current.flowId === flow.id));

        if (canFinalize) {
          if (
            latestCheckpoint?.runId === runId &&
            latestCheckpoint.flowId === flow.id &&
            (!latestLease || latestLease.ownerId === leaseOwnerId)
          ) {
            recoveryCheckpoint = latestCheckpoint;
          }
          if (
            independentLease &&
            independentLease.lease.ownerId === leaseOwnerId
          ) {
            await runStore.releaseLease({
              runId,
              flowId: flow.id,
              ownerId: leaseOwnerId,
              generation: independentLease.lease.generation,
            });
          }
          const result = createUnexpectedRalphRunResult(flow, validation, {
            runId,
            startedAt: recoveryCheckpoint?.startedAt ?? startedAt,
            reason: failureReason,
            ...(recoveryCheckpoint ? { checkpoint: recoveryCheckpoint } : {}),
            durabilityRequired: true,
          });
          const record = createRalphRunRecord(
            RALPH_FLOW_SCHEMA_VERSION,
            paths.id,
            result.startedAt ?? startedAt,
            flow,
            result,
            recoveryCheckpoint?.variables ?? options.variableValues ?? {},
            paths,
          );
          await mutationLock.assertOwnership();
          await writeJsonAtomically(paths.recordPath, record, {
            beforeCommit: mutationLock.assertOwnership,
          });
          await mutationLock.assertOwnership();
        }
      }
    } catch (persistenceError) {
      cleanupError = `${cleanupError ? `${cleanupError} ` : ""}Crash finalization failed: ${persistenceError instanceof Error ? persistenceError.message : String(persistenceError)}`;
    } finally {
      await mutationLock?.release().catch((releaseError: unknown) => {
        cleanupError = `${cleanupError ? `${cleanupError} ` : ""}Crash-finalization lock release failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`;
      });
    }

    const result = createUnexpectedRalphRunResult(flow, validation, {
      runId,
      startedAt: recoveryCheckpoint?.startedAt ?? startedAt,
      reason: cleanupError
        ? `${reason} Recovery finalization was incomplete: ${cleanupError}`
        : reason,
      ...(recoveryCheckpoint ? { checkpoint: recoveryCheckpoint } : {}),
      durabilityRequired: Boolean(paths),
    });
    try {
      options.logger?.simple({
        kind: "crash",
        message: result.summary,
        flowId: flow.id,
        flowName: flow.name,
        blockId: result.checkpoint?.currentBlockId ?? "run",
        output: "ERROR",
      });
      options.logger?.trace({
        kind: "crash",
        message: result.summary,
        flowId: flow.id,
        details: result,
      });
      await options.logger?.flush();
    } catch {
      // The durable run record above remains the authoritative crash result.
    }
    return result;
  }
};
