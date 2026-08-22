import type {
  AgentModelStreamEvent,
  AgentModelStreamEventHandler,
  AgentModelStreamUsage,
  AgentModelToolResult,
} from "../../types.js";
import type { ModelProvider } from "../../runtime-contract.generated.js";

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const getNumber = (
  record: Record<string, unknown>,
  key: string,
): number | undefined => {
  const value = record[key];

  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

const getString = (
  record: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = record[key];

  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const getNestedRecord = (
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined => {
  const value = record[key];

  return isRecord(value) ? value : undefined;
};

export const emitProviderStreamEvent = (
  onStreamEvent: AgentModelStreamEventHandler | undefined,
  event: AgentModelStreamEvent,
): void => {
  try {
    onStreamEvent?.(event);
  } catch {
    // Stream events are best-effort progress updates.
  }
};

export const emitProviderStreamStatus = (
  onStreamEvent: AgentModelStreamEventHandler | undefined,
  provider: ModelProvider,
  status: Extract<AgentModelStreamEvent, { type: "status" }>["status"],
  message: string,
  rawEventType?: string,
): void => {
  emitProviderStreamEvent(onStreamEvent, {
    type: "status",
    provider,
    status,
    message,
    ...(rawEventType ? { rawEventType } : {}),
  });
};

export const emitProviderStreamError = (
  onStreamEvent: AgentModelStreamEventHandler | undefined,
  provider: ModelProvider,
  error: unknown,
): void => {
  if (isRecord(error)) {
    const nestedError = getNestedRecord(error, "error");
    const detail = nestedError ?? error;
    const message =
      getString(detail, "message") ??
      getString(error, "message") ??
      String(error);
    const code = getString(detail, "code");
    const param = getString(detail, "param");

    const streamError: AgentModelStreamEvent = {
      type: "error",
      provider,
      message,
      raw: error,
    };

    if (code) {
      streamError.code = code;
    }

    if (param) {
      streamError.param = param;
    }

    emitProviderStreamEvent(onStreamEvent, streamError);
    return;
  }

  emitProviderStreamEvent(onStreamEvent, {
    type: "error",
    provider,
    message: error instanceof Error ? error.message : String(error),
    raw: error,
  });
};

export const emitToolResultStreamEvents = (
  onStreamEvent: AgentModelStreamEventHandler | undefined,
  provider: ModelProvider,
  toolResults: AgentModelToolResult[],
): void => {
  for (const toolResult of toolResults) {
    emitProviderStreamEvent(onStreamEvent, {
      type: "tool-result",
      provider,
      id: toolResult.callId,
      name: toolResult.name,
      output: toolResult.output,
      ...(toolResult.isError ? { isError: true } : {}),
      ...(toolResult.content ? { content: toolResult.content } : {}),
    });
  }
};

export const emitUsageStreamEvent = (
  onStreamEvent: AgentModelStreamEventHandler | undefined,
  provider: ModelProvider,
  usage: AgentModelStreamUsage | undefined,
): void => {
  if (!usage) {
    return;
  }

  emitProviderStreamEvent(onStreamEvent, {
    type: "usage",
    provider,
    usage,
  });
};

export const normalizeOpenAIUsage = (
  usage: unknown,
): AgentModelStreamUsage | undefined => {
  if (!isRecord(usage)) {
    return undefined;
  }

  const inputDetails =
    getNestedRecord(usage, "input_tokens_details") ??
    getNestedRecord(usage, "prompt_tokens_details");
  const outputDetails =
    getNestedRecord(usage, "output_tokens_details") ??
    getNestedRecord(usage, "completion_tokens_details");
  const inputTokens =
    getNumber(usage, "input_tokens") ?? getNumber(usage, "prompt_tokens");
  const outputTokens =
    getNumber(usage, "output_tokens") ?? getNumber(usage, "completion_tokens");
  const totalTokens = getNumber(usage, "total_tokens");
  const cachedInputTokens = inputDetails
    ? getNumber(inputDetails, "cached_tokens")
    : undefined;
  const reasoningTokens = outputDetails
    ? getNumber(outputDetails, "reasoning_tokens")
    : undefined;
  const normalized: AgentModelStreamUsage = { raw: usage };

  if (inputTokens !== undefined) {
    normalized.inputTokens = inputTokens;
  }

  if (outputTokens !== undefined) {
    normalized.outputTokens = outputTokens;
  }

  if (totalTokens !== undefined) {
    normalized.totalTokens = totalTokens;
  }

  if (cachedInputTokens !== undefined) {
    normalized.cachedInputTokens = cachedInputTokens;
  }

  if (reasoningTokens !== undefined) {
    normalized.reasoningTokens = reasoningTokens;
  }

  return normalized;
};

export const normalizeAnthropicUsage = (
  usage: unknown,
): AgentModelStreamUsage | undefined => {
  if (!isRecord(usage)) {
    return undefined;
  }

  const cacheCreationTokens =
    getNumber(usage, "cache_creation_input_tokens") ?? 0;
  const cacheReadTokens = getNumber(usage, "cache_read_input_tokens") ?? 0;
  const inputTokens = getNumber(usage, "input_tokens");
  const outputTokens = getNumber(usage, "output_tokens");

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(inputTokens !== undefined && outputTokens !== undefined
      ? { totalTokens: inputTokens + outputTokens }
      : {}),
    ...(cacheCreationTokens + cacheReadTokens > 0
      ? { cachedInputTokens: cacheCreationTokens + cacheReadTokens }
      : {}),
    raw: usage,
  };
};

export const normalizeGeminiUsage = (
  usage: unknown,
): AgentModelStreamUsage | undefined => {
  if (!isRecord(usage)) {
    return undefined;
  }

  const normalized: AgentModelStreamUsage = { raw: usage };
  const inputTokens = getNumber(usage, "promptTokenCount");
  const outputTokens = getNumber(usage, "candidatesTokenCount");
  const totalTokens = getNumber(usage, "totalTokenCount");
  const reasoningTokens = getNumber(usage, "thoughtsTokenCount");

  if (inputTokens !== undefined) {
    normalized.inputTokens = inputTokens;
  }

  if (outputTokens !== undefined) {
    normalized.outputTokens = outputTokens;
  }

  if (totalTokens !== undefined) {
    normalized.totalTokens = totalTokens;
  }

  if (reasoningTokens !== undefined) {
    normalized.reasoningTokens = reasoningTokens;
  }

  return normalized;
};

export const getProviderEventString = (
  event: unknown,
  key: string,
): string | undefined => {
  return isRecord(event) ? getString(event, key) : undefined;
};
