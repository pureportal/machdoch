import type {
  ConfiguredModelProvider,
  ContextWindow,
} from "./runtime-contract.generated.js";
import {
  isContextWindow,
  MAX_CONTEXT_WINDOW_TOKENS,
  MIN_CONTEXT_WINDOW_TOKENS,
} from "./runtime-contract.generated.js";
import {
  getDiscoveredModelCapabilities,
  getModelContextWindowTokens,
} from "./model-capabilities.js";
import { contextWindowCapabilities } from "@machdoch/fleet-protocol/context-window";

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
  return (
    contextWindowCapabilities(
      provider,
      model,
      provider && model
        ? getDiscoveredModelCapabilities(provider, model)
        : undefined,
    ).kind === "presets"
  );
};

export const assertContextWindowSupportedForProviderModel = (
  contextWindow: ContextWindow,
  provider: ConfiguredModelProvider,
  model?: string | null,
  discoveredMaximumTokens?: number | null,
): void => {
  if (!isContextWindow(contextWindow))
    throw new Error("Choose a valid context size.");
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

  if (
    provider !== "codex-cli" ||
    !model ||
    !getModelContextWindowTokens(provider, model)
  ) {
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

  const maximum =
    discoveredMaximumTokens ?? getModelContextWindowTokens(provider, model);
  if (maximum && contextWindow > maximum) {
    throw new Error(
      `Context window ${contextWindow} exceeds the discovered ${maximum}-token limit for \`${modelName}\`.`,
    );
  }
};

export const retainSupportedContextWindow = (
  value: ContextWindow | undefined,
  provider: ConfiguredModelProvider | "unconfigured",
  model: string,
): ContextWindow | undefined => {
  if (value === undefined || provider === "unconfigured") return undefined;
  const maximum = getModelContextWindowTokens(provider, model);
  return value === "default" ||
    (value === "long"
      ? supportsLongContextWindow(provider, model)
      : provider === "codex-cli" && maximum !== null && value <= maximum)
    ? value
    : undefined;
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
