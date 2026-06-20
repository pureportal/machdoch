import { extname } from "node:path";
import { FLOW_FILE_EXTENSION } from "./ralph-flow-ids.helper.js";

export const createGenerationAttemptFlowPath = (
  generationFlowPath: string,
  round: number,
): string => {
  const extension = extname(generationFlowPath) || FLOW_FILE_EXTENSION;
  const basePath = generationFlowPath.endsWith(extension)
    ? generationFlowPath.slice(0, -extension.length)
    : generationFlowPath;

  return `${basePath}-round-${round}${extension}`;
};
