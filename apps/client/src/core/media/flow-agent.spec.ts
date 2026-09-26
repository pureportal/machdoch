import { describe, expect, it, vi } from "vitest";
import { createImageRecipeFlow } from "@machdoch/media-studio/core/media/compiler.js";
import { validateMediaAgentPoseMaps, type MediaFlowAgentRequest } from "@machdoch/media-studio/core/media/flow-agent.js";
import { createDefaultMediaNodeConfig } from "@machdoch/media-studio/core/media/node-registry.js";
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
          poseMaps: [],
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
        text: JSON.stringify({ message: "Updated.", graphJson: "{}", poseMaps: [] }),
        toolCalls: [],
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          message: "Updated.",
          graphJson: JSON.stringify(flow),
          poseMaps: [],
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
          poseMaps: [],
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

  it("accepts a structured two-person pose for a connected pose source", async () => {
    const generation = flow.nodes.find((node) => node.type === "task.generate-image")!;
    const candidate = {
      ...flow,
      nodes: [
        ...flow.nodes,
        {
          id: "pose-source",
          type: "source.image",
          label: "Two people",
          config: {
            ...createDefaultMediaNodeConfig("source.image"),
            assetId: "pose-map:duo",
            referenceRole: "pose",
          },
        },
      ],
      edges: [
        ...flow.edges,
        {
          id: "pose-edge",
          fromNodeId: "pose-source",
          fromPortId: "image",
          toNodeId: generation.id,
          toPortId: "image",
        },
      ],
    };
    const poseMaps = [{
      id: "duo",
      map: {
        aspectRatio: "1:1",
        people: [
          { pose: "standing", x: 0.28, y: 0.92, scale: 0.75, mirror: false },
          { pose: "sitting", x: 0.7, y: 0.92, scale: 0.73, mirror: true },
        ],
      },
    }];
    const startTurn = vi.fn().mockResolvedValue({
      text: JSON.stringify({ message: "Added two poses.", graphJson: JSON.stringify(candidate), poseMaps }),
      toolCalls: [],
    });
    const result = await runMediaFlowAgent(config, request, { startTurn, continueTurn: vi.fn() });
    expect(result.flow?.nodes.find((node) => node.id === "pose-source")?.config.assetId).toBe("pose-map:duo");
    expect(result.poseMaps[0]?.map.people.map((person) => person.pose)).toEqual(["standing", "sitting"]);
  });

  it("rejects generated poses that cannot condition an image task", () => {
    const generation = flow.nodes.find((node) => node.type === "task.generate-image")!;
    const source = {
      id: "pose-source",
      type: "source.image" as const,
      label: "Pose",
      version: 1 as const,
      layer: "source" as const,
      config: {
        ...createDefaultMediaNodeConfig("source.image"),
        assetId: "pose-map:person",
        referenceRole: "pose",
      },
    };
    const map = {
      aspectRatio: "1:1" as const,
      people: [{ pose: "standing" as const, x: 0.5, y: 0.92, scale: 0.8, mirror: false }],
    };
    const candidate = { ...flow, nodes: [...flow.nodes, source] };
    const maps = [{ id: "person", map }];
    expect(() => validateMediaAgentPoseMaps(maps, candidate)).toThrow(/connected pose source/);
    expect(() => validateMediaAgentPoseMaps(maps, {
      ...candidate,
      nodes: [...flow.nodes, { ...source, config: { ...source.config, referenceRole: "style" } }],
      edges: [...flow.edges, {
        id: "pose-edge", fromNodeId: source.id, fromPortId: "image",
        toNodeId: generation.id, toPortId: "image",
      }],
    })).toThrow(/connected pose source/);
    expect(() => validateMediaAgentPoseMaps(maps, {
      ...candidate,
      nodes: [...flow.nodes.map((node) => node.id === generation.id
        ? { ...node, config: { ...node.config, aspectRatio: "16:9" } }
        : node), source],
      edges: [...flow.edges, {
        id: "pose-edge", fromNodeId: source.id, fromPortId: "image",
        toNodeId: generation.id, toPortId: "image",
      }],
    })).toThrow(/aspect ratio/);
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
