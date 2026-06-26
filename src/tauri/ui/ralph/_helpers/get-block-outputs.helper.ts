import type {
  RalphExecutionOutput,
  RalphFlowBlock,
  RalphUtilityConfig,
} from "../../../../core/ralph.js";

export const getUtilityOutputs = (
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
    case "CONDITION":
      return ["MATCH", "NO_MATCH", "ERROR"];
    case "RUN_COMMAND":
    case "READ_FILE":
    case "WRITE_FILE":
    case "GIT_STATUS":
    case "GIT_SNAPSHOT":
    case "FINAL_REPORT":
    case "TRANSFORM_JSON":
      return ["SUCCESS", "ERROR"];
    case "READ_JSON":
      return ["SUCCESS", "NOT_FOUND", "INVALID", "ERROR"];
    case "READ_JSONL":
    case "QUERY_JSONL":
      return ["SUCCESS", "EMPTY", "NOT_FOUND", "INVALID", "ERROR"];
    case "WRITE_JSON":
    case "APPEND_JSONL":
      return ["SUCCESS", "INVALID", "ERROR"];
    case "PATCH_JSON":
      return ["SUCCESS", "NOT_FOUND", "INVALID", "ERROR"];
    case "FILE_EXISTS":
      return ["EXISTS", "MISSING", "ERROR"];
    case "DELETE_FILE":
    case "MOVE_FILE":
    case "ARCHIVE_FILE":
      return ["SUCCESS", "NOT_FOUND", "ERROR"];
    case "LOOP_COUNTER":
      return ["CONTINUE", "LIMIT_REACHED", "ERROR"];
    case "PROMPT_JSON":
      return ["SUCCESS", "INVALID", "ERROR"];
    case "VALIDATOR_JSON":
      return ["DONE", "CONTINUE", "RETRY", "ERROR", "INVALID"];
    case "SELECT_JSON_TASK":
      return ["SELECTED", "EMPTY", "NOT_FOUND", "INVALID", "ERROR"];
    case "MARK_JSON_TASK":
      return ["SUCCESS", "NOT_FOUND", "INVALID", "ERROR"];
    case "CHANGE_SCOPE_GUARD":
      return ["IN_SCOPE", "OUT_OF_SCOPE", "EMPTY", "ERROR"];
    case "SCAN_SCOPE_EVIDENCE":
    case "UPDATE_SCOPE_REGISTRY":
      return ["SUCCESS", "EMPTY", "ERROR"];
    case "SELECT_SCOPE":
      return ["SELECTED", "EMPTY", "ERROR"];
    case "MARK_SCOPE_RESULT":
      return ["SUCCESS", "NOT_FOUND", "ERROR"];
    case "SEARCH_FILES":
    case "GIT_DIFF_SUMMARY":
    case "DETECT_PROJECT_COMMANDS":
      return ["SUCCESS", "EMPTY", "ERROR"];
    case "RUN_CHECK":
      return ["SUCCESS", "FAILED", "ERROR"];
    case "UI_ANALYZE":
      return ["SUCCESS", "UNAVAILABLE", "ERROR"];
    case "VALIDATE_JSON":
      return ["SUCCESS", "INVALID", "ERROR"];
  }
};

export const getBlockOutputs = (block: RalphFlowBlock): RalphExecutionOutput[] => {
  switch (block.type) {
    case "START":
      return ["SUCCESS"];
    case "PROMPT":
    case "PACK":
    case "MCP_TOOL":
    case "MCP_RESOURCE":
    case "MCP_PROMPT":
      return ["SUCCESS", "ERROR"];
    case "ASK_USER":
      return ["SUCCESS", "CANCELLED", "TIMEOUT", "ERROR"];
    case "INTERVIEW":
      return ["DONE", "INCOMPLETE", "CANCELLED", "ERROR"];
    case "UTILITY":
      return getUtilityOutputs(block.utility);
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

export const isVisualRalphCanvasBlock = (block: RalphFlowBlock): boolean =>
  block.type === "NOTE" || block.type === "GROUP";

export const isExecutableRalphCanvasBlock = (block: RalphFlowBlock): boolean =>
  block.type !== "START" && block.type !== "END" && !isVisualRalphCanvasBlock(block);
