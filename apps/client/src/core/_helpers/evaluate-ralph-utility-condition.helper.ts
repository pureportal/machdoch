import type {
  RalphBlockExecutionResult,
  RalphUtilityCondition,
  RalphUtilityConditionOperator,
} from "../ralph.js";

export interface RalphUtilityConditionContext {
  lastResult?: RalphBlockExecutionResult;
  runLog: string[];
  variables: Record<string, string>;
  resultsByBlock?: Map<string, RalphBlockExecutionResult>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export const parseRalphUtilityJsonValue = (value: string): unknown => {
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

const normalizeRalphUtilityPathSegments = (path: string): string[] => {
  return path
    .trim()
    .replace(/^\$\.?/u, "")
    .replace(/\[(\d+)\]/gu, ".$1")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
};

export const readRalphUtilityValuePath = (
  value: unknown,
  path: string | undefined,
): unknown => {
  if (!path?.trim()) {
    return value;
  }

  let current = value;
  for (const segment of normalizeRalphUtilityPathSegments(path)) {
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

const compareRalphUtilityConditionValues = (
  condition: RalphUtilityCondition,
  actual: unknown,
  scope: Record<string, unknown>,
): boolean => {
  const expected =
    condition.valuePath !== undefined
      ? readRalphUtilityValuePath(scope, condition.valuePath)
      : condition.value !== undefined
        ? parseRalphUtilityJsonValue(condition.value)
        : true;

  switch (condition.operator ?? "truthy") {
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
    case "is-one-of":
      return (
        typeof actual === "string" &&
        condition.matchValues?.includes(actual) === true
      );
    case "non-empty-string":
      return typeof actual === "string" && actual.trim().length > 0;
    case "non-empty-array":
      return Array.isArray(actual) && actual.length > 0;
    case "non-empty-record":
      return isRecord(actual) && Object.keys(actual).length > 0;
    case "equals-path":
      return condition.valuePath !== undefined && actual === expected;
    case "array-every": {
      const itemCondition = condition.itemCondition;
      return (
        Array.isArray(actual) &&
        itemCondition !== undefined &&
        actual.every((item) =>
          evaluateRalphUtilityConditionInScope(itemCondition, {
            ...scope,
            result: item,
            item,
          }),
        )
      );
    }
  }
};

const assertRalphUtilityConditionValue = (
  condition: RalphUtilityCondition,
  actual: unknown,
): void => {
  if (
    condition.allowedValues &&
    (typeof actual !== "string" || !condition.allowedValues.includes(actual))
  ) {
    throw new Error(
      condition.invalidMessage ??
        `Condition path ${condition.path ?? "value"} is missing or invalid.`,
    );
  }
};

const evaluateSimpleRalphUtilityCondition = (
  expression: string,
  scope: unknown,
): boolean => {
  const match = expression.match(
    /^\s*([A-Za-z0-9_$.[\]-]+)\s*(==|!=|>=|<=|>|<|includes|matches)\s*([\s\S]+?)\s*$/u,
  );

  if (!match) {
    return Boolean(readRalphUtilityValuePath(scope, expression));
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
  const operator = operatorMap[operatorToken] ?? "truthy";

  return compareRalphUtilityConditionValues(
    {
      style: "simple",
      operator,
      value: value.replace(/^(['"])([\s\S]*)\1$/u, "$2"),
    },
    readRalphUtilityValuePath(scope, path),
    isRecord(scope) ? scope : { result: scope },
  );
};

const createRalphUtilityConditionScope = (
  context: RalphUtilityConditionContext,
  result?: unknown,
): Record<string, unknown> => {
  const resultsByBlock = context.resultsByBlock
    ? Object.fromEntries(context.resultsByBlock.entries())
    : undefined;

  return {
    variables: context.variables,
    lastResult: context.lastResult,
    lastData: context.lastResult?.data,
    runLog: context.runLog,
    ...(resultsByBlock ? { resultsByBlock } : {}),
    result,
    ...(isRecord(result) ? result : {}),
  };
};

export const evaluateRalphUtilityCondition = (
  condition: RalphUtilityCondition,
  context: RalphUtilityConditionContext,
  result?: unknown,
): boolean => {
  const scope = createRalphUtilityConditionScope(context, result);

  return evaluateRalphUtilityConditionInScope(condition, scope);
};

function evaluateRalphUtilityConditionInScope(
  condition: RalphUtilityCondition,
  scope: Record<string, unknown>,
): boolean {
  let matched: boolean;
  switch (condition.style) {
    case "simple":
      matched = evaluateSimpleRalphUtilityCondition(
        condition.expression ?? "",
        scope,
      );
      break;
    case "json-path": {
      const actual = readRalphUtilityValuePath(scope, condition.path);
      assertRalphUtilityConditionValue(condition, actual);
      matched = compareRalphUtilityConditionValues(condition, actual, scope);
      break;
    }
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

      matched = evaluator(
        scope,
        scope.result,
        (scope.variables as Record<string, string> | undefined) ?? {},
        scope.lastResult as RalphBlockExecutionResult | undefined,
        (scope.lastResult as RalphBlockExecutionResult | undefined)?.data,
      );
      break;
    }
  }

  if (!matched && condition.assertMatch) {
    throw new Error(
      condition.invalidMessage ??
        `Condition path ${condition.path ?? "value"} is missing or invalid.`,
    );
  }

  const conditions = condition.conditions ?? [];
  if (conditions.length === 0) {
    return matched;
  }

  if (condition.combinator === "any") {
    return (
      matched ||
      conditions.some((nested) =>
        evaluateRalphUtilityConditionInScope(nested, scope),
      )
    );
  }
  return (
    matched &&
    conditions.every((nested) =>
      evaluateRalphUtilityConditionInScope(nested, scope),
    )
  );
}
