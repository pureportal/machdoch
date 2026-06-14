import {
  getReasoningModesForProviderModel,
  normalizeReasoningModeForProviderModel,
} from "../../core/reasoning-modes.js";
import type { ReasoningMode } from "../../core/types.js";
import type { RuntimeProvider } from "./model-catalog";

export const REASONING_LABELS: Record<ReasoningMode, string> = {
  default: "Provider Default",
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

export const getReasoningModesForProvider = (
  provider: RuntimeProvider | null | undefined,
  model?: string | null,
): readonly ReasoningMode[] => {
  return getReasoningModesForProviderModel(provider, model);
};

export const normalizeReasoningModeForProvider = (
  reasoning: ReasoningMode,
  provider: RuntimeProvider | null | undefined,
  model?: string | null,
): ReasoningMode => {
  return normalizeReasoningModeForProviderModel(reasoning, provider, model);
};
