import type {
  RalphFlow,
  RalphFlowBlock,
} from "../../../../core/ralph.js";
import {
  createBlock,
  createBlockId,
  createEdgeId,
} from "./ralph-block-factory.helper";

const createFlow = (blocks: RalphFlowBlock[] = []): RalphFlow => ({
  schemaVersion: 1,
  id: "factory-flow",
  name: "Factory Flow",
  blocks,
  edges: [],
});

describe("ralph-block-factory helper", () => {
  it("creates the first available block id for a block type", () => {
    expect(
      createBlockId(
        createFlow([
          { id: "prompt-1", type: "PROMPT", title: "Prompt", prompt: "" },
          { id: "prompt-2", type: "PROMPT", title: "Prompt", prompt: "" },
        ]),
        "PROMPT",
      ),
    ).toBe("prompt-3");
  });

  it("creates edge ids with sanitized outputs and collision suffixes", () => {
    const flow: RalphFlow = {
      ...createFlow(),
      edges: [
        {
          id: "source-needs-review-target",
          from: "source",
          fromOutput: "NEEDS REVIEW",
          to: "target",
        },
      ],
    };

    expect(createEdgeId(flow, "source", "NEEDS REVIEW", "target")).toBe(
      "source-needs-review-target-2",
    );
  });

  it("creates utility blocks with the wait default config", () => {
    const block = createBlock(createFlow(), "UTILITY");

    expect(block).toMatchObject({
      id: "utility-1",
      type: "UTILITY",
      title: "Wait",
      utility: { type: "WAIT", mode: "delay", delaySeconds: 1 },
    });
  });

  it("creates a safe pinned media-flow bridge that waits by default", () => {
    expect(createBlock(createFlow(), "MEDIA_FLOW")).toMatchObject({
      id: "media-flow-1",
      type: "MEDIA_FLOW",
      title: "Run Media Flow",
      flowId: "",
      revisionId: "",
      inputBindings: {},
      outputBindings: {},
      runPolicy: "wait",
      approvalPolicy: "inherit-workspace",
      settings: { retry: { mode: "finite", maxRetries: 0 } },
    });
  });

});
