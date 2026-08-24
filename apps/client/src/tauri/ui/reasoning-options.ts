import {
  getReasoningModesForProviderModel,
  normalizeReasoningModeForProviderModel,
} from "../../core/reasoning-modes.js";
import type { ReasoningMode } from "../../core/runtime-contract.generated.js";
import type { RuntimeProvider } from "./model-catalog";
import type { RuntimeModelCapabilities } from "./model-catalog";

export const REASONING_LABELS: Record<ReasoningMode, string> = {
  default: "Provider Default",
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
  ultra: "Ultra",
};

export const getReasoningModesForProvider = (
  provider: RuntimeProvider | null | undefined,
  model?: string | null,
  capabilities?: RuntimeModelCapabilities,
): readonly ReasoningMode[] => {
  return getReasoningModesForProviderModel(
    provider,
    model,
    capabilities?.reasoningModes,
  );
};

export const normalizeReasoningModeForProvider = (
  reasoning: ReasoningMode,
  provider: RuntimeProvider | null | undefined,
  model?: string | null,
  capabilities?: RuntimeModelCapabilities,
): ReasoningMode => {
  return normalizeReasoningModeForProviderModel(
    reasoning,
    provider,
    model,
    capabilities?.reasoningModes,
  );
};
