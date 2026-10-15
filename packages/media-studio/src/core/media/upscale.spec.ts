import { describe, expect, it } from "vitest";
import { compileMediaFlow } from "./compiler.js";
import { createMediaModelCatalog } from "./catalog.js";
import {
  createDefaultMediaNodeConfig,
  validateMediaFlowDocument,
} from "./node-registry.js";
import { createMediaUpscaleFlow } from "./upscale.js";
import { DEFAULT_UPSCALE_SETTINGS } from "./upscale-settings.js";

const draft = (kind: "image" | "video") =>
  createMediaUpscaleFlow({
    id: `upscale-${kind}`,
    createdAt: "2026-10-15T00:00:00Z",
    asset: { id: "asset:source", kind },
    modelPath: "C:/models/span.safetensors",
    settings: { ...DEFAULT_UPSCALE_SETTINGS, tileSize: 128 },
  });

describe("upscaling workflows", () => {
  it.each(["image", "video"] as const)(
    "compiles a local %s upscale without a generation model",
    (kind) => {
      const flow = draft(kind);
      expect(validateMediaFlowDocument(flow)).toEqual([]);
      const plan = compileMediaFlow({
        flow,
        models: [],
        compiledAt: flow.createdAt,
      });
      expect(
        plan.diagnostics.filter((item) => item.severity === "error"),
      ).toEqual([]);
      expect(plan.status).toBe("ready");
      expect(plan.steps.some((step) => step.kind === `upscale-${kind}`)).toBe(
        true,
      );
      expect(plan.steps.every((step) => step.target === "local")).toBe(true);
      expect(plan.runtimeBindings).toEqual([]);
    },
  );

  it.each(["image", "video"] as const)(
    "chains %s generation into the matching upscaler",
    (kind) => {
      const flow = draft(kind);
      const source = flow.nodes[0]!;
      source.type =
        kind === "image" ? "task.generate-image" : "task.generate-video";
      source.layer = "task";
      source.config = {
        ...createDefaultMediaNodeConfig(source.type),
        providerPolicy: "local",
        ...(kind === "image" ? { outputCount: 1 } : {}),
        modelId:
          kind === "image"
            ? "local:flux-2-klein-4b"
            : "local:hunyuan-video-1.5-i2v-step-distilled",
      };
      flow.nodes.unshift({
        id: "prompt",
        type: "source.prompt",
        version: 1,
        layer: "source",
        label: "Prompt",
        config: { prompt: "A moving red ball" },
      });
      flow.edges.unshift({
        id: "prompt-source",
        fromNodeId: "prompt",
        fromPortId: "prompt",
        toNodeId: "source",
        toPortId: "prompt",
      });
      expect(validateMediaFlowDocument(flow)).toEqual([]);
      const models = createMediaModelCatalog({
        isLocalFluxInstalled: true,
        isOpenAiConfigured: false,
      });
      const videoModel = {
        ...models.find((model) => model.id === "local:flux-2-klein-4b")!,
        id: "local:hunyuan-video-1.5-i2v-step-distilled",
        architecture: "hunyuan-video-1.5-i2v" as const,
        capabilities: ["image-to-video" as const],
        availability: "installed" as const,
      };
      if (kind === "video") {
        flow.nodes.push({
          id: "frame",
          type: "source.image",
          version: 1,
          layer: "source",
          label: "First frame",
          config: {
            ...createDefaultMediaNodeConfig("source.image"),
            assetId: "asset:frame",
          },
        });
        flow.edges.push({
          id: "frame-source",
          fromNodeId: "frame",
          fromPortId: "image",
          toNodeId: "source",
          toPortId: "first-frame",
        });
      }
      const plan = compileMediaFlow({
        flow,
        models: [...models, videoModel],
        compiledAt: flow.createdAt,
      });
      expect(
        plan.diagnostics.filter((item) => item.severity === "error"),
      ).toEqual([]);
      expect(
        plan.steps.find((step) => step.kind === `upscale-${kind}`)
          ?.sourceNodeId,
      ).toBe("upscale");
      expect(
        plan.steps.findIndex((step) => step.kind === `generate-${kind}`),
      ).toBeLessThan(
        plan.steps.findIndex((step) => step.kind === `upscale-${kind}`),
      );
    },
  );

  it("rejects mismatched ports and invalid settings before execution", () => {
    const flow = draft("video");
    flow.edges[0]!.fromPortId = "image";
    expect(validateMediaFlowDocument(flow).length).toBeGreaterThan(0);
    const invalid = draft("image");
    invalid.nodes[1]!.config.tileSize = 0;
    expect(
      compileMediaFlow({
        flow: invalid,
        models: [],
        compiledAt: invalid.createdAt,
      }).status,
    ).toBe("blocked");
  });
});
