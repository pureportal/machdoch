import type { RalphFlow } from "../../../../core/ralph.js";
import { getReachableBlockIds } from "./get-reachable-block-ids.helper";

const createFlow = (overrides: Partial<RalphFlow> = {}): RalphFlow => ({
  schemaVersion: 1,
  id: "graph-flow",
  name: "Graph Flow",
  blocks: [
    { id: "start", type: "START", title: "Start" },
    { id: "prompt", type: "PROMPT", title: "Prompt", prompt: "Run." },
    { id: "end", type: "END", title: "End" },
  ],
  edges: [
    { id: "start-prompt", from: "start", fromOutput: "SUCCESS", to: "prompt" },
    { id: "prompt-end", from: "prompt", fromOutput: "SUCCESS", to: "end" },
  ],
  ...overrides,
});

describe("getReachableBlockIds", () => {
  it("walks reachable blocks from every START block", () => {
    const flow = createFlow({
      blocks: [
        { id: "start-a", type: "START", title: "Start A" },
        { id: "start-b", type: "START", title: "Start B" },
        { id: "prompt-a", type: "PROMPT", title: "Prompt A", prompt: "A" },
        { id: "prompt-b", type: "PROMPT", title: "Prompt B", prompt: "B" },
        { id: "orphan", type: "PROMPT", title: "Orphan", prompt: "Orphan" },
      ],
      edges: [
        { id: "a", from: "start-a", fromOutput: "SUCCESS", to: "prompt-a" },
        { id: "b", from: "start-b", fromOutput: "SUCCESS", to: "prompt-b" },
      ],
    });

    expect([...getReachableBlockIds(flow)].sort()).toEqual([
      "prompt-a",
      "prompt-b",
      "start-a",
      "start-b",
    ]);
  });

  it("handles cycles without revisiting blocks forever", () => {
    const flow = createFlow({
      edges: [
        { id: "start-prompt", from: "start", fromOutput: "SUCCESS", to: "prompt" },
        { id: "prompt-start", from: "prompt", fromOutput: "SUCCESS", to: "start" },
      ],
    });

    expect([...getReachableBlockIds(flow)].sort()).toEqual(["prompt", "start"]);
  });

  it("returns an empty set when the flow has no START block", () => {
    expect(
      getReachableBlockIds(
        createFlow({
          blocks: [{ id: "prompt", type: "PROMPT", title: "Prompt", prompt: "Run." }],
        }),
      ).size,
    ).toBe(0);
  });
});
