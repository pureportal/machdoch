import type { ReasoningMode } from "../../../../core/runtime-contract.generated.js";
import type { RuntimeProvider } from "../../model-catalog";
import { normalizeReasoningModeForProvider } from "../../reasoning-options";

export const normalizeSessionReasoningOverride = (
  reasoning: ReasoningMode | null | undefined,
  provider: RuntimeProvider | null | undefined,
  model?: string | null,
): ReasoningMode | undefined => {
  if (!reasoning) {
    return undefined;
  }

  const normalizedReasoning = normalizeReasoningModeForProvider(
    reasoning,
    provider,
    model,
  );

  return normalizedReasoning === "default" ? undefined : normalizedReasoning;
};
