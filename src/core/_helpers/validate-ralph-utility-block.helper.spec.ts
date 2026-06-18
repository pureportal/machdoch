import type {
  RalphUtilityBlock,
  RalphUtilityConfig,
  RalphValidationIssue,
} from "../ralph.ts";
import { validateRalphUtilityBlock } from "./validate-ralph-utility-block.helper.ts";

const createUtilityBlock = (
  utility: RalphUtilityConfig,
  overrides: Partial<Omit<RalphUtilityBlock, "type" | "utility">> = {},
): RalphUtilityBlock => {
  return {
    id: "utility",
    type: "UTILITY",
    title: "Utility",
    ...overrides,
    utility,
  };
};

const validateUtility = (
  utility: RalphUtilityConfig,
  overrides?: Partial<Omit<RalphUtilityBlock, "type" | "utility">>,
): RalphValidationIssue[] => {
  const errors: RalphValidationIssue[] = [];

  validateRalphUtilityBlock(createUtilityBlock(utility, overrides), errors);

  return errors;
};

const getCodes = (issues: readonly RalphValidationIssue[]): string[] => {
  return issues.map((issue) => issue.code);
};

describe("validateRalphUtilityBlock", () => {
  it("accepts valid utility configurations without adding errors", () => {
    const utilities: RalphUtilityConfig[] = [
      { type: "WAIT", mode: "delay", delaySeconds: 0 },
      { type: "HTTP_FETCH", url: "https://example.com" },
      {
        type: "POLL",
        url: "https://example.com/status",
        condition: { style: "json-path", path: "$.ready", operator: "truthy" },
      },
      { type: "RUN_COMMAND", command: "pnpm test" },
      { type: "RUN_CHECK", command: "pnpm typecheck" },
      { type: "READ_FILE", path: "src/core/ralph.ts" },
      { type: "WRITE_FILE", path: "tmp/result.txt", content: "" },
      { type: "SEARCH_FILES", glob: "**/*.ts" },
      {
        type: "UI_ANALYZE",
        adapter: "browser",
        targetUrl: "http://127.0.0.1:4173",
        server: { healthUrl: "https://example.com/health" },
        viewports: [
          { width: 320, height: 320 },
          { width: 3840, height: 3840 },
        ],
      },
      { type: "SET_VARIABLE", variableName: "result", value: "" },
      { type: "TRANSFORM_JSON", expression: "input" },
      { type: "VALIDATE_JSON", schema: null },
      { type: "GIT_STATUS" },
      { type: "NOTIFY" },
    ];

    for (const utility of utilities) {
      expect(validateUtility(utility)).toEqual([]);
    }
  });

  it("rejects missing required config for utility families", () => {
    const cases: Array<{
      utility: RalphUtilityConfig;
      expectedCodes: string[];
    }> = [
      {
        utility: { type: "WAIT", mode: "until-time" },
        expectedCodes: ["utility-run-at-required"],
      },
      {
        utility: { type: "WAIT", mode: "condition" },
        expectedCodes: ["utility-condition-required"],
      },
      {
        utility: { type: "HTTP_FETCH" },
        expectedCodes: ["utility-url-required"],
      },
      {
        utility: { type: "POLL", url: "" },
        expectedCodes: [
          "utility-url-required",
          "utility-condition-required",
        ],
      },
      {
        utility: { type: "RUN_COMMAND", command: " " },
        expectedCodes: ["utility-command-required"],
      },
      {
        utility: { type: "WRITE_FILE", path: "" },
        expectedCodes: [
          "utility-path-required",
          "utility-content-required",
        ],
      },
      {
        utility: { type: "SEARCH_FILES" },
        expectedCodes: ["utility-search-pattern-required"],
      },
      {
        utility: { type: "SET_VARIABLE", variableName: "" },
        expectedCodes: ["utility-variable-name-required"],
      },
      {
        utility: { type: "TRANSFORM_JSON" },
        expectedCodes: ["utility-expression-required"],
      },
      {
        utility: { type: "VALIDATE_JSON" },
        expectedCodes: ["utility-schema-required"],
      },
    ];

    for (const testCase of cases) {
      expect(getCodes(validateUtility(testCase.utility))).toEqual(
        expect.arrayContaining(testCase.expectedCodes),
      );
    }
  });

  it("rejects invalid numeric bounds", () => {
    const errors = validateUtility({
      type: "WAIT",
      mode: "delay",
      delaySeconds: -1,
      intervalSeconds: -1,
      maxAttempts: 0,
      timeoutSeconds: Number.NaN,
      maxOutputBytes: 0,
    });

    expect(getCodes(errors)).toEqual(
      expect.arrayContaining([
        "utility-delay-invalid",
        "utility-interval-invalid",
        "utility-max-attempts-invalid",
        "utility-timeout-invalid",
        "utility-output-limit-invalid",
      ]),
    );
  });

  it("allows null maxAttempts and zero timeout as boundary values", () => {
    expect(
      validateUtility({
        type: "WAIT",
        mode: "delay",
        maxAttempts: null,
        timeoutSeconds: 0,
        maxOutputBytes: 1,
      }),
    ).toEqual([]);
  });

  it("validates condition inputs by style", () => {
    expect(
      getCodes(
        validateUtility({
          type: "WAIT",
          mode: "condition",
          condition: { style: "simple", expression: "" },
        }),
      ),
    ).toContain("utility-condition-expression-required");

    expect(
      getCodes(
        validateUtility({
          type: "WAIT",
          mode: "poll",
          condition: { style: "javascript" },
        }),
      ),
    ).toContain("utility-condition-expression-required");

    expect(
      getCodes(
        validateUtility({
          type: "WAIT",
          mode: "condition",
          condition: { style: "json-path", path: "" },
        }),
      ),
    ).toContain("utility-condition-path-required");
  });

  it("validates UI_ANALYZE adapters, URLs, and viewport bounds", () => {
    const browserErrors = validateUtility({
      type: "UI_ANALYZE",
      adapter: "browser",
      targetUrl: "file:///tmp/index.html",
      server: { healthUrl: "ftp://127.0.0.1/health" },
      viewports: [{ width: 319, height: 900 }],
    });

    expect(getCodes(browserErrors)).toEqual(
      expect.arrayContaining([
        "utility-ui-target-url-invalid",
        "utility-ui-health-url-invalid",
        "utility-ui-viewport-invalid",
      ]),
    );

    expect(
      getCodes(validateUtility({ type: "UI_ANALYZE", adapter: "image" })),
    ).toEqual(
      expect.arrayContaining([
        "utility-ui-target-required",
        "utility-ui-screenshot-required",
      ]),
    );

    expect(
      getCodes(
        validateUtility({ type: "UI_ANALYZE", adapter: "playwright-mcp" }),
      ),
    ).toContain("utility-ui-mcp-required");
  });

  it("allows templated UI_ANALYZE URLs because runtime resolves placeholders", () => {
    expect(
      validateUtility({
        type: "UI_ANALYZE",
        adapter: "browser",
        targetUrl: "{{targetUrl:url}}",
      }),
    ).toEqual([]);
  });
});
