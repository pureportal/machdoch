import type {
  ConfiguredModelProvider,
  ContextWindow,
} from "./runtime-contract.generated.js";
import {
  isContextWindow,
  MAX_CONTEXT_WINDOW_TOKENS,
  MIN_CONTEXT_WINDOW_TOKENS,
} from "./runtime-contract.generated.js";
import { getDiscoveredLongContextWindowTokens } from "./model-capabilities.js";

const CLAUDE_LONG_CONTEXT_MODEL_PATTERN =
  /^(?:sonnet|opus|sonnet\[1m\]|opus\[1m\]|claude-(?:sonnet|opus)-(?:5|4-[6-9])(?:-|$)|claude-(?:5|4-[6-9])-(?:sonnet|opus)(?:-|$))/u;

export const parseContextWindow = (
  value: unknown,
): ContextWindow | undefined => {
  if (isContextWindow(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  if (isContextWindow(normalized)) {
    return normalized;
  }

  if (!/^\d+$/u.test(normalized)) {
    return undefined;
  }

  const tokens = Number(normalized);
  return isContextWindow(tokens) ? tokens : undefined;
};

export const supportsLongContextWindow = (
  provider: ConfiguredModelProvider | null | undefined,
  model?: string | null,
): boolean => {
  if (provider === "copilot-cli") {
    const discoveredLongContext = model
      ? getDiscoveredLongContextWindowTokens(provider, model)
      : undefined;

    return discoveredLongContext === undefined
      ? true
      : typeof discoveredLongContext === "number" && discoveredLongContext > 0;
  }

  return (
    provider === "claude-cli" &&
    CLAUDE_LONG_CONTEXT_MODEL_PATTERN.test(model?.trim().toLowerCase() ?? "")
  );
};

export const assertContextWindowSupportedForProviderModel = (
  contextWindow: ContextWindow,
  provider: ConfiguredModelProvider,
  model?: string | null,
  discoveredMaximumTokens?: number | null,
): void => {
  if (contextWindow === "default") {
    return;
  }

  const modelName = model?.trim() || "the selected model";

  if (contextWindow === "long") {
    if (supportsLongContextWindow(provider, model)) {
      return;
    }

    throw new Error(
      `Long context is not supported by \`${modelName}\` on \`${provider}\`.`,
    );
  }

  if (provider !== "codex-cli") {
    throw new Error(
      `A numeric context window cannot be configured for \`${modelName}\` on \`${provider}\`.`,
    );
  }

  if (
    contextWindow < MIN_CONTEXT_WINDOW_TOKENS ||
    contextWindow > MAX_CONTEXT_WINDOW_TOKENS
  ) {
    throw new Error(
      `Context window tokens must be between ${MIN_CONTEXT_WINDOW_TOKENS} and ${MAX_CONTEXT_WINDOW_TOKENS}.`,
    );
  }

  if (
    discoveredMaximumTokens !== null &&
    discoveredMaximumTokens !== undefined &&
    contextWindow > discoveredMaximumTokens
  ) {
    throw new Error(
      `Context window ${contextWindow} exceeds the discovered ${discoveredMaximumTokens}-token limit for \`${modelName}\`.`,
    );
  }
};

export const resolveClaudeCliModelForContextWindow = (
  model: string,
  contextWindow: ContextWindow,
): string => {
  assertContextWindowSupportedForProviderModel(
    contextWindow,
    "claude-cli",
    model,
  );

  if (contextWindow !== "long" || model.toLowerCase().endsWith("[1m]")) {
    return model;
  }

  return `${model}[1m]`;
};
