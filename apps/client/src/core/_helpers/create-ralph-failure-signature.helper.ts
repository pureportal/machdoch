import { createHash } from "node:crypto";
import type { RalphBlockExecutionResult } from "../ralph.js";

export const MAX_RALPH_FAILURE_SIGNATURE_CHARS = 8_000;

const isRepeatableRalphFailureOutput = (
  result: RalphBlockExecutionResult,
): boolean => {
  if (result.output === "SUCCESS" || result.output === "DONE") {
    return false;
  }

  return (
    result.status === "error" ||
    result.output === "FAILED" ||
    result.output === "INVALID" ||
    result.output === "TIMEOUT" ||
    result.output === "HTTP_ERROR" ||
    result.output === "UNAVAILABLE"
  );
};

const compactFailureSignatureText = (value: string): string => {
  const normalized = value
    .replace(
      /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu,
      "<timestamp>",
    )
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu,
      "<uuid>",
    )
    .replace(/\b\d+(?:\.\d+)?\s*ms\b/giu, "<duration>");
  return normalized.length > MAX_RALPH_FAILURE_SIGNATURE_CHARS
    ? normalized.slice(0, MAX_RALPH_FAILURE_SIGNATURE_CHARS)
    : normalized;
};

const normalizeFailureSignatureValue = (
  value: unknown,
  ancestors = new WeakSet<object>(),
): unknown => {
  if (typeof value === "string") {
    return compactFailureSignatureText(value);
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (value === undefined) {
    return { type: "undefined" };
  }
  if (typeof value === "bigint") {
    return { type: "bigint", value: value.toString() };
  }
  if (typeof value === "symbol") {
    return { type: "symbol", description: value.description ?? "" };
  }
  if (typeof value === "function") {
    return { type: "function", name: value.name };
  }
  if (ancestors.has(value)) {
    return { type: "circular-reference" };
  }

  ancestors.add(value);
  const normalized = Array.isArray(value)
    ? value.map((entry) => normalizeFailureSignatureValue(entry, ancestors))
    : Object.fromEntries(
        Object.keys(value)
          .sort((left, right) => left.localeCompare(right))
          .map((key) => [
            key,
            normalizeFailureSignatureValue(
              (value as Record<string, unknown>)[key],
              ancestors,
            ),
          ]),
      );
  ancestors.delete(value);
  return normalized;
};

const serializeFailureSignatureValue = (value: unknown): string =>
  compactFailureSignatureText(
    JSON.stringify(normalizeFailureSignatureValue(value)),
  );

export const createRalphFailureSignature = (
  result: RalphBlockExecutionResult,
): string | undefined => {
  if (!isRepeatableRalphFailureOutput(result)) {
    return undefined;
  }

  const payload = {
    blockId: result.blockId,
    output: result.output,
    status: result.status,
    summary: compactFailureSignatureText(result.summary),
    error: compactFailureSignatureText(result.error ?? ""),
    markdown: compactFailureSignatureText(result.markdown ?? ""),
    ...(result.data === undefined
      ? {}
      : { data: serializeFailureSignatureValue(result.data) }),
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
};
