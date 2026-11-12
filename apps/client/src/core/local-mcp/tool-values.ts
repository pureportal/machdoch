import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { LocalToolRuntime } from "./runtime.js";

export const callLocalTool = async (
  runtime: LocalToolRuntime,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> => {
  const { toolResult } = await runtime.call(name, args, signal);
  if (toolResult.isError)
    throw new McpError(ErrorCode.InternalError, toolResult.output);
  try {
    return JSON.parse(toolResult.output) as unknown;
  } catch {
    throw new McpError(
      ErrorCode.InternalError,
      `The ${name} tool returned an unreadable result.`,
    );
  }
};

export const readRecords = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      )
    : [];

export const readText = (
  record: Record<string, unknown>,
  field: string,
): string | undefined => {
  const value = record[field];
  return typeof value === "string" && value.trim() ? value : undefined;
};
