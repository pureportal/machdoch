import type { AgentModelImageInput } from "../../types.js";

export const hasImageInputs = (
  imageInputs: AgentModelImageInput[] | undefined,
): imageInputs is AgentModelImageInput[] => {
  return Array.isArray(imageInputs) && imageInputs.length > 0;
};
