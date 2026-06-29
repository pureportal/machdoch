import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, lstat, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
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
  createDefaultRalphScopeRegistryPath,
  createRalphScopeRegistryMarkdownPath,
  discoverRalphScopeEvidence,
  formatRalphScopeRegistryMarkdown,
  isResolvedPathInside,
  markRalphScopeRegistryResult,
  normalizeRalphScopeSelectionStrategy,
  parseRalphScopeEvidence,
  parseRalphScopeExcludePaths,
  readRalphScopeRegistryFile,
  selectRalphScopeFromRegistry,
  updateRalphScopeRegistryFromEvidence,
  writeRalphScopeRegistryFile,
  type RalphScopeSelectionStrategy,
} from "./_helpers/ralph-scope-registry.helper.js";
import { resolveRalphRetryDecision } from "./_helpers/resolve-ralph-retry-decision.helper.js";
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
} from "./_helpers/parse-ralph-decision.helper.js";
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
  normalizeLocalCommandCwd,
} from "./_helpers/process-execution.js";
import {
  collectRalphGitChangeSnapshot,
  type RalphGitChangeSnapshot,
  type RalphGitChangedFileSnapshot,
} from "./_helpers/ralph-git-change-snapshot.helper.js";
import { executeTask } from "./execution.js";
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
} from "./types.js";
import type {
  ModelProvider,
  ReasoningMode,
  RuntimeConfig,
} from "./runtime-contract.generated.js";

export { discoverRalphFlowVariables } from "./_helpers/ralph-placeholders.helper.js";

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
const DEFAULT_RALPH_UTILITY_POLL_INTERVAL_SECONDS = 30;
const DEFAULT_RALPH_UTILITY_MAX_SEARCH_RESULTS = 100;
const DEFAULT_RALPH_REPEATED_FAILURE_LIMIT = 3;
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
export type RalphVariableType = (typeof RALPH_VARIABLE_TYPES)[number];
export type { RalphFlowScope, RalphRunLogPaths } from "./_helpers/create-ralph-storage-paths.helper.js";
export type { RalphScopeSelectionStrategy } from "./_helpers/ralph-scope-registry.helper.js";
export type RalphValidatorDecision = "DONE" | "CONTINUE" | "RETRY" | "ERROR";
export type RalphExecutionOutput = "SUCCESS" | "ERROR" | RalphValidatorDecision | string;
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

export {
  MAX_RALPH_RESULT_CHARS,
  parseRalphDecision,
} from "./_helpers/parse-ralph-decision.helper.js";
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
  | "completed"
  | "crashed"
  | "blocked"
  | "stopped"
  | "waiting-for-input";
export type RalphUtilityWaitMode = "delay" | "until-time" | "condition" | "poll";
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
  maxResults?: number;
  maxDepth?: number;
  excludePaths?: string;
  flowAlias?: string;
  strategy?: RalphScopeSelectionStrategy | string;
  scopeId?: string;
  taskId?: string;
  status?: string;
  result?: string;
  includeMarkdown?: boolean;
  forceNew?: boolean;
  reset?: boolean;
  jsonPatchMode?: "merge" | "replace";
  counterName?: string;
  counterKey?: string;
  command?: string;
  fallbackCommand?: string;
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
}

export interface RalphFlowSource {
  kind: "starter";
  id: string;
  version: number;
  importedAt?: string;
}

export interface RalphFlow {
  schemaVersion: typeof RALPH_FLOW_SCHEMA_VERSION;
  id: string;
  alias?: string;
  name: string;
  description?: string;
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
  output: RalphExecutionOutput;
  status: "completed" | "error" | "skipped";
  attempt: number;
  result?: TaskExecutionResult;
  progress?: RalphRunRecordBlockProgressEvent[];
  data?: unknown;
  summary: string;
  markdown?: string;
  error?: string;
}

export interface RalphRunRecordBlockProgressEvent {
  timestamp: string;
  kind: "model-stream" | "timeline" | "action-output" | "message";
  label: string;
  streamKind?: NonNullable<TaskExecutionProgress["modelStream"]>["kind"];
  phase?: NonNullable<TaskExecutionProgress["timelineEvent"]>["phase"];
  tone?: NonNullable<TaskExecutionProgress["timelineEvent"]>["tone"];
  complete?: boolean;
  toolName?: string;
  stream?: TaskActionOutput["stream"];
  content?: string;
  detail?: string;
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
    }
  | {
      type: "retry";
      blockId: string;
      attempt: number;
      reason: string;
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
      type: "end";
      blockId: string;
      status: RalphRunStatus;
      summary: string;
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
  status?: RalphRunStatus | RalphBlockExecutionResult["status"] | TaskExecutionResult["status"];
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
  simple(entry: Omit<RalphSimpleLogEntry, "sequence" | "createdAt" | "runId">): void;
  trace(entry: Omit<RalphTraceLogEntry, "sequence" | "createdAt" | "runId">): void;
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
  repeatedFailureLimit?: number | null;
}

export interface RalphExecutionOptionsSource {
  runId?: string;
  logger?: RalphRunLogger;
  signal?: AbortSignal;
  onStateChange?: TaskExecutionProgressHandler;
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
}

export interface RalphRunRecordBlock {
  blockId: string;
  output: RalphExecutionOutput;
  status: RalphBlockExecutionResult["status"];
  attempt: number;
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
  repeatedFailures: Record<string, RalphRepeatedFailureState>;
  pendingInput?: RalphInputRequest;
  interviewStates?: Record<string, RalphInterviewState>;
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
  status: RalphRunStatus;
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
  lastResult?: RalphBlockExecutionResult;
  resultsByBlock: Map<string, RalphBlockExecutionResult>;
  runLog: string[];
  variables: Record<string, string>;
  interviewStates: Map<string, RalphInterviewState>;
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

  const directPath = getRalphFlowPath(workspaceRoot, normalizedReference, scope);

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
    throw new Error(`Ralph flow \`${reference}\` was not found.`);
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
          id: normalizeOptionalString(flow.id) ?? basename(entry.name, FLOW_FILE_EXTENSION),
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
    throw new Error(`Ralph flow \`${reference}\` was not found.`);
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
    throw new Error(`Ralph flow \`${id}\` is invalid: ${validation.errors.join(" ")}`);
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

    try {
      const existingFlow = await readRalphFlowFile(path);
      const existingId =
        normalizeOptionalString(existingFlow.id) ?? basename(entry.name, FLOW_FILE_EXTENSION);

      if (existingId === flow.id) {
        continue;
      }

      const existingAlias = existingFlow.alias
        ? normalizeFlowAlias(existingFlow.alias)
        : "";

      if (existingId === alias || existingAlias === alias) {
        throw new Error(
          `Ralph flow alias \`${flow.alias}\` is already used by \`${existingFlow.name || existingId}\`.`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Ralph flow alias")) {
        throw error;
      }
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
  await assertRalphFlowAliasAvailable(workspaceRoot, flow, scope);
  const flowPath = getRalphFlowPath(workspaceRoot, flow.id, scope);
  const now = new Date().toISOString();
  const storedFlow: RalphFlow = {
    ...flow,
    variables: validation.variables,
    createdAt: flow.createdAt ?? now,
    updatedAt: now,
  };

  await mkdir(directory, { recursive: true });

  if (options.createRevision && existsSync(flowPath)) {
    const revisionDirectory = getRalphRevisionDirectory(
      workspaceRoot,
      flow.id,
      scope,
    );
    await mkdir(revisionDirectory, { recursive: true });
    const revisionPath = createRalphRevisionFilePath(revisionDirectory, now);
    await writeFile(revisionPath, await readFile(flowPath, "utf8"), "utf8");
  }

  await writeFile(flowPath, `${JSON.stringify(storedFlow, null, 2)}\n`, "utf8");

  return flowPath;
};

export const listRalphFlows = async (
  workspaceRoot: string,
  options: RalphFlowListOptions = {},
): Promise<RalphFlowSummary[]> => {
  const scopes: RalphFlowScope[] = options.scope === "all"
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
          id: normalizeOptionalString(flow.id) ?? basename(entry.name, FLOW_FILE_EXTENSION),
          ...(alias ? { alias } : {}),
          name: normalizeOptionalString(flow.name) ?? basename(entry.name, FLOW_FILE_EXTENSION),
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
  options: { scope?: RalphFlowScope } = {},
): Promise<RalphFlowDeleteResult> => {
  const scope = options.scope ?? "workspace";
  const normalizedReference = normalizeFlowId(reference);

  if (!normalizedReference) {
    throw new Error("Expected Ralph flow id or alias.");
  }

  const directPath = getRalphFlowPath(workspaceRoot, normalizedReference, scope);
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
    const resolution = await resolveRalphFlowReference(workspaceRoot, reference, {
      scope,
    });
    flowId = normalizeOptionalString(resolution.flow.id) ?? resolution.id;
    flowPath = resolution.path;
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
  options: { scope?: RalphFlowScope } = {},
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
  });
  const restoredFlow = await readRalphFlow(workspaceRoot, flowReference.flow.id, {
    allowInvalid: true,
    scope,
  });

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
  private failed = false;

  public constructor(paths: RalphRunLogPaths) {
    this.runId = paths.id;
    this.paths = paths;
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
      await appendFile(this.paths.simpleJsonlPath, createRalphLogLine(completedEntry), "utf8");
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
      await appendFile(this.paths.traceJsonlPath, createRalphLogLine(completedEntry), "utf8");
    });
  }

  public async flush(): Promise<void> {
    await this.pending.catch(() => undefined);
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private enqueue(write: () => Promise<void>): void {
    if (this.failed) {
      return;
    }

    this.pending = this.pending
      .then(write)
      .catch(() => {
        this.failed = true;
      });
  }
}

export const createRalphRunLogger = async (
  workspaceRoot: string,
  flow: RalphFlow,
  options: {
    runId?: string;
    variableValues?: Record<string, string>;
    paths?: RalphRunLogPaths;
    append?: boolean;
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
  const logger = new RalphFileRunLogger(paths);

  await mkdir(paths.directory, { recursive: true });
  if (options.append) {
    await appendFile(
      paths.simpleMarkdownPath,
      [``, `## Resumed ${createdAt}`, ``].join("\n"),
      "utf8",
    );
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
  const runDirectory = getRalphRunDirectory(workspaceRoot, options.scope ?? "workspace");
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

  await writeFile(paths.recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

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
): Promise<{ path: string; record: RalphRunRecord }> => {
  const path = await resolveRalphRunRecordPath(
    workspaceRoot,
    runId,
    options.scope ?? "workspace",
  );
  const record = await readRalphRunRecordFile(path);

  if (!record) {
    throw new Error(`Ralph run \`${runId}\` is not a valid run record.`);
  }

  return { path, record };
};

export const listRalphRunRecords = async (
  workspaceRoot: string,
  options: {
    flowId?: string;
    limit?: number;
    scope?: RalphFlowScope;
  } = {},
): Promise<RalphRunSummary[]> => {
  const runDirectory = getRalphRunDirectory(workspaceRoot, options.scope ?? "workspace");

  if (!existsSync(runDirectory)) {
    return [];
  }

  const entries = await readdir(runDirectory, { withFileTypes: true });
  const summaries: RalphRunSummary[] = [];
  const normalizedFlowId = options.flowId
    ? normalizeFlowId(options.flowId)
    : undefined;

  for (const entry of entries) {
    const path = entry.isDirectory()
      ? join(runDirectory, entry.name, "run.json")
      : entry.isFile() && entry.name.endsWith(".json")
        ? join(runDirectory, entry.name)
        : undefined;

    if (!path || !existsSync(path)) {
      continue;
    }

    const record = await readRalphRunRecordFile(path);

    if (!record) {
      continue;
    }

    if (normalizedFlowId && normalizeFlowId(record.flowId) !== normalizedFlowId) {
      continue;
    }

    summaries.push(createRalphRunSummaryFromRecord(record, path));
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
  const { path: recordPath, record } = await readRalphRunRecord(workspaceRoot, runId, {
    scope: options.scope ?? "workspace",
  });
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
};

const resolveVariableValues = (
  variables: RalphFlowVariable[],
  supplied: Record<string, string> = {},
): ResolvedVariableValues => {
  const values: Record<string, string> = {};
  const variableNames = new Set(variables.map((variable) => variable.name));
  const missing: string[] = [];
  const unknown = Object.keys(supplied).filter((name) => !variableNames.has(name));

  for (const variable of variables) {
    const suppliedValue = supplied[variable.name];

    if (suppliedValue !== undefined) {
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
): string => {
  if (placeholder.variable) {
    return context.variables[placeholder.variable.name] ?? "";
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

  const reference = placeholder.blockReference;
  if (!reference) {
    return placeholder.raw;
  }

  const result = context.resultsByBlock.get(reference.blockId);
  if (!result) {
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
      return "";
    }

    return typeof value === "string" ? value : JSON.stringify(value);
  }

  return result.markdown ?? result.summary;
};

const resolveTemplateText = (text: string, context: RalphResultContext): string => {
  return text.replace(RALPH_PLACEHOLDER_PATTERN, (raw: string, content: string) =>
    resolvePlaceholder(parseRalphPlaceholderContent(raw, content.trim()), context),
  );
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
      ? context.variables[rawValue] ?? ""
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
          ).join(", ")}.`,
        );
      }

      if (!providerSupportsImageInputMediaType(config.provider, mediaType)) {
        throw new Error(
          `Unsupported image attachment format for \`${attachment.value}\`. Supported extensions for provider \`${config.provider}\`: ${getSupportedImageInputExtensions(
            config.provider,
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

const delay = async (seconds: number, signal: AbortSignal | undefined): Promise<void> => {
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
): RuntimeConfig => {
  const settings = block.settings;

  return {
    ...baseConfig,
    workspaceRoot:
      settings?.workspace?.mode === "custom" && settings.workspace.path
        ? settings.workspace.path
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
    "Return exactly one final marker line:",
    "RALPH_DECISION: DONE",
    "RALPH_DECISION: CONTINUE",
    "RALPH_DECISION: RETRY",
    "RALPH_DECISION: ERROR",
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
    "Return exactly one final marker line:",
    "RALPH_DECISION: <LABEL>",
    "",
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
      phase: progress.timelineEvent.phase,
      ...(progress.timelineEvent.tone ? { tone: progress.timelineEvent.tone } : {}),
      ...(progress.timelineEvent.toolName
        ? { toolName: progress.timelineEvent.toolName }
        : {}),
      ...(progress.timelineEvent.detail
        ? {
            detail: truncateRalphBlockProgressText(progress.timelineEvent.detail),
          }
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
        const progress: TaskExecutionProgress = withRalphProgressBlockMetadata({
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
        }, block);

        appendRalphBlockProgressEvent(
          progressEvents,
          block ? createRalphBlockProgressEvent(progress) : undefined,
        );
        void baseOnStateChange?.(progress);
      }
    : undefined;

  return {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(runId ? { runId } : {}),
    ...(onStateChange ? { onStateChange } : {}),
    ...(onActionOutput ? { onActionOutput } : {}),
    ...(conversationContext ? { conversationContext } : {}),
    ...(typeof block?.settings?.timeoutSeconds === "number" &&
    Number.isFinite(block.settings.timeoutSeconds) &&
    block.settings.timeoutSeconds > 0
      ? { maxDurationMs: block.settings.timeoutSeconds * 1000 }
      : {}),
    ...(imageInputs.length > 0 ? { imageInputs } : {}),
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

type RalphExecutionStepResult = RalphBlockExecutionResult | RalphInputWaitStepResult;

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
  "flowId" | "flowName" | "blockId" | "blockTitle" | "blockType" | "provider" | "model"
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
  const blockConfig = createBlockConfig(config, block);
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
  }

  return withRalphBlockProgress(
    createRalphPromptExecutionResult(block, result, maxIterations),
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
  const blockConfig = createBlockConfig(config, block);
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
  const blockConfig = createBlockConfig(config, block);
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
          return parsed.filter((entry): entry is string => typeof entry === "string");
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
      return parseContextVariableAsInputValue(field, context.variables[variableName]);
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

  if (pendingInput && !response) {
    return {
      kind: "input-wait",
      request: pendingInput,
      summary: `${block.title} is waiting for input.`,
    };
  }

  if (!response) {
    const request = createAskUserRequest(block, context);

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

  applyNormalizedInputValuesToContext(context, pendingInput.fields, normalized.values);

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

  const blockConfig = createBlockConfig(config, block);
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
        new Error(getResultMarkdown(result) || "Interview AI question generation failed."),
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
          label: generation.summary ?? "What else should be clarified before continuing?",
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
): unknown => {
  if (typeof value === "string") {
    return resolveTemplateText(value, context);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolveTemplateValue(entry, context));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        resolveTemplateValue(entry, context),
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
  const workspacePath = resolve(workspaceRoot);
  const relativePath = relative(workspacePath, resolve(path));

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

const delayWithBackoff = async (
  intervalSeconds: number,
  backoffMultiplier: number | undefined,
  attempt: number,
  signal: AbortSignal | undefined,
): Promise<void> => {
  const multiplier = backoffMultiplier && backoffMultiplier > 0
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

    return createUtilityResult(block, "SUCCESS", `${block.title} reached runAt.`, {
      mode,
      runAt: utility.runAt,
    });
  }

  const condition = utility.condition;
  if (!condition) {
    return createUtilityResult(block, "SUCCESS", `${block.title} has no condition.`, {
      mode,
    });
  }

  let attempt = 1;
  while (true) {
    if (evaluateRalphUtilityCondition(condition, context)) {
      return createUtilityResult(block, "SUCCESS", `${block.title} condition matched.`, {
        mode,
        attempts: attempt,
      });
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
      error instanceof Error && error.name === "AbortError" ? "TIMEOUT" : "ERROR";
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
    return createUtilityResult(block, "ERROR", "POLL utility requires condition.");
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
    ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );

  cachedWindowsShellExecutable = result.error || result.status !== 0
    ? "powershell.exe"
    : "pwsh.exe";

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

const executeCommandUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  checkMode: boolean,
  signal?: AbortSignal,
): Promise<RalphBlockExecutionResult> => {
  const command = utility.command?.trim() || utility.fallbackCommand?.trim();

  if (!command) {
    return createUtilityResult(block, "ERROR", "Command utility requires command.");
  }

  const invocation = getShellInvocation(command);
  const cwd = normalizeLocalCommandCwd(
    resolveUtilityPath(utility.cwd, config.workspaceRoot),
  );
  const acceptedExitCodes = checkMode
    ? Array.from({ length: 256 }, (_, index) => index)
    : utility.acceptedExitCodes ?? [0];

  try {
    const result = await executeLocalCommand(invocation.executable, invocation.args, {
      cwd,
      timeoutMs: getUtilityTimeoutMs(
        utility,
        DEFAULT_RALPH_UTILITY_COMMAND_TIMEOUT_MS,
      ),
      maxBufferBytes:
        utility.maxOutputBytes ?? DEFAULT_RALPH_UTILITY_RESPONSE_LIMIT_BYTES,
      acceptedExitCodes,
      ...(signal ? { signal } : {}),
      ...(utility.env ? { env: { ...process.env, ...utility.env } } : {}),
    });
    const data = {
      command,
      cwd,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };

    if (checkMode && result.exitCode !== 0) {
      return createUtilityResult(
        block,
        "FAILED",
        `${block.title} failed with exit code ${result.exitCode}.`,
        data,
      );
    }

    return createUtilityResult(block, "SUCCESS", `${block.title} completed.`, data);
  } catch (error) {
    return createUtilityResult(
      block,
      "ERROR",
      formatLocalCommandError(`${block.title} failed.`, error),
    );
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
    return createUtilityResult(block, "ERROR", "Condition utility requires condition.");
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

    return createUtilityResult(block, "SUCCESS", `${block.title} read ${path}.`, {
      path,
      content,
    });
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

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, {
      encoding: utility.encoding ?? "utf8",
      flag: utility.append ? "a" : "w",
    });

    return createUtilityResult(block, "SUCCESS", `${block.title} wrote ${path}.`, {
      path,
      bytes: Buffer.byteLength(content),
      append: utility.append === true,
    });
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
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringifyJson(value), "utf8");
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
    return createUtilityResult(block, "ERROR", "Read JSON utility requires path.");
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
    return createUtilityResult(block, "ERROR", "Write JSON utility requires path.");
  }

  try {
    const path = resolveWorkspaceContainedUtilityPath(rawPath, config.workspaceRoot);
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

    return createUtilityResult(block, "SUCCESS", `${block.title} wrote ${path}.`, {
      path,
      json,
      validation,
    });
  } catch (error) {
    return createRalphBlockExecutionErrorResult(block, error);
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
    return createUtilityResult(block, "ERROR", "Patch JSON utility requires path.");
  }

  const path = resolveWorkspaceContainedUtilityPath(rawPath, config.workspaceRoot);

  try {
    const current = await readJsonFile(path);
    const patch = getWritableJsonInput(utility, context);
    const json =
      utility.jsonPatchMode === "replace" ? patch : deepMergeJson(current, patch);
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

    return createUtilityResult(block, "SUCCESS", `${block.title} patched ${path}.`, {
      path,
      mode: utility.jsonPatchMode ?? "merge",
      patch,
      json,
      validation,
    });
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
    return createUtilityResult(block, "ERROR", "Append JSONL utility requires path.");
  }

  try {
    const path = resolveWorkspaceContainedUtilityPath(rawPath, config.workspaceRoot);
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

    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(json)}\n`, "utf8");

    return createUtilityResult(block, "SUCCESS", `${block.title} appended ${path}.`, {
      path,
      json,
      validation,
    });
  } catch (error) {
    return createRalphBlockExecutionErrorResult(block, error);
  }
};

interface JsonlEntry {
  line: number;
  value: unknown;
}

const readJsonlEntries = async (
  path: string,
): Promise<{ entries: JsonlEntry[]; invalid: Array<{ line: number; error: string }> }> => {
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
    return createUtilityResult(block, "ERROR", "Read JSONL utility requires path.");
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
    return createUtilityResult(block, "ERROR", "Query JSONL utility requires path.");
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
          evaluateRalphUtilityCondition(utility.condition!, context, entry.value),
        )
      : entries;
    const limit =
      typeof utility.maxResults === "number" && utility.maxResults >= 0
        ? utility.maxResults
        : matchedEntries.length;
    const selectedEntries = matchedEntries.slice(0, limit);
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

const getJsonTaskStatus = (task: Record<string, unknown>): string => {
  return typeof task.status === "string" ? task.status.toLowerCase() : "todo";
};

const isSelectableJsonTask = (task: Record<string, unknown>): boolean => {
  return !["done", "completed", "skipped", "cancelled", "blocked"].includes(
    getJsonTaskStatus(task),
  );
};

const selectJsonTaskCandidate = (
  tasks: Record<string, unknown>[],
  strategy: string | undefined,
): { task: Record<string, unknown>; index: number } | undefined => {
  const candidates = tasks
    .map((task, index) => ({ task, index }))
    .filter((candidate) => isSelectableJsonTask(candidate.task));

  if (candidates.length === 0) {
    return undefined;
  }

  switch (strategy) {
    case "random":
    case "random-seeded":
      return candidates[Math.floor(Math.random() * candidates.length)];
    case "end-to-start":
      return candidates[candidates.length - 1];
    case "priority":
      return [...candidates].sort(
        (left, right) =>
          Number(right.task.priority ?? 0) - Number(left.task.priority ?? 0),
      )[0];
    case "least-recent":
    case "least-validated":
      return [...candidates].sort((left, right) =>
        String(left.task.updatedAt ?? left.task.selectedAt ?? "").localeCompare(
          String(right.task.updatedAt ?? right.task.selectedAt ?? ""),
        ),
      )[0];
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
      )[0];
    }
    case "start-to-end":
    case "round-robin":
    default:
      return candidates[0];
  }
};

const executeSelectJsonTaskUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
): Promise<RalphBlockExecutionResult> => {
  const rawPath = utility.path?.trim();

  if (!rawPath) {
    return createUtilityResult(block, "ERROR", "Select JSON task utility requires path.");
  }

  const path = resolveWorkspaceContainedUtilityPath(rawPath, config.workspaceRoot);

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

    const selected = selectJsonTaskCandidate(taskArray.tasks, utility.strategy);

    if (!selected) {
      return createUtilityResult(
        block,
        "EMPTY",
        `${block.title} found no selectable task.`,
        { path, jsonPath: taskArray.normalizedPath, tasks: taskArray.tasks },
        "completed",
      );
    }

    const now = new Date().toISOString();
    const currentAttempts =
      typeof selected.task.attempts === "number" ? selected.task.attempts : 0;

    selected.task.status =
      getJsonTaskStatus(selected.task) === "in_progress"
        ? selected.task.status
        : "in_progress";
    selected.task.selectedAt = now;
    selected.task.updatedAt = now;
    selected.task.attempts = currentAttempts + 1;

    await writeUtilityJsonOutput(path, json);

    return createUtilityResult(
      block,
      "SELECTED",
      `${block.title} selected ${String(selected.task.id ?? selected.index)}.`,
      {
        path,
        jsonPath: taskArray.normalizedPath,
        task: selected.task,
        index: selected.index,
        remainingCount: taskArray.tasks.filter(isSelectableJsonTask).length,
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
  }
};

const getJsonTaskIdFromInput = (
  utility: RalphUtilityConfig,
  context: RalphResultContext,
): string | undefined => {
  if (utility.taskId?.trim()) {
    return utility.taskId.trim();
  }

  const input =
    utility.input !== undefined
      ? parseRalphUtilityJsonValue(utility.input)
      : context.lastResult?.data;
  const task = isRecord(input) && isRecord(input.task) ? input.task : undefined;
  const id = task?.id ?? (isRecord(input) ? input.taskId ?? input.id : undefined);

  return typeof id === "string" && id.trim() ? id.trim() : undefined;
};

const executeMarkJsonTaskUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  context: RalphResultContext,
): Promise<RalphBlockExecutionResult> => {
  const rawPath = utility.path?.trim();

  if (!rawPath) {
    return createUtilityResult(block, "ERROR", "Mark JSON task utility requires path.");
  }

  const path = resolveWorkspaceContainedUtilityPath(rawPath, config.workspaceRoot);

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

    const taskId = getJsonTaskIdFromInput(utility, context);
    const candidate = taskId
      ? taskArray.tasks.find((task) => task.id === taskId)
      : taskArray.tasks.find((task) => getJsonTaskStatus(task) === "in_progress");

    if (!candidate) {
      return createUtilityResult(
        block,
        "NOT_FOUND",
        `${block.title} found no matching task.`,
        { path, jsonPath: taskArray.normalizedPath, taskId },
        "completed",
      );
    }

    const now = new Date().toISOString();
    const status = utility.status ?? utility.result ?? "done";

    candidate.status = status;
    candidate.updatedAt = now;
    if (["done", "completed"].includes(status.toLowerCase())) {
      candidate.completedAt = now;
    }
    candidate.lastResult = {
      blockId: context.lastResult?.blockId,
      output: context.lastResult?.output,
      summary: context.lastResult?.summary,
    };

    await writeUtilityJsonOutput(path, json);

    return createUtilityResult(
      block,
      "SUCCESS",
      `${block.title} marked ${String(candidate.id ?? "task")} as ${status}.`,
      {
        path,
        jsonPath: taskArray.normalizedPath,
        task: candidate,
        taskId: candidate.id,
        status,
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
  }
};

const executeFileExistsUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
): Promise<RalphBlockExecutionResult> => {
  const rawPath = utility.path?.trim();

  if (!rawPath) {
    return createUtilityResult(block, "ERROR", "File exists utility requires path.");
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
    return createUtilityResult(block, "ERROR", "Delete file utility requires path.");
  }

  try {
    const path = resolveWorkspaceContainedUtilityPath(rawPath, config.workspaceRoot);
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
      const path = resolveWorkspaceContainedUtilityPath(rawPath, config.workspaceRoot);

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

  const from = resolveWorkspaceContainedUtilityPath(rawPath, config.workspaceRoot);
  const to = resolveWorkspaceContainedUtilityPath(rawOutputPath, config.workspaceRoot);

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

    return createUtilityResult(block, "SUCCESS", `${block.title} moved ${from}.`, {
      from,
      to,
    });
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

const createArchiveFilePath = (
  sourcePath: string,
  utility: RalphUtilityConfig,
  workspaceRoot: string,
): string => {
  const rawOutputPath = utility.outputPath?.trim();

  if (rawOutputPath) {
    return resolveWorkspaceContainedUtilityPath(rawOutputPath, workspaceRoot);
  }

  const archiveRoot = resolveWorkspaceContainedUtilityPath(
    utility.rootPath?.trim() || ".machdoch/ralph/archive",
    workspaceRoot,
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
    return createUtilityResult(block, "ERROR", "Archive file utility requires path.");
  }

  const from = resolveWorkspaceContainedUtilityPath(rawPath, config.workspaceRoot);
  const to = createArchiveFilePath(from, utility, config.workspaceRoot);

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

    return createUtilityResult(block, "SUCCESS", `${block.title} archived ${from}.`, {
      from,
      to,
    });
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
  const path = resolveWorkspaceContainedUtilityPath(
    utility.path?.trim() || ".machdoch/ralph/counters.json",
    config.workspaceRoot,
  );
  const counterName = utility.counterName?.trim() || block.id;
  const counterKey = utility.counterKey?.trim() || context.runId;

  try {
    const file = await readCounterFile(path);
    const counters = isRecord(file.counters) ? { ...file.counters } : {};
    const group = isRecord(counters[counterName])
      ? { ...counters[counterName] }
      : {};
    const currentState = isRecord(group[counterKey])
      ? group[counterKey]
      : undefined;
    const currentCount =
      typeof currentState?.count === "number" && Number.isFinite(currentState.count)
        ? currentState.count
        : 0;
    const count = utility.reset ? 0 : currentCount + 1;
    const limit =
      typeof utility.maxAttempts === "number" ? utility.maxAttempts : null;

    group[counterKey] = {
      count,
      updatedAt: new Date().toISOString(),
    };
    counters[counterName] = group;
    await writeUtilityJsonOutput(path, { counters });

    const limitReached = limit !== null && count > limit;

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
  }
};

const getScopeRegistryFlowAlias = (utility: RalphUtilityConfig): string => {
  return utility.flowAlias?.trim() || "ralph-flow";
};

const getScopeRegistryStrategy = (
  utility: RalphUtilityConfig,
): RalphScopeSelectionStrategy => {
  return normalizeRalphScopeSelectionStrategy(utility.strategy) ?? "round-robin";
};

const resolveScopeRegistryUtilityPath = (
  utility: RalphUtilityConfig,
  workspaceRoot: string,
): string => {
  const flowAlias = getScopeRegistryFlowAlias(utility);
  const path =
    utility.registryPath?.trim() ||
    utility.path?.trim() ||
    createDefaultRalphScopeRegistryPath(flowAlias);

  return resolveWorkspaceContainedUtilityPath(path, workspaceRoot);
};

const resolveScopeScanRootPath = (
  utility: RalphUtilityConfig,
  workspaceRoot: string,
): string => {
  const path = resolveUtilityPath(utility.rootPath?.trim() || ".", workspaceRoot);

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

  const markdownPath = resolveWorkspaceContainedUtilityPath(
    utility.outputPath?.trim() || createRalphScopeRegistryMarkdownPath(registryPath),
    workspaceRoot,
  );

  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(markdownPath, formatRalphScopeRegistryMarkdown(registry), "utf8");

  return markdownPath;
};

const executeScanScopeEvidenceUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
): Promise<RalphBlockExecutionResult> => {
  try {
    const rootPath = resolveScopeScanRootPath(utility, config.workspaceRoot);
    const scanOptions: Parameters<typeof discoverRalphScopeEvidence>[1] = {
      rootPath,
      excludePaths: parseRalphScopeExcludePaths(utility.excludePaths),
    };

    if (utility.maxDepth !== undefined) {
      scanOptions.maxDepth = utility.maxDepth;
    }

    if (utility.maxResults !== undefined) {
      scanOptions.maxResults = utility.maxResults;
    }

    const evidence = await discoverRalphScopeEvidence(
      config.workspaceRoot,
      scanOptions,
    );
    const output = evidence.scopes.length > 0 ? "SUCCESS" : "EMPTY";

    return createUtilityResult(
      block,
      output,
      `${block.title} discovered ${evidence.scopes.length} scope(s).`,
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
    const registryPath = resolveScopeRegistryUtilityPath(
      utility,
      config.workspaceRoot,
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
  }
};

const executeSelectScopeUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
): Promise<RalphBlockExecutionResult> => {
  try {
    const flowAlias = getScopeRegistryFlowAlias(utility);
    const strategy = getScopeRegistryStrategy(utility);
    const registryPath = resolveScopeRegistryUtilityPath(
      utility,
      config.workspaceRoot,
    );
    const registry = await readRalphScopeRegistryFile(registryPath, {
      flowAlias,
      strategy,
    });
    const selectionOptions: Parameters<typeof selectRalphScopeFromRegistry>[1] = {
      strategy,
    };

    if (utility.forceNew !== undefined) {
      selectionOptions.forceNew = utility.forceNew;
    }

    const selection = selectRalphScopeFromRegistry(registry, selectionOptions);

    await writeRalphScopeRegistryFile(registryPath, selection.registry);

    if (!selection.scope) {
      return createUtilityResult(
        block,
        "EMPTY",
        `${block.title} did not find an active scope.`,
        { registryPath, registry: selection.registry },
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
        strategy,
        reusedCurrentScope: selection.reusedCurrentScope,
        cycleStarted: selection.cycleStarted,
        cycle: selection.registry.selection.cycle,
      },
      "completed",
    );
  } catch (error) {
    return createRalphBlockExecutionErrorResult(block, error);
  }
};

const executeMarkScopeResultUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
  context: RalphResultContext,
): Promise<RalphBlockExecutionResult> => {
  try {
    const flowAlias = getScopeRegistryFlowAlias(utility);
    const strategy = getScopeRegistryStrategy(utility);
    const registryPath = resolveScopeRegistryUtilityPath(
      utility,
      config.workspaceRoot,
    );
    const registry = await readRalphScopeRegistryFile(registryPath, {
      flowAlias,
      strategy,
    });
    const markOptions: Parameters<typeof markRalphScopeRegistryResult>[1] = {};

    if (utility.scopeId !== undefined) {
      markOptions.scopeId = utility.scopeId;
    }

    const outcome = utility.result ?? context.lastResult?.output;
    if (outcome !== undefined) {
      markOptions.outcome = outcome;
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
    pattern?: string;
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
      continue;
    }

    const matchesPattern =
      options.pattern === undefined ||
      entry.name.toLowerCase().includes(options.pattern.toLowerCase()) ||
      path.toLowerCase().includes(options.pattern.toLowerCase());
    const relativeFilePath = relative(options.basePath, path).replace(/\\/gu, "/");
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

    await searchFilesRecursive(
      rootPath,
      {
        basePath: rootPath,
        ...(utility.pattern ? { pattern: utility.pattern } : {}),
        ...(utility.glob ? { glob: globToRegExp(utility.glob) } : {}),
        maxResults:
          utility.maxResults ?? DEFAULT_RALPH_UTILITY_MAX_SEARCH_RESULTS,
        ...(signal ? { signal } : {}),
      },
      results,
    );

    const data = { rootPath, results, count: results.length };

    return createUtilityResult(
      block,
      results.length > 0 ? "SUCCESS" : "EMPTY",
      `${block.title} found ${results.length} file(s).`,
      data,
      results.length > 0 ? "completed" : "error",
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
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80) || "artifact";
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

const resolveUiAnalyzeTargetUrl = (utility: RalphUtilityConfig): string | undefined => {
  return utility.targetUrl?.trim() || utility.url?.trim() || undefined;
};

const isReadyHttpStatus = (status: number): boolean => {
  return (status >= 200 && status < 400) ||
    status === 400 ||
    status === 401 ||
    status === 402 ||
    status === 403;
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
  const { chromium } = await import("playwright-core");
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

const evaluateUiHeuristics = async (
  page: PlaywrightPage,
): Promise<RalphUiAnalyzeIssue[]> => {
  const issues = await page.evaluate(`(() => {
    const issues = [];
    const add = (severity, category, message, element) => {
      const selector = element && element.tagName
        ? element.tagName.toLowerCase() + (element.id ? "#" + element.id : "")
        : undefined;
      issues.push({ severity, category, message, ...(selector ? { selector } : {}) });
    };
    const body = document.body;
    if (!body || !body.innerText.trim()) {
      add("warning", "content", "Page body has no visible text.");
    }
    if (!document.querySelector("h1")) {
      add("info", "structure", "Page has no h1 heading.");
    }
    for (const image of Array.from(document.images)) {
      if (!image.getAttribute("alt")) {
        add("warning", "accessibility", "Image is missing alt text.", image);
      }
    }
    const namedControls = Array.from(document.querySelectorAll("button, a, input, textarea, select"));
    for (const element of namedControls) {
      const ariaLabel = element.getAttribute("aria-label") || element.getAttribute("aria-labelledby");
      const text = element.textContent || element.getAttribute("value") || element.getAttribute("placeholder") || "";
      if (!ariaLabel && !text.trim()) {
        add("warning", "accessibility", "Interactive element may not have an accessible name.", element);
      }
    }
    for (const input of Array.from(document.querySelectorAll("input, textarea, select"))) {
      const id = input.id;
      const hasLabel = Boolean(
        input.getAttribute("aria-label") ||
        input.getAttribute("aria-labelledby") ||
        (id && document.querySelector("label[for='" + CSS.escape(id) + "']")) ||
        input.closest("label")
      );
      if (!hasLabel) {
        add("warning", "accessibility", "Form control may be missing a label.", input);
      }
    }
    if (document.documentElement.scrollWidth > window.innerWidth + 2) {
      add("warning", "responsive", "Page has horizontal overflow.");
    }
    return issues.slice(0, ${MAX_RALPH_UI_ANALYZE_ISSUES});
  })()`);

  return Array.isArray(issues)
    ? issues.filter((issue): issue is RalphUiAnalyzeIssue => {
        return isRecord(issue) &&
          (issue.severity === "error" ||
            issue.severity === "warning" ||
            issue.severity === "info") &&
          typeof issue.category === "string" &&
          typeof issue.message === "string";
      })
    : [];
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

    const [title, visibleText, ariaSnapshot, issues] = await Promise.all([
      page.title(),
      page.locator("body").innerText({ timeout: timeoutMs }).catch(() => ""),
      checks.accessibility
        ? page
            .locator("body")
            .ariaSnapshot({ mode: "ai", depth: 8, timeout: timeoutMs })
            .catch((error: unknown) =>
              `ARIA snapshot unavailable: ${error instanceof Error ? error.message : String(error)}`,
            )
        : Promise.resolve(undefined),
      checks.responsive ? evaluateUiHeuristics(page) : Promise.resolve([]),
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
      issues,
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
    const result = await mcpClientManager.callTool(
      config.workspaceRoot,
      serverId,
      toolName,
      args,
      {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(block.settings?.mcp ? { configOverride: block.settings.mcp } : {}),
      },
    );
    const data: RalphUiAnalyzeData = {
      adapter: utility.adapter ?? "playwright-mcp",
      ...(targetUrl ? { targetUrl } : {}),
      ...(utility.screenshotPath ? { screenshotPath: utility.screenshotPath } : {}),
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
        ...(utility.screenshotPath ? { screenshotPath: utility.screenshotPath } : {}),
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

  if (serverMode === "managed") {
    return createUtilityResult(
      block,
      "UNAVAILABLE",
      `${block.title} server.mode=managed is not implemented; use an already-running server or MCP adapter.`,
      {
        adapter: "browser",
        targetUrl,
        server: { mode: serverMode, ready: false },
        viewports: [],
        artifacts: { screenshots: [] },
        issues: [],
        summary: `${block.title} did not start a managed server.`,
      } satisfies RalphUiAnalyzeData,
      "error",
    );
  }

  const timeoutMs = getUtilityTimeoutMs(
    utility,
    DEFAULT_RALPH_UI_ANALYZE_TIMEOUT_MS,
  );
  const healthUrl =
    serverMode === "none" ? undefined : utility.server?.healthUrl ?? targetUrl;
  const health = await checkUiAnalyzeServerReady(
    healthUrl,
    timeoutMs,
    options.signal,
  );

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

  let browser: PlaywrightBrowser | undefined;

  try {
    const launch = await launchUiAnalyzeBrowser();
    browser = launch.browser;
    const artifactDirectory = await createUiAnalyzeArtifactDirectory(
      config.workspaceRoot,
      options.runId,
      block.id,
    );
    const viewports: RalphUiAnalyzeViewportData[] = [];

    for (const viewport of getUiAnalyzeViewports(utility)) {
      viewports.push(
        await captureUiAnalyzeViewport(
          browser,
          targetUrl,
          viewport,
          utility,
          artifactDirectory,
          options.signal,
        ),
      );
    }

    const issues = viewports.flatMap((viewport) => [
      ...viewport.issues.map((issue) => ({ ...issue, viewport: viewport.name })),
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
    return executeUiAnalyzeMcpUtilityBlock(block, utility, config, context, options);
  }

  return executeUiAnalyzeBrowserUtilityBlock(block, utility, config, options);
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
    timeoutMs: getUtilityTimeoutMs(utility, DEFAULT_RALPH_UTILITY_COMMAND_TIMEOUT_MS),
    maxOutputBytes:
      utility.maxOutputBytes ?? DEFAULT_RALPH_UTILITY_RESPONSE_LIMIT_BYTES,
    ...(signal ? { signal } : {}),
  });
};

const maybeWriteJsonArtifact = async (
  path: string | undefined,
  workspaceRoot: string,
  value: unknown,
): Promise<string | undefined> => {
  if (!path?.trim()) {
    return undefined;
  }

  const resolvedPath = resolveWorkspaceContainedUtilityPath(path, workspaceRoot);
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
    const data = await collectUtilityGitChangeSnapshot(cwd, utility, config, signal);
    const outputPath = await maybeWriteJsonArtifact(
      utility.outputPath,
      config.workspaceRoot,
      data,
    );

    return createUtilityResult(block, "SUCCESS", `${block.title} captured git snapshot.`, {
      ...data,
      ...(outputPath ? { outputPath } : {}),
    });
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
    const data = await collectUtilityGitChangeSnapshot(cwd, utility, config, signal);
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

const extractStringListField = (
  value: unknown,
  field: string,
): string[] => {
  if (!isRecord(value) || !Array.isArray(value[field])) {
    return [];
  }

  return value[field].filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
};

const extractScopeGuardRules = (
  input: unknown,
): { paths: string[]; globs: string[] } => {
  const source = isRecord(input) && isRecord(input.scope) ? input.scope : input;
  const extraSource = isRecord(input) && isRecord(input.scope) ? input : undefined;

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

const normalizeScopeGuardChangedFiles = (
  files: readonly string[],
  workspaceRoot: string,
): string[] => {
  return files
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => normalizeWorkspaceRelativePath(path, workspaceRoot))
    .filter((path, index, all) => all.indexOf(path) === index);
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
        typeof entry.indexStatus === "string" ? entry.indexStatus : status[0] ?? "?";
      const worktreeStatus =
        typeof entry.worktreeStatus === "string" ? entry.worktreeStatus : status[1] ?? "?";
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

  return normalizeScopeGuardChangedFiles(
    [
      ...extractStringListField(value, "changedFiles"),
      ...extractStringListField(value, "diffFiles"),
      ...extractStringListField(value, "stagedDiffFiles"),
    ],
    workspaceRoot,
  ).map((path) => ({
    path,
    status: "??",
    indexStatus: "?",
    worktreeStatus: "?",
    staged: false,
    unstaged: false,
    untracked: true,
    deleted: false,
    signature: `legacy-path=${path}`,
  }));
};

interface ScopeGuardBaseline {
  files: RalphGitChangedFileSnapshot[];
  source: "configured" | "implicit";
  blockId?: string;
}

const isGitSnapshotBaselineCandidate = (
  result: RalphBlockExecutionResult,
): boolean => {
  if (!isRecord(result.data)) {
    return false;
  }

  const outputPath =
    typeof result.data.outputPath === "string"
      ? result.data.outputPath.toLowerCase()
      : "";

  return (
    Array.isArray(result.data.files) &&
    typeof result.data.capturedAt === "string" &&
    (
      result.blockId.toLowerCase().includes("snapshot") ||
      outputPath.includes("snapshot")
    )
  );
};

const extractImplicitScopeGuardBaseline = (
  context: RalphResultContext,
  workspaceRoot: string,
): ScopeGuardBaseline | undefined => {
  const results = Array.from(context.resultsByBlock.values()).reverse();

  for (const result of results) {
    if (!isGitSnapshotBaselineCandidate(result)) {
      continue;
    }

    const files = extractGitSummaryFiles(result.data, workspaceRoot);

    if (files.length > 0) {
      return { files, source: "implicit", blockId: result.blockId };
    }
  }

  return undefined;
};

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

  return extractImplicitScopeGuardBaseline(context, workspaceRoot);
};

const doesPathMatchScopeGuard = (
  filePath: string,
  allowedPaths: readonly string[],
  allowedGlobs: readonly string[],
  workspaceRoot: string,
): boolean => {
  const normalizedAllowedPaths = allowedPaths.map((allowedPath) =>
    normalizeWorkspaceRelativePath(allowedPath, workspaceRoot).replace(/\/+$/u, ""),
  );
  const normalizedAllowedGlobs = allowedGlobs.map((allowedGlob) =>
    normalizeWorkspaceRelativePath(allowedGlob, workspaceRoot),
  );

  if (normalizedAllowedPaths.includes(".") || normalizedAllowedPaths.includes("")) {
    return true;
  }

  const pathMatched = normalizedAllowedPaths.some((normalized) =>
    (
      filePath === normalized ||
      filePath.startsWith(`${normalized}/`) ||
      (normalized.includes("*") && globToRegExp(normalized).test(filePath))
    )
  );

  if (pathMatched) {
    return true;
  }

  return normalizedAllowedGlobs.some((glob) => globToRegExp(glob).test(filePath));
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
    const snapshot = await collectUtilityGitChangeSnapshot(cwd, utility, config, signal);
    const changedFileEntries = snapshot.files;
    const changedFiles = changedFileEntries.map((file) => file.path);

    if (changedFiles.length === 0) {
      return createUtilityResult(
        block,
        "EMPTY",
        `${block.title} found no changed files.`,
        { cwd, changedFiles },
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
        },
        "completed",
      );
    }

    const rules = extractScopeGuardRules(extractScopeGuardInput(utility, context));

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
    const output = outOfScopeFiles.length > 0 ? "OUT_OF_SCOPE" : "IN_SCOPE";

    return createUtilityResult(
      block,
      output,
      outOfScopeFiles.length > 0
        ? `${block.title} found ${outOfScopeFiles.length} out-of-scope file(s).`
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
        outOfScopeFiles,
        files: changedFileEntries,
        allowedPaths: rules.paths,
        allowedGlobs: rules.globs,
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
): string => {
  const packageManager = typeof packageJson.packageManager === "string"
    ? packageJson.packageManager.split("@")[0]
    : undefined;

  if (packageManager) {
    return packageManager;
  }

  if (existsSync(join(rootPath, "pnpm-lock.yaml"))) {
    return "pnpm";
  }

  if (existsSync(join(rootPath, "yarn.lock"))) {
    return "yarn";
  }

  if (existsSync(join(rootPath, "package-lock.json"))) {
    return "npm";
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

const executeDetectProjectCommandsUtilityBlock = async (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  config: RuntimeConfig,
): Promise<RalphBlockExecutionResult> => {
  const rootPath = resolveUtilityPath(
    utility.rootPath?.trim() || utility.cwd,
    config.workspaceRoot,
  );

  try {
    const manifests: string[] = [];
    const commands: Array<{
      kind: "typecheck" | "lint" | "test" | "build" | "format";
      command: string;
      source: string;
      confidence: "high" | "medium";
    }> = [];
    const packageJsonPath = join(rootPath, "package.json");

    if (existsSync(packageJsonPath)) {
      const packageJson = await readJsonFile(packageJsonPath);
      if (isRecord(packageJson)) {
        manifests.push("package.json");
        const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {};
        const packageManager = getPackageManagerCommand(rootPath, packageJson);

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
      }
    }

    if (existsSync(join(rootPath, "Cargo.toml"))) {
      manifests.push("Cargo.toml");
      commands.push(
        { kind: "build", command: "cargo build", source: "Cargo.toml", confidence: "high" },
        { kind: "test", command: "cargo test", source: "Cargo.toml", confidence: "high" },
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
        { kind: "test", command: "go test ./...", source: "go.mod", confidence: "high" },
        { kind: "build", command: "go build ./...", source: "go.mod", confidence: "high" },
      );
    }

    const verificationCommand = commands
      .filter((entry) =>
        entry.kind === "typecheck" ||
        entry.kind === "lint" ||
        entry.kind === "test"
      )
      .map((entry) => entry.command)
      .filter((command, index, all) => all.indexOf(command) === index)
      .join(" && ");
    const data = {
      rootPath,
      manifests,
      commands,
      verificationCommand,
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

      return `- ${String(entry.blockId ?? "unknown")}: ${String(entry.output ?? "")} - ${String(entry.summary ?? "")}`;
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
    const blockResults = Array.from(context.resultsByBlock.values()).map((result) => ({
      blockId: result.blockId,
      output: result.output,
      status: result.status,
      summary: result.summary,
      error: result.error,
    }));
    const report = {
      flowId: flow.id,
      flowName: flow.name,
      runId: context.runId,
      generatedAt: new Date().toISOString(),
      variables: context.variables,
      lastResult: context.lastResult,
      blockResults,
      runLog: context.runLog,
    };
    const jsonPath = await maybeWriteJsonArtifact(
      utility.path,
      config.workspaceRoot,
      report,
    );
    const markdownPath = utility.markdownPath ?? utility.outputPath;
    let resolvedMarkdownPath: string | undefined;

    if (markdownPath?.trim()) {
      resolvedMarkdownPath = resolveWorkspaceContainedUtilityPath(
        markdownPath,
        config.workspaceRoot,
      );
      await mkdir(dirname(resolvedMarkdownPath), { recursive: true });
      await writeFile(
        resolvedMarkdownPath,
        createFinalReportMarkdown(flow, block, report),
        "utf8",
      );
    }

    return createUtilityResult(block, "SUCCESS", `${block.title} wrote report.`, {
      ...report,
      ...(jsonPath ? { jsonPath } : {}),
      ...(resolvedMarkdownPath ? { markdownPath: resolvedMarkdownPath } : {}),
    });
  } catch (error) {
    return createRalphBlockExecutionErrorResult(block, error);
  }
};

const executeSetVariableUtilityBlock = (
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  context: RalphResultContext,
): RalphBlockExecutionResult => {
  const name = utility.variableName?.trim();

  if (!name) {
    return createUtilityResult(block, "SUCCESS", `${block.title} had no variable.`, {});
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
      `"use strict"; return (${utility.expression ?? "input"});`,
    ) as (
      input: unknown,
      variables: Record<string, string>,
      lastResult: RalphBlockExecutionResult | undefined,
    ) => unknown;
    const output = evaluator(input, context.variables, context.lastResult);

    return createUtilityResult(block, "SUCCESS", `${block.title} transformed JSON.`, {
      input,
      output,
    });
  } catch (error) {
    return createRalphBlockExecutionErrorResult(block, error);
  }
};

interface JsonSchemaValidationResult {
  valid: boolean;
  errors: string[];
}

const validateJsonAgainstSchema = (
  value: unknown,
  schema: unknown,
  path = "$",
): JsonSchemaValidationResult => {
  if (!isRecord(schema)) {
    return { valid: true, errors: [] };
  }

  const errors: string[] = [];
  const type = typeof schema.type === "string" ? schema.type : undefined;

  if (type) {
    const actualType = Array.isArray(value) ? "array" : typeof value;
    if (actualType !== type) {
      errors.push(`${path} expected ${type}, got ${actualType}.`);
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path} is not in enum.`);
  }

  if (Array.isArray(schema.required) && isRecord(value)) {
    for (const key of schema.required) {
      if (typeof key === "string" && !Object.hasOwn(value, key)) {
        errors.push(`${path}.${key} is required.`);
      }
    }
  }

  if (isRecord(schema.properties) && isRecord(value)) {
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key)) {
        const nested = validateJsonAgainstSchema(
          value[key],
          propertySchema,
          `${path}.${key}`,
        );
        errors.push(...nested.errors);
      }
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((entry, index) => {
      const nested = validateJsonAgainstSchema(entry, schema.items, `${path}[${index}]`);
      errors.push(...nested.errors);
    });
  }

  return { valid: errors.length === 0, errors };
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

const createPromptJsonTask = (
  flow: RalphFlow,
  block: RalphUtilityBlock,
  utility: RalphUtilityConfig,
  context: RalphResultContext,
  repairFeedback: string | undefined,
): string => {
  const schemaText = utility.schema === undefined
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
    ...(repairFeedback ? ["", "Previous JSON validation failed:", repairFeedback] : []),
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
    return createUtilityResult(block, "ERROR", "Prompt JSON utility requires prompt.");
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
              strict: true,
            },
          };

    logBlockInput(options.logger, flow, block, config, task, attempt);

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

      const json = parseJsonFromText(lastText);
      const validation = validateUtilityJsonValue(json, utility.schema);
      lastValidation = validation;

      if (!validation.valid) {
        repairFeedback = validation.errors.join("\n");
        continue;
      }

      const outputPath = await maybeWriteJsonArtifact(
        utility.outputPath,
        config.workspaceRoot,
        json,
      );

      return withRalphBlockProgress(
        createUtilityResult(block, "SUCCESS", `${block.title} produced JSON.`, {
          output: json,
          validation,
          attempts: attempt,
          ...(outputPath ? { outputPath } : {}),
        }),
        progressEvents,
      );
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
    }
  }

  return withRalphBlockProgress(
    createUtilityResult(
      block,
      "INVALID",
      `${block.title} did not produce schema-valid JSON.`,
      {
        raw: lastText,
        validation: lastValidation ?? { valid: false, errors: ["No JSON parsed."] },
      },
    ),
    progressEvents,
  );
};

const RALPH_VALIDATOR_JSON_SCHEMA = {
  type: "object",
  required: ["decision", "confidence", "summary", "evidence", "remainingWork"],
  properties: {
    decision: {
      type: "string",
      enum: ["DONE", "CONTINUE", "RETRY", "ERROR"],
    },
    confidence: { type: "string" },
    summary: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    remainingWork: { type: "array", items: { type: "string" } },
  },
};

const isRalphValidatorJsonDecision = (
  value: unknown,
): value is RalphValidatorDecision => {
  return (
    value === "DONE" ||
    value === "CONTINUE" ||
    value === "RETRY" ||
    value === "ERROR"
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
  const output = isRecord(data.output) ? data.output : {};
  const decision = typeof output.decision === "string"
    ? output.decision.toUpperCase()
    : undefined;

  if (!isRalphValidatorJsonDecision(decision)) {
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

  return withRalphBlockProgress(
    createUtilityResult(
      block,
      decision,
      typeof output.summary === "string"
        ? output.summary
        : `${block.title} returned ${decision}.`,
      {
        output,
        decision,
        confidence: output.confidence,
        evidence: output.evidence,
        remainingWork: output.remainingWork,
      },
      decision === "ERROR" ? "error" : "completed",
    ),
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
  const blockConfig = createBlockConfig(config, block);
  const utility = resolveUtilityConfig(block.utility, context);
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
      return executeFetchUtilityBlock(block, utility, context, blockConfig, options);
    case "POLL":
      return executePollUtilityBlock(block, utility, context, blockConfig, options);
    case "CONDITION":
      return executeConditionUtilityBlock(block, utility, context);
    case "RUN_COMMAND":
      return executeCommandUtilityBlock(block, utility, blockConfig, false, options.signal);
    case "RUN_CHECK":
      return executeCommandUtilityBlock(block, utility, blockConfig, true, options.signal);
    case "UI_ANALYZE":
      return executeUiAnalyzeUtilityBlock(block, utility, blockConfig, context, options);
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
      return executeAppendJsonlUtilityBlock(block, utility, blockConfig, context);
    case "READ_JSONL":
      return executeReadJsonlUtilityBlock(block, utility, blockConfig);
    case "QUERY_JSONL":
      return executeQueryJsonlUtilityBlock(block, utility, blockConfig, context);
    case "FILE_EXISTS":
      return executeFileExistsUtilityBlock(block, utility, blockConfig);
    case "DELETE_FILE":
      return executeDeleteFileUtilityBlock(block, utility, blockConfig);
    case "MOVE_FILE":
      return executeMoveFileUtilityBlock(block, utility, blockConfig);
    case "ARCHIVE_FILE":
      return executeArchiveFileUtilityBlock(block, utility, blockConfig);
    case "LOOP_COUNTER":
      return executeLoopCounterUtilityBlock(block, utility, blockConfig, context);
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
    case "SELECT_JSON_TASK":
      return executeSelectJsonTaskUtilityBlock(block, utility, blockConfig);
    case "MARK_JSON_TASK":
      return executeMarkJsonTaskUtilityBlock(block, utility, blockConfig, context);
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
    case "SELECT_SCOPE":
      return executeSelectScopeUtilityBlock(block, utility, blockConfig);
    case "MARK_SCOPE_RESULT":
      return executeMarkScopeResultUtilityBlock(
        block,
        utility,
        blockConfig,
        context,
      );
    case "SEARCH_FILES":
      return executeSearchFilesUtilityBlock(block, utility, blockConfig, options.signal);
    case "GIT_STATUS":
      return executeGitStatusUtilityBlock(block, utility, blockConfig, options.signal);
    case "GIT_SNAPSHOT":
      return executeGitSnapshotUtilityBlock(block, utility, blockConfig, options.signal);
    case "GIT_DIFF_SUMMARY":
      return executeGitDiffSummaryUtilityBlock(
        block,
        utility,
        blockConfig,
        options.signal,
      );
    case "DETECT_PROJECT_COMMANDS":
      return executeDetectProjectCommandsUtilityBlock(block, utility, blockConfig);
    case "SET_VARIABLE":
      return executeSetVariableUtilityBlock(block, utility, context);
    case "TRANSFORM_JSON":
      return executeTransformJsonUtilityBlock(block, utility, context);
    case "VALIDATE_JSON":
      return executeValidateJsonUtilityBlock(block, utility, context);
    case "FINAL_REPORT":
      return executeFinalReportUtilityBlock(flow, block, utility, blockConfig, context);
    case "NOTIFY":
      return createUtilityResult(block, "SUCCESS", utility.message ?? block.title, {
        message: utility.message ?? block.title,
      });
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

    const discovery = loadMcpDiscoveryCacheSync(workspaceRoot).servers[server.id];
    const tool = discovery?.tools.find((candidate) => candidate.name === toolName);

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
  const blockConfig = createBlockConfig(config, block);
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
    const result = await mcpClientManager.callTool(
      blockConfig.workspaceRoot,
      serverId,
      toolName,
      argumentsValue,
      createRalphMcpOperationOptions(block, context, options, "tool", readOnly),
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
  const blockConfig = createBlockConfig(config, block);
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
    const result = await mcpClientManager.readResource(
      blockConfig.workspaceRoot,
      serverId,
      uri,
      createRalphMcpOperationOptions(block, context, options, "resource"),
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
  const blockConfig = createBlockConfig(config, block);
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
    const result = await mcpClientManager.getPrompt(
      blockConfig.workspaceRoot,
      serverId,
      promptName,
      argumentsValue,
      createRalphMcpOperationOptions(block, context, options, "prompt"),
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
      return executePromptBlock(flow, block, config, customizations, context, options);
    case "VALIDATOR":
      return executeValidatorBlock(flow, block, config, customizations, context, options);
    case "DECISION":
      return executeDecisionBlock(flow, block, config, customizations, context, options);
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
      return executeInterviewBlock(flow, block, config, customizations, context, options);
    case "UTILITY":
      return executeUtilityBlock(flow, block, config, customizations, context, options);
    case "MCP_TOOL":
      return executeMcpToolBlock(block, config, context, options);
    case "MCP_RESOURCE":
      return executeMcpResourceBlock(block, config, context, options);
    case "MCP_PROMPT":
      return executeMcpPromptBlock(block, config, context, options);
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
    case "END":
      return {
        blockId: block.id,
        output: "SUCCESS",
        status: "skipped",
        attempt: 1,
        summary: `Reached ${block.title}.`,
      };
  }
};

const getValidatorGroupStart = (
  flow: RalphFlow,
  validatorBlockId: string,
): string | undefined => {
  const validatorIndex = flow.blocks.findIndex((block) => block.id === validatorBlockId);

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
  context.lastResult = result;
  context.resultsByBlock.set(result.blockId, result);
  context.runLog.push(`${result.blockId}: ${result.output} - ${result.summary}`);
};

const getRunStatusForEndBlock = (block: RalphEndBlock): RalphRunStatus => {
  const normalizedEndIdentity = `${block.id} ${block.title}`.toLowerCase();

  if (
    (block.status === undefined || block.status === "success") &&
    /\b(blocked|failed|failure|error)\b/u.test(normalizedEndIdentity)
  ) {
    return "blocked";
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
  "OUT_OF_SCOPE",
  "TIMEOUT",
  "HTTP_ERROR",
]);

const isRecoverableRalphBlockResult = (
  block: RalphFlowBlock,
  result: RalphBlockExecutionResult,
): boolean => {
  return block.type !== "END" &&
    (result.status === "error" || RECOVERABLE_RALPH_OUTPUTS.has(result.output));
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

export const runRalphFlow = async (
  flow: RalphFlow,
  config: RuntimeConfig,
  customizations: CustomizationDiscoveryResult,
  options: RalphRunOptions = {},
): Promise<RalphRunResult> => {
  const logger = options.logger;
  const runId = logger?.runId ?? options.runId ?? `ralph-${flow.id}-${randomUUID()}`;
  const startedAt = createLogTimestamp();
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
  const variables = discoverRalphFlowVariables(flow);
  const checkpoint = options.checkpoint;
  const variableNames = new Set(variables.map((variable) => variable.name));
  const suppliedVariableValues = checkpoint
    ? Object.fromEntries(
        Object.entries({
          ...(options.variableValues ?? {}),
          ...checkpoint.variables,
        }).filter(([name]) => variableNames.has(name)),
      )
    : options.variableValues;
  const resolvedVariables = resolveVariableValues(variables, suppliedVariableValues);
  const validation = validateRalphFlow(flow, {
    config,
    variableValues: resolvedVariables.values,
  });
  const finishRun = async (result: RalphRunResult): Promise<RalphRunResult> => {
    const finishedAt =
      result.status === "waiting-for-input" ? undefined : createLogTimestamp();
    const runResult: RalphRunResult = {
      ...result,
      runId,
      startedAt,
      ...(finishedAt ? { finishedAt } : {}),
    };
    logger?.simple({
      kind: "run-end",
      message: result.summary,
      flowId: flow.id,
      flowName: flow.name,
      provider: config.provider,
      model: config.model,
      status: result.status,
    });
    logger?.trace({
      kind: "run-end",
      message: result.summary,
      flowId: flow.id,
      provider: config.provider,
      model: config.model,
      details: runResult,
    });
    await logger?.flush();

    return runResult;
  };

  if (resolvedVariables.unknown.length > 0) {
    return finishRun(createBlockedRunResult(
      flow,
      validation,
      `Unknown Ralph variable(s): ${resolvedVariables.unknown.join(", ")}.`,
      [],
      resolvedVariables.unknown,
    ));
  }

  if (resolvedVariables.missing.length > 0) {
    return finishRun(createBlockedRunResult(
      flow,
      validation,
      `Missing Ralph variable(s): ${resolvedVariables.missing.join(", ")}.`,
      resolvedVariables.missing,
    ));
  }

  if (!validation.valid) {
    return finishRun(createBlockedRunResult(
      flow,
      validation,
      `Ralph flow is invalid: ${validation.errors.join(" ")}`,
    ));
  }

  const blockMap = getRalphBlockById(flow);
  const start = flow.blocks.find((block): block is RalphStartBlock => block.type === "START");
  if (!start) {
    return finishRun(
      createBlockedRunResult(flow, validation, "Ralph flow has no START block."),
    );
  }

  const events: RalphRunEvent[] = checkpoint ? [...checkpoint.events] : [];
  const blockResults: RalphBlockExecutionResult[] = checkpoint
    ? [...checkpoint.blockResults]
    : [];
  const resultContext: RalphResultContext = {
    runId,
    resultsByBlock: restoreRalphResultMap(checkpoint),
    runLog: checkpoint ? [...checkpoint.runLog] : [],
    variables: {
      ...resolvedVariables.values,
      ...(checkpoint?.variables ?? {}),
    },
    interviewStates: new Map(Object.entries(checkpoint?.interviewStates ?? {})),
  };
  const errorCounts = restoreRalphNumberMap(checkpoint?.errorCounts);
  const repeatedFailures = restoreRalphRepeatedFailureMap(checkpoint?.repeatedFailures);
  let currentBlockId: string | undefined = checkpoint?.currentBlockId ?? start.id;
  let transitions = checkpoint?.transitions ?? 0;
  const maxTransitions =
    options.maxTransitions === null
      ? null
      : options.maxTransitions ?? flow.settings?.maxTransitions;
  const repeatedFailureLimit =
    options.repeatedFailureLimit === null
      ? null
      : options.repeatedFailureLimit ?? DEFAULT_RALPH_REPEATED_FAILURE_LIMIT;
  let lastRecoverableCheckpoint: RalphRunCheckpoint | undefined;

  while (currentBlockId) {
    if (options.signal?.aborted) {
      const summary = "Ralph run stopped.";
      await emitRunEvent(events, { type: "end", blockId: currentBlockId, status: "stopped", summary }, options.onEvent);
      return finishRun({
        flow: flow.id,
        status: "stopped",
        summary,
        events,
        blockResults,
        missingVariables: [],
        unknownVariables: [],
        validation,
      });
    }

    if (maxTransitions !== null && maxTransitions !== undefined) {
      if (transitions >= maxTransitions) {
        const summary = `Ralph flow reached maxTransitions (${maxTransitions}).`;
        await emitRunEvent(
          events,
          { type: "crash", blockId: currentBlockId, output: "ERROR", reason: summary },
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
        });
      }
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

    const attempt = (errorCounts.get(block.id) ?? 0) + 1;
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

    const stepResult = await executeBlock(
      flow,
      block,
      config,
      customizations,
      resultContext,
      options,
    );

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

      const runCheckpoint = createRunCheckpoint(
        block.id,
        transitions,
        resultContext,
        blockResults,
        events,
        errorCounts,
        repeatedFailures,
        stepResult.request,
      );

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

    const result = stepResult;
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

    blockResults.push(result);
    updateResultContext(resultContext, result);
    const blockDurationMs = Date.now() - blockStartedAt;
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
        nextFailureState.count >= repeatedFailureLimit
      ) {
        const summary =
          `Ralph flow stopped at \`${block.id}\` after ${nextFailureState.count} identical non-success result(s): ${result.summary}`;
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
          checkpoint: createRunCheckpoint(
            block.id,
            transitions,
            resultContext,
            blockResults,
            events,
            errorCounts,
            repeatedFailures,
          ),
        });
      }
    } else {
      repeatedFailures.delete(block.id);
    }

    if (isRecoverableRalphBlockResult(block, result)) {
      lastRecoverableCheckpoint = createRunCheckpoint(
        block.id,
        transitions,
        resultContext,
        blockResults,
        events,
        errorCounts,
        repeatedFailures,
      );
    }

    if (block.type === "END") {
      const status = getRunStatusForEndBlock(block);
      const summary = `Ralph flow \`${flow.name}\` ended at \`${block.id}\`.`;
      await emitRunEvent(
        events,
        { type: "end", blockId: block.id, status, summary },
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
        ...(status === "blocked" && lastRecoverableCheckpoint
          ? { checkpoint: lastRecoverableCheckpoint }
          : {}),
      });
    }

    if (result.output === "ERROR") {
      const nextErrorCount = (errorCounts.get(block.id) ?? 0) + 1;
      errorCounts.set(block.id, nextErrorCount);
      const hasExplicitErrorRoute = Boolean(
        findOutgoingRalphEdge(flow, block.id, "ERROR"),
      );
      const retryDecision = resolveRalphRetryDecision({
        block,
        currentErrorCount: nextErrorCount,
        hasExplicitErrorRoute,
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
        await delay(retryDecision.delaySeconds, options.signal);
        transitions += 1;
        continue;
      }
    }

    const edge = findOutgoingRalphEdge(flow, block.id, result.output);
    let nextBlockId = edge?.to;

    if (block.type === "VALIDATOR" && result.output === "RETRY" && !nextBlockId) {
      nextBlockId = getValidatorGroupStart(flow, block.id);
    }

    if (!nextBlockId) {
      const summary = `Ralph flow crashed at \`${block.id}\`: no edge handles output ${result.output}.`;
      await emitRunEvent(
        events,
        { type: "crash", blockId: block.id, output: result.output, reason: summary },
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
      errorCounts.clear();
    }

    await emitRunEvent(
      events,
      {
        type: "edge-route",
        from: block.id,
        output: result.output,
        to: nextBlockId,
        ...(edge ? { edgeId: edge.id } : {}),
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

    currentBlockId = nextBlockId;
    transitions += 1;
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
