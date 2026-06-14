import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { normalizeOptionalString } from "../common/_helpers/normalize-optional-string.js";
import {
  executeLocalCommand,
  formatLocalCommandError,
} from "./_helpers/process-execution.js";
import { loadRuntimeConfig } from "./config.js";
import { discoverCustomizations } from "./customizations.js";
import { executeTask } from "./execution.js";
import { normalizeRalphFlowLayout } from "./ralph-layout.js";
import { isReasoningMode } from "./runtime-contract.generated.js";
import { mcpClientManager } from "./mcp/client.js";
import {
  createImageInputUnsupportedModelMessage,
  getImageInputMediaTypeForPath,
  getSupportedImageInputExtensions,
  modelSupportsImageInput,
  providerSupportsImageInputMediaType,
} from "./model-capabilities.js";
import {
  coerceMcpConfigOverride,
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
  ModelProvider,
  AgentModelImageInput,
  ReasoningMode,
  RuntimeConfig,
  TaskExecutionOptions,
  TaskConversationContext,
  TaskExecutionProgressHandler,
  TaskExecutionResult,
} from "./types.js";

export const RALPH_FLOW_SCHEMA_VERSION = 1;
export const DEFAULT_RALPH_GENERATION_MAX_ROUNDS = 3;
export const MAX_RALPH_GENERATION_MAX_ROUNDS = 25;
export const MAX_RALPH_RESULT_CHARS = 16_000;

const RALPH_FLOW_DIRECTORY = ".machdoch/ralph/flows";
const RALPH_RUN_DIRECTORY = ".machdoch/ralph/runs";
const RALPH_REVISION_DIRECTORY = ".machdoch/ralph/revisions";
const FLOW_FILE_EXTENSION = ".json";
const FLOW_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/u;
const BLOCK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/u;
const EDGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,119}$/u;
const REVISION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const PLACEHOLDER_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/gu;
const DECISION_LINE_PATTERN = /^\s*RALPH_DECISION\s*:\s*([A-Z0-9_-]+)\s*$/iu;
const MAX_FLOW_BLOCKS = 250;
const MAX_FLOW_EDGES = 500;
const DEFAULT_RALPH_UTILITY_RESPONSE_LIMIT_BYTES = 1_000_000;
const DEFAULT_RALPH_UTILITY_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_RALPH_UTILITY_POLL_INTERVAL_SECONDS = 30;
const DEFAULT_RALPH_UTILITY_MAX_SEARCH_RESULTS = 100;

export { normalizeRalphFlowLayout };

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
  "END",
] as const;

export const RALPH_UTILITY_TYPES = [
  "WAIT",
  "HTTP_FETCH",
  "POLL",
  "RUN_COMMAND",
  "READ_FILE",
  "WRITE_FILE",
  "SEARCH_FILES",
  "RUN_CHECK",
  "GIT_STATUS",
  "SET_VARIABLE",
  "TRANSFORM_JSON",
  "VALIDATE_JSON",
  "NOTIFY",
] as const;

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
export type RalphValidatorDecision = "DONE" | "CONTINUE" | "RETRY" | "ERROR";
export type RalphExecutionOutput = "SUCCESS" | "ERROR" | RalphValidatorDecision | string;
export type RalphRunStatus = "completed" | "crashed" | "blocked" | "stopped";
export type RalphUtilityWaitMode = "delay" | "until-time" | "condition" | "poll";
export type RalphUtilityConditionStyle = "simple" | "json-path" | "javascript";
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

export interface RalphFlow {
  schemaVersion: typeof RALPH_FLOW_SCHEMA_VERSION;
  id: string;
  alias?: string;
  name: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  variables?: RalphFlowVariable[];
  blocks: RalphFlowBlock[];
  edges: RalphFlowEdge[];
}

export interface RalphFlowSummary {
  id: string;
  alias?: string;
  name: string;
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
}

export interface RalphFlowWriteOptions {
  createRevision?: boolean;
  reason?: string;
  allowInvalid?: boolean;
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

export interface RalphRunOptions {
  variableValues?: Record<string, string>;
  conversationContext?: TaskConversationContext;
  onStateChange?: TaskExecutionProgressHandler;
  onEvent?: (event: RalphRunEvent) => void | Promise<void>;
  runId?: string;
  signal?: AbortSignal;
  maxTransitions?: number | null;
}

export interface RalphRunResult {
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
  flowId: string;
  flowName: string;
  flowRevisionId?: string | null;
  status: RalphRunStatus;
  summary: string;
  variableValues: Record<string, string>;
  events: RalphRunEvent[];
  blockResults: RalphRunRecordBlock[];
  validation: Pick<RalphValidationResult, "valid" | "errors" | "warnings">;
}

export interface RalphRunRecordWriteResult {
  id: string;
  path: string;
  record: RalphRunRecord;
}

export interface RalphFlowGenerationOptions {
  name: string;
  prompt: string;
  existingFlow?: RalphFlow;
  mode?: "do-it" | "interview";
  target?: "flow" | "prompt-block" | "refactor";
  config?: RuntimeConfig;
  customizations?: CustomizationDiscoveryResult;
  maxRounds?: number;
  onStateChange?: TaskExecutionProgressHandler;
  runId?: string;
  signal?: AbortSignal;
}

export interface RalphFlowGenerationResult {
  status: "created" | "blocked";
  flowPath: string;
  flow?: RalphFlow;
  rounds: number;
  validation: RalphValidationResult;
  generatorResults: TaskExecutionResult[];
  validatorResults: TaskExecutionResult[];
  summary: string;
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

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isRalphBlockType = (value: unknown): value is RalphBlockType => {
  return (
    typeof value === "string" &&
    RALPH_BLOCK_TYPES.includes(value as RalphBlockType)
  );
};

const isRalphVariableType = (value: string): value is RalphVariableType => {
  return RALPH_VARIABLE_TYPES.includes(value as RalphVariableType);
};

const normalizeFlowId = (value: string): string => {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
};

const normalizeFlowAlias = normalizeFlowId;

const normalizeFlowFileName = (id: string): string => {
  const normalizedId = normalizeFlowId(id);

  if (!normalizedId || !FLOW_ID_PATTERN.test(normalizedId)) {
    throw new Error(
      "Expected Ralph flow id to contain lowercase letters, numbers, and dashes.",
    );
  }

  return `${normalizedId}${FLOW_FILE_EXTENSION}`;
};

const normalizeRevisionId = (value: string): string => {
  const revisionId = value.trim().replace(/\.json$/iu, "");

  if (!revisionId || !REVISION_ID_PATTERN.test(revisionId)) {
    throw new Error(
      "Expected Ralph revision id to contain letters, numbers, dashes, underscores, colons, or periods.",
    );
  }

  return revisionId;
};

export const getRalphFlowDirectory = (workspaceRoot: string): string => {
  return join(workspaceRoot, RALPH_FLOW_DIRECTORY);
};

export const getRalphRunDirectory = (workspaceRoot: string): string => {
  return join(workspaceRoot, RALPH_RUN_DIRECTORY);
};

export const getRalphRevisionDirectory = (
  workspaceRoot: string,
  flowId: string,
): string => {
  return join(workspaceRoot, RALPH_REVISION_DIRECTORY, normalizeFlowId(flowId));
};

export const getRalphRevisionPath = (
  workspaceRoot: string,
  flowId: string,
  revisionId: string,
): string => {
  return join(
    getRalphRevisionDirectory(workspaceRoot, flowId),
    `${normalizeRevisionId(revisionId)}${FLOW_FILE_EXTENSION}`,
  );
};

export const getRalphFlowPath = (
  workspaceRoot: string,
  id: string,
): string => {
  return join(getRalphFlowDirectory(workspaceRoot), normalizeFlowFileName(id));
};

export interface RalphFlowReferenceResolution {
  id: string;
  path: string;
  flow: RalphFlow;
}

const readRalphFlowFile = async (path: string): Promise<RalphFlow> => {
  return parseRalphFlowJson(await readFile(path, "utf8"));
};

export const resolveRalphFlowReference = async (
  workspaceRoot: string,
  reference: string,
): Promise<RalphFlowReferenceResolution> => {
  const normalizedReference = normalizeFlowId(reference);

  if (!normalizedReference) {
    throw new Error("Expected Ralph flow id or alias.");
  }

  const directPath = getRalphFlowPath(workspaceRoot, normalizedReference);

  if (existsSync(directPath)) {
    const flow = await readRalphFlowFile(directPath);

    return {
      id: normalizeOptionalString(flow.id) ?? normalizedReference,
      path: directPath,
      flow,
    };
  }

  const directory = getRalphFlowDirectory(workspaceRoot);

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

const createRalphRunFilePath = (
  runDirectory: string,
  timestamp: string,
): { id: string; path: string } => {
  const baseName = timestamp.replace(/[:.]/gu, "-");
  let id = baseName;
  let candidatePath = join(runDirectory, `${id}.json`);
  let suffix = 1;

  while (existsSync(candidatePath)) {
    id = `${baseName}-${suffix}`;
    candidatePath = join(runDirectory, `${id}.json`);
    suffix += 1;
  }

  return { id, path: candidatePath };
};

const createValidationResult = (
  errorIssues: RalphValidationIssue[],
  warningIssues: RalphValidationIssue[] = [],
  variables: RalphFlowVariable[] = [],
): RalphValidationResult => {
  return {
    valid: errorIssues.length === 0,
    errors: errorIssues.map((issue) => issue.message),
    warnings: warningIssues.map((issue) => issue.message),
    errorIssues,
    warningIssues,
    variables,
  };
};

const coerceStringArray = (value: unknown): string[] => {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
};

const coercePosition = (value: unknown): RalphPosition | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const x = typeof value.x === "number" ? value.x : undefined;
  const y = typeof value.y === "number" ? value.y : undefined;

  return x !== undefined && y !== undefined ? { x, y } : undefined;
};

const coerceRetryPolicy = (value: unknown): RalphRetryPolicy | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const mode = value.mode === "finite" ? "finite" : "infinite";
  const maxRetries =
    typeof value.maxRetries === "number" ? value.maxRetries : null;
  const delaySeconds =
    typeof value.delaySeconds === "number" ? value.delaySeconds : undefined;

  return {
    mode,
    maxRetries,
    ...(delaySeconds !== undefined ? { delaySeconds } : {}),
  };
};

const coerceWorkspaceSetting = (
  value: unknown,
): RalphWorkspaceSetting | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.mode === "custom") {
    return {
      mode: "custom",
      ...(typeof value.path === "string" ? { path: value.path } : {}),
    };
  }

  return value.mode === "default" ? { mode: "default" } : undefined;
};

const coerceAttachmentKind = (
  value: unknown,
): RalphAttachmentReference["kind"] | undefined => {
  return value === "file" ||
    value === "directory" ||
    value === "image" ||
    value === "other"
    ? value
    : undefined;
};

const coerceAttachments = (value: unknown): RalphAttachmentReference[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry): RalphAttachmentReference[] => {
    if (!isRecord(entry)) {
      return [];
    }

    const source = entry.source === "variable" ? "variable" : "path";
    const rawValue = typeof entry.value === "string" ? entry.value : "";
    const kind = coerceAttachmentKind(entry.kind);

    if (!rawValue.trim()) {
      return [];
    }

    return [
      {
        source,
        value: rawValue,
        ...(typeof entry.id === "string" ? { id: entry.id } : {}),
        ...(kind ? { kind } : {}),
        ...(typeof entry.mediaType === "string"
          ? { mediaType: entry.mediaType }
          : {}),
      },
    ];
  });
};

const coerceMcpArguments = (
  value: unknown,
): Record<string, unknown> | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  return { ...value };
};

const isRalphUtilityType = (value: unknown): value is RalphUtilityType => {
  return (
    typeof value === "string" &&
    RALPH_UTILITY_TYPES.includes(value as RalphUtilityType)
  );
};

const coerceStringRecord = (
  value: unknown,
): Record<string, string> | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value).flatMap(([key, entry]) =>
    typeof entry === "string" ? ([[key, entry]] as const) : [],
  );

  return Object.fromEntries(entries);
};

const coerceNumberArray = (value: unknown): number[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const numbers = value.filter(
    (entry): entry is number => Number.isInteger(entry),
  );

  return numbers.length > 0 ? numbers : undefined;
};

const coerceUtilityWaitMode = (
  value: unknown,
): RalphUtilityWaitMode | undefined => {
  return value === "delay" ||
    value === "until-time" ||
    value === "condition" ||
    value === "poll"
    ? value
    : undefined;
};

const coerceUtilityConditionStyle = (
  value: unknown,
): RalphUtilityConditionStyle | undefined => {
  return value === "simple" || value === "json-path" || value === "javascript"
    ? value
    : undefined;
};

const coerceUtilityConditionOperator = (
  value: unknown,
): RalphUtilityConditionOperator | undefined => {
  return value === "exists" ||
    value === "not-exists" ||
    value === "truthy" ||
    value === "falsy" ||
    value === "equals" ||
    value === "not-equals" ||
    value === "contains" ||
    value === "matches" ||
    value === "gt" ||
    value === "gte" ||
    value === "lt" ||
    value === "lte"
    ? value
    : undefined;
};

const coerceUtilityCondition = (
  value: unknown,
): RalphUtilityCondition | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const style = coerceUtilityConditionStyle(value.style) ?? "simple";
  const operator = coerceUtilityConditionOperator(value.operator);

  return {
    style,
    ...(typeof value.expression === "string"
      ? { expression: value.expression }
      : {}),
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(operator ? { operator } : {}),
    ...(typeof value.value === "string" ? { value: value.value } : {}),
  };
};

const coerceUtilityEncoding = (
  value: unknown,
): BufferEncoding | undefined => {
  return value === "utf8" ||
    value === "utf-8" ||
    value === "base64" ||
    value === "hex" ||
    value === "latin1" ||
    value === "ascii"
    ? (value === "utf-8" ? "utf8" : value)
    : undefined;
};

const coerceUtilityConfig = (value: unknown): RalphUtilityConfig => {
  const record = isRecord(value) ? value : {};
  const type = isRalphUtilityType(record.type) ? record.type : "WAIT";
  const mode = coerceUtilityWaitMode(record.mode);
  const condition = coerceUtilityCondition(record.condition);
  const headers = coerceStringRecord(record.headers);
  const env = coerceStringRecord(record.env);
  const acceptedExitCodes = coerceNumberArray(record.acceptedExitCodes);
  const encoding = coerceUtilityEncoding(record.encoding);

  return {
    type,
    ...(mode ? { mode } : {}),
    ...(typeof record.delaySeconds === "number"
      ? { delaySeconds: record.delaySeconds }
      : {}),
    ...(typeof record.runAt === "string" ? { runAt: record.runAt } : {}),
    ...(typeof record.intervalSeconds === "number"
      ? { intervalSeconds: record.intervalSeconds }
      : {}),
    ...(typeof record.backoffMultiplier === "number"
      ? { backoffMultiplier: record.backoffMultiplier }
      : {}),
    ...(typeof record.maxAttempts === "number" || record.maxAttempts === null
      ? { maxAttempts: record.maxAttempts }
      : {}),
    ...(condition ? { condition } : {}),
    ...(typeof record.url === "string" ? { url: record.url } : {}),
    ...(typeof record.method === "string" ? { method: record.method } : {}),
    ...(headers ? { headers } : {}),
    ...(typeof record.body === "string" ? { body: record.body } : {}),
    ...(typeof record.outputPath === "string"
      ? { outputPath: record.outputPath }
      : {}),
    ...(typeof record.path === "string" ? { path: record.path } : {}),
    ...(typeof record.rootPath === "string" ? { rootPath: record.rootPath } : {}),
    ...(typeof record.content === "string" ? { content: record.content } : {}),
    ...(typeof record.append === "boolean" ? { append: record.append } : {}),
    ...(encoding ? { encoding } : {}),
    ...(typeof record.pattern === "string" ? { pattern: record.pattern } : {}),
    ...(typeof record.glob === "string" ? { glob: record.glob } : {}),
    ...(typeof record.maxResults === "number"
      ? { maxResults: record.maxResults }
      : {}),
    ...(typeof record.command === "string" ? { command: record.command } : {}),
    ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
    ...(env ? { env } : {}),
    ...(acceptedExitCodes ? { acceptedExitCodes } : {}),
    ...(typeof record.timeoutSeconds === "number"
      ? { timeoutSeconds: record.timeoutSeconds }
      : {}),
    ...(typeof record.maxOutputBytes === "number"
      ? { maxOutputBytes: record.maxOutputBytes }
      : {}),
    ...(typeof record.variableName === "string"
      ? { variableName: record.variableName }
      : {}),
    ...(typeof record.value === "string" ? { value: record.value } : {}),
    ...(typeof record.input === "string" ? { input: record.input } : {}),
    ...(typeof record.expression === "string"
      ? { expression: record.expression }
      : {}),
    ...(Object.hasOwn(record, "schema") ? { schema: record.schema } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...(typeof record.ignoreErrors === "boolean"
      ? { ignoreErrors: record.ignoreErrors }
      : {}),
  };
};

const coerceSettings = (value: unknown): RalphBlockSettings | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const workspace = coerceWorkspaceSetting(value.workspace);
  const retry = coerceRetryPolicy(value.retry);
  const mcp = coerceMcpConfigOverride(value.mcp);
  const provider =
    typeof value.provider === "string"
      ? (value.provider as ModelProvider | "default")
      : undefined;
  const model = typeof value.model === "string" ? value.model : undefined;
  const reasoning =
    typeof value.reasoning === "string" && isReasoningMode(value.reasoning)
      ? value.reasoning
      : undefined;
  const timeoutSeconds =
    typeof value.timeoutSeconds === "number" ? value.timeoutSeconds : undefined;
  const temperature =
    typeof value.temperature === "number" ? value.temperature : undefined;
  const maxIterations =
    typeof value.maxIterations === "number" ? value.maxIterations : undefined;

  return {
    ...(workspace ? { workspace } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(typeof value.webAccess === "boolean"
      ? { webAccess: value.webAccess }
      : {}),
    ...(typeof value.fileAccess === "boolean"
      ? { fileAccess: value.fileAccess }
      : {}),
    attachments: coerceAttachments(value.attachments),
    packs: coerceStringArray(value.packs),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(typeof value.internalValidatorEnabled === "boolean"
      ? { internalValidatorEnabled: value.internalValidatorEnabled }
      : {}),
    ...(retry ? { retry } : {}),
    ...(mcp ? { mcp } : {}),
  };
};

const coerceValidationScope = (
  value: unknown,
): RalphValidationScope | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const allowedModes: RalphValidationScope["mode"][] = [
    "sinceLastValidator",
    "previousBlock",
    "selectedBlocks",
    "wholeFlow",
  ];
  const mode = allowedModes.includes(value.mode as RalphValidationScope["mode"])
    ? (value.mode as RalphValidationScope["mode"])
    : "sinceLastValidator";

  return {
    mode,
    blockIds: coerceStringArray(value.blockIds),
  };
};

const parseFlowBlockRecord = (record: Record<string, unknown>): RalphFlowBlock => {
  const type = isRalphBlockType(record.type) ? record.type : "PROMPT";
  const base: Omit<RalphBaseBlock, "type"> = {
    id: typeof record.id === "string" ? record.id : "",
    title: typeof record.title === "string" ? record.title : "",
  };
  const position = coercePosition(record.position);
  const settings = coerceSettings(record.settings);

  if (position) {
    base.position = position;
  }

  if (settings) {
    base.settings = settings;
  }

  if (typeof record.groupBoundary === "boolean") {
    base.groupBoundary = record.groupBoundary;
  }

  switch (type) {
    case "START":
      return { ...base, type };
    case "PROMPT":
      return {
        ...base,
        type,
        prompt: typeof record.prompt === "string" ? record.prompt : "",
      };
    case "VALIDATOR": {
      const validationScope = coerceValidationScope(record.validationScope);
      return {
        ...base,
        type,
        prompt: typeof record.prompt === "string" ? record.prompt : "",
        ...(validationScope ? { validationScope } : {}),
      };
    }
    case "DECISION":
      return {
        ...base,
        type,
        prompt: typeof record.prompt === "string" ? record.prompt : "",
        labels: coerceStringArray(record.labels),
      };
    case "PACK":
      return {
        ...base,
        type,
        packIds: coerceStringArray(record.packIds),
        propagationMode:
          record.propagationMode === "untilOverridden"
            ? "untilOverridden"
            : "nextBlockOnly",
      };
    case "UTILITY":
      return {
        ...base,
        type,
        utility: coerceUtilityConfig(record.utility),
      };
    case "MCP_TOOL": {
      const mcpArguments = coerceMcpArguments(record.arguments);
      return {
        ...base,
        type,
        serverId: typeof record.serverId === "string" ? record.serverId : "",
        toolName: typeof record.toolName === "string" ? record.toolName : "",
        ...(mcpArguments ? { arguments: mcpArguments } : {}),
      };
    }
    case "MCP_RESOURCE":
      return {
        ...base,
        type,
        serverId: typeof record.serverId === "string" ? record.serverId : "",
        uri: typeof record.uri === "string" ? record.uri : "",
      };
    case "MCP_PROMPT": {
      const mcpArguments = coerceMcpArguments(record.arguments);
      return {
        ...base,
        type,
        serverId: typeof record.serverId === "string" ? record.serverId : "",
        promptName:
          typeof record.promptName === "string" ? record.promptName : "",
        ...(mcpArguments ? { arguments: mcpArguments } : {}),
      };
    }
    case "END":
      return {
        ...base,
        type,
        status:
          record.status === "failed" ||
          record.status === "cancelled" ||
          record.status === "review"
            ? record.status
            : "success",
      };
  }
};

const parseFlowRecord = (record: Record<string, unknown>): RalphFlow => {
  const schemaVersion =
    typeof record.schemaVersion === "number"
      ? record.schemaVersion
      : record.schemaVersion === undefined || record.schemaVersion === null
        ? RALPH_FLOW_SCHEMA_VERSION
        : Number.NaN;
  const blocks = Array.isArray(record.blocks)
    ? record.blocks.flatMap((block): RalphFlowBlock[] =>
        isRecord(block) ? [parseFlowBlockRecord(block)] : [],
      )
    : [];
  const edges = Array.isArray(record.edges)
    ? record.edges.flatMap((edge): RalphFlowEdge[] => {
        if (!isRecord(edge)) {
          return [];
        }

        return [
          {
            id: typeof edge.id === "string" ? edge.id : "",
            from: typeof edge.from === "string" ? edge.from : "",
            fromOutput:
              typeof edge.fromOutput === "string" ? edge.fromOutput : "",
            to: typeof edge.to === "string" ? edge.to : "",
          },
        ];
      })
    : [];

  return {
    schemaVersion: schemaVersion as typeof RALPH_FLOW_SCHEMA_VERSION,
    id: typeof record.id === "string" ? record.id : "",
    ...(typeof record.alias === "string" ? { alias: record.alias } : {}),
    name: typeof record.name === "string" ? record.name : "",
    ...(typeof record.description === "string"
      ? { description: record.description }
      : {}),
    ...(typeof record.createdAt === "string" ? { createdAt: record.createdAt } : {}),
    ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {}),
    variables: Array.isArray(record.variables)
      ? record.variables.flatMap((variable): RalphFlowVariable[] => {
          if (!isRecord(variable)) {
            return [];
          }

          const type =
            typeof variable.type === "string" && isRalphVariableType(variable.type)
              ? variable.type
              : "string";
          const name = typeof variable.name === "string" ? variable.name : "";
          const defaultValue =
            typeof variable.default === "string" ? variable.default : undefined;

          return [
            {
              name,
              type,
              ...(defaultValue !== undefined ? { default: defaultValue } : {}),
              required:
                typeof variable.required === "boolean"
                  ? variable.required
                  : defaultValue === undefined,
            },
          ];
        })
      : [],
    blocks,
    edges,
  };
};

export const parseRalphFlowJson = (raw: string): RalphFlow => {
  const parsed: unknown = JSON.parse(raw);

  if (!isRecord(parsed)) {
    throw new Error("Expected Ralph flow JSON to be an object.");
  }

  return parseFlowRecord(parsed);
};

interface ParsedPlaceholder {
  raw: string;
  content: string;
  variable?: RalphFlowVariable;
  builtin?: string;
  blockReference?: {
    kind: "result" | "summary" | "error" | "data";
    blockId: string;
    path?: string;
  };
  invalid?: string;
}

const parsePlaceholderContent = (raw: string, content: string): ParsedPlaceholder => {
  const builtinNames = new Set([
    "lastResult",
    "lastResultSummary",
    "lastError",
    "lastData",
    "runLog",
  ]);

  if (builtinNames.has(content)) {
    return { raw, content, builtin: content };
  }

  const blockReference = content.match(
    /^(result|summary|error|data):([a-z0-9][a-z0-9-]{0,79})(?::([\s\S]+))?$/u,
  );
  if (blockReference) {
    return {
      raw,
      content,
      blockReference: {
        kind: blockReference[1] as "result" | "summary" | "error" | "data",
        blockId: blockReference[2] ?? "",
        ...(blockReference[3] ? { path: blockReference[3] } : {}),
      },
    };
  }

  const variableMatch = content.match(
    /^([A-Za-z_][A-Za-z0-9_]*)(?::([a-z][a-z0-9-]*))?(?:=([\s\S]*))?$/u,
  );
  if (!variableMatch) {
    return {
      raw,
      content,
      invalid: `placeholder \`${raw}\` has invalid Ralph variable syntax.`,
    };
  }

  const type = variableMatch[2] ?? "string";
  if (!isRalphVariableType(type)) {
    return {
      raw,
      content,
      invalid: `placeholder \`${raw}\` uses unsupported variable type \`${type}\`.`,
    };
  }

  const defaultValue = variableMatch[3];

  return {
    raw,
    content,
    variable: {
      name: variableMatch[1] ?? "",
      type,
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      required: defaultValue === undefined,
    },
  };
};

const extractPlaceholders = (text: string): ParsedPlaceholder[] => {
  return [...text.matchAll(PLACEHOLDER_PATTERN)].map((match) =>
    parsePlaceholderContent(match[0] ?? "", (match[1] ?? "").trim()),
  );
};

const hasPlaceholders = (text: string): boolean => {
  return /\{\{\s*([^}]+?)\s*\}\}/u.test(text);
};

const collectTemplateTexts = (value: unknown): string[] => {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectTemplateTexts);
  }

  if (isRecord(value)) {
    return Object.values(value).flatMap(collectTemplateTexts);
  }

  return [];
};

const getPromptLikeText = (block: RalphFlowBlock): string[] => {
  switch (block.type) {
    case "PROMPT":
    case "VALIDATOR":
    case "DECISION":
      return [block.prompt];
    case "MCP_TOOL":
      return [
        block.serverId,
        block.toolName,
        ...collectTemplateTexts(block.arguments),
      ];
    case "MCP_RESOURCE":
      return [block.serverId, block.uri];
    case "MCP_PROMPT":
      return [
        block.serverId,
        block.promptName,
        ...collectTemplateTexts(block.arguments),
      ];
    case "UTILITY":
      return collectTemplateTexts(block.utility);
    case "START":
    case "PACK":
    case "END":
      return [];
  }
};

const isPlainRalphVariableReference = (value: string): boolean => {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(value.trim());
};

const getAttachmentTexts = (block: RalphFlowBlock): string[] => {
  return (
    block.settings?.attachments?.map((attachment) => {
      if (
        attachment.source === "variable" &&
        isPlainRalphVariableReference(attachment.value)
      ) {
        return `{{${attachment.value.trim()}:file}}`;
      }

      return attachment.value;
    }) ?? []
  );
};

export const discoverRalphFlowVariables = (flow: RalphFlow): RalphFlowVariable[] => {
  const variables = new Map<string, RalphFlowVariable>();

  for (const declared of flow.variables ?? []) {
    if (!declared.name.trim()) {
      continue;
    }

    variables.set(declared.name, declared);
  }

  for (const block of flow.blocks) {
    for (const text of [...getPromptLikeText(block), ...getAttachmentTexts(block)]) {
      for (const placeholder of extractPlaceholders(text)) {
        if (!placeholder.variable) {
          continue;
        }

        const current = variables.get(placeholder.variable.name);
        variables.set(placeholder.variable.name, {
          ...placeholder.variable,
          ...(current?.default !== undefined
            ? { default: current.default, required: current.required }
            : {}),
          type: current?.type ?? placeholder.variable.type,
        });
      }
    }
  }

  for (const block of flow.blocks) {
    if (
      block.type === "UTILITY" &&
      block.utility.type === "SET_VARIABLE" &&
      block.utility.variableName?.trim()
    ) {
      const name = block.utility.variableName.trim();
      const current = variables.get(name);

      variables.set(name, {
        name,
        type: current?.type ?? "string",
        ...(current?.default !== undefined ? { default: current.default } : {}),
        required: false,
      });
    }
  }

  return [...variables.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
};

export const getRalphUtilityOutputs = (
  utility: RalphUtilityConfig,
): RalphExecutionOutput[] => {
  switch (utility.type) {
    case "WAIT":
    case "SET_VARIABLE":
    case "NOTIFY":
      return ["SUCCESS"];
    case "HTTP_FETCH":
      return ["SUCCESS", "HTTP_ERROR", "TIMEOUT", "ERROR"];
    case "POLL":
      return utility.maxAttempts === null || utility.maxAttempts === undefined
        ? ["SUCCESS", "ERROR"]
        : ["SUCCESS", "TIMEOUT", "ERROR"];
    case "RUN_COMMAND":
    case "READ_FILE":
    case "WRITE_FILE":
    case "GIT_STATUS":
    case "TRANSFORM_JSON":
      return ["SUCCESS", "ERROR"];
    case "SEARCH_FILES":
      return ["SUCCESS", "EMPTY", "ERROR"];
    case "RUN_CHECK":
      return ["SUCCESS", "FAILED", "ERROR"];
    case "VALIDATE_JSON":
      return ["SUCCESS", "INVALID", "ERROR"];
  }
};

const getBlockOutputs = (block: RalphFlowBlock): RalphExecutionOutput[] => {
  switch (block.type) {
    case "START":
      return ["SUCCESS"];
    case "PROMPT":
    case "PACK":
    case "MCP_TOOL":
    case "MCP_RESOURCE":
    case "MCP_PROMPT":
      return ["SUCCESS", "ERROR"];
    case "UTILITY":
      return getRalphUtilityOutputs(block.utility);
    case "VALIDATOR":
      return ["DONE", "CONTINUE", "RETRY", "ERROR"];
    case "DECISION":
      return [...new Set([...block.labels, "ERROR"])];
    case "END":
      return [];
  }
};

const getBlockById = (flow: RalphFlow): Map<string, RalphFlowBlock> => {
  return new Map(flow.blocks.map((block) => [block.id, block]));
};

const hasOutgoingEdge = (
  flow: RalphFlow,
  blockId: string,
  output: RalphExecutionOutput,
): boolean => {
  return flow.edges.some(
    (edge) => edge.from === blockId && edge.fromOutput === output,
  );
};

const findOutgoingEdge = (
  flow: RalphFlow,
  blockId: string,
  output: RalphExecutionOutput,
): RalphFlowEdge | undefined => {
  return flow.edges.find(
    (edge) => edge.from === blockId && edge.fromOutput === output,
  );
};

const addIssue = (
  issues: RalphValidationIssue[],
  code: string,
  message: string,
  context: Pick<RalphValidationIssue, "blockId" | "edgeId"> = {},
): void => {
  issues.push({ code, message, ...context });
};

const validateBlockReferencePlaceholders = (
  flow: RalphFlow,
  block: RalphFlowBlock,
  errors: RalphValidationIssue[],
  warnings: RalphValidationIssue[],
): void => {
  const blockIds = new Set(flow.blocks.map((candidate) => candidate.id));

  for (const text of [...getPromptLikeText(block), ...getAttachmentTexts(block)]) {
    for (const placeholder of extractPlaceholders(text)) {
      if (placeholder.invalid) {
        addIssue(errors, "invalid-placeholder", placeholder.invalid, {
          blockId: block.id,
        });
        continue;
      }

      const reference = placeholder.blockReference;
      if (reference && !blockIds.has(reference.blockId)) {
        addIssue(
          warnings,
          "missing-result-reference",
          `${block.id} references result placeholder for unknown block \`${reference.blockId}\`.`,
          { blockId: block.id },
        );
      }
    }
  }
};

const blockCanExecute = (block: RalphFlowBlock): boolean => {
  return block.type !== "START" && block.type !== "END";
};

const getReachableBlockIds = (flow: RalphFlow): Set<string> => {
  const starts = flow.blocks.filter((block) => block.type === "START");
  const reachable = new Set<string>();
  const pending = starts.map((block) => block.id);

  while (pending.length > 0) {
    const current = pending.shift();

    if (!current || reachable.has(current)) {
      continue;
    }

    reachable.add(current);
    for (const edge of flow.edges.filter((candidate) => candidate.from === current)) {
      pending.push(edge.to);
    }
  }

  return reachable;
};

const hasPathToEnd = (flow: RalphFlow, startBlockId: string): boolean => {
  const blockMap = getBlockById(flow);
  const visited = new Set<string>();
  const pending = [startBlockId];

  while (pending.length > 0) {
    const current = pending.shift();

    if (!current || visited.has(current)) {
      continue;
    }

    visited.add(current);
    const block = blockMap.get(current);
    if (block?.type === "END") {
      return true;
    }

    for (const edge of flow.edges.filter((candidate) => candidate.from === current)) {
      pending.push(edge.to);
    }
  }

  return false;
};

const validateUtilityCondition = (
  blockLabel: string,
  block: RalphUtilityBlock,
  errors: RalphValidationIssue[],
): void => {
  const condition = block.utility.condition;

  if (!condition) {
    return;
  }

  if (condition.style === "javascript" || condition.style === "simple") {
    if (!condition.expression?.trim()) {
      addIssue(
        errors,
        "utility-condition-expression-required",
        `${blockLabel} ${condition.style} condition requires expression.`,
        { blockId: block.id },
      );
    }
    return;
  }

  if (!condition.path?.trim()) {
    addIssue(
      errors,
      "utility-condition-path-required",
      `${blockLabel} json-path condition requires path.`,
      { blockId: block.id },
    );
  }
};

const validateRalphUtilityBlock = (
  block: RalphUtilityBlock,
  errors: RalphValidationIssue[],
): void => {
  const blockLabel = block.id || block.title || "utility block";
  const utility = block.utility;

  if (utility.delaySeconds !== undefined && utility.delaySeconds < 0) {
    addIssue(
      errors,
      "utility-delay-invalid",
      `${blockLabel} delaySeconds must be >= 0.`,
      { blockId: block.id },
    );
  }

  if (utility.intervalSeconds !== undefined && utility.intervalSeconds < 0) {
    addIssue(
      errors,
      "utility-interval-invalid",
      `${blockLabel} intervalSeconds must be >= 0.`,
      { blockId: block.id },
    );
  }

  if (
    utility.maxAttempts !== undefined &&
    utility.maxAttempts !== null &&
    (!Number.isInteger(utility.maxAttempts) || utility.maxAttempts < 1)
  ) {
    addIssue(
      errors,
      "utility-max-attempts-invalid",
      `${blockLabel} maxAttempts must be null or an integer >= 1.`,
      { blockId: block.id },
    );
  }

  if (
    utility.timeoutSeconds !== undefined &&
    (!Number.isFinite(utility.timeoutSeconds) || utility.timeoutSeconds < 0)
  ) {
    addIssue(
      errors,
      "utility-timeout-invalid",
      `${blockLabel} timeoutSeconds must be >= 0.`,
      { blockId: block.id },
    );
  }

  if (
    utility.maxOutputBytes !== undefined &&
    (!Number.isInteger(utility.maxOutputBytes) || utility.maxOutputBytes < 1)
  ) {
    addIssue(
      errors,
      "utility-output-limit-invalid",
      `${blockLabel} maxOutputBytes must be an integer >= 1.`,
      { blockId: block.id },
    );
  }

  validateUtilityCondition(blockLabel, block, errors);

  switch (utility.type) {
    case "WAIT":
      if (utility.mode === "until-time" && !utility.runAt?.trim()) {
        addIssue(errors, "utility-run-at-required", `${blockLabel} requires runAt.`, {
          blockId: block.id,
        });
      }

      if (
        (utility.mode === "condition" || utility.mode === "poll") &&
        !utility.condition
      ) {
        addIssue(
          errors,
          "utility-condition-required",
          `${blockLabel} requires a condition.`,
          { blockId: block.id },
        );
      }
      break;
    case "HTTP_FETCH":
    case "POLL":
      if (!utility.url?.trim()) {
        addIssue(errors, "utility-url-required", `${blockLabel} requires url.`, {
          blockId: block.id,
        });
      }

      if (utility.type === "POLL" && !utility.condition) {
        addIssue(
          errors,
          "utility-condition-required",
          `${blockLabel} requires a poll condition.`,
          { blockId: block.id },
        );
      }
      break;
    case "RUN_COMMAND":
    case "RUN_CHECK":
      if (!utility.command?.trim()) {
        addIssue(
          errors,
          "utility-command-required",
          `${blockLabel} requires command.`,
          { blockId: block.id },
        );
      }
      break;
    case "READ_FILE":
    case "WRITE_FILE":
      if (!utility.path?.trim()) {
        addIssue(errors, "utility-path-required", `${blockLabel} requires path.`, {
          blockId: block.id,
        });
      }

      if (utility.type === "WRITE_FILE" && utility.content === undefined) {
        addIssue(
          errors,
          "utility-content-required",
          `${blockLabel} requires content.`,
          { blockId: block.id },
        );
      }
      break;
    case "SEARCH_FILES":
      if (!utility.pattern?.trim() && !utility.glob?.trim()) {
        addIssue(
          errors,
          "utility-search-pattern-required",
          `${blockLabel} requires pattern or glob.`,
          { blockId: block.id },
        );
      }
      break;
    case "SET_VARIABLE":
      if (!utility.variableName?.trim()) {
        addIssue(
          errors,
          "utility-variable-name-required",
          `${blockLabel} requires variableName.`,
          { blockId: block.id },
        );
      }
      break;
    case "TRANSFORM_JSON":
      if (!utility.expression?.trim()) {
        addIssue(
          errors,
          "utility-expression-required",
          `${blockLabel} requires expression.`,
          { blockId: block.id },
        );
      }
      break;
    case "VALIDATE_JSON":
      if (utility.schema === undefined) {
        addIssue(
          errors,
          "utility-schema-required",
          `${blockLabel} requires schema.`,
          { blockId: block.id },
        );
      }
      break;
    case "GIT_STATUS":
    case "NOTIFY":
      break;
  }
};

export const validateRalphFlow = (
  flow: RalphFlow,
  options: {
    config?: RuntimeConfig;
    variableValues?: Record<string, string>;
  } = {},
): RalphValidationResult => {
  const errors: RalphValidationIssue[] = [];
  const warnings: RalphValidationIssue[] = [];
  const variables = discoverRalphFlowVariables(flow);

  if (flow.schemaVersion !== RALPH_FLOW_SCHEMA_VERSION) {
    addIssue(
      errors,
      "schema-version",
      `schemaVersion must be ${RALPH_FLOW_SCHEMA_VERSION}.`,
    );
  }

  if (!flow.id.trim()) {
    addIssue(errors, "flow-id-required", "flow id is required.");
  } else if (!FLOW_ID_PATTERN.test(flow.id)) {
    addIssue(errors, "flow-id-invalid", `flow id \`${flow.id}\` must match ${FLOW_ID_PATTERN.source}.`);
  }

  if (flow.alias !== undefined) {
    const alias = flow.alias.trim();

    if (!alias) {
      addIssue(errors, "flow-alias-empty", "flow alias cannot be empty.");
    } else if (!FLOW_ID_PATTERN.test(alias)) {
      addIssue(
        errors,
        "flow-alias-invalid",
        `flow alias \`${flow.alias}\` must match ${FLOW_ID_PATTERN.source}.`,
      );
    }
  }

  if (!flow.name.trim()) {
    addIssue(errors, "flow-name-required", "flow name is required.");
  }

  if (flow.blocks.length > MAX_FLOW_BLOCKS) {
    addIssue(
      errors,
      "too-many-blocks",
      `blocks cannot contain more than ${MAX_FLOW_BLOCKS} entries.`,
    );
  }

  if (flow.edges.length > MAX_FLOW_EDGES) {
    addIssue(
      errors,
      "too-many-edges",
      `edges cannot contain more than ${MAX_FLOW_EDGES} entries.`,
    );
  }

  const blockIds = new Set<string>();
  const startBlocks = flow.blocks.filter((block) => block.type === "START");

  if (startBlocks.length === 0) {
    addIssue(errors, "missing-start", "Ralph flow must contain exactly one START block.");
  } else if (startBlocks.length > 1) {
    addIssue(errors, "multiple-start", "Ralph flow cannot contain more than one START block.");
  }

  for (const block of flow.blocks) {
    const blockLabel = block.id || block.title || "block";

    if (!block.id.trim()) {
      addIssue(errors, "block-id-required", "block id is required.", {
        blockId: block.id,
      });
    } else if (!BLOCK_ID_PATTERN.test(block.id)) {
      addIssue(
        errors,
        "block-id-invalid",
        `block id \`${block.id}\` must match ${BLOCK_ID_PATTERN.source}.`,
        { blockId: block.id },
      );
    } else if (blockIds.has(block.id)) {
      addIssue(errors, "block-id-duplicate", `block id \`${block.id}\` is duplicated.`, {
        blockId: block.id,
      });
    }

    blockIds.add(block.id);

    if (!block.title.trim()) {
      addIssue(errors, "block-title-required", `${blockLabel} title is required.`, {
        blockId: block.id,
      });
    }

    if (
      (block.type === "PROMPT" ||
        block.type === "VALIDATOR" ||
        block.type === "DECISION") &&
      !block.prompt.trim()
    ) {
      addIssue(errors, "block-prompt-required", `${blockLabel} prompt is required.`, {
        blockId: block.id,
      });
    }

    if (block.type === "DECISION" && block.labels.length === 0) {
      addIssue(
        errors,
        "decision-labels-required",
        `${blockLabel} decision block requires at least one label.`,
        { blockId: block.id },
      );
    }

    if (block.type === "PACK" && block.packIds.length === 0) {
      addIssue(warnings, "pack-empty", `${blockLabel} pack block does not reference any packs.`, {
        blockId: block.id,
      });
    }

    if (block.type === "UTILITY") {
      validateRalphUtilityBlock(block, errors);
    }

    if (block.type === "MCP_TOOL") {
      if (!block.serverId.trim()) {
        addIssue(errors, "mcp-server-required", `${blockLabel} requires serverId.`, {
          blockId: block.id,
        });
      }

      if (!block.toolName.trim()) {
        addIssue(errors, "mcp-tool-required", `${blockLabel} requires toolName.`, {
          blockId: block.id,
        });
      }
    }

    if (block.type === "MCP_RESOURCE") {
      if (!block.serverId.trim()) {
        addIssue(errors, "mcp-server-required", `${blockLabel} requires serverId.`, {
          blockId: block.id,
        });
      }

      if (!block.uri.trim()) {
        addIssue(errors, "mcp-resource-uri-required", `${blockLabel} requires uri.`, {
          blockId: block.id,
        });
      }
    }

    if (block.type === "MCP_PROMPT") {
      if (!block.serverId.trim()) {
        addIssue(errors, "mcp-server-required", `${blockLabel} requires serverId.`, {
          blockId: block.id,
        });
      }

      if (!block.promptName.trim()) {
        addIssue(errors, "mcp-prompt-required", `${blockLabel} requires promptName.`, {
          blockId: block.id,
        });
      }
    }

    if (
      options.config &&
      (block.type === "MCP_TOOL" ||
        block.type === "MCP_RESOURCE" ||
        block.type === "MCP_PROMPT") &&
      block.serverId.trim() &&
      !hasPlaceholders(block.serverId)
    ) {
      try {
        const mcpConfig = loadMcpConfigSync(
          options.config.workspaceRoot,
          block.settings?.mcp,
        );

        if (!getEnabledMcpServer(mcpConfig, block.serverId)) {
          addIssue(
            errors,
            "mcp-server-unavailable",
            `${blockLabel} references MCP server \`${block.serverId}\`, but it is not configured or not enabled.`,
            { blockId: block.id },
          );
        }
      } catch (error) {
        addIssue(
          errors,
          "mcp-config-invalid",
          `${blockLabel} could not load MCP config: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { blockId: block.id },
        );
      }
    }

    const maxIterations = block.settings?.maxIterations;
    if (
      maxIterations !== undefined &&
      (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 100)
    ) {
      addIssue(
        errors,
        "max-iterations-invalid",
        `${blockLabel} maxIterations must be an integer from 1 to 100.`,
        { blockId: block.id },
      );
    }

    const retry = block.settings?.retry;
    if (
      retry?.mode === "finite" &&
      (retry.maxRetries === null ||
        retry.maxRetries === undefined ||
        !Number.isInteger(retry.maxRetries) ||
        retry.maxRetries < 0)
    ) {
      addIssue(
        errors,
        "retry-invalid",
        `${blockLabel} finite retry policy requires maxRetries >= 0.`,
        { blockId: block.id },
      );
    }

    if (
      block.settings?.provider &&
      block.settings.provider !== "default" &&
      options.config &&
      !options.config.providerAvailability.some(
        (entry) => entry.provider === block.settings?.provider && entry.configured,
      )
    ) {
      addIssue(
        errors,
        "provider-unavailable",
        `${blockLabel} uses unavailable provider \`${block.settings.provider}\`.`,
        { blockId: block.id },
      );
    }

    validateBlockReferencePlaceholders(flow, block, errors, warnings);
  }

  const edgeIds = new Set<string>();
  for (const edge of flow.edges) {
    if (!edge.id.trim()) {
      addIssue(errors, "edge-id-required", "edge id is required.", {
        edgeId: edge.id,
      });
    } else if (!EDGE_ID_PATTERN.test(edge.id)) {
      addIssue(errors, "edge-id-invalid", `edge id \`${edge.id}\` must match ${EDGE_ID_PATTERN.source}.`, {
        edgeId: edge.id,
      });
    } else if (edgeIds.has(edge.id)) {
      addIssue(errors, "edge-id-duplicate", `edge id \`${edge.id}\` is duplicated.`, {
        edgeId: edge.id,
      });
    }

    edgeIds.add(edge.id);

    if (!blockIds.has(edge.from)) {
      addIssue(
        errors,
        "edge-from-missing",
        `edge \`${edge.id}\` references missing source block \`${edge.from}\`.`,
        { edgeId: edge.id },
      );
    }

    if (!blockIds.has(edge.to)) {
      addIssue(
        errors,
        "edge-to-missing",
        `edge \`${edge.id}\` references missing target block \`${edge.to}\`.`,
        { edgeId: edge.id },
      );
    }
  }

  for (const block of flow.blocks) {
    for (const output of getBlockOutputs(block)) {
      if (block.type === "VALIDATOR" && output === "RETRY") {
        continue;
      }

      if (!hasOutgoingEdge(flow, block.id, output)) {
        const code =
          block.type === "VALIDATOR" && output === "CONTINUE"
            ? "validator-continue-missing"
            : "output-edge-missing";
        addIssue(
          warnings,
          code,
          `${block.id} has no edge for output ${output}.`,
          { blockId: block.id },
        );
      }
    }
  }

  const reachable = getReachableBlockIds(flow);
  for (const block of flow.blocks) {
    if (startBlocks.length === 1 && !reachable.has(block.id)) {
      addIssue(warnings, "unreachable-block", `${block.id} is unreachable from START.`, {
        blockId: block.id,
      });
    }

    if (blockCanExecute(block) && !hasPathToEnd(flow, block.id)) {
      addIssue(
        warnings,
        "no-terminal-path",
        `${block.id} has no routed path to an END block.`,
        { blockId: block.id },
      );
    }
  }

  for (const variable of variables) {
    if (!variable.name.trim()) {
      addIssue(errors, "variable-name-required", "variable name is required.");
    }

    if (
      variable.required &&
      variable.default === undefined &&
      options.variableValues &&
      !Object.hasOwn(options.variableValues, variable.name)
    ) {
      addIssue(
        errors,
        "variable-missing",
        `missing required Ralph variable \`${variable.name}\`.`,
      );
    }
  }

  return createValidationResult(errors, warnings, variables);
};

export const readRalphFlow = async (
  workspaceRoot: string,
  id: string,
  options: RalphFlowReadOptions = {},
): Promise<RalphFlow> => {
  const resolution = await resolveRalphFlowReference(workspaceRoot, id);
  const flow = resolution.flow;
  const validation = validateRalphFlow(flow);

  if (!options.allowInvalid && !validation.valid) {
    throw new Error(`Ralph flow \`${id}\` is invalid: ${validation.errors.join(" ")}`);
  }

  return flow;
};

const assertRalphFlowAliasAvailable = async (
  workspaceRoot: string,
  flow: RalphFlow,
): Promise<void> => {
  const alias = flow.alias ? normalizeFlowAlias(flow.alias) : "";

  if (!alias) {
    return;
  }

  const directory = getRalphFlowDirectory(workspaceRoot);

  if (!existsSync(directory)) {
    return;
  }

  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name) !== FLOW_FILE_EXTENSION) {
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
  const validation = validateRalphFlow(flow);

  if (!options.allowInvalid && !validation.valid) {
    throw new Error(`Ralph flow is invalid: ${validation.errors.join(" ")}`);
  }

  const directory = getRalphFlowDirectory(workspaceRoot);
  await assertRalphFlowAliasAvailable(workspaceRoot, flow);
  const flowPath = getRalphFlowPath(workspaceRoot, flow.id);
  const now = new Date().toISOString();
  const storedFlow: RalphFlow = {
    ...flow,
    variables: validation.variables,
    createdAt: flow.createdAt ?? now,
    updatedAt: now,
  };

  await mkdir(directory, { recursive: true });

  if (options.createRevision && existsSync(flowPath)) {
    const revisionDirectory = getRalphRevisionDirectory(workspaceRoot, flow.id);
    await mkdir(revisionDirectory, { recursive: true });
    const revisionPath = createRalphRevisionFilePath(revisionDirectory, now);
    await writeFile(revisionPath, await readFile(flowPath, "utf8"), "utf8");
  }

  await writeFile(flowPath, `${JSON.stringify(storedFlow, null, 2)}\n`, "utf8");

  return flowPath;
};

export const listRalphFlows = async (
  workspaceRoot: string,
): Promise<RalphFlowSummary[]> => {
  const directory = getRalphFlowDirectory(workspaceRoot);

  if (!existsSync(directory)) {
    return [];
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const summaries: RalphFlowSummary[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name) !== FLOW_FILE_EXTENSION) {
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
        path,
        blockCount: 0,
        edgeCount: 0,
        variableCount: 0,
      });
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
): Promise<RalphFlowDeleteResult> => {
  const normalizedReference = normalizeFlowId(reference);

  if (!normalizedReference) {
    throw new Error("Expected Ralph flow id or alias.");
  }

  const directPath = getRalphFlowPath(workspaceRoot, normalizedReference);
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
    const resolution = await resolveRalphFlowReference(workspaceRoot, reference);
    flowId = normalizeOptionalString(resolution.flow.id) ?? resolution.id;
    flowPath = resolution.path;
  }

  await unlink(flowPath);

  const revisionDirectory = getRalphRevisionDirectory(workspaceRoot, flowId);
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
): Promise<RalphFlowRevisionSummary[]> => {
  const flowReference = await resolveRalphFlowReference(workspaceRoot, flowId);
  const directory = getRalphRevisionDirectory(workspaceRoot, flowReference.flow.id);

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
    const path = getRalphRevisionPath(workspaceRoot, flowId, id);
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
): Promise<{
  path: string;
  flow: RalphFlow;
  validation: RalphValidationResult;
  revision: RalphFlowRevisionSummary;
}> => {
  const flowReference = await resolveRalphFlowReference(workspaceRoot, flowId);
  const path = getRalphRevisionPath(workspaceRoot, flowReference.flow.id, revisionId);
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
  });
  const restoredFlow = await readRalphFlow(workspaceRoot, flowReference.flow.id, {
    allowInvalid: true,
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

const capRunRecordText = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  return truncateResultText(value);
};

const capRunRecordValue = (value: unknown, depth = 0): unknown => {
  if (typeof value === "string") {
    return truncateResultText(value);
  }

  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (depth >= 4) {
    return "[Ralph data truncated]";
  }

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => capRunRecordValue(entry, depth + 1));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, entry]) => [key, capRunRecordValue(entry, depth + 1)]),
    );
  }

  return undefined;
};

const createRalphRunRecordBlock = (
  blockResult: RalphBlockExecutionResult,
): RalphRunRecordBlock => {
  const task = capRunRecordText(blockResult.result?.task);
  const markdown = capRunRecordText(blockResult.markdown);
  const error = capRunRecordText(blockResult.error);

  return {
    blockId: blockResult.blockId,
    output: blockResult.output,
    status: blockResult.status,
    attempt: blockResult.attempt,
    ...(task ? { task } : {}),
    ...(blockResult.result?.status
      ? { executionStatus: blockResult.result.status }
      : {}),
    summary: truncateResultText(blockResult.summary),
    ...(blockResult.data !== undefined
      ? { data: capRunRecordValue(blockResult.data) }
      : {}),
    ...(markdown ? { markdown } : {}),
    ...(error ? { error } : {}),
  };
};

const createRalphRunRecord = (
  id: string,
  createdAt: string,
  flow: RalphFlow,
  result: RalphRunResult,
  variableValues: Record<string, string>,
): RalphRunRecord => {
  return {
    schemaVersion: RALPH_FLOW_SCHEMA_VERSION,
    id,
    createdAt,
    flowId: flow.id,
    flowName: flow.name,
    flowRevisionId: flow.updatedAt ?? flow.createdAt ?? null,
    status: result.status,
    summary: truncateResultText(result.summary),
    variableValues: Object.fromEntries(
      Object.entries(variableValues).map(([name, value]) => [
        name,
        truncateResultText(value),
      ]),
    ),
    events: result.events,
    blockResults: result.blockResults.map(createRalphRunRecordBlock),
    validation: {
      valid: result.validation.valid,
      errors: result.validation.errors,
      warnings: result.validation.warnings,
    },
  };
};

export const writeRalphRunRecord = async (
  workspaceRoot: string,
  flow: RalphFlow,
  result: RalphRunResult,
  options: {
    variableValues?: Record<string, string>;
  } = {},
): Promise<RalphRunRecordWriteResult> => {
  const createdAt = new Date().toISOString();
  const runDirectory = getRalphRunDirectory(workspaceRoot);
  await mkdir(runDirectory, { recursive: true });

  const { id, path } = createRalphRunFilePath(runDirectory, createdAt);
  const record = createRalphRunRecord(
    id,
    createdAt,
    flow,
    result,
    options.variableValues ?? {},
  );

  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  return { id, path, record };
};

const truncateResultText = (value: string): string => {
  if (value.length <= MAX_RALPH_RESULT_CHARS) {
    return value;
  }

  return `${value.slice(0, MAX_RALPH_RESULT_CHARS)}\n[Ralph result truncated at ${MAX_RALPH_RESULT_CHARS} characters.]`;
};

const getResultMarkdown = (result: TaskExecutionResult | undefined): string => {
  return truncateResultText(
    result?.response?.markdown ?? result?.summary ?? result?.reason ?? "",
  );
};

const parseDecision = (
  result: TaskExecutionResult | undefined,
): string | undefined => {
  const markdown = getResultMarkdown(result);
  const lines = markdown
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const match = lines.at(-1)?.match(DECISION_LINE_PATTERN);

  return match?.[1]?.toUpperCase();
};

const parseLastDecisionMarker = (
  result: TaskExecutionResult | undefined,
): string | undefined => {
  const markdown = getResultMarkdown(result);
  const decisions = markdown
    .split(/\r?\n/u)
    .map((line) => line.trim().match(DECISION_LINE_PATTERN)?.[1]?.toUpperCase())
    .filter((decision): decision is string => Boolean(decision));

  return decisions.at(-1);
};

export const parseRalphDecision = (
  result: TaskExecutionResult,
): RalphValidatorDecision | undefined => {
  const decision = parseDecision(result);

  return decision === "DONE" ||
    decision === "CONTINUE" ||
    decision === "RETRY" ||
    decision === "ERROR"
    ? decision
    : undefined;
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
  placeholder: ParsedPlaceholder,
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
    const value = readValuePath(result.data, reference.path);

    if (value === undefined) {
      return "";
    }

    return typeof value === "string" ? value : JSON.stringify(value);
  }

  return result.markdown ?? result.summary;
};

const resolveTemplateText = (text: string, context: RalphResultContext): string => {
  return text.replace(PLACEHOLDER_PATTERN, (raw: string, content: string) =>
    resolvePlaceholder(parsePlaceholderContent(raw, content.trim()), context),
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

const getRetryPolicy = (block: RalphFlowBlock): RalphRetryPolicy => {
  return block.settings?.retry ?? { mode: "infinite", maxRetries: null, delaySeconds: 0 };
};

const retryAllowsAnotherAttempt = (
  policy: RalphRetryPolicy,
  currentErrorCount: number,
): boolean => {
  if (policy.mode === "infinite") {
    return true;
  }

  return currentErrorCount <= (policy.maxRetries ?? 0);
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
  options: RalphRunOptions | RalphFlowGenerationOptions,
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

  return {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(runId ? { runId } : {}),
    ...(options.onStateChange ? { onStateChange: options.onStateChange } : {}),
    ...(conversationContext ? { conversationContext } : {}),
    ...(block?.settings?.timeoutSeconds
      ? { maxDurationMs: block.settings.timeoutSeconds * 1000 }
      : {}),
    ...(imageInputs.length > 0 ? { imageInputs } : {}),
  };
};

const emitRunEvent = async (
  events: RalphRunEvent[],
  event: RalphRunEvent,
  onEvent: RalphRunOptions["onEvent"],
): Promise<void> => {
  events.push(event);
  await onEvent?.(event);
};

const createBlockExecutionErrorResult = (
  block: RalphFlowBlock,
  error: unknown,
  attempt = 1,
): RalphBlockExecutionResult => {
  const message = error instanceof Error ? error.message : String(error);

  return {
    blockId: block.id,
    output: "ERROR",
    status: "error",
    attempt,
    summary: message,
    error: message,
  };
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
      return createBlockExecutionErrorResult(block, error, iteration);
    }

    conversationContext.history.push({ role: "user", content: task });
    conversationContext.history.push({
      role: "assistant",
      content: getResultMarkdown(result),
    });

    if (result.status !== "executed") {
      return {
        blockId: block.id,
        output: "ERROR",
        status: "error",
        attempt: iteration,
        result,
        summary: result.summary,
        markdown: getResultMarkdown(result),
        error: result.reason ?? result.summary,
      };
    }
  }

  if (!result) {
    return {
      blockId: block.id,
      output: "ERROR",
      status: "error",
      attempt: maxIterations,
      summary: `${block.title} did not produce a result.`,
      error: `${block.title} did not produce a result.`,
    };
  }

  return {
    blockId: block.id,
    output: "SUCCESS",
    status: "completed",
    attempt: maxIterations,
    result,
    summary: result?.summary ?? `${block.title} completed.`,
    markdown: getResultMarkdown(result),
  };
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

  try {
    result = await executeTask(
      createValidatorTask(flow, block, context),
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
    return createBlockExecutionErrorResult(block, error);
  }

  const decision = parseRalphDecision(result) ?? "ERROR";

  return {
    blockId: block.id,
    output: result.status === "executed" ? decision : "ERROR",
    status: result.status === "executed" && decision !== "ERROR" ? "completed" : "error",
    attempt: 1,
    result,
    summary: result.summary,
    markdown: getResultMarkdown(result),
    ...(decision === "ERROR" || result.status !== "executed"
      ? { error: result.reason ?? result.summary }
      : {}),
  };
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

  try {
    result = await executeTask(
      createDecisionTask(flow, block, context),
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
    return createBlockExecutionErrorResult(block, error);
  }

  const parsed = parseDecision(result);
  const output =
    result.status === "executed" && parsed && block.labels.includes(parsed)
      ? parsed
      : "ERROR";

  return {
    blockId: block.id,
    output,
    status: output === "ERROR" ? "error" : "completed",
    attempt: 1,
    result,
    summary: result.summary,
    markdown: getResultMarkdown(result),
    ...(output === "ERROR" ? { error: result.reason ?? result.summary } : {}),
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
  return coerceUtilityConfig(resolveTemplateValue(utility, context));
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

const parseJsonValue = (value: string): unknown => {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};

const normalizePathSegments = (path: string): string[] => {
  return path
    .trim()
    .replace(/^\$\.?/u, "")
    .replace(/\[(\d+)\]/gu, ".$1")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
};

const readValuePath = (value: unknown, path: string | undefined): unknown => {
  if (!path?.trim()) {
    return value;
  }

  let current = value;
  for (const segment of normalizePathSegments(path)) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }

    if (isRecord(current)) {
      current = current[segment];
      continue;
    }

    return undefined;
  }

  return current;
};

const toComparableString = (value: unknown): string => {
  return typeof value === "string" ? value : JSON.stringify(value);
};

const compareConditionValues = (
  actual: unknown,
  operator: RalphUtilityConditionOperator | undefined,
  expectedText: string | undefined,
): boolean => {
  const expected = expectedText !== undefined ? parseJsonValue(expectedText) : true;

  switch (operator ?? "truthy") {
    case "exists":
      return actual !== undefined && actual !== null;
    case "not-exists":
      return actual === undefined || actual === null;
    case "truthy":
      return Boolean(actual);
    case "falsy":
      return !actual;
    case "equals":
      return actual === expected;
    case "not-equals":
      return actual !== expected;
    case "contains":
      return toComparableString(actual).includes(String(expected));
    case "matches":
      return new RegExp(String(expected), "u").test(toComparableString(actual));
    case "gt":
      return Number(actual) > Number(expected);
    case "gte":
      return Number(actual) >= Number(expected);
    case "lt":
      return Number(actual) < Number(expected);
    case "lte":
      return Number(actual) <= Number(expected);
  }
};

const evaluateSimpleCondition = (
  expression: string,
  scope: unknown,
): boolean => {
  const match = expression.match(
    /^\s*([A-Za-z0-9_$.[\]-]+)\s*(==|!=|>=|<=|>|<|includes|matches)\s*([\s\S]+?)\s*$/u,
  );

  if (!match) {
    return Boolean(readValuePath(scope, expression));
  }

  const path = match[1] ?? "";
  const operatorToken = match[2] ?? "";
  const value = match[3] ?? "";
  const operatorMap: Record<string, RalphUtilityConditionOperator> = {
    "==": "equals",
    "!=": "not-equals",
    ">": "gt",
    ">=": "gte",
    "<": "lt",
    "<=": "lte",
    includes: "contains",
    matches: "matches",
  };

  return compareConditionValues(
    readValuePath(scope, path),
    operatorMap[operatorToken],
    value.replace(/^(['"])([\s\S]*)\1$/u, "$2"),
  );
};

const createConditionScope = (
  context: RalphResultContext,
  result?: unknown,
): Record<string, unknown> => {
  return {
    variables: context.variables,
    lastResult: context.lastResult,
    lastData: context.lastResult?.data,
    runLog: context.runLog,
    ...(isRecord(result) ? result : { result }),
  };
};

const evaluateUtilityCondition = (
  condition: RalphUtilityCondition,
  context: RalphResultContext,
  result?: unknown,
): boolean => {
  const scope = createConditionScope(context, result);

  switch (condition.style) {
    case "simple":
      return evaluateSimpleCondition(condition.expression ?? "", scope);
    case "json-path":
      return compareConditionValues(
        readValuePath(scope, condition.path),
        condition.operator,
        condition.value,
      );
    case "javascript": {
      const evaluator = new Function(
        "context",
        "result",
        "variables",
        "lastResult",
        "lastData",
        `"use strict"; return Boolean(${condition.expression ?? "false"});`,
      ) as (
        context: Record<string, unknown>,
        result: unknown,
        variables: Record<string, string>,
        lastResult: RalphBlockExecutionResult | undefined,
        lastData: unknown,
      ) => boolean;

      return evaluator(
        scope,
        result,
        context.variables,
        context.lastResult,
        context.lastResult?.data,
      );
    }
  }
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
      body: parseJsonValue(bodyText),
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
    if (evaluateUtilityCondition(condition, context)) {
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

      if (evaluateUtilityCondition(condition, context, data)) {
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

const getShellInvocation = (
  command: string,
): { executable: string; args: string[] } => {
  return process.platform === "win32"
    ? {
        executable: "powershell.exe",
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
  const acceptedExitCodes = checkMode
    ? Array.from({ length: 256 }, (_, index) => index)
    : utility.acceptedExitCodes ?? [0];

  try {
    const result = await executeLocalCommand(invocation.executable, invocation.args, {
      cwd: resolveUtilityPath(utility.cwd, config.workspaceRoot),
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
      cwd: resolveUtilityPath(utility.cwd, config.workspaceRoot),
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
    return createBlockExecutionErrorResult(block, error);
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
    return createBlockExecutionErrorResult(block, error);
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
    return createBlockExecutionErrorResult(block, error);
  }
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
    return createBlockExecutionErrorResult(block, error);
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
    return createBlockExecutionErrorResult(block, error);
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
      resolveMcpArguments(block.arguments, context),
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
      resolveMcpPromptArguments(block.arguments, context),
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

    if (block && blockCanExecute(block)) {
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
  const variables = discoverRalphFlowVariables(flow);
  const resolvedVariables = resolveVariableValues(variables, options.variableValues);
  const validation = validateRalphFlow(flow, {
    config,
    variableValues: resolvedVariables.values,
  });

  if (resolvedVariables.unknown.length > 0) {
    return createBlockedRunResult(
      flow,
      validation,
      `Unknown Ralph variable(s): ${resolvedVariables.unknown.join(", ")}.`,
      [],
      resolvedVariables.unknown,
    );
  }

  if (resolvedVariables.missing.length > 0) {
    return createBlockedRunResult(
      flow,
      validation,
      `Missing Ralph variable(s): ${resolvedVariables.missing.join(", ")}.`,
      resolvedVariables.missing,
    );
  }

  if (!validation.valid) {
    return createBlockedRunResult(
      flow,
      validation,
      `Ralph flow is invalid: ${validation.errors.join(" ")}`,
    );
  }

  const blockMap = getBlockById(flow);
  const start = flow.blocks.find((block): block is RalphStartBlock => block.type === "START");
  if (!start) {
    return createBlockedRunResult(flow, validation, "Ralph flow has no START block.");
  }

  const events: RalphRunEvent[] = [];
  const blockResults: RalphBlockExecutionResult[] = [];
  const runId = options.runId ?? `ralph-${flow.id}-${randomUUID()}`;
  const resultContext: RalphResultContext = {
    runId,
    resultsByBlock: new Map(),
    runLog: [],
    variables: resolvedVariables.values,
  };
  const errorCounts = new Map<string, number>();
  let currentBlockId: string | undefined = start.id;
  let transitions = 0;

  while (currentBlockId) {
    if (options.signal?.aborted) {
      const summary = "Ralph run stopped.";
      await emitRunEvent(events, { type: "end", blockId: currentBlockId, status: "stopped", summary }, options.onEvent);
      return {
        flow: flow.id,
        status: "stopped",
        summary,
        events,
        blockResults,
        missingVariables: [],
        unknownVariables: [],
        validation,
      };
    }

    if (options.maxTransitions !== null && options.maxTransitions !== undefined) {
      if (transitions >= options.maxTransitions) {
        const summary = `Ralph flow reached maxTransitions (${options.maxTransitions}).`;
        await emitRunEvent(
          events,
          { type: "crash", blockId: currentBlockId, output: "ERROR", reason: summary },
          options.onEvent,
        );
        return {
          flow: flow.id,
          status: "crashed",
          summary,
          events,
          blockResults,
          missingVariables: [],
          unknownVariables: [],
          validation,
        };
      }
    }

    const block = blockMap.get(currentBlockId);
    if (!block) {
      const summary = `Ralph flow routed to missing block \`${currentBlockId}\`.`;
      return {
        flow: flow.id,
        status: "crashed",
        summary,
        events,
        blockResults,
        missingVariables: [],
        unknownVariables: [],
        validation,
      };
    }

    await emitRunEvent(
      events,
      {
        type: "block-start",
        blockId: block.id,
        attempt: (errorCounts.get(block.id) ?? 0) + 1,
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

    if (block.type === "END") {
      const summary = `Ralph flow \`${flow.name}\` ended at \`${block.id}\`.`;
      await emitRunEvent(
        events,
        { type: "end", blockId: block.id, status: "completed", summary },
        options.onEvent,
      );
      return {
        flow: flow.id,
        status: "completed",
        summary,
        events,
        blockResults,
        missingVariables: [],
        unknownVariables: [],
        validation,
      };
    }

    if (result.output === "ERROR") {
      const nextErrorCount = (errorCounts.get(block.id) ?? 0) + 1;
      errorCounts.set(block.id, nextErrorCount);
      const retryPolicy = getRetryPolicy(block);

      if (retryAllowsAnotherAttempt(retryPolicy, nextErrorCount)) {
        await emitRunEvent(
          events,
          {
            type: "retry",
            blockId: block.id,
            attempt: nextErrorCount + 1,
            reason: result.error ?? result.summary,
          },
          options.onEvent,
        );
        await delay(retryPolicy.delaySeconds ?? 0, options.signal);
        transitions += 1;
        continue;
      }
    }

    const edge = findOutgoingEdge(flow, block.id, result.output);
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
      return {
        flow: flow.id,
        status: "crashed",
        summary,
        events,
        blockResults,
        missingVariables: [],
        unknownVariables: [],
        validation,
      };
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

    currentBlockId = nextBlockId;
    transitions += 1;
  }

  return {
    flow: flow.id,
    status: "crashed",
    summary: "Ralph flow stopped without reaching an END block.",
    events,
    blockResults,
    missingVariables: [],
    unknownVariables: [],
    validation,
  };
};

const createFlowGenerationTask = (
  flowPath: string,
  id: string,
  alias: string | undefined,
  name: string,
  prompt: string,
  target: RalphFlowGenerationOptions["target"],
  mode: RalphFlowGenerationOptions["mode"],
  existingFlow: RalphFlow | undefined,
  validatorFeedback: string | undefined,
): string => {
  return [
    "Create or update a Ralph flow graph.",
    "",
    "Write the finished flow JSON to this exact workspace path:",
    flowPath,
    "",
    "Ralph flow requirements:",
    "- Use graph blocks: START, PROMPT, VALIDATOR, DECISION, PACK, UTILITY, END.",
    "- Use exactly one START block and one or more END blocks.",
    "- Normal PROMPT blocks route with SUCCESS and ERROR; they do not need RALPH_DECISION markers.",
    "- VALIDATOR blocks must end with RALPH_DECISION: DONE, CONTINUE, RETRY, or ERROR.",
    "- VALIDATOR.CONTINUE needs an explicit edge.",
    "- VALIDATOR.RETRY may omit an edge; Ralph falls back to the validator group start.",
    "- DECISION blocks must define labels and end with RALPH_DECISION: <LABEL>.",
    "- UTILITY blocks run deterministic operations without an LLM. Available utility.type values: WAIT, HTTP_FETCH, POLL, RUN_COMMAND, READ_FILE, WRITE_FILE, SEARCH_FILES, RUN_CHECK, GIT_STATUS, SET_VARIABLE, TRANSFORM_JSON, VALIDATE_JSON, NOTIFY.",
    "- Use utility outputs exactly as produced: WAIT/SET_VARIABLE/NOTIFY use SUCCESS only; HTTP_FETCH uses SUCCESS, HTTP_ERROR, TIMEOUT, ERROR; POLL uses SUCCESS, ERROR, and TIMEOUT when maxAttempts is finite; RUN_CHECK uses SUCCESS, FAILED, ERROR; SEARCH_FILES uses SUCCESS, EMPTY, ERROR; VALIDATE_JSON uses SUCCESS, INVALID, ERROR.",
    "- Add variables directly in prompts using {{name:type=default}}, for example {{scope:path=ALL}}.",
    "- Use block result placeholders such as {{lastResult}}, {{summary:block-id}}, and {{result:block-id}} where useful.",
    "- Use structured utility data placeholders such as {{data:block-id:path.to.value}} where useful.",
    "- Put reusable context packs in PACK blocks or block settings.packs.",
    "- Keep block ids stable kebab-case.",
    "- Store graph positions so the canvas is readable.",
    "",
    `Generation target: ${target ?? "flow"}.`,
    `Generation mode: ${mode ?? "do-it"}.`,
    target === "prompt-block"
      ? "- Add or improve one focused PROMPT block in the existing graph, including routes needed to make it reachable and useful."
      : undefined,
    target === "refactor"
      ? "- Refactor or improve the existing graph while preserving its intent, ids, variables, and useful routes unless the user asks to change them."
      : undefined,
    mode === "interview"
      ? "- If the request is underspecified, prefer variables with defaults and validator/decision blocks that make assumptions explicit in the graph."
      : undefined,
    "",
    "Schema example:",
    JSON.stringify(
      {
        schemaVersion: RALPH_FLOW_SCHEMA_VERSION,
        id,
        ...(alias ? { alias } : {}),
        name,
        description: "Short description",
        blocks: [
          { id: "start", type: "START", title: "Start", position: { x: 0, y: 0 } },
          {
            id: "wait-before-work",
            type: "UTILITY",
            title: "Wait before work",
            utility: { type: "WAIT", mode: "delay", delaySeconds: 0 },
            position: { x: 260, y: 0 },
          },
          {
            id: "do-work",
            type: "PROMPT",
            title: "Do work",
            prompt: "Do the requested work for {{scope:path=ALL}}.",
            settings: {
              workspace: { mode: "default" },
              reasoning: "default",
              maxIterations: 1,
            },
            position: { x: 520, y: 0 },
          },
          {
            id: "validate-work",
            type: "VALIDATOR",
            title: "Validate work",
            prompt:
              "Validate the completed work for {{scope:path=ALL}}. End with RALPH_DECISION: DONE, CONTINUE, RETRY, or ERROR.",
            validationScope: { mode: "sinceLastValidator" },
            position: { x: 780, y: 0 },
          },
          {
            id: "success",
            type: "END",
            title: "Success",
            status: "success",
            position: { x: 1040, y: 0 },
          },
        ],
        edges: [
          { id: "start-to-wait", from: "start", fromOutput: "SUCCESS", to: "wait-before-work" },
          { id: "wait-to-work", from: "wait-before-work", fromOutput: "SUCCESS", to: "do-work" },
          { id: "work-to-validate", from: "do-work", fromOutput: "SUCCESS", to: "validate-work" },
          { id: "validate-done", from: "validate-work", fromOutput: "DONE", to: "success" },
          { id: "validate-continue", from: "validate-work", fromOutput: "CONTINUE", to: "do-work" },
        ],
      },
      null,
      2,
    ),
    "",
    existingFlow
      ? `<existing_flow>\n${JSON.stringify(existingFlow, null, 2)}\n</existing_flow>`
      : undefined,
    validatorFeedback
      ? `<validator_feedback>\n${validatorFeedback}\n</validator_feedback>`
      : undefined,
    "<user_request>",
    prompt,
    "</user_request>",
    "",
    "After writing the file, validate the graph against the rules above.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
};

const createFlowValidatorTask = (flowPath: string, prompt: string): string => {
  return [
    "Validate this generated Ralph flow graph as an independent reviewer.",
    "",
    `Read ${flowPath}. Verify it satisfies the user request, has one START, reachable END blocks, explicit CONTINUE routing, useful validator scopes, typed variables, readable positions, and no vague verifier-impossible criteria.`,
    "",
    "End with exactly one marker line:",
    "RALPH_DECISION: DONE",
    "or",
    "RALPH_DECISION: RETRY",
    "",
    "<user_request>",
    prompt,
    "</user_request>",
  ].join("\n");
};

const createBlockedGenerationResult = (
  flowPath: string,
  validation: RalphValidationResult,
  summary?: string,
): RalphFlowGenerationResult => {
  return {
    status: "blocked",
    flowPath,
    rounds: 0,
    validation,
    generatorResults: [],
    validatorResults: [],
    summary: summary ?? validation.errors[0] ?? "Invalid Ralph flow generation options.",
  };
};

const createTaskDidNotExecuteFeedback = (
  actor: "generator" | "validator",
  result: TaskExecutionResult,
): string => {
  return `The Ralph ${actor} did not execute successfully (${result.status}): ${
    result.reason ?? result.summary
  }`;
};

const createGenerationFeedbackExcerpt = (value: string | undefined): string => {
  const normalized = value?.replace(/\s+/gu, " ").trim() ?? "";

  return normalized.length > 1_200
    ? `${normalized.slice(0, 1_200)}...`
    : normalized;
};

const createGenerationDidNotConvergeSummary = (
  maxRounds: number,
  validation: RalphValidationResult,
  validatorFeedback: string | undefined,
): string => {
  const details: string[] = [];

  if (!validation.valid && validation.errors.length > 0) {
    details.push(`Last schema error: ${validation.errors[0]}`);
  }

  const feedback = createGenerationFeedbackExcerpt(validatorFeedback);

  if (feedback) {
    details.push(`Last feedback: ${feedback}`);
  }

  return [
    `Ralph flow generation did not converge after ${maxRounds} round(s).`,
    ...details,
  ].join(" ");
};

export const createRalphFlowWithAgent = async (
  workspaceRoot: string,
  options: RalphFlowGenerationOptions,
): Promise<RalphFlowGenerationResult> => {
  const alias = normalizeFlowAlias(options.name);
  const id = options.existingFlow?.id ?? randomUUID();
  const displayName = options.existingFlow?.name ?? options.name.trim();
  const flowPath = id
    ? getRalphFlowPath(workspaceRoot, id)
    : join(getRalphFlowDirectory(workspaceRoot), "flow.json");
  const generationFlowPath = join(
    getRalphFlowDirectory(workspaceRoot),
    `.${id}-generation-${randomUUID()}${FLOW_FILE_EXTENSION}`,
  );
  const maxRounds = options.maxRounds ?? DEFAULT_RALPH_GENERATION_MAX_ROUNDS;

  if (!alias) {
    return createBlockedGenerationResult(
      flowPath,
      createValidationResult([
        {
          code: "flow-id-required",
          message: "Expected a Ralph flow name before generation.",
        },
      ]),
    );
  }

  if (!options.prompt.trim()) {
    return createBlockedGenerationResult(
      flowPath,
      createValidationResult([
        {
          code: "prompt-required",
          message: "Expected a prompt before generating a Ralph flow.",
        },
      ]),
    );
  }

  if (
    !Number.isInteger(maxRounds) ||
    maxRounds < 1 ||
    maxRounds > MAX_RALPH_GENERATION_MAX_ROUNDS
  ) {
    return createBlockedGenerationResult(
      flowPath,
      createValidationResult([
        {
          code: "max-rounds-invalid",
          message: `maxRounds must be an integer from 1 to ${MAX_RALPH_GENERATION_MAX_ROUNDS}.`,
        },
      ]),
    );
  }

  const config =
    options.config ??
    (await loadRuntimeConfig(workspaceRoot, "machdoch", undefined, undefined, undefined));
  const customizations =
    options.customizations ??
    (await discoverCustomizations(workspaceRoot, {
      discoverUserCustomizations: true,
      discoverGithubCustomizations:
        Boolean(config.compatibility.discoverGithubCustomizations),
      includeDiagnostics: true,
    }));
  const generatorResults: TaskExecutionResult[] = [];
  const validatorResults: TaskExecutionResult[] = [];
  const generationRunId = options.runId ?? `ralph-generation-${id}-${randomUUID()}`;
  let validatorFeedback: string | undefined;
  let latestValidation = createValidationResult([]);

  await mkdir(getRalphFlowDirectory(workspaceRoot), { recursive: true });

  try {
    for (let round = 1; round <= maxRounds; round += 1) {
      const generatorExecutionOptions = await createExecutionOptions(
        { ...options, runId: generationRunId },
        config,
      );
      const generatorResult = await executeTask(
        createFlowGenerationTask(
          generationFlowPath,
          id,
          options.existingFlow?.alias ?? alias,
          displayName,
          options.prompt,
          options.target,
          options.mode,
          options.existingFlow,
          validatorFeedback,
        ),
        config,
        customizations,
        {
          ...generatorExecutionOptions,
          instructionAudience: "generator",
        },
      );
      generatorResults.push(generatorResult);

      if (generatorResult.status !== "executed") {
        return {
          status: "blocked",
          flowPath,
          rounds: round,
          validation: latestValidation,
          generatorResults,
          validatorResults,
          summary: createTaskDidNotExecuteFeedback("generator", generatorResult),
        };
      }

      let flow: RalphFlow;
      try {
        flow = parseRalphFlowJson(await readFile(generationFlowPath, "utf8"));
        flow = {
          ...flow,
          id,
          alias: flow.alias ?? options.existingFlow?.alias ?? alias,
          name: flow.name || displayName,
        };
        flow = normalizeRalphFlowLayout(flow);
      } catch (error) {
        validatorFeedback = `The generated file is not valid Ralph JSON: ${error instanceof Error ? error.message : String(error)}`;
        continue;
      }

      latestValidation = validateRalphFlow(flow, { config });
      if (!latestValidation.valid) {
        validatorFeedback = `The generated flow is invalid: ${latestValidation.errors.join(" ")}`;
        continue;
      }

      await writeFile(generationFlowPath, `${JSON.stringify(flow, null, 2)}\n`, "utf8");
      const validatorExecutionOptions = await createExecutionOptions(
        { ...options, runId: generationRunId },
        config,
      );
      const validatorResult = await executeTask(
        createFlowValidatorTask(generationFlowPath, options.prompt),
        config,
        customizations,
        {
          ...validatorExecutionOptions,
          instructionAudience: "validator",
        },
      );
      validatorResults.push(validatorResult);

      if (validatorResult.status !== "executed") {
        return {
          status: "blocked",
          flowPath,
          rounds: round,
          validation: latestValidation,
          generatorResults,
          validatorResults,
          summary: createTaskDidNotExecuteFeedback("validator", validatorResult),
        };
      }

      const validatorDecision = parseLastDecisionMarker(validatorResult);

      if (validatorDecision === "DONE") {
        await writeRalphFlow(workspaceRoot, flow, { createRevision: true });
        return {
          status: "created",
          flowPath,
          flow,
          rounds: round,
          validation: latestValidation,
          generatorResults,
          validatorResults,
          summary: `Created Ralph flow \`${flow.name}\` at ${flowPath}.`,
        };
      }

      const validatorMarkdown =
        validatorResult.response?.markdown ??
        validatorResult.reason ??
        validatorResult.summary;
      validatorFeedback = validatorDecision
        ? `The validator returned ${validatorDecision}. ${validatorMarkdown}`
        : `The validator did not return RALPH_DECISION: DONE or RALPH_DECISION: RETRY. Last validator output: ${validatorMarkdown}`;
    }

    return {
      status: "blocked",
      flowPath,
      rounds: maxRounds,
      validation: latestValidation,
      generatorResults,
      validatorResults,
      summary: createGenerationDidNotConvergeSummary(
        maxRounds,
        latestValidation,
        validatorFeedback,
      ),
    };
  } finally {
    await unlink(generationFlowPath).catch(() => undefined);
  }
};
