import type {
  RalphUiAnalyzeAdapter,
  RalphUiAnalyzeChecks,
  RalphUiAnalyzeServer,
  RalphUiAnalyzeServerMode,
  RalphUiAnalyzeViewport,
  RalphUiAnalyzeWaitUntil,
  RalphUtilityCondition,
  RalphUtilityConditionOperator,
  RalphUtilityConfig,
  RalphUtilityConditionStyle,
  RalphUtilityWaitMode,
} from "../ralph.js";
import { normalizeRalphScopeSelectionStrategy } from "./ralph-scope-registry.helper.js";

export const RALPH_UTILITY_TYPES = [
  "WAIT",
  "HTTP_FETCH",
  "POLL",
  "CONDITION",
  "RUN_COMMAND",
  "READ_FILE",
  "WRITE_FILE",
  "READ_JSON",
  "WRITE_JSON",
  "PATCH_JSON",
  "APPEND_JSONL",
  "READ_JSONL",
  "QUERY_JSONL",
  "FILE_EXISTS",
  "DELETE_FILE",
  "MOVE_FILE",
  "ARCHIVE_FILE",
  "LOOP_COUNTER",
  "PROMPT_JSON",
  "VALIDATOR_JSON",
  "SELECT_JSON_TASK",
  "MARK_JSON_TASK",
  "CHANGE_SCOPE_GUARD",
  "SCAN_SCOPE_EVIDENCE",
  "UPDATE_SCOPE_REGISTRY",
  "SELECT_SCOPE",
  "MARK_SCOPE_RESULT",
  "SEARCH_FILES",
  "RUN_CHECK",
  "UI_ANALYZE",
  "GIT_STATUS",
  "GIT_SNAPSHOT",
  "GIT_DIFF_SUMMARY",
  "DETECT_PROJECT_COMMANDS",
  "SET_VARIABLE",
  "TRANSFORM_JSON",
  "VALIDATE_JSON",
  "FINAL_REPORT",
  "NOTIFY",
] as const;

type RalphUtilityType = (typeof RALPH_UTILITY_TYPES)[number];

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const coerceRalphMcpArguments = (
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

const coerceFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
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

const coerceUiAnalyzeAdapter = (
  value: unknown,
): RalphUiAnalyzeAdapter | undefined => {
  return value === "auto" ||
    value === "browser" ||
    value === "image" ||
    value === "playwright-mcp" ||
    value === "tauri-mcp"
    ? value
    : undefined;
};

const coerceUiAnalyzeServerMode = (
  value: unknown,
): RalphUiAnalyzeServerMode | undefined => {
  return value === "existing" || value === "managed" || value === "none"
    ? value
    : undefined;
};

const coerceUiAnalyzeWaitUntil = (
  value: unknown,
): RalphUiAnalyzeWaitUntil | undefined => {
  return value === "load" ||
    value === "domcontentloaded" ||
    value === "networkidle" ||
    value === "commit"
    ? value
    : undefined;
};

const coerceUiAnalyzeServer = (
  value: unknown,
): RalphUiAnalyzeServer | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const mode = coerceUiAnalyzeServerMode(value.mode);

  return {
    ...(mode ? { mode } : {}),
    ...(typeof value.healthUrl === "string" ? { healthUrl: value.healthUrl } : {}),
    ...(typeof value.command === "string" ? { command: value.command } : {}),
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    ...(typeof value.reuseExisting === "boolean"
      ? { reuseExisting: value.reuseExisting }
      : {}),
  };
};

const coerceUiAnalyzeViewports = (
  value: unknown,
): RalphUiAnalyzeViewport[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const viewports = value.flatMap((entry): RalphUiAnalyzeViewport[] => {
    if (!isRecord(entry)) {
      return [];
    }

    const width = typeof entry.width === "number" ? Math.trunc(entry.width) : NaN;
    const height = typeof entry.height === "number" ? Math.trunc(entry.height) : NaN;

    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      return [];
    }

    return [
      {
        ...(typeof entry.name === "string" ? { name: entry.name } : {}),
        width,
        height,
      },
    ];
  });

  return viewports.length > 0 ? viewports : undefined;
};

const coerceUiAnalyzeChecks = (
  value: unknown,
): RalphUiAnalyzeChecks | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const checks: RalphUiAnalyzeChecks = {};

  for (const key of [
    "screenshots",
    "accessibility",
    "console",
    "network",
    "responsive",
    "trace",
  ] as const) {
    if (typeof value[key] === "boolean") {
      checks[key] = value[key];
    }
  }

  return Object.keys(checks).length > 0 ? checks : undefined;
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

const coerceJsonPatchMode = (
  value: unknown,
): RalphUtilityConfig["jsonPatchMode"] | undefined => {
  return value === "merge" || value === "replace" ? value : undefined;
};

const coerceFirstString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === "string") {
      return value;
    }

    if (Array.isArray(value)) {
      const firstString = value.find(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      );

      if (firstString) {
        return firstString;
      }
    }
  }

  return undefined;
};

export const coerceRalphUtilityConfig = (
  value: unknown,
): RalphUtilityConfig => {
  const record = isRecord(value) ? value : {};
  const type = isRalphUtilityType(record.type) ? record.type : "WAIT";
  const mode = coerceUtilityWaitMode(record.mode);
  const condition = coerceUtilityCondition(record.condition);
  const headers = coerceStringRecord(record.headers);
  const env = coerceStringRecord(record.env);
  const acceptedExitCodes = coerceNumberArray(record.acceptedExitCodes);
  const maxAttempts =
    record.maxAttempts === null ? null : coerceFiniteNumber(record.maxAttempts);
  const encoding = coerceUtilityEncoding(record.encoding);
  const adapter = coerceUiAnalyzeAdapter(record.adapter);
  const server = coerceUiAnalyzeServer(record.server);
  const viewports = coerceUiAnalyzeViewports(record.viewports);
  const checks = coerceUiAnalyzeChecks(record.checks);
  const waitUntil = coerceUiAnalyzeWaitUntil(record.waitUntil);
  const mcpArguments = coerceRalphMcpArguments(record.mcpArguments);
  const jsonPatchMode = coerceJsonPatchMode(record.jsonPatchMode);
  const rootPath = coerceFirstString(
    record.rootPath,
    record.root,
    record.sourceRoot,
    record.directory,
  );
  const pattern = coerceFirstString(record.pattern);
  const glob = coerceFirstString(record.glob, record.patterns, record.globs);
  const strategy = normalizeRalphScopeSelectionStrategy(record.strategy);

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
    ...(maxAttempts !== undefined || maxAttempts === null
      ? { maxAttempts }
      : {}),
    ...(condition ? { condition } : {}),
    ...(typeof record.url === "string" ? { url: record.url } : {}),
    ...(typeof record.method === "string" ? { method: record.method } : {}),
    ...(headers ? { headers } : {}),
    ...(typeof record.body === "string" ? { body: record.body } : {}),
    ...(typeof record.outputPath === "string"
      ? { outputPath: record.outputPath }
      : {}),
    ...(typeof record.markdownPath === "string"
      ? { markdownPath: record.markdownPath }
      : {}),
    ...(typeof record.path === "string" ? { path: record.path } : {}),
    ...(typeof record.registryPath === "string"
      ? { registryPath: record.registryPath }
      : {}),
    ...(typeof record.jsonPath === "string" ? { jsonPath: record.jsonPath } : {}),
    ...(rootPath ? { rootPath } : {}),
    ...(typeof record.content === "string" ? { content: record.content } : {}),
    ...(typeof record.append === "boolean" ? { append: record.append } : {}),
    ...(encoding ? { encoding } : {}),
    ...(pattern ? { pattern } : {}),
    ...(glob ? { glob } : {}),
    ...(typeof record.maxResults === "number"
      ? { maxResults: record.maxResults }
      : {}),
    ...(typeof record.maxDepth === "number"
      ? { maxDepth: record.maxDepth }
      : {}),
    ...(typeof record.excludePaths === "string"
      ? { excludePaths: record.excludePaths }
      : {}),
    ...(typeof record.flowAlias === "string"
      ? { flowAlias: record.flowAlias }
      : {}),
    ...(strategy ? { strategy } : {}),
    ...(typeof record.scopeId === "string" ? { scopeId: record.scopeId } : {}),
    ...(typeof record.taskId === "string" ? { taskId: record.taskId } : {}),
    ...(typeof record.status === "string" ? { status: record.status } : {}),
    ...(typeof record.result === "string" ? { result: record.result } : {}),
    ...(typeof record.includeMarkdown === "boolean"
      ? { includeMarkdown: record.includeMarkdown }
      : {}),
    ...(typeof record.forceNew === "boolean" ? { forceNew: record.forceNew } : {}),
    ...(typeof record.reset === "boolean" ? { reset: record.reset } : {}),
    ...(typeof record.enforce === "boolean" ? { enforce: record.enforce } : {}),
    ...(jsonPatchMode ? { jsonPatchMode } : {}),
    ...(typeof record.counterName === "string"
      ? { counterName: record.counterName }
      : {}),
    ...(typeof record.counterKey === "string"
      ? { counterKey: record.counterKey }
      : {}),
    ...(typeof record.command === "string" ? { command: record.command } : {}),
    ...(typeof record.fallbackCommand === "string"
      ? { fallbackCommand: record.fallbackCommand }
      : {}),
    ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
    ...(env ? { env } : {}),
    ...(adapter ? { adapter } : {}),
    ...(typeof record.targetUrl === "string"
      ? { targetUrl: record.targetUrl }
      : {}),
    ...(typeof record.screenshotPath === "string"
      ? { screenshotPath: record.screenshotPath }
      : {}),
    ...(server ? { server } : {}),
    ...(viewports ? { viewports } : {}),
    ...(checks ? { checks } : {}),
    ...(typeof record.fullPage === "boolean" ? { fullPage: record.fullPage } : {}),
    ...(waitUntil ? { waitUntil } : {}),
    ...(typeof record.mcpServerId === "string"
      ? { mcpServerId: record.mcpServerId }
      : {}),
    ...(typeof record.mcpToolName === "string"
      ? { mcpToolName: record.mcpToolName }
      : {}),
    ...(mcpArguments ? { mcpArguments } : {}),
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
    ...(typeof record.baseline === "string" ? { baseline: record.baseline } : {}),
    ...(typeof record.expression === "string"
      ? { expression: record.expression }
      : {}),
    ...(typeof record.prompt === "string" ? { prompt: record.prompt } : {}),
    ...(Object.hasOwn(record, "schema") ? { schema: record.schema } : {}),
    ...(typeof record.structuredOutput === "boolean"
      ? { structuredOutput: record.structuredOutput }
      : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...(typeof record.ignoreErrors === "boolean"
      ? { ignoreErrors: record.ignoreErrors }
      : {}),
  };
};
