import type { RalphFlow } from "../../../../core/ralph.js";
import { hasLocalFlowCycle } from "./has-local-flow-cycle.helper";

const createFlow = (overrides: Partial<RalphFlow> = {}): RalphFlow => ({
  schemaVersion: 1,
  id: "cycle-flow",
  name: "Cycle Flow",
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

describe("hasLocalFlowCycle", () => {
  it("returns false for an acyclic flow", () => {
    expect(hasLocalFlowCycle(createFlow())).toBe(false);
  });

  it("detects a cycle reachable from START", () => {
    expect(
      hasLocalFlowCycle(
        createFlow({
          edges: [
            { id: "start-prompt", from: "start", fromOutput: "SUCCESS", to: "prompt" },
            { id: "prompt-start", from: "prompt", fromOutput: "SUCCESS", to: "start" },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("detects a disconnected local cycle", () => {
    expect(
      hasLocalFlowCycle(
        createFlow({
          blocks: [
            { id: "start", type: "START", title: "Start" },
            { id: "end", type: "END", title: "End" },
            { id: "a", type: "PROMPT", title: "A", prompt: "A" },
            { id: "b", type: "PROMPT", title: "B", prompt: "B" },
          ],
          edges: [
            { id: "start-end", from: "start", fromOutput: "SUCCESS", to: "end" },
            { id: "a-b", from: "a", fromOutput: "SUCCESS", to: "b" },
            { id: "b-a", from: "b", fromOutput: "SUCCESS", to: "a" },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("returns false for empty block and edge lists", () => {
    expect(hasLocalFlowCycle(createFlow({ blocks: [], edges: [] }))).toBe(false);
  });
});
