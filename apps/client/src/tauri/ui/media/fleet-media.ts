import type { ProductMedia } from "@machdoch/fleet-protocol";
import {
  compileMediaFlow,
  compileMediaImageOutputBranches,
  createMediaFlowLayout,
} from "../../../core/media/compiler.js";
import { readFlowSubjectCutoutModelPriority } from "../../../core/media/subject-cutout-policy.js";
import type {
  GenerateMediaImagesRequest,
  GenerateMediaSvgRequest,
  ImageRecipeSettings,
  MediaModelDescriptor,
  MediaRunPlanSnapshot,
} from "../../../core/media/contracts.js";
import type { FleetControlCommandEvent } from "../runtime";
import { createBasicMediaRecipeFlow } from "./media-basic-generation";
import { normalizeMediaSubmissionText } from "./media-generation-recipe";
import {
  loadMediaStudioState,
  saveMediaStudioState,
} from "./media-studio-store";
import {
  cancelMediaRun,
  generateMediaImages,
  generateMediaSvg,
  getMediaModelCatalog,
  initializeMediaRuntime,
  listMediaAssets,
  listMediaRuns,
  readMediaAssetPreview,
  saveMediaFlowRevision,
} from "./media-runtime";

const maximumRemotePreviewChars = 120_000;
const remotePreviewCount = 12;
const remoteAssetCount = 48;
const remoteRunCount = 80;
const previewCacheLimit = 64;
const previewCache = new Map<string, string | null>();
let runtimeInitialization: ReturnType<typeof initializeMediaRuntime> | null =
  null;
let fleetMediaOperationError: string | null = null;

export async function loadFleetMediaSnapshot(
  configuredProviderIds: readonly string[],
): Promise<ProductMedia> {
  const runtime = await getFleetMediaRuntime();
  const [state, catalog, assets, runs] = await Promise.all([
    loadMediaStudioState(),
    getMediaModelCatalog(configuredProviderIds),
    listMediaAssets(),
    listMediaRuns(),
  ]);
  const directModelIds = new Set(runtime.directGenerationModelIds);
  const models = catalog.models.flatMap((model) => {
    const targets = remoteTargetsForModel(model);
    if (!targets.length || !directModelIds.has(model.id)) return [];
    return [
      {
        id: model.id,
        label: model.displayName,
        target: model.target,
        targets,
        recommended: model.recommended,
        ...(model.costHint ? { costHint: model.costHint } : {}),
      },
    ];
  });
  const target = state.target === "svg" ? "svg" : "image";
  const availableModels = models.filter((model) =>
    model.targets.includes(target),
  );
  const selectedModel =
    availableModels.find((model) => model.id === state.recipe.modelId) ??
    availableModels.find((model) => model.recommended) ??
    availableModels[0];
  const visibleAssets = assets.slice(0, remoteAssetCount);
  const previews = await loadPreviews(
    visibleAssets.slice(0, remotePreviewCount),
  );

  return {
    loading: false,
    ...(fleetMediaOperationError ? { error: fleetMediaOperationError } : {}),
    runtimeMode: runtime.mode,
    generation: {
      prompt: state.recipe.prompt,
      target,
      ...(selectedModel ? { modelId: selectedModel.id } : {}),
      aspectRatio: state.recipe.aspectRatio,
      outputCount: state.recipe.outputCount,
      outputFormat:
        target === "svg"
          ? "svg"
          : state.recipe.outputFormat === "svg"
            ? "png"
            : state.recipe.outputFormat,
      transparentBackground: state.recipe.transparentBackground,
      available: availableModels.length > 0,
      ...(availableModels.length
        ? {}
        : { unavailableReason: "No ready model supports this media type." }),
    },
    models,
    assets: visibleAssets.map((asset) => ({
      id: asset.id,
      runId: asset.runId,
      kind: asset.kind,
      mimeType: asset.mimeType,
      byteSize: asset.byteSize,
      width: asset.width,
      height: asset.height,
      createdAt: asset.createdAt,
      ...(previews.get(asset.id)
        ? { previewDataUrl: previews.get(asset.id)! }
        : {}),
      tags: asset.tags.slice(0, 8).map((tag) => tag.label),
    })),
    assetCount: assets.length,
    runs: runs.slice(0, remoteRunCount).map((run) => ({
      id: run.id,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      prompt: run.prompt,
      modelLabel: run.modelLabel,
      target: run.target,
      outputCount: run.outputCount,
      progress: run.progress,
      currentStep: run.currentStep,
      ...(run.error ? { error: run.error } : {}),
    })),
    runCount: runs.length,
    busy: runs.some((run) =>
      ["queued", "running", "canceling"].includes(run.status),
    ),
    updatedAt: Date.now(),
  };
}

export function unavailableFleetMediaSnapshot(
  reason: unknown,
  previous?: ProductMedia | null,
): ProductMedia {
  const error = reason instanceof Error ? reason.message : String(reason);
  if (previous) {
    return { ...previous, loading: false, error, updatedAt: Date.now() };
  }
  return {
    loading: false,
    error,
    generation: {
      prompt: "",
      target: "image",
      aspectRatio: "1:1",
      outputCount: 1,
      outputFormat: "png",
      transparentBackground: false,
      available: false,
      unavailableReason: error,
    },
    models: [],
    assets: [],
    assetCount: 0,
    runs: [],
    runCount: 0,
    busy: false,
    updatedAt: Date.now(),
  };
}

export async function executeFleetMediaCommand(
  command: FleetControlCommandEvent,
  configuredProviderIds: readonly string[],
): Promise<void> {
  if (command.kind === "cancel-media-run") {
    if (!command.runId) throw new Error("The media run is unavailable.");
    await cancelMediaRun(command.runId);
    fleetMediaOperationError = null;
    return;
  }
  if (command.kind !== "generate-media") return;
  const input = readGenerationCommand(command);
  const [runtime, state, catalog] = await Promise.all([
    getFleetMediaRuntime(),
    loadMediaStudioState(),
    getMediaModelCatalog(configuredProviderIds),
  ]);
  const model = catalog.models.find((entry) => entry.id === input.modelId);
  if (!model || !remoteTargetsForModel(model).includes(input.target)) {
    throw new Error("The selected media model is unavailable.");
  }
  if (!runtime.directGenerationModelIds.includes(model.id)) {
    throw new Error("The selected media model is not ready.");
  }

  const submittedRecipe: ImageRecipeSettings = {
    ...state.recipe,
    prompt: input.prompt,
    providerPolicy: model.target,
    modelId: model.id,
    aspectRatio: input.aspectRatio,
    outputCount: input.outputCount,
    outputFormat: input.target === "svg" ? "svg" : input.outputFormat,
    transparentBackground: input.transparentBackground,
    qualityGateEnabled: false,
    referenceImages: [],
    baseImageAssetId: null,
    poseImageAssetId: null,
    editMask: null,
    modelAddons: [],
    svgMode: "generate",
  };
  const createdAt = new Date().toISOString();
  const flowId = boundedId(`fleet-media-${command.commandId}`);
  const flow = createBasicMediaRecipeFlow({
    id: flowId,
    createdAt,
    target: input.target,
    settings: submittedRecipe,
    models: catalog.models,
  });
  const layout = createMediaFlowLayout(flow);
  const plan = compileMediaFlow({
    flow,
    models: catalog.models,
    addons: catalog.addons,
    compiledAt: createdAt,
  });
  if (plan.status !== "ready" || !plan.model) {
    throw new Error(
      plan.diagnostics.find((diagnostic) => diagnostic.severity === "error")
        ?.message ?? "The media recipe is not ready.",
    );
  }
  const revision = await saveMediaFlowRevision({
    schemaVersion: 1,
    idempotencyKey: boundedId(`fleet-revision-${command.commandId}`),
    expectedHeadRevisionId: null,
    changeSummary: "Generated from Fleet",
    flow,
    layout,
  });
  await saveMediaStudioState({
    ...state,
    activeSection: "runs",
    target: input.target,
    recipe: submittedRecipe,
  });
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
  fleetMediaOperationError = null;
  const run =
    input.target === "svg"
      ? () =>
          generateMediaSvg(
            createSvgRequest({
              command,
              flowId,
              revisionId: revision.revision.revisionId,
              planSnapshot,
              plan,
              model,
              recipe: submittedRecipe,
            }),
          )
      : () =>
          generateMediaImages(
            createImageRequest({
              command,
              flowId,
              revisionId: revision.revision.revisionId,
              planSnapshot,
              plan,
              model,
              recipe: submittedRecipe,
              flow,
            }),
          );
  void run().catch((error: unknown) => {
    fleetMediaOperationError =
      error instanceof Error ? error.message : String(error);
  });
}

function readGenerationCommand(command: FleetControlCommandEvent): {
  prompt: string;
  target: "image" | "svg";
  modelId: string;
  aspectRatio: "1:1" | "4:5" | "16:9" | "9:16";
  outputCount: number;
  outputFormat: "png" | "jpeg" | "webp";
  transparentBackground: boolean;
} {
  const prompt = normalizeMediaSubmissionText(command.prompt ?? "");
  if (
    !prompt ||
    !command.modelId ||
    !command.target ||
    !command.aspectRatio ||
    !command.outputCount ||
    !command.outputFormat ||
    typeof command.transparentBackground !== "boolean"
  ) {
    throw new Error("The media recipe is incomplete.");
  }
  const outputFormat =
    command.outputFormat === "jpeg" || command.outputFormat === "webp"
      ? command.outputFormat
      : "png";
  return {
    prompt,
    target: command.target,
    modelId: command.modelId,
    aspectRatio: command.aspectRatio,
    outputCount: command.outputCount,
    outputFormat,
    transparentBackground: command.transparentBackground,
  };
}

function remoteTargetsForModel(
  model: MediaModelDescriptor,
): Array<"image" | "svg"> {
  const targets: Array<"image" | "svg"> = [];
  if (model.capabilities.includes("text-to-image")) targets.push("image");
  if (model.capabilities.includes("text-to-svg")) targets.push("svg");
  return targets;
}

async function loadPreviews(
  assets: Awaited<ReturnType<typeof listMediaAssets>>,
): Promise<Map<string, string | null>> {
  const previews = await Promise.all(
    assets.map(async (asset) => {
      if (asset.kind !== "image" && asset.kind !== "vector") {
        return [asset.id, null] as const;
      }
      const cacheKey = `${asset.id}:${asset.digest}`;
      if (!previewCache.has(cacheKey)) {
        try {
          const dataUrl = await blobToDataUrl(
            await readMediaAssetPreview(asset, 192),
          );
          cachePreview(
            cacheKey,
            dataUrl.length <= maximumRemotePreviewChars ? dataUrl : null,
          );
        } catch {
          cachePreview(cacheKey, null);
        }
      }
      return [asset.id, previewCache.get(cacheKey) ?? null] as const;
    }),
  );
  return new Map(previews);
}

function getFleetMediaRuntime(): ReturnType<typeof initializeMediaRuntime> {
  runtimeInitialization ??= initializeMediaRuntime().catch((error) => {
    runtimeInitialization = null;
    throw error;
  });
  return runtimeInitialization;
}

function cachePreview(key: string, value: string | null): void {
  previewCache.set(key, value);
  while (previewCache.size > previewCacheLimit) {
    const oldestKey = previewCache.keys().next().value;
    if (typeof oldestKey !== "string") return;
    previewCache.delete(oldestKey);
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Media preview could not be encoded.")),
    );
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("Media preview could not be encoded.")),
    );
    reader.readAsDataURL(blob);
  });
}

function createImageRequest(input: {
  command: FleetControlCommandEvent;
  flowId: string;
  revisionId: string;
  planSnapshot: MediaRunPlanSnapshot;
  plan: ReturnType<typeof compileMediaFlow>;
  model: MediaModelDescriptor;
  recipe: ImageRecipeSettings;
  flow: ReturnType<typeof createBasicMediaRecipeFlow>;
}): GenerateMediaImagesRequest {
  return {
    schemaVersion: 1,
    runId: input.command.commandId,
    flowId: input.flowId,
    flowRevisionId: input.revisionId,
    flowName: input.flow.name,
    planId: input.plan.id,
    prompt: input.recipe.prompt,
    modelId: input.model.id,
    modelLabel: input.model.displayName,
    outputCount: input.plan.preflight.generatedCandidates,
    diagnosticCount: input.plan.diagnostics.length,
    aspectRatio: input.recipe.aspectRatio,
    outputFormat:
      input.recipe.outputFormat === "svg" ? "png" : input.recipe.outputFormat,
    modelPolicy: input.recipe.modelPolicy,
    modelAddons: [],
    transparentBackground: input.recipe.transparentBackground,
    subjectCutoutModelPriority: readFlowSubjectCutoutModelPriority(input.flow),
    negativePrompt: "",
    referenceImages: [],
    baseImageAssetId: null,
    editMask: null,
    poseImageAssetId: null,
    poseStrength: null,
    poseStart: null,
    poseEnd: null,
    seed: input.recipe.seed ?? null,
    memoryProfile: input.recipe.memoryProfile ?? "auto",
    outputBranches: compileMediaImageOutputBranches(input.flow),
    planSnapshot: input.planSnapshot,
  };
}

function createSvgRequest(input: {
  command: FleetControlCommandEvent;
  flowId: string;
  revisionId: string;
  planSnapshot: MediaRunPlanSnapshot;
  plan: ReturnType<typeof compileMediaFlow>;
  model: MediaModelDescriptor;
  recipe: ImageRecipeSettings;
}): GenerateMediaSvgRequest {
  return {
    schemaVersion: 1,
    runId: input.command.commandId,
    flowId: input.flowId,
    flowRevisionId: input.revisionId,
    flowName: "Fleet SVG",
    planId: input.plan.id,
    prompt: input.recipe.prompt,
    modelId: input.model.id,
    modelLabel: input.model.displayName,
    outputCount: input.plan.preflight.generatedCandidates,
    candidateCount: Math.max(
      input.recipe.outputCount,
      Math.min(
        input.model.id.startsWith("recraft:") ? 6 : 16,
        input.recipe.svgCandidateCount ?? 6,
      ),
    ),
    diagnosticCount: input.plan.diagnostics.length,
    aspectRatio: input.recipe.aspectRatio,
    modelPolicy: input.recipe.modelPolicy,
    transparentBackground: input.recipe.transparentBackground,
    mode: "generate",
    autoCrop: input.recipe.svgAutoCrop !== false,
    targetSize: input.recipe.svgTargetSize ?? 1024,
    style: input.recipe.svgStyle ?? "illustration",
    textPolicy: input.recipe.svgTextPolicy ?? "avoid",
    criticEnabled:
      input.model.target === "remote" &&
      input.recipe.modelPolicy === "quality" &&
      input.recipe.svgCriticEnabled === true,
    referenceImages: [],
    allowRemoteUpload: false,
    planSnapshot: input.planSnapshot,
  };
}

function boundedId(value: string): string {
  return value.slice(0, 128);
}
