import type {
  RalphBlockExecutionResult,
  RalphUtilityCondition,
} from "../ralph.ts";
import {
  evaluateRalphUtilityCondition,
  parseRalphUtilityJsonValue,
  readRalphUtilityValuePath,
  type RalphUtilityConditionContext,
} from "./evaluate-ralph-utility-condition.helper.ts";

const createResult = (
  overrides: Partial<RalphBlockExecutionResult> = {},
): RalphBlockExecutionResult => ({
  blockId: "fetch-data",
  output: "SUCCESS",
  status: "completed",
  attempt: 1,
  summary: "Fetched data.",
  data: {
    ready: true,
    count: 3,
    message: "service ready",
  },
  ...overrides,
});

const createContext = (
  overrides: Partial<RalphUtilityConditionContext> = {},
): RalphUtilityConditionContext => ({
  variables: {
    flag: "yes",
    threshold: "3",
  },
  lastResult: createResult(),
  runLog: ["fetch-data: SUCCESS - Fetched data."],
  ...overrides,
});

describe("parseRalphUtilityJsonValue", () => {
  it.each([
    ["", ""],
    ["   ", ""],
    ["true", true],
    ["false", false],
    ["null", null],
    ["42", 42],
    ['"text"', "text"],
    ['{"ready":true}', { ready: true }],
    ["[1,2]", [1, 2]],
  ])("parses %j as %#", (input, expected) => {
    expect(parseRalphUtilityJsonValue(input)).toEqual(expected);
  });

  it("returns the original value when JSON parsing fails", () => {
    expect(parseRalphUtilityJsonValue("  not-json  ")).toBe("  not-json  ");
  });
});

describe("readRalphUtilityValuePath", () => {
  const value = {
    items: [
      { name: "first", enabled: false },
      { name: "second", enabled: true },
    ],
    nested: {
      total: 2,
      empty: null,
    },
  };

  it.each([undefined, "", "   "])(
    "returns the root value for empty path %#",
    (path) => {
      expect(readRalphUtilityValuePath(value, path)).toBe(value);
    },
  );

  it.each([
    ["items[1].name", "second"],
    ["$.items[0].enabled", false],
    ["nested.total", 2],
    [" nested.empty ", null],
  ])("reads nested path %s", (path, expected) => {
    expect(readRalphUtilityValuePath(value, path)).toBe(expected);
  });

  it.each([
    ["items.name"],
    ["items[5].name"],
    ["missing.value"],
    ["nested.total.value"],
  ])("returns undefined for unresolved path %s", (path) => {
    expect(readRalphUtilityValuePath(value, path)).toBeUndefined();
  });

  it("returns undefined when a nested path is read from null or undefined", () => {
    expect(readRalphUtilityValuePath(null, "anything")).toBeUndefined();
    expect(readRalphUtilityValuePath(undefined, "anything")).toBeUndefined();
  });
});

describe("evaluateRalphUtilityCondition", () => {
  it.each([
    [{ style: "simple", expression: "variables.flag" }, true],
    [{ style: "simple", expression: "missing.path" }, false],
    [{ style: "simple", expression: "lastData.count >= 3" }, true],
    [{ style: "simple", expression: "lastData.count < 3" }, false],
    [
      { style: "simple", expression: "lastData.message includes 'ready'" },
      true,
    ],
    [{ style: "simple", expression: "lastData.message matches ready$" }, true],
    [{ style: "simple", expression: "" }, true],
  ] satisfies Array<[RalphUtilityCondition, boolean]>)(
    "evaluates simple condition %#",
    (condition, expected) => {
      expect(evaluateRalphUtilityCondition(condition, createContext())).toBe(
        expected,
      );
    },
  );

  it.each([
    [{ style: "json-path", path: "lastData.ready" }, true],
    [{ style: "json-path", path: "lastData.ready", operator: "exists" }, true],
    [
      { style: "json-path", path: "lastData.missing", operator: "not-exists" },
      true,
    ],
    [{ style: "json-path", path: "lastData.ready", operator: "truthy" }, true],
    [{ style: "json-path", path: "lastData.empty", operator: "falsy" }, true],
    [
      {
        style: "json-path",
        path: "lastData.count",
        operator: "equals",
        value: "3",
      },
      true,
    ],
    [
      {
        style: "json-path",
        path: "lastData.count",
        operator: "not-equals",
        value: "4",
      },
      true,
    ],
    [
      {
        style: "json-path",
        path: "lastData.message",
        operator: "contains",
        value: "ready",
      },
      true,
    ],
    [
      {
        style: "json-path",
        path: "lastData.message",
        operator: "matches",
        value: "ready$",
      },
      true,
    ],
    [
      {
        style: "json-path",
        path: "lastData.count",
        operator: "gt",
        value: "2",
      },
      true,
    ],
    [
      {
        style: "json-path",
        path: "lastData.count",
        operator: "gte",
        value: "3",
      },
      true,
    ],
    [
      {
        style: "json-path",
        path: "lastData.count",
        operator: "lt",
        value: "4",
      },
      true,
    ],
    [
      {
        style: "json-path",
        path: "lastData.count",
        operator: "lte",
        value: "3",
      },
      true,
    ],
  ] satisfies Array<[RalphUtilityCondition, boolean]>)(
    "evaluates json-path condition %#",
    (condition, expected) => {
      expect(evaluateRalphUtilityCondition(condition, createContext())).toBe(
        expected,
      );
    },
  );

  it("treats a record result as top-level condition scope fields", () => {
    expect(
      evaluateRalphUtilityCondition(
        {
          style: "json-path",
          path: "status",
          operator: "equals",
          value: '"ok"',
        },
        createContext(),
        { status: "ok" },
      ),
    ).toBe(true);
  });

  it("fails constrained enum conditions closed before comparing", () => {
    const condition: RalphUtilityCondition = {
      style: "json-path",
      path: "lastData.decision",
      operator: "equals",
      value: "DEFER",
      allowedValues: ["DONE", "DEFER"],
      invalidMessage: "Decision is invalid.",
    };

    expect(
      evaluateRalphUtilityCondition(
        condition,
        createContext({
          lastResult: createResult({ data: { decision: "DEFER" } }),
        }),
      ),
    ).toBe(true);
    expect(() =>
      evaluateRalphUtilityCondition(
        condition,
        createContext({
          lastResult: createResult({ data: { decision: "FIX" } }),
        }),
      ),
    ).toThrow("Decision is invalid.");
  });

  it("evaluates composed typed task-state conditions", () => {
    const condition: RalphUtilityCondition = {
      style: "json-path",
      path: "lastData.status",
      operator: "is-one-of",
      matchValues: ["planned", "implementing"],
      allowedValues: ["planned", "implementing", "completed"],
      invalidMessage: "Task state is invalid.",
      conditions: [
        {
          style: "json-path",
          path: "lastData.tasks",
          operator: "non-empty-array",
          assertMatch: true,
          invalidMessage: "Active work requires tasks.",
        },
        {
          style: "json-path",
          path: "lastData.tasks",
          operator: "array-every",
          assertMatch: true,
          itemCondition: {
            style: "json-path",
            path: "item.id",
            operator: "non-empty-string",
          },
        },
      ],
    };

    expect(
      evaluateRalphUtilityCondition(
        condition,
        createContext({
          lastResult: createResult({
            data: { status: "planned", tasks: [{ id: "task-1" }] },
          }),
        }),
      ),
    ).toBe(true);
    expect(
      evaluateRalphUtilityCondition(
        condition,
        createContext({
          lastResult: createResult({
            data: { status: "completed", tasks: [] },
          }),
        }),
      ),
    ).toBe(false);
    expect(() =>
      evaluateRalphUtilityCondition(
        condition,
        createContext({
          lastResult: createResult({
            data: { status: "planned", tasks: [] },
          }),
        }),
      ),
    ).toThrow("Active work requires tasks.");
    expect(() =>
      evaluateRalphUtilityCondition(
        condition,
        createContext({
          lastResult: createResult({
            data: { status: "PLANNED", tasks: [{ id: "task-1" }] },
          }),
        }),
      ),
    ).toThrow("Task state is invalid.");
  });

  it("compares explicit identity paths after validating both identities", () => {
    const condition: RalphUtilityCondition = {
      style: "json-path",
      path: "lastData.featureId",
      operator: "non-empty-string",
      assertMatch: true,
      conditions: [
        {
          style: "json-path",
          path: "variables.featureId",
          operator: "non-empty-string",
          assertMatch: true,
          conditions: [
            {
              style: "json-path",
              path: "lastData.featureId",
              operator: "equals-path",
              valuePath: "variables.featureId",
            },
          ],
        },
      ],
    };

    expect(
      evaluateRalphUtilityCondition(
        condition,
        createContext({
          variables: { featureId: "feature-1" },
          lastResult: createResult({ data: { featureId: "feature-1" } }),
        }),
      ),
    ).toBe(true);
    expect(
      evaluateRalphUtilityCondition(
        condition,
        createContext({
          variables: { featureId: "feature-2" },
          lastResult: createResult({ data: { featureId: "feature-1" } }),
        }),
      ),
    ).toBe(false);
  });

  it("short-circuits explicit any conditions", () => {
    expect(
      evaluateRalphUtilityCondition(
        {
          style: "json-path",
          path: "variables.primary",
          operator: "non-empty-string",
          combinator: "any",
          conditions: [
            {
              style: "json-path",
              path: "variables.secondary",
              operator: "non-empty-string",
            },
          ],
        },
        createContext({ variables: { primary: " ", secondary: "ready" } }),
      ),
    ).toBe(true);
  });

  it("exposes primitive result under the result scope field", () => {
    expect(
      evaluateRalphUtilityCondition(
        {
          style: "json-path",
          path: "result",
          operator: "equals",
          value: '"done"',
        },
        createContext(),
        "done",
      ),
    ).toBe(true);
  });

  it("evaluates javascript expressions with context, variables, last result, and data", () => {
    expect(
      evaluateRalphUtilityCondition(
        {
          style: "javascript",
          expression:
            'variables.flag === "yes" && lastData.ready === true && result.score === 9 && context.runLog.length === 1',
        },
        createContext(),
        { score: 9 },
      ),
    ).toBe(true);
  });

  it("exposes prior block results to javascript expressions by block id", () => {
    expect(
      evaluateRalphUtilityCondition(
        {
          style: "javascript",
          expression:
            "Boolean(context.resultsByBlock?.['detect-project-commands']?.data?.verificationCommand?.trim())",
        },
        createContext({
          resultsByBlock: new Map([
            [
              "detect-project-commands",
              createResult({
                blockId: "detect-project-commands",
                data: { verificationCommand: "pnpm typecheck" },
              }),
            ],
          ]),
        }),
      ),
    ).toBe(true);
  });

  it("defaults missing javascript expressions to false", () => {
    expect(
      evaluateRalphUtilityCondition(
        { style: "javascript" },
        { variables: {}, runLog: [] },
      ),
    ).toBe(false);
  });

  it("propagates invalid regular expressions from matches conditions", () => {
    expect(() =>
      evaluateRalphUtilityCondition(
        {
          style: "json-path",
          path: "lastData.message",
          operator: "matches",
          value: "[",
        },
        createContext(),
      ),
    ).toThrow(SyntaxError);
  });

  it("propagates javascript expression errors", () => {
    expect(() =>
      evaluateRalphUtilityCondition(
        { style: "javascript", expression: "missing.value" },
        createContext(),
      ),
    ).toThrow(ReferenceError);
  });
});
