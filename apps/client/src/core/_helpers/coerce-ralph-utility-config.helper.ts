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
import {
  isRalphScopeOutcome,
  normalizeRalphScopeSelectionStrategy,
} from "./ralph-scope-registry.helper.js";
import type { RalphDeterministicJsonTransform } from "./ralph-repository-work-yield.helper.js";

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
  "ASSESS_JSON_TASKS",
  "SELECT_JSON_TASK",
  "MARK_JSON_TASK",
  "CHANGE_SCOPE_GUARD",
  "SCAN_SCOPE_EVIDENCE",
  "UPDATE_SCOPE_REGISTRY",
  "BEGIN_SCOPE_CYCLE",
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

export class InvalidRalphUtilityConfigurationError extends TypeError {
  readonly field: "type" | "condition" | "deterministicTransform";
  readonly value: unknown;

  constructor(
    field: InvalidRalphUtilityConfigurationError["field"],
    value: unknown,
  ) {
    super(`Ralph utility config contains an invalid ${field}.`);
    this.name = "InvalidRalphUtilityConfigurationError";
    this.field = field;
    this.value = value;
  }
}

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

  const numbers = value.filter((entry): entry is number =>
    Number.isInteger(entry),
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

const coerceFiniteNumberOrTemplate = (
  value: unknown,
): number | string | undefined => {
  const number = coerceFiniteNumber(value);

  if (number !== undefined) {
    return number;
  }

  if (
    typeof value === "string" &&
    value.includes("{{") &&
    value.includes("}}")
  ) {
    return value;
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
    value === "lte" ||
    value === "is-one-of" ||
    value === "non-empty-string" ||
    value === "non-empty-array" ||
    value === "non-empty-record" ||
    value === "equals-path" ||
    value === "array-every"
    ? value
    : undefined;
};

const coerceUtilityCondition = (
  value: unknown,
  depth = 0,
): RalphUtilityCondition | undefined => {
  if (!isRecord(value) || depth > 16) {
    return undefined;
  }

  const style =
    value.style === undefined
      ? "simple"
      : coerceUtilityConditionStyle(value.style);
  const operator = coerceUtilityConditionOperator(value.operator);
  if (
    !style ||
    (value.operator !== undefined && !operator) ||
    (value.expression !== undefined && typeof value.expression !== "string") ||
    (value.path !== undefined && typeof value.path !== "string") ||
    (value.value !== undefined && typeof value.value !== "string") ||
    (value.valuePath !== undefined && typeof value.valuePath !== "string") ||
    (value.invalidMessage !== undefined &&
      typeof value.invalidMessage !== "string") ||
    (value.assertMatch !== undefined &&
      typeof value.assertMatch !== "boolean") ||
    (value.combinator !== undefined &&
      value.combinator !== "all" &&
      value.combinator !== "any") ||
    (value.matchValues !== undefined &&
      (!Array.isArray(value.matchValues) ||
        !value.matchValues.every((entry) => typeof entry === "string"))) ||
    (value.allowedValues !== undefined &&
      (!Array.isArray(value.allowedValues) ||
        !value.allowedValues.every((entry) => typeof entry === "string"))) ||
    (value.conditions !== undefined && !Array.isArray(value.conditions))
  ) {
    return undefined;
  }

  const nestedConditions = (value.conditions ?? []).map((condition) =>
    coerceUtilityCondition(condition, depth + 1),
  );
  if (
    !nestedConditions.every(
      (condition): condition is RalphUtilityCondition =>
        condition !== undefined,
    )
  ) {
    return undefined;
  }

  const itemCondition =
    value.itemCondition === undefined
      ? undefined
      : coerceUtilityCondition(value.itemCondition, depth + 1);
  if (value.itemCondition !== undefined && !itemCondition) {
    return undefined;
  }

  return {
    style,
    ...(typeof value.expression === "string"
      ? { expression: value.expression }
      : {}),
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(operator ? { operator } : {}),
    ...(typeof value.value === "string" ? { value: value.value } : {}),
    ...(typeof value.valuePath === "string"
      ? { valuePath: value.valuePath }
      : {}),
    ...(Array.isArray(value.matchValues)
      ? { matchValues: [...value.matchValues] }
      : {}),
    ...(Array.isArray(value.allowedValues)
      ? { allowedValues: [...value.allowedValues] }
      : {}),
    ...(typeof value.invalidMessage === "string"
      ? { invalidMessage: value.invalidMessage }
      : {}),
    ...(typeof value.assertMatch === "boolean"
      ? { assertMatch: value.assertMatch }
      : {}),
    ...(value.combinator === "all" || value.combinator === "any"
      ? { combinator: value.combinator }
      : {}),
    ...(nestedConditions.length > 0 ? { conditions: nestedConditions } : {}),
    ...(itemCondition ? { itemCondition } : {}),
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
    ...(typeof value.healthUrl === "string"
      ? { healthUrl: value.healthUrl }
      : {}),
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

    const width =
      typeof entry.width === "number" ? Math.trunc(entry.width) : NaN;
    const height =
      typeof entry.height === "number" ? Math.trunc(entry.height) : NaN;

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

const coerceUtilityEncoding = (value: unknown): BufferEncoding | undefined => {
  return value === "utf8" ||
    value === "utf-8" ||
    value === "base64" ||
    value === "hex" ||
    value === "latin1" ||
    value === "ascii"
    ? value === "utf-8"
      ? "utf8"
      : value
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

const coerceDeterministicJsonTransform = (
  value: unknown,
): RalphDeterministicJsonTransform | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    value.type === "repository-work-yield" &&
    typeof value.baselineBlockId === "string" &&
    typeof value.currentBlockId === "string" &&
    (value.scopeGuardBlockId === undefined ||
      typeof value.scopeGuardBlockId === "string") &&
    (value.workItemBlockId === undefined ||
      typeof value.workItemBlockId === "string") &&
    (value.excludedPaths === undefined ||
      (Array.isArray(value.excludedPaths) &&
        value.excludedPaths.every((entry) => typeof entry === "string"))) &&
    (value.trackPrevious === undefined ||
      typeof value.trackPrevious === "boolean") &&
    (value.verifyOnObservationError === undefined ||
      typeof value.verifyOnObservationError === "boolean")
  ) {
    return {
      type: value.type,
      baselineBlockId: value.baselineBlockId,
      currentBlockId: value.currentBlockId,
      ...(typeof value.scopeGuardBlockId === "string"
        ? { scopeGuardBlockId: value.scopeGuardBlockId }
        : {}),
      ...(typeof value.workItemBlockId === "string"
        ? { workItemBlockId: value.workItemBlockId }
        : {}),
      ...(Array.isArray(value.excludedPaths)
        ? { excludedPaths: [...value.excludedPaths] }
        : {}),
      ...(typeof value.trackPrevious === "boolean"
        ? { trackPrevious: value.trackPrevious }
        : {}),
      ...(typeof value.verifyOnObservationError === "boolean"
        ? { verifyOnObservationError: value.verifyOnObservationError }
        : {}),
    };
  }

  if (
    value.type === "verification-command" &&
    typeof value.selectionBlockId === "string" &&
    typeof value.selectionPath === "string" &&
    typeof value.commandsBlockId === "string" &&
    typeof value.configuredCommandVariable === "string"
  ) {
    return {
      type: value.type,
      selectionBlockId: value.selectionBlockId,
      selectionPath: value.selectionPath,
      commandsBlockId: value.commandsBlockId,
      configuredCommandVariable: value.configuredCommandVariable,
    };
  }

  if (
    value.type === "code-improvement-plan" &&
    typeof value.draftBlockId === "string" &&
    typeof value.selectionBlockId === "string" &&
    typeof value.constitutionBlockId === "string" &&
    typeof value.researchBlockId === "string"
  ) {
    return {
      type: value.type,
      draftBlockId: value.draftBlockId,
      selectionBlockId: value.selectionBlockId,
      constitutionBlockId: value.constitutionBlockId,
      researchBlockId: value.researchBlockId,
    };
  }

  if (
    value.type === "visual-runtime" &&
    typeof value.commandsBlockId === "string" &&
    typeof value.targetUrlVariable === "string" &&
    typeof value.healthUrlVariable === "string" &&
    typeof value.serverCommandVariable === "string" &&
    typeof value.serverCwdVariable === "string" &&
    typeof value.screenshotPathVariable === "string"
  ) {
    return {
      type: value.type,
      commandsBlockId: value.commandsBlockId,
      targetUrlVariable: value.targetUrlVariable,
      healthUrlVariable: value.healthUrlVariable,
      serverCommandVariable: value.serverCommandVariable,
      serverCwdVariable: value.serverCwdVariable,
      screenshotPathVariable: value.screenshotPathVariable,
    };
  }

  return undefined;
};

export const coerceRalphUtilityConfig = (
  value: unknown,
): RalphUtilityConfig => {
  if (!isRecord(value)) {
    throw new InvalidRalphUtilityConfigurationError("type", value);
  }

  const record = value;
  if (!isRalphUtilityType(record.type)) {
    throw new InvalidRalphUtilityConfigurationError("type", record.type);
  }
  const type = record.type;
  const mode = coerceUtilityWaitMode(record.mode);
  const condition = coerceUtilityCondition(record.condition);
  const headers = coerceStringRecord(record.headers);
  const env = coerceStringRecord(record.env);
  const acceptedExitCodes = coerceNumberArray(record.acceptedExitCodes);
  const maxAttempts =
    record.maxAttempts === null
      ? null
      : coerceFiniteNumberOrTemplate(record.maxAttempts);
  const maxTasks = coerceFiniteNumberOrTemplate(record.maxTasks);
  const maxResults = coerceFiniteNumberOrTemplate(record.maxResults);
  const maxDepth = coerceFiniteNumberOrTemplate(record.maxDepth);
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
  const deterministicTransform = coerceDeterministicJsonTransform(
    record.deterministicTransform,
  );
  if (record.condition !== undefined && !condition) {
    throw new InvalidRalphUtilityConfigurationError(
      "condition",
      record.condition,
    );
  }
  if (record.deterministicTransform !== undefined && !deterministicTransform) {
    throw new InvalidRalphUtilityConfigurationError(
      "deterministicTransform",
      record.deterministicTransform,
    );
  }

  return {
    type,
    ...(record.replayPolicy === "safe" || record.replayPolicy === "at-most-once"
      ? { replayPolicy: record.replayPolicy }
      : {}),
    ...(record.workOutcome === "DONE" ||
    record.workOutcome === "DEFER" ||
    record.workOutcome === "STOP" ||
    record.workOutcome === "BLOCKED" ||
    record.workOutcome === "INVALID"
      ? { workOutcome: record.workOutcome }
      : {}),
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
    ...(typeof record.jsonPath === "string"
      ? { jsonPath: record.jsonPath }
      : {}),
    ...(rootPath ? { rootPath } : {}),
    ...(typeof record.content === "string" ? { content: record.content } : {}),
    ...(typeof record.append === "boolean" ? { append: record.append } : {}),
    ...(encoding ? { encoding } : {}),
    ...(pattern ? { pattern } : {}),
    ...(glob ? { glob } : {}),
    ...(maxResults !== undefined ? { maxResults } : {}),
    ...(record.order === "oldest" || record.order === "newest"
      ? { order: record.order }
      : {}),
    ...(maxTasks !== undefined ? { maxTasks } : {}),
    ...(maxDepth !== undefined ? { maxDepth } : {}),
    ...(typeof record.excludePaths === "string"
      ? { excludePaths: record.excludePaths }
      : {}),
    ...(typeof record.flowAlias === "string"
      ? { flowAlias: record.flowAlias }
      : {}),
    ...(strategy ? { strategy } : {}),
    ...(typeof record.scopeId === "string" ? { scopeId: record.scopeId } : {}),
    ...(isRalphScopeOutcome(record.scopeOutcome)
      ? { scopeOutcome: record.scopeOutcome }
      : {}),
    ...(typeof record.taskId === "string" ? { taskId: record.taskId } : {}),
    ...(typeof record.status === "string" ? { status: record.status } : {}),
    ...(typeof record.result === "string" ? { result: record.result } : {}),
    ...(typeof record.includeMarkdown === "boolean"
      ? { includeMarkdown: record.includeMarkdown }
      : {}),
    ...(typeof record.forceNew === "boolean"
      ? { forceNew: record.forceNew }
      : {}),
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
    ...(record.verificationRole === "baseline" ||
    record.verificationRole === "candidate" ||
    record.verificationRole === "supplemental"
      ? { verificationRole: record.verificationRole }
      : {}),
    ...(typeof record.baselineBlockId === "string"
      ? { baselineBlockId: record.baselineBlockId }
      : {}),
    ...(typeof record.verificationPlanId === "string"
      ? { verificationPlanId: record.verificationPlanId }
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
    ...(typeof record.fullPage === "boolean"
      ? { fullPage: record.fullPage }
      : {}),
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
    ...(typeof record.baseline === "string"
      ? { baseline: record.baseline }
      : {}),
    ...(typeof record.expression === "string"
      ? { expression: record.expression }
      : {}),
    ...(deterministicTransform ? { deterministicTransform } : {}),
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
