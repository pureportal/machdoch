import { readFile } from "node:fs/promises";
import type { AgentModelStreamUsage } from "../types.js";

interface CopilotCliTelemetry {
  modelCallCount: number;
  usage?: AgentModelStreamUsage;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0
      ? Math.trunc(parsed)
      : undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of [
    "intValue",
    "doubleValue",
    "stringValue",
    "value",
  ] as const) {
    const parsed = parseNumber(value[key]);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
};

const parseString = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of ["stringValue", "value"] as const) {
    const parsed = parseString(value[key]);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
};

const normalizeAttributes = (
  value: unknown,
): Record<string, unknown> | undefined => {
  if (Array.isArray(value)) {
    const attributes: Record<string, unknown> = {};

    for (const entry of value) {
      if (!isRecord(entry) || typeof entry.key !== "string") {
        continue;
      }
      attributes[entry.key] = entry.value;
    }

    return Object.keys(attributes).length > 0 ? attributes : undefined;
  }

  return isRecord(value) ? value : undefined;
};

const collectSpanAttributes = (value: unknown): Record<string, unknown>[] => {
  const attributes: Record<string, unknown>[] = [];
  const pending = [value];

  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (!isRecord(current)) {
      continue;
    }

    const normalized = normalizeAttributes(current.attributes);
    if (normalized) {
      attributes.push(normalized);
    }

    pending.push(...Object.values(current));
  }

  return attributes;
};

const getTokenCount = (
  attributes: Record<string, unknown>,
  key: string,
): number => parseNumber(attributes[key]) ?? 0;

const aggregateUsage = (
  spans: readonly Record<string, unknown>[],
): AgentModelStreamUsage | undefined => {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let reasoningTokens = 0;
  let usageReported = false;

  for (const attributes of spans) {
    usageReported ||= [
      "gen_ai.usage.input_tokens",
      "gen_ai.usage.output_tokens",
      "gen_ai.usage.cache_read.input_tokens",
      "gen_ai.usage.cache_creation.input_tokens",
      "gen_ai.usage.reasoning_tokens",
    ].some((key) => parseNumber(attributes[key]) !== undefined);
    inputTokens += getTokenCount(attributes, "gen_ai.usage.input_tokens");
    outputTokens += getTokenCount(attributes, "gen_ai.usage.output_tokens");
    cacheReadInputTokens += getTokenCount(
      attributes,
      "gen_ai.usage.cache_read.input_tokens",
    );
    cacheWriteInputTokens += getTokenCount(
      attributes,
      "gen_ai.usage.cache_creation.input_tokens",
    );
    reasoningTokens += getTokenCount(
      attributes,
      "gen_ai.usage.reasoning_tokens",
    );
  }

  if (!usageReported) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cacheReadInputTokens > 0
      ? {
          cachedInputTokens: cacheReadInputTokens,
          cacheReadInputTokens,
        }
      : {}),
    ...(cacheWriteInputTokens > 0 ? { cacheWriteInputTokens } : {}),
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
  };
};

const getOperation = (
  attributes: Record<string, unknown>,
): string | undefined => parseString(attributes["gen_ai.operation.name"]);

const selectInvokeAgentSpan = (
  spans: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined =>
  [...spans].sort((left, right) => {
    const leftTopLevel = left["server.address"] === undefined ? 0 : 1;
    const rightTopLevel = right["server.address"] === undefined ? 0 : 1;
    if (leftTopLevel !== rightTopLevel) {
      return rightTopLevel - leftTopLevel;
    }

    const leftTokens =
      getTokenCount(left, "gen_ai.usage.input_tokens") +
      getTokenCount(left, "gen_ai.usage.output_tokens");
    const rightTokens =
      getTokenCount(right, "gen_ai.usage.input_tokens") +
      getTokenCount(right, "gen_ai.usage.output_tokens");
    return rightTokens - leftTokens;
  })[0];

export const parseCopilotCliTelemetry = (
  content: string,
): CopilotCliTelemetry | undefined => {
  const spans: Record<string, unknown>[] = [];

  for (const line of content.split(/\r?\n/u)) {
    if (line.trim().length === 0) {
      continue;
    }

    try {
      spans.push(...collectSpanAttributes(JSON.parse(line) as unknown));
    } catch {
      continue;
    }
  }

  const chatSpans = spans.filter(
    (attributes) => getOperation(attributes) === "chat",
  );
  if (chatSpans.length > 0) {
    const usage = aggregateUsage(chatSpans);
    return {
      modelCallCount: chatSpans.length,
      ...(usage ? { usage } : {}),
    };
  }

  const invokeAgentSpan = selectInvokeAgentSpan(
    spans.filter((attributes) => getOperation(attributes) === "invoke_agent"),
  );
  if (!invokeAgentSpan) {
    return undefined;
  }

  const usage = aggregateUsage([invokeAgentSpan]);
  return {
    modelCallCount: Math.max(
      1,
      parseNumber(invokeAgentSpan["github.copilot.turn_count"]) ?? 1,
    ),
    ...(usage ? { usage } : {}),
  };
};

export const readCopilotCliTelemetry = async (
  path: string,
): Promise<CopilotCliTelemetry | undefined> => {
  try {
    return parseCopilotCliTelemetry(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
};
