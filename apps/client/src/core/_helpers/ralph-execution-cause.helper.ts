import type { RalphBlockExecutionResult } from "../ralph.js";

const failureOutputs = new Set([
  "ERROR",
  "FAILED",
  "INCONCLUSIVE",
  "INVALID",
  "NOT_FOUND",
  "OUT_OF_SCOPE",
  "ADVISORY",
  "TIMEOUT",
  "UNAVAILABLE",
]);

export const findRalphExecutionCause = (
  results: readonly RalphBlockExecutionResult[],
  beforeIndex = results.length,
):
  | {
      blockId: string;
      output: string;
      summary: string;
      category?: string;
      retryCondition?: string;
    }
  | undefined => {
  const reviewedBlockIds = new Set<string>();
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const result = results[index]!;
    const data = result.data as Record<string, unknown> | undefined;
    if (data?.workOutcome) {
      break;
    }
    if (reviewedBlockIds.has(result.blockId)) {
      continue;
    }
    reviewedBlockIds.add(result.blockId);
    if (result.status !== "error" && !failureOutputs.has(result.output)) {
      continue;
    }
    const diagnostic = data?.diagnostic as Record<string, unknown> | undefined;
    return {
      blockId: result.blockId,
      output: result.output,
      summary: String(
        diagnostic?.message ?? result.error ?? result.summary,
      ).slice(0, 2_000),
      ...(typeof diagnostic?.category === "string"
        ? { category: diagnostic.category.slice(0, 200) }
        : {}),
      ...(typeof diagnostic?.retryCondition === "string"
        ? { retryCondition: diagnostic.retryCondition.slice(0, 2_000) }
        : {}),
    };
  }
  return undefined;
};
