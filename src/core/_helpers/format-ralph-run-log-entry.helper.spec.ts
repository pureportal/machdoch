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

  it("redacts inline bearer tokens, secret values, and OpenAI-style keys before truncating", () => {
    const capped = capLogText(
      "Bearer abcdefghijklmnop token=abc123456789 sk-abcdefghijklmnopqrstuvwx",
      200,
    );

    expect(capped).toBe("Bearer [redacted] token= [redacted] [redacted]");
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

  it("redacts sensitive object keys and preserves safe nested values", () => {
    expect(
      sanitizeTraceValue({
        status: "ok",
        password: "value",
        nested: {
          authorizationHeader: "Bearer abcdefghijklmnop",
          visible: "yes",
        },
      }),
    ).toEqual({
      status: "ok",
      password: "[redacted]",
      nested: {
        authorizationHeader: "[redacted]",
        visible: "yes",
      },
    });
  });

  it("sanitizes error name, message, and stack", () => {
    const error = new TypeError("token=abc123456789");
    error.stack = "TypeError: password=abc123456789";

    expect(sanitizeTraceValue(error)).toEqual({
      name: "TypeError",
      message: "token= [redacted]",
      stack: "TypeError: password= [redacted]",
    });
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
