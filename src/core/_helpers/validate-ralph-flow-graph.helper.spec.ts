import type { RalphFlow, RalphFlowBlock } from "../ralph.ts";
import { createFlow } from "../__test__/ralph-test-helpers.ts";
import {
  DEFAULT_RALPH_GROUP_MAX_DEPTH,
  findOutgoingRalphEdge,
  getRalphBlockById,
  getRalphGroupDepthIssue,
  getReachableRalphBlockIds,
  hasGraphCycle,
  hasOutgoingRalphEdge,
  hasRalphPathToEnd,
} from "./validate-ralph-flow-graph.helper.ts";

const createEmptyFlow = (overrides: Partial<RalphFlow> = {}): RalphFlow => {
  return createFlow({
    blocks: [],
    edges: [],
    ...overrides,
  });
};

describe("Ralph flow graph lookup helpers", () => {
  it("indexes blocks by id and lets later duplicate ids win", () => {
    const first: RalphFlowBlock = { id: "same", type: "START", title: "Start" };
    const second: RalphFlowBlock = {
      id: "same",
      type: "END",
      title: "End",
      status: "success",
    };

    expect(getRalphBlockById(createEmptyFlow({ blocks: [first, second] }))).toEqual(
      new Map([["same", second]]),
    );
  });

  it("finds outgoing edges by block id and output", () => {
    const flow = createFlow();

    expect(hasOutgoingRalphEdge(flow, "validate", "DONE")).toBe(true);
    expect(hasOutgoingRalphEdge(flow, "validate", "ERROR")).toBe(false);
    expect(findOutgoingRalphEdge(flow, "validate", "DONE")).toEqual({
      id: "validate-done",
      from: "validate",
      fromOutput: "DONE",
      to: "success",
    });
    expect(findOutgoingRalphEdge(flow, "missing", "SUCCESS")).toBeUndefined();
  });
});

describe("Ralph flow graph traversal helpers", () => {
  it("returns no reachable blocks for an empty flow", () => {
    expect(getReachableRalphBlockIds(createEmptyFlow())).toEqual(new Set());
  });

  it("walks reachable blocks from START without looping forever on cycles", () => {
    expect(getReachableRalphBlockIds(createFlow())).toEqual(
      new Set(["start", "fix-tsc", "validate", "success"]),
    );
  });

  it("detects terminal paths and disconnected branches", () => {
    expect(hasRalphPathToEnd(createFlow(), "start")).toBe(true);
    expect(hasRalphPathToEnd(createFlow(), "missing")).toBe(false);
    expect(
      hasRalphPathToEnd(
        createEmptyFlow({
          blocks: [
            { id: "start", type: "START", title: "Start" },
            { id: "review", type: "PROMPT", title: "Review", prompt: "Review." },
            { id: "end", type: "END", title: "End" },
          ],
          edges: [
            {
              id: "start-to-review",
              from: "start",
              fromOutput: "SUCCESS",
              to: "review",
            },
          ],
        }),
        "start",
      ),
    ).toBe(false);
  });

  it("detects acyclic graphs, self loops, and multi-block cycles", () => {
    expect(hasGraphCycle(createEmptyFlow())).toBe(false);
    expect(
      hasGraphCycle(
        createEmptyFlow({
          blocks: [
            { id: "start", type: "START", title: "Start" },
            { id: "end", type: "END", title: "End" },
          ],
          edges: [
            { id: "start-to-end", from: "start", fromOutput: "SUCCESS", to: "end" },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      hasGraphCycle(
        createEmptyFlow({
          blocks: [{ id: "start", type: "START", title: "Start" }],
          edges: [
            {
              id: "start-to-start",
              from: "start",
              fromOutput: "SUCCESS",
              to: "start",
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(hasGraphCycle(createFlow())).toBe(true);
  });
});

describe("getRalphGroupDepthIssue", () => {
  it("allows group nesting at the configured boundary", () => {
    const child: RalphFlowBlock = {
      id: "child",
      type: "PROMPT",
      title: "Child",
      prompt: "Run.",
      parentGroupId: "g3",
    };
    const blocks: RalphFlowBlock[] = [
      child,
      { id: "g3", type: "GROUP", title: "Group 3", childBlockIds: [], parentGroupId: "g2" },
      { id: "g2", type: "GROUP", title: "Group 2", childBlockIds: [], parentGroupId: "g1" },
      { id: "g1", type: "GROUP", title: "Group 1", childBlockIds: [] },
    ];

    expect(DEFAULT_RALPH_GROUP_MAX_DEPTH).toBe(3);
    expect(getRalphGroupDepthIssue(child, new Map(blocks.map((block) => [block.id, block])))).toBeUndefined();
  });

  it("reports nesting beyond the maximum depth", () => {
    const child: RalphFlowBlock = {
      id: "child",
      type: "PROMPT",
      title: "Child",
      prompt: "Run.",
      parentGroupId: "g4",
    };
    const blocks: RalphFlowBlock[] = [
      child,
      { id: "g4", type: "GROUP", title: "Group 4", childBlockIds: [], parentGroupId: "g3" },
      { id: "g3", type: "GROUP", title: "Group 3", childBlockIds: [], parentGroupId: "g2" },
      { id: "g2", type: "GROUP", title: "Group 2", childBlockIds: [], parentGroupId: "g1" },
      { id: "g1", type: "GROUP", title: "Group 1", childBlockIds: [] },
    ];

    expect(getRalphGroupDepthIssue(child, new Map(blocks.map((block) => [block.id, block])))).toBe("too-deep");
  });

  it("reports parent group cycles", () => {
    const child: RalphFlowBlock = {
      id: "child",
      type: "PROMPT",
      title: "Child",
      prompt: "Run.",
      parentGroupId: "g1",
    };
    const blocks: RalphFlowBlock[] = [
      child,
      { id: "g1", type: "GROUP", title: "Group 1", childBlockIds: [], parentGroupId: "g2" },
      { id: "g2", type: "GROUP", title: "Group 2", childBlockIds: [], parentGroupId: "g1" },
    ];

    expect(getRalphGroupDepthIssue(child, new Map(blocks.map((block) => [block.id, block])))).toBe("cycle");
  });
});
