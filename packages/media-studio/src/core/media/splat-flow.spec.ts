import { describe, expect, it } from "vitest";
import { createMediaModelCatalog } from "./catalog.js";
import { compileMediaFlow } from "./compiler.js";
import {
  createSplatRecipeFlow,
  DEFAULT_SPLAT_RECIPE_SETTINGS,
  readSplatRecipeSettings,
} from "./splat-flow.js";
import { validateMediaFlowDocument } from "./node-registry.js";
import { isConnectedMediaFlow } from "./workflow-compiler.js";
import type { MediaFlow, MediaSplatRecipeSettings } from "./contracts.js";

const installed = createMediaModelCatalog({ isOpenAiConfigured: false }).map(
  (model) =>
    model.id === "local:idol"
      ? {
          ...model,
          installed: true,
          installationStatus: "installed" as const,
          runtimeReadiness: "unverified" as const,
        }
      : model,
);
const flow = (settings: Partial<MediaSplatRecipeSettings> = {}): MediaFlow =>
  createSplatRecipeFlow({
    id: "splat-flow",
    createdAt: "2026-11-03T12:00:00Z",
    settings: {
      ...DEFAULT_SPLAT_RECIPE_SETTINGS,
      sourceAssetId: "asset:chair",
      seed: 0,
      ...settings,
    },
  });
const compile = (document: MediaFlow, models = installed) =>
  compileMediaFlow({ flow: document, models, compiledAt: "2026-11-03T12:00:01Z" });

describe("3D flows", () => {
  it("round-trips recipe settings and binds the installed Idol model", () => {
    const document = flow({ inputKind: "real", gaussianCount: 524_288 });
    expect(validateMediaFlowDocument(document)).toEqual([]);
    expect(readSplatRecipeSettings(document)).toMatchObject({
      sourceAssetId: "asset:chair",
      inputKind: "real",
      gaussianCount: 524_288,
      seed: 0,
    });
    const plan = compile(document);
    expect(plan.status).toBe("ready");
    expect(plan.model?.id).toBe("local:idol");
    expect(plan.runtimeBindings[0]).toMatchObject({
      modality: "splat",
      requiredCapabilities: ["image-to-3d"],
    });
    expect(plan.steps.map((step) => step.kind)).toEqual([
      "resolve-asset",
      "generate-splat",
      "ingest-asset",
    ]);
  });

  it("blocks generation until an image, valid detail, and an installed model exist", () => {
    expect(compile(flow({ sourceAssetId: null })).diagnostics).toContainEqual(
      expect.objectContaining({ code: "SOURCE_ASSET_REQUIRED" }),
    );
    expect(
      compile(flow({ gaussianCount: 100_001 })).diagnostics.map((entry) => entry.message),
    ).toContain("Choose 32,768 to 1,048,576 Gaussians in multiples of 32.");
    const uninstalled = createMediaModelCatalog({ isOpenAiConfigured: false });
    expect(compile(flow(), uninstalled).diagnostics).toContainEqual(
      expect.objectContaining({ code: "MODEL_NOT_READY" }),
    );
  });

  it("runs image-to-3D chains as connected workflows", () => {
    const document = flow();
    expect(isConnectedMediaFlow(document)).toBe(false);
    const chained: MediaFlow = {
      ...document,
      nodes: [
        ...document.nodes,
        {
          id: "prompt",
          type: "source.prompt",
          version: 1,
          label: "Prompt",
          layer: "source",
          config: { prompt: "A ceramic teapot" },
        },
      ],
    };
    expect(isConnectedMediaFlow(chained)).toBe(true);
  });
});
