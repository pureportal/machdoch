import type {
  ContextWindow,
  ModelProvider,
} from "./runtime-contract.generated.js";
import { isContextWindow } from "./runtime-contract.generated.js";
import {
  getDiscoveredLongContextWindowTokens,
  getDiscoveredModelCapabilities,
  getModelContextWindowTokens,
} from "@machdoch/model-runtime/model-capabilities";
import {
  autoCompactTokens,
  contextWindowCapabilities,
  resolveProviderContextWindow,
} from "@machdoch/fleet-protocol/context-window";

export const parseContextWindow = (
  value: unknown,
): ContextWindow | undefined => {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : value;
  return isContextWindow(normalized) ? normalized : undefined;
};

export const getContextWindowCapabilities = (
  provider: ModelProvider,
  model: string,
) => {
  const discovered = getDiscoveredModelCapabilities(provider, model);
  return contextWindowCapabilities(provider, model, {
    ...discovered,
    contextWindowTokens:
      discovered?.contextWindowTokens ??
      (provider === "codex-cli" || provider === "claude-cli"
        ? null
        : getModelContextWindowTokens(provider, model)),
  });
};

export const resolveContextWindowForProviderModel = (
  value: ContextWindow,
  provider: ModelProvider,
  model: string,
): "default" | "long" | number =>
  resolveProviderContextWindow(
    value,
    getContextWindowCapabilities(provider, model),
  );

export const resolveClaudeCliModelForContextWindow = (
  model: string,
  contextWindow: ContextWindow,
): string => {
  const baseModel = model.replace(/\[1m\]$/iu, "");
  if (
    contextWindow === "highest" &&
    (getDiscoveredLongContextWindowTokens("claude-cli", model) ?? 0) > 0
  )
    return `${baseModel}[1m]`;
  return contextWindow === "lowest" ? baseModel : model;
};

export const resolveAutoCompactionForProviderModel = (
  value: ContextWindow,
  provider: ModelProvider,
  model: string,
): { tokens: number; windowShare: number } | undefined => {
  const supported = getContextWindowCapabilities(provider, model);
  const tokens = autoCompactTokens(value, supported);
  return tokens === null || supported.defaultTokens === null
    ? undefined
    : { tokens, windowShare: tokens / supported.defaultTokens };
};
