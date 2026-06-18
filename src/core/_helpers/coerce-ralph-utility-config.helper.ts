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

export const RALPH_UTILITY_TYPES = [
  "WAIT",
  "HTTP_FETCH",
  "POLL",
  "RUN_COMMAND",
  "READ_FILE",
  "WRITE_FILE",
  "SEARCH_FILES",
  "RUN_CHECK",
  "UI_ANALYZE",
  "GIT_STATUS",
  "SET_VARIABLE",
  "TRANSFORM_JSON",
  "VALIDATE_JSON",
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
  const encoding = coerceUtilityEncoding(record.encoding);
  const adapter = coerceUiAnalyzeAdapter(record.adapter);
  const server = coerceUiAnalyzeServer(record.server);
  const viewports = coerceUiAnalyzeViewports(record.viewports);
  const checks = coerceUiAnalyzeChecks(record.checks);
  const waitUntil = coerceUiAnalyzeWaitUntil(record.waitUntil);
  const mcpArguments = coerceRalphMcpArguments(record.mcpArguments);
  const rootPath = coerceFirstString(
    record.rootPath,
    record.root,
    record.sourceRoot,
    record.directory,
  );
  const pattern = coerceFirstString(record.pattern);
  const glob = coerceFirstString(record.glob, record.patterns, record.globs);

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
    ...(rootPath ? { rootPath } : {}),
    ...(typeof record.content === "string" ? { content: record.content } : {}),
    ...(typeof record.append === "boolean" ? { append: record.append } : {}),
    ...(encoding ? { encoding } : {}),
    ...(pattern ? { pattern } : {}),
    ...(glob ? { glob } : {}),
    ...(typeof record.maxResults === "number"
      ? { maxResults: record.maxResults }
      : {}),
    ...(typeof record.command === "string" ? { command: record.command } : {}),
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
