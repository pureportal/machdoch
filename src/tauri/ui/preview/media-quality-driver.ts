import { invoke } from "@tauri-apps/api/core";
import { compileMediaFlow } from "../../../core/media/compiler.js";
import { extendMediaCatalogWithWorkspaceDiscovery } from "../../../core/media/discovered-model-profiles.js";
import type {
  MediaFlowHistory,
  MediaImageImportResult,
  MediaModelCatalogSnapshot,
  MediaRunDetail,
  MediaRunPlanSnapshot,
  MediaRuntimeStatus,
  MediaWorkspaceModelDiscovery,
  SaveMediaFlowRevisionResult,
} from "../../../core/media/contracts.js";

const workspaceRoot = "C:\\Development\\machdoch";
const witchFlowId = "flow:anime-witch-production-spellcast-v2";
const generalVideoFlowId =
  "media-video-c69a40a7-5e08-4910-bac7-aed99905a81c";
const dogLoraImageFlowId = "flow:e2e-final-flux-dog-lora";
const dogLoraImageAssetId = "asset:run:e2e-final-flux-dog-lora-v1:0";
const framePackModelId = "local:framepack-i2v-hy-13b";
const hunyuanVideoModelId =
  "local:hunyuan-video-1.5-i2v-step-distilled";

const startVideoQualityRun = async ({
  flowId,
  modelId,
  runLabel,
  prompt,
  sameEndpoint,
  sourceAssetId,
  lastSourceAssetId = null,
  transparentBackground,
  guidanceScale,
  seed,
  numFrames,
  numInferenceSteps,
  resolution,
  aspectRatio = "16:9",
  fps = 16,
  loopMode = "none",
  negativePrompt = null,
}: {
  flowId: string;
  modelId: string;
  runLabel: string;
  prompt: string | null;
  sameEndpoint: boolean;
  sourceAssetId: string | null;
  lastSourceAssetId?: string | null;
  transparentBackground: boolean;
  guidanceScale: number;
  seed: number;
  numFrames: number;
  numInferenceSteps: number;
  resolution: string;
  aspectRatio?: string;
  fps?: number;
  loopMode?: "none" | "seamless";
  negativePrompt?: string | null;
},
): Promise<{
  runId: string;
  revisionId: string;
  planId: string;
  modelLabel: string;
}> => {
  const [history, catalog, discovery, runtimeStatus] = await Promise.all([
    invoke<MediaFlowHistory>("media_get_flow", { flowId }),
    invoke<MediaModelCatalogSnapshot>("media_get_model_catalog", {
      configuredProviderIds: [],
    }),
    invoke<MediaWorkspaceModelDiscovery>("media_discover_workspace_models", {
      workspaceRoot,
    }),
    invoke<MediaRuntimeStatus>("media_initialize_runtime"),
  ]);
  const activeCatalog = extendMediaCatalogWithWorkspaceDiscovery({
    catalog,
    discovery,
    runtime: runtimeStatus.localDiffusers,
  });
  const model = activeCatalog.models.find((candidate) => candidate.id === modelId);
  if (!model?.configured || model.runtimeReadiness !== "ready") {
    throw new Error(
      model?.runtimeReadinessDiagnostic ??
        `The ${runLabel} profile is not ready.`,
    );
  }
  const head = history.revisions.find((revision) => revision.isHead);
  if (!head) {
    throw new Error("The witch comparison flow has no saved head revision.");
  }
  const flow = structuredClone(head.flow);
  const videoNode = flow.nodes.find((node) => node.type === "task.generate-video");
  if (!videoNode) {
    throw new Error("The comparison flow has no video generation node.");
  }
  const firstFrameEdge = flow.edges.find(
    (edge) =>
      edge.toNodeId === videoNode.id && edge.toPortId === "first-frame",
  );
  const lastFrameEdge = flow.edges.find(
    (edge) =>
      edge.toNodeId === videoNode.id && edge.toPortId === "last-frame",
  );
  const firstFrame = flow.nodes.find(
    (node) =>
      node.id === firstFrameEdge?.fromNodeId && node.type === "source.image",
  );
  const lastFrame = flow.nodes.find(
    (node) =>
      node.id === lastFrameEdge?.fromNodeId && node.type === "source.image",
  );
  if (
    typeof firstFrame?.config.assetId !== "string" ||
    typeof lastFrame?.config.assetId !== "string"
  ) {
    throw new Error("The immutable endpoint assets are unavailable.");
  }
  if (sourceAssetId) {
    firstFrame.config = { ...firstFrame.config, assetId: sourceAssetId };
    lastFrame.config = {
      ...lastFrame.config,
      assetId: lastSourceAssetId ?? sourceAssetId,
    };
  }
  if (sameEndpoint) {
    lastFrame.config = {
      ...lastFrame.config,
      assetId: firstFrame.config.assetId,
    };
  }
  const promptNode = flow.nodes.find(
    (node) => node.type === "source.prompt",
  );
  if (prompt && promptNode) {
    promptNode.config = { ...promptNode.config, prompt };
  }
  const {
    durationSeconds: _legacyDurationSeconds,
    ...videoConfig
  } = videoNode.config;
  videoNode.config = {
    ...videoConfig,
    modelId,
    modelPolicy: "quality",
    aspectRatio,
    resolution,
    fps,
    numFrames,
    numInferenceSteps,
    guidanceScale,
    seed,
    memoryProfile: "auto",
    loopMode,
    transparentBackground,
    matteQuality: "production",
    encodingQuality: "lossless",
    ...(negativePrompt === null ? {} : { negativePrompt }),
  };
  flow.nodes
    .filter((node) => node.type === "output.video")
    .forEach((node) => {
      node.config = {
        ...node.config,
        role: transparentBackground ? "transparent" : "opaque",
      };
    });
  const compiledAt = new Date().toISOString();
  flow.updatedAt = compiledAt;
  const plan = compileMediaFlow({
    flow,
    models: activeCatalog.models,
    addons: activeCatalog.addons,
    compiledAt,
  });
  if (plan.status !== "ready") {
    throw new Error(
      plan.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    );
  }
  const planSnapshot: MediaRunPlanSnapshot = {
    schemaVersion: 1,
    planId: plan.id,
    flowId: flow.id,
    flowFingerprint: plan.flowFingerprint,
    compiledAt: plan.compiledAt,
    nodes: flow.nodes.map(({ id, type, label, layer }) => ({
      id,
      type,
      label,
      layer,
    })),
    steps: plan.steps.map((step) => ({ ...step })),
  };
  const revision = await invoke<SaveMediaFlowRevisionResult>(
    "media_save_flow_revision",
    {
      request: {
        schemaVersion: 1,
        idempotencyKey: `quality-video-revision-${crypto.randomUUID()}`,
        expectedHeadRevisionId: head.revisionId,
        changeSummary: `${runLabel} comparison with ${numFrames} frames, ${numInferenceSteps} requested steps, isolated component lifecycles, and adaptive CPU block offload`,
        flow,
        layout: head.layout,
      },
    },
  );
  const animatedBackgroundNode = flow.nodes.find(
    (node) => node.type === "source.animated-background",
  );
  const runId = `run:${runLabel
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")}-${crypto.randomUUID()}`;
  const request = {
    schemaVersion: 1,
    runId,
    flowId: flow.id,
    flowRevisionId: revision.revision.revisionId,
    flowName: flow.name,
    planId: plan.id,
    prompt: String(
      flow.nodes.find((node) => node.type === "source.prompt")?.config.prompt ??
        "",
    ),
    modelId,
    modelLabel: model.displayName,
    diagnosticCount: plan.diagnostics.length,
    workspaceRoot,
    firstFrameAssetId: firstFrame.config.assetId,
    lastFrameAssetId: lastFrame.config.assetId,
    aspectRatio,
    resolution,
    outputFormat: "webm",
    transparentBackground,
    loopMode,
    fps,
    numFrames,
    numInferenceSteps,
    guidanceScale,
    seed,
    negativePrompt: String(
      negativePrompt ?? videoNode.config.negativePrompt ?? "",
    ),
    matteQuality: "production",
    encodingQuality: "lossless",
    memoryProfile: "auto",
    experimentalLowMemory: true,
    animatedBackground: transparentBackground && animatedBackgroundNode
      ? {
          style: String(animatedBackgroundNode.config.style),
          direction: String(animatedBackgroundNode.config.direction),
          colorStart: String(animatedBackgroundNode.config.colorStart),
          colorEnd: String(animatedBackgroundNode.config.colorEnd),
          cycles: Number(animatedBackgroundNode.config.cycles),
        }
      : null,
    planSnapshot,
  };
  const run = invoke<MediaRunDetail>("media_generate_video", { request });
  Object.assign(window, {
    __machdochQualityRun: run,
    __machdochQualityRunId: runId,
    __machdochQualityRunResult: null,
    __machdochQualityRunError: null,
  });
  void run.then(
    (detail) => {
      Object.assign(window, { __machdochQualityRunResult: detail });
    },
    (error: unknown) => {
      Object.assign(window, {
        __machdochQualityRunError:
          error instanceof Error ? error.message : String(error),
      });
    },
  );
  return {
    runId,
    revisionId: revision.revision.revisionId,
    planId: plan.id,
    modelLabel: model.displayName,
  };
};

export const startAnimationIterationRun = async ({
  sourcePath,
  lastSourcePath,
  runLabel,
  prompt,
  negativePrompt,
  modelId = hunyuanVideoModelId,
  aspectRatio,
  resolution,
  fps,
  numFrames,
  numInferenceSteps,
  guidanceScale,
  seed,
  loopMode,
}: {
  sourcePath: string;
  lastSourcePath?: string;
  runLabel: string;
  prompt: string;
  negativePrompt: string;
  modelId?: string;
  aspectRatio: string;
  resolution: string;
  fps: number;
  numFrames: number;
  numInferenceSteps: number;
  guidanceScale: number;
  seed: number;
  loopMode: "none" | "seamless";
}) => {
  const imported = await invoke<MediaImageImportResult>(
    "media_import_image",
    { path: sourcePath },
  );
  const importedLast = lastSourcePath
    ? await invoke<MediaImageImportResult>(
        "media_import_image",
        { path: lastSourcePath },
      )
    : null;
  const run = await startVideoQualityRun({
    flowId: generalVideoFlowId,
    modelId,
    runLabel,
    prompt,
    sameEndpoint: importedLast === null,
    sourceAssetId: imported.asset.id,
    lastSourceAssetId: importedLast?.asset.id,
    transparentBackground: false,
    guidanceScale,
    seed,
    numFrames,
    numInferenceSteps,
    resolution,
    aspectRatio,
    fps,
    loopMode,
    negativePrompt,
  });
  return {
    ...run,
    sourceAssetId: imported.asset.id,
    sourceDeduplicated: imported.deduplicated,
    lastSourceAssetId: importedLast?.asset.id ?? imported.asset.id,
    lastSourceDeduplicated:
      importedLast?.deduplicated ?? imported.deduplicated,
  };
};

export const startWitchFramePackQualityRun = async (
  seed = 72_526_021,
  numFrames = 33,
  numInferenceSteps = 30,
  resolution = "quality-640",
) =>
  startVideoQualityRun({
    flowId: witchFlowId,
    modelId: framePackModelId,
    runLabel: "FramePack quality",
    prompt: null,
    sameEndpoint: false,
    sourceAssetId: null,
    transparentBackground: true,
    guidanceScale: 9,
    seed,
    numFrames,
    numInferenceSteps,
    resolution,
  });

export const startWitchHunyuanQualityRun = async (
  seed = 72_526_021,
  numFrames = 33,
  numInferenceSteps = 12,
  resolution = "quality-640",
) =>
  startVideoQualityRun({
    flowId: witchFlowId,
    modelId: hunyuanVideoModelId,
    runLabel: "HunyuanVideo 1.5 quality",
    prompt: [
      "The witch takes two deliberate steps forward and casts a spell",
      "her right arm sweeps continuously from her side to full forward extension",
      "her left hand and torso balance the motion",
      "her robe and hair react naturally",
      "full body remains centered with consistent anatomy",
      "locked camera",
    ].join(", "),
    sameEndpoint: true,
    sourceAssetId: null,
    transparentBackground: true,
    guidanceScale: 1,
    seed,
    numFrames,
    numInferenceSteps,
    resolution,
  });

export const startGeneralHunyuanQualityRun = async (
  seed = 72_526_023,
  numFrames = 17,
  numInferenceSteps = 8,
  resolution = "preview-512",
  sourceAssetId = dogLoraImageAssetId,
) =>
  startVideoQualityRun({
    flowId: generalVideoFlowId,
    modelId: hunyuanVideoModelId,
    runLabel: "HunyuanVideo 1.5 general motion",
    prompt: [
      "A friendly golden retriever in a clean photography studio",
      "turns its head toward the camera",
      "raises one front paw",
      "and wags its tail in one smooth continuous action",
      "natural animal anatomy",
      "stable studio background",
      "locked camera",
    ].join(", "),
    sameEndpoint: true,
    sourceAssetId,
    transparentBackground: false,
    guidanceScale: 1,
    seed,
    numFrames,
    numInferenceSteps,
    resolution,
  });

export const startDogLoraImageQualityRun = async (): Promise<{
  runId: string;
  revisionId: string;
  planId: string;
  modelLabel: string;
}> => {
  const [history, catalog, discovery, runtimeStatus] = await Promise.all([
    invoke<MediaFlowHistory>("media_get_flow", {
      flowId: dogLoraImageFlowId,
    }),
    invoke<MediaModelCatalogSnapshot>("media_get_model_catalog", {
      configuredProviderIds: [],
    }),
    invoke<MediaWorkspaceModelDiscovery>("media_discover_workspace_models", {
      workspaceRoot,
    }),
    invoke<MediaRuntimeStatus>("media_initialize_runtime"),
  ]);
  const activeCatalog = extendMediaCatalogWithWorkspaceDiscovery({
    catalog,
    discovery,
    runtime: runtimeStatus.localDiffusers,
  });
  const head = history.revisions.find((revision) => revision.isHead);
  if (!head) {
    throw new Error("The dog LoRA comparison flow has no saved head revision.");
  }
  const flow = structuredClone(head.flow);
  const promptNode = flow.nodes.find(
    (node) => node.type === "source.prompt",
  );
  const imageNode = flow.nodes.find(
    (node) => node.type === "task.generate-image",
  );
  if (!promptNode || !imageNode) {
    throw new Error("The dog LoRA comparison flow is incomplete.");
  }
  const modelId = String(imageNode.config.modelId ?? "");
  const model = activeCatalog.models.find((candidate) => candidate.id === modelId);
  if (!model?.configured || model.runtimeReadiness !== "ready") {
    throw new Error(
      model?.runtimeReadinessDiagnostic ??
        "The dog LoRA image model is not ready.",
    );
  }
  const compiledAt = new Date().toISOString();
  const plan = compileMediaFlow({
    flow,
    models: activeCatalog.models,
    addons: activeCatalog.addons,
    compiledAt,
  });
  if (plan.status !== "ready") {
    throw new Error(
      plan.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    );
  }
  const planSnapshot: MediaRunPlanSnapshot = {
    schemaVersion: 1,
    planId: plan.id,
    flowId: flow.id,
    flowFingerprint: plan.flowFingerprint,
    compiledAt: plan.compiledAt,
    nodes: flow.nodes.map(({ id, type, label, layer }) => ({
      id,
      type,
      label,
      layer,
    })),
    steps: plan.steps.map((step) => ({ ...step })),
  };
  const revision = await invoke<SaveMediaFlowRevisionResult>(
    "media_save_flow_revision",
    {
      request: {
        schemaVersion: 1,
        idempotencyKey: `quality-image-revision-${crypto.randomUUID()}`,
        expectedHeadRevisionId: head.revisionId,
        changeSummary:
          "Re-verified FLUX.2 dog LoRA generation with the current runtime and explicit automatic memory policy",
        flow,
        layout: head.layout,
      },
    },
  );
  const runId = `run:flux-dog-lora-quality-${crypto.randomUUID()}`;
  const run = invoke<MediaRunDetail>("media_generate_images", {
    request: {
      schemaVersion: 1,
      runId,
      flowId: flow.id,
      flowRevisionId: revision.revision.revisionId,
      flowName: flow.name,
      planId: plan.id,
      prompt: String(promptNode.config.prompt ?? ""),
      modelId,
      modelLabel: model.displayName,
      outputCount: Number(imageNode.config.outputCount ?? 1),
      diagnosticCount: plan.diagnostics.length,
      aspectRatio: String(imageNode.config.aspectRatio ?? "1:1"),
      outputFormat: String(imageNode.config.outputFormat ?? "png"),
      modelPolicy: String(imageNode.config.modelPolicy ?? "fast"),
      modelAddons: Array.isArray(imageNode.config.modelAddons)
        ? imageNode.config.modelAddons
        : [],
      transparentBackground: Boolean(
        imageNode.config.transparentBackground,
      ),
      subjectCutoutModelPriority: [],
      negativePrompt: String(imageNode.config.negativePrompt ?? ""),
      memoryProfile: "auto",
      planSnapshot,
    },
  });
  Object.assign(window, {
    __machdochImageQualityRun: run,
    __machdochImageQualityRunId: runId,
    __machdochImageQualityRunResult: null,
    __machdochImageQualityRunError: null,
  });
  void run.then(
    (detail) => {
      Object.assign(window, { __machdochImageQualityRunResult: detail });
    },
    (error: unknown) => {
      Object.assign(window, {
        __machdochImageQualityRunError:
          error instanceof Error ? error.message : String(error),
      });
    },
  );
  return {
    runId,
    revisionId: revision.revision.revisionId,
    planId: plan.id,
    modelLabel: model.displayName,
  };
};
