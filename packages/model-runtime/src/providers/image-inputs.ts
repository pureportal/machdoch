import type { AgentModelImageInput } from "../types.ts";

export const hasImageInputs = (
  imageInputs: AgentModelImageInput[] | undefined,
): imageInputs is AgentModelImageInput[] => {
  return Array.isArray(imageInputs) && imageInputs.length > 0;
};
