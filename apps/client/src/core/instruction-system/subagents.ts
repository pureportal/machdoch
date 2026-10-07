import type { InstructionCapabilityDescriptor } from "./types.js";

export const supportsNativeSubagentInstructionDelivery = (
  capability: InstructionCapabilityDescriptor | undefined,
): boolean =>
  capability?.lifecycle.subagents === "reattached" ||
  capability?.lifecycle.subagents === "session";
