import type { AgentModelToolResult } from "@machdoch/model-runtime/types";

export const MAX_WORKER_TOOL_CALLS = 24;
export const MAX_WORKER_TEXT = 12_000;
export const WORKER_WRITE_TOOLS = new Set(["create_file", "replace_in_file"]);

export class WorkerBoundaryError extends Error {}

export interface ParallelWorkerState {
  toolCalls: number;
  successfulWrites: number;
  answer: string;
  toolErrors: { name: string; output: string }[];
}

export const recordWorkerToolResult = (
  state: ParallelWorkerState,
  result: AgentModelToolResult,
): void => {
  if (result.isError) {
    if (state.toolErrors.length < MAX_WORKER_TOOL_CALLS) {
      state.toolErrors.push({
        name: result.name,
        output: result.output.slice(0, 300),
      });
    }
  } else if (WORKER_WRITE_TOOLS.has(result.name)) {
    state.successfulWrites += 1;
  }
};

export const workerResult = (
  id: string,
  state: ParallelWorkerState,
  error?: unknown,
) => {
  const message =
    error === undefined
      ? undefined
      : error instanceof Error
        ? error.message
        : String(error);
  return {
    id,
    status:
      message === undefined ? ("completed" as const) : ("failed" as const),
    answer: (state.answer || message || "").slice(0, MAX_WORKER_TEXT),
    toolCalls: state.toolCalls,
    ...(state.successfulWrites > 0
      ? { successfulWrites: state.successfulWrites }
      : {}),
    ...(state.toolErrors.length ? { toolErrors: state.toolErrors } : {}),
    ...(message !== undefined
      ? { error: message.slice(0, MAX_WORKER_TEXT) }
      : {}),
  };
};
