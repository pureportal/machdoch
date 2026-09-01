import type { RalphFlow, RalphFlowBlock } from "../ralph.ts";
import { createFlow } from "../__test__/ralph-test-helpers.ts";
import {
  createRalphFlowGraphIndex,
  findOutgoingRalphEdge,
  getRalphBlockIdsWithPathToEnd,
  getRalphBlockById,
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

    expect(
      getRalphBlockById(createEmptyFlow({ blocks: [first, second] })),
    ).toEqual(new Map([["same", second]]));
  });

  it("finds outgoing edges by block id and output", () => {
    const flow = createFlow();
    const index = createRalphFlowGraphIndex(flow);

    expect(hasOutgoingRalphEdge(flow, "validate", "DONE", index)).toBe(true);
    expect(hasOutgoingRalphEdge(flow, "validate", "ERROR", index)).toBe(false);
    expect(findOutgoingRalphEdge(flow, "validate", "DONE", index)).toEqual({
      id: "validate-done",
      from: "validate",
      fromOutput: "DONE",
      to: "success",
    });
    expect(findOutgoingRalphEdge(flow, "missing", "SUCCESS")).toBeUndefined();
  });

  it("keeps block and output identity fields separate", () => {
    const first = {
      id: "first",
      from: "block\0SUCCESS",
      fromOutput: "ERROR" as const,
      to: "first-target",
    };
    const second = {
      id: "second",
      from: "block",
      fromOutput: "SUCCESS" as const,
      to: "second-target",
    };
    const flow = createEmptyFlow({ edges: [first, second] });
    const index = createRalphFlowGraphIndex(flow);

    expect(
      findOutgoingRalphEdge(flow, first.from, first.fromOutput, index),
    ).toEqual(first);
    expect(
      findOutgoingRalphEdge(flow, second.from, second.fromOutput, index),
    ).toEqual(second);
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
    const flow = createFlow();

    expect(getRalphBlockIdsWithPathToEnd(flow)).toEqual(
      new Set(["start", "fix-tsc", "validate", "success"]),
    );
    expect(hasRalphPathToEnd(flow, "start")).toBe(true);
    expect(hasRalphPathToEnd(flow, "missing")).toBe(false);
    expect(
      hasRalphPathToEnd(
        createEmptyFlow({
          blocks: [
            { id: "start", type: "START", title: "Start" },
            {
              id: "review",
              type: "PROMPT",
              title: "Review",
              prompt: "Review.",
            },
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
            {
              id: "start-to-end",
              from: "start",
              fromOutput: "SUCCESS",
              to: "end",
            },
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
