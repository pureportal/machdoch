import type {
  RalphFlow,
  RalphFlowBlock,
} from "../../../../core/ralph.js";
import {
  createBlock,
  createBlockId,
  createCopiedBlock,
  createDefaultUtilityConfig,
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

  it("prevents copying a second start block", () => {
    const startBlock: RalphFlowBlock = {
      id: "start",
      type: "START",
      title: "Start",
      position: { x: 80, y: 120 },
    };

    expect(createCopiedBlock(createFlow([startBlock]), startBlock)).toBeNull();
  });

  it("copies non-start blocks with a new id, title, and displaced position", () => {
    const promptBlock: RalphFlowBlock = {
      id: "prompt-1",
      type: "PROMPT",
      title: "Collect data",
      prompt: "Collect it.",
      position: { x: 80, y: 120 },
    };
    const copy = createCopiedBlock(createFlow([promptBlock]), promptBlock);

    expect(copy).toMatchObject({
      id: "prompt-2",
      title: "Collect data Copy",
      position: { x: 116, y: 156 },
    });
    expect(copy).not.toBe(promptBlock);
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

  it("creates default UI analysis config for existing preview servers", () => {
    expect(createDefaultUtilityConfig("UI_ANALYZE")).toMatchObject({
      type: "UI_ANALYZE",
      adapter: "browser",
      server: {
        mode: "existing",
        reuseExisting: true,
      },
      checks: {
        accessibility: true,
        console: true,
        network: true,
        responsive: true,
        screenshots: true,
      },
    });
  });
});
