import type { RalphSimpleLogEntry } from "../ralph.ts";
import {
  capLogText,
  createRalphLogLine,
  formatRalphSimpleMarkdownEntry,
  sanitizeTraceValue,
} from "./format-ralph-run-log-entry.helper.ts";

const createSimpleLogEntry = (
  overrides: Partial<RalphSimpleLogEntry> = {},
): RalphSimpleLogEntry => {
  return {
    sequence: 1,
    createdAt: "2026-06-18T19:00:00.000Z",
    runId: "run-1",
    kind: "block-output",
    message: "Block completed.",
    ...overrides,
  };
};

describe("capLogText", () => {
  it("returns unchanged text when it is within the limit and contains no secrets", () => {
    expect(capLogText("short message", 20)).toBe("short message");
  });

  it("redacts exact configured secret values without classifying incidental prose", () => {
    const previousToken = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "configured-secret-value";

    try {
      const capped = capLogText(
        "configured-secret-value Bearer example token=example sk-example",
        200,
      );

      expect(capped).toBe(
        "[redacted] Bearer example token=example sk-example",
      );
    } finally {
      if (previousToken === undefined) {
        delete process.env.GH_TOKEN;
      } else {
        process.env.GH_TOKEN = previousToken;
      }
    }
  });

  it("appends a truncation marker at the requested boundary", () => {
    expect(capLogText("abcdef", 3)).toBe(
      "abc\n[Ralph log text truncated at 3 characters.]",
    );
  });
});

describe("sanitizeTraceValue", () => {
  it.each([
    [null, null],
    [undefined, "undefined"],
    [42, 42],
    [false, false],
  ] as const)("normalizes primitive value %#", (input, expected) => {
    expect(sanitizeTraceValue(input)).toBe(expected);
  });

  it("redacts exact sensitive fields and structured value containers", () => {
    expect(
      sanitizeTraceValue({
        status: "ok",
        password: "value",
        nested: {
          authorization: "Bearer abcdefghijklmnop",
          authorizationHeader: "ordinary presentation value",
          visible: "yes",
        },
        env: { PUBLIC_VALUE: "also secret within this container" },
        headers: { Accept: "application/json" },
      }),
    ).toEqual({
      status: "ok",
      password: "[redacted]",
      nested: {
        authorization: "[redacted]",
        authorizationHeader: "ordinary presentation value",
        visible: "yes",
      },
      env: "[redacted]",
      headers: "[redacted]",
    });
  });

  it("redacts configured values in errors but does not interpret error prose", () => {
    const previousToken = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "configured-error-secret";

    try {
      const error = new TypeError(
        "token=example configured-error-secret",
      );
      error.stack = "TypeError: password=example configured-error-secret";

      expect(sanitizeTraceValue(error)).toEqual({
        name: "TypeError",
        message: "token=example [redacted]",
        stack: "TypeError: password=example [redacted]",
      });
    } finally {
      if (previousToken === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousToken;
      }
    }
  });

  it("limits arrays and object entries to the trace collection limit", () => {
    const entries = Array.from({ length: 205 }, (_, index) => index);
    const objectEntries = Object.fromEntries(
      entries.map((entry) => [`key${entry}`, entry]),
    );

    expect(sanitizeTraceValue(entries)).toHaveLength(200);
    expect(Object.keys(sanitizeTraceValue(objectEntries) as Record<string, unknown>))
      .toHaveLength(200);
  });

  it("replaces values beyond the maximum trace depth", () => {
    const value = {
      a: {
        b: {
          c: {
            d: {
              e: {
                f: {
                  g: "too deep",
                },
              },
            },
          },
        },
      },
    };

    expect(sanitizeTraceValue(value)).toEqual({
      a: {
        b: {
          c: {
            d: {
              e: {
                f: "[Ralph trace value truncated]",
              },
            },
          },
        },
      },
    });
  });
});

describe("formatRalphSimpleMarkdownEntry", () => {
  it("formats block title, output, second duration, and input preview", () => {
    expect(
      formatRalphSimpleMarkdownEntry(
        createSimpleLogEntry({
          blockId: "prompt-1",
          blockTitle: "Prompt 1",
          output: "SUCCESS",
          durationMs: 1_250,
          inputPreview: "line 1\nline 2",
          outputPreview: "ignored when input exists",
        }),
      ),
    ).toBe(
      "- 2026-06-18T19:00:00.000Z [Prompt 1] Block completed. -> SUCCESS (1.3 s)\n  input: line 1 line 2",
    );
  });

  it("falls back to block id and output preview with millisecond duration", () => {
    expect(
      formatRalphSimpleMarkdownEntry(
        createSimpleLogEntry({
          blockId: "prompt-1",
          durationMs: 999,
          outputPreview: "done\r\nnow",
        }),
      ),
    ).toBe(
      "- 2026-06-18T19:00:00.000Z [prompt-1] Block completed. (999 ms)\n  output: done now",
    );
  });

  it("omits optional sections for empty markdown details", () => {
    expect(formatRalphSimpleMarkdownEntry(createSimpleLogEntry())).toBe(
      "- 2026-06-18T19:00:00.000Z Block completed.",
    );
  });
});

describe("createRalphLogLine", () => {
  it("creates newline-terminated JSON with sanitized trace values", () => {
    expect(createRalphLogLine({ token: "abc123456789", ok: true })).toBe(
      '{"token":"[redacted]","ok":true}\n',
    );
  });
});
