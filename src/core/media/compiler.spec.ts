import { describe, expect, it } from "vitest";
import { createMediaModelCatalog } from "./catalog.js";
import {
  createMediaFlowDocumentDigest,
  createMediaFlowFingerprint,
  createMediaFlowLayoutDigest,
} from "./canonicalize.js";
import {
  addMediaFlowLayoutComment,
  addMediaFlowLayoutGroup,
  compileMediaFlow,
  createAlphaMatteFlow,
  createSubjectCutoutFlow,
  createImageCompositeFlow,
  createImageContactSheetFlow,
  createImageEditFlow,
  createImageRecipeFlow,
  createImageTransformFlow,
  createMediaFlowLayout,
  reconcileMediaFlowLayout,
  readImageRecipeSettings,
  removeMediaFlowLayoutComment,
  removeMediaFlowLayoutGroup,
  updateMediaFlowLayoutComment,
  updateMediaFlowLayoutGroup,
} from "./compiler.js";
import { getMediaModelAddonCapabilities } from "./model-addons.js";
import {
  DEFAULT_SUBJECT_CUTOUT_MODEL_PRIORITY,
  LOCAL_BIREFNET_MODEL_ID,
  LOCAL_BORDER_MATTE_MODEL_ID,
} from "./subject-cutout-policy.js";
import type {
  ImageRecipeSettings,
  MediaFlow,
  MediaModelAddonDescriptor,
} from "./contracts.js";

const DEFAULT_SETTINGS = {
  prompt: "A quiet brutalist reading room at blue hour",
  providerPolicy: "auto",
  modelPolicy: "balanced",
  modelId: null,
  aspectRatio: "16:9",
  outputCount: 4,
  outputFormat: "png",
  transparentBackground: false,
  qualityGateEnabled: true,
  referenceImages: [],
  modelAddons: [],
} as const satisfies ImageRecipeSettings;

const createFlow = (
  settings: ImageRecipeSettings = DEFAULT_SETTINGS,
): MediaFlow => {
  return createImageRecipeFlow({
    id: "flow-1",
    createdAt: "2026-07-14T00:00:00.000Z",
    settings,
  });
};

const FLUX_LORA = {
  id: "addon:lora:flux-detail",
  kind: "lora",
  displayName: "FLUX Detail",
  architecture: "flux-2",
  architectureConfidence: "high",
  format: "safetensors",
  targetComponents: ["denoiser"],
  embeddingVectors: [],
  loraProfile: {
    algorithm: "lora",
    dialect: "kohya",
    rankMinimum: 8,
    rankMaximum: 8,
    heterogeneousRanks: false,
    targetModuleCount: 1,
    convolutionTargetCount: 0,
    magnitudeVectorCount: 0,
    networkAlphaCount: 0,
  },
  baseModelHint: null,
  triggerWords: ["crisp-detail"],
  defaultToken: null,
  digest: "a".repeat(64),
  headerDigest: "b".repeat(64),
  byteSize: 1_024,
  relativePath: "addons/sha256/a/addon.safetensors",
  sourceUrl: null,
  license: {
    name: "Test terms",
    spdxId: null,
    sourceUrl: "https://example.com/terms",
    commercialUse: "review-required",
    requiresAcceptance: false,
  },
  importedAt: "2026-07-14T00:00:00.000Z",
} as const satisfies MediaModelAddonDescriptor;

const SDXL_EMBEDDING = {
  ...FLUX_LORA,
  id: "addon:embedding:sdxl-concept",
  kind: "textual-inversion",
  displayName: "SDXL Concept",
  architecture: "stable-diffusion-xl",
  targetComponents: ["text-encoder", "text-encoder-2"],
  embeddingVectors: [
    {
      component: "text-encoder",
      tensorKey: "clip_l",
      vectorCount: 4,
      dimension: 768,
    },
    {
      component: "text-encoder-2",
      tensorKey: "clip_g",
      vectorCount: 4,
      dimension: 1_280,
    },
  ],
  loraProfile: null,
  triggerWords: [],
  defaultToken: "<sdxl-concept>",
} as const satisfies MediaModelAddonDescriptor;

describe("media flow compiler", () => {
  it("compiles guided SVG references as explicit multimodal source lineage", () => {
    const catalog = createMediaModelCatalog({ isOpenAiConfigured: true });
    const guidedSvgModel = {
      ...catalog[0]!,
      id: "quiver:arrow-1.1-max",
      providerId: "quiver",
      displayName: "Arrow 1.1 Max",
      family: "Quiver Arrow",
      capabilities: [
        "text-to-svg",
        "image-to-svg",
        "guided-svg-generation",
        "svg-structure-evaluation",
        "render-verified",
      ] as const,
    };
    const settings: ImageRecipeSettings = {
      ...DEFAULT_SETTINGS,
      modelId: guidedSvgModel.id,
      outputFormat: "svg",
      qualityGateEnabled: false,
      referenceImages: [
        { assetId: "asset:sketch", role: "composition", influence: 0.8 },
        { assetId: "asset:palette", role: "palette", influence: 0.55 },
      ],
    };
    const flow = createFlow(settings);
    const plan = compileMediaFlow({
      flow,
      models: [guidedSvgModel],
      compiledAt: "2026-07-15T00:00:00.000Z",
    });

    expect(plan.status).toBe("ready");
    expect(flow.nodes.filter((node) => node.type === "source.image")).toHaveLength(2);
    expect(
      flow.edges.filter(
        (edge) => edge.toNodeId === "generate" && edge.toPortId === "image",
      ),
    ).toHaveLength(2);
    expect(readImageRecipeSettings(flow)?.referenceImages).toEqual(
      settings.referenceImages,
    );
    expect(plan.steps.filter((step) => step.kind === "resolve-asset")).toHaveLength(2);
    expect(plan.steps.some((step) => step.kind === "generate-svg")).toBe(true);
    expect(plan.preflight.remoteUploadAssetIds).toEqual([
      "asset:sketch",
      "asset:palette",
    ]);
  });

  it("compiles opt-in SVG render-and-verify as separate paid OpenAI requests", () => {
    const catalog = createMediaModelCatalog({ isOpenAiConfigured: true });
    const svgModel = {
      ...catalog[0]!,
      id: "quiver:arrow-1.1-max",
      providerId: "quiver",
      displayName: "Arrow 1.1 Max",
      family: "Quiver Arrow",
      capabilities: [
        "text-to-svg",
        "guided-svg-generation",
        "svg-structure-evaluation",
        "render-verified",
      ] as const,
    };
    const plan = compileMediaFlow({
      flow: createFlow({
        ...DEFAULT_SETTINGS,
        modelId: svgModel.id,
        modelPolicy: "quality",
        outputFormat: "svg",
        qualityGateEnabled: false,
        svgCriticEnabled: true,
      }),
      models: [...catalog, svgModel],
      compiledAt: "2026-07-15T00:00:00.000Z",
    });

    const repairStep = plan.steps.find((step) => step.kind === "repair-svg");
    expect(plan.status).toBe("ready");
    expect(repairStep).toMatchObject({ target: "remote", sideEffect: "paid-request" });
    expect(plan.preflight.privacySummary).toContain("up to two separately billed");
  });

  it("compiles one-source SVG vectorization without requiring a prompt", () => {
    const catalog = createMediaModelCatalog({ isOpenAiConfigured: true });
    const vectorizationModel = {
      ...catalog[0]!,
      id: "recraft:recraftv4_1_pro_vector",
      providerId: "recraft",
      displayName: "Recraft V4.1 Pro Vector",
      family: "Recraft Vector",
      capabilities: [
        "text-to-svg",
        "image-to-svg",
        "svg-structure-evaluation",
        "render-verified",
      ] as const,
    };
    const flow = createFlow({
      ...DEFAULT_SETTINGS,
      prompt: "",
      modelId: vectorizationModel.id,
      outputCount: 1,
      outputFormat: "svg",
      qualityGateEnabled: false,
      svgMode: "vectorize",
      svgAutoCrop: true,
      svgTargetSize: 2048,
      svgCandidateCount: 1,
      svgCriticEnabled: false,
      referenceImages: [
        { assetId: "asset:product-raster", role: "base", influence: 1 },
      ],
    });
    const plan = compileMediaFlow({
      flow,
      models: [vectorizationModel],
      compiledAt: "2026-07-15T00:00:00.000Z",
    });

    expect(plan.status).toBe("ready");
    expect(flow.nodes.some((node) => node.type === "source.prompt")).toBe(false);
    expect(plan.steps.some((step) => step.kind === "normalize-prompt")).toBe(false);
    expect(plan.steps.some((step) => step.kind === "vectorize-svg")).toBe(true);
    expect(plan.steps.some((step) => step.kind === "repair-svg")).toBe(false);
    expect(plan.diagnostics.some((diagnostic) => diagnostic.code === "PROMPT_REQUIRED"))
      .toBe(false);
  });

  it("resolves compatible local LoRAs into an explicit execution step", () => {
    const plan = compileMediaFlow({
      flow: createFlow({
        ...DEFAULT_SETTINGS,
        providerPolicy: "local",
        modelId: "local:flux-2-klein-4b",
        modelAddons: [{
          kind: "lora",
          addonId: FLUX_LORA.id,
          enabled: true,
          modelStrength: 0.8,
          textEncoderStrength: null,
          denoisingSchedule: { start: 0.2, end: 0.8 },
        }],
      }),
      models: createMediaModelCatalog({
        isOpenAiConfigured: false,
        isLocalFluxInstalled: true,
      }),
      addons: [FLUX_LORA],
      compiledAt: "2026-07-14T00:01:00.000Z",
    });

    expect(plan.status).toBe("ready");
    expect(plan.addons).toEqual([
      expect.objectContaining({
        descriptor: expect.objectContaining({ id: FLUX_LORA.id }),
        selection: expect.objectContaining({
          denoisingSchedule: { start: 0.2, end: 0.8 },
        }),
        compatibility: "compatible",
      }),
    ]);
    expect(plan.steps.map((step) => step.kind)).toContain("resolve-model-addons");
  });

  it("rejects denoising schedules for LoRAs that also target text encoders", () => {
    const baseModel = createMediaModelCatalog({
      isOpenAiConfigured: false,
      isLocalFluxInstalled: true,
    }).find((model) => model.id === "local:flux-2-klein-4b")!;
    const stableDiffusionModel = {
      ...baseModel,
      id: "local:user:sdxl-scheduled-lora",
      displayName: "Imported SDXL",
      family: "Stable Diffusion XL",
      architecture: "stable-diffusion-xl",
      addonCapabilities: getMediaModelAddonCapabilities(
        "local-diffusers",
        "stable-diffusion-xl",
      ),
      userImported: true,
    } as const;
    const multiComponentLora = {
      ...FLUX_LORA,
      id: "addon:lora:sdxl-multi-component",
      displayName: "SDXL Multi-component",
      architecture: "stable-diffusion-xl",
      targetComponents: ["denoiser", "text-encoder"],
    } as const satisfies MediaModelAddonDescriptor;
    const plan = compileMediaFlow({
      flow: createFlow({
        ...DEFAULT_SETTINGS,
        providerPolicy: "local",
        modelId: stableDiffusionModel.id,
        modelAddons: [{
          kind: "lora",
          addonId: multiComponentLora.id,
          enabled: true,
          modelStrength: 0.8,
          textEncoderStrength: null,
          denoisingSchedule: { start: 0.1, end: 0.7 },
        }],
      }),
      models: [stableDiffusionModel],
      addons: [multiComponentLora],
      compiledAt: "2026-07-15T00:01:20.000Z",
    });

    expect(plan.status).toBe("blocked");
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "ADDON_CONFIG_INVALID",
        message: expect.stringContaining("text encoders"),
      }),
    );
  });

  it("rejects text-encoder strength for a denoiser-only LoRA", () => {
    const baseModel = createMediaModelCatalog({
      isOpenAiConfigured: false,
      isLocalFluxInstalled: true,
    }).find((model) => model.id === "local:flux-2-klein-4b")!;
    const stableDiffusionModel = {
      ...baseModel,
      id: "local:user:sdxl-lora",
      displayName: "Imported SDXL",
      family: "Stable Diffusion XL",
      architecture: "stable-diffusion-xl",
      addonCapabilities: getMediaModelAddonCapabilities(
        "local-diffusers",
        "stable-diffusion-xl",
      ),
      userImported: true,
    } as const;
    const denoiserLora = {
      ...FLUX_LORA,
      id: "addon:lora:sdxl-denoiser",
      displayName: "SDXL Denoiser",
      architecture: "stable-diffusion-xl",
    } as const satisfies MediaModelAddonDescriptor;
    const plan = compileMediaFlow({
      flow: createFlow({
        ...DEFAULT_SETTINGS,
        providerPolicy: "local",
        modelId: stableDiffusionModel.id,
        modelAddons: [{
          kind: "lora",
          addonId: denoiserLora.id,
          enabled: true,
          modelStrength: 0.8,
          textEncoderStrength: 0.4,
          denoisingSchedule: null,
        }],
      }),
      models: [stableDiffusionModel],
      addons: [denoiserLora],
      compiledAt: "2026-07-15T00:01:30.000Z",
    });

    expect(plan.status).toBe("blocked");
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({ code: "ADDON_CONFIG_INVALID" }),
    );
  });

  it("blocks LoRAs on OpenAI instead of silently ignoring them", () => {
    const plan = compileMediaFlow({
      flow: createFlow({
        ...DEFAULT_SETTINGS,
        modelId: "openai:gpt-image-2",
        modelAddons: [{
          kind: "lora",
          addonId: FLUX_LORA.id,
          enabled: true,
          modelStrength: 1,
          textEncoderStrength: null,
          denoisingSchedule: null,
        }],
      }),
      models: createMediaModelCatalog({ isOpenAiConfigured: true }),
      addons: [FLUX_LORA],
      compiledAt: "2026-07-14T00:01:00.000Z",
    });

    expect(plan.status).toBe("blocked");
    expect(plan.addons).toEqual([]);
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({ code: "ADDON_PROVIDER_UNSUPPORTED" }),
    );
  });

  it("resolves textual-inversion tokens for compatible Stable Diffusion models", () => {
    const baseModel = createMediaModelCatalog({
      isOpenAiConfigured: false,
      isLocalFluxInstalled: true,
    }).find((model) => model.id === "local:flux-2-klein-4b")!;
    const stableDiffusionModel = {
      ...baseModel,
      id: "local:user:sdxl",
      displayName: "Imported SDXL",
      family: "Stable Diffusion XL",
      architecture: "stable-diffusion-xl",
      addonCapabilities: getMediaModelAddonCapabilities(
        "local-diffusers",
        "stable-diffusion-xl",
      ),
      userImported: true,
    } as const;
    const plan = compileMediaFlow({
      flow: createFlow({
        ...DEFAULT_SETTINGS,
        providerPolicy: "local",
        modelId: stableDiffusionModel.id,
        modelAddons: [{
          kind: "textual-inversion",
          addonId: SDXL_EMBEDDING.id,
          enabled: true,
          token: "<sdxl-concept>",
          placement: "positive",
        }],
      }),
      models: [stableDiffusionModel],
      addons: [SDXL_EMBEDDING],
      compiledAt: "2026-07-14T00:01:00.000Z",
    });

    expect(plan.status).toBe("ready");
    expect(plan.addons[0]).toMatchObject({
      descriptor: { id: SDXL_EMBEDDING.id },
      selection: { token: "<sdxl-concept>", placement: "positive" },
    });
  });

  it("rejects negative textual-inversion placement for FLUX pipelines", () => {
    const baseModel = createMediaModelCatalog({
      isOpenAiConfigured: false,
      isLocalFluxInstalled: true,
    }).find((model) => model.id === "local:flux-2-klein-4b")!;
    const fluxModel = {
      ...baseModel,
      id: "local:user:flux-1",
      displayName: "Imported FLUX.1",
      family: "FLUX.1",
      architecture: "flux-1",
      addonCapabilities: getMediaModelAddonCapabilities(
        "local-diffusers",
        "flux-1",
      ),
      userImported: true,
    } as const;
    const embedding = {
      ...SDXL_EMBEDDING,
      id: "addon:embedding:flux-concept",
      displayName: "FLUX Concept",
      architecture: "flux-1",
      targetComponents: ["text-encoder-2"],
      embeddingVectors: [{
        component: "text-encoder-2",
        tensorKey: "t5",
        vectorCount: 1,
        dimension: 4_096,
      }],
      defaultToken: "<flux-concept>",
    } as const satisfies MediaModelAddonDescriptor;
    const plan = compileMediaFlow({
      flow: createFlow({
        ...DEFAULT_SETTINGS,
        providerPolicy: "local",
        modelId: fluxModel.id,
        modelAddons: [{
          kind: "textual-inversion",
          addonId: embedding.id,
          enabled: true,
          token: "<flux-concept>",
          placement: "negative",
        }],
      }),
      models: [fluxModel],
      addons: [embedding],
      compiledAt: "2026-07-15T00:02:00.000Z",
    });

    expect(plan.status).toBe("blocked");
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({ code: "ADDON_CONFIG_INVALID" }),
    );
  });

  it("reconciles persisted layout without changing semantic flow identity", () => {
    const flow = createFlow();
    const fingerprintBeforeLayout = createMediaFlowFingerprint(flow);
    const generated = createMediaFlowLayout(flow);
    const moved = {
      ...generated,
      nodes: generated.nodes.map((entry) =>
        entry.nodeId === "generate" ? { ...entry, x: 777, y: -42 } : entry,
      ),
    };

    const reconciled = reconcileMediaFlowLayout(flow, moved);

    expect(reconciled.nodes.find((entry) => entry.nodeId === "generate")).toMatchObject({
      x: 777,
      y: -42,
    });
    expect(createMediaFlowFingerprint(flow)).toBe(fingerprintBeforeLayout);
  });

  it("selects a configured remote model and expands quality steps", () => {
    const plan = compileMediaFlow({
      flow: createFlow(),
      models: createMediaModelCatalog({
        isOpenAiConfigured: true,
        isLocalBiRefNetInstalled: true,
      }),
      compiledAt: "2026-07-14T00:01:00.000Z",
    });

    expect(plan.status).toBe("ready");
    expect(plan.model?.id).toBe("openai:gpt-image-2");
    expect(plan.preflight.requiresRemoteRequest).toBe(true);
    expect(plan.steps.map((step) => step.kind)).toEqual([
      "normalize-prompt",
      "resolve-model",
      "generate-image",
      "analyze-quality",
      "evaluate-gate",
      "ingest-asset",
    ]);
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({ code: "REMOTE_EXECUTION_SELECTED" }),
    );
  });

  it("compiles a text-guided image edit with an explicit upload manifest", () => {
    const flow = createImageEditFlow({
      id: "flow:edit-1",
      createdAt: "2026-07-14T00:00:00.000Z",
      sourceAssetId: "asset:approved-product-shot",
      settings: {
        ...DEFAULT_SETTINGS,
        prompt: "Keep the product unchanged and replace the background with warm travertine.",
        outputCount: 2,
        qualityGateEnabled: false,
      },
    });
    const plan = compileMediaFlow({
      flow,
      models: createMediaModelCatalog({
        isOpenAiConfigured: true,
        isLocalBiRefNetInstalled: true,
      }),
      compiledAt: "2026-07-14T00:01:00.000Z",
    });

    expect(plan.status).toBe("ready");
    expect(plan.model?.capabilities).toContain("image-to-image");
    expect(plan.steps.map((step) => step.kind)).toEqual([
      "normalize-prompt",
      "resolve-asset",
      "resolve-model",
      "edit-image",
      "ingest-asset",
    ]);
    expect(plan.preflight.remoteUploadAssetIds).toEqual([
      "asset:approved-product-shot",
    ]);
    expect(plan.preflight.privacySummary).toContain("1 disclosed source asset");
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "REMOTE_ASSET_UPLOAD_SELECTED",
        message: expect.stringContaining("asset:approved-product-shot"),
      }),
    );
  });

  it("preserves explicit quality analysis and gating for image edits", () => {
    const flow = createImageEditFlow({
      id: "flow:edit-with-quality",
      createdAt: "2026-07-14T00:00:00.000Z",
      sourceAssetId: "asset:approved-product-shot",
      settings: {
        ...DEFAULT_SETTINGS,
        prompt: "Keep the silhouette and refine the material finish.",
        transparentBackground: true,
      },
    });
    const plan = compileMediaFlow({
      flow,
      models: createMediaModelCatalog({
        isOpenAiConfigured: true,
        isLocalBiRefNetInstalled: true,
      }),
      compiledAt: "2026-07-14T00:01:00.000Z",
    });

    expect(plan.status).toBe("ready");
    expect(plan.steps.map((step) => step.kind)).toEqual([
      "normalize-prompt",
      "resolve-asset",
      "resolve-model",
      "edit-image",
      "cutout-subject",
      "analyze-quality",
      "evaluate-gate",
      "ingest-asset",
    ]);
  });

  it("compiles labeled multi-reference edits with a stable exact upload order", () => {
    const flow = createImageEditFlow({
      id: "flow:multi-reference-edit",
      createdAt: "2026-07-14T00:00:00.000Z",
      sourceAssetId: "asset:base",
      referenceAssets: [
        { assetId: "asset:subject", role: "subject", influence: 0.9 },
        { assetId: "asset:style", role: "style", influence: 0.45 },
      ],
      settings: {
        ...DEFAULT_SETTINGS,
        prompt: "Preserve the subject and apply the material language from the style reference.",
        qualityGateEnabled: false,
      },
    });
    const plan = compileMediaFlow({
      flow,
      models: createMediaModelCatalog({ isOpenAiConfigured: true }),
      compiledAt: "2026-07-14T00:01:00.000Z",
    });

    expect(plan.status).toBe("ready");
    expect(plan.model?.capabilities).toContain("multi-reference-edit");
    expect(plan.preflight.remoteUploadAssetIds).toEqual([
      "asset:base",
      "asset:subject",
      "asset:style",
    ]);
    expect(plan.steps.filter((step) => step.kind === "resolve-asset")).toHaveLength(3);
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "REMOTE_ASSET_UPLOAD_SELECTED",
        message: expect.stringContaining("3 disclosed source assets"),
      }),
    );
    expect(readImageRecipeSettings(flow)?.referenceImages).toEqual([
      { assetId: "asset:base", role: "base", influence: 1 },
      { assetId: "asset:subject", role: "subject", influence: 0.9 },
      { assetId: "asset:style", role: "style", influence: 0.45 },
    ]);
  });

  it("excludes disconnected image sources from the provider upload manifest", () => {
    const baseFlow = createImageEditFlow({
      id: "flow:disconnected-reference",
      createdAt: "2026-07-14T00:00:00.000Z",
      sourceAssetId: "asset:connected",
      settings: {
        ...DEFAULT_SETTINGS,
        prompt: "Refine the connected image.",
        qualityGateEnabled: false,
      },
    });
    const flow: MediaFlow = {
      ...baseFlow,
      nodes: [
        ...baseFlow.nodes,
        {
          id: "unused-reference",
          type: "source.image",
          version: 1,
          label: "Unused reference",
          layer: "source",
          config: {
            assetId: "asset:must-not-upload",
            referenceRole: "style",
            influence: 1,
          },
        },
      ],
    };
    const plan = compileMediaFlow({
      flow,
      models: createMediaModelCatalog({ isOpenAiConfigured: true }),
      compiledAt: "2026-07-14T00:01:00.000Z",
    });

    expect(plan.status).toBe("blocked");
    expect(plan.preflight.remoteUploadAssetIds).toEqual(["asset:connected"]);
  });

  it("blocks image edits that do not identify an immutable source asset", () => {
    const plan = compileMediaFlow({
      flow: createImageEditFlow({
        id: "flow:edit-missing-source",
        createdAt: "2026-07-14T00:00:00.000Z",
        sourceAssetId: "",
        settings: {
          ...DEFAULT_SETTINGS,
          prompt: "Create a lower-key lighting variation.",
          qualityGateEnabled: false,
        },
      }),
      models: createMediaModelCatalog({ isOpenAiConfigured: true }),
      compiledAt: "2026-07-14T00:01:00.000Z",
    });

    expect(plan.status).toBe("blocked");
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "SOURCE_ASSET_REQUIRED",
        nodeId: "source-image",
      }),
    );
  });

  it("expands crop, resize, and format conversion as cacheable local operations", () => {
    const source = createFlow({
      ...DEFAULT_SETTINGS,
      qualityGateEnabled: false,
    });
    const flow: MediaFlow = {
      ...source,
      nodes: [
        ...source.nodes.filter((node) => node.id !== "asset-output"),
        {
          id: "crop",
          type: "operation.crop",
          version: 1,
          label: "Crop image",
          layer: "operation",
          config: { x: 0, y: 0, width: 1200, height: 1200 },
        },
        {
          id: "resize",
          type: "operation.resize",
          version: 1,
          label: "Resize image",
          layer: "operation",
          config: { width: 800, height: 800, fit: "contain" },
        },
        {
          id: "format-convert",
          type: "operation.format-convert",
          version: 1,
          label: "Convert image format",
          layer: "operation",
          config: { outputFormat: "webp", quality: 90 },
        },
        ...source.nodes.filter((node) => node.id === "asset-output"),
      ],
      edges: [
        ...source.edges.filter((edge) => edge.id !== "result-to-output"),
        {
          id: "generate-crop",
          fromNodeId: "generate",
          fromPortId: "image",
          toNodeId: "crop",
          toPortId: "image",
        },
        {
          id: "crop-resize",
          fromNodeId: "crop",
          fromPortId: "image",
          toNodeId: "resize",
          toPortId: "image",
        },
        {
          id: "resize-format",
          fromNodeId: "resize",
          fromPortId: "image",
          toNodeId: "format-convert",
          toPortId: "image",
        },
        {
          id: "format-output",
          fromNodeId: "format-convert",
          fromPortId: "image",
          toNodeId: "asset-output",
          toPortId: "image",
        },
      ],
    };
    const plan = compileMediaFlow({
      flow,
      models: createMediaModelCatalog({ isOpenAiConfigured: true }),
      compiledAt: "2026-07-14T00:01:00.000Z",
    });

    expect(plan.status).toBe("ready");
    expect(plan.steps.map((step) => step.kind)).toEqual([
      "normalize-prompt",
      "resolve-model",
      "generate-image",
      "crop-image",
      "resize-image",
      "convert-image",
      "ingest-asset",
    ]);
    expect(
      plan.steps
        .filter((step) =>
          ["crop-image", "resize-image", "convert-image"].includes(step.kind),
        )
        .every((step) => step.target === "local" && step.cacheable),
    ).toBe(true);
  });

  it("compiles a taskless local image utility pipeline without model plumbing", () => {
    const flow: MediaFlow = {
      schemaVersion: 1,
      id: "flow:local-image-utility",
      name: "Local image utility",
      description: "Crop, resize, and encode an immutable source.",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
      variables: [],
      variableBindings: {},
      presets: [],
      activePresetId: null,
      nodes: [
        {
          id: "source",
          type: "source.image",
          version: 1,
          label: "Source image",
          layer: "source",
          config: {
            assetId: "asset:local-source",
            referenceRole: "base",
            influence: 1,
          },
        },
        {
          id: "crop",
          type: "operation.crop",
          version: 1,
          label: "Crop",
          layer: "operation",
          config: { x: 0, y: 0, width: 1200, height: 1200 },
        },
        {
          id: "resize",
          type: "operation.resize",
          version: 1,
          label: "Resize",
          layer: "operation",
          config: { width: 800, height: 800, fit: "contain" },
        },
        {
          id: "convert",
          type: "operation.format-convert",
          version: 1,
          label: "Convert",
          layer: "operation",
          config: { outputFormat: "webp", quality: 90 },
        },
        {
          id: "output",
          type: "output.asset",
          version: 1,
          label: "Save",
          layer: "output",
          config: { format: "webp", outputCount: 1 },
        },
      ],
      edges: [
        {
          id: "source-crop",
          fromNodeId: "source",
          fromPortId: "image",
          toNodeId: "crop",
          toPortId: "image",
        },
        {
          id: "crop-resize",
          fromNodeId: "crop",
          fromPortId: "image",
          toNodeId: "resize",
          toPortId: "image",
        },
        {
          id: "resize-convert",
          fromNodeId: "resize",
          fromPortId: "image",
          toNodeId: "convert",
          toPortId: "image",
        },
        {
          id: "convert-output",
          fromNodeId: "convert",
          fromPortId: "image",
          toNodeId: "output",
          toPortId: "image",
        },
      ],
    };
    const plan = compileMediaFlow({
      flow,
      models: createMediaModelCatalog({ isOpenAiConfigured: false }),
      compiledAt: "2026-07-14T00:01:00.000Z",
    });

    expect(plan.status).toBe("ready");
    expect(plan.model).toBeNull();
    expect(plan.preflight).toMatchObject({
      target: "local",
      modelLabel: "Built-in media utilities",
      requiresRemoteRequest: false,
      generatedCandidates: 0,
      estimatedOutputs: 1,
    });
    expect(plan.steps.map((step) => step.kind)).toEqual([
      "resolve-asset",
      "crop-image",
      "resize-image",
      "convert-image",
      "ingest-asset",
    ]);
    expect(plan.diagnostics).toEqual([]);
  });

  it("opens a reviewed resize request as an explicit local transform and encode flow", () => {
    const flow = createImageTransformFlow({
      id: "flow:library-transform",
      createdAt: "2026-07-14T00:00:00.000Z",
      request: {
        sourceAssetId: "asset:library-source",
        operation: {
          kind: "resize",
          width: 1600,
          height: 900,
          fit: "cover",
        },
        outputFormat: "jpeg",
        quality: 86,
        jpegBackground: "#111827",
      },
    });
    const plan = compileMediaFlow({
      flow,
      models: createMediaModelCatalog({ isOpenAiConfigured: false }),
      compiledAt: "2026-07-14T00:01:00.000Z",
    });

    expect(plan.status).toBe("ready");
    expect(flow.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "operation.resize",
          config: { width: 1600, height: 900, fit: "cover" },
        }),
        expect.objectContaining({
          type: "operation.format-convert",
          config: {
            outputFormat: "jpeg",
            quality: 86,
            jpegBackground: "#111827",
          },
        }),
      ]),
    );
    expect(plan.steps.map((step) => step.kind)).toEqual([
      "resolve-asset",
      "resize-image",
      "convert-image",
      "ingest-asset",
    ]);
  });

  it("creates a model-backed subject cutout flow with an explicit matte", () => {
    const flow = createSubjectCutoutFlow({
      id: "flow:background-matte",
      createdAt: "2026-07-14T00:00:00.000Z",
      sourceAssetId: "asset:studio-source",
    });
    const plan = compileMediaFlow({
      flow,
      models: createMediaModelCatalog({
        isOpenAiConfigured: false,
        isLocalBiRefNetInstalled: true,
      }),
      compiledAt: "2026-07-14T00:01:00.000Z",
    });

    expect(plan.status).toBe("ready");
    expect(flow.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "operation.subject-cutout",
          config: {
            modelPriority: [...DEFAULT_SUBJECT_CUTOUT_MODEL_PRIORITY],
            outputMatte: true,
          },
        }),
        expect.objectContaining({
          type: "operation.auto-tag",
          config: { profile: "technical-metadata-v1" },
        }),
        expect.objectContaining({
          type: "output.asset",
          config: { format: "png", outputCount: 1 },
        }),
      ]),
    );
    expect(plan.steps.map((step) => step.kind)).toEqual([
      "resolve-asset",
      "cutout-subject",
      "auto-tag",
      "ingest-asset",
    ]);
    expect(plan.preflight).toMatchObject({
      target: "local",
      requiresRemoteRequest: false,
      estimatedOutputs: 1,
    });
    expect(plan.steps.find((step) => step.kind === "cutout-subject")?.label).toContain(
      "1 BiRefNet Matting → 2 Local Border Matte",
    );
  });

  it("selects the first runnable subject-cutout fallback without blocking the flow", () => {
    const flow = createSubjectCutoutFlow({
      id: "flow:background-matte-fallback",
      createdAt: "2026-07-14T00:00:00.000Z",
      sourceAssetId: "asset:studio-source",
    });
    const plan = compileMediaFlow({
      flow,
      models: createMediaModelCatalog({ isOpenAiConfigured: false }),
      compiledAt: "2026-07-14T00:01:00.000Z",
    });

    expect(plan.status).toBe("ready");
    expect(plan.model?.id).toBe(LOCAL_BORDER_MATTE_MODEL_ID);
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "SUBJECT_CUTOUT_FALLBACK_SELECTED",
        severity: "warning",
      }),
    );
  });

  it("honors an explicit subject-cutout priority and blocks when it has no fallback", () => {
    const preferredBorder = createSubjectCutoutFlow({
      id: "flow:border-first",
      createdAt: "2026-07-14T00:00:00.000Z",
      sourceAssetId: "asset:studio-source",
      modelPriority: [LOCAL_BORDER_MATTE_MODEL_ID, LOCAL_BIREFNET_MODEL_ID],
    });
    const borderPlan = compileMediaFlow({
      flow: preferredBorder,
      models: createMediaModelCatalog({ isOpenAiConfigured: false }),
      compiledAt: "2026-07-14T00:01:00.000Z",
    });
    expect(borderPlan.status).toBe("ready");
    expect(borderPlan.model?.id).toBe(LOCAL_BORDER_MATTE_MODEL_ID);
    expect(borderPlan.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "SUBJECT_CUTOUT_FALLBACK_SELECTED" }),
    );

    const birefNetOnly = createSubjectCutoutFlow({
      id: "flow:birefnet-only",
      createdAt: "2026-07-14T00:00:00.000Z",
      sourceAssetId: "asset:studio-source",
      modelPriority: [LOCAL_BIREFNET_MODEL_ID],
    });
    const blockedPlan = compileMediaFlow({
      flow: birefNetOnly,
      models: createMediaModelCatalog({ isOpenAiConfigured: false }),
      compiledAt: "2026-07-14T00:01:00.000Z",
    });
    expect(blockedPlan.status).toBe("blocked");
    expect(blockedPlan.diagnostics).toContainEqual(
      expect.objectContaining({ code: "LOCAL_MODEL_DOWNLOAD_REQUIRED" }),
    );
  });

  it("creates a lossless local alpha-channel extraction flow", () => {
    const flow = createAlphaMatteFlow({
      id: "flow:alpha-extraction",
      createdAt: "2026-07-14T00:00:00.000Z",
      sourceAssetId: "asset:transparent-source",
      invert: true,
    });
    const plan = compileMediaFlow({
      flow,
      models: [],
      compiledAt: "2026-07-14T00:01:00.000Z",
    });

    expect(plan.status).toBe("ready");
    expect(flow.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "operation.alpha-matte",
          config: { invert: true },
        }),
        expect.objectContaining({
          type: "operation.auto-tag",
          config: { profile: "technical-metadata-v1" },
        }),
        expect.objectContaining({
          type: "output.asset",
          config: { format: "png", outputCount: 1 },
        }),
      ]),
    );
    expect(plan.steps.map((step) => step.kind)).toEqual([
      "resolve-asset",
      "extract-alpha-matte",
      "auto-tag",
      "ingest-asset",
    ]);
  });

  it("creates a typed local foreground-over-background composite flow", () => {
    const flow = createImageCompositeFlow({
      id: "flow:composite",
      createdAt: "2026-07-14T00:00:00.000Z",
      foregroundAssetId: "asset:foreground",
      backgroundAssetId: "asset:background",
      fit: "cover",
      opacityPercent: 80,
    });
    const plan = compileMediaFlow({
      flow,
      models: [],
      compiledAt: "2026-07-14T00:01:00.000Z",
    });

    expect(plan.status).toBe("ready");
    expect(flow.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromNodeId: "foreground-image",
          toNodeId: "composite",
          toPortId: "foreground",
        }),
        expect.objectContaining({
          fromNodeId: "background-image",
          toNodeId: "composite",
          toPortId: "background",
        }),
      ]),
    );
    expect(plan.steps.map((step) => step.kind)).toEqual([
      "resolve-asset",
      "resolve-asset",
      "composite-image",
      "auto-tag",
      "ingest-asset",
    ]);
  });

  it("creates a bounded ordered contact-sheet flow without exposing image plumbing", () => {
    const flow = createImageContactSheetFlow({
      id: "flow:guided-contact-sheet",
      createdAt: "2026-07-14T00:00:00.000Z",
      sourceAssetIds: ["asset:one", "asset:two", "asset:three"],
    });
    const plan = compileMediaFlow({
      flow,
      models: [],
      compiledAt: "2026-07-14T00:01:00.000Z",
    });

    expect(plan.status).toBe("ready");
    expect(
      flow.nodes
        .filter((node) => node.type === "source.image")
        .map((node) => node.config.assetId),
    ).toEqual(["asset:one", "asset:two", "asset:three"]);
    expect(flow.nodes.find((node) => node.type === "operation.contact-sheet")?.config)
      .toEqual({
        columns: 2,
        cellWidth: 512,
        cellHeight: 512,
        gap: 16,
        background: "#0f172a",
        labelMode: "index",
      });
    expect(plan.steps.map((step) => step.kind)).toEqual([
      "resolve-asset",
      "resolve-asset",
      "resolve-asset",
      "create-contact-sheet",
      "auto-tag",
      "ingest-asset",
    ]);
    expect(() =>
      createImageContactSheetFlow({
        id: "flow:invalid-contact-sheet",
        createdAt: "2026-07-14T00:00:00.000Z",
        sourceAssetIds: ["asset:one", "asset:one"],
      }),
    ).toThrow(/two and eight unique image assets/u);
  });

  it("compiles a guided generate-and-choose recipe into a durable review contract", () => {
    const flow = createImageRecipeFlow({
      id: "flow:generate-and-choose",
      createdAt: "2026-07-14T00:00:00.000Z",
      settings: { ...DEFAULT_SETTINGS, qualityGateEnabled: false, outputCount: 4 },
      review: {
        instructions: "Choose the strongest candidate for publication.",
        maxSelections: 1,
        requireComment: false,
      },
    });
    const plan = compileMediaFlow({
      flow,
      models: createMediaModelCatalog({
        isOpenAiConfigured: true,
        isLocalBiRefNetInstalled: true,
      }),
      compiledAt: "2026-07-14T00:01:00.000Z",
    });

    expect(plan.status).toBe("ready");
    expect(plan.preflight.generatedCandidates).toBe(4);
    expect(plan.preflight.estimatedOutputs).toBe(1);
    expect(plan.preflight.requiresHumanReview).toBe(true);
    expect(plan.steps.find((step) => step.kind === "wait-for-review")?.review)
      .toEqual({
        instructions: "Choose the strongest candidate for publication.",
        maxSelections: 1,
        requireComment: false,
      });
    expect(flow.nodes.find((node) => node.type === "output.asset")?.config)
      .toMatchObject({ outputCount: 1 });
  });

  it("compiles bounded contact-sheet and metadata privacy operations", () => {
    const flow: MediaFlow = {
      schemaVersion: 1,
      id: "flow:contact-sheet",
      name: "Contact sheet",
      description: "",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
      variables: [],
      variableBindings: {},
      presets: [],
      activePresetId: null,
      nodes: [
        ...["one", "two"].map((suffix) => ({
          id: `source-${suffix}`,
          type: "source.image" as const,
          version: 1 as const,
          label: `Source ${suffix}`,
          layer: "source" as const,
          config: {
            assetId: `asset:${suffix}`,
            referenceRole: "base",
            influence: 1,
          },
        })),
        {
          id: "contact-sheet",
          type: "operation.contact-sheet",
          version: 1,
          label: "Contact sheet",
          layer: "operation",
          config: {
            columns: 2,
            cellWidth: 512,
            cellHeight: 512,
            gap: 16,
            background: "#0f172a",
            labelMode: "index",
          },
        },
        {
          id: "metadata-strip",
          type: "operation.metadata-strip",
          version: 1,
          label: "Strip metadata",
          layer: "operation",
          config: { preserveColorProfile: true, applyOrientation: true },
        },
        {
          id: "output",
          type: "output.asset",
          version: 1,
          label: "Save",
          layer: "output",
          config: { format: "png", outputCount: 1 },
        },
      ],
      edges: [
        ...["one", "two"].map((suffix) => ({
          id: `source-${suffix}-contact-sheet`,
          fromNodeId: `source-${suffix}`,
          fromPortId: "image",
          toNodeId: "contact-sheet",
          toPortId: "image",
        })),
        {
          id: "contact-sheet-metadata-strip",
          fromNodeId: "contact-sheet",
          fromPortId: "image",
          toNodeId: "metadata-strip",
          toPortId: "image",
        },
        {
          id: "metadata-strip-output",
          fromNodeId: "metadata-strip",
          fromPortId: "image",
          toNodeId: "output",
          toPortId: "image",
        },
      ],
    };
    const plan = compileMediaFlow({
      flow,
      models: [],
      compiledAt: "2026-07-14T00:01:00.000Z",
    });

    expect(plan.status).toBe("ready");
    expect(plan.preflight.estimatedOutputs).toBe(1);
    expect(plan.steps.map((step) => step.kind)).toEqual([
      "resolve-asset",
      "resolve-asset",
      "create-contact-sheet",
      "strip-metadata",
      "ingest-asset",
    ]);
  });

  it("keeps transparency as a visible matting operation", () => {
    const flow = createFlow({
      ...DEFAULT_SETTINGS,
      transparentBackground: true,
    });
    const plan = compileMediaFlow({
      flow,
      models: createMediaModelCatalog({
        isOpenAiConfigured: true,
        isLocalBiRefNetInstalled: true,
      }),
      compiledAt: "2026-07-14T00:01:00.000Z",
    });

    expect(flow.nodes.map((node) => node.type)).toContain(
      "operation.subject-cutout",
    );
    expect(plan.steps.map((step) => step.kind)).toContain("cutout-subject");
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "TRANSPARENCY_REQUIRES_POSTPROCESS",
        severity: "warning",
      }),
    );
  });

  it("blocks a local-only plan until the model is installed", () => {
    const plan = compileMediaFlow({
      flow: createFlow({
        ...DEFAULT_SETTINGS,
        providerPolicy: "local",
      }),
      models: createMediaModelCatalog({ isOpenAiConfigured: true }),
      compiledAt: "2026-07-14T00:01:00.000Z",
    });

    expect(plan.status).toBe("blocked");
    expect(plan.model?.id).toBe("local:flux-2-klein-4b");
    expect(plan.preflight.requiresModelDownload).toBe(true);
    expect(plan.preflight.estimatedVramGb).toBe(13);
    expect(plan.preflight.estimatedDownloadGb).toBe(14.9);
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({ code: "MODEL_NOT_READY", severity: "error" }),
    );
  });

  it("blocks an installed Diffusers model until its exact runtime is verified", () => {
    const models = createMediaModelCatalog({
      isOpenAiConfigured: false,
      isLocalFluxInstalled: true,
    }).map((model) =>
      model.providerId === "local-diffusers"
        ? { ...model, runtimeReadiness: "unverified" as const }
        : model,
    );
    const plan = compileMediaFlow({
      flow: createFlow({
        ...DEFAULT_SETTINGS,
        providerPolicy: "local",
        modelId: "local:flux-2-klein-4b",
      }),
      models,
      compiledAt: "2026-07-14T00:01:00.000Z",
    });

    expect(plan.status).toBe("blocked");
    expect(plan.preflight.requiresModelDownload).toBe(false);
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "MODEL_NOT_READY",
        message: expect.stringContaining("clean offline runtime verification"),
        action: "Open Models and run Verify model.",
      }),
    );
  });

  it("preserves an incompatible exact model pin and explains the provider boundary conflict", () => {
    const plan = compileMediaFlow({
      flow: createFlow({
        ...DEFAULT_SETTINGS,
        providerPolicy: "local",
        modelId: "openai:gpt-image-2",
      }),
      models: createMediaModelCatalog({ isOpenAiConfigured: true }),
      compiledAt: "2026-07-14T00:01:00.000Z",
    });

    expect(plan.model?.id).toBe("openai:gpt-image-2");
    expect(plan.status).toBe("blocked");
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "PROVIDER_POLICY_UNSATISFIED",
        severity: "error",
        message: expect.stringContaining("conflicts with the local execution boundary"),
      }),
    );
    expect(plan.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "REMOTE_EXECUTION_SELECTED" }),
    );
  });

  it("includes node-registry validation in compiler preflight", () => {
    const source = createFlow();
    const invalid: MediaFlow = {
      ...source,
      nodes: source.nodes.map((node) =>
        node.id === "generate"
          ? { ...node, config: { ...node.config, outputCount: 12 } }
          : node,
      ),
    };
    const plan = compileMediaFlow({
      flow: invalid,
      models: createMediaModelCatalog({ isOpenAiConfigured: true }),
      compiledAt: "2026-07-14T00:01:00.000Z",
    });

    expect(plan.status).toBe("blocked");
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "NODE_SCHEMA_INVALID",
        severity: "error",
        nodeId: "generate",
      }),
    );
  });

  it("allows preview models without lifecycle review while surfacing stale capability snapshots", () => {
    const models = createMediaModelCatalog({ isOpenAiConfigured: true }).map(
      (model) =>
        model.id === "openai:gpt-image-2"
          ? {
              ...model,
              lifecycle: "preview" as const,
              lifecycleCheckedAt: "2026-06-01T00:00:00.000Z",
            }
          : model,
    );
    const plan = compileMediaFlow({
      flow: createFlow(),
      models,
      compiledAt: "2026-07-14T00:01:00.000Z",
    });

    expect(plan.model?.id).toBe("openai:gpt-image-2");
    expect(plan.diagnostics).not.toContainEqual(
      expect.objectContaining({
        code: "MODEL_LIFECYCLE_REVIEW_REQUIRED",
      }),
    );
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "MODEL_LIFECYCLE_STALE",
        severity: "warning",
      }),
    );
  });

  it("fingerprints semantic execution independent of array ordering and labels", () => {
    const flow = createFlow();
    const reordered: MediaFlow = {
      ...flow,
      name: "Renamed in the UI",
      description: "This does not affect execution.",
      updatedAt: "2026-07-14T04:00:00.000Z",
      nodes: [...flow.nodes].reverse(),
      edges: [...flow.edges].reverse(),
    };

    expect(createMediaFlowFingerprint(reordered)).toBe(
      createMediaFlowFingerprint(flow),
    );
    expect(createMediaFlowDocumentDigest(reordered)).not.toBe(
      createMediaFlowDocumentDigest(flow),
    );
    const reorderedPlan = compileMediaFlow({
      flow: reordered,
      models: createMediaModelCatalog({ isOpenAiConfigured: true }),
      compiledAt: "2026-07-14T04:01:00.000Z",
    });
    expect(reorderedPlan.steps.map((step) => step.sourceNodeId)).toEqual([
      "prompt",
      "generate",
      "generate",
      "quality-analyze",
      "quality-gate",
      "asset-output",
    ]);
  });

  it("canonicalizes layout identity independently of position array ordering", () => {
    const layout = createMediaFlowLayout(createFlow());
    const reordered = { ...layout, nodes: [...layout.nodes].reverse() };
    const moved = {
      ...layout,
      nodes: layout.nodes.map((node) =>
        node.nodeId === "generate" ? { ...node, x: node.x + 1 } : node,
      ),
    };

    expect(createMediaFlowLayoutDigest(reordered)).toBe(
      createMediaFlowLayoutDigest(layout),
    );
    expect(createMediaFlowLayoutDigest(moved)).not.toBe(
      createMediaFlowLayoutDigest(layout),
    );
  });

  it("creates a separate deterministic layout document", () => {
    const flow = createFlow({
      ...DEFAULT_SETTINGS,
      transparentBackground: true,
    });
    const layout = createMediaFlowLayout(flow);

    expect(layout.flowId).toBe(flow.id);
    expect(layout.nodes).toHaveLength(flow.nodes.length);
    expect(new Set(layout.nodes.map((node) => node.nodeId)).size).toBe(
      flow.nodes.length,
    );
    expect(layout.groups).toEqual([]);
    expect(layout.comments).toEqual([]);
  });

  it("creates bounded non-overlapping visual groups without affecting execution identity", () => {
    const flow = createFlow();
    const layout = createMediaFlowLayout(flow);
    const executionDigest = createMediaFlowFingerprint(flow);
    const grouped = addMediaFlowLayoutGroup({
      layout,
      nodeIds: ["prompt", "generate", "quality-analyze"],
      label: "Creative generation",
    });

    expect(grouped.groupId).toBe("group-1");
    expect(grouped.layout.groups).toEqual([
      {
        id: "group-1",
        label: "Creative generation",
        color: "cyan",
        collapsed: false,
        nodeIds: ["prompt", "generate", "quality-analyze"],
      },
    ]);
    expect(createMediaFlowLayoutDigest(grouped.layout)).not.toBe(
      createMediaFlowLayoutDigest(layout),
    );
    expect(createMediaFlowFingerprint(flow)).toBe(executionDigest);

    const updated = updateMediaFlowLayoutGroup({
      layout: grouped.layout,
      groupId: grouped.groupId,
      color: "violet",
      collapsed: true,
      label: "Generation chain",
    });
    expect(updated.groups[0]).toMatchObject({
      label: "Generation chain",
      color: "violet",
      collapsed: true,
    });
    expect(() =>
      addMediaFlowLayoutGroup({
        layout: updated,
        nodeIds: ["generate", "asset-output"],
      }),
    ).toThrow("already belongs");
    expect(removeMediaFlowLayoutGroup(updated, grouped.groupId).groups).toEqual([]);
  });

  it("creates revisioned canvas comments without affecting execution identity", () => {
    const flow = createFlow();
    const layout = createMediaFlowLayout(flow);
    const executionDigest = createMediaFlowFingerprint(flow);
    const added = addMediaFlowLayoutComment({
      layout,
      body: "Review edge detail before export",
      x: 120,
      y: 180,
    });

    expect(added.commentId).toBe("comment-1");
    expect(added.layout.comments[0]).toMatchObject({
      body: "Review edge detail before export",
      color: "amber",
      x: 120,
      y: 180,
      width: 240,
      height: 120,
    });
    expect(createMediaFlowLayoutDigest(added.layout)).not.toBe(
      createMediaFlowLayoutDigest(layout),
    );
    expect(createMediaFlowFingerprint(flow)).toBe(executionDigest);

    const updated = updateMediaFlowLayoutComment({
      layout: added.layout,
      commentId: added.commentId,
      body: "Glass edges need human review",
      color: "violet",
      width: 1_000,
      height: 20,
    });
    expect(updated.comments[0]).toMatchObject({
      body: "Glass edges need human review",
      color: "violet",
      width: 600,
      height: 80,
    });
    expect(removeMediaFlowLayoutComment(updated, added.commentId).comments).toEqual([]);
  });
});
