import type {
  ContextWindow,
  ModelProvider,
} from "./runtime-contract.generated.js";
import { isContextWindow } from "./runtime-contract.generated.js";
import {
  getDiscoveredModelCapabilities,
  getModelContextWindowTokens,
} from "@machdoch/model-runtime/model-capabilities";
import {
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
  const resolved = resolveContextWindowForProviderModel(
    contextWindow,
    "claude-cli",
    model,
  );
  const baseModel = model.replace(/\[1m\]$/iu, "");
  if (resolved === "long") return `${baseModel}[1m]`;
  return contextWindow === "lowest" ? baseModel : model;
};
