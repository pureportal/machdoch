import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { normalizeOptionalString } from "../helpers/normalize-optional-string.helper.js";
import {
  FLOW_FILE_EXTENSION,
  normalizeFlowAlias,
  normalizeFlowFileName,
  normalizeFlowId,
  normalizeRevisionId,
  normalizeRunId,
} from "./_helpers/ralph-flow-ids.helper.js";
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
import { getUserConfigPath } from "./env.js";
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

const RALPH_WORKSPACE_DIRECTORY = ".machdoch/ralph";
const RALPH_USER_DIRECTORY = "ralph";
const RALPH_FLOW_SUBDIRECTORY = "flows";
const RALPH_RUN_SUBDIRECTORY = "runs";
const RALPH_REVISION_SUBDIRECTORY = "revisions";
const RALPH_ARTIFACT_SUBDIRECTORY = "artifacts";
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
export type RalphFlowScope = "workspace" | "user";
export type RalphValidatorDecision = "DONE" | "CONTINUE" | "RETRY" | "ERROR";
export type RalphExecutionOutput = "SUCCESS" | "ERROR" | RalphValidatorDecision | string;

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
export type RalphRunStatus = "completed" | "crashed" | "blocked" | "stopped";
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
  maxAttempts?: number | null;
  condition?: RalphUtilityCondition;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  outputPath?: string;
  path?: string;
  rootPath?: string;
  content?: string;
  append?: boolean;
  encoding?: BufferEncoding;
  pattern?: string;
  glob?: string;
  maxResults?: number;
  command?: string;
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
  expression?: string;
  schema?: unknown;
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
  locked?: boolean;
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

export interface RalphFlow {
  schemaVersion: typeof RALPH_FLOW_SCHEMA_VERSION;
  id: string;
  alias?: string;
  name: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
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
  data?: unknown;
  summary: string;
  markdown?: string;
  error?: string;
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

export interface RalphRunLogPaths {
  id: string;
  directory: string;
  recordPath: string;
  simpleJsonlPath: string;
  simpleMarkdownPath: string;
  traceJsonlPath: string;
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
}

export interface RalphRunRecordBlock {
  blockId: string;
  output: RalphExecutionOutput;
  status: RalphBlockExecutionResult["status"];
  attempt: number;
  task?: string;
  executionStatus?: TaskExecutionResult["status"];
  data?: unknown;
  summary: string;
  markdown?: string;
  error?: string;
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
}

interface RalphRepeatedFailureState {
  signature: string;
  count: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export const getRalphFlowDirectory = (workspaceRoot: string): string => {
  return getRalphFlowStorageDirectory(workspaceRoot, "workspace");
};

export const getUserRalphDirectory = (): string => {
  return join(dirname(getUserConfigPath()), RALPH_USER_DIRECTORY);
};

export const getRalphStorageDirectory = (
  workspaceRoot: string,
  scope: RalphFlowScope = "workspace",
): string => {
  return scope === "user"
    ? getUserRalphDirectory()
    : join(workspaceRoot, RALPH_WORKSPACE_DIRECTORY);
};

export const getRalphFlowStorageDirectory = (
  workspaceRoot: string,
  scope: RalphFlowScope = "workspace",
): string => {
  return join(getRalphStorageDirectory(workspaceRoot, scope), RALPH_FLOW_SUBDIRECTORY);
};

export const getRalphRunDirectory = (
  workspaceRoot: string,
  scope: RalphFlowScope = "workspace",
): string => {
  return join(getRalphStorageDirectory(workspaceRoot, scope), RALPH_RUN_SUBDIRECTORY);
};

export const getRalphArtifactDirectory = (workspaceRoot: string): string => {
  return join(getRalphStorageDirectory(workspaceRoot, "workspace"), RALPH_ARTIFACT_SUBDIRECTORY);
};

export const getRalphRevisionDirectory = (
  workspaceRoot: string,
  flowId: string,
  scope: RalphFlowScope = "workspace",
): string => {
  return join(
    getRalphStorageDirectory(workspaceRoot, scope),
    RALPH_REVISION_SUBDIRECTORY,
    normalizeFlowId(flowId),
  );
};

export const getRalphRevisionPath = (
  workspaceRoot: string,
  flowId: string,
  revisionId: string,
  scope: RalphFlowScope = "workspace",
): string => {
  return join(
    getRalphRevisionDirectory(workspaceRoot, flowId, scope),
    `${normalizeRevisionId(revisionId)}${FLOW_FILE_EXTENSION}`,
  );
};

export const getRalphFlowPath = (
  workspaceRoot: string,
  id: string,
  scope: RalphFlowScope = "workspace",
): string => {
  return join(getRalphFlowStorageDirectory(workspaceRoot, scope), normalizeFlowFileName(id));
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

const createRalphRevisionFilePath = (
  revisionDirectory: string,
  timestamp: string,
): string => {
  const baseName = timestamp.replace(/[:.]/gu, "-");
  let candidatePath = join(revisionDirectory, `${baseName}.json`);
  let suffix = 1;

  while (existsSync(candidatePath)) {
    candidatePath = join(revisionDirectory, `${baseName}-${suffix}.json`);
    suffix += 1;
  }

  return candidatePath;
};

const createRalphRunArtifactPaths = (
  runDirectory: string,
  timestamp: string,
  preferredId?: string,
): RalphRunLogPaths => {
  const baseName = preferredId
    ? normalizeRunId(preferredId)
    : timestamp.replace(/[:.]/gu, "-");
  let id = baseName;
  let candidateDirectory = join(runDirectory, id);
  let suffix = 1;

  while (existsSync(candidateDirectory)) {
    id = `${baseName}-${suffix}`;
    candidateDirectory = join(runDirectory, id);
    suffix += 1;
  }

  return {
    id,
    directory: candidateDirectory,
    recordPath: join(candidateDirectory, "run.json"),
    simpleJsonlPath: join(candidateDirectory, "simple.jsonl"),
    simpleMarkdownPath: join(candidateDirectory, "simple.md"),
    traceJsonlPath: join(candidateDirectory, "trace.jsonl"),
  };
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
  const flow = await readRalphFlowFile(
    getRalphFlowPath(workspaceRoot, id, options.scope ?? "workspace"),
  );
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
    scope?: RalphFlowScope;
  } = {},
): Promise<RalphRunLogger> => {
  const createdAt = createLogTimestamp();
  const paths = createRalphRunArtifactPaths(
    getRalphRunDirectory(workspaceRoot, options.scope ?? "workspace"),
    createdAt,
    options.runId,
  );
  const logger = new RalphFileRunLogger(paths);

  await mkdir(paths.directory, { recursive: true });
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
  logger.trace({
    kind: "run-start",
    message: `Ralph run ${paths.id} created.`,
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

const createExecutionOptions = async (
  options: RalphExecutionOptionsSource,
  config: RuntimeConfig,
  context?: RalphResultContext,
  block?: RalphFlowBlock,
  conversationContext?: TaskConversationContext,
): Promise<TaskExecutionOptions> => {
  const runId = context?.runId ?? options.runId;
  const fallbackContext: RalphResultContext = {
    runId: runId ?? "ralph-unscoped",
    resultsByBlock: new Map(),
    runLog: [],
    variables: {},
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
  const onStateChange: TaskExecutionProgressHandler | undefined =
    baseOnStateChange || logger
      ? async (progress) => {
          logger?.trace({
            kind: "progress",
            message: progress.message,
            ...(block
              ? {
                  blockId: block.id,
                  blockTitle: block.title,
                  blockType: block.type,
                }
              : {}),
            provider: config.provider,
            model: config.model,
            details: progress,
          });
          await baseOnStateChange?.(progress);
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
        void baseOnStateChange?.({
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
        });
      }
    : undefined;

  return {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(runId ? { runId } : {}),
    ...(onStateChange ? { onStateChange } : {}),
    ...(onActionOutput ? { onActionOutput } : {}),
    ...(conversationContext ? { conversationContext } : {}),
    ...(block?.settings?.timeoutSeconds
      ? { maxDurationMs: block.settings.timeoutSeconds * 1000 }
      : {}),
    ...(imageInputs.length > 0 ? { imageInputs } : {}),
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
  const conversationContext: TaskConversationContext = {
    ...(options.conversationContext ?? { history: [] }),
    history: [...(options.conversationContext?.history ?? [])],
  };

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const task = createPromptTask(flow, block, context);
    logBlockInput(options.logger, flow, block, blockConfig, task, iteration);
    try {
      const executionOptions = await createExecutionOptions(
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
      return createRalphBlockExecutionErrorResult(block, error, iteration);
    }

    conversationContext.history.push({ role: "user", content: task });
    conversationContext.history.push({
      role: "assistant",
      content: getResultMarkdown(result),
    });

    if (result.status !== "executed") {
      return createRalphPromptExecutionResult(block, result, iteration);
    }
  }

  return createRalphPromptExecutionResult(block, result, maxIterations);
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

  try {
    result = await executeTask(
      task,
      blockConfig,
      customizations,
      await createExecutionOptions(
        options,
        blockConfig,
        context,
        block,
        options.conversationContext,
      ),
    );
  } catch (error) {
    return createRalphBlockExecutionErrorResult(block, error);
  }

  return createRalphValidatorExecutionResult(block, result);
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

  try {
    result = await executeTask(
      task,
      blockConfig,
      customizations,
      await createExecutionOptions(
        options,
        blockConfig,
        context,
        block,
        options.conversationContext,
      ),
    );
  } catch (error) {
    return createRalphBlockExecutionErrorResult(block, error);
  }

  return createRalphDecisionExecutionResult(block, result);
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

  while (
    utility.maxAttempts === null ||
    utility.maxAttempts === undefined ||
    attempt <= utility.maxAttempts
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
    `${block.title} did not match after ${utility.maxAttempts} attempt(s).`,
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
  const command = utility.command?.trim();

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

const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
};

const globToRegExp = (glob: string): RegExp => {
  const pattern = glob
    .split(/([*?])/u)
    .map((part) => {
      if (part === "*") {
        return ".*";
      }

      if (part === "?") {
        return ".";
      }

      return escapeRegExp(part);
    })
    .join("");

  return new RegExp(`^${pattern}$`, "iu");
};

const searchFilesRecursive = async (
  rootPath: string,
  options: {
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
    const matchesGlob = options.glob === undefined || options.glob.test(entry.name);

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

const executeUtilityBlock = async (
  block: RalphUtilityBlock,
  config: RuntimeConfig,
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
    case "SEARCH_FILES":
      return executeSearchFilesUtilityBlock(block, utility, blockConfig, options.signal);
    case "GIT_STATUS":
      return executeGitStatusUtilityBlock(block, utility, blockConfig, options.signal);
    case "SET_VARIABLE":
      return executeSetVariableUtilityBlock(block, utility, context);
    case "TRANSFORM_JSON":
      return executeTransformJsonUtilityBlock(block, utility, context);
    case "VALIDATE_JSON":
      return executeValidateJsonUtilityBlock(block, utility, context);
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
): Promise<RalphBlockExecutionResult> => {
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
    case "UTILITY":
      return executeUtilityBlock(block, config, context, options);
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
  const resolvedVariables = resolveVariableValues(variables, options.variableValues);
  const validation = validateRalphFlow(flow, {
    config,
    variableValues: resolvedVariables.values,
  });
  const finishRun = async (result: RalphRunResult): Promise<RalphRunResult> => {
    const finishedAt = createLogTimestamp();
    const runResult: RalphRunResult = {
      ...result,
      runId,
      startedAt,
      finishedAt,
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

  const events: RalphRunEvent[] = [];
  const blockResults: RalphBlockExecutionResult[] = [];
  const resultContext: RalphResultContext = {
    runId,
    resultsByBlock: new Map(),
    runLog: [],
    variables: resolvedVariables.values,
  };
  const errorCounts = new Map<string, number>();
  const repeatedFailures = new Map<string, RalphRepeatedFailureState>();
  let currentBlockId: string | undefined = start.id;
  let transitions = 0;
  const maxTransitions =
    options.maxTransitions === null
      ? null
      : options.maxTransitions ?? flow.settings?.maxTransitions;
  const repeatedFailureLimit =
    options.repeatedFailureLimit === null
      ? null
      : options.repeatedFailureLimit ?? DEFAULT_RALPH_REPEATED_FAILURE_LIMIT;

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
          variables: resolvedVariables.values,
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

    const result = await executeBlock(
      flow,
      block,
      config,
      customizations,
      resultContext,
      options,
    );
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
        });
      }
    } else {
      repeatedFailures.delete(block.id);
    }

    if (block.type === "END") {
      const summary = `Ralph flow \`${flow.name}\` ended at \`${block.id}\`.`;
      await emitRunEvent(
        events,
        { type: "end", blockId: block.id, status: "completed", summary },
        options.onEvent,
      );
      return finishRun({
        flow: flow.id,
        status: "completed",
        summary,
        events,
        blockResults,
        missingVariables: [],
        unknownVariables: [],
        validation,
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
