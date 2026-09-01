import {
  coerceRalphUtilityConfig,
  InvalidRalphUtilityConfigurationError,
  RALPH_UTILITY_TYPES,
} from "./coerce-ralph-utility-config.helper.ts";

describe("coerceRalphUtilityConfig", () => {
  it.each([undefined, null, "", 42, false, [], {}])(
    "rejects missing or unsupported utility type input %#",
    (value) => {
      expect(() => coerceRalphUtilityConfig(value)).toThrow(
        InvalidRalphUtilityConfigurationError,
      );
    },
  );

  it("exports the public utility type list used by Ralph APIs", () => {
    expect(RALPH_UTILITY_TYPES.filter((type) => type !== "UI_ANALYZE")).toEqual(
      [
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
        "GIT_STATUS",
        "GIT_SNAPSHOT",
        "GIT_DIFF_SUMMARY",
        "DETECT_PROJECT_COMMANDS",
        "SET_VARIABLE",
        "TRANSFORM_JSON",
        "VALIDATE_JSON",
        "FINAL_REPORT",
        "NOTIFY",
      ],
    );
  });

  it("coerces structured condition constraints and deterministic transforms", () => {
    expect(
      coerceRalphUtilityConfig({
        type: "TRANSFORM_JSON",
        deterministicTransform: {
          type: "repository-work-yield",
          baselineBlockId: "before",
          currentBlockId: "after",
          scopeGuardBlockId: "scope",
          workItemBlockId: "tasks",
          excludedPaths: ["state.json"],
          trackPrevious: true,
          verifyOnObservationError: false,
        },
        condition: {
          style: "json-path",
          path: "result.decision",
          operator: "equals",
          value: "DONE",
          valuePath: "result.expectedDecision",
          matchValues: ["DONE"],
          allowedValues: ["DONE", "DEFER"],
          invalidMessage: "Decision is invalid.",
          assertMatch: true,
          combinator: "all",
          conditions: [
            {
              style: "json-path",
              path: "result.tasks",
              operator: "non-empty-array",
            },
          ],
          itemCondition: {
            style: "json-path",
            path: "item.id",
            operator: "non-empty-string",
          },
        },
      }),
    ).toMatchObject({
      deterministicTransform: {
        type: "repository-work-yield",
        baselineBlockId: "before",
        currentBlockId: "after",
        scopeGuardBlockId: "scope",
        workItemBlockId: "tasks",
        excludedPaths: ["state.json"],
        trackPrevious: true,
        verifyOnObservationError: false,
      },
      condition: {
        style: "json-path",
        valuePath: "result.expectedDecision",
        matchValues: ["DONE"],
        allowedValues: ["DONE", "DEFER"],
        invalidMessage: "Decision is invalid.",
        assertMatch: true,
        combinator: "all",
        conditions: [
          {
            style: "json-path",
            path: "result.tasks",
            operator: "non-empty-array",
          },
        ],
        itemCondition: {
          style: "json-path",
          path: "item.id",
          operator: "non-empty-string",
        },
      },
    });

    expect(
      coerceRalphUtilityConfig({
        type: "TRANSFORM_JSON",
        deterministicTransform: {
          type: "code-improvement-plan",
          draftBlockId: "draft",
          selectionBlockId: "selection",
          constitutionBlockId: "constitution",
          researchBlockId: "research",
        },
      }).deterministicTransform,
    ).toMatchObject({ type: "code-improvement-plan", draftBlockId: "draft" });
    expect(
      coerceRalphUtilityConfig({
        type: "TRANSFORM_JSON",
        deterministicTransform: {
          type: "visual-runtime",
          commandsBlockId: "commands",
          targetUrlVariable: "targetUrl",
          healthUrlVariable: "healthUrl",
          serverCommandVariable: "serverCommand",
          serverCwdVariable: "serverCwd",
          screenshotPathVariable: "screenshotPath",
        },
      }).deterministicTransform,
    ).toMatchObject({ type: "visual-runtime", commandsBlockId: "commands" });
  });

  it.each([
    {
      field: "condition",
      value: {
        type: "CONDITION",
        condition: {
          style: "json-path",
          path: "result.state",
          operator: "unsupported",
        },
      },
    },
    {
      field: "condition",
      value: {
        type: "CONDITION",
        condition: {
          style: "json-path",
          path: "result.state",
          conditions: [null],
        },
      },
    },
    {
      field: "condition",
      value: {
        type: "CONDITION",
        condition: {
          style: "json-path",
          path: "result.state",
          allowedValues: ["ready", 1],
        },
      },
    },
    {
      field: "deterministicTransform",
      value: {
        type: "TRANSFORM_JSON",
        expression: "({ fallback: true })",
        deterministicTransform: { type: "unsupported" },
      },
    },
    {
      field: "deterministicTransform",
      value: {
        type: "TRANSFORM_JSON",
        deterministicTransform: {
          type: "repository-work-yield",
          baselineBlockId: "before",
          currentBlockId: "after",
          excludedPaths: ["state.json", 1],
        },
      },
    },
  ])("rejects an invalid $field instead of dropping it", ({ field, value }) => {
    expect(() => coerceRalphUtilityConfig(value)).toThrow(
      expect.objectContaining({
        name: "InvalidRalphUtilityConfigurationError",
        field,
      }),
    );
  });

  it("coerces the common utility fields while preserving boundary values", () => {
    expect(
      coerceRalphUtilityConfig({
        type: "RUN_COMMAND",
        mode: "delay",
        delaySeconds: 0,
        runAt: "2026-06-18T12:00:00Z",
        intervalSeconds: 0,
        backoffMultiplier: 1.5,
        maxAttempts: null,
        maxTasks: "3",
        maxDepth: 4,
        excludePaths: "node_modules,dist",
        flowAlias: "security-review-fix-loop",
        strategy: "least-validated",
        scopeId: "src-core",
        scopeOutcome: "completed",
        jsonPath: "tasks",
        taskId: "task-1",
        status: "completed",
        result: "DONE",
        includeMarkdown: true,
        forceNew: false,
        reset: false,
        enforce: true,
        jsonPatchMode: "merge",
        counterName: "scope-pass",
        counterKey: "src-core",
        markdownPath: ".machdoch/report.md",
        prompt: "Return JSON.",
        structuredOutput: false,
        command: "pnpm test",
        fallbackCommand: "pnpm typecheck",
        cwd: "",
        timeoutSeconds: 0,
        maxOutputBytes: 1,
        baseline: "{{result:git-snapshot-before}}",
        ignoreErrors: false,
      }),
    ).toEqual({
      type: "RUN_COMMAND",
      mode: "delay",
      delaySeconds: 0,
      runAt: "2026-06-18T12:00:00Z",
      intervalSeconds: 0,
      backoffMultiplier: 1.5,
      maxAttempts: null,
      maxTasks: 3,
      maxDepth: 4,
      excludePaths: "node_modules,dist",
      flowAlias: "security-review-fix-loop",
      strategy: "least-validated",
      scopeId: "src-core",
      scopeOutcome: "completed",
      jsonPath: "tasks",
      taskId: "task-1",
      status: "completed",
      result: "DONE",
      includeMarkdown: true,
      forceNew: false,
      reset: false,
      enforce: true,
      jsonPatchMode: "merge",
      counterName: "scope-pass",
      counterKey: "src-core",
      markdownPath: ".machdoch/report.md",
      prompt: "Return JSON.",
      structuredOutput: false,
      command: "pnpm test",
      fallbackCommand: "pnpm typecheck",
      cwd: "",
      timeoutSeconds: 0,
      maxOutputBytes: 1,
      baseline: "{{result:git-snapshot-before}}",
      ignoreErrors: false,
    });
  });

  it("preserves numeric templates until runtime values are resolved", () => {
    expect(
      coerceRalphUtilityConfig({
        type: "LOOP_COUNTER",
        maxAttempts: "{{maxPasses:number=3}}",
        maxTasks: "{{maxTasks:number=2}}",
        maxDepth: "{{maxDepth:number=4}}",
        maxResults: "{{maxResults:number=200}}",
      }),
    ).toMatchObject({
      type: "LOOP_COUNTER",
      maxAttempts: "{{maxPasses:number=3}}",
      maxTasks: "{{maxTasks:number=2}}",
      maxDepth: "{{maxDepth:number=4}}",
      maxResults: "{{maxResults:number=200}}",
    });
  });

  it("filters invalid optional enum values and non-string record entries", () => {
    expect(
      coerceRalphUtilityConfig({
        type: "WAIT",
        mode: "sometimes",
        encoding: "utf16",
        headers: { accept: "application/json", retry: 3, empty: "" },
        env: { NODE_ENV: "test", DEBUG: true },
        acceptedExitCodes: [0, 1.5, "2", 3, Number.NaN],
        waitUntil: "quiet",
        scopeOutcome: "DONE because validation passed",
      }),
    ).toEqual({
      type: "WAIT",
      headers: { accept: "application/json", empty: "" },
      env: { NODE_ENV: "test" },
      acceptedExitCodes: [0, 3],
    });
  });

  it("defaults an omitted condition style without accepting an invalid style", () => {
    expect(
      coerceRalphUtilityConfig({
        type: "POLL",
        condition: {
          expression: "lastData.ready",
          operator: "equals",
          value: "true",
        },
      }),
    ).toEqual({
      type: "POLL",
      condition: {
        style: "simple",
        expression: "lastData.ready",
        operator: "equals",
        value: "true",
      },
    });

    expect(() =>
      coerceRalphUtilityConfig({
        type: "POLL",
        condition: { style: "invalid", expression: "lastData.ready" },
      }),
    ).toThrow(InvalidRalphUtilityConfigurationError);
  });

  it("normalizes filesystem aliases, encodings, and integer exit codes", () => {
    expect(
      coerceRalphUtilityConfig({
        type: "SEARCH_FILES",
        root: "repo",
        sourceRoot: "src",
        directory: "lib",
        pattern: ["", "ignored"],
        patterns: ["", "**/*.ts"],
        encoding: "utf-8",
        acceptedExitCodes: [0, 2, -1, 1.25, Number.POSITIVE_INFINITY],
      }),
    ).toEqual({
      type: "SEARCH_FILES",
      rootPath: "repo",
      pattern: "ignored",
      glob: "**/*.ts",
      encoding: "utf8",
      acceptedExitCodes: [0, 2, -1],
    });
  });

  it("distinguishes absent schema from an explicitly provided undefined schema", () => {
    expect(coerceRalphUtilityConfig({ type: "VALIDATE_JSON" })).toEqual({
      type: "VALIDATE_JSON",
    });

    expect(
      Object.hasOwn(
        coerceRalphUtilityConfig({
          type: "VALIDATE_JSON",
          schema: undefined,
        }),
        "schema",
      ),
    ).toBe(true);
  });
});
