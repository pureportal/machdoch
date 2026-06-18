import type {
  RalphExecutionOutput,
  RalphFlowBlock,
  RalphUtilityConfig,
} from "../ralph.js";

export const getRalphUtilityOutputs = (
  utility: RalphUtilityConfig,
): RalphExecutionOutput[] => {
  switch (utility.type) {
    case "WAIT":
    case "SET_VARIABLE":
    case "NOTIFY":
      return ["SUCCESS"];
    case "HTTP_FETCH":
      return ["SUCCESS", "HTTP_ERROR", "TIMEOUT", "ERROR"];
    case "POLL":
      return utility.maxAttempts === null || utility.maxAttempts === undefined
        ? ["SUCCESS", "ERROR"]
        : ["SUCCESS", "TIMEOUT", "ERROR"];
    case "RUN_COMMAND":
    case "READ_FILE":
    case "WRITE_FILE":
    case "GIT_STATUS":
    case "TRANSFORM_JSON":
      return ["SUCCESS", "ERROR"];
    case "SEARCH_FILES":
      return ["SUCCESS", "EMPTY", "ERROR"];
    case "RUN_CHECK":
      return ["SUCCESS", "FAILED", "ERROR"];
    case "UI_ANALYZE":
      return ["SUCCESS", "UNAVAILABLE", "ERROR"];
    case "VALIDATE_JSON":
      return ["SUCCESS", "INVALID", "ERROR"];
  }
};

export const getRalphBlockOutputs = (block: RalphFlowBlock): RalphExecutionOutput[] => {
  switch (block.type) {
    case "START":
      return ["SUCCESS"];
    case "PROMPT":
    case "PACK":
    case "MCP_TOOL":
    case "MCP_RESOURCE":
    case "MCP_PROMPT":
      return ["SUCCESS", "ERROR"];
    case "UTILITY":
      return getRalphUtilityOutputs(block.utility);
    case "VALIDATOR":
      return ["DONE", "CONTINUE", "RETRY", "ERROR"];
    case "DECISION":
      return [...new Set([...block.labels, "ERROR"])];
    case "NOTE":
    case "GROUP":
    case "END":
      return [];
  }
};

export const isVisualRalphBlock = (block: RalphFlowBlock): boolean => {
  return block.type === "NOTE" || block.type === "GROUP";
};

export const isExecutableRalphBlock = (block: RalphFlowBlock): boolean => {
  return block.type !== "START" && block.type !== "END" && !isVisualRalphBlock(block);
};

