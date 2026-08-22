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
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu, "<timestamp>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, "<uuid>")
    .replace(/\b\d+(?:\.\d+)?\s*ms\b/giu, "<duration>");
  return normalized.length > MAX_RALPH_FAILURE_SIGNATURE_CHARS
    ? normalized.slice(0, MAX_RALPH_FAILURE_SIGNATURE_CHARS)
    : normalized;
};

const stringifyFailureSignatureValue = (value: unknown): string => {
  if (value === undefined) {
    return "";
  }

  try {
    return compactFailureSignatureText(JSON.stringify(value));
  } catch {
    return compactFailureSignatureText(String(value));
  }
};

export const createRalphFailureSignature = (
  result: RalphBlockExecutionResult,
): string | undefined => {
  if (!isRepeatableRalphFailureOutput(result)) {
    return undefined;
  }

  const payload = [
    result.blockId,
    result.output,
    result.status,
    compactFailureSignatureText(result.summary),
    compactFailureSignatureText(result.error ?? ""),
    compactFailureSignatureText(result.markdown ?? ""),
    stringifyFailureSignatureValue(result.data),
  ].join("\n");

  return createHash("sha256").update(payload).digest("hex");
};
