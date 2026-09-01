import { MediaStudioNavigation } from "@machdoch/product-ui";
import {
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
} from "react";
import { createMediaModelCatalogSnapshot } from "../../../core/media/catalog.js";
import { applyMediaAssetMetadataToAddon } from "../../../core/media/asset-metadata.js";
import type { MediaAssetImportProgress } from "../../../core/media/asset-import.js";
import { extendMediaCatalogWithWorkspaceDiscovery } from "../../../core/media/discovered-model-profiles.js";
import {
  hasMediaImageMaskContent,
  normalizeMediaImageMask,
} from "../../../core/media/image-mask.js";
import { createMediaModelAddonSelection } from "../../../core/media/model-addons.js";
import { getMediaModelPrimaryGenerationTarget } from "../../../core/media/model-library.js";
import {
  createMediaFlowDocumentDigest,
  createMediaFlowFingerprint,
  createMediaFlowLayoutDigest,
} from "../../../core/media/canonicalize.js";
import {
  compileMediaFlow,
  compileMediaImageOutputBranches,
  createGeneratedLoopVideoFlow,
  createImageRecipeFlow,
  createImageToVideoFlow,
  createMediaFlowLayout,
  readImageRecipeSettings,
  reconcileMediaFlowLayout,
} from "../../../core/media/compiler.js";
import {
  addMediaFlowNode,
  connectMediaFlowPorts,
  copyMediaFlowNode,
  copyMediaFlowNodes,
  disconnectMediaFlowConnection,
  disconnectMediaFlowInput,
  inspectMediaFlowNodePaste,
  pasteMediaFlowNode,
  removeMediaFlowNode,
  updateMediaFlowNodeConfig,
  updateMediaFlowNodeConfigs,
  updateMediaFlowNodeLabel,
  type MediaFlowConnectionRequest,
  type MediaFlowNodeClipboardPayload,
} from "../../../core/media/node-registry.js";
import { resolveMediaFlowVariables } from "../../../core/media/variables.js";
import { readFlowSubjectCutoutModelPriority } from "../../../core/media/subject-cutout-policy.js";
import {
  inferMediaVideoAspectRatio,
  isMediaAssetKnownTransparent,
  resolveMediaVideoExecutionSettings,
  type MediaVideoAspectRatio,
  type MediaVideoLoopMode,
} from "../../../core/media/video-quality.js";
import type {
  ExecuteLocalImageFlowRequest,
  ExecuteRemoteImageEditFlowRequest,
  GenerateMediaImagesRequest,
  GenerateMediaVideoRequest,
  GenerateMediaSvgRequest,
  ImageRecipeSettings,
  ImportMediaLocalModelRequest,
  ImportMediaModelAddonRequest,
  MediaAssetRecord,
  MediaAssetCategory,
  MediaAssetTagUpdate,
  MediaErrorAction,
  MediaErrorDetail,
  MediaFlow,
  MediaFlowHead,
  MediaFlowHistory,
  MediaFlowImportInspection,
  InstantiateMediaFlowTemplateResult,
  MediaFlowLayout,
  MediaFlowRevision,
  MediaHumanReviewDecisionRequest,
  MediaImageOutputBranch,
  MediaLocalModelImportInspection,
  MediaModelAddonImportInspection,
  MediaCivitaiModelAddonInspection,
  MediaCompiledPlan,
  MediaModelCatalogSnapshot,
  MediaModelDescriptor,
  MediaNodeType,
  MediaProviderReviewAction,
  MediaGenerationAssetMetadata,
  MediaGenerationTarget,
  MediaRunDetail,
  MediaRunRecord,
  MediaRunPlanSnapshot,
  MediaRuntimeRunRecord,
  MediaRuntimeStatus,
  MediaStudioSection,
  MediaStudioState,
  MediaVideoRecipeSettings,
  MediaWorkspaceModelDiscovery,
} from "../../../core/media/contracts.js";
import { getDefaultCommandShortcut } from "../commands/command-defaults";
import { useOptionalRegisterCommands } from "../commands/command-context";
import type { CommandDefinition } from "../commands/command-types";
import {
  subscribeToUserSettingsChanged,
  type RuntimeProviderAvailability,
} from "../runtime";
import { MediaFlowView } from "./components/media-flow-view";
import { MediaErrorNotice } from "./components/media-error-notice";
import { MediaGenerateView } from "./components/media-generate-view";
import { MediaAssetsView } from "./components/media-assets-view";
import { MediaRunsView } from "./components/media-runs-view";
import {
  createBasicMediaRecipeFlow,
  createBasicVideoDraftFromImage,
} from "./media-basic-generation";
import {
  DEFAULT_MEDIA_STUDIO_STATE,
  loadMediaStudioState,
  normalizeMediaStudioState,
  saveMediaStudioState,
} from "./media-studio-store";
import {
  MediaGenerationQueue,
  type MediaGenerationQueueJob,
  type MediaGenerationRecipeSnapshot,
} from "./media-generation-queue";
import {
  countMediaImageRecipeOutputs,
  normalizeMediaFlowForPersistence,
  normalizeMediaFlowLayoutForPersistence,
  normalizeMediaSubmissionText,
  readMediaFlowImageSettings,
  readMediaFlowPrompt,
  readMediaGenerationTarget,
  readMediaVideoRecipeSettings,
} from "./media-generation-recipe";
import {
  cancelMediaRun,
  deleteMediaAsset,
  discoverMediaWorkspaceModels,
  executeMediaLocalImageFlow,
  executeMediaRemoteImageEditFlow,
  exportMediaFlowRevision,
  getMediaRunDetail,
  getMediaFlow,
  getMediaModelCatalog,
  generateMediaImages,
  generateMediaVideo,
  generateMediaSvg,
  initializeMediaRuntime,
  inspectMediaLocalModel,
  inspectMediaModelAddon,
  inspectMediaCivitaiModelAddon,
  importMediaAsset,
  importMediaAssetFromUrl,
  importMediaFlow,
  importMediaLocalModel,
  importMediaModelAddon,
  inspectMediaFlowImport,
  listMediaFlows,
  listMediaAssets,
  listMediaRuns,
  planMediaAssetDeletion,
  probeMediaLocalModel,
  refreshMediaLocalDiffusersRuntime,
  retryMediaFixtureRun,
  resolveMediaHumanReview,
  resolveMediaProviderReview,
  saveMediaFlowRevision,
  setMediaAssetTags,
  supportsNativeMediaImport,
  supportsNativeMediaFlowPortability,
  supportsNativeMediaModelImport,
  supportsNativeMediaModelAddonImport,
  subscribeToMediaImportProgress,
  normalizeMediaError,
} from "./media-runtime";

const EXECUTABLE_LOCAL_VIDEO_MODEL_IDS: ReadonlySet<string> = new Set([
  "local:framepack-i2v-hy-13b",
  "local:hunyuan-video-1.5-i2v-step-distilled",
  "local:ltx-video-0.9.8-13b-distilled-fp8",
  "local:ltx-video-0.9.8-2b-distilled-fp8",
  "local:wan2.2-ti2v-5b",
]);

const isExecutableLocalVideoModelId = (
  modelId: string,
): modelId is GenerateMediaVideoRequest["modelId"] =>
  EXECUTABLE_LOCAL_VIDEO_MODEL_IDS.has(modelId);

const generationQueue = new MediaGenerationQueue({
  readRunDetail: getMediaRunDetail,
  cancelRun: cancelMediaRun,
});

const createIdentityImageOutputBranch = (
  format: MediaImageOutputBranch["format"],
  outputNodeId: string,
): MediaImageOutputBranch => ({
  id: outputNodeId,
  outputNodeId,
  format,
  quality: 95,
  jpegBackground: "#ffffff",
  operations: [],
});

interface MediaStudioProps {
  providerStatuses: readonly RuntimeProviderAvailability[];
  onOpenProviderSettings: () => void;
  workspaceRoot: string | null;
  openRunId?: string | null;
  onOpenRunHandled?: () => void;
  openSection?: MediaStudioSection | null;
  onOpenSectionHandled?: () => void;
  openAssetId?: string | null;
  onOpenAssetHandled?: () => void;
  importPath?: string | null;
  onImportPathHandled?: () => void;
  draftPrompt?: string | null;
  onDraftPromptHandled?: () => void;
}

const NAVIGATION_ITEMS: readonly {
  id: MediaStudioSection;
  label: string;
}[] = [
  { id: "generate", label: "Basic" },
  { id: "flow", label: "Advanced" },
  { id: "library", label: "Assets" },
  { id: "runs", label: "Activity" },
] as const;

const readImportError = (error: unknown, fallback: string): string => {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.trim();
  return message && message !== "Media Studio could not complete the operation."
    ? message
    : fallback;
};

const readAssetImportError = (failure: MediaErrorDetail): string => {
  const diagnostic = failure.technicalDiagnostic.toLocaleLowerCase();
  if (diagnostic.includes("ffprobe is required")) {
    return "Install ffprobe and restart Machdoch to import WebM files.";
  }
  if (diagnostic.includes("webm")) {
    return "Select a valid WebM file using VP8, VP9, or AV1 video.";
  }
  if (diagnostic.includes("svg")) {
    return "Select an SVG without scripts or external resources.";
  }
  if (
    diagnostic.includes("image") ||
    diagnostic.includes("png") ||
    diagnostic.includes("jpeg") ||
    diagnostic.includes("webp")
  ) {
    return "Select a valid still PNG, JPEG, or WebP image.";
  }
  return "Select a valid PNG, JPEG, WebP, SVG, or WebM file.";
};

const createRunId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `media-run-${Date.now().toString(36)}`;
};

const createFlowSaveId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `media-flow-save-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
};

const generationJobToRunDetail = (
  job: MediaGenerationQueueJob,
): MediaRunDetail => ({
  id: job.runId,
  flowId: job.recipe.flowId,
  flowRevisionId: job.recipe.flowRevisionId,
  flowName: job.recipe.flowName,
  planId: job.recipe.planId,
  status: job.status,
  createdAt: job.submittedAt,
  updatedAt: job.completedAt ?? job.startedAt ?? job.submittedAt,
  prompt: job.recipe.prompt,
  modelLabel: job.recipe.modelLabel,
  target:
    job.recipe.modelId === null
      ? null
      : job.recipe.modelId.startsWith("local:")
        ? "local"
        : "remote",
  outputCount: job.recipe.imageSettings
    ? countMediaImageRecipeOutputs(
        job.recipe.imageSettings,
        job.recipe.outputBranches,
      )
    : 1,
  diagnosticCount: 0,
  progress: job.progress,
  currentStep: job.currentStep,
  executor:
    job.recipe.target === "video"
      ? "local-video"
      : job.recipe.target === "svg"
        ? "svg-ai-pipeline"
        : job.recipe.modelId?.startsWith("openai:")
          ? "openai-image-api"
          : job.recipe.modelId
            ? "local-image-flow"
            : "local-analysis",
  error: job.error,
  failure: job.failure,
  events: [],
  assets: [...job.assets],
  providerJobs: [],
  humanReviews: [],
  nodeExecutions: [],
  planSnapshot: null,
});

const recipeSnapshotFromRevision = (
  run: MediaRunDetail,
  revision: MediaFlowRevision,
): MediaGenerationRecipeSnapshot => {
  const target = readMediaGenerationTarget(revision.flow);
  const imageSettings = readMediaFlowImageSettings(revision.flow);
  const videoSettings = readMediaVideoRecipeSettings(revision.flow);
  let outputBranches: MediaImageOutputBranch[] = [];
  if (target === "image") {
    try {
      outputBranches = compileMediaImageOutputBranches(revision.flow);
    } catch {
      outputBranches = [];
    }
  }
  return {
    schemaVersion: 1,
    mode: revision.flow.id.startsWith("media-basic-") ? "basic" : "advanced",
    target,
    flowId: revision.flow.id,
    flowName: revision.flow.name,
    flowRevisionId: revision.revisionId,
    flowRevisionNumber: revision.revisionNumber,
    planId: run.planId,
    prompt: readMediaFlowPrompt(revision.flow),
    modelId:
      target === "video"
        ? (videoSettings?.modelId ?? null)
        : (imageSettings?.modelId ?? null),
    modelLabel: run.modelLabel,
    modelAddons: imageSettings?.modelAddons ?? [],
    outputBranches,
    imageSettings,
    videoSettings,
    resultDestination: "assets",
  };
};

const SEMANTIC_HISTORY_LIMIT = 100;

interface RemoteEditExecutionAssessment {
  supported: boolean;
  reason: string;
  maskIncluded: boolean;
  manifest: Array<{
    assetId: string;
    digest: string;
    byteSize: number;
    role: string;
    influence: number;
  }>;
}

interface AdvancedLocalImageExecutionAssessment {
  supported: boolean;
  reason: string;
  settings: ImageRecipeSettings | null;
  model: MediaModelDescriptor | null;
  taskNode: MediaFlow["nodes"][number] | null;
  outputBranches: MediaImageOutputBranch[];
}

const assessAdvancedLocalImageExecution = ({
  flow,
  plan,
  runtimeStatus,
  assets,
}: {
  flow: MediaFlow;
  plan: MediaCompiledPlan;
  runtimeStatus: MediaRuntimeStatus | null;
  assets: readonly MediaAssetRecord[];
}): AdvancedLocalImageExecutionAssessment => {
  const unavailable = (
    reason: string,
  ): AdvancedLocalImageExecutionAssessment => ({
    supported: false,
    reason,
    settings: null,
    model: null,
    taskNode: null,
    outputBranches: [],
  });
  if (plan.status !== "ready") {
    return unavailable(
      "Resolve preflight diagnostics before running this flow.",
    );
  }
  const resolvedFlow = resolveMediaFlowVariables(flow).flow;
  const taskNodes = resolvedFlow.nodes.filter(
    (node) =>
      node.type === "task.generate-image" || node.type === "task.edit-image",
  );
  if (taskNodes.length !== 1) {
    return unavailable("This flow does not contain exactly one image task.");
  }
  const taskNode = taskNodes[0]!;
  const binding = plan.runtimeBindings.find(
    (candidate) =>
      candidate.nodeId === taskNode.id && candidate.modality === "image",
  );
  const model = binding?.model ?? null;
  if (
    !model ||
    model.providerId !== "local-diffusers" ||
    !(runtimeStatus?.directGenerationModelIds ?? []).includes(model.id)
  ) {
    return unavailable("Choose a runnable local diffusion model.");
  }
  const settings = readImageRecipeSettings(resolvedFlow);
  if (!settings) return unavailable("The image task configuration is invalid.");
  if (
    (settings.referenceImages.length > 0 || settings.baseImageAssetId) &&
    !(runtimeStatus?.directReferenceImageModelIds ?? []).includes(model.id)
  ) {
    return unavailable("This model cannot run the connected references.");
  }
  if (
    hasMediaImageMaskContent(settings.editMask) &&
    !(runtimeStatus?.directInpaintingModelIds ?? []).includes(model.id)
  ) {
    return unavailable("This model cannot run the edited mask.");
  }
  if (
    settings.poseImageAssetId &&
    !(runtimeStatus?.directPoseModelIds ?? []).includes(model.id)
  ) {
    return unavailable("This model cannot run the connected pose control.");
  }
  const availableAssetIds = new Set(assets.map((asset) => asset.id));
  const missingSource = resolvedFlow.nodes.find(
    (node) =>
      node.type === "source.image" &&
      !availableAssetIds.has(String(node.config.assetId ?? "")),
  );
  if (missingSource) {
    return unavailable(
      `${missingSource.label} must reference an available image.`,
    );
  }
  const supportedNodeTypes = new Set<MediaNodeType>([
    "source.prompt",
    "source.image",
    "source.seed",
    "task.generate-image",
    "task.edit-image",
    "operation.crop",
    "operation.resize",
    "operation.text-overlay",
    "operation.color-adjust",
    "operation.sharpen",
    "operation.format-convert",
    "operation.metadata-strip",
    "output.asset",
  ]);
  const unsupported = resolvedFlow.nodes.find(
    (node) => !supportedNodeTypes.has(node.type),
  );
  if (unsupported) {
    return unavailable(`${unsupported.label} requires a separate executor.`);
  }
  try {
    return {
      supported: true,
      reason: "Runs local conditioning and independent output branches.",
      settings,
      model,
      taskNode,
      outputBranches: compileMediaImageOutputBranches(resolvedFlow),
    };
  } catch (error) {
    return unavailable(
      error instanceof Error ? error.message : "Output branches are invalid.",
    );
  }
};

const assessRemoteEditExecution = ({
  plan,
  flow,
  assets,
  runtimeMode,
  directReferenceImageModelIds,
}: {
  plan: ReturnType<typeof compileMediaFlow>;
  flow: MediaFlow;
  assets: readonly MediaAssetRecord[];
  runtimeMode: MediaRuntimeStatus["mode"] | null;
  directReferenceImageModelIds: readonly string[] | null;
}): RemoteEditExecutionAssessment => {
  const unavailable = (reason: string): RemoteEditExecutionAssessment => ({
    supported: false,
    reason,
    maskIncluded: false,
    manifest: [],
  });
  const resolvedFlow = resolveMediaFlowVariables(flow).flow;
  if (!resolvedFlow.nodes.some((node) => node.type === "task.edit-image")) {
    return unavailable("This flow does not contain a remote image-edit task.");
  }
  if (plan.status !== "ready") {
    return unavailable(
      "Resolve preflight diagnostics before using image references.",
    );
  }
  if (directReferenceImageModelIds === null) {
    return unavailable(
      "Checking whether the selected model can use image references.",
    );
  }
  if (!plan.model || !directReferenceImageModelIds.includes(plan.model.id)) {
    return unavailable(
      "The selected model runtime does not support image references yet.",
    );
  }
  if (plan.model.target !== "remote" || !plan.preflight.requiresRemoteRequest) {
    return unavailable(
      "The selected reference-image runtime is not available in this build.",
    );
  }
  const supportedNodeTypes = new Set<MediaNodeType>([
    "source.prompt",
    "source.image",
    "task.edit-image",
    "output.asset",
  ]);
  const unsupported = resolvedFlow.nodes.find(
    (node) => !supportedNodeTypes.has(node.type),
  );
  if (unsupported) {
    return unavailable(
      `${unsupported.label} requires a separate executor; reference generation currently supports a one-shot edit followed directly by Save assets.`,
    );
  }
  const editNodes = resolvedFlow.nodes.filter(
    (node) => node.type === "task.edit-image",
  );
  const promptNodes = resolvedFlow.nodes.filter(
    (node) => node.type === "source.prompt",
  );
  const outputNodes = resolvedFlow.nodes.filter(
    (node) => node.type === "output.asset",
  );
  const sourceNodes = resolvedFlow.nodes.filter(
    (node) => node.type === "source.image",
  );
  if (
    editNodes.length !== 1 ||
    promptNodes.length !== 1 ||
    outputNodes.length !== 1 ||
    sourceNodes.length < 1 ||
    sourceNodes.length > 8
  ) {
    return unavailable(
      "Reference generation requires one prompt, one edit task, one output, and one to eight images.",
    );
  }
  const availableAssets = new Map(assets.map((asset) => [asset.id, asset]));
  const manifest = sourceNodes.map((node) => {
    const assetId = String(node.config.assetId ?? "");
    const asset = availableAssets.get(assetId);
    return asset
      ? {
          assetId,
          digest: asset.digest,
          byteSize: asset.byteSize,
          role: String(node.config.referenceRole ?? "base"),
          influence:
            typeof node.config.influence === "number"
              ? node.config.influence
              : 1,
        }
      : null;
  });
  if (manifest.some((item) => item === null)) {
    return unavailable(
      "Every reference must point to an available Library image.",
    );
  }
  const exactManifest = manifest.filter(
    (item): item is NonNullable<typeof item> => item !== null,
  );
  if (
    new Set(exactManifest.map((item) => item.assetId)).size !==
    exactManifest.length
  ) {
    return unavailable("Remove duplicate reference images before generation.");
  }
  if (exactManifest.filter((item) => item.role === "base").length !== 1) {
    return unavailable("Exactly one reference must be the base image.");
  }
  exactManifest.sort((left, right) =>
    left.role === "base" ? -1 : right.role === "base" ? 1 : 0,
  );
  const maskIncluded = hasMediaImageMaskContent(
    normalizeMediaImageMask(editNodes[0]?.config.editMask),
  );
  return {
    supported: true,
    reason:
      runtimeMode === "browser-preview"
        ? "Runs a deterministic browser fixture with no upload or charge."
        : `Submits one paid ${plan.model.displayName} edit request with ${exactManifest.length} image${exactManifest.length === 1 ? "" : "s"}${maskIncluded ? " and a mask" : ""}.`,
    maskIncluded,
    manifest: exactManifest,
  };
};

export const MediaStudio = ({
  providerStatuses,
  onOpenProviderSettings,
  workspaceRoot,
  openRunId,
  onOpenRunHandled,
  openSection,
  onOpenSectionHandled,
  openAssetId,
  onOpenAssetHandled,
  importPath,
  onImportPathHandled,
  draftPrompt,
  onDraftPromptHandled,
}: MediaStudioProps): JSX.Element => {
  const [state, setState] = useState<MediaStudioState>(() =>
    normalizeMediaStudioState(DEFAULT_MEDIA_STUDIO_STATE),
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<MediaRuntimeStatus | null>(
    null,
  );
  const [runtimeRuns, setRuntimeRuns] = useState<MediaRuntimeRunRecord[]>([]);
  const [runtimeAssets, setRuntimeAssets] = useState<MediaAssetRecord[]>([]);
  const [runtimeError, setRuntimeError] = useState<MediaErrorDetail | null>(
    null,
  );
  const [importedAssetId, setImportedAssetId] = useState<string | null>(null);
  const [importedResourceId, setImportedResourceId] = useState<string | null>(
    null,
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<MediaRunDetail | null>(null);
  const [selectedRunRecipe, setSelectedRunRecipe] =
    useState<MediaGenerationRecipeSnapshot | null>(null);
  const [flowRunOverlayId, setFlowRunOverlayId] = useState<string | null>(null);
  const [generationPending, setGenerationPending] = useState(false);
  const [localFlowPending, setLocalFlowPending] = useState(false);
  const [remoteEditPending, setRemoteEditPending] = useState(false);
  const generationJobs = useSyncExternalStore(
    generationQueue.subscribe,
    generationQueue.getSnapshot,
    generationQueue.getSnapshot,
  );
  const [providerReviewPending, setProviderReviewPending] = useState(false);
  const [humanReviewPending, setHumanReviewPending] = useState(false);
  const [localRuntimeRefreshing, setLocalRuntimeRefreshing] = useState(false);
  const [verifyingModelId, setVerifyingModelId] = useState<string | null>(null);
  const [modelCatalog, setModelCatalog] =
    useState<MediaModelCatalogSnapshot | null>(null);
  const [workspaceModelDiscovery, setWorkspaceModelDiscovery] =
    useState<MediaWorkspaceModelDiscovery | null>(null);
  const [modelImportInspection, setModelImportInspection] =
    useState<MediaLocalModelImportInspection | null>(null);
  const [modelImportLoading, setModelImportLoading] = useState(false);
  const [modelImportError, setModelImportError] = useState<string | null>(null);
  const [addonImportInspection, setAddonImportInspection] =
    useState<MediaModelAddonImportInspection | null>(null);
  const [addonImportLoading, setAddonImportLoading] = useState(false);
  const [addonImportError, setAddonImportError] = useState<string | null>(null);
  const [civitaiAddonInspection, setCivitaiAddonInspection] =
    useState<MediaCivitaiModelAddonInspection | null>(null);
  const [civitaiAddonLoading, setCivitaiAddonLoading] = useState(false);
  const [civitaiAddonError, setCivitaiAddonError] = useState<string | null>(
    null,
  );
  const [importLoading, setImportLoading] = useState(false);
  const [assetImportError, setAssetImportError] = useState<string | null>(null);
  const [assetImportProgress, setAssetImportProgress] =
    useState<MediaAssetImportProgress | null>(null);
  const [tagLoadingAssetId, setTagLoadingAssetId] = useState<string | null>(
    null,
  );
  const [draftCreatedAt] = useState(() => new Date().toISOString());
  const [basicImageFlowId] = useState(
    () => `media-basic-image-${createFlowSaveId()}`,
  );
  const [advancedDraftFlowId] = useState(
    () => `media-advanced-${createFlowSaveId()}`,
  );
  const [flowHistory, setFlowHistory] = useState<MediaFlowHistory | null>(null);
  const [savedFlows, setSavedFlows] = useState<MediaFlowHead[]>([]);
  const [savedFlowsLoading, setSavedFlowsLoading] = useState(false);
  const [flowRevisionLoading, setFlowRevisionLoading] = useState(false);
  const [flowRevisionNotice, setFlowRevisionNotice] = useState<string | null>(
    null,
  );
  const [flowPortabilityLoading, setFlowPortabilityLoading] = useState(false);
  const [flowImportInspection, setFlowImportInspection] =
    useState<MediaFlowImportInspection | null>(null);
  const [flowImportSourcePath, setFlowImportSourcePath] = useState<
    string | null
  >(null);
  const [flowClipboard, setFlowClipboard] =
    useState<MediaFlowNodeClipboardPayload | null>(null);
  const semanticUndoStack = useRef<MediaFlow[]>([]);
  const semanticRedoStack = useRef<MediaFlow[]>([]);
  const [, setSemanticHistoryRevision] = useState(0);
  const latestSaveSequence = useRef(0);
  const runtimeRefreshSequence = useRef(0);
  const selectedRunDetailSequence = useRef(0);
  const selectedRunIdRef = useRef<string | null>(selectedRunId);
  const modelCatalogRequestSequence = useRef(0);
  const workspaceDiscoveryRequestSequence = useRef(0);
  const announcedFailureKey = useRef<string | null>(null);
  const claimedImportPath = useRef<string | null>(null);
  const basicFlowHeadRevisionIds = useRef(new Map<string, string>());
  const mediaStudioMounted = useRef(true);

  useEffect(() => {
    mediaStudioMounted.current = true;
    return () => {
      mediaStudioMounted.current = false;
      ++runtimeRefreshSequence.current;
      ++selectedRunDetailSequence.current;
      ++modelCatalogRequestSequence.current;
      ++workspaceDiscoveryRequestSequence.current;
    };
  }, []);

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void subscribeToMediaImportProgress((progress) => {
      if (!disposed) setAssetImportProgress(progress);
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unsubscribe = dispose;
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setAssetImportError(
            readImportError(error, "Import progress is unavailable."),
          );
        }
      });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  const presentRunFailure = useCallback((failure: MediaErrorDetail): void => {
    const key = [
      failure.code,
      failure.context.runId ?? "",
      failure.context.nodeId ?? "",
      failure.technicalDiagnostic,
    ].join("\0");
    if (announcedFailureKey.current !== key) {
      announcedFailureKey.current = key;
      setRuntimeError(failure);
    }
  }, []);

  const refreshRuntime = useCallback(async (): Promise<void> => {
    const refreshSequence = ++runtimeRefreshSequence.current;
    const detailSequence = ++selectedRunDetailSequence.current;
    const requestedRunId = selectedRunIdRef.current;
    const requestedQueueJob = requestedRunId
      ? generationQueue.getJob(requestedRunId)
      : null;
    try {
      const [runs, assets, detail] = await Promise.all([
        listMediaRuns(),
        listMediaAssets(),
        requestedRunId
          ? getMediaRunDetail(requestedRunId).catch((error: unknown) => {
              if (requestedQueueJob) return null;
              throw error;
            })
          : null,
      ]);
      if (
        !mediaStudioMounted.current ||
        refreshSequence !== runtimeRefreshSequence.current
      ) {
        return;
      }
      setRuntimeRuns(runs);
      setRuntimeAssets(assets);
      if (
        detailSequence === selectedRunDetailSequence.current &&
        selectedRunIdRef.current === requestedRunId
      ) {
        if (detail) {
          setSelectedRun(detail);
        } else if (requestedQueueJob) {
          setSelectedRun(generationJobToRunDetail(requestedQueueJob));
          setSelectedRunRecipe(requestedQueueJob.recipe);
        }
        if (detail?.failure) {
          presentRunFailure(detail.failure);
        }
      }
    } catch (error: unknown) {
      if (
        mediaStudioMounted.current &&
        refreshSequence === runtimeRefreshSequence.current
      ) {
        setRuntimeError(normalizeMediaError(error, "refresh_media_runtime"));
      }
    }
  }, [presentRunFailure]);

  const displayedGenerationJob = useMemo<MediaGenerationQueueJob | null>(() => {
    const active = generationJobs.find((job) =>
      ["running", "canceling"].includes(job.status),
    );
    if (active) return active;
    const queued = generationJobs.find((job) => job.status === "queued");
    return queued ?? generationJobs.at(-1) ?? null;
  }, [generationJobs]);
  const generationQueueBusy = generationJobs.some((job) =>
    ["queued", "running", "canceling"].includes(job.status),
  );
  const completedGenerationIds = generationJobs
    .filter((job) => job.completedAt !== null)
    .map((job) => `${job.id}:${job.completedAt}`)
    .join("|");
  const refreshedGenerationIds = useRef("");
  useEffect(() => {
    if (
      !completedGenerationIds ||
      refreshedGenerationIds.current === completedGenerationIds
    ) {
      return;
    }
    refreshedGenerationIds.current = completedGenerationIds;
    void refreshRuntime();
  }, [completedGenerationIds, refreshRuntime]);
  useEffect(() => {
    if (!selectedRunId || runtimeRuns.some((run) => run.id === selectedRunId)) {
      return;
    }
    const queuedJob = generationQueue.getJob(selectedRunId);
    if (!queuedJob) return;
    setSelectedRun(generationJobToRunDetail(queuedJob));
    setSelectedRunRecipe(queuedJob.recipe);
  }, [generationJobs, runtimeRuns, selectedRunId]);

  const configuredProviderIds = useMemo(() => {
    if (runtimeStatus?.mode === "browser-preview") {
      return ["openai"];
    }
    return providerStatuses
      .filter((status) => status.configured)
      .map((status) => status.provider);
  }, [providerStatuses, runtimeStatus?.mode]);
  const fallbackModelCatalog = useMemo(
    () =>
      createMediaModelCatalogSnapshot({
        isOpenAiConfigured: configuredProviderIds.includes("openai"),
      }),
    [configuredProviderIds],
  );
  const refreshModelCatalog =
    useCallback(async (): Promise<MediaModelCatalogSnapshot | null> => {
      const requestSequence = ++modelCatalogRequestSequence.current;
      try {
        const snapshot = await getMediaModelCatalog(configuredProviderIds);
        if (requestSequence === modelCatalogRequestSequence.current) {
          setModelCatalog(snapshot);
          return snapshot;
        }
      } catch (error: unknown) {
        if (requestSequence === modelCatalogRequestSequence.current) {
          setRuntimeError(
            normalizeMediaError(error, "get_media_model_catalog"),
          );
        }
      }
      return null;
    }, [configuredProviderIds]);

  const refreshLocalRuntime = useCallback(async (): Promise<void> => {
    setLocalRuntimeRefreshing(true);
    try {
      await refreshMediaLocalDiffusersRuntime();
      setRuntimeStatus(await initializeMediaRuntime());
      await refreshModelCatalog();
      setRuntimeError(null);
    } catch (error: unknown) {
      setRuntimeError(normalizeMediaError(error, "refresh_local_runtime"));
    } finally {
      setLocalRuntimeRefreshing(false);
    }
  }, [refreshModelCatalog]);

  const verifyLocalModel = useCallback(
    async (model: MediaModelDescriptor): Promise<void> => {
      setVerifyingModelId(model.id);
      try {
        await probeMediaLocalModel(model.id);
        setRuntimeStatus(await initializeMediaRuntime());
        await refreshModelCatalog();
        setRuntimeError(null);
      } catch (error: unknown) {
        setRuntimeError(normalizeMediaError(error, "probe_local_model"));
      } finally {
        setVerifyingModelId(null);
      }
    },
    [refreshModelCatalog],
  );

  const refreshWorkspaceModels = useCallback((): void => {
    const normalizedWorkspaceRoot = workspaceRoot?.trim();
    const requestSequence = ++workspaceDiscoveryRequestSequence.current;
    if (!normalizedWorkspaceRoot) {
      setWorkspaceModelDiscovery(null);
      return;
    }
    void discoverMediaWorkspaceModels(normalizedWorkspaceRoot)
      .then((discovery) => {
        if (requestSequence === workspaceDiscoveryRequestSequence.current) {
          setWorkspaceModelDiscovery(discovery);
        }
      })
      .catch((error: unknown) => {
        if (requestSequence === workspaceDiscoveryRequestSequence.current) {
          setRuntimeError(
            normalizeMediaError(error, "discover_workspace_models"),
          );
        }
      });
  }, [workspaceRoot]);

  const persistImportedResourceMetadata = useCallback(
    async (
      resourceId: string,
      metadata: MediaGenerationAssetMetadata,
    ): Promise<void> => {
      const nextState = {
        ...stateRef.current,
        assetMetadata: {
          ...stateRef.current.assetMetadata,
          [resourceId]: metadata,
        },
      };
      const saveSequence = ++latestSaveSequence.current;
      try {
        await saveMediaStudioState(nextState);
        if (latestSaveSequence.current === saveSequence) setSaveError(null);
      } catch {
        if (latestSaveSequence.current === saveSequence) {
          setSaveError("Imported metadata could not be saved.");
        }
      }
      stateRef.current = nextState;
      setState(nextState);
    },
    [],
  );

  const retryMediaStudioStateSave = useCallback(async (): Promise<void> => {
    const saveSequence = ++latestSaveSequence.current;
    try {
      await saveMediaStudioState(stateRef.current);
      if (latestSaveSequence.current === saveSequence) setSaveError(null);
    } catch (error: unknown) {
      if (latestSaveSequence.current === saveSequence) {
        setSaveError(
          error instanceof Error
            ? error.message
            : "Media Studio settings could not be saved.",
        );
      }
    }
  }, []);

  const inspectModelImportPath = useCallback(
    (path: string): void => {
      if (modelImportLoading || addonImportLoading) return;
      if (!supportsNativeMediaModelImport()) {
        setModelImportError(
          "Local model import is available in the native desktop app only.",
        );
        return;
      }
      setModelImportLoading(true);
      setAssetImportProgress(null);
      setModelImportError(null);
      setModelImportInspection(null);
      void inspectMediaLocalModel(path)
        .then(setModelImportInspection)
        .catch((error: unknown) => {
          setModelImportError(
            readImportError(
              error,
              "Select a valid .safetensors model checkpoint.",
            ),
          );
        })
        .finally(() => setModelImportLoading(false));
    },
    [addonImportLoading, modelImportLoading],
  );

  const importLocalModel = useCallback(
    async (
      request: ImportMediaLocalModelRequest,
      metadata: MediaGenerationAssetMetadata,
    ): Promise<boolean> => {
      setModelImportLoading(true);
      setAssetImportProgress(null);
      setModelImportError(null);
      try {
        const result = await importMediaLocalModel(request);
        await persistImportedResourceMetadata(result.modelId, metadata);
        const snapshot = await refreshModelCatalog();
        setImportedAssetId(null);
        setImportedResourceId(result.modelId);
        if (!snapshot?.models.some((model) => model.id === result.modelId)) {
          void refreshModelCatalog();
        }
        return true;
      } catch (error: unknown) {
        setModelImportError(
          readImportError(
            error,
            "The model could not be imported. Check the file and available storage.",
          ),
        );
        return false;
      } finally {
        setModelImportLoading(false);
      }
    },
    [persistImportedResourceMetadata, refreshModelCatalog],
  );

  const dismissModelImport = useCallback((): void => {
    if (modelImportLoading) return;
    setModelImportInspection(null);
    setModelImportError(null);
  }, [modelImportLoading]);

  const inspectAddonImportPath = useCallback(
    (path: string): void => {
      if (modelImportLoading || addonImportLoading) return;
      if (!supportsNativeMediaModelAddonImport()) {
        setAddonImportError(
          "LoRA and embedding import is available in the native desktop app only.",
        );
        return;
      }
      setAddonImportLoading(true);
      setAssetImportProgress(null);
      setAddonImportError(null);
      setAddonImportInspection(null);
      void inspectMediaModelAddon(path)
        .then(setAddonImportInspection)
        .catch((error: unknown) => {
          setAddonImportError(
            readImportError(
              error,
              "Select a valid .safetensors LoRA or embedding file.",
            ),
          );
        })
        .finally(() => setAddonImportLoading(false));
    },
    [addonImportLoading, modelImportLoading],
  );

  const inspectCivitaiAddon = useCallback((source: string): void => {
    if (!supportsNativeMediaModelAddonImport()) {
      setCivitaiAddonError(
        "Civitai add-on import is available in the native desktop app only.",
      );
      return;
    }
    setCivitaiAddonLoading(true);
    setCivitaiAddonError(null);
    setCivitaiAddonInspection(null);
    void inspectMediaCivitaiModelAddon(source)
      .then((inspection) => setCivitaiAddonInspection(inspection))
      .catch((error: unknown) => {
        setCivitaiAddonError(
          readImportError(
            error,
            "Civitai metadata could not be loaded. Check the link and try again.",
          ),
        );
      })
      .finally(() => setCivitaiAddonLoading(false));
  }, []);

  const dismissCivitaiAddon = useCallback((): void => {
    if (civitaiAddonLoading) return;
    setCivitaiAddonInspection(null);
    setCivitaiAddonError(null);
  }, [civitaiAddonLoading]);

  const importAddon = useCallback(
    async (
      request: ImportMediaModelAddonRequest,
      metadata: MediaGenerationAssetMetadata,
    ): Promise<boolean> => {
      setAddonImportLoading(true);
      setAssetImportProgress(null);
      setAddonImportError(null);
      try {
        const result = await importMediaModelAddon(request);
        await persistImportedResourceMetadata(result.addonId, metadata);
        const snapshot = await refreshModelCatalog();
        setImportedAssetId(null);
        setImportedResourceId(result.addonId);
        if (!snapshot?.addons.some((addon) => addon.id === result.addonId)) {
          void refreshModelCatalog();
        }
        return true;
      } catch (error: unknown) {
        setAddonImportError(
          readImportError(
            error,
            "The add-on could not be imported. Check the file and available storage.",
          ),
        );
        return false;
      } finally {
        setAddonImportLoading(false);
      }
    },
    [persistImportedResourceMetadata, refreshModelCatalog],
  );

  const dismissAddonImport = useCallback((): void => {
    if (addonImportLoading) return;
    setAddonImportInspection(null);
    setAddonImportError(null);
  }, [addonImportLoading]);

  const dismissAssetImport = useCallback((): void => {
    setAssetImportError(null);
    setAssetImportProgress(null);
    dismissModelImport();
    dismissAddonImport();
    dismissCivitaiAddon();
  }, [dismissAddonImport, dismissCivitaiAddon, dismissModelImport]);

  useEffect(() => {
    let cancelled = false;
    void loadMediaStudioState()
      .then((stored) => {
        if (!cancelled) {
          setState(stored);
          setLoadError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(
            error instanceof Error
              ? error.message
              : "Media Studio settings could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void initializeMediaRuntime()
      .then((status) => {
        if (!cancelled) {
          setRuntimeStatus(status);
        }
        return refreshRuntime();
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRuntimeError(
            normalizeMediaError(error, "initialize_media_runtime"),
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [refreshRuntime]);

  useEffect(() => {
    void refreshModelCatalog();
  }, [refreshModelCatalog]);

  useEffect(() => {
    refreshWorkspaceModels();
  }, [refreshWorkspaceModels]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void subscribeToUserSettingsChanged((kind) => {
      if (kind === "provider-keys") {
        void refreshModelCatalog();
      }
    }).then((dispose) => {
      if (disposed) {
        dispose();
      } else {
        unsubscribe = dispose;
      }
    });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [refreshModelCatalog]);

  useEffect(() => {
    const hasActiveRun = runtimeRuns.some((run) =>
      ["queued", "running", "canceling"].includes(run.status),
    );
    const timeout = window.setTimeout(
      () => void refreshRuntime(),
      hasActiveRun ? 450 : 3_000,
    );
    return () => window.clearTimeout(timeout);
  }, [refreshRuntime, runtimeRuns]);

  useEffect(() => {
    if (!flowRunOverlayId) return;
    let cancelled = false;
    let timeout: number | null = null;
    let misses = 0;
    const pollOverlayRun = async (): Promise<void> => {
      try {
        const detail = await getMediaRunDetail(flowRunOverlayId);
        if (cancelled) return;
        misses = 0;
        if (selectedRunIdRef.current === detail.id) {
          ++selectedRunDetailSequence.current;
          setSelectedRun(detail);
        }
        if (detail.failure) presentRunFailure(detail.failure);
        if (["queued", "running", "canceling"].includes(detail.status)) {
          timeout = window.setTimeout(() => void pollOverlayRun(), 140);
        }
      } catch {
        if (cancelled) return;
        misses += 1;
        // Native commands register the run inside their worker. A short not-found
        // window is expected between choosing the id and the first committed row.
        if (localFlowPending || remoteEditPending || misses < 40) {
          timeout = window.setTimeout(
            () => void pollOverlayRun(),
            Math.min(100 + misses * 25, 500),
          );
        }
      }
    };
    void pollOverlayRun();
    return () => {
      cancelled = true;
      if (timeout !== null) window.clearTimeout(timeout);
    };
  }, [
    flowRunOverlayId,
    localFlowPending,
    presentRunFailure,
    remoteEditPending,
  ]);

  useEffect(() => {
    if (!loaded) {
      return;
    }

    const saveSequence = ++latestSaveSequence.current;
    const timeout = window.setTimeout(() => {
      void saveMediaStudioState(state)
        .then(() => {
          if (latestSaveSequence.current === saveSequence) {
            setSaveError(null);
          }
        })
        .catch((error: unknown) => {
          if (latestSaveSequence.current === saveSequence) {
            setSaveError(
              error instanceof Error
                ? error.message
                : "Media Studio settings could not be saved.",
            );
          }
        });
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [loaded, state]);

  const discoveredModelCatalog = useMemo<MediaModelCatalogSnapshot>(
    () =>
      extendMediaCatalogWithWorkspaceDiscovery({
        catalog: modelCatalog ?? fallbackModelCatalog,
        discovery: workspaceModelDiscovery,
        runtime: runtimeStatus?.localDiffusers ?? null,
      }),
    [
      fallbackModelCatalog,
      modelCatalog,
      runtimeStatus?.localDiffusers,
      workspaceModelDiscovery,
    ],
  );
  const activeModelCatalog = useMemo<MediaModelCatalogSnapshot>(() => {
    const directInpaintingModelIds = new Set(
      runtimeStatus?.directInpaintingModelIds ?? [],
    );
    const directPoseModelIds = new Set(runtimeStatus?.directPoseModelIds ?? []);
    return {
      ...discoveredModelCatalog,
      models: discoveredModelCatalog.models.map((model) => {
        const capabilities = [...model.capabilities];
        if (
          directInpaintingModelIds.has(model.id) &&
          !capabilities.includes("masked-image-edit")
        ) {
          capabilities.push("masked-image-edit");
        }
        if (
          directPoseModelIds.has(model.id) &&
          !capabilities.includes("pose-control")
        ) {
          capabilities.push("pose-control");
        }
        return capabilities.length === model.capabilities.length
          ? model
          : { ...model, capabilities };
      }),
      addons: discoveredModelCatalog.addons.map((addon) =>
        applyMediaAssetMetadataToAddon(addon, state.assetMetadata[addon.id]),
      ),
    };
  }, [
    discoveredModelCatalog,
    runtimeStatus?.directInpaintingModelIds,
    runtimeStatus?.directPoseModelIds,
    state.assetMetadata,
  ]);
  const models = activeModelCatalog.models;
  const recipeFlow = useMemo(() => {
    const settings = {
      ...state.recipe,
      prompt: normalizeMediaSubmissionText(state.recipe.prompt, 8_000),
    };
    return createBasicMediaRecipeFlow({
      id: basicImageFlowId,
      createdAt: draftCreatedAt,
      target: state.target,
      settings,
      models,
    });
  }, [basicImageFlowId, draftCreatedAt, models, state.recipe, state.target]);
  const recipeLayout = useMemo(
    () => createMediaFlowLayout(recipeFlow),
    [recipeFlow],
  );
  const recipePlan = useMemo(
    () =>
      compileMediaFlow({
        flow: recipeFlow,
        models,
        addons: activeModelCatalog.addons,
        compiledAt: draftCreatedAt,
      }),
    [activeModelCatalog.addons, draftCreatedAt, models, recipeFlow],
  );
  const advancedDraftFlow = useMemo(
    () =>
      createImageRecipeFlow({
        id: advancedDraftFlowId,
        createdAt: draftCreatedAt,
        settings: DEFAULT_MEDIA_STUDIO_STATE.recipe,
      }),
    [advancedDraftFlowId, draftCreatedAt],
  );
  const flow = state.flow ?? advancedDraftFlow;
  const normalizedFlowForPlan = useMemo(
    () => normalizeMediaFlowForPersistence(flow),
    [flow],
  );
  const layout = useMemo(
    () => reconcileMediaFlowLayout(flow, state.flowLayout),
    [flow, state.flowLayout],
  );
  const plan = useMemo(
    () =>
      compileMediaFlow({
        flow: normalizedFlowForPlan,
        models,
        addons: activeModelCatalog.addons,
        compiledAt: draftCreatedAt,
      }),
    [activeModelCatalog.addons, draftCreatedAt, models, normalizedFlowForPlan],
  );
  const currentFlowDigests = useMemo(
    () => ({
      document: createMediaFlowDocumentDigest(flow),
      execution: createMediaFlowFingerprint(flow),
      layout: createMediaFlowLayoutDigest(layout),
    }),
    [flow, layout],
  );
  const hasUnsavedFlowChanges =
    !flowHistory ||
    flowHistory.flowId !== flow.id ||
    !flowHistory.head ||
    flowHistory.head.documentDigest !== currentFlowDigests.document ||
    flowHistory.head.executionDigest !== currentFlowDigests.execution ||
    flowHistory.head.layoutDigest !== currentFlowDigests.layout;
  const localFlowExecution = useMemo(() => {
    if (plan.status !== "ready") {
      return {
        supported: false,
        reason: "Resolve preflight diagnostics before running this flow.",
      };
    }
    const supportedNodeTypes = new Set<MediaNodeType>([
      "source.image",
      "operation.crop",
      "operation.resize",
      "operation.text-overlay",
      "operation.color-adjust",
      "operation.sharpen",
      "operation.format-convert",
      "operation.metadata-strip",
      "operation.auto-tag",
      "operation.subject-cutout",
      "operation.alpha-matte",
      "operation.composite",
      "operation.contact-sheet",
      "output.asset",
    ]);
    const resolvedFlow = resolveMediaFlowVariables(flow).flow;
    const unsupported = resolvedFlow.nodes.find(
      (node) => !supportedNodeTypes.has(node.type),
    );
    if (unsupported) {
      return {
        supported: false,
        reason: `${unsupported.label} needs a model/provider executor; this Run action currently executes bounded local image utilities.`,
      };
    }
    const outputs = resolvedFlow.nodes.filter(
      (node) => node.type === "output.asset",
    );
    if (outputs.length !== 1) {
      return {
        supported: false,
        reason:
          "Local utility execution requires exactly one Save asset output.",
      };
    }
    const metadataStrip = resolvedFlow.nodes.find(
      (node) => node.type === "operation.metadata-strip",
    );
    if (
      metadataStrip?.type === "operation.metadata-strip" &&
      metadataStrip.config.applyOrientation !== true
    ) {
      return {
        supported: false,
        reason:
          "Enable Apply orientation on Metadata Strip because bounded source decoding normalizes EXIF orientation.",
      };
    }
    const availableAssetIds = new Set(runtimeAssets.map((asset) => asset.id));
    const missingSource = resolvedFlow.nodes.find(
      (node) =>
        node.type === "source.image" &&
        !availableAssetIds.has(String(node.config.assetId ?? "")),
    );
    if (missingSource) {
      return {
        supported: false,
        reason: `${missingSource.label} must reference an available Library image before execution.`,
      };
    }
    return {
      supported: true,
      reason:
        runtimeStatus?.mode === "native"
          ? "Executes the pinned revision locally with bounded decoding, no model, and no network request."
          : "Runs a deterministic metadata fixture only; the native app performs the bounded pixel operation without a model or network request.",
    };
  }, [flow, plan.status, runtimeAssets, runtimeStatus?.mode]);

  const advancedLocalImageExecution = useMemo(
    () =>
      assessAdvancedLocalImageExecution({
        flow,
        plan,
        runtimeStatus,
        assets: runtimeAssets,
      }),
    [flow, plan, runtimeAssets, runtimeStatus],
  );

  const assessVideoFlow = useCallback(
    (candidateFlow: MediaFlow, candidatePlan: MediaCompiledPlan) => {
      const unavailable = (reason: string) => ({
        supported: false as const,
        reason,
        firstFrameAssetId: null,
        lastFrameAssetId: null,
        videoNode: null,
        videoModel: null,
        generatedFrame: false,
        imageModel: null,
        imageSettings: null,
        animatedBackground: null,
      });
      const resolvedFlow = resolveMediaFlowVariables(candidateFlow).flow;
      const videoNodes = resolvedFlow.nodes.filter(
        (node) => node.type === "task.generate-video",
      );
      if (videoNodes.length !== 1) {
        return unavailable(
          "This flow does not contain exactly one video generation node.",
        );
      }
      const videoBinding = candidatePlan.runtimeBindings.find(
        (binding) =>
          binding.nodeId === videoNodes[0]?.id &&
          binding.modality === "video" &&
          isExecutableLocalVideoModelId(binding.model.id),
      );
      if (candidatePlan.status !== "ready" || !videoBinding) {
        return unavailable(
          "Resolve the local video model, runtime, and node contract diagnostics first.",
        );
      }
      const videoNode = videoNodes[0];
      if (!videoNode) {
        return unavailable("The local video node is unavailable.");
      }
      const firstFrameEdge = resolvedFlow.edges.find(
        (edge) =>
          edge.toNodeId === videoNode.id && edge.toPortId === "first-frame",
      );
      const firstFrameNode = firstFrameEdge
        ? resolvedFlow.nodes.find(
            (node) => node.id === firstFrameEdge.fromNodeId,
          )
        : null;
      const firstFrameAssetId =
        typeof firstFrameNode?.config.assetId === "string"
          ? firstFrameNode.config.assetId.trim()
          : "";
      const lastFrameEdge = resolvedFlow.edges.find(
        (edge) =>
          edge.toNodeId === videoNode.id && edge.toPortId === "last-frame",
      );
      const lastFrameNode = lastFrameEdge
        ? resolvedFlow.nodes.find(
            (node) => node.id === lastFrameEdge.fromNodeId,
          )
        : null;
      const lastFrameAssetId =
        typeof lastFrameNode?.config.assetId === "string"
          ? lastFrameNode.config.assetId.trim()
          : "";
      const generatedFrame =
        firstFrameNode?.type !== "source.image" ||
        lastFrameNode?.type !== "source.image";
      let imageModel:
        | (typeof candidatePlan.runtimeBindings)[number]["model"]
        | null = null;
      let imageSettings: ImageRecipeSettings | null = null;
      if (generatedFrame) {
        if (
          !firstFrameNode ||
          !lastFrameNode ||
          firstFrameNode.id !== lastFrameNode.id
        ) {
          return unavailable(
            "Connected generation currently requires the same generated image output on both video endpoint ports.",
          );
        }
        const imageNode = resolvedFlow.nodes.find(
          (node) => node.type === "task.generate-image",
        );
        const imageBinding = candidatePlan.runtimeBindings.find(
          (binding) =>
            binding.nodeId === imageNode?.id && binding.modality === "image",
        );
        const reachesFrame = imageNode
          ? (() => {
              const visited = new Set<string>([imageNode.id]);
              const queue = [imageNode.id];
              while (queue.length > 0) {
                const current = queue.shift();
                if (current === firstFrameNode.id) return true;
                for (const edge of resolvedFlow.edges.filter(
                  (candidate) => candidate.fromNodeId === current,
                )) {
                  if (!visited.has(edge.toNodeId)) {
                    visited.add(edge.toNodeId);
                    queue.push(edge.toNodeId);
                  }
                }
              }
              return false;
            })()
          : false;
        imageSettings = readImageRecipeSettings(resolvedFlow);
        if (
          !imageNode ||
          !imageBinding ||
          !reachesFrame ||
          !imageSettings ||
          imageSettings.outputCount !== 1 ||
          imageSettings.outputFormat === "svg" ||
          !(runtimeStatus?.directGenerationModelIds ?? []).includes(
            imageBinding.model.id,
          )
        ) {
          return unavailable(
            "Resolve a ready local image model and one PNG/WebP output upstream of both video endpoints.",
          );
        }
        imageModel = imageBinding.model;
      } else {
        if (
          !firstFrameAssetId ||
          !runtimeAssets.some(
            (asset) => asset.id === firstFrameAssetId && asset.kind === "image",
          )
        ) {
          return unavailable(
            "Choose an available Library image for the first video frame.",
          );
        }
        if (
          !lastFrameAssetId ||
          !runtimeAssets.some(
            (asset) => asset.id === lastFrameAssetId && asset.kind === "image",
          )
        ) {
          return unavailable(
            "Connect an available Library image to the last-frame port. Reuse the first frame for a closed loop.",
          );
        }
      }
      const compositeNode = resolvedFlow.nodes.find(
        (node) => node.type === "operation.video-composite",
      );
      const backgroundEdge = compositeNode
        ? resolvedFlow.edges.find(
            (edge) =>
              edge.toNodeId === compositeNode.id &&
              edge.toPortId === "background-video",
          )
        : null;
      const backgroundNode = backgroundEdge
        ? resolvedFlow.nodes.find(
            (node) =>
              node.id === backgroundEdge.fromNodeId &&
              node.type === "source.animated-background",
          )
        : null;
      const animatedBackground = backgroundNode
        ? {
            style:
              backgroundNode.config.style === "enchanted-beach"
                ? ("enchanted-beach" as const)
                : ("gradient-wave" as const),
            direction:
              backgroundNode.config.direction === "horizontal" ||
              backgroundNode.config.direction === "vertical"
                ? (backgroundNode.config.direction as "horizontal" | "vertical")
                : ("diagonal" as const),
            colorStart: String(backgroundNode.config.colorStart),
            colorEnd: String(backgroundNode.config.colorEnd),
            cycles: Number(backgroundNode.config.cycles),
          }
        : null;
      if (compositeNode && !animatedBackground) {
        return unavailable(
          "Connect an Animated background source to the video composite node.",
        );
      }
      if (
        animatedBackground &&
        videoNode.config.transparentBackground !== true
      ) {
        return unavailable(
          "Animated background compositing requires Transparent background on the video node.",
        );
      }
      if (!workspaceRoot?.trim()) {
        return unavailable(
          "The active workspace root is required to resolve models safely.",
        );
      }
      return {
        supported: true as const,
        reason: animatedBackground
          ? "Runs the selected local video quality profile, verifies temporally stabilized VP9 alpha, and publishes an animated-background companion."
          : "Runs the selected local video quality, shot/loop, transparency, memory, and encoding profiles with decoded-output verification.",
        firstFrameAssetId,
        lastFrameAssetId,
        videoNode,
        videoModel: videoBinding.model,
        generatedFrame,
        imageModel,
        imageSettings,
        animatedBackground,
      };
    },
    [runtimeAssets, runtimeStatus?.directGenerationModelIds, workspaceRoot],
  );
  const videoFlowExecution = useMemo(
    () => assessVideoFlow(flow, plan),
    [assessVideoFlow, flow, plan],
  );

  const remoteEditExecution = useMemo(
    () =>
      assessRemoteEditExecution({
        plan,
        flow,
        assets: runtimeAssets,
        runtimeMode: runtimeStatus?.mode ?? null,
        directReferenceImageModelIds:
          runtimeStatus?.directReferenceImageModelIds ?? null,
      }),
    [flow, plan, runtimeAssets, runtimeStatus],
  );
  const selectSection = useCallback((activeSection: MediaStudioSection) => {
    setState((current) => ({ ...current, activeSection }));
  }, []);
  const mediaSectionCommandStateRef = useRef({
    activeSection: state.activeSection,
    selectSection,
  });
  mediaSectionCommandStateRef.current = {
    activeSection: state.activeSection,
    selectSection,
  };
  const sectionCommands = useMemo<readonly CommandDefinition[]>(
    () =>
      NAVIGATION_ITEMS.map((item): CommandDefinition => {
        const commandId = `media.section.${
          item.id === "generate"
            ? "create"
            : item.id === "flow"
              ? "graph"
              : item.id === "runs"
                ? "activity"
                : "assets"
        }` as
          | "media.section.create"
          | "media.section.assets"
          | "media.section.graph"
          | "media.section.activity";
        return {
          id: commandId,
          title: `Open Media ${item.label}`,
          group: "Media",
          scope: { kind: "view", ownerId: "media" },
          shortcuts: [
            {
              chord: getDefaultCommandShortcut(commandId),
              runtimes: ["tauri"],
              allowIn: [
                "document",
                "text-entry",
                "interactive-control",
                "command-surface",
              ],
            },
          ],
          palette: "visible",
          current: () =>
            mediaSectionCommandStateRef.current.activeSection === item.id,
          overlayPolicy: "replace-non-modal",
          execute: () =>
            mediaSectionCommandStateRef.current.selectSection(item.id),
        };
      }),
    [],
  );
  useOptionalRegisterCommands(sectionCommands);
  const changeFlowLayout = useCallback((flowLayout: MediaFlowLayout) => {
    setFlowRevisionNotice(null);
    setState((current) => ({ ...current, flowLayout }));
  }, []);
  const replaceSemanticFlow = useCallback((nextFlow: MediaFlow): void => {
    setRuntimeError(null);
    setState((current) => ({
      ...current,
      flow: nextFlow,
    }));
  }, []);
  const clearSemanticHistory = useCallback((): void => {
    semanticUndoStack.current = [];
    semanticRedoStack.current = [];
    setSemanticHistoryRevision((revision) => revision + 1);
  }, []);
  const applySemanticFlow = useCallback(
    (nextFlow: MediaFlow): void => {
      if (
        createMediaFlowDocumentDigest(flow) ===
        createMediaFlowDocumentDigest(nextFlow)
      ) {
        return;
      }
      semanticUndoStack.current = [
        ...semanticUndoStack.current.slice(-(SEMANTIC_HISTORY_LIMIT - 1)),
        flow,
      ];
      semanticRedoStack.current = [];
      setSemanticHistoryRevision((revision) => revision + 1);
      setFlowRevisionNotice(null);
      replaceSemanticFlow(nextFlow);
    },
    [flow, replaceSemanticFlow],
  );
  const applyFlowTemplate = useCallback(
    (result: InstantiateMediaFlowTemplateResult): void => {
      applySemanticFlow(result.flow);
      changeFlowLayout(result.layout);
      setFlowHistory(null);
      setFlowRunOverlayId(null);
      setFlowRevisionNotice(
        `Forked ${result.flow.name} as a new editable flow.`,
      );
    },
    [applySemanticFlow, changeFlowLayout],
  );
  const useAssetAsCreateReference = useCallback(
    (asset: MediaAssetRecord): void => {
      if (asset.kind !== "image" && asset.kind !== "vector") return;
      ++selectedRunDetailSequence.current;
      selectedRunIdRef.current = null;
      setSelectedRunId(null);
      setSelectedRun(null);
      setState((current) => ({
        ...current,
        activeSection: "generate",
        target: asset.kind === "vector" ? "svg" : current.target,
        recipe: {
          ...current.recipe,
          prompt: "",
          modelId: null,
          modelAddons: [],
          outputFormat:
            asset.kind === "vector"
              ? "svg"
              : current.recipe.outputFormat === "svg"
                ? "png"
                : current.recipe.outputFormat,
          referenceImages: [
            {
              assetId: asset.id,
              role: "subject",
              influence: 1,
            },
          ],
          baseImageAssetId: null,
          poseImageAssetId: null,
          editMask: null,
        },
      }));
    },
    [],
  );
  const useAssetAsBasicVideoReference = useCallback(
    (asset: MediaAssetRecord): void => {
      if (asset.kind !== "image") return;
      ++selectedRunDetailSequence.current;
      selectedRunIdRef.current = null;
      setSelectedRunId(null);
      setSelectedRun(null);
      setState((current) => createBasicVideoDraftFromImage(current, asset));
    },
    [],
  );
  const useAssetAsBaseImage = useCallback((asset: MediaAssetRecord): void => {
    if (asset.kind !== "image") return;
    ++selectedRunDetailSequence.current;
    selectedRunIdRef.current = null;
    setSelectedRunId(null);
    setSelectedRun(null);
    setState((current) => ({
      ...current,
      activeSection: "generate",
      target: "image",
      recipe: {
        ...current.recipe,
        prompt: "",
        modelId: null,
        modelAddons: [],
        outputFormat: "png",
        transparentBackground: false,
        referenceImages: current.recipe.referenceImages.filter(
          (reference) => reference.assetId !== asset.id,
        ),
        baseImageAssetId: asset.id,
        poseImageAssetId:
          current.recipe.poseImageAssetId === asset.id
            ? null
            : current.recipe.poseImageAssetId,
        editMask: null,
      },
    }));
  }, []);
  const useModelInCreate = useCallback(
    (model: MediaModelCatalogSnapshot["models"][number]): void => {
      const target = getMediaModelPrimaryGenerationTarget(model);
      if (!target) return;
      setState((current) => ({
        ...current,
        activeSection: "generate",
        target,
        recipe: {
          ...current.recipe,
          modelId: target === "video" ? current.recipe.modelId : model.id,
          modelAddons: target === "video" ? current.recipe.modelAddons : [],
          outputFormat:
            target === "svg"
              ? "svg"
              : current.recipe.outputFormat === "svg"
                ? "png"
                : current.recipe.outputFormat,
          referenceImages:
            target === "video"
              ? current.recipe.referenceImages.slice(0, 1)
              : current.recipe.referenceImages,
        },
        videoRecipe:
          target === "video"
            ? {
                ...current.videoRecipe,
                modelId: isExecutableLocalVideoModelId(model.id)
                  ? model.id
                  : current.videoRecipe.modelId,
              }
            : current.videoRecipe,
      }));
    },
    [],
  );
  const useAddonInCreate = useCallback(
    (addonId: string): void => {
      const addon = activeModelCatalog.addons.find(
        (candidate) => candidate.id === addonId,
      );
      if (!addon) return;
      setState((current) => {
        if (
          current.recipe.modelAddons.some(
            (selection) => selection.addonId === addonId,
          )
        ) {
          return { ...current, activeSection: "generate" };
        }
        return {
          ...current,
          activeSection: "generate",
          target: current.target === "video" ? "image" : current.target,
          recipe: {
            ...current.recipe,
            modelAddons: [
              ...current.recipe.modelAddons,
              createMediaModelAddonSelection(addon),
            ],
          },
        };
      });
    },
    [activeModelCatalog.addons],
  );
  const openVideoFlowDraft = useCallback(
    ({
      sourceAssetId,
      prompt,
      aspectRatio = "1:1",
      loopMode = "none",
      transparentBackground = false,
    }: {
      sourceAssetId?: string;
      prompt?: string;
      aspectRatio?: MediaVideoAspectRatio;
      loopMode?: MediaVideoLoopMode;
      transparentBackground?: boolean;
    }): void => {
      const createdAt = new Date().toISOString();
      const videoFlow = createImageToVideoFlow({
        id: `media-video-${createFlowSaveId()}`,
        createdAt,
        ...(sourceAssetId ? { sourceAssetId } : {}),
        ...(prompt ? { prompt } : {}),
        settings: {
          ...state.videoRecipe,
          aspectRatio,
          loopMode,
          transparentBackground,
        },
      });
      applySemanticFlow(videoFlow);
      changeFlowLayout(createMediaFlowLayout(videoFlow));
      setFlowHistory(null);
      setFlowRunOverlayId(null);
      setFlowRevisionNotice("Video setup converted to Advanced.");
      setState((current) => ({ ...current, activeSection: "flow" }));
    },
    [applySemanticFlow, changeFlowLayout, state.videoRecipe],
  );
  const createCurrentVideoFlow = useCallback((): MediaFlow => {
    const sourceAssetId = state.recipe.referenceImages[0]?.assetId;
    if (sourceAssetId) {
      return createImageToVideoFlow({
        id: `media-basic-video-${createFlowSaveId()}`,
        createdAt: new Date().toISOString(),
        sourceAssetId,
        prompt: state.recipe.prompt.trim(),
        settings: state.videoRecipe,
      });
    }
    return createGeneratedLoopVideoFlow({
      id: `media-basic-video-${createFlowSaveId()}`,
      createdAt: new Date().toISOString(),
      prompt: state.recipe.prompt.trim(),
      imageModelId: state.recipe.modelId,
      imageModelAddons: state.recipe.modelAddons,
      settings: state.videoRecipe,
    });
  }, [state.recipe, state.videoRecipe]);
  const basicVideoDraft = useMemo(() => {
    if (state.target !== "video") return null;
    const flow = createCurrentVideoFlow();
    const layout = createMediaFlowLayout(flow);
    const plan = compileMediaFlow({
      flow,
      models,
      addons: activeModelCatalog.addons,
      compiledAt: new Date().toISOString(),
    });
    return {
      flow,
      layout,
      plan,
      execution: assessVideoFlow(flow, plan),
    };
  }, [
    activeModelCatalog.addons,
    assessVideoFlow,
    createCurrentVideoFlow,
    models,
    state.target,
  ]);
  const openVideoCreationFlow = useCallback((): void => {
    const sourceAssetId = state.recipe.referenceImages[0]?.assetId;
    if (!sourceAssetId) {
      const createdAt = new Date().toISOString();
      const generatedLoop = createGeneratedLoopVideoFlow({
        id: `media-generated-loop-${createFlowSaveId()}`,
        createdAt,
        ...(state.recipe.prompt.trim()
          ? { prompt: state.recipe.prompt.trim() }
          : {}),
        imageModelId: state.recipe.modelId,
        imageModelAddons: state.recipe.modelAddons,
        settings: state.videoRecipe,
      });
      applySemanticFlow(generatedLoop);
      changeFlowLayout(createMediaFlowLayout(generatedLoop));
      setFlowHistory(null);
      setFlowRunOverlayId(null);
      setFlowRevisionNotice("Video setup converted to Advanced.");
      setState((current) => ({ ...current, activeSection: "flow" }));
      return;
    }
    const sourceAsset =
      runtimeAssets.find((asset) => asset.id === sourceAssetId) ?? null;
    openVideoFlowDraft({
      prompt: state.recipe.prompt.trim(),
      sourceAssetId,
      aspectRatio: sourceAsset
        ? inferMediaVideoAspectRatio(sourceAsset.width, sourceAsset.height)
        : "1:1",
      transparentBackground:
        sourceAsset !== null && isMediaAssetKnownTransparent(sourceAsset),
    });
  }, [
    applySemanticFlow,
    changeFlowLayout,
    openVideoFlowDraft,
    state.recipe.modelAddons,
    state.recipe.modelId,
    state.recipe.prompt,
    state.recipe.referenceImages,
    state.videoRecipe,
    runtimeAssets,
  ]);
  const openAssetAsVideoFlow = useCallback(
    (asset: MediaAssetRecord): void => {
      if (asset.kind !== "image") return;
      const transparentBackground = isMediaAssetKnownTransparent(asset);
      openVideoFlowDraft({
        sourceAssetId: asset.id,
        aspectRatio: inferMediaVideoAspectRatio(asset.width, asset.height),
        loopMode: "seamless",
        transparentBackground,
        prompt: transparentBackground
          ? "One continuous forward-time subject cycle on a perfectly uniform chroma-green background. Locked camera. First the subject gently inhales or shifts weight, then completes one soft blink with one continuous secondary sway, then exhales and arrives naturally at the opening pose only at the final instant. Keep the subject centered, fully visible, and unchanged. Never reverse playback, mirrored replay, boomerang, pause, shadows, or background movement."
          : "One continuous forward-time cyclic animation of the exact supplied image. Locked camera. First the subject gently inhales or shifts weight, then completes one soft blink while hair, fabric, flames, or particles continue along one natural direction, then exhales and arrives naturally at the opening pose only at the final instant. Preserve identity, anatomy, composition, lighting, and the existing background. Never reverse playback, mirrored replay, boomerang, cut, pause, zoom, camera shake, or background-only motion.",
      });
    },
    [openVideoFlowDraft],
  );
  const openAssetInLibrary = useCallback((asset: MediaAssetRecord): void => {
    setImportedAssetId(asset.id);
    setState((current) => ({ ...current, activeSection: "library" }));
  }, []);
  const undoSemanticFlow = useCallback((): void => {
    const previous = semanticUndoStack.current.at(-1);
    if (!previous) return;
    semanticUndoStack.current = semanticUndoStack.current.slice(0, -1);
    semanticRedoStack.current = [
      ...semanticRedoStack.current.slice(-(SEMANTIC_HISTORY_LIMIT - 1)),
      flow,
    ];
    replaceSemanticFlow(previous);
    setFlowRevisionNotice("Undid semantic flow change.");
    setSemanticHistoryRevision((revision) => revision + 1);
  }, [flow, replaceSemanticFlow]);
  const redoSemanticFlow = useCallback((): void => {
    const next = semanticRedoStack.current.at(-1);
    if (!next) return;
    semanticRedoStack.current = semanticRedoStack.current.slice(0, -1);
    semanticUndoStack.current = [
      ...semanticUndoStack.current.slice(-(SEMANTIC_HISTORY_LIMIT - 1)),
      flow,
    ];
    replaceSemanticFlow(next);
    setFlowRevisionNotice("Redid semantic flow change.");
    setSemanticHistoryRevision((revision) => revision + 1);
  }, [flow, replaceSemanticFlow]);
  const changeRecipe = useCallback((recipe: ImageRecipeSettings): void => {
    setState((current) => ({ ...current, recipe }));
  }, []);
  const changeGenerationTarget = useCallback(
    (target: MediaGenerationTarget): void => {
      setState((current) => ({
        ...current,
        target,
        recipe: {
          ...current.recipe,
          outputCount:
            target === "svg" && current.recipe.svgMode === "vectorize"
              ? 1
              : current.recipe.outputCount,
          outputFormat:
            target === "svg"
              ? "svg"
              : current.recipe.outputFormat === "svg"
                ? "png"
                : current.recipe.outputFormat,
          referenceImages:
            target === "video" ||
            (target === "svg" && current.recipe.svgMode === "vectorize")
              ? current.recipe.referenceImages.slice(0, 1)
              : current.recipe.referenceImages,
        },
      }));
    },
    [],
  );
  const changeVideoRecipe = useCallback(
    (videoRecipe: MediaVideoRecipeSettings): void => {
      setState((current) => ({
        ...current,
        videoRecipe,
      }));
    },
    [],
  );
  const changeFlowNodeConfig = useCallback(
    (nodeId: string, fieldId: string, value: unknown): void => {
      try {
        const nextFlow = updateMediaFlowNodeConfig({
          flow,
          nodeId,
          fieldId,
          value,
          updatedAt: new Date().toISOString(),
        });
        applySemanticFlow(nextFlow);
      } catch (error: unknown) {
        setRuntimeError(normalizeMediaError(error, "edit_media_flow_node"));
      }
    },
    [applySemanticFlow, flow],
  );
  const changeFlowNodeConfigs = useCallback(
    (nodeId: string, values: Readonly<Record<string, unknown>>): void => {
      try {
        const nextFlow = updateMediaFlowNodeConfigs({
          flow,
          nodeId,
          values,
          updatedAt: new Date().toISOString(),
        });
        applySemanticFlow(nextFlow);
      } catch (error: unknown) {
        setRuntimeError(normalizeMediaError(error, "edit_media_flow_node"));
      }
    },
    [applySemanticFlow, flow],
  );
  const changeFlowNodeLabel = useCallback(
    (nodeId: string, label: string): void => {
      try {
        applySemanticFlow(
          updateMediaFlowNodeLabel({
            flow,
            nodeId,
            label,
            updatedAt: new Date().toISOString(),
          }),
        );
      } catch (error: unknown) {
        setRuntimeError(normalizeMediaError(error, "edit_media_flow_node"));
      }
    },
    [applySemanticFlow, flow],
  );
  const addFlowNode = useCallback(
    (nodeType: MediaNodeType): string | null => {
      try {
        const result = addMediaFlowNode({
          flow,
          type: nodeType,
          updatedAt: new Date().toISOString(),
        });
        applySemanticFlow(result.flow);
        return result.nodeId;
      } catch (error: unknown) {
        setRuntimeError(normalizeMediaError(error, "add_media_flow_node"));
        return null;
      }
    },
    [applySemanticFlow, flow],
  );
  const removeFlowNode = useCallback(
    (nodeId: string): void => {
      try {
        applySemanticFlow(
          removeMediaFlowNode({
            flow,
            nodeId,
            updatedAt: new Date().toISOString(),
          }),
        );
      } catch (error: unknown) {
        setRuntimeError(normalizeMediaError(error, "remove_media_flow_node"));
      }
    },
    [applySemanticFlow, flow],
  );
  const connectFlowPorts = useCallback(
    (request: MediaFlowConnectionRequest): void => {
      try {
        applySemanticFlow(
          connectMediaFlowPorts({
            flow,
            request,
            updatedAt: new Date().toISOString(),
          }),
        );
      } catch (error: unknown) {
        setRuntimeError(normalizeMediaError(error, "connect_media_flow_ports"));
      }
    },
    [applySemanticFlow, flow],
  );
  const disconnectFlowInput = useCallback(
    (nodeId: string, portId: string): void => {
      applySemanticFlow(
        disconnectMediaFlowInput({
          flow,
          nodeId,
          portId,
          updatedAt: new Date().toISOString(),
        }),
      );
    },
    [applySemanticFlow, flow],
  );
  const disconnectFlowConnection = useCallback(
    (request: MediaFlowConnectionRequest): void => {
      applySemanticFlow(
        disconnectMediaFlowConnection({
          flow,
          request,
          updatedAt: new Date().toISOString(),
        }),
      );
    },
    [applySemanticFlow, flow],
  );
  const copyFlowNode = useCallback(
    (nodeId: string): void => {
      try {
        const clipboard = copyMediaFlowNode(flow, nodeId);
        setFlowClipboard(clipboard);
        setFlowRevisionNotice(`Copied ${clipboard.label}.`);
        setRuntimeError(null);
      } catch (error: unknown) {
        setRuntimeError(normalizeMediaError(error, "copy_media_flow_node"));
      }
    },
    [flow],
  );
  const copySelectedFlowNodes = useCallback(
    (nodeIds: readonly string[]): void => {
      try {
        const clipboard = copyMediaFlowNodes(flow, nodeIds);
        setFlowClipboard(clipboard);
        setFlowRevisionNotice(
          `Copied ${clipboard.label} with internal connections.`,
        );
        setRuntimeError(null);
      } catch (error: unknown) {
        setRuntimeError(normalizeMediaError(error, "copy_media_flow_nodes"));
      }
    },
    [flow],
  );
  const pasteFlowNode = useCallback((): string | null => {
    if (!flowClipboard) return null;
    try {
      const result = pasteMediaFlowNode({
        flow,
        payload: flowClipboard,
        updatedAt: new Date().toISOString(),
      });
      applySemanticFlow(result.flow);
      setFlowRevisionNotice(
        flowClipboard.nodes.length === 1
          ? `Pasted ${flowClipboard.label} as an independently remapped node.`
          : `Pasted ${flowClipboard.nodes.length} independently remapped nodes.`,
      );
      return result.nodeId;
    } catch (error: unknown) {
      setRuntimeError(normalizeMediaError(error, "paste_media_flow_node"));
      return null;
    }
  }, [applySemanticFlow, flow, flowClipboard]);
  const pasteInspection = useMemo(
    () =>
      flowClipboard
        ? inspectMediaFlowNodePaste(flow, flowClipboard)
        : { valid: false, reason: "Copy a node before pasting." },
    [flow, flowClipboard],
  );

  const refreshFlowHistory = useCallback((): void => {
    setFlowRevisionLoading(true);
    void getMediaFlow(flow.id)
      .then((history) => {
        setFlowHistory(history);
        setRuntimeError(null);
      })
      .catch((error: unknown) => {
        const failure = normalizeMediaError(error, "media_get_flow");
        if (failure.code === "RESOURCE_NOT_FOUND") {
          setFlowHistory(null);
          return;
        }
        setRuntimeError(failure);
      })
      .finally(() => setFlowRevisionLoading(false));
  }, [flow.id]);

  const refreshSavedFlows = useCallback((): void => {
    setSavedFlowsLoading(true);
    void listMediaFlows()
      .then((heads) => {
        setSavedFlows(
          heads.filter((head) => !head.flowId.startsWith("media-basic-")),
        );
        setRuntimeError(null);
      })
      .catch((error: unknown) => {
        setRuntimeError(normalizeMediaError(error, "media_list_flows"));
      })
      .finally(() => setSavedFlowsLoading(false));
  }, []);

  const openSavedFlow = useCallback(
    (flowId: string): void => {
      if (flowId === flow.id || savedFlowsLoading) {
        return;
      }
      if (
        hasUnsavedFlowChanges &&
        !window.confirm(`Discard unsaved workflow "${flow.name}"?`)
      ) {
        return;
      }
      setSavedFlowsLoading(true);
      setFlowRevisionNotice(null);
      void getMediaFlow(flowId)
        .then((history) => {
          const head = history.revisions.find((revision) => revision.isHead);
          if (!head) {
            throw new Error("The saved workflow has no head revision.");
          }
          const openedFlow = head.flow;
          clearSemanticHistory();
          setFlowHistory(history);
          setFlowRunOverlayId(null);
          setState((current) => ({
            ...current,
            activeSection: "flow",
            flow: openedFlow,
            flowLayout: head.layout,
          }));
          setFlowRevisionNotice(
            `Opened ${openedFlow.name} at revision ${head.revisionNumber}.`,
          );
          setRuntimeError(null);
        })
        .catch((error: unknown) => {
          setRuntimeError(normalizeMediaError(error, "media_get_flow"));
        })
        .finally(() => setSavedFlowsLoading(false));
    },
    [
      clearSemanticHistory,
      flow.id,
      flow.name,
      hasUnsavedFlowChanges,
      savedFlowsLoading,
    ],
  );

  const persistFlowRevision = useCallback(
    async (
      sourceFlow: MediaFlow,
      sourceLayout: MediaFlowLayout,
      changeSummary: string,
    ) => {
      if (flowRevisionLoading) {
        return null;
      }
      setFlowRevisionLoading(true);
      setFlowRevisionNotice(null);
      setRuntimeError(null);
      try {
        const result = await saveMediaFlowRevision({
          schemaVersion: 1,
          idempotencyKey: createFlowSaveId(),
          expectedHeadRevisionId:
            flowHistory?.flowId === sourceFlow.id
              ? (flowHistory.head?.headRevisionId ?? null)
              : null,
          changeSummary,
          flow: sourceFlow,
          layout: sourceLayout,
        });
        const history = await getMediaFlow(sourceFlow.id);
        setFlowHistory(history);
        setSavedFlows((current) => [
          result.head,
          ...current.filter((head) => head.flowId !== result.head.flowId),
        ]);
        setFlowRevisionNotice(
          result.created
            ? `Saved immutable revision ${result.head.headRevisionNumber}.`
            : `Revision ${result.head.headRevisionNumber} already matches this flow.`,
        );
        return result;
      } catch (error: unknown) {
        const failure = normalizeMediaError(error, "media_save_flow_revision");
        setRuntimeError(failure);
        if (failure.code === "FLOW_REVISION_CONFLICT") {
          void getMediaFlow(sourceFlow.id)
            .then(setFlowHistory)
            .catch(() => undefined);
        }
        return null;
      } finally {
        setFlowRevisionLoading(false);
      }
    },
    [flowHistory, flowRevisionLoading],
  );

  const persistBasicFlowRevision = useCallback(
    async (
      sourceFlow: MediaFlow,
      sourceLayout: MediaFlowLayout,
      changeSummary: string,
    ) => {
      const result = await saveMediaFlowRevision({
        schemaVersion: 1,
        idempotencyKey: createFlowSaveId(),
        expectedHeadRevisionId:
          basicFlowHeadRevisionIds.current.get(sourceFlow.id) ?? null,
        changeSummary,
        flow: sourceFlow,
        layout: sourceLayout,
      });
      basicFlowHeadRevisionIds.current.set(
        sourceFlow.id,
        result.head.headRevisionId,
      );
      return result;
    },
    [],
  );

  const saveCurrentFlowRevision = useCallback((): void => {
    const normalizedFlow = normalizeMediaFlowForPersistence(flow);
    const normalizedLayout = normalizeMediaFlowLayoutForPersistence(layout);
    setState((current) => ({
      ...current,
      flow: normalizedFlow,
      flowLayout: normalizedLayout,
    }));
    void persistFlowRevision(
      normalizedFlow,
      normalizedLayout,
      "Saved from Advanced",
    );
  }, [flow, layout, persistFlowRevision]);

  const openRecipeAsFlow = useCallback((): void => {
    if (state.target === "video") {
      openVideoCreationFlow();
      return;
    }
    clearSemanticHistory();
    setFlowHistory(null);
    setFlowRunOverlayId(null);
    setFlowRevisionNotice("Basic setup converted to Advanced.");
    const now = new Date().toISOString();
    const convertedFlow: MediaFlow = {
      ...recipeFlow,
      id: `media-flow-${createFlowSaveId()}`,
      createdAt: now,
      updatedAt: now,
    };
    setState((current) => ({
      ...current,
      activeSection: "flow",
      flow: convertedFlow,
      flowLayout: createMediaFlowLayout(convertedFlow),
    }));
  }, [clearSemanticHistory, openVideoCreationFlow, recipeFlow, state.target]);

  const restoreFlowRevision = useCallback(
    (revision: MediaFlowRevision): void => {
      const restoredFlow = revision.flow;
      void persistFlowRevision(
        restoredFlow,
        revision.layout,
        `Restored revision ${revision.revisionNumber}`,
      ).then((result) => {
        if (!result) {
          return;
        }
        clearSemanticHistory();
        setState((current) => ({
          ...current,
          activeSection: "flow",
          flow: restoredFlow,
          flowLayout: revision.layout,
        }));
      });
    },
    [clearSemanticHistory, persistFlowRevision],
  );

  const inspectPortableFlow = useCallback((): void => {
    if (flowPortabilityLoading || !supportsNativeMediaFlowPortability()) {
      return;
    }
    setFlowPortabilityLoading(true);
    setRuntimeError(null);
    setFlowRevisionNotice(null);
    void (async () => {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        title: "Inspect portable Media Studio flow",
        filters: [
          {
            name: "Media Studio flow",
            extensions: ["json"],
          },
        ],
      });
      if (typeof selected !== "string") {
        return;
      }
      const inspection = await inspectMediaFlowImport({
        schemaVersion: 1,
        sourcePath: selected,
      });
      setFlowImportSourcePath(selected);
      setFlowImportInspection(inspection);
    })()
      .catch((error: unknown) => {
        setRuntimeError(
          normalizeMediaError(error, "media_inspect_flow_import"),
        );
      })
      .finally(() => setFlowPortabilityLoading(false));
  }, [flowPortabilityLoading]);

  const importReviewedFlow = useCallback((): void => {
    if (
      flowPortabilityLoading ||
      !flowImportInspection?.canImport ||
      !flowImportSourcePath
    ) {
      return;
    }
    setFlowPortabilityLoading(true);
    setRuntimeError(null);
    setFlowRevisionNotice(null);
    void importMediaFlow({
      schemaVersion: 1,
      idempotencyKey: createFlowSaveId(),
      sourcePath: flowImportSourcePath,
      reviewToken: flowImportInspection.reviewToken,
    })
      .then(async (result) => {
        const history = await getMediaFlow(result.targetFlowId);
        const importedFlow = result.revision.flow;
        const importedLayout = result.revision.layout;
        clearSemanticHistory();
        setFlowHistory(history);
        const importedHead = history.head;
        if (importedHead) {
          setSavedFlows((current) => [
            importedHead,
            ...current.filter((head) => head.flowId !== history.flowId),
          ]);
        }
        setFlowRunOverlayId(null);
        setFlowImportInspection(null);
        setFlowImportSourcePath(null);
        setState((current) => ({
          ...current,
          activeSection: "flow",
          flow: importedFlow,
          flowLayout: importedLayout,
        }));
        setFlowRevisionNotice(
          `${
            result.created
              ? `Imported immutable revision 1 as isolated flow ${result.targetFlowId}.`
              : `This reviewed bundle already exists as ${result.targetFlowId}.`
          }`,
        );
      })
      .catch((error: unknown) => {
        setRuntimeError(normalizeMediaError(error, "media_import_flow"));
      })
      .finally(() => setFlowPortabilityLoading(false));
  }, [
    clearSemanticHistory,
    flowImportInspection,
    flowImportSourcePath,
    flowPortabilityLoading,
  ]);

  const exportCurrentFlowRevision = useCallback((): void => {
    const head = flowHistory?.flowId === flow.id ? flowHistory.head : null;
    if (
      flowPortabilityLoading ||
      hasUnsavedFlowChanges ||
      !head ||
      !supportsNativeMediaFlowPortability()
    ) {
      return;
    }
    setFlowPortabilityLoading(true);
    setRuntimeError(null);
    setFlowRevisionNotice(null);
    void (async () => {
      const destination = await saveDialog({
        title: `Export immutable flow revision ${head.headRevisionNumber}`,
        defaultPath: `media-flow-r${head.headRevisionNumber}.machdoch-flow.json`,
        filters: [
          {
            name: "Media Studio flow",
            extensions: ["json"],
          },
        ],
      });
      if (!destination) {
        return;
      }
      const exported = await exportMediaFlowRevision({
        schemaVersion: 1,
        idempotencyKey: createFlowSaveId(),
        revisionId: head.headRevisionId,
        destinationPath: destination,
      });
      setFlowRevisionNotice(
        `Exported ${exported.fileName} with ${exported.requirementCount} pinned node requirements (${exported.bundleDigest.slice(0, 19)}…).`,
      );
    })()
      .catch((error: unknown) => {
        setRuntimeError(
          normalizeMediaError(error, "media_export_flow_revision"),
        );
      })
      .finally(() => setFlowPortabilityLoading(false));
  }, [flow.id, flowHistory, flowPortabilityLoading, hasUnsavedFlowChanges]);

  const dismissFlowImport = useCallback((): void => {
    setFlowImportInspection(null);
    setFlowImportSourcePath(null);
  }, []);

  useEffect(() => {
    if (runtimeStatus?.storageReady) {
      refreshFlowHistory();
      refreshSavedFlows();
    }
  }, [refreshFlowHistory, refreshSavedFlows, runtimeStatus?.storageReady]);
  const runLocalFlow = useCallback((): void => {
    if (!localFlowExecution.supported || localFlowPending) {
      return;
    }
    const submittedFlow = normalizeMediaFlowForPersistence(flow);
    const submittedLayout = normalizeMediaFlowLayoutForPersistence(layout);
    const submittedPlan = compileMediaFlow({
      flow: submittedFlow,
      models,
      addons: activeModelCatalog.addons,
      compiledAt: new Date().toISOString(),
    });
    const submittedPlanSnapshot: MediaRunPlanSnapshot = {
      schemaVersion: 1,
      planId: submittedPlan.id,
      flowId: submittedFlow.id,
      flowFingerprint: submittedPlan.flowFingerprint,
      compiledAt: submittedPlan.compiledAt,
      nodes: submittedFlow.nodes.map(({ id, type, label, layer }) => ({
        id,
        type,
        label,
        layer,
      })),
      steps: submittedPlan.steps.map((step) => ({ ...step })),
    };
    setLocalFlowPending(true);
    setRuntimeError(null);
    setFlowRevisionNotice(null);
    void persistFlowRevision(
      submittedFlow,
      submittedLayout,
      "Pinned automatically for local utility execution",
    )
      .then((revisionResult) => {
        if (!revisionResult) {
          return null;
        }
        const runId = createRunId();
        const request: ExecuteLocalImageFlowRequest = {
          schemaVersion: 1,
          runId,
          flowId: submittedFlow.id,
          flowRevisionId: revisionResult.revision.revisionId,
          planId: submittedPlan.id,
          planSnapshot: submittedPlanSnapshot,
        };
        ++selectedRunDetailSequence.current;
        selectedRunIdRef.current = request.runId;
        setSelectedRunId(request.runId);
        setSelectedRun(null);
        setFlowRunOverlayId(request.runId);
        const imageSettings = readMediaFlowImageSettings(submittedFlow);
        generationQueue.enqueue({
          runId,
          recipe: {
            schemaVersion: 1,
            mode: "advanced",
            target: readMediaGenerationTarget(submittedFlow),
            flowId: submittedFlow.id,
            flowName: submittedFlow.name,
            flowRevisionId: revisionResult.revision.revisionId,
            flowRevisionNumber: revisionResult.revision.revisionNumber,
            planId: submittedPlan.id,
            prompt: readMediaFlowPrompt(submittedFlow),
            modelId: submittedPlan.model?.id ?? null,
            modelLabel: submittedPlan.model?.displayName ?? "Local flow",
            modelAddons: imageSettings?.modelAddons ?? [],
            outputBranches: [],
            imageSettings,
            videoSettings: readMediaVideoRecipeSettings(submittedFlow),
            resultDestination: "assets",
          },
          execute: () => executeMediaLocalImageFlow(request, submittedFlow),
        });
      })
      .catch((error: unknown) => {
        setRuntimeError(normalizeMediaError(error, "execute_local_image_flow"));
      })
      .finally(() => setLocalFlowPending(false));
  }, [
    activeModelCatalog.addons,
    flow,
    layout,
    localFlowExecution.supported,
    localFlowPending,
    models,
    persistFlowRevision,
  ]);
  const runAdvancedLocalImageFlow = useCallback((): void => {
    if (!advancedLocalImageExecution.supported || localFlowPending) return;
    const submittedFlow = normalizeMediaFlowForPersistence(flow);
    const submittedLayout = normalizeMediaFlowLayoutForPersistence(layout);
    const submittedPlan = compileMediaFlow({
      flow: submittedFlow,
      models,
      addons: activeModelCatalog.addons,
      compiledAt: new Date().toISOString(),
    });
    const submittedExecution = assessAdvancedLocalImageExecution({
      flow: submittedFlow,
      plan: submittedPlan,
      runtimeStatus,
      assets: runtimeAssets,
    });
    if (
      !submittedExecution.supported ||
      !submittedExecution.settings ||
      !submittedExecution.model ||
      !submittedExecution.taskNode
    ) {
      setRuntimeError(
        normalizeMediaError(
          new Error(submittedExecution.reason),
          "prepare_advanced_image_generation",
        ),
      );
      return;
    }
    setLocalFlowPending(true);
    setRuntimeError(null);
    setFlowRevisionNotice(null);
    void persistFlowRevision(
      submittedFlow,
      submittedLayout,
      "Pinned automatically for local diffusion execution",
    )
      .then((revisionResult) => {
        if (!revisionResult) return null;
        const pinnedFlow = revisionResult.revision.flow;
        const pinnedPlan = compileMediaFlow({
          flow: pinnedFlow,
          models,
          addons: activeModelCatalog.addons,
          compiledAt: new Date().toISOString(),
        });
        const pinnedExecution = assessAdvancedLocalImageExecution({
          flow: pinnedFlow,
          plan: pinnedPlan,
          runtimeStatus,
          assets: runtimeAssets,
        });
        if (
          !pinnedExecution.supported ||
          !pinnedExecution.settings ||
          !pinnedExecution.model ||
          !pinnedExecution.taskNode
        ) {
          throw new Error(pinnedExecution.reason);
        }
        const pinnedPlanSnapshot: MediaRunPlanSnapshot = {
          schemaVersion: 1,
          planId: pinnedPlan.id,
          flowId: pinnedFlow.id,
          flowFingerprint: pinnedPlan.flowFingerprint,
          compiledAt: pinnedPlan.compiledAt,
          nodes: pinnedFlow.nodes.map(({ id, type, label, layer }) => ({
            id,
            type,
            label,
            layer,
          })),
          steps: pinnedPlan.steps.map((step) => ({ ...step })),
        };
        const settings = pinnedExecution.settings;
        const model = pinnedExecution.model;
        const taskConfig = pinnedExecution.taskNode.config;
        const runId = createRunId();
        const hasConditioning =
          settings.referenceImages.length > 0 ||
          settings.baseImageAssetId !== null ||
          settings.poseImageAssetId !== null;
        const request = {
          schemaVersion: 1,
          runId,
          flowId: pinnedFlow.id,
          flowRevisionId: revisionResult.revision.revisionId,
          flowName: pinnedFlow.name,
          planId: pinnedPlan.id,
          prompt: normalizeMediaSubmissionText(settings.prompt),
          modelId: model.id,
          modelLabel: model.displayName,
          outputCount: settings.outputCount,
          diagnosticCount: pinnedPlan.diagnostics.length,
          aspectRatio: settings.aspectRatio,
          outputFormat: "png",
          modelPolicy: settings.modelPolicy,
          modelAddons: settings.modelAddons,
          transparentBackground: settings.transparentBackground,
          subjectCutoutModelPriority: settings.transparentBackground
            ? readFlowSubjectCutoutModelPriority(pinnedFlow)
            : [],
          negativePrompt: "",
          referenceImages: settings.referenceImages,
          baseImageAssetId: settings.baseImageAssetId,
          editMask: settings.baseImageAssetId
            ? (normalizeMediaImageMask(settings.editMask) ?? null)
            : null,
          poseImageAssetId: settings.poseImageAssetId,
          poseStrength: settings.poseImageAssetId
            ? settings.poseStrength
            : null,
          poseStart: settings.poseImageAssetId
            ? (settings.poseStart ?? 0)
            : null,
          poseEnd: settings.poseImageAssetId ? (settings.poseEnd ?? 1) : null,
          seed: settings.seed ?? null,
          editStrength:
            hasConditioning && typeof taskConfig.editStrength === "number"
              ? taskConfig.editStrength
              : undefined,
          maskStrength:
            settings.baseImageAssetId &&
            normalizeMediaImageMask(settings.editMask) !== null &&
            typeof taskConfig.maskStrength === "number"
              ? taskConfig.maskStrength
              : undefined,
          requireChromaBackground:
            hasConditioning && taskConfig.requireChromaBackground === true,
          memoryProfile:
            taskConfig.memoryProfile === "memory-saver" ||
            taskConfig.memoryProfile === "balanced" ||
            taskConfig.memoryProfile === "maximum-speed"
              ? taskConfig.memoryProfile
              : "auto",
          outputBranches: pinnedExecution.outputBranches,
          planSnapshot: pinnedPlanSnapshot,
        } satisfies GenerateMediaImagesRequest;
        ++selectedRunDetailSequence.current;
        selectedRunIdRef.current = runId;
        setSelectedRunId(runId);
        setSelectedRun(null);
        setFlowRunOverlayId(runId);
        generationQueue.enqueue({
          runId,
          recipe: {
            schemaVersion: 1,
            mode: "advanced",
            target: "image",
            flowId: pinnedFlow.id,
            flowName: pinnedFlow.name,
            flowRevisionId: revisionResult.revision.revisionId,
            flowRevisionNumber: revisionResult.revision.revisionNumber,
            planId: pinnedPlan.id,
            prompt: request.prompt,
            modelId: model.id,
            modelLabel: model.displayName,
            modelAddons: settings.modelAddons,
            outputBranches: pinnedExecution.outputBranches,
            imageSettings: settings,
            videoSettings: null,
            resultDestination: "assets",
          },
          execute: () => generateMediaImages(request),
          cancel: () => cancelMediaRun(runId),
        });
        return null;
      })
      .catch((error: unknown) => {
        setRuntimeError(
          normalizeMediaError(error, "generate_advanced_local_image"),
        );
      })
      .finally(() => setLocalFlowPending(false));
  }, [
    activeModelCatalog.addons,
    advancedLocalImageExecution.supported,
    flow,
    layout,
    localFlowPending,
    models,
    persistFlowRevision,
    runtimeAssets,
    runtimeStatus,
  ]);
  const runVideoFlowDocument = useCallback(
    (
      sourceFlow: MediaFlow,
      sourceLayout: MediaFlowLayout,
      _sourcePlan: MediaCompiledPlan,
      _sourceExecution: ReturnType<typeof assessVideoFlow>,
      basicExecution: boolean,
    ): void => {
      if (localFlowPending) return;
      const submittedFlow = normalizeMediaFlowForPersistence(sourceFlow);
      const submittedLayout =
        normalizeMediaFlowLayoutForPersistence(sourceLayout);
      const submittedPlan = compileMediaFlow({
        flow: submittedFlow,
        models,
        addons: activeModelCatalog.addons,
        compiledAt: new Date().toISOString(),
      });
      const submittedExecution = assessVideoFlow(submittedFlow, submittedPlan);
      if (!submittedExecution.supported) {
        setRuntimeError(
          normalizeMediaError(
            new Error(submittedExecution.reason),
            "prepare_video_generation",
          ),
        );
        return;
      }
      const normalizedWorkspaceRoot = workspaceRoot?.trim();
      if (!normalizedWorkspaceRoot) return;
      const sourcePlanSnapshot: MediaRunPlanSnapshot = {
        schemaVersion: 1,
        planId: submittedPlan.id,
        flowId: submittedFlow.id,
        flowFingerprint: submittedPlan.flowFingerprint,
        compiledAt: submittedPlan.compiledAt,
        nodes: submittedFlow.nodes.map(({ id, type, label, layer }) => ({
          id,
          type,
          label,
          layer,
        })),
        steps: submittedPlan.steps.map((step) => ({ ...step })),
      };
      const updateNotice = (notice: string | null): void => {
        if (!basicExecution) setFlowRevisionNotice(notice);
      };
      const updateOverlay = (runId: string): void => {
        if (!basicExecution) setFlowRunOverlayId(runId);
      };
      const persistRevision = basicExecution
        ? persistBasicFlowRevision
        : persistFlowRevision;
      setLocalFlowPending(true);
      setRuntimeError(null);
      if (basicExecution) {
        ++selectedRunDetailSequence.current;
        selectedRunIdRef.current = null;
        setSelectedRunId(null);
        setSelectedRun(null);
      }
      updateNotice(null);
      void persistRevision(
        submittedFlow,
        submittedLayout,
        "Pinned automatically for local video execution",
      )
        .then(async (revisionResult) => {
          if (
            !revisionResult ||
            !submittedExecution.videoNode ||
            !submittedExecution.videoModel
          ) {
            return null;
          }
          const queueRunId = createRunId();
          const imageSettings = readMediaFlowImageSettings(submittedFlow);
          const prompt = normalizeMediaSubmissionText(
            readMediaFlowPrompt(submittedFlow),
          );
          const recipeSnapshot: MediaGenerationRecipeSnapshot = {
            schemaVersion: 1,
            mode: basicExecution ? "basic" : "advanced",
            target: "video",
            flowId: submittedFlow.id,
            flowName: submittedFlow.name,
            flowRevisionId: revisionResult.revision.revisionId,
            flowRevisionNumber: revisionResult.revision.revisionNumber,
            planId: submittedPlan.id,
            prompt,
            modelId: submittedExecution.videoModel.id,
            modelLabel: submittedExecution.videoModel.displayName,
            modelAddons: imageSettings?.modelAddons ?? [],
            outputBranches: [],
            imageSettings,
            videoSettings: readMediaVideoRecipeSettings(submittedFlow),
            resultDestination: "assets",
          };
          ++selectedRunDetailSequence.current;
          selectedRunIdRef.current = queueRunId;
          setSelectedRunId(queueRunId);
          setSelectedRun(null);
          updateOverlay(queueRunId);
          let activeNativeRunId = queueRunId;
          generationQueue.enqueue({
            runId: queueRunId,
            recipe: recipeSnapshot,
            execute: async () => {
              const resolvedFlow =
                resolveMediaFlowVariables(submittedFlow).flow;
              const promptNode = resolvedFlow.nodes.find(
                (node) => node.type === "source.prompt",
              );
              const prompt =
                typeof promptNode?.config.prompt === "string"
                  ? promptNode.config.prompt.trim()
                  : "";
              const configuredAspect =
                submittedExecution.videoNode.config.aspectRatio;
              const aspectRatio =
                configuredAspect === "16:9" ||
                configuredAspect === "9:16" ||
                configuredAspect === "21:9"
                  ? configuredAspect
                  : "1:1";
              const videoConfig = submittedExecution.videoNode.config;
              const resolution =
                videoConfig.resolution === "preview-512" ||
                videoConfig.resolution === "quality-768"
                  ? videoConfig.resolution
                  : "quality-640";
              const loopMode =
                videoConfig.loopMode === "ping-pong" ||
                videoConfig.loopMode === "seamless"
                  ? videoConfig.loopMode
                  : "none";
              const matteQuality =
                videoConfig.matteQuality === "fast" ||
                videoConfig.matteQuality === "balanced"
                  ? videoConfig.matteQuality
                  : "production";
              const encodingQuality =
                videoConfig.encodingQuality === "draft" ||
                videoConfig.encodingQuality === "balanced" ||
                videoConfig.encodingQuality === "production" ||
                videoConfig.encodingQuality === "lossless"
                  ? videoConfig.encodingQuality
                  : "lossless";
              const memoryProfile =
                videoConfig.memoryProfile === "memory-saver" ||
                videoConfig.memoryProfile === "balanced" ||
                videoConfig.memoryProfile === "maximum-speed"
                  ? videoConfig.memoryProfile
                  : "auto";
              const selectedVideoModelId = submittedExecution.videoModel.id;
              if (!isExecutableLocalVideoModelId(selectedVideoModelId)) {
                throw new Error(
                  "The resolved video model does not have an executable local adapter.",
                );
              }
              const videoExecutionSettings = resolveMediaVideoExecutionSettings(
                videoConfig,
                submittedExecution.videoModel.architecture,
              );
              const runVideo = (
                firstFrameAssetId: string,
                lastFrameAssetId: string,
              ) => {
                activeNativeRunId = queueRunId;
                const request = {
                  schemaVersion: 1,
                  runId: queueRunId,
                  flowId: submittedFlow.id,
                  flowRevisionId: revisionResult.revision.revisionId,
                  flowName: submittedFlow.name,
                  planId: submittedPlan.id,
                  prompt,
                  modelId: selectedVideoModelId,
                  modelLabel: submittedExecution.videoModel.displayName,
                  diagnosticCount: submittedPlan.diagnostics.length,
                  workspaceRoot: normalizedWorkspaceRoot,
                  firstFrameAssetId,
                  lastFrameAssetId,
                  aspectRatio,
                  resolution,
                  outputFormat: "webm",
                  transparentBackground:
                    videoConfig.transparentBackground === true,
                  loopMode,
                  fps:
                    typeof videoConfig.fps === "number" ? videoConfig.fps : 8,
                  numFrames:
                    typeof videoConfig.numFrames === "number"
                      ? videoConfig.numFrames
                      : 33,
                  numInferenceSteps: videoExecutionSettings.numInferenceSteps,
                  guidanceScale: videoExecutionSettings.guidanceScale,
                  seed:
                    typeof videoConfig.seed === "number" ? videoConfig.seed : 0,
                  negativePrompt:
                    typeof videoConfig.negativePrompt === "string"
                      ? videoConfig.negativePrompt
                      : "",
                  matteQuality,
                  encodingQuality,
                  memoryProfile,
                  experimentalLowMemory: true,
                  animatedBackground: submittedExecution.animatedBackground,
                  planSnapshot: sourcePlanSnapshot,
                } satisfies GenerateMediaVideoRequest;
                return generateMediaVideo(request);
              };
              if (
                submittedExecution.generatedFrame &&
                submittedExecution.imageModel &&
                submittedExecution.imageSettings
              ) {
                const settings = submittedExecution.imageSettings;
                const imageRequest = {
                  schemaVersion: 1,
                  runId: createRunId(),
                  flowId: submittedFlow.id,
                  flowRevisionId: revisionResult.revision.revisionId,
                  flowName: `${submittedFlow.name} · endpoint frame`,
                  planId: submittedPlan.id,
                  prompt: settings.prompt,
                  modelId: submittedExecution.imageModel.id,
                  modelLabel: submittedExecution.imageModel.displayName,
                  outputCount: 1,
                  diagnosticCount: submittedPlan.diagnostics.length,
                  aspectRatio: settings.aspectRatio,
                  outputFormat:
                    settings.outputFormat === "jpeg" ||
                    settings.outputFormat === "webp"
                      ? settings.outputFormat
                      : "png",
                  modelPolicy: settings.modelPolicy,
                  modelAddons: settings.modelAddons,
                  transparentBackground: true,
                  subjectCutoutModelPriority:
                    readFlowSubjectCutoutModelPriority(resolvedFlow),
                  referenceImages: [],
                  baseImageAssetId: null,
                  editMask: null,
                  poseImageAssetId: null,
                  poseStrength: null,
                  poseStart: null,
                  poseEnd: null,
                  seed: settings.seed ?? null,
                  memoryProfile: settings.memoryProfile ?? "auto",
                  outputBranches: [
                    createIdentityImageOutputBranch(
                      settings.outputFormat === "jpeg" ||
                        settings.outputFormat === "webp"
                        ? settings.outputFormat
                        : "png",
                      resolvedFlow.nodes.find(
                        (node) => node.type === "task.generate-image",
                      )?.id ?? "generate",
                    ),
                  ],
                  planSnapshot: sourcePlanSnapshot,
                } satisfies GenerateMediaImagesRequest;
                activeNativeRunId = imageRequest.runId;
                generationQueue.updateProgress(
                  queueRunId,
                  0.02,
                  `Generating endpoint with ${submittedExecution.imageModel.displayName}`,
                );
                const imageDetail = await generateMediaImages(imageRequest);
                const endpoint = imageDetail.assets.find(
                  (asset) => asset.kind === "image",
                );
                if (!endpoint) {
                  throw new Error(
                    imageDetail.error ??
                      "The connected image stage completed without a published endpoint frame.",
                  );
                }
                generationQueue.updateProgress(
                  queueRunId,
                  0.05,
                  "Endpoint ready; starting video generation",
                );
                return runVideo(endpoint.id, endpoint.id);
              }
              if (
                !submittedExecution.firstFrameAssetId ||
                !submittedExecution.lastFrameAssetId
              ) {
                throw new Error(
                  "The video endpoint assets are no longer available.",
                );
              }
              return runVideo(
                submittedExecution.firstFrameAssetId,
                submittedExecution.lastFrameAssetId,
              );
            },
            cancel: () => cancelMediaRun(activeNativeRunId),
          });
          return null;
        })
        .catch((error: unknown) => {
          setRuntimeError(normalizeMediaError(error, "generate_local_video"));
        })
        .finally(() => setLocalFlowPending(false));
    },
    [
      assessVideoFlow,
      activeModelCatalog.addons,
      localFlowPending,
      models,
      persistBasicFlowRevision,
      persistFlowRevision,
      workspaceRoot,
    ],
  );
  const runVideoFlow = useCallback(
    (): void =>
      runVideoFlowDocument(flow, layout, plan, videoFlowExecution, false),
    [flow, layout, plan, runVideoFlowDocument, videoFlowExecution],
  );
  const runRemoteEditFlow = useCallback((): void => {
    if (!remoteEditExecution.supported || remoteEditPending) {
      return;
    }
    const submittedFlow = normalizeMediaFlowForPersistence(flow);
    const submittedLayout = normalizeMediaFlowLayoutForPersistence(layout);
    const submittedPlan = compileMediaFlow({
      flow: submittedFlow,
      models,
      addons: activeModelCatalog.addons,
      compiledAt: new Date().toISOString(),
    });
    const submittedPlanSnapshot: MediaRunPlanSnapshot = {
      schemaVersion: 1,
      planId: submittedPlan.id,
      flowId: submittedFlow.id,
      flowFingerprint: submittedPlan.flowFingerprint,
      compiledAt: submittedPlan.compiledAt,
      nodes: submittedFlow.nodes.map(({ id, type, label, layer }) => ({
        id,
        type,
        label,
        layer,
      })),
      steps: submittedPlan.steps.map((step) => ({ ...step })),
    };
    setRemoteEditPending(true);
    setRuntimeError(null);
    setFlowRevisionNotice(null);
    void persistFlowRevision(
      submittedFlow,
      submittedLayout,
      "Pinned automatically for confirmed remote image edit",
    )
      .then((revisionResult) => {
        if (!revisionResult) {
          return null;
        }
        const runId = createRunId();
        const request: ExecuteRemoteImageEditFlowRequest = {
          schemaVersion: 1,
          runId,
          flowId: submittedFlow.id,
          flowRevisionId: revisionResult.revision.revisionId,
          planId: submittedPlan.id,
          planSnapshot: submittedPlanSnapshot,
          allowRemoteUpload: true,
        };
        ++selectedRunDetailSequence.current;
        selectedRunIdRef.current = request.runId;
        setSelectedRunId(request.runId);
        setSelectedRun(null);
        setFlowRunOverlayId(request.runId);
        const imageSettings = readMediaFlowImageSettings(submittedFlow);
        generationQueue.enqueue({
          runId,
          recipe: {
            schemaVersion: 1,
            mode: "advanced",
            target: readMediaGenerationTarget(submittedFlow),
            flowId: submittedFlow.id,
            flowName: submittedFlow.name,
            flowRevisionId: revisionResult.revision.revisionId,
            flowRevisionNumber: revisionResult.revision.revisionNumber,
            planId: submittedPlan.id,
            prompt: readMediaFlowPrompt(submittedFlow),
            modelId: submittedPlan.model?.id ?? null,
            modelLabel: submittedPlan.model?.displayName ?? "Image edit",
            modelAddons: imageSettings?.modelAddons ?? [],
            outputBranches: compileMediaImageOutputBranches(submittedFlow),
            imageSettings,
            videoSettings: null,
            resultDestination: "assets",
          },
          execute: () =>
            executeMediaRemoteImageEditFlow(request, submittedFlow),
        });
      })
      .catch((error: unknown) => {
        setRuntimeError(
          normalizeMediaError(error, "execute_remote_image_edit_flow"),
        );
      })
      .finally(() => setRemoteEditPending(false));
  }, [
    activeModelCatalog.addons,
    flow,
    layout,
    models,
    persistFlowRevision,
    remoteEditExecution,
    remoteEditPending,
  ]);
  const runRecipeGeneration = useCallback(() => {
    const submittedRecipe: ImageRecipeSettings = {
      ...state.recipe,
      prompt: normalizeMediaSubmissionText(state.recipe.prompt),
      referenceImages: structuredClone(state.recipe.referenceImages),
      modelAddons: structuredClone(state.recipe.modelAddons),
      editMask: state.recipe.editMask
        ? structuredClone(state.recipe.editMask)
        : null,
    };
    const submittedFlow = normalizeMediaFlowForPersistence(recipeFlow);
    const submittedLayout =
      normalizeMediaFlowLayoutForPersistence(recipeLayout);
    const submittedPlan = compileMediaFlow({
      flow: submittedFlow,
      models,
      addons: activeModelCatalog.addons,
      compiledAt: new Date().toISOString(),
    });
    const submittedPlanSnapshot: MediaRunPlanSnapshot = {
      schemaVersion: 1,
      planId: submittedPlan.id,
      flowId: submittedFlow.id,
      flowFingerprint: submittedPlan.flowFingerprint,
      compiledAt: submittedPlan.compiledAt,
      nodes: submittedFlow.nodes.map(({ id, type, label, layer }) => ({
        id,
        type,
        label,
        layer,
      })),
      steps: submittedPlan.steps.map((step) => ({ ...step })),
    };
    const submittedRemoteEditExecution = assessRemoteEditExecution({
      plan: submittedPlan,
      flow: submittedFlow,
      assets: runtimeAssets,
      runtimeMode: runtimeStatus?.mode ?? null,
      directReferenceImageModelIds:
        runtimeStatus?.directReferenceImageModelIds ?? null,
    });
    const model = submittedPlan.model;
    const isSvg = submittedRecipe.outputFormat === "svg";
    const isSvgVectorization = isSvg && submittedRecipe.svgMode === "vectorize";
    const hasReferences = submittedRecipe.referenceImages.length > 0;
    const hasBaseImage = submittedRecipe.baseImageAssetId !== null;
    const hasEditMask = hasMediaImageMaskContent(submittedRecipe.editMask);
    const hasPoseImage = submittedRecipe.poseImageAssetId !== null;
    const hasImageConditioning = hasReferences || hasBaseImage || hasPoseImage;
    const localReferenceReady =
      (!hasReferences && !hasBaseImage) ||
      (model !== null &&
        (runtimeStatus?.directReferenceImageModelIds ?? []).includes(model.id));
    const localInpaintingReady =
      !hasEditMask ||
      (model !== null &&
        (runtimeStatus?.directInpaintingModelIds ?? []).includes(model.id));
    const localPoseReady =
      !hasPoseImage ||
      (model !== null &&
        (runtimeStatus?.directPoseModelIds ?? []).includes(model.id));
    const localConditionedGeneration =
      !isSvg &&
      hasImageConditioning &&
      model?.target === "local" &&
      localReferenceReady &&
      localInpaintingReady &&
      localPoseReady;
    const imageTaskConfig = submittedFlow.nodes.find(
      (node) =>
        node.type === "task.generate-image" || node.type === "task.edit-image",
    )?.config;
    if (
      submittedPlan.status !== "ready" ||
      !model ||
      (isSvg
        ? !(runtimeStatus?.directGenerationModelIds ?? []).includes(model.id) ||
          (hasReferences &&
            !(runtimeStatus?.directReferenceImageModelIds ?? []).includes(
              model.id,
            ))
        : hasImageConditioning
          ? !localConditionedGeneration &&
            !(
              hasReferences &&
              !hasBaseImage &&
              !hasPoseImage &&
              submittedRemoteEditExecution.supported
            )
          : !(runtimeStatus?.directGenerationModelIds ?? []).includes(
              model.id,
            )) ||
      submittedRecipe.qualityGateEnabled ||
      generationPending
    ) {
      return;
    }
    setGenerationPending(true);
    setRuntimeError(null);
    ++selectedRunDetailSequence.current;
    selectedRunIdRef.current = null;
    setSelectedRunId(null);
    setSelectedRun(null);
    void persistBasicFlowRevision(
      submittedFlow,
      submittedLayout,
      "Pinned automatically for direct generation",
    )
      .then((revisionResult) => {
        if (!revisionResult) {
          return null;
        }
        const runId = createRunId();
        ++selectedRunDetailSequence.current;
        selectedRunIdRef.current = runId;
        setSelectedRunId(runId);
        setSelectedRun(null);
        const recipeSnapshot: MediaGenerationRecipeSnapshot = {
          schemaVersion: 1,
          mode: "basic",
          target: isSvg ? "svg" : "image",
          flowId: submittedFlow.id,
          flowName: submittedFlow.name,
          flowRevisionId: revisionResult.revision.revisionId,
          flowRevisionNumber: revisionResult.revision.revisionNumber,
          planId: submittedPlan.id,
          prompt: submittedRecipe.prompt,
          modelId: model.id,
          modelLabel: submittedPlan.preflight.modelLabel,
          modelAddons: submittedRecipe.modelAddons,
          outputBranches: isSvg
            ? []
            : compileMediaImageOutputBranches(submittedFlow),
          imageSettings: submittedRecipe,
          videoSettings: null,
          resultDestination: "assets",
        };
        if (isSvg) {
          const candidateCount = isSvgVectorization
            ? 1
            : Math.max(
                submittedRecipe.outputCount,
                Math.min(
                  model.id.startsWith("recraft:") ? 6 : 16,
                  submittedRecipe.svgCandidateCount ?? 6,
                ),
              );
          const request = {
            schemaVersion: 1,
            runId,
            flowId: submittedFlow.id,
            flowRevisionId: revisionResult.revision.revisionId,
            flowName: submittedFlow.name,
            planId: submittedPlan.id,
            prompt: submittedRecipe.prompt,
            modelId: model.id,
            modelLabel: submittedPlan.preflight.modelLabel,
            outputCount: submittedPlan.preflight.generatedCandidates,
            candidateCount,
            diagnosticCount: submittedPlan.diagnostics.length,
            aspectRatio: submittedRecipe.aspectRatio,
            modelPolicy: submittedRecipe.modelPolicy,
            transparentBackground: submittedRecipe.transparentBackground,
            mode: submittedRecipe.svgMode ?? "generate",
            autoCrop: submittedRecipe.svgAutoCrop !== false,
            targetSize: submittedRecipe.svgTargetSize ?? 1024,
            style: submittedRecipe.svgStyle ?? "illustration",
            textPolicy: submittedRecipe.svgTextPolicy ?? "avoid",
            criticEnabled:
              !isSvgVectorization &&
              model.target === "remote" &&
              submittedRecipe.modelPolicy === "quality" &&
              submittedRecipe.svgCriticEnabled === true,
            referenceImages: submittedRecipe.referenceImages,
            allowRemoteUpload: model.target === "remote" && hasReferences,
            planSnapshot: submittedPlanSnapshot,
          } satisfies GenerateMediaSvgRequest;
          generationQueue.enqueue({
            runId,
            recipe: recipeSnapshot,
            execute: () => generateMediaSvg(request),
          });
          return;
        }
        if (
          hasReferences &&
          !hasBaseImage &&
          !hasPoseImage &&
          !localConditionedGeneration
        ) {
          const request: ExecuteRemoteImageEditFlowRequest = {
            schemaVersion: 1,
            runId,
            flowId: submittedFlow.id,
            flowRevisionId: revisionResult.revision.revisionId,
            planId: submittedPlan.id,
            planSnapshot: submittedPlanSnapshot,
            allowRemoteUpload: true,
          };
          generationQueue.enqueue({
            runId,
            recipe: recipeSnapshot,
            execute: () =>
              executeMediaRemoteImageEditFlow(request, submittedFlow),
          });
          return;
        }
        const request = {
          schemaVersion: 1,
          runId,
          flowId: submittedFlow.id,
          flowRevisionId: revisionResult.revision.revisionId,
          flowName: submittedFlow.name,
          planId: submittedPlan.id,
          prompt: submittedRecipe.prompt,
          modelId: model.id,
          modelLabel: submittedPlan.preflight.modelLabel,
          outputCount: submittedPlan.preflight.generatedCandidates,
          diagnosticCount: submittedPlan.diagnostics.length,
          aspectRatio: submittedRecipe.aspectRatio,
          outputFormat:
            submittedRecipe.outputFormat === "svg"
              ? "png"
              : submittedRecipe.outputFormat,
          modelPolicy: submittedRecipe.modelPolicy,
          modelAddons: submittedRecipe.modelAddons,
          transparentBackground: submittedRecipe.transparentBackground,
          subjectCutoutModelPriority:
            readFlowSubjectCutoutModelPriority(submittedFlow),
          negativePrompt: "",
          referenceImages: localConditionedGeneration
            ? submittedRecipe.referenceImages
            : [],
          baseImageAssetId: localConditionedGeneration
            ? submittedRecipe.baseImageAssetId
            : null,
          editMask:
            localConditionedGeneration && submittedRecipe.baseImageAssetId
              ? (normalizeMediaImageMask(submittedRecipe.editMask) ?? null)
              : null,
          poseImageAssetId: localConditionedGeneration
            ? submittedRecipe.poseImageAssetId
            : null,
          poseStrength:
            localConditionedGeneration && submittedRecipe.poseImageAssetId
              ? submittedRecipe.poseStrength
              : null,
          poseStart:
            localConditionedGeneration && submittedRecipe.poseImageAssetId
              ? (submittedRecipe.poseStart ?? 0)
              : null,
          poseEnd:
            localConditionedGeneration && submittedRecipe.poseImageAssetId
              ? (submittedRecipe.poseEnd ?? 1)
              : null,
          seed: submittedRecipe.seed ?? null,
          editStrength:
            localConditionedGeneration &&
            typeof imageTaskConfig?.editStrength === "number"
              ? imageTaskConfig.editStrength
              : undefined,
          maskStrength:
            localConditionedGeneration &&
            submittedRecipe.baseImageAssetId &&
            normalizeMediaImageMask(submittedRecipe.editMask) !== null &&
            typeof imageTaskConfig?.maskStrength === "number"
              ? imageTaskConfig.maskStrength
              : undefined,
          requireChromaBackground:
            localConditionedGeneration &&
            imageTaskConfig?.requireChromaBackground === true,
          memoryProfile:
            imageTaskConfig?.memoryProfile === "memory-saver" ||
            imageTaskConfig?.memoryProfile === "balanced" ||
            imageTaskConfig?.memoryProfile === "maximum-speed"
              ? imageTaskConfig.memoryProfile
              : "auto",
          outputBranches: compileMediaImageOutputBranches(submittedFlow),
          planSnapshot: submittedPlanSnapshot,
        } satisfies GenerateMediaImagesRequest;
        generationQueue.enqueue({
          runId,
          recipe: recipeSnapshot,
          execute: () => generateMediaImages(request),
        });
      })
      .catch((error: unknown) => {
        setRuntimeError(
          normalizeMediaError(
            error,
            hasImageConditioning
              ? "generate_images_with_references"
              : "generate_images",
          ),
        );
      })
      .finally(() => setGenerationPending(false));
  }, [
    activeModelCatalog.addons,
    generationPending,
    models,
    persistBasicFlowRevision,
    recipeFlow,
    recipeLayout,
    runtimeAssets,
    runtimeStatus?.directGenerationModelIds,
    runtimeStatus?.directInpaintingModelIds,
    runtimeStatus?.directPoseModelIds,
    runtimeStatus?.directReferenceImageModelIds,
    runtimeStatus?.mode,
    state.recipe.aspectRatio,
    state.recipe.baseImageAssetId,
    state.recipe.editMask,
    state.recipe.modelAddons,
    state.recipe.modelPolicy,
    state.recipe.outputCount,
    state.recipe.outputFormat,
    state.recipe.poseImageAssetId,
    state.recipe.poseStrength,
    state.recipe.prompt,
    state.recipe.qualityGateEnabled,
    state.recipe.referenceImages,
    state.recipe.svgCandidateCount,
    state.recipe.svgCriticEnabled,
    state.recipe.svgAutoCrop,
    state.recipe.svgMode,
    state.recipe.svgStyle,
    state.recipe.svgTargetSize,
    state.recipe.svgTextPolicy,
    state.recipe.transparentBackground,
  ]);
  const runQuickVideo = useCallback((): void => {
    if (localFlowPending || !basicVideoDraft) return;
    if (!basicVideoDraft.execution.supported) {
      setRuntimeError(
        normalizeMediaError(
          new Error(basicVideoDraft.execution.reason),
          "prepare_quick_video",
        ),
      );
      return;
    }
    runVideoFlowDocument(
      basicVideoDraft.flow,
      basicVideoDraft.layout,
      basicVideoDraft.plan,
      basicVideoDraft.execution,
      true,
    );
  }, [basicVideoDraft, localFlowPending, runVideoFlowDocument]);
  const runGeneration = useCallback(() => {
    if (state.target === "video") {
      runQuickVideo();
      return;
    }
    runRecipeGeneration();
  }, [runQuickVideo, runRecipeGeneration, state.target]);
  const selectRun = useCallback(
    (runId: string) => {
      const requestSequence = ++selectedRunDetailSequence.current;
      selectedRunIdRef.current = runId;
      setSelectedRunId(runId);
      setSelectedRun(null);
      setSelectedRunRecipe(null);
      const queuedJob = generationQueue.getJob(runId);
      if (queuedJob && !runtimeRuns.some((run) => run.id === runId)) {
        setSelectedRun(generationJobToRunDetail(queuedJob));
        setSelectedRunRecipe(queuedJob.recipe);
        return;
      }
      void getMediaRunDetail(runId)
        .then(async (detail) => {
          let recipe = queuedJob?.recipe ?? null;
          if (!recipe && detail.flowRevisionId) {
            try {
              const history = await getMediaFlow(detail.flowId);
              const revision = history.revisions.find(
                (candidate) => candidate.revisionId === detail.flowRevisionId,
              );
              if (revision)
                recipe = recipeSnapshotFromRevision(detail, revision);
            } catch {
              recipe = null;
            }
          }
          return { detail, recipe };
        })
        .then(({ detail, recipe }) => {
          if (
            requestSequence !== selectedRunDetailSequence.current ||
            selectedRunIdRef.current !== runId
          ) {
            return;
          }
          setSelectedRun(detail);
          setSelectedRunRecipe(recipe);
          if (detail.failure) {
            presentRunFailure(detail.failure);
          } else {
            announcedFailureKey.current = null;
            setRuntimeError(null);
          }
        })
        .catch((error: unknown) => {
          if (
            requestSequence === selectedRunDetailSequence.current &&
            selectedRunIdRef.current === runId
          ) {
            setRuntimeError(normalizeMediaError(error, "inspect_run"));
          }
        });
    },
    [presentRunFailure, runtimeRuns],
  );
  useEffect(() => {
    if (!loaded || !openRunId) {
      return;
    }
    setState((current) => ({ ...current, activeSection: "runs" }));
    selectRun(openRunId);
    onOpenRunHandled?.();
  }, [loaded, onOpenRunHandled, openRunId, selectRun]);
  useEffect(() => {
    if (!loaded || !openSection) return;
    setState((current) => ({ ...current, activeSection: openSection }));
    onOpenSectionHandled?.();
  }, [loaded, onOpenSectionHandled, openSection]);
  useEffect(() => {
    if (!loaded || draftPrompt === null || draftPrompt === undefined) return;
    const normalizedPrompt = draftPrompt.trim().slice(0, 8_000);
    setState((current) => ({
      ...current,
      activeSection: "generate",
      ...(normalizedPrompt
        ? {
            recipe: {
              ...current.recipe,
              prompt: normalizedPrompt,
            },
          }
        : {}),
    }));
    onDraftPromptHandled?.();
  }, [draftPrompt, loaded, onDraftPromptHandled]);
  useEffect(() => {
    if (!loaded || !openAssetId) return;
    setState((current) => ({ ...current, activeSection: "library" }));
  }, [loaded, openAssetId]);
  useEffect(() => {
    if (!importPath) {
      claimedImportPath.current = null;
      return;
    }
    if (!loaded || importLoading || claimedImportPath.current === importPath) {
      return;
    }

    claimedImportPath.current = importPath;
    onImportPathHandled?.();
    setState((current) => ({ ...current, activeSection: "library" }));
    setImportLoading(true);
    setRuntimeError(null);
    void importMediaAsset(importPath)
      .then(({ asset, detail }) => {
        ++selectedRunDetailSequence.current;
        selectedRunIdRef.current = detail.id;
        setSelectedRunId(detail.id);
        setSelectedRun(detail);
        setImportedAssetId(asset.id);
        return refreshRuntime();
      })
      .catch((error: unknown) => {
        setRuntimeError(
          normalizeMediaError(error, "import_chat_image_attachment"),
        );
      })
      .finally(() => setImportLoading(false));
  }, [importLoading, importPath, loaded, onImportPathHandled, refreshRuntime]);
  const inspectRunInFlow = useCallback(
    (run: MediaRunDetail): void => {
      if (!run.flowRevisionId) return;
      setFlowRevisionLoading(true);
      setRuntimeError(null);
      void getMediaFlow(run.flowId)
        .then((history) => {
          const revision = history.revisions.find(
            (candidate) => candidate.revisionId === run.flowRevisionId,
          );
          if (!revision) {
            throw new Error("The pinned flow revision is unavailable.");
          }
          clearSemanticHistory();
          ++selectedRunDetailSequence.current;
          selectedRunIdRef.current = run.id;
          setSelectedRunId(run.id);
          setSelectedRun(run);
          setSelectedRunRecipe(recipeSnapshotFromRevision(run, revision));
          setFlowHistory(history);
          setFlowRunOverlayId(run.id);
          setState((current) => ({
            ...current,
            activeSection: "flow",
            flow: revision.flow,
            flowLayout: revision.layout,
          }));
        })
        .catch((error: unknown) => {
          setRuntimeError(normalizeMediaError(error, "inspect_run_flow"));
        })
        .finally(() => setFlowRevisionLoading(false));
    },
    [clearSemanticHistory],
  );
  const reuseRunSettings = useCallback(
    (runId: string): void => {
      const applyRecipe = (
        recipe: MediaGenerationRecipeSnapshot,
        revision: MediaFlowRevision | null,
      ): void => {
        if (recipe.mode === "basic") {
          setState((current) => ({
            ...current,
            activeSection: "generate",
            target: recipe.target,
            recipe: recipe.imageSettings
              ? structuredClone(recipe.imageSettings)
              : { ...current.recipe, prompt: recipe.prompt },
            videoRecipe: recipe.videoSettings
              ? structuredClone(recipe.videoSettings)
              : current.videoRecipe,
          }));
          return;
        }
        if (!revision) return;
        clearSemanticHistory();
        setFlowRunOverlayId(null);
        setState((current) => ({
          ...current,
          activeSection: "flow",
          flow: revision.flow,
          flowLayout: revision.layout,
        }));
      };
      const queuedJob = generationQueue.getJob(runId);
      if (queuedJob?.recipe.mode === "basic") {
        applyRecipe(queuedJob.recipe, null);
        return;
      }
      setFlowRevisionLoading(true);
      setRuntimeError(null);
      void (async () => {
        const run =
          selectedRun?.id === runId
            ? selectedRun
            : await getMediaRunDetail(runId);
        const flowId = queuedJob?.recipe.flowId ?? run.flowId;
        const revisionId =
          queuedJob?.recipe.flowRevisionId ?? run.flowRevisionId;
        if (!revisionId) throw new Error("This run has no pinned settings.");
        const history = await getMediaFlow(flowId);
        const revision = history.revisions.find(
          (candidate) => candidate.revisionId === revisionId,
        );
        if (!revision) throw new Error("The pinned settings are unavailable.");
        const recipe =
          queuedJob?.recipe ?? recipeSnapshotFromRevision(run, revision);
        setFlowHistory(history);
        applyRecipe(recipe, revision);
      })()
        .catch((error: unknown) => {
          setRuntimeError(normalizeMediaError(error, "reuse_run_settings"));
        })
        .finally(() => setFlowRevisionLoading(false));
    },
    [clearSemanticHistory, selectedRun],
  );
  const inspectRunSettings = useCallback(
    (runId: string): void => {
      setState((current) => ({ ...current, activeSection: "runs" }));
      selectRun(runId);
    },
    [selectRun],
  );
  const cancelRun = useCallback(
    (runId: string) => {
      const queuedJob = generationQueue.getJob(runId);
      if (
        queuedJob &&
        ["queued", "running", "canceling"].includes(queuedJob.status)
      ) {
        void generationQueue.cancel(runId).catch((error: unknown) => {
          setRuntimeError(normalizeMediaError(error, "cancel_queued_run"));
        });
        return;
      }
      void cancelMediaRun(runId)
        .then((detail) => {
          ++selectedRunDetailSequence.current;
          selectedRunIdRef.current = detail.id;
          setSelectedRunId(detail.id);
          setSelectedRun(detail);
          return refreshRuntime();
        })
        .catch((error: unknown) => {
          setRuntimeError(normalizeMediaError(error, "cancel_run"));
        });
    },
    [refreshRuntime],
  );
  const retryRun = useCallback(
    (runId: string) => {
      void retryMediaFixtureRun(runId)
        .then((detail) => {
          ++selectedRunDetailSequence.current;
          selectedRunIdRef.current = detail.id;
          setSelectedRunId(detail.id);
          setSelectedRun(detail);
          return refreshRuntime();
        })
        .catch((error: unknown) => {
          setRuntimeError(normalizeMediaError(error, "retry_run"));
        });
    },
    [refreshRuntime],
  );
  const resolveProviderReview = useCallback(
    (providerJobId: string, action: MediaProviderReviewAction) => {
      if (providerReviewPending) return;
      setProviderReviewPending(true);
      setRuntimeError(null);
      void resolveMediaProviderReview(providerJobId, action)
        .then((detail) => {
          ++selectedRunDetailSequence.current;
          selectedRunIdRef.current = detail.id;
          setSelectedRunId(detail.id);
          setSelectedRun(detail);
          return refreshRuntime();
        })
        .catch((error: unknown) => {
          setRuntimeError(
            normalizeMediaError(error, "resolve_provider_review"),
          );
        })
        .finally(() => setProviderReviewPending(false));
    },
    [providerReviewPending, refreshRuntime],
  );
  const resolveHumanReview = useCallback(
    (request: MediaHumanReviewDecisionRequest) => {
      if (humanReviewPending) return;
      setHumanReviewPending(true);
      setRuntimeError(null);
      void resolveMediaHumanReview(request)
        .then((detail) => {
          ++selectedRunDetailSequence.current;
          selectedRunIdRef.current = detail.id;
          setSelectedRunId(detail.id);
          setSelectedRun(detail);
          return refreshRuntime();
        })
        .catch((error: unknown) => {
          setRuntimeError(normalizeMediaError(error, "resolve_human_review"));
        })
        .finally(() => setHumanReviewPending(false));
    },
    [humanReviewPending, refreshRuntime],
  );
  const importAssetPath = useCallback(
    async (
      path: string,
      metadata: MediaGenerationAssetMetadata,
    ): Promise<Awaited<ReturnType<typeof importMediaAsset>> | null> => {
      if (importLoading || !supportsNativeMediaImport()) return null;
      setImportLoading(true);
      setAssetImportError(null);
      setRuntimeError(null);
      try {
        const result = await importMediaAsset(path);
        setRuntimeAssets((current) => {
          const remaining = current.filter(
            (asset) => asset.id !== result.asset.id,
          );
          return [result.asset, ...remaining];
        });
        if (metadata.tags.length > 0) {
          await setMediaAssetTags({
            assetId: result.asset.id,
            tags: metadata.tags,
          });
        }
        setState((current) => ({
          ...current,
          assetMetadata: {
            ...current.assetMetadata,
            [result.asset.id]: metadata,
          },
        }));
        ++selectedRunDetailSequence.current;
        selectedRunIdRef.current = result.detail.id;
        setSelectedRunId(result.detail.id);
        setSelectedRun(result.detail);
        setImportedAssetId(result.asset.id);
        await refreshRuntime();
        return result;
      } catch (error: unknown) {
        const failure = normalizeMediaError(error, "import_media");
        setAssetImportError(readAssetImportError(failure));
        setRuntimeError(failure);
        return null;
      } finally {
        setImportLoading(false);
      }
    },
    [importLoading, refreshRuntime],
  );
  const importSampleImageUrl = useCallback(
    async (
      url: string,
    ): Promise<Awaited<ReturnType<typeof importMediaAsset>> | null> => {
      if (importLoading || !supportsNativeMediaImport()) return null;
      setImportLoading(true);
      setAssetImportError(null);
      setRuntimeError(null);
      try {
        const result = await importMediaAssetFromUrl(url);
        setRuntimeAssets((current) => [
          result.asset,
          ...current.filter((asset) => asset.id !== result.asset.id),
        ]);
        await refreshRuntime();
        return result;
      } catch (error: unknown) {
        const failure = normalizeMediaError(error, "import_sample_image_url");
        setAssetImportError(readAssetImportError(failure));
        setRuntimeError(failure);
        return null;
      } finally {
        setImportLoading(false);
      }
    },
    [importLoading, refreshRuntime],
  );
  const importReferenceImages = useCallback(() => {
    if (importLoading || !supportsNativeMediaImport()) {
      return;
    }

    setImportLoading(true);
    setRuntimeError(null);
    void (async () => {
      const selected = await openDialog({
        multiple: true,
        directory: false,
        title: "Add image references",
        filters: [
          {
            name: "Supported images",
            extensions: ["png", "jpg", "jpeg", "webp", "svg"],
          },
        ],
      });
      const paths = Array.isArray(selected)
        ? selected
        : typeof selected === "string"
          ? [selected]
          : [];
      if (paths.length === 0) return;
      const remaining =
        8 -
        state.recipe.referenceImages.length -
        (state.recipe.baseImageAssetId ? 1 : 0) -
        (state.recipe.poseImageAssetId ? 1 : 0);
      if (paths.length > remaining) {
        throw new Error(
          `Add at most ${remaining} more reference image${remaining === 1 ? "" : "s"}.`,
        );
      }

      const importedAssets: MediaAssetRecord[] = [];
      for (const path of paths) {
        const result = await importMediaAsset(path);
        importedAssets.push(result.asset);
      }
      const uniqueImportedAssets = [
        ...new Map(importedAssets.map((asset) => [asset.id, asset])).values(),
      ];
      if (uniqueImportedAssets.length === 0) return;
      setRuntimeAssets((current) => {
        const importedIds = new Set(
          uniqueImportedAssets.map((asset) => asset.id),
        );
        return [
          ...uniqueImportedAssets,
          ...current.filter((asset) => !importedIds.has(asset.id)),
        ];
      });
      setState((current) => {
        const existingIds = new Set(
          current.recipe.referenceImages.map((reference) => reference.assetId),
        );
        if (current.recipe.baseImageAssetId) {
          existingIds.add(current.recipe.baseImageAssetId);
        }
        if (current.recipe.poseImageAssetId) {
          existingIds.add(current.recipe.poseImageAssetId);
        }
        const additions = uniqueImportedAssets
          .filter((asset) => !existingIds.has(asset.id))
          .map((asset, index) => ({
            assetId: asset.id,
            role:
              current.target !== "image" &&
              current.recipe.referenceImages.length === 0 &&
              index === 0
                ? ("base" as const)
                : ("subject" as const),
            influence: 1,
          }));
        return {
          ...current,
          recipe: {
            ...current.recipe,
            referenceImages: [
              ...current.recipe.referenceImages,
              ...additions,
            ].slice(0, 8),
          },
        };
      });
      await refreshRuntime();
    })()
      .catch((error: unknown) => {
        setRuntimeError(normalizeMediaError(error, "import_reference_images"));
      })
      .finally(() => setImportLoading(false));
  }, [
    importLoading,
    refreshRuntime,
    state.recipe.baseImageAssetId,
    state.recipe.poseImageAssetId,
    state.recipe.referenceImages.length,
  ]);
  const importConditioningImage = useCallback(
    (kind: "base" | "pose"): void => {
      if (importLoading || !supportsNativeMediaImport()) return;
      setImportLoading(true);
      setRuntimeError(null);
      void (async () => {
        const selected = await openDialog({
          multiple: false,
          directory: false,
          title: kind === "base" ? "Add base image" : "Add pose map",
          filters: [
            {
              name: "Supported images",
              extensions: ["png", "jpg", "jpeg", "webp"],
            },
          ],
        });
        if (typeof selected !== "string") return;
        const result = await importMediaAsset(selected);
        setRuntimeAssets((current) => [
          result.asset,
          ...current.filter((asset) => asset.id !== result.asset.id),
        ]);
        setState((current) => {
          const referenceImages = current.recipe.referenceImages.filter(
            (reference) => reference.assetId !== result.asset.id,
          );
          return {
            ...current,
            recipe: {
              ...current.recipe,
              referenceImages,
              ...(kind === "base"
                ? {
                    baseImageAssetId: result.asset.id,
                    poseImageAssetId:
                      current.recipe.poseImageAssetId === result.asset.id
                        ? null
                        : current.recipe.poseImageAssetId,
                    editMask: null,
                    outputFormat: "png" as const,
                    transparentBackground: false,
                  }
                : {
                    poseImageAssetId: result.asset.id,
                    baseImageAssetId:
                      current.recipe.baseImageAssetId === result.asset.id
                        ? null
                        : current.recipe.baseImageAssetId,
                    editMask:
                      current.recipe.baseImageAssetId === result.asset.id
                        ? null
                        : current.recipe.editMask,
                  }),
            },
          };
        });
        await refreshRuntime();
      })()
        .catch((error: unknown) => {
          setRuntimeError(normalizeMediaError(error, `import_${kind}_image`));
        })
        .finally(() => setImportLoading(false));
    },
    [importLoading, refreshRuntime],
  );
  const updateAssetTags = useCallback(
    (update: MediaAssetTagUpdate) => {
      if (tagLoadingAssetId !== null) {
        return;
      }
      setTagLoadingAssetId(update.assetId);
      setRuntimeError(null);
      void setMediaAssetTags(update)
        .then(() => refreshRuntime())
        .catch((error: unknown) => {
          setRuntimeError(normalizeMediaError(error, "set_asset_tags"));
        })
        .finally(() => setTagLoadingAssetId(null));
    },
    [refreshRuntime, tagLoadingAssetId],
  );
  const deleteAsset = useCallback(
    async (impact: Awaited<ReturnType<typeof planMediaAssetDeletion>>) => {
      await deleteMediaAsset({
        assetId: impact.assetId,
        mode: "metadata-and-unreferenced-bytes",
        confirmationToken: impact.confirmationToken,
        confirmDependencies: impact.dependentAssetIds.length > 0,
      });
      setRuntimeAssets((current) =>
        current.filter((asset) => asset.id !== impact.assetId),
      );
      setState((current) => {
        const assetMetadata = { ...current.assetMetadata };
        delete assetMetadata[impact.assetId];
        const referenceImages = current.recipe.referenceImages.filter(
          (reference) => reference.assetId !== impact.assetId,
        );
        return {
          ...current,
          assetMetadata,
          recipe: {
            ...current.recipe,
            referenceImages,
            baseImageAssetId:
              current.recipe.baseImageAssetId === impact.assetId
                ? null
                : current.recipe.baseImageAssetId,
            poseImageAssetId:
              current.recipe.poseImageAssetId === impact.assetId
                ? null
                : current.recipe.poseImageAssetId,
            editMask:
              current.recipe.editMask?.sourceAssetId === impact.assetId
                ? null
                : current.recipe.editMask,
          },
        };
      });
      await refreshRuntime();
    },
    [refreshRuntime],
  );
  const updateAssetMetadata = useCallback(
    (resourceId: string, metadata: MediaGenerationAssetMetadata): void => {
      setState((current) => ({
        ...current,
        assetMetadata: {
          ...current.assetMetadata,
          [resourceId]: metadata,
        },
      }));
    },
    [],
  );
  const updateAssetCategoryState = useCallback(
    (
      categories: MediaAssetCategory[],
      assetMetadata: Record<string, MediaGenerationAssetMetadata>,
    ): void => {
      setState((current) => ({ ...current, categories, assetMetadata }));
    },
    [],
  );
  const combinedRuns = useMemo(() => {
    const runsById = new Map<string, MediaRunRecord>();
    for (const run of state.runs) runsById.set(run.id, run);
    for (const run of runtimeRuns) runsById.set(run.id, run);
    for (const job of generationJobs) {
      runsById.set(job.id, generationJobToRunDetail(job));
    }
    return [...runsById.values()].sort(
      (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
    );
  }, [generationJobs, runtimeRuns, state.runs]);
  const handleRuntimeErrorAction = useCallback(
    (action: MediaErrorAction["id"]): void => {
      setRuntimeError(null);
      switch (action) {
        case "refresh":
        case "retry":
          void refreshRuntime();
          refreshFlowHistory();
          break;
        case "open-models":
        case "free-space":
          setState((current) => ({ ...current, activeSection: "library" }));
          void refreshModelCatalog();
          break;
        case "open-provider-settings":
          onOpenProviderSettings();
          break;
        case "review-run":
          setState((current) => ({ ...current, activeSection: "runs" }));
          break;
        case "review-input":
        case "choose-location":
          break;
      }
    },
    [
      onOpenProviderSettings,
      refreshModelCatalog,
      refreshFlowHistory,
      refreshRuntime,
    ],
  );

  const persistenceError = saveError ?? loadError;

  return (
    <main className="m-media-studio-layout">
      <MediaStudioNavigation
        activeSection={state.activeSection}
        onSelect={selectSection}
      />

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {runtimeError ? (
          <MediaErrorNotice
            error={runtimeError}
            onAction={handleRuntimeErrorAction}
            onDismiss={() => setRuntimeError(null)}
          />
        ) : null}
        <div className="min-h-0 min-w-0 flex-1">
          {state.activeSection === "generate" ? (
            <MediaGenerateView
              target={state.target}
              settings={state.recipe}
              videoSettings={state.videoRecipe}
              assetMetadata={state.assetMetadata}
              categories={state.categories}
              plan={recipePlan}
              catalog={activeModelCatalog}
              directGenerationModelIds={
                runtimeStatus?.directGenerationModelIds ?? null
              }
              directReferenceImageModelIds={
                runtimeStatus?.directReferenceImageModelIds ?? null
              }
              directInpaintingModelIds={
                runtimeStatus?.directInpaintingModelIds ?? null
              }
              directPoseModelIds={runtimeStatus?.directPoseModelIds ?? null}
              videoGenerationSupported={
                basicVideoDraft?.execution.supported ?? false
              }
              videoGenerationBlockedReason={
                basicVideoDraft?.execution.reason ?? null
              }
              referenceAssets={runtimeAssets}
              referenceImportSupported={supportsNativeMediaImport()}
              referenceImportPending={importLoading}
              generationJob={displayedGenerationJob}
              generationJobs={generationJobs}
              queueBusy={generationQueueBusy}
              persistenceError={persistenceError}
              onTargetChange={changeGenerationTarget}
              onChange={changeRecipe}
              onVideoSettingsChange={changeVideoRecipe}
              onOpenFlow={openRecipeAsFlow}
              onOpenAssets={() => selectSection("library")}
              onOpenActivity={() => selectSection("runs")}
              onGenerate={runGeneration}
              onAddReferenceImages={importReferenceImages}
              onAddBaseImage={() => importConditioningImage("base")}
              onAddPoseImage={() => importConditioningImage("pose")}
              onEditResult={useAssetAsBaseImage}
              onAnimateResult={useAssetAsBasicVideoReference}
              onOpenResult={openAssetInLibrary}
              generationPending={generationPending || localFlowPending}
            />
          ) : null}
          {state.activeSection === "flow" ? (
            <MediaFlowView
              flow={flow}
              layout={layout}
              plan={plan}
              models={models}
              addons={activeModelCatalog.addons}
              assets={runtimeAssets}
              assetMetadata={state.assetMetadata}
              onLayoutChange={changeFlowLayout}
              onFlowVariablesChange={applySemanticFlow}
              onTemplateApply={applyFlowTemplate}
              onNodeConfigChange={changeFlowNodeConfig}
              onNodeConfigPatch={changeFlowNodeConfigs}
              onNodeLabelChange={changeFlowNodeLabel}
              onNodeAdd={addFlowNode}
              onNodeRemove={removeFlowNode}
              onConnectPorts={connectFlowPorts}
              onDisconnectInput={disconnectFlowInput}
              onDisconnectConnection={disconnectFlowConnection}
              canUndoSemantic={semanticUndoStack.current.length > 0}
              canRedoSemantic={semanticRedoStack.current.length > 0}
              onUndoSemantic={undoSemanticFlow}
              onRedoSemantic={redoSemanticFlow}
              onNodeCopy={copyFlowNode}
              onNodePaste={pasteFlowNode}
              onNodesCopy={copySelectedFlowNodes}
              clipboardLabel={flowClipboard?.label ?? null}
              canPasteNode={pasteInspection.valid}
              pasteBlockedReason={pasteInspection.reason}
              history={flowHistory}
              savedFlows={savedFlows}
              savedFlowsLoading={savedFlowsLoading}
              revisionLoading={flowRevisionLoading}
              revisionNotice={flowRevisionNotice}
              hasUnsavedChanges={hasUnsavedFlowChanges}
              onRefreshHistory={refreshFlowHistory}
              onRefreshSavedFlows={refreshSavedFlows}
              onOpenSavedFlow={openSavedFlow}
              onSaveRevision={saveCurrentFlowRevision}
              onRestoreRevision={restoreFlowRevision}
              portabilitySupported={supportsNativeMediaFlowPortability()}
              portabilityLoading={flowPortabilityLoading}
              importInspection={flowImportInspection}
              onInspectImport={inspectPortableFlow}
              onImportReviewed={importReviewedFlow}
              onDismissImport={dismissFlowImport}
              onExportRevision={exportCurrentFlowRevision}
              onRunLocalFlow={
                advancedLocalImageExecution.supported
                  ? runAdvancedLocalImageFlow
                  : videoFlowExecution.supported
                    ? runVideoFlow
                    : runLocalFlow
              }
              localRunPending={localFlowPending}
              localRunSupported={
                advancedLocalImageExecution.supported ||
                localFlowExecution.supported ||
                videoFlowExecution.supported
              }
              localRunDescription={
                advancedLocalImageExecution.supported
                  ? advancedLocalImageExecution.reason
                  : videoFlowExecution.videoNode
                    ? videoFlowExecution.reason
                    : localFlowExecution.reason
              }
              onRunRemoteEdit={runRemoteEditFlow}
              remoteRunPending={remoteEditPending}
              remoteRunSupported={remoteEditExecution.supported}
              remoteRunDescription={remoteEditExecution.reason}
              remoteRunMode={runtimeStatus?.mode ?? null}
              remoteMaskIncluded={remoteEditExecution.maskIncluded}
              remoteUploadManifest={remoteEditExecution.manifest}
              runOverlay={
                flowRunOverlayId === selectedRun?.id ? selectedRun : null
              }
              onRunOverlayClear={() => setFlowRunOverlayId(null)}
            />
          ) : null}
          {state.activeSection === "library" ? (
            <MediaAssetsView
              assets={runtimeAssets}
              catalog={activeModelCatalog}
              categories={state.categories}
              metadata={state.assetMetadata}
              selectedModelId={state.recipe.modelId}
              importSupported={supportsNativeMediaImport()}
              importLoading={
                importLoading ||
                modelImportLoading ||
                addonImportLoading ||
                civitaiAddonLoading
              }
              importProgress={assetImportProgress}
              modelImportInspection={modelImportInspection}
              addonImportInspection={addonImportInspection}
              civitaiInspection={civitaiAddonInspection}
              importError={
                assetImportError ??
                modelImportError ??
                addonImportError ??
                civitaiAddonError
              }
              persistenceError={saveError}
              tagLoadingAssetId={tagLoadingAssetId}
              openAssetId={openAssetId ?? importedAssetId}
              onOpenAssetHandled={() => {
                if (openAssetId) onOpenAssetHandled?.();
                if (importedAssetId) setImportedAssetId(null);
              }}
              openResourceId={importedResourceId}
              onOpenResourceHandled={() => setImportedResourceId(null)}
              onInspectModel={inspectModelImportPath}
              onInspectAddon={inspectAddonImportPath}
              onInspectCivitai={inspectCivitaiAddon}
              onImportMedia={importAssetPath}
              onImportModel={importLocalModel}
              onImportAddon={importAddon}
              onImportSampleUrl={importSampleImageUrl}
              onRetryPersistence={() => void retryMediaStudioStateSave()}
              onDismissImport={dismissAssetImport}
              onUseModel={useModelInCreate}
              onRefreshLocalRuntime={() => void refreshLocalRuntime()}
              onVerifyModel={(model) => void verifyLocalModel(model)}
              localRuntimeRefreshing={localRuntimeRefreshing}
              verifyingModelId={verifyingModelId}
              onUseAddon={useAddonInCreate}
              onUpdateTags={updateAssetTags}
              onUpdateMetadata={updateAssetMetadata}
              onCategoryStateChange={updateAssetCategoryState}
              onUseAsReference={useAssetAsCreateReference}
              onOpenVideoAsFlow={openAssetAsVideoFlow}
              onInspectSettings={inspectRunSettings}
              onReuseSettings={reuseRunSettings}
              onPlanAssetDeletion={planMediaAssetDeletion}
              onDeleteAsset={deleteAsset}
            />
          ) : null}
          {state.activeSection === "runs" ? (
            <MediaRunsView
              runs={combinedRuns}
              assets={runtimeAssets}
              selectedRun={selectedRun}
              selectedRecipe={selectedRunRecipe}
              onCreate={() => selectSection("generate")}
              onSelect={selectRun}
              onCancel={cancelRun}
              onRetry={retryRun}
              onResolveProviderReview={resolveProviderReview}
              providerReviewPending={providerReviewPending}
              onResolveHumanReview={resolveHumanReview}
              humanReviewPending={humanReviewPending}
              onInspectInFlow={inspectRunInFlow}
              onReuseSettings={reuseRunSettings}
              onRefresh={() => void refreshRuntime()}
            />
          ) : null}
        </div>
      </section>
    </main>
  );
};
