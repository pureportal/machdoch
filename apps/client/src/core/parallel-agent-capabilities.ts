import type { ModelProvider } from "./runtime-contract.generated.js";
import type { ParallelAgentMode } from "./types.js";
import type { InstructionDeliveryPlan } from "./instruction-system/types.js";
import { supportsNativeSubagentInstructionDelivery } from "./instruction-system/subagents.js";

const MANAGED_MODES = ["disabled", "read-only", "machdoch"] as const;
const NATIVE_MODES = [...MANAGED_MODES, "native"] as const;

export const supportsNativeSubagents = (
  provider: ModelProvider,
  model: string,
): boolean => {
  if (!model.trim()) return false;

  switch (provider) {
    case "codex-cli":
    case "claude-cli":
    case "copilot-cli":
      return true;
    case "openai":
      return /^gpt-(?:5\.6(?:-(?:sol|terra|luna))?|6-(?:astra|sol|luna))(?:-\d{4}-\d{2}-\d{2})?$/iu.test(
        model,
      );
    default:
      return false;
  }
};

export const getAvailableParallelAgentModes = (
  provider: ModelProvider,
  model: string,
  instructionPlan?: InstructionDeliveryPlan,
): readonly ParallelAgentMode[] =>
  provider === "unconfigured" || !model.trim()
    ? ["disabled"]
    : supportsNativeSubagents(provider, model) &&
        instructionPlan?.providerId === provider &&
        instructionPlan.grade !== "unsupported" &&
        supportsNativeSubagentInstructionDelivery(instructionPlan.capability)
      ? NATIVE_MODES
      : MANAGED_MODES;

export const resolveParallelAgentMode = (
  provider: ModelProvider,
  model: string,
  mode: ParallelAgentMode | undefined,
  instructionPlan?: InstructionDeliveryPlan,
): ParallelAgentMode =>
  mode &&
  getAvailableParallelAgentModes(provider, model, instructionPlan).includes(
    mode,
  )
    ? mode
    : "disabled";
