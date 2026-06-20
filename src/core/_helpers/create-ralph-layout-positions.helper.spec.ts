import type { RalphFlowBlock, RalphFlowEdge } from "../ralph.ts";
import {
  createRalphLayoutIncomingOrder,
  createRalphLayoutPositions,
  createRalphLayoutRanks,
} from "./create-ralph-layout-positions.helper.ts";

const block = (id: string, type: RalphFlowBlock["type"] = "PROMPT"): RalphFlowBlock => {
  if (type === "START") {
    return { id, type, title: id };
  }

  return { id, type: "PROMPT", title: id, prompt: id };
};

const edge = (
  from: string,
  to: string,
  fromOutput: RalphFlowEdge["fromOutput"] = "SUCCESS",
): RalphFlowEdge => ({
  id: `${from}-${to}-${fromOutput}`,
  from,
  fromOutput,
  to,
});

describe("createRalphLayoutRanks", () => {
  it("ranks reachable nodes from START and places disconnected nodes after them", () => {
    const ranks = createRalphLayoutRanks(
      [block("start", "START"), block("next"), block("disconnected")],
      [edge("start", "next")],
    );

    expect(ranks.get("start")).toBe(0);
    expect(ranks.get("next")).toBe(1);
    expect(ranks.get("disconnected")).toBe(2);
  });

  it("ignores edges whose endpoints are outside the layout set", () => {
    const ranks = createRalphLayoutRanks([block("start", "START")], [
      edge("missing", "start"),
      edge("start", "missing"),
    ]);

    expect(ranks.get("start")).toBe(0);
  });
});

describe("createRalphLayoutIncomingOrder", () => {
  it("orders lower-risk success branches before retry and error branches", () => {
    const incomingOrder = createRalphLayoutIncomingOrder(
      [block("source"), block("success"), block("retry"), block("error")],
      [
        edge("source", "error", "ERROR"),
        edge("source", "retry", "RETRY"),
        edge("source", "success", "SUCCESS"),
      ],
    );

    expect(incomingOrder.get("success")).toBeLessThan(
      incomingOrder.get("retry") ?? Number.POSITIVE_INFINITY,
    );
    expect(incomingOrder.get("retry")).toBeLessThan(
      incomingOrder.get("error") ?? Number.POSITIVE_INFINITY,
    );
  });
});

describe("createRalphLayoutPositions", () => {
  it("lays out same-rank blocks with stable vertical spacing", () => {
    const positions = createRalphLayoutPositions(
      [block("start", "START"), block("success"), block("failure")],
      [edge("start", "success", "SUCCESS"), edge("start", "failure", "ERROR")],
    );

    expect(positions.get("start")).toEqual({ x: 0, y: 0 });
    expect(positions.get("success")).toEqual({ x: 340, y: -95 });
    expect(positions.get("failure")).toEqual({ x: 340, y: 95 });
  });
});
