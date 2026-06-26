import { getRalphUtilityOutputs } from "../ralph.js";
describe("getRalphUtilityOutputs", () => {
  it.each([
    {
      name: "WAIT",
      utility: { type: "WAIT" },
      outputs: ["SUCCESS"],
    },
    {
      name: "HTTP_FETCH",
      utility: { type: "HTTP_FETCH" },
      outputs: ["SUCCESS", "HTTP_ERROR", "TIMEOUT", "ERROR"],
    },
    {
      name: "POLL with finite attempts",
      utility: { type: "POLL", maxAttempts: 3 },
      outputs: ["SUCCESS", "TIMEOUT", "ERROR"],
    },
    {
      name: "POLL without finite attempts",
      utility: { type: "POLL" },
      outputs: ["SUCCESS", "ERROR"],
    },
    {
      name: "CONDITION",
      utility: { type: "CONDITION" },
      outputs: ["MATCH", "NO_MATCH", "ERROR"],
    },
    {
      name: "RUN_COMMAND",
      utility: { type: "RUN_COMMAND" },
      outputs: ["SUCCESS", "ERROR"],
    },
    {
      name: "READ_FILE",
      utility: { type: "READ_FILE" },
      outputs: ["SUCCESS", "ERROR"],
    },
    {
      name: "WRITE_FILE",
      utility: { type: "WRITE_FILE" },
      outputs: ["SUCCESS", "ERROR"],
    },
    {
      name: "READ_JSON",
      utility: { type: "READ_JSON" },
      outputs: ["SUCCESS", "NOT_FOUND", "INVALID", "ERROR"],
    },
    {
      name: "WRITE_JSON",
      utility: { type: "WRITE_JSON" },
      outputs: ["SUCCESS", "INVALID", "ERROR"],
    },
    {
      name: "PATCH_JSON",
      utility: { type: "PATCH_JSON" },
      outputs: ["SUCCESS", "NOT_FOUND", "INVALID", "ERROR"],
    },
    {
      name: "APPEND_JSONL",
      utility: { type: "APPEND_JSONL" },
      outputs: ["SUCCESS", "INVALID", "ERROR"],
    },
    {
      name: "READ_JSONL",
      utility: { type: "READ_JSONL" },
      outputs: ["SUCCESS", "EMPTY", "NOT_FOUND", "INVALID", "ERROR"],
    },
    {
      name: "QUERY_JSONL",
      utility: { type: "QUERY_JSONL" },
      outputs: ["SUCCESS", "EMPTY", "NOT_FOUND", "INVALID", "ERROR"],
    },
    {
      name: "FILE_EXISTS",
      utility: { type: "FILE_EXISTS" },
      outputs: ["EXISTS", "MISSING", "ERROR"],
    },
    {
      name: "DELETE_FILE",
      utility: { type: "DELETE_FILE" },
      outputs: ["SUCCESS", "NOT_FOUND", "ERROR"],
    },
    {
      name: "MOVE_FILE",
      utility: { type: "MOVE_FILE" },
      outputs: ["SUCCESS", "NOT_FOUND", "ERROR"],
    },
    {
      name: "ARCHIVE_FILE",
      utility: { type: "ARCHIVE_FILE" },
      outputs: ["SUCCESS", "NOT_FOUND", "ERROR"],
    },
    {
      name: "LOOP_COUNTER",
      utility: { type: "LOOP_COUNTER" },
      outputs: ["CONTINUE", "LIMIT_REACHED", "ERROR"],
    },
    {
      name: "PROMPT_JSON",
      utility: { type: "PROMPT_JSON" },
      outputs: ["SUCCESS", "INVALID", "ERROR"],
    },
    {
      name: "VALIDATOR_JSON",
      utility: { type: "VALIDATOR_JSON" },
      outputs: ["DONE", "CONTINUE", "RETRY", "ERROR", "INVALID"],
    },
    {
      name: "SELECT_JSON_TASK",
      utility: { type: "SELECT_JSON_TASK" },
      outputs: ["SELECTED", "EMPTY", "NOT_FOUND", "INVALID", "ERROR"],
    },
    {
      name: "MARK_JSON_TASK",
      utility: { type: "MARK_JSON_TASK" },
      outputs: ["SUCCESS", "NOT_FOUND", "INVALID", "ERROR"],
    },
    {
      name: "CHANGE_SCOPE_GUARD",
      utility: { type: "CHANGE_SCOPE_GUARD" },
      outputs: ["IN_SCOPE", "OUT_OF_SCOPE", "EMPTY", "ERROR"],
    },
    {
      name: "SCAN_SCOPE_EVIDENCE",
      utility: { type: "SCAN_SCOPE_EVIDENCE" },
      outputs: ["SUCCESS", "EMPTY", "ERROR"],
    },
    {
      name: "UPDATE_SCOPE_REGISTRY",
      utility: { type: "UPDATE_SCOPE_REGISTRY" },
      outputs: ["SUCCESS", "EMPTY", "ERROR"],
    },
    {
      name: "SELECT_SCOPE",
      utility: { type: "SELECT_SCOPE" },
      outputs: ["SELECTED", "EMPTY", "ERROR"],
    },
    {
      name: "MARK_SCOPE_RESULT",
      utility: { type: "MARK_SCOPE_RESULT" },
      outputs: ["SUCCESS", "NOT_FOUND", "ERROR"],
    },
    {
      name: "SEARCH_FILES",
      utility: { type: "SEARCH_FILES" },
      outputs: ["SUCCESS", "EMPTY", "ERROR"],
    },
    {
      name: "RUN_CHECK",
      utility: { type: "RUN_CHECK" },
      outputs: ["SUCCESS", "FAILED", "ERROR"],
    },
    {
      name: "UI_ANALYZE",
      utility: { type: "UI_ANALYZE" },
      outputs: ["SUCCESS", "UNAVAILABLE", "ERROR"],
    },
    {
      name: "GIT_STATUS",
      utility: { type: "GIT_STATUS" },
      outputs: ["SUCCESS", "ERROR"],
    },
    {
      name: "GIT_SNAPSHOT",
      utility: { type: "GIT_SNAPSHOT" },
      outputs: ["SUCCESS", "ERROR"],
    },
    {
      name: "GIT_DIFF_SUMMARY",
      utility: { type: "GIT_DIFF_SUMMARY" },
      outputs: ["SUCCESS", "EMPTY", "ERROR"],
    },
    {
      name: "DETECT_PROJECT_COMMANDS",
      utility: { type: "DETECT_PROJECT_COMMANDS" },
      outputs: ["SUCCESS", "EMPTY", "ERROR"],
    },
    {
      name: "SET_VARIABLE",
      utility: { type: "SET_VARIABLE" },
      outputs: ["SUCCESS"],
    },
    {
      name: "TRANSFORM_JSON",
      utility: { type: "TRANSFORM_JSON" },
      outputs: ["SUCCESS", "ERROR"],
    },
    {
      name: "VALIDATE_JSON",
      utility: { type: "VALIDATE_JSON" },
      outputs: ["SUCCESS", "INVALID", "ERROR"],
    },
    {
      name: "FINAL_REPORT",
      utility: { type: "FINAL_REPORT" },
      outputs: ["SUCCESS", "ERROR"],
    },
    {
      name: "NOTIFY",
      utility: { type: "NOTIFY" },
      outputs: ["SUCCESS"],
    },
  ] satisfies Array<{
    name: string;
    utility: Parameters<typeof getRalphUtilityOutputs>[0];
    outputs: ReturnType<typeof getRalphUtilityOutputs>;
  }>)("returns $name outputs", ({ utility, outputs }) => {
    expect(getRalphUtilityOutputs(utility)).toEqual(outputs);
  });
});


