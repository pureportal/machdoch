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


