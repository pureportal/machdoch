import { describe, expect, it } from "vitest";
import {
  createImageRecipeFlow,
  createImageToVideoFlow,
  readImageRecipeSettings,
} from "./compiler.js";
import { resolveMediaNodePrompt } from "./prompt-resolution.js";
import type { MediaFlow } from "./contracts.js";

const imageFlow = () =>
  createImageRecipeFlow({
    id: "prompt-resolution",
    createdAt: "2026-09-15T00:00:00.000Z",
    settings: {
      prompt: "unused",
      providerPolicy: "local",
      modelPolicy: "balanced",
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

const connectSecondPrompt = (
  flow: MediaFlow,
  taskType: "task.generate-image" | "task.generate-video",
) => {
  const task = flow.nodes.find((node) => node.type === taskType)!;
  const source = flow.nodes.find((node) => node.type === "source.prompt")!;
  flow.nodes.push({
    ...source,
    id: "connected",
    config: { prompt: "a {{subject}}, pixel" },
  });
  flow.edges = flow.edges.map((edge) =>
    edge.toNodeId === task.id && edge.toPortId === "prompt"
      ? { ...edge, fromNodeId: "connected" }
      : edge,
  );
  flow.variables = [
    {
      id: "subject",
      name: "Subject",
      type: "text",
      required: true,
      defaultValue: "castle",
      description: "",
      constraints: { maxLength: 100 },
    },
  ];
  flow.variableBindings = { subject: "teapot" };
  return task;
};

describe("media node prompt resolution", () => {
  it("uses the connected image prompt after variable resolution and node reordering", () => {
    const flow = imageFlow();
    const task = connectSecondPrompt(flow, "task.generate-image");
    expect(resolveMediaNodePrompt(flow, task.id).prompt).toBe(
      "a teapot, pixel",
    );
    expect(readImageRecipeSettings(flow)?.prompt).toBe("a teapot, pixel");
    flow.nodes.reverse();
    expect(readImageRecipeSettings(flow)?.prompt).toBe("a teapot, pixel");
    expect(
      flow.nodes.find((node) => node.id === "connected")?.config.prompt,
    ).toBe("a {{subject}}, pixel");
  });

  it("uses the connected video prompt and its negative channel", () => {
    const flow = createImageToVideoFlow({
      id: "video-prompts",
      createdAt: "2026-09-15T00:00:00.000Z",
    });
    const task = connectSecondPrompt(flow, "task.generate-video");
    task.config.negativePrompt = "blurry {{subject}}";
    expect(resolveMediaNodePrompt(flow, task.id)).toEqual({
      sourceNodeId: "connected",
      prompt: "a teapot, pixel",
      negativePrompt: "blurry teapot",
    });
  });

  it("does not borrow an unrelated prompt for missing, ambiguous or generated inputs", () => {
    const flow = imageFlow();
    const task = connectSecondPrompt(flow, "task.generate-image");
    const edge = flow.edges.find(
      (entry) => entry.toNodeId === task.id && entry.toPortId === "prompt",
    )!;
    flow.edges.push({ ...edge, id: "ambiguous", fromNodeId: "prompt" });
    expect(resolveMediaNodePrompt(flow, task.id).prompt).toBeNull();
    flow.edges.pop();
    flow.nodes.find((entry) => entry.id === "connected")!.type =
      "task.generate-prompt";
    expect(resolveMediaNodePrompt(flow, task.id).prompt).toBeNull();
    flow.edges = flow.edges.filter((entry) => entry.id !== edge.id);
    expect(resolveMediaNodePrompt(flow, task.id).prompt).toBeNull();
  });
});
