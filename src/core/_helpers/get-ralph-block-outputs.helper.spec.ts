import type {
  RalphFlowBlock,
  RalphUtilityConfig,
} from "../ralph.ts";
import {
  getRalphBlockOutputs,
  getRalphUtilityOutputs,
  isExecutableRalphBlock,
  isVisualRalphBlock,
} from "./get-ralph-block-outputs.helper.ts";

describe("getRalphUtilityOutputs", () => {
  it.each([
    [{ type: "WAIT" }, ["SUCCESS"]],
    [{ type: "SET_VARIABLE" }, ["SUCCESS"]],
    [{ type: "NOTIFY" }, ["SUCCESS"]],
    [{ type: "HTTP_FETCH" }, ["SUCCESS", "HTTP_ERROR", "TIMEOUT", "ERROR"]],
    [{ type: "RUN_COMMAND" }, ["SUCCESS", "ERROR"]],
    [{ type: "READ_FILE" }, ["SUCCESS", "ERROR"]],
    [{ type: "WRITE_FILE" }, ["SUCCESS", "ERROR"]],
    [{ type: "GIT_STATUS" }, ["SUCCESS", "ERROR"]],
    [{ type: "TRANSFORM_JSON" }, ["SUCCESS", "ERROR"]],
    [{ type: "SEARCH_FILES" }, ["SUCCESS", "EMPTY", "ERROR"]],
    [{ type: "RUN_CHECK" }, ["SUCCESS", "FAILED", "ERROR"]],
    [{ type: "UI_ANALYZE" }, ["SUCCESS", "UNAVAILABLE", "ERROR"]],
    [{ type: "VALIDATE_JSON" }, ["SUCCESS", "INVALID", "ERROR"]],
  ] as const)("returns outputs for utility %#", (utility, outputs) => {
    expect(getRalphUtilityOutputs(utility)).toEqual(outputs);
  });

  it.each([
    [{ type: "POLL" }, ["SUCCESS", "ERROR"]],
    [{ type: "POLL", maxAttempts: null }, ["SUCCESS", "ERROR"]],
    [{ type: "POLL", maxAttempts: 0 }, ["SUCCESS", "TIMEOUT", "ERROR"]],
    [{ type: "POLL", maxAttempts: 3 }, ["SUCCESS", "TIMEOUT", "ERROR"]],
  ] satisfies Array<[RalphUtilityConfig, string[]]>)(
    "uses TIMEOUT only for bounded poll attempts %#",
    (utility, outputs) => {
      expect(getRalphUtilityOutputs(utility)).toEqual(outputs);
    },
  );
});

describe("getRalphBlockOutputs", () => {
  it.each([
    [{ id: "start", type: "START", title: "Start" }, ["SUCCESS"]],
    [
      { id: "prompt", type: "PROMPT", title: "Prompt", prompt: "Do it." },
      ["SUCCESS", "ERROR"],
    ],
    [
      { id: "pack", type: "PACK", title: "Pack", packIds: [] },
      ["SUCCESS", "ERROR"],
    ],
    [
      {
        id: "tool",
        type: "MCP_TOOL",
        title: "Tool",
        serverId: "server",
        toolName: "tool",
      },
      ["SUCCESS", "ERROR"],
    ],
    [
      {
        id: "resource",
        type: "MCP_RESOURCE",
        title: "Resource",
        serverId: "server",
        uri: "resource://one",
      },
      ["SUCCESS", "ERROR"],
    ],
    [
      {
        id: "mcp-prompt",
        type: "MCP_PROMPT",
        title: "Prompt",
        serverId: "server",
        promptName: "summarize",
      },
      ["SUCCESS", "ERROR"],
    ],
    [
      { id: "validator", type: "VALIDATOR", title: "Validate", prompt: "Check." },
      ["DONE", "CONTINUE", "RETRY", "ERROR"],
    ],
    [
      { id: "note", type: "NOTE", title: "Note", text: "" },
      [],
    ],
    [
      { id: "group", type: "GROUP", title: "Group", childBlockIds: [] },
      [],
    ],
    [
      { id: "end", type: "END", title: "End" },
      [],
    ],
  ] satisfies Array<[RalphFlowBlock, string[]]>)(
    "returns outputs for block %#",
    (block, outputs) => {
      expect(getRalphBlockOutputs(block)).toEqual(outputs);
    },
  );

  it("delegates utility blocks to utility output classification", () => {
    expect(
      getRalphBlockOutputs({
        id: "search",
        type: "UTILITY",
        title: "Search",
        utility: { type: "SEARCH_FILES" },
      }),
    ).toEqual(["SUCCESS", "EMPTY", "ERROR"]);
  });

  it("deduplicates decision labels while appending ERROR", () => {
    expect(
      getRalphBlockOutputs({
        id: "decide",
        type: "DECISION",
        title: "Decide",
        prompt: "Choose.",
        labels: ["APPROVE", "ERROR", "RETRY", "APPROVE"],
      }),
    ).toEqual(["APPROVE", "ERROR", "RETRY"]);
  });
});

describe("Ralph block execution classification", () => {
  it.each([
    [{ id: "note", type: "NOTE", title: "Note", text: "" }, true],
    [{ id: "group", type: "GROUP", title: "Group", childBlockIds: [] }, true],
    [{ id: "start", type: "START", title: "Start" }, false],
    [{ id: "end", type: "END", title: "End" }, false],
  ] satisfies Array<[RalphFlowBlock, boolean]>)(
    "detects visual block %#",
    (block, expected) => {
      expect(isVisualRalphBlock(block)).toBe(expected);
    },
  );

  it.each([
    [{ id: "start", type: "START", title: "Start" }, false],
    [{ id: "end", type: "END", title: "End" }, false],
    [{ id: "note", type: "NOTE", title: "Note", text: "" }, false],
    [{ id: "group", type: "GROUP", title: "Group", childBlockIds: [] }, false],
    [
      { id: "prompt", type: "PROMPT", title: "Prompt", prompt: "Do it." },
      true,
    ],
    [
      {
        id: "utility",
        type: "UTILITY",
        title: "Utility",
        utility: { type: "WAIT" },
      },
      true,
    ],
  ] satisfies Array<[RalphFlowBlock, boolean]>)(
    "detects executable block %#",
    (block, expected) => {
      expect(isExecutableRalphBlock(block)).toBe(expected);
    },
  );
});
