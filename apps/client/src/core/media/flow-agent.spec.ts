import { describe, expect, it, vi } from "vitest";
import { createImageRecipeFlow } from "@machdoch/media-studio/core/media/compiler.js";
import type { MediaFlowAgentRequest } from "@machdoch/media-studio/core/media/flow-agent.js";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import { runMediaFlowAgent } from "./flow-agent.js";

const config: RuntimeConfig = {
  workspaceRoot: "C:/workspace",
  mode: "machdoch",
  provider: "openai",
  model: "primary",
  reasoning: "default",
  contextWindow: "default",
  offline: false,
  compatibility: { discoverGithubCustomizations: false },
  providerAvailability: [{ provider: "openai", configured: true }],
  webSearch: { activeProvider: "none", providerAvailability: [] },
  reviewModel: { mode: "base" },
  internalTaskModel: {
    provider: "openai",
    model: "internal",
    reasoning: "default",
  },
};
const flow = createImageRecipeFlow({
  id: "flow:agent",
  createdAt: "2026-09-20T00:00:00Z",
  settings: {
    prompt: "A forest",
    providerPolicy: "auto",
    modelPolicy: "quality",
    modelId: null,
    aspectRatio: "1:1",
    outputCount: 1,
    outputFormat: "png",
    transparentBackground: false,
    qualityGateEnabled: false,
    referenceImages: [],
    baseImageAssetId: null,
    poseImageAssetId: null,
    poseStrength: 1,
    modelAddons: [],
  },
});
const request: MediaFlowAgentRequest = {
  prompt: "Make a forest flow",
  flow,
  messages: [],
  models: [],
  addons: [],
  assets: [],
};

describe("Media Studio flow agent", () => {
  it("uses the internal model without tools and returns a validated editable flow", async () => {
    const startTurn = vi
      .fn()
      .mockResolvedValue({
        text: JSON.stringify({
          message: "Updated the flow.",
          graphJson: JSON.stringify(flow),
        }),
        toolCalls: [],
      });
    const result = await runMediaFlowAgent(config, request, {
      startTurn,
      continueTurn: vi.fn(),
    });
    expect(result.flow?.id).toBe(flow.id);
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "internal",
        tools: [],
        structuredOutput: expect.any(Object),
      }),
    );
    expect(startTurn.mock.calls[0]![0].systemPrompt).toContain("source.prompt");
  });

  it("repairs an invalid graph using validation feedback", async () => {
    const startTurn = vi
      .fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({ message: "Updated.", graphJson: "{}" }),
        toolCalls: [],
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          message: "Updated.",
          graphJson: JSON.stringify(flow),
        }),
        toolCalls: [],
      });
    const result = await runMediaFlowAgent(config, request, {
      startTurn,
      continueTurn: vi.fn(),
    });
    expect(result.flow?.nodes).toEqual(flow.nodes);
    expect(startTurn).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(startTurn.mock.calls[1]![0].userPrompt).validationFeedback,
    ).toContain("invalid flow document");
  });

  it("answers questions without editing the flow", async () => {
    const startTurn = vi
      .fn()
      .mockResolvedValue({
        text: JSON.stringify({
          message: "Which source image should I use?",
          graphJson: null,
        }),
        toolCalls: [],
      });
    expect(
      (
        await runMediaFlowAgent(config, request, {
          startTurn,
          continueTurn: vi.fn(),
        })
      ).flow,
    ).toBeNull();
  });

  it("bounds repair attempts and leaves the source untouched", async () => {
    const original = JSON.stringify(flow);
    const startTurn = vi
      .fn()
      .mockResolvedValue({ text: "not json", toolCalls: [] });
    await expect(
      runMediaFlowAgent(config, request, { startTurn, continueTurn: vi.fn() }),
    ).rejects.toThrow("could not produce a valid flow");
    expect(startTurn).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(flow)).toBe(original);
  });

  it("reports missing provider configuration before inference", async () => {
    const startTurn = vi.fn();
    await expect(
      runMediaFlowAgent(
        {
          ...config,
          internalTaskModel: {
            ...config.internalTaskModel,
            provider: "unconfigured",
          },
        },
        request,
        { startTurn, continueTurn: vi.fn() },
      ),
    ).rejects.toThrow("Settings > Providers");
    expect(startTurn).not.toHaveBeenCalled();
  });
});
