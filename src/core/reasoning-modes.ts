import type { ConfiguredModelProvider } from "./provider-model-registry.js";
import type { ReasoningMode } from "./runtime-contract.generated.js";
import { normalizeModelId } from "../helpers/normalize-model-id.helper.js";

const ALL_REASONING_MODES = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ReasoningMode[];

const OPENAI_GPT_55_REASONING_MODES = [
  "default",
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly ReasoningMode[];

const OPENAI_GPT_54_REASONING_MODES = OPENAI_GPT_55_REASONING_MODES;

const OPENAI_GPT_5_REASONING_MODES = [
  "default",
  "minimal",
  "low",
  "medium",
  "high",
] as const satisfies readonly ReasoningMode[];

const OPENAI_DEFAULT_REASONING_MODES = [
  "default",
  "low",
  "medium",
  "high",
] as const satisfies readonly ReasoningMode[];

const ANTHROPIC_OPUS_47_PLUS_REASONING_MODES = [
  "default",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ReasoningMode[];

const ANTHROPIC_MAX_REASONING_MODES = [
  "default",
  "low",
  "medium",
  "high",
  "max",
] as const satisfies readonly ReasoningMode[];

const ANTHROPIC_DEFAULT_REASONING_MODES = [
  "default",
  "low",
  "medium",
  "high",
] as const satisfies readonly ReasoningMode[];

const DEFAULT_ONLY_REASONING_MODES = [
  "default",
] as const satisfies readonly ReasoningMode[];

const GEMINI_3_REASONING_MODES = [
  "default",
  "minimal",
  "low",
  "medium",
  "high",
] as const satisfies readonly ReasoningMode[];

const GEMINI_3_PRO_REASONING_MODES = [
  "default",
  "low",
  "medium",
  "high",
] as const satisfies readonly ReasoningMode[];

const GEMINI_25_REASONING_MODES = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
] as const satisfies readonly ReasoningMode[];

const GEMINI_25_PRO_REASONING_MODES = [
  "default",
  "minimal",
  "low",
  "medium",
  "high",
] as const satisfies readonly ReasoningMode[];

const CODEX_CLI_REASONING_MODES = [
  "default",
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly ReasoningMode[];

const COPILOT_CLI_REASONING_MODES = [
  "default",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ReasoningMode[];

const isOpenAiGpt55Model = (model: string): boolean =>
  /^gpt-5\.5(?:-|$)/u.test(model);

const isOpenAiGpt54Model = (model: string): boolean =>
  /^gpt-5\.4(?:-(?:mini|nano))?(?:-|$)/u.test(model);

const isOpenAiGpt5Model = (model: string): boolean =>
  /^gpt-5(?:-(?:mini|nano))?(?:-|$)/u.test(model);

const isAnthropicOpus47PlusModel = (model: string): boolean =>
  /^claude-(?:opus-4-[78]|4-[78]-opus)(?:-|$)/u.test(model);

const isAnthropicMaxEffortModel = (model: string): boolean =>
  /^claude-(?:opus-4-[56]|4-[56]-opus|sonnet-4-6|4-6-sonnet)(?:-|$)/u.test(
    model,
  );

const isAnthropicEffortModel = (model: string): boolean =>
  /^claude-(?:fable-5|mythos-5|mythos-preview)(?:-|$)/u.test(model);

const isGemini25Model = (model: string): boolean =>
  /\bgemini-2\.5\b/u.test(model);

const isGemini25ProModel = (model: string): boolean =>
  /\bgemini-2\.5\b.*\bpro\b/u.test(model);

const isGemini3Model = (model: string): boolean =>
  /\bgemini-3(?:\.\d+)?\b/u.test(model);

const isGemini3ProModel = (model: string): boolean =>
  /\bgemini-3(?:\.\d+)?\b.*\bpro\b/u.test(model);

const getOpenAiReasoningModes = (
  model: string,
): readonly ReasoningMode[] => {
  if (isOpenAiGpt55Model(model)) {
    return OPENAI_GPT_55_REASONING_MODES;
  }

  if (isOpenAiGpt54Model(model)) {
    return OPENAI_GPT_54_REASONING_MODES;
  }

  if (isOpenAiGpt5Model(model)) {
    return OPENAI_GPT_5_REASONING_MODES;
  }

  return OPENAI_DEFAULT_REASONING_MODES;
};

const getAnthropicReasoningModes = (
  model: string,
): readonly ReasoningMode[] => {
  if (isAnthropicOpus47PlusModel(model) || isAnthropicEffortModel(model)) {
    return ANTHROPIC_OPUS_47_PLUS_REASONING_MODES;
  }

  if (isAnthropicMaxEffortModel(model)) {
    return ANTHROPIC_MAX_REASONING_MODES;
  }

  if (model.includes("haiku-4-5") || model.includes("4-5-haiku")) {
    return DEFAULT_ONLY_REASONING_MODES;
  }

  return ANTHROPIC_DEFAULT_REASONING_MODES;
};

const getGoogleReasoningModes = (
  model: string,
): readonly ReasoningMode[] => {
  if (isGemini25ProModel(model)) {
    return GEMINI_25_PRO_REASONING_MODES;
  }

  if (isGemini25Model(model)) {
    return GEMINI_25_REASONING_MODES;
  }

  if (isGemini3ProModel(model)) {
    return GEMINI_3_PRO_REASONING_MODES;
  }

  if (isGemini3Model(model)) {
    return GEMINI_3_REASONING_MODES;
  }

  return ANTHROPIC_DEFAULT_REASONING_MODES;
};

export const getReasoningModesForProviderModel = (
  provider: ConfiguredModelProvider | null | undefined,
  model?: string | null,
): readonly ReasoningMode[] => {
  if (!provider) {
    return ALL_REASONING_MODES;
  }

  const normalizedModel = normalizeModelId(model);

  switch (provider) {
    case "openai":
      return getOpenAiReasoningModes(normalizedModel);
    case "anthropic":
    case "claude-cli":
      return getAnthropicReasoningModes(normalizedModel);
    case "google":
      return getGoogleReasoningModes(normalizedModel);
    case "codex-cli":
      return CODEX_CLI_REASONING_MODES;
    case "copilot-cli":
      return COPILOT_CLI_REASONING_MODES;
  }
};

const pickFirstSupported = (
  supportedModes: readonly ReasoningMode[],
  fallbackModes: readonly ReasoningMode[],
): ReasoningMode =>
  fallbackModes.find((mode) => supportedModes.includes(mode)) ??
  supportedModes[0] ??
  "default";

export const normalizeReasoningModeForProviderModel = (
  reasoning: ReasoningMode,
  provider: ConfiguredModelProvider | null | undefined,
  model?: string | null,
): ReasoningMode => {
  const supportedModes = getReasoningModesForProviderModel(provider, model);

  if (supportedModes.includes(reasoning)) {
    return reasoning;
  }

  switch (reasoning) {
    case "max":
      return pickFirstSupported(supportedModes, ["xhigh", "high", "default"]);
    case "xhigh":
      return pickFirstSupported(supportedModes, ["high", "max", "default"]);
    case "none":
      return pickFirstSupported(supportedModes, [
        "minimal",
        "low",
        "default",
      ]);
    case "minimal":
      return pickFirstSupported(supportedModes, ["low", "none", "default"]);
    case "medium":
      return pickFirstSupported(supportedModes, ["low", "high", "default"]);
    case "low":
      return pickFirstSupported(supportedModes, [
        "minimal",
        "medium",
        "default",
      ]);
    case "high":
      return pickFirstSupported(supportedModes, ["medium", "max", "default"]);
    case "default":
      return "default";
  }
};
