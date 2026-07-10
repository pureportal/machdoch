import { createHash } from "node:crypto";
import type { RalphBlockExecutionResult } from "../ralph.ts";
import {
  createRalphFailureSignature,
  MAX_RALPH_FAILURE_SIGNATURE_CHARS,
} from "./create-ralph-failure-signature.helper.ts";

const createResult = (
  overrides: Partial<RalphBlockExecutionResult> = {},
): RalphBlockExecutionResult => ({
  blockId: "validator",
  output: "ERROR",
  status: "error",
  attempt: 1,
  summary: "Validation failed.",
  ...overrides,
});

const hashPayload = (parts: readonly string[]): string => {
  return createHash("sha256").update(parts.join("\n")).digest("hex");
};

describe("createRalphFailureSignature", () => {
  it.each(["ERROR", "FAILED", "INVALID", "TIMEOUT", "HTTP_ERROR", "UNAVAILABLE"] as const)(
    "creates a deterministic signature for repeatable %s output",
    (output) => {
      const result = createResult({
        output,
        status: output === "ERROR" ? "error" : "completed",
        markdown: "Full result markdown",
        error: "Tool returned an error",
        data: { reason: "missing value" },
      });

      const expected = hashPayload([
        "validator",
        output,
        output === "ERROR" ? "error" : "completed",
        "Validation failed.",
        "Tool returned an error",
        "Full result markdown",
        '{"reason":"missing value"}',
      ]);

      expect(createRalphFailureSignature(result)).toBe(expected);
      expect(createRalphFailureSignature(result)).toBe(expected);
    },
  );

  it.each([
    createResult({ output: "SUCCESS", status: "completed" }),
    createResult({ output: "DONE", status: "completed" }),
    createResult({ output: "CONTINUE", status: "completed" }),
    createResult({ output: "RETRY", status: "skipped" }),
  ])("returns undefined for non-repeatable result %#", (result) => {
    expect(createRalphFailureSignature(result)).toBeUndefined();
  });

  it("includes block id, output, status, summary, error, markdown, and data in the signature", () => {
    const base = createResult();

    expect(createRalphFailureSignature(base)).not.toBe(
      createRalphFailureSignature(createResult({ blockId: "other" })),
    );
    expect(createRalphFailureSignature(base)).not.toBe(
      createRalphFailureSignature(createResult({ output: "FAILED" })),
    );
    expect(createRalphFailureSignature(base)).not.toBe(
      createRalphFailureSignature(createResult({ status: "completed" })),
    );
    expect(createRalphFailureSignature(base)).not.toBe(
      createRalphFailureSignature(createResult({ summary: "Different summary." })),
    );
    expect(createRalphFailureSignature(base)).not.toBe(
      createRalphFailureSignature(createResult({ error: "Different error" })),
    );
    expect(createRalphFailureSignature(base)).not.toBe(
      createRalphFailureSignature(createResult({ markdown: "Different markdown" })),
    );
    expect(createRalphFailureSignature(base)).not.toBe(
      createRalphFailureSignature(createResult({ data: null })),
    );
  });

  it("treats omitted and undefined optional fields as empty signature parts", () => {
    const omitted = createResult();
    const explicitUndefined = createResult();
    Object.assign(explicitUndefined, {
      error: undefined,
      markdown: undefined,
      data: undefined,
    });

    expect(createRalphFailureSignature(explicitUndefined)).toBe(
      createRalphFailureSignature(omitted),
    );
  });

  it("distinguishes null data from undefined data", () => {
    expect(createRalphFailureSignature(createResult({ data: null }))).not.toBe(
      createRalphFailureSignature(createResult()),
    );
  });

  it("falls back to string conversion when data cannot be serialized as JSON", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const expected = hashPayload([
      "validator",
      "ERROR",
      "error",
      "Validation failed.",
      "",
      "",
      "[object Object]",
    ]);

    expect(createRalphFailureSignature(createResult({ data: circular }))).toBe(
      expected,
    );
  });

  it("compacts serialized data at the signature boundary", () => {
    const longValue = "x".repeat(MAX_RALPH_FAILURE_SIGNATURE_CHARS + 100);
    const truncatedJson = JSON.stringify(longValue).slice(
      0,
      MAX_RALPH_FAILURE_SIGNATURE_CHARS,
    );

    const expected = hashPayload([
      "validator",
      "ERROR",
      "error",
      "Validation failed.",
      "",
      "",
      truncatedJson,
    ]);

    expect(createRalphFailureSignature(createResult({ data: longValue }))).toBe(
      expected,
    );
  });

  it("ignores timestamps, UUIDs, and duration jitter in repeated failures", () => {
    const first = createResult({
      summary: "Failed at 2026-01-01T00:00:00.000Z after 125ms id 9aa0be52-f28a-4ce5-9962-36802f0444bc",
    });
    const second = createResult({
      summary: "Failed at 2026-02-02T03:04:05.999Z after 980ms id cdf82acd-677a-4d30-94f2-b692ee397cae",
    });

    expect(createRalphFailureSignature(first)).toBe(
      createRalphFailureSignature(second),
    );
  });
});
