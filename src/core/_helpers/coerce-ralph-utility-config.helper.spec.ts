import {
  coerceRalphUtilityConfig,
  RALPH_UTILITY_TYPES,
} from "./coerce-ralph-utility-config.helper.ts";

describe("coerceRalphUtilityConfig", () => {
  it.each([undefined, null, "", 42, false, [], {}])(
    "defaults empty or invalid input %# to a WAIT utility",
    (value) => {
      expect(coerceRalphUtilityConfig(value)).toEqual({ type: "WAIT" });
    },
  );

  it("exports the public utility type list used by Ralph APIs", () => {
    expect(RALPH_UTILITY_TYPES).toEqual([
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
    ]);
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
        command: "pnpm test",
        cwd: "",
        timeoutSeconds: 0,
        maxOutputBytes: 1,
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
      command: "pnpm test",
      cwd: "",
      timeoutSeconds: 0,
      maxOutputBytes: 1,
      ignoreErrors: false,
    });
  });

  it("filters invalid enum values and non-string record entries", () => {
    expect(
      coerceRalphUtilityConfig({
        type: "UNKNOWN",
        mode: "sometimes",
        encoding: "utf16",
        headers: { accept: "application/json", retry: 3, empty: "" },
        env: { NODE_ENV: "test", DEBUG: true },
        acceptedExitCodes: [0, 1.5, "2", 3, Number.NaN],
        waitUntil: "quiet",
      }),
    ).toEqual({
      type: "WAIT",
      headers: { accept: "application/json", empty: "" },
      env: { NODE_ENV: "test" },
      acceptedExitCodes: [0, 3],
    });
  });

  it("coerces conditions with default style and valid operators only", () => {
    expect(
      coerceRalphUtilityConfig({
        type: "POLL",
        condition: {
          style: "invalid",
          expression: "lastData.ready",
          path: "$.ready",
          operator: "equals",
          value: "true",
        },
      }),
    ).toEqual({
      type: "POLL",
      condition: {
        style: "simple",
        expression: "lastData.ready",
        path: "$.ready",
        operator: "equals",
        value: "true",
      },
    });

    expect(
      coerceRalphUtilityConfig({
        type: "POLL",
        condition: { style: "json-path", operator: "invalid" },
      }),
    ).toEqual({
      type: "POLL",
      condition: { style: "json-path" },
    });
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

  it("coerces UI analysis nested config and skips unusable viewport entries", () => {
    expect(
      coerceRalphUtilityConfig({
        type: "UI_ANALYZE",
        adapter: "tauri-mcp",
        targetUrl: "https://example.com",
        screenshotPath: "shot.png",
        server: {
          mode: "managed",
          healthUrl: "http://127.0.0.1:4173/health",
          command: "pnpm preview:ui",
          cwd: ".",
          reuseExisting: true,
          ignored: "value",
        },
        viewports: [
          { name: "desktop", width: 1280.8, height: 900.2 },
          { name: "invalid", width: "wide", height: 900 },
          null,
        ],
        checks: {
          screenshots: true,
          accessibility: false,
          console: "yes",
          trace: true,
        },
        fullPage: true,
        waitUntil: "networkidle",
        mcpServerId: "browser",
        mcpToolName: "analyze",
        mcpArguments: { includeTrace: true },
      }),
    ).toEqual({
      type: "UI_ANALYZE",
      adapter: "tauri-mcp",
      targetUrl: "https://example.com",
      screenshotPath: "shot.png",
      server: {
        mode: "managed",
        healthUrl: "http://127.0.0.1:4173/health",
        command: "pnpm preview:ui",
        cwd: ".",
        reuseExisting: true,
      },
      viewports: [{ name: "desktop", width: 1280, height: 900 }],
      checks: {
        screenshots: true,
        accessibility: false,
        trace: true,
      },
      fullPage: true,
      waitUntil: "networkidle",
      mcpServerId: "browser",
      mcpToolName: "analyze",
      mcpArguments: { includeTrace: true },
    });
  });

  it("distinguishes absent schema from an explicitly provided undefined schema", () => {
    expect(coerceRalphUtilityConfig({ type: "VALIDATE_JSON" })).toEqual({
      type: "VALIDATE_JSON",
    });

    expect(
      Object.hasOwn(coerceRalphUtilityConfig({ schema: undefined }), "schema"),
    ).toBe(true);
  });
});
