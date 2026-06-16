import {
  getRalphUtilityOutputs,
  parseRalphFlowJson,
  validateRalphFlow,
} from "../ralph.js";
import {
  createFlow,
  createUtilityFlow,
  runtimeConfig,
  type RalphUtilityBlockForTest,
} from "./ralph-test-helpers.js";
describe("validateRalphFlow", () => {
  it("accepts a valid prompt and validator graph", () => {
    const validation = validateRalphFlow(createFlow());

    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(validation.variables).toEqual([
      {
        name: "scope",
        type: "path",
        default: "ALL",
        required: false,
      },
    ]);
  });

  it("requires exactly one start block", () => {
    const validation = validateRalphFlow(
      createFlow({
        blocks: [
          {
            id: "fix-tsc",
            type: "PROMPT",
            title: "Fix TSC",
            prompt: "Fix.",
          },
        ],
        edges: [],
      }),
    );

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain(
      "Ralph flow must contain exactly one START block.",
    );
  });

  it("warns when validator CONTINUE is not connected", () => {
    const validation = validateRalphFlow(
      createFlow({
        edges: createFlow().edges.filter(
          (edge) => edge.fromOutput !== "CONTINUE",
        ),
      }),
    );

    expect(validation.valid).toBe(true);
    expect(validation.warnings).toContain(
      "validate has no edge for output CONTINUE.",
    );
  });

  it("accepts notes, groups, and annotation links without runtime routing", () => {
    const parsed = parseRalphFlowJson(
      JSON.stringify(
        createFlow({
          blocks: [
            ...createFlow().blocks,
            {
              id: "context-note",
              type: "NOTE",
              title: "Context",
              text: "Manual verification must include a screenshot.",
              tone: "amber",
              tags: ["manual QA"],
              size: { width: 300, height: 180 },
              pinnedBlockIds: ["validate"],
            },
            {
              id: "verification-group",
              type: "GROUP",
              title: "Verification",
              description: "Validation and evidence collection.",
              tone: "sky",
              size: { width: 720, height: 420 },
              childBlockIds: ["validate", "context-note"],
              executionBoundary: { mode: "selectedChild", blockId: "validate" },
            },
          ],
          annotationLinks: [
            {
              id: "note-to-validate",
              from: "context-note",
              to: "validate",
              kind: "evidence",
            },
          ],
        }),
      ),
    );

    expect(parsed.annotationLinks).toEqual([
      {
        id: "note-to-validate",
        from: "context-note",
        to: "validate",
        kind: "evidence",
      },
    ]);
    expect(validateRalphFlow(parsed)).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  it("coerces malformed flow JSON into a stable editable shape", () => {
    const parsed = parseRalphFlowJson(
      JSON.stringify({
        schemaVersion: 1,
        id: "coerced-flow",
        name: "Coerced Flow",
        settings: {
          maxTransitions: 2.9,
        },
        variables: [
          {
            name: "scope",
            type: "directory",
            default: 42,
            required: "yes",
          },
        ],
        blocks: [
          {
            id: "start",
            type: "START",
            title: "Start",
            position: { x: 0, y: "bad" },
            size: { width: 100, height: "bad" },
          },
          {
            id: "unknown",
            type: "UNKNOWN",
            title: "Unknown",
            prompt: 42,
            settings: {
              workspace: { mode: "custom", path: "C:/other" },
              reasoning: "max",
              retry: {
                mode: "finite",
                maxRetries: "bad",
                delaySeconds: 1,
              },
              attachments: [
                { source: "variable", value: "screenshot", kind: "image" },
                { source: "path", value: "", kind: "file" },
              ],
            },
          },
          {
            id: "utility",
            type: "UTILITY",
            title: "Utility",
            utility: {
              type: "UNKNOWN",
              acceptedExitCodes: [0, "bad", 3],
              encoding: "utf-8",
              viewports: [{ name: "wide", width: 800.9, height: 600.1 }],
            },
          },
          {
            id: "end",
            type: "END",
            title: "End",
            status: "weird",
          },
        ],
        edges: [
          { id: "start-to-unknown", from: "start", fromOutput: "SUCCESS", to: "unknown" },
          { id: "unknown-to-utility", from: "unknown", fromOutput: "SUCCESS", to: "utility" },
          { id: "utility-to-end", from: "utility", fromOutput: "SUCCESS", to: "end" },
        ],
      }),
    );

    expect(parsed.settings).toEqual({ maxTransitions: 2 });
    expect(parsed.variables).toEqual([
      {
        name: "scope",
        type: "string",
        required: true,
      },
    ]);
    expect(parsed.blocks).toEqual([
      {
        id: "start",
        type: "START",
        title: "Start",
      },
      expect.objectContaining({
        id: "unknown",
        type: "PROMPT",
        title: "Unknown",
        prompt: "",
        settings: expect.objectContaining({
          workspace: { mode: "custom", path: "C:/other" },
          reasoning: "max",
          retry: { mode: "finite", maxRetries: null, delaySeconds: 1 },
          attachments: [
            { source: "variable", value: "screenshot", kind: "image" },
          ],
        }),
      }),
      expect.objectContaining({
        id: "utility",
        type: "UTILITY",
        utility: expect.objectContaining({
          type: "WAIT",
          acceptedExitCodes: [0, 3],
          encoding: "utf8",
          viewports: [{ name: "wide", width: 800, height: 600 }],
        }),
      }),
      {
        id: "end",
        type: "END",
        title: "End",
        status: "success",
      },
    ]);
  });

  it("rejects non-object Ralph JSON at parse time", () => {
    expect(() => parseRalphFlowJson("[]")).toThrow(
      "Expected Ralph flow JSON to be an object.",
    );
  });

  it("rejects runtime routes to visual note and group blocks", () => {
    const validation = validateRalphFlow(
      createFlow({
        blocks: [
          ...createFlow().blocks,
          {
            id: "context-note",
            type: "NOTE",
            title: "Context",
            text: "Do not execute.",
            size: { width: 280, height: 180 },
          },
        ],
        edges: [
          ...createFlow().edges,
          {
            id: "validate-to-note",
            from: "validate",
            fromOutput: "ERROR",
            to: "context-note",
          },
        ],
      }),
    );

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain(
      "edge `validate-to-note` cannot use visual block `context-note` as a target.",
    );
  });

  it("rejects missing edge target blocks", () => {
    const validation = validateRalphFlow(
      createFlow({
        edges: [
          ...createFlow().edges,
          {
            id: "broken",
            from: "validate",
            fromOutput: "ERROR",
            to: "missing",
          },
        ],
      }),
    );

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain(
      "edge `broken` references missing target block `missing`.",
    );
  });

  it("rejects unsupported typed variable placeholders", () => {
    const validation = validateRalphFlow(
      createFlow({
        blocks: [
          {
            id: "start",
            type: "START",
            title: "Start",
          },
          {
            id: "bad",
            type: "PROMPT",
            title: "Bad",
            prompt: "Use {{scope:directory}}.",
          },
        ],
        edges: [
          {
            id: "start-to-bad",
            from: "start",
            fromOutput: "SUCCESS",
            to: "bad",
          },
        ],
      }),
    );

    expect(validation.valid).toBe(false);
    expect(validation.errors.join(" ")).toContain(
      "unsupported variable type `directory`",
    );
  });

  it("warns for unknown explicit result references", () => {
    const validation = validateRalphFlow(
      createFlow({
        blocks: [
          {
            id: "start",
            type: "START",
            title: "Start",
          },
          {
            id: "use-result",
            type: "PROMPT",
            title: "Use result",
            prompt: "Use {{summary:no-such-block}}.",
          },
        ],
        edges: [
          {
            id: "start-to-use",
            from: "start",
            fromOutput: "SUCCESS",
            to: "use-result",
          },
        ],
      }),
    );

    expect(validation.valid).toBe(true);
    expect(validation.warnings.join(" ")).toContain(
      "unknown block `no-such-block`",
    );
  });

  it("warns when a cyclic flow has no flow-level transition cap", () => {
    const uncappedValidation = validateRalphFlow(createFlow());

    expect(uncappedValidation.valid).toBe(true);
    expect(uncappedValidation.warnings).toContain(
      "Flow contains a cycle but does not define settings.maxTransitions; runs can continue until manually stopped.",
    );

    const cappedValidation = validateRalphFlow(
      createFlow({
        settings: {
          maxTransitions: 30,
        },
      }),
    );

    expect(cappedValidation.valid).toBe(true);
    expect(cappedValidation.warnings).not.toContain(
      "Flow contains a cycle but does not define settings.maxTransitions; runs can continue until manually stopped.",
    );
  });

  it("rejects invalid flow-level transition caps", () => {
    const validation = validateRalphFlow(
      createFlow({
        settings: {
          maxTransitions: 0,
        },
      }),
    );

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain(
      "flow settings.maxTransitions must be an integer >= 1.",
    );
  });

  it("warns that pack references are metadata-only at runtime", () => {
    const validation = validateRalphFlow(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "load-ui-pack",
            type: "PACK",
            title: "Load UI pack",
            packIds: ["ui-review"],
          },
          {
            id: "review",
            type: "PROMPT",
            title: "Review",
            prompt: "Review the UI.",
            settings: {
              packs: ["ui-review"],
            },
          },
          { id: "success", type: "END", title: "Success", status: "success" },
        ],
        edges: [
          {
            id: "start-to-pack",
            from: "start",
            fromOutput: "SUCCESS",
            to: "load-ui-pack",
          },
          {
            id: "pack-to-review",
            from: "load-ui-pack",
            fromOutput: "SUCCESS",
            to: "review",
          },
          {
            id: "review-to-success",
            from: "review",
            fromOutput: "SUCCESS",
            to: "success",
          },
        ],
      }),
    );

    expect(validation.valid).toBe(true);
    expect(validation.warnings).toEqual(
      expect.arrayContaining([
        "load-ui-pack references context packs, but Ralph currently stores pack ids as metadata and does not inject pack contents at runtime.",
        "review references settings.packs, but Ralph currently stores pack ids as metadata and does not inject pack contents at runtime.",
      ]),
    );
  });

  it("validates UI_ANALYZE utility targets and outputs", () => {
    expect(getRalphUtilityOutputs({ type: "UI_ANALYZE" })).toEqual([
      "SUCCESS",
      "UNAVAILABLE",
      "ERROR",
    ]);

    const missingTargetValidation = validateRalphFlow(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "analyze-ui",
            type: "UTILITY",
            title: "Analyze UI",
            utility: {
              type: "UI_ANALYZE",
              adapter: "browser",
            },
          },
        ],
        edges: [
          {
            id: "start-to-analyze",
            from: "start",
            fromOutput: "SUCCESS",
            to: "analyze-ui",
          },
        ],
      }),
    );

    expect(missingTargetValidation.valid).toBe(false);
    expect(missingTargetValidation.errors).toContain(
      "analyze-ui browser analysis requires targetUrl.",
    );

    const validScreenshotValidation = validateRalphFlow(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "analyze-ui",
            type: "UTILITY",
            title: "Analyze UI",
            utility: {
              type: "UI_ANALYZE",
              adapter: "image",
              screenshotPath: "screenshots/home.png",
            },
          },
          { id: "success", type: "END", title: "Success" },
        ],
        edges: [
          {
            id: "start-to-analyze",
            from: "start",
            fromOutput: "SUCCESS",
            to: "analyze-ui",
          },
          {
            id: "analyze-to-success",
            from: "analyze-ui",
            fromOutput: "SUCCESS",
            to: "success",
          },
        ],
      }),
    );

    expect(validScreenshotValidation.valid).toBe(true);
  });

  it("rejects missing required config for every utility family", () => {
    const cases: Array<{
      name: string;
      utility: RalphUtilityBlockForTest["utility"];
      errorCodes: string[];
    }> = [
      {
        name: "WAIT until-time",
        utility: { type: "WAIT", mode: "until-time" },
        errorCodes: ["utility-run-at-required"],
      },
      {
        name: "WAIT condition",
        utility: { type: "WAIT", mode: "condition" },
        errorCodes: ["utility-condition-required"],
      },
      {
        name: "HTTP_FETCH",
        utility: { type: "HTTP_FETCH" },
        errorCodes: ["utility-url-required"],
      },
      {
        name: "POLL",
        utility: { type: "POLL" },
        errorCodes: ["utility-url-required", "utility-condition-required"],
      },
      {
        name: "RUN_COMMAND",
        utility: { type: "RUN_COMMAND" },
        errorCodes: ["utility-command-required"],
      },
      {
        name: "RUN_CHECK",
        utility: { type: "RUN_CHECK" },
        errorCodes: ["utility-command-required"],
      },
      {
        name: "READ_FILE",
        utility: { type: "READ_FILE" },
        errorCodes: ["utility-path-required"],
      },
      {
        name: "WRITE_FILE",
        utility: { type: "WRITE_FILE" },
        errorCodes: ["utility-path-required", "utility-content-required"],
      },
      {
        name: "SEARCH_FILES",
        utility: { type: "SEARCH_FILES" },
        errorCodes: ["utility-search-pattern-required"],
      },
      {
        name: "UI_ANALYZE MCP",
        utility: { type: "UI_ANALYZE", adapter: "tauri-mcp" },
        errorCodes: ["utility-ui-mcp-required"],
      },
      {
        name: "SET_VARIABLE",
        utility: { type: "SET_VARIABLE" },
        errorCodes: ["utility-variable-name-required"],
      },
      {
        name: "TRANSFORM_JSON",
        utility: { type: "TRANSFORM_JSON" },
        errorCodes: ["utility-expression-required"],
      },
      {
        name: "VALIDATE_JSON",
        utility: { type: "VALIDATE_JSON" },
        errorCodes: ["utility-schema-required"],
      },
    ];

    for (const testCase of cases) {
      const validation = validateRalphFlow(
        createUtilityFlow(
          {
            id: "utility",
            type: "UTILITY",
            title: testCase.name,
            utility: testCase.utility,
          },
          [
            {
              id: "start-to-utility",
              from: "start",
              fromOutput: "SUCCESS",
              to: "utility",
            },
          ],
        ),
      );
      const errorCodes = validation.errorIssues.map((issue) => issue.code);

      expect(errorCodes).toEqual(expect.arrayContaining(testCase.errorCodes));
    }
  });

  it("rejects utility numeric bounds and invalid UI analysis URLs", () => {
    const validation = validateRalphFlow(
      createUtilityFlow(
        {
          id: "analyze-ui",
          type: "UTILITY",
          title: "Analyze UI",
          utility: {
            type: "UI_ANALYZE",
            adapter: "browser",
            targetUrl: "file:///tmp/index.html",
            delaySeconds: -1,
            intervalSeconds: -1,
            maxAttempts: 0,
            timeoutSeconds: -1,
            maxOutputBytes: 0,
            server: {
              healthUrl: "ftp://127.0.0.1/health",
            },
            viewports: [{ width: 319, height: 900 }],
          },
        },
        [
          {
            id: "start-to-analyze",
            from: "start",
            fromOutput: "SUCCESS",
            to: "analyze-ui",
          },
        ],
      ),
    );

    expect(validation.errorIssues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "utility-delay-invalid",
        "utility-interval-invalid",
        "utility-max-attempts-invalid",
        "utility-timeout-invalid",
        "utility-output-limit-invalid",
        "utility-ui-target-url-invalid",
        "utility-ui-health-url-invalid",
        "utility-ui-viewport-invalid",
      ]),
    );
  });

  it("rejects invalid graph metadata, group boundaries, and annotation links", () => {
    const validation = validateRalphFlow(
      createFlow({
        id: "Invalid Flow",
        alias: "",
        name: "",
        blocks: [
          { id: "start", type: "START", title: "Start" },
          { id: "start", type: "START", title: "Duplicate start" },
          {
            id: "prompt",
            type: "PROMPT",
            title: "Prompt",
            prompt: "Run.",
            parentGroupId: "not-a-group",
          },
          {
            id: "not-a-group",
            type: "PROMPT",
            title: "Not a group",
            prompt: "Run.",
          },
          {
            id: "group",
            type: "GROUP",
            title: "Group",
            childBlockIds: ["prompt"],
            executionBoundary: { mode: "selectedChild", blockId: "missing" },
          },
        ],
        edges: [
          {
            id: "bad edge",
            from: "group",
            fromOutput: "SUCCESS",
            to: "missing",
          },
        ],
        annotationLinks: [
          { id: "link", from: "missing", to: "prompt", kind: "explains" },
          { id: "link", from: "prompt", to: "missing", kind: "risk" },
        ],
      }),
    );

    expect(validation.errorIssues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "flow-id-invalid",
        "flow-alias-empty",
        "flow-name-required",
        "multiple-start",
        "block-id-duplicate",
        "parent-group-invalid",
        "group-execution-boundary-missing",
        "annotation-link-id-duplicate",
        "edge-id-invalid",
        "edge-to-missing",
        "edge-from-visual-block",
      ]),
    );
    expect(validation.warningIssues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "annotation-link-from-missing",
        "annotation-link-to-missing",
      ]),
    );
  });

  it("rejects unavailable block providers before runtime", () => {
    const validation = validateRalphFlow(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "review",
            type: "PROMPT",
            title: "Review",
            prompt: "Review the change.",
            settings: {
              provider: "google",
            },
          },
        ],
        edges: [
          {
            id: "start-to-review",
            from: "start",
            fromOutput: "SUCCESS",
            to: "review",
          },
        ],
      }),
      { config: runtimeConfig },
    );

    expect(validation.errorIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "provider-unavailable",
          blockId: "review",
        }),
      ]),
    );
  });

  it("accepts MCP blocks with block-level MCP config overrides", () => {
    const validation = validateRalphFlow(
      createFlow({
        blocks: [
          {
            id: "start",
            type: "START",
            title: "Start",
          },
          {
            id: "search",
            type: "MCP_TOOL",
            title: "Search",
            serverId: "serper",
            toolName: "search",
            arguments: {
              query: "{{query:string=machdoch}}",
            },
            settings: {
              mcp: {
                servers: [
                  {
                    id: "serper",
                    enabled: true,
                    auth: {
                      type: "oauth",
                      accessToken: "ralph-access-token",
                      refreshToken: "ralph-refresh-token",
                    },
                  },
                ],
              },
            },
          },
          {
            id: "success",
            type: "END",
            title: "Success",
            status: "success",
          },
        ],
        edges: [
          {
            id: "start-to-search",
            from: "start",
            fromOutput: "SUCCESS",
            to: "search",
          },
          {
            id: "search-to-success",
            from: "search",
            fromOutput: "SUCCESS",
            to: "success",
          },
        ],
      }),
      { config: runtimeConfig },
    );

    expect(validation.valid).toBe(true);
    expect(validation.variables).toEqual([
      {
        name: "query",
        type: "string",
        default: "machdoch",
        required: false,
      },
    ]);
  });

  it("accepts WAIT utilities without requiring an impossible ERROR route", () => {
    const validation = validateRalphFlow(
      createFlow({
        blocks: [
          {
            id: "start",
            type: "START",
            title: "Start",
          },
          {
            id: "wait",
            type: "UTILITY",
            title: "Wait",
            utility: {
              type: "WAIT",
              mode: "delay",
              delaySeconds: 0,
            },
          },
          {
            id: "success",
            type: "END",
            title: "Success",
            status: "success",
          },
        ],
        edges: [
          {
            id: "start-to-wait",
            from: "start",
            fromOutput: "SUCCESS",
            to: "wait",
          },
          {
            id: "wait-to-success",
            from: "wait",
            fromOutput: "SUCCESS",
            to: "success",
          },
        ],
      }),
    );

    expect(validation.valid).toBe(true);
    expect(validation.warnings.join(" ")).not.toContain(
      "wait has no edge for output ERROR",
    );
    expect(getRalphUtilityOutputs({ type: "WAIT" })).toEqual(["SUCCESS"]);
  });
});


