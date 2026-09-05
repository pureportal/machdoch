import type { ConfiguredModelProvider } from "./provider-model-registry.js";
import type { ReasoningMode } from "./runtime-contract.generated.js";
import { isReasoningMode } from "./runtime-contract.generated.js";
import { normalizeModelId } from "../helpers/normalize-model-id.helper.js";
import { getDiscoveredReasoningModes } from "./model-capabilities.js";

const ALL_REASONING_MODES = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "aeon",
] as const satisfies readonly ReasoningMode[];

const GPT_6_ASTRA_REASONING_EFFORT_MODES = [
  "default",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ReasoningMode[];

const OPENAI_GPT_6_ASTRA_REASONING_MODES = [
  ...GPT_6_ASTRA_REASONING_EFFORT_MODES,
  "ultra",
] as const satisfies readonly ReasoningMode[];

const CODEX_CLI_GPT_6_ASTRA_REASONING_MODES = [
  ...OPENAI_GPT_6_ASTRA_REASONING_MODES,
  "aeon",
] as const satisfies readonly ReasoningMode[];

const GPT_56_REASONING_EFFORT_MODES = [
  "default",
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ReasoningMode[];

const OPENAI_GPT_56_REASONING_MODES = [
  ...GPT_56_REASONING_EFFORT_MODES,
  "ultra",
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

const OPENAI_GPT_52_REASONING_MODES = OPENAI_GPT_55_REASONING_MODES;

const OPENAI_GPT_51_REASONING_MODES = [
  "default",
  "none",
  "low",
  "medium",
  "high",
] as const satisfies readonly ReasoningMode[];

const OPENAI_GPT_PRO_REASONING_MODES = [
  "default",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly ReasoningMode[];

const OPENAI_GPT_5_PRO_REASONING_MODES = [
  "default",
  "high",
] as const satisfies readonly ReasoningMode[];

const OPENAI_GPT_5_REASONING_MODES = [
  "default",
  "minimal",
  "low",
  "medium",
  "high",
] as const satisfies readonly ReasoningMode[];

const ANTHROPIC_XHIGH_REASONING_MODES = [
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

const GEMINI_3_PRO_PREVIEW_REASONING_MODES = [
  "default",
  "low",
  "high",
] as const satisfies readonly ReasoningMode[];

const GEMINI_31_FLASH_LITE_IMAGE_REASONING_MODES = [
  "default",
  "minimal",
  "high",
] as const satisfies readonly ReasoningMode[];

const GEMINI_25_REASONING_MODES = [
  "default",
  "none",
  "low",
  "medium",
  "high",
] as const satisfies readonly ReasoningMode[];

const GEMINI_25_PRO_REASONING_MODES = [
  "default",
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

const CODEX_CLI_GPT_56_REASONING_MODES = GPT_56_REASONING_EFFORT_MODES;

const CODEX_CLI_GPT_56_SOL_REASONING_MODES = [
  ...GPT_56_REASONING_EFFORT_MODES,
  "ultra",
] as const satisfies readonly ReasoningMode[];

const COPILOT_CLI_REASONING_MODES = [
  "default",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ReasoningMode[];

const TRANSPORT_REASONING_MODES: Record<
  ConfiguredModelProvider,
  readonly ReasoningMode[]
> = {
  openai: ALL_REASONING_MODES.filter((mode) => mode !== "aeon"),
  anthropic: ["default", "low", "medium", "high", "xhigh", "max"],
  google: ["default", "none", "minimal", "low", "medium", "high"],
  langdock: ["default", "none", "minimal", "low", "medium", "high", "xhigh"],
  "codex-cli": ALL_REASONING_MODES,
  "claude-cli": ["default", "low", "medium", "high", "xhigh", "max"],
  "copilot-cli": COPILOT_CLI_REASONING_MODES,
};

const isOpenAiGpt6AstraModel = (model: string): boolean =>
  /^gpt-6-astra(?:-\d{4}-\d{2}-\d{2})?$/u.test(model);

const isOpenAiGpt55Model = (model: string): boolean =>
  /^gpt-5\.5(?:-|$)/u.test(model);

const isOpenAiGpt55ProModel = (model: string): boolean =>
  /^gpt-5\.5-pro(?:-|$)/u.test(model);

const isOpenAiGpt56Model = (model: string): boolean =>
  /^gpt-5\.6(?:-|$)/u.test(model);

const isOpenAiGpt56SolModel = (model: string): boolean =>
  model === "gpt-5.6" || /^gpt-5\.6-sol(?:-|$)/u.test(model);

const isOpenAiGpt54Model = (model: string): boolean =>
  /^gpt-5\.4(?:-(?:mini|nano))?(?:-|$)/u.test(model);

const isOpenAiGpt54ProModel = (model: string): boolean =>
  /^gpt-5\.4-pro(?:-|$)/u.test(model);

const isOpenAiGpt52Model = (model: string): boolean =>
  /^gpt-5\.2(?:-|$)/u.test(model);

const isOpenAiGpt52ProModel = (model: string): boolean =>
  /^gpt-5\.2-pro(?:-|$)/u.test(model);

const isOpenAiGpt51Model = (model: string): boolean =>
  /^gpt-5\.1(?:-|$)/u.test(model);

const isOpenAiGpt5ProModel = (model: string): boolean =>
  /^gpt-5-pro(?:-|$)/u.test(model);

const isOpenAiGpt5Model = (model: string): boolean =>
  /^gpt-5(?:-(?:mini|nano))?(?:-|$)/u.test(model);

const isAnthropicXhighEffortModel = (model: string): boolean =>
  /^(?:best|opus|opus\[1m\])$/u.test(model) ||
  /^claude-(?:(?:fable|mythos|opus|sonnet)-5|5-(?:fable|mythos|opus|sonnet)|opus-4-[78]|4-[78]-opus)(?:-|$)/u.test(
    model,
  );

const isAnthropicMaxEffortModel = (model: string): boolean =>
  /^(?:sonnet|sonnet\[1m\]|opusplan)$/u.test(model) ||
  /^claude-(?:mythos-preview|opus-4-6|4-6-opus|sonnet-4-6|4-6-sonnet)(?:-|$)/u.test(
    model,
  );

const isAnthropicStandardEffortModel = (model: string): boolean =>
  /^claude-(?:opus-4-5|4-5-opus)(?:-|$)/u.test(model);

const isGemini25Model = (model: string): boolean =>
  /\bgemini-2\.5\b/u.test(model);

const isGemini25ProModel = (model: string): boolean =>
  /\bgemini-2\.5\b.*\bpro\b/u.test(model);

const isGemini3ProModel = (model: string): boolean =>
  /\bgemini-3(?:\.\d+)?\b.*\bpro\b/u.test(model);

const isGemini37FlashModel = (model: string): boolean =>
  /\bgemini-3\.7\b.*\bflash\b/u.test(model);

const getOpenAiReasoningModes = (model: string): readonly ReasoningMode[] => {
  if (isOpenAiGpt6AstraModel(model)) {
    return OPENAI_GPT_6_ASTRA_REASONING_MODES;
  }

  if (isOpenAiGpt56Model(model)) {
    return OPENAI_GPT_56_REASONING_MODES;
  }

  if (isOpenAiGpt55ProModel(model)) {
    return OPENAI_GPT_PRO_REASONING_MODES;
  }

  if (isOpenAiGpt55Model(model)) {
    return OPENAI_GPT_55_REASONING_MODES;
  }

  if (isOpenAiGpt54ProModel(model)) {
    return OPENAI_GPT_PRO_REASONING_MODES;
  }

  if (isOpenAiGpt54Model(model)) {
    return OPENAI_GPT_54_REASONING_MODES;
  }

  if (isOpenAiGpt52ProModel(model)) {
    return OPENAI_GPT_PRO_REASONING_MODES;
  }

  if (isOpenAiGpt52Model(model)) {
    return OPENAI_GPT_52_REASONING_MODES;
  }

  if (isOpenAiGpt51Model(model)) {
    return OPENAI_GPT_51_REASONING_MODES;
  }

  if (isOpenAiGpt5ProModel(model)) {
    return OPENAI_GPT_5_PRO_REASONING_MODES;
  }

  if (isOpenAiGpt5Model(model)) {
    return OPENAI_GPT_5_REASONING_MODES;
  }

  return DEFAULT_ONLY_REASONING_MODES;
};

const getAnthropicReasoningModes = (
  model: string,
): readonly ReasoningMode[] => {
  if (isAnthropicXhighEffortModel(model)) {
    return ANTHROPIC_XHIGH_REASONING_MODES;
  }

  if (isAnthropicMaxEffortModel(model)) {
    return ANTHROPIC_MAX_REASONING_MODES;
  }

  if (isAnthropicStandardEffortModel(model)) {
    return ANTHROPIC_DEFAULT_REASONING_MODES;
  }

  return DEFAULT_ONLY_REASONING_MODES;
};

const getGoogleReasoningModes = (model: string): readonly ReasoningMode[] => {
  if (isGemini25ProModel(model)) {
    return GEMINI_25_PRO_REASONING_MODES;
  }

  if (isGemini25Model(model)) {
    return GEMINI_25_REASONING_MODES;
  }

  if (/^gemini-3-pro-preview$/u.test(model)) {
    return GEMINI_3_PRO_PREVIEW_REASONING_MODES;
  }

  if (/^gemini-3\.1-flash-lite-image(?:-|$)/u.test(model)) {
    return GEMINI_31_FLASH_LITE_IMAGE_REASONING_MODES;
  }

  if (isGemini3ProModel(model)) {
    return GEMINI_3_PRO_REASONING_MODES;
  }

  if (isGemini37FlashModel(model)) {
    return GEMINI_3_PRO_REASONING_MODES;
  }

  if (
    /^gemini-(?:3(?:\.0)?-flash-preview|3\.[56]-flash(?:-|$)|3\.[15]-flash-lite(?:-|$))/u.test(
      model,
    )
  ) {
    return GEMINI_3_REASONING_MODES;
  }

  return DEFAULT_ONLY_REASONING_MODES;
};

const getLangdockReasoningModes = (model: string): readonly ReasoningMode[] => {
  if (model.startsWith("claude-")) {
    return getAnthropicReasoningModes(model);
  }

  if (model.startsWith("gemini-")) {
    return getGoogleReasoningModes(model);
  }

  return getOpenAiReasoningModes(model).filter(
    (mode) => mode !== "max" && mode !== "ultra",
  );
};

export const getReasoningModesForProviderModel = (
  provider: ConfiguredModelProvider | null | undefined,
  model?: string | null,
  discoveredModes?: readonly string[] | null,
): readonly ReasoningMode[] => {
  const normalizedModel = normalizeModelId(model);
  if (provider === "copilot-cli" && normalizedModel === "auto") {
    return DEFAULT_ONLY_REASONING_MODES;
  }
  const effectiveDiscoveredModes =
    discoveredModes ??
    (provider && model
      ? getDiscoveredReasoningModes(provider, model)
      : undefined);

  if (
    effectiveDiscoveredModes !== undefined &&
    effectiveDiscoveredModes !== null
  ) {
    const transportModes = provider
      ? TRANSPORT_REASONING_MODES[provider]
      : ALL_REASONING_MODES;
    const modes = effectiveDiscoveredModes
      .map((mode) => {
        const normalizedMode = mode.trim().toLowerCase();

        return provider === "codex-cli" && normalizedMode === "persistent"
          ? "aeon"
          : normalizedMode;
      })
      .filter(isReasoningMode)
      .filter((mode) => transportModes.includes(mode))
      .filter((mode, index, entries) => entries.indexOf(mode) === index);

    if (
      ((provider === "openai" &&
        (isOpenAiGpt56Model(normalizedModel) ||
          isOpenAiGpt6AstraModel(normalizedModel))) ||
        (provider === "codex-cli" &&
          (isOpenAiGpt56SolModel(normalizedModel) ||
            isOpenAiGpt6AstraModel(normalizedModel)))) &&
      !modes.includes("ultra")
    ) {
      modes.push("ultra");
    }

    if (
      provider === "codex-cli" &&
      isOpenAiGpt6AstraModel(normalizedModel) &&
      !modes.includes("aeon")
    ) {
      modes.push("aeon");
    }

    return modes.includes("default") ? modes : ["default", ...modes];
  }

  if (!provider) {
    return ALL_REASONING_MODES;
  }

  switch (provider) {
    case "openai":
      return getOpenAiReasoningModes(normalizedModel);
    case "anthropic":
    case "claude-cli":
      return getAnthropicReasoningModes(normalizedModel);
    case "google":
      return getGoogleReasoningModes(normalizedModel);
    case "langdock":
      return getLangdockReasoningModes(normalizedModel);
    case "codex-cli":
      if (isOpenAiGpt6AstraModel(normalizedModel)) {
        return CODEX_CLI_GPT_6_ASTRA_REASONING_MODES;
      }

      if (isOpenAiGpt56SolModel(normalizedModel)) {
        return CODEX_CLI_GPT_56_SOL_REASONING_MODES;
      }

      if (isOpenAiGpt56Model(normalizedModel)) {
        return CODEX_CLI_GPT_56_REASONING_MODES;
      }

      {
        const modes = getOpenAiReasoningModes(normalizedModel);
        return modes === DEFAULT_ONLY_REASONING_MODES
          ? CODEX_CLI_REASONING_MODES
          : modes;
      }
    case "copilot-cli":
      return COPILOT_CLI_REASONING_MODES;
  }
};

export const normalizeReasoningModeForProviderModel = (
  reasoning: ReasoningMode,
  provider: ConfiguredModelProvider | null | undefined,
  model?: string | null,
  discoveredModes?: readonly string[] | null,
): ReasoningMode => {
  const supportedModes = getReasoningModesForProviderModel(
    provider,
    model,
    discoveredModes,
  );

  return supportedModes.includes(reasoning) ? reasoning : "default";
};

export const isReasoningModeSupportedForProviderModel = (
  reasoning: ReasoningMode,
  provider: ConfiguredModelProvider | null | undefined,
  model?: string | null,
): boolean =>
  getReasoningModesForProviderModel(provider, model).includes(reasoning);

export const assertReasoningModeSupportedForProviderModel = (
  reasoning: ReasoningMode,
  provider: ConfiguredModelProvider,
  model?: string | null,
): void => {
  const supportedModes = getReasoningModesForProviderModel(provider, model);

  if (supportedModes.includes(reasoning)) {
    return;
  }

  const modelName = normalizeModelId(model) || "the selected model";
  throw new Error(
    `Reasoning mode \`${reasoning}\` is not supported by \`${modelName}\` on \`${provider}\`. Supported modes: ${supportedModes.join(", ")}.`,
  );
};
