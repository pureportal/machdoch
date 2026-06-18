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
  return value.length > MAX_RALPH_FAILURE_SIGNATURE_CHARS
    ? value.slice(0, MAX_RALPH_FAILURE_SIGNATURE_CHARS)
    : value;
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
    result.summary,
    result.error ?? "",
    result.markdown ?? "",
    stringifyFailureSignatureValue(result.data),
  ].join("\n");

  return createHash("sha256").update(payload).digest("hex");
};
