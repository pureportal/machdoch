import type { ConfiguredModelProvider } from "./provider-model-registry.js";
import type { ReasoningExecutionMode } from "./runtime-contract.generated.js";
import { normalizeModelId } from "../helpers/normalize-model-id.helper.js";

const STANDARD_REASONING_EXECUTION_MODES = [
  "standard",
] as const satisfies readonly ReasoningExecutionMode[];

const GPT_56_REASONING_EXECUTION_MODES = [
  "standard",
  "pro",
] as const satisfies readonly ReasoningExecutionMode[];

const isGpt56Model = (model: string): boolean =>
  /^gpt-5\.6(?:-(?:sol|terra|luna))?(?:-\d{4}-\d{2}-\d{2})?$/u.test(model);

export const getReasoningExecutionModesForProviderModel = (
  provider: ConfiguredModelProvider | null | undefined,
  model?: string | null,
): readonly ReasoningExecutionMode[] =>
  provider === "openai" && isGpt56Model(normalizeModelId(model))
    ? GPT_56_REASONING_EXECUTION_MODES
    : STANDARD_REASONING_EXECUTION_MODES;

export const assertReasoningExecutionModeSupportedForProviderModel = (
  reasoningMode: ReasoningExecutionMode,
  provider: ConfiguredModelProvider,
  model?: string | null,
): void => {
  const supportedModes = getReasoningExecutionModesForProviderModel(
    provider,
    model,
  );

  if (supportedModes.includes(reasoningMode)) {
    return;
  }

  const modelName = normalizeModelId(model) || "the selected model";
  throw new Error(
    `Reasoning execution mode \`${reasoningMode}\` is not supported by \`${modelName}\` on \`${provider}\`. Supported modes: ${supportedModes.join(", ")}.`,
  );
};
