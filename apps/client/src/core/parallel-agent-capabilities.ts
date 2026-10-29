import { getDiscoveredModelCapabilities } from "@machdoch/model-runtime/model-capabilities";
import { supportsNativeSubagents } from "@machdoch/model-runtime/native-subagents";
import type { ModelProvider } from "./runtime-contract.generated.js";
import type { ParallelAgentMode } from "@machdoch/model-runtime/types";
import type { InstructionDeliveryPlan } from "./instruction-system/types.js";
import { supportsNativeSubagentInstructionDelivery } from "./instruction-system/subagents.js";

const MANAGED_MODES = ["disabled", "read-only", "machdoch"] as const;
const NATIVE_MODES = [...MANAGED_MODES, "native"] as const;

const hasVerifiedNativeSubagentDelivery = (
  provider: ModelProvider,
  model: string,
  instructionPlan: InstructionDeliveryPlan | undefined,
): boolean =>
  instructionPlan
    ? instructionPlan.providerId === provider &&
      instructionPlan.grade !== "unsupported" &&
      supportsNativeSubagentInstructionDelivery(instructionPlan.capability)
    : // Before a run has a plan, only a provider probe that confirmed
      // subagent instruction delivery counts (the Claude CLI catalog does).
      getDiscoveredModelCapabilities(provider, model)?.nativeSubagents === true;

export const getAvailableParallelAgentModes = (
  provider: ModelProvider,
  model: string,
  instructionPlan?: InstructionDeliveryPlan,
): readonly ParallelAgentMode[] =>
  provider === "unconfigured" || !model.trim()
    ? ["disabled"]
    : supportsNativeSubagents(provider, model) &&
        hasVerifiedNativeSubagentDelivery(provider, model, instructionPlan)
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
