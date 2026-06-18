import type {
  RalphBlockExecutionResult,
  RalphUtilityCondition,
  RalphUtilityConditionOperator,
} from "../ralph.js";

export interface RalphUtilityConditionContext {
  lastResult?: RalphBlockExecutionResult;
  runLog: string[];
  variables: Record<string, string>;
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
  actual: unknown,
  operator: RalphUtilityConditionOperator | undefined,
  expectedText: string | undefined,
): boolean => {
  const expected =
    expectedText !== undefined ? parseRalphUtilityJsonValue(expectedText) : true;

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

  return compareRalphUtilityConditionValues(
    readRalphUtilityValuePath(scope, path),
    operatorMap[operatorToken],
    value.replace(/^(['"])([\s\S]*)\1$/u, "$2"),
  );
};

const createRalphUtilityConditionScope = (
  context: RalphUtilityConditionContext,
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

export const evaluateRalphUtilityCondition = (
  condition: RalphUtilityCondition,
  context: RalphUtilityConditionContext,
  result?: unknown,
): boolean => {
  const scope = createRalphUtilityConditionScope(context, result);

  switch (condition.style) {
    case "simple":
      return evaluateSimpleRalphUtilityCondition(condition.expression ?? "", scope);
    case "json-path":
      return compareRalphUtilityConditionValues(
        readRalphUtilityValuePath(scope, condition.path),
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
