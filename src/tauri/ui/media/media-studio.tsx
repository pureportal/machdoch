import {
  Boxes,
  FileClock,
  FolderGit2,
  Gauge,
  ImagePlus,
} from "lucide-react";
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
  type JSX,
} from "react";
import { createMediaModelCatalogSnapshot } from "../../../core/media/catalog.js";
import { extendMediaCatalogWithWorkspaceDiscovery } from "../../../core/media/discovered-model-profiles.js";
import {
  createMediaFlowDocumentDigest,
  createMediaFlowFingerprint,
  createMediaFlowLayoutDigest,
} from "../../../core/media/canonicalize.js";
import {
  compileMediaFlow,
  createGeneratedLoopVideoFlow,
  createAlphaMatteFlow,
  createSubjectCutoutFlow,
  createImageCompositeFlow,
  createImageContactSheetFlow,
  createImageEditFlow,
  createImageRecipeFlow,
  createImageToVideoFlow,
  createImageTransformFlow,
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
  upgradeMediaFlowQualityDefaults,
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
  DownloadMediaCivitaiModelAddonRequest,
  MediaAssetReference,
  MediaAssetRecord,
  MediaAssetDeletionImpact,
  MediaAssetDeletionRequest,
  MediaAssetDeletionResult,
  MediaAssetExportMode,
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
  MediaHardwareInspection,
  MediaHumanReviewDecisionRequest,
  MediaImageTransformRequest,
  MediaLocalModelImportInspection,
  MediaLocalModelImportResult,
  MediaModelAddonImportInspection,
  MediaModelAddonImportResult,
  MediaModelAddonRemovalPlan,
  MediaModelAddonRemovalResult,
  MediaCivitaiModelAddonInspection,
  MediaModelCatalogSnapshot,
  MediaModelInstallJob,
  MediaModelInstallPlan,
  MediaModelRemovalPlan,
  MediaModelRemovalResult,
  MediaNodeType,
  MediaProviderReviewAction,
  MediaQualityReport,
  MediaDiscoveredModelArtifact,
  MediaRunDetail,
  MediaRunPlanSnapshot,
  MediaRuntimeRunRecord,
  MediaRuntimeStatus,
  MediaStudioSection,
  MediaStudioState,
  MediaWorkspaceModelDiscovery,
  StartMediaModelInstallRequest,
  RemoveMediaModelRequest,
  RemoveMediaModelAddonRequest,
} from "../../../core/media/contracts.js";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { addPromptHistoryEntry } from "../_helpers/prompt-history-navigation.helper";
import {
  subscribeToUserSettingsChanged,
  type RuntimeProviderAvailability,
} from "../runtime";
import { cn } from "../lib/utils";
import { MediaFlowView } from "./components/media-flow-view";
import { MediaErrorNotice } from "./components/media-error-notice";
import { MediaGenerateView } from "./components/media-generate-view";
import { MediaLibraryView } from "./components/media-library-view";
import { MediaModelsView } from "./components/media-models-view";
import { MediaRunsView } from "./components/media-runs-view";
import {
  DEFAULT_MEDIA_STUDIO_STATE,
  loadMediaStudioState,
  normalizeMediaStudioState,
  saveMediaStudioState,
} from "./media-studio-store";
import {
  analyzeMediaImageQuality,
  autoTagMediaAsset,
  cancelMediaRun,
  cancelMediaModelInstall,
  deleteMediaAsset,
  discoverMediaWorkspaceModels,
  executeMediaLocalImageFlow,
  executeMediaRemoteImageEditFlow,
  exportMediaFlowRevision,
  exportMediaAsset,
  getMediaRunDetail,
  getMediaFlow,
  getMediaModelCatalog,
  getMediaModelInstallJob,
  generateMediaImages,
  generateMediaVideo,
  generateMediaSvg,
  initializeMediaRuntime,
  inspectMediaHardware,
  inspectMediaLocalModel,
  inspectMediaModelAddon,
  inspectMediaCivitaiModelAddon,
  downloadMediaCivitaiModelAddon,
  importMediaImage,
  importMediaFlow,
  importMediaLocalModel,
  importMediaModelAddon,
  probeMediaLocalModel,
  refreshMediaLocalDiffusersRuntime,
  inspectMediaFlowImport,
  listMediaFlows,
  listMediaAssets,
  listMediaRuns,
  planMediaAssetDeletion,
  planMediaModelInstall,
  planMediaModelRemoval,
  planMediaModelAddonRemoval,
  readMediaQualityReport,
  retryMediaFixtureRun,
  resolveMediaHumanReview,
  resolveMediaProviderReview,
  removeMediaModel,
  removeMediaModelAddon,
  saveMediaFlowRevision,
  setMediaAssetTags,
  startMediaModelInstall,
  supportsNativeMediaImport,
  supportsNativeMediaExport,
  supportsNativeMediaFlowPortability,
  supportsNativeMediaModelImport,
  supportsNativeMediaModelAddonImport,
  supportsNativeMediaModelProbe,
  transformMediaImage,
  MediaRuntimeError,
  normalizeMediaError,
} from "./media-runtime";

const MEDIA_RECIPE_PROMPT_FLOW_IDS = new Set([
  "media-image-recipe-draft",
  "media-image-review-draft",
]);

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

interface MediaStudioProps {
  providerStatuses: readonly RuntimeProviderAvailability[];
  onOpenProviderSettings: () => void;
  workspaceRoot: string | null;
  onSendAssetToChat: (reference: MediaAssetReference) => void;
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

interface NavigationItem {
  id: MediaStudioSection;
  label: string;
  icon: typeof ImagePlus;
}

const NAVIGATION_ITEMS: readonly NavigationItem[] = [
  { id: "generate", label: "Create", icon: ImagePlus },
  { id: "flow", label: "Workflows", icon: FolderGit2 },
  { id: "library", label: "Library", icon: Boxes },
  { id: "runs", label: "Activity", icon: FileClock },
  { id: "models", label: "Models", icon: Gauge },
] as const;

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

const SEMANTIC_HISTORY_LIMIT = 100;

interface RemoteEditExecutionAssessment {
  supported: boolean;
  reason: string;
  manifest: Array<{
    assetId: string;
    digest: string;
    byteSize: number;
    role: string;
    influence: number;
  }>;
}

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
    manifest: [],
  });
  const resolvedFlow = resolveMediaFlowVariables(flow).flow;
  if (!resolvedFlow.nodes.some((node) => node.type === "task.edit-image")) {
    return unavailable("This flow does not contain a remote image-edit task.");
  }
  if (plan.status !== "ready") {
    return unavailable("Resolve preflight diagnostics before using image references.");
  }
  if (directReferenceImageModelIds === null) {
    return unavailable("Checking whether the selected model can use image references.");
  }
  if (!plan.model || !directReferenceImageModelIds.includes(plan.model.id)) {
    return unavailable("The selected model runtime does not support image references yet.");
  }
  if (plan.model.target !== "remote" || !plan.preflight.requiresRemoteRequest) {
    return unavailable("The selected reference-image runtime is not available in this build.");
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
            typeof node.config.influence === "number" ? node.config.influence : 1,
        }
      : null;
  });
  if (manifest.some((item) => item === null)) {
    return unavailable("Every reference must point to an available Library image.");
  }
  const exactManifest = manifest.filter(
    (item): item is NonNullable<typeof item> => item !== null,
  );
  if (new Set(exactManifest.map((item) => item.assetId)).size !== exactManifest.length) {
    return unavailable("Remove duplicate reference images before generation.");
  }
  if (exactManifest.filter((item) => item.role === "base").length !== 1) {
    return unavailable("Exactly one reference must be the base image.");
  }
  exactManifest.sort((left, right) =>
    left.role === "base" ? -1 : right.role === "base" ? 1 : 0,
  );
  return {
    supported: true,
    reason:
      runtimeMode === "browser-preview"
        ? "Runs a deterministic browser fixture with no upload or charge."
        : `Metadata-strips ${exactManifest.length} reference${exactManifest.length === 1 ? "" : "s"}, then submits one paid ${plan.model.displayName} edit request.`,
    manifest: exactManifest,
  };
};

export const MediaStudio = ({
  providerStatuses,
  onOpenProviderSettings,
  workspaceRoot,
  onSendAssetToChat,
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
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [runtimeStatus, setRuntimeStatus] =
    useState<MediaRuntimeStatus | null>(null);
  const [runtimeRuns, setRuntimeRuns] = useState<MediaRuntimeRunRecord[]>([]);
  const [runtimeAssets, setRuntimeAssets] = useState<MediaAssetRecord[]>([]);
  const [runtimeError, setRuntimeError] = useState<MediaErrorDetail | null>(null);
  const [importedAssetId, setImportedAssetId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<MediaRunDetail | null>(null);
  const [flowRunOverlayId, setFlowRunOverlayId] = useState<string | null>(null);
  const [generationPending, setGenerationPending] = useState(false);
  const [localFlowPending, setLocalFlowPending] = useState(false);
  const [remoteEditPending, setRemoteEditPending] = useState(false);
  const [providerReviewPending, setProviderReviewPending] = useState(false);
  const [humanReviewPending, setHumanReviewPending] = useState(false);
  const [hardware, setHardware] = useState<MediaHardwareInspection | null>(null);
  const [hardwareLoading, setHardwareLoading] = useState(false);
  const [hardwareError, setHardwareError] = useState<string | null>(null);
  const [modelCatalog, setModelCatalog] =
    useState<MediaModelCatalogSnapshot | null>(null);
  const [modelCatalogLoading, setModelCatalogLoading] = useState(false);
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);
  const [workspaceModelDiscovery, setWorkspaceModelDiscovery] =
    useState<MediaWorkspaceModelDiscovery | null>(null);
  const [workspaceModelDiscoveryLoading, setWorkspaceModelDiscoveryLoading] =
    useState(false);
  const [workspaceModelDiscoveryError, setWorkspaceModelDiscoveryError] =
    useState<string | null>(null);
  const [localRuntimeLoading, setLocalRuntimeLoading] = useState(false);
  const [modelImportInspection, setModelImportInspection] =
    useState<MediaLocalModelImportInspection | null>(null);
  const [modelImportResult, setModelImportResult] =
    useState<MediaLocalModelImportResult | null>(null);
  const [modelImportLoading, setModelImportLoading] = useState(false);
  const [modelImportError, setModelImportError] = useState<string | null>(null);
  const [modelProbeLoadingId, setModelProbeLoadingId] = useState<string | null>(null);
  const [modelProbeError, setModelProbeError] = useState<string | null>(null);
  const [addonImportInspection, setAddonImportInspection] =
    useState<MediaModelAddonImportInspection | null>(null);
  const [addonImportResult, setAddonImportResult] =
    useState<MediaModelAddonImportResult | null>(null);
  const [addonImportLoading, setAddonImportLoading] = useState(false);
  const [addonImportError, setAddonImportError] = useState<string | null>(null);
  const [civitaiAddonInspection, setCivitaiAddonInspection] =
    useState<MediaCivitaiModelAddonInspection | null>(null);
  const [addonImportCivitaiSource, setAddonImportCivitaiSource] =
    useState<MediaCivitaiModelAddonInspection | null>(null);
  const [civitaiAddonLoading, setCivitaiAddonLoading] = useState(false);
  const [civitaiAddonError, setCivitaiAddonError] = useState<string | null>(null);
  const [addonRemovalPlan, setAddonRemovalPlan] =
    useState<MediaModelAddonRemovalPlan | null>(null);
  const [addonRemovalResult, setAddonRemovalResult] =
    useState<MediaModelAddonRemovalResult | null>(null);
  const [addonRemovalLoading, setAddonRemovalLoading] = useState(false);
  const [addonRemovalError, setAddonRemovalError] = useState<string | null>(null);
  const [modelInstallPlan, setModelInstallPlan] =
    useState<MediaModelInstallPlan | null>(null);
  const [modelInstallJob, setModelInstallJob] =
    useState<MediaModelInstallJob | null>(null);
  const [modelInstallLoading, setModelInstallLoading] = useState(false);
  const [modelInstallError, setModelInstallError] = useState<string | null>(null);
  const [modelRemovalPlan, setModelRemovalPlan] =
    useState<MediaModelRemovalPlan | null>(null);
  const [modelRemovalLoading, setModelRemovalLoading] = useState(false);
  const [modelRemovalError, setModelRemovalError] = useState<string | null>(null);
  const [modelRemovalResult, setModelRemovalResult] =
    useState<MediaModelRemovalResult | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [transformLoading, setTransformLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [deletionNotice, setDeletionNotice] = useState<string | null>(null);
  const [qualityLoadingAssetId, setQualityLoadingAssetId] = useState<string | null>(null);
  const [qualityReports, setQualityReports] = useState<Record<string, MediaQualityReport>>({});
  const [tagLoadingAssetId, setTagLoadingAssetId] = useState<string | null>(null);
  const [draftCreatedAt] = useState(() => new Date().toISOString());
  const [flowHistory, setFlowHistory] = useState<MediaFlowHistory | null>(null);
  const [savedFlows, setSavedFlows] = useState<MediaFlowHead[]>([]);
  const [savedFlowsLoading, setSavedFlowsLoading] = useState(false);
  const [flowRevisionLoading, setFlowRevisionLoading] = useState(false);
  const [flowRevisionNotice, setFlowRevisionNotice] = useState<string | null>(null);
  const [flowPortabilityLoading, setFlowPortabilityLoading] = useState(false);
  const [flowImportInspection, setFlowImportInspection] =
    useState<MediaFlowImportInspection | null>(null);
  const [flowImportSourcePath, setFlowImportSourcePath] = useState<string | null>(null);
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
  const hardwareRequestSequence = useRef(0);
  const localRuntimeRefreshInFlight = useRef(false);
  const announcedFailureKey = useRef<string | null>(null);
  const claimedImportPath = useRef<string | null>(null);

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);

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
    try {
      const [runs, assets, detail] = await Promise.all([
        listMediaRuns(),
        listMediaAssets(),
        requestedRunId ? getMediaRunDetail(requestedRunId) : null,
      ]);
      if (refreshSequence !== runtimeRefreshSequence.current) {
        return;
      }
      setRuntimeRuns(runs);
      setRuntimeAssets(assets);
      if (
        detailSequence === selectedRunDetailSequence.current &&
        selectedRunIdRef.current === requestedRunId
      ) {
        setSelectedRun(detail);
        if (detail?.failure) {
          presentRunFailure(detail.failure);
        }
      }
    } catch (error: unknown) {
      if (refreshSequence === runtimeRefreshSequence.current) {
        setRuntimeError(normalizeMediaError(error, "refresh_media_runtime"));
      }
    }
  }, [presentRunFailure]);

  const refreshHardware = useCallback((): void => {
    const requestSequence = ++hardwareRequestSequence.current;
    setHardwareLoading(true);
    setHardwareError(null);
    void inspectMediaHardware()
      .then((inspection) => {
        if (requestSequence === hardwareRequestSequence.current) {
          setHardware(inspection);
        }
      })
      .catch((error: unknown) => {
        if (requestSequence === hardwareRequestSequence.current) {
          setHardwareError(
            error instanceof Error
              ? error.message
              : "Local media runtime probes could not be completed.",
          );
        }
      })
      .finally(() => {
        if (requestSequence === hardwareRequestSequence.current) {
          setHardwareLoading(false);
        }
      });
  }, []);

  const configuredProviderIds = useMemo(
    () =>
      providerStatuses
        .filter((status) => status.configured)
        .map((status) => status.provider),
    [providerStatuses],
  );
  const fallbackModelCatalog = useMemo(
    () =>
      createMediaModelCatalogSnapshot({
        isOpenAiConfigured: configuredProviderIds.includes("openai"),
      }),
    [configuredProviderIds],
  );
  const refreshModelCatalog = useCallback((): void => {
    const requestSequence = ++modelCatalogRequestSequence.current;
    setModelCatalogLoading(true);
    setModelCatalogError(null);
    void getMediaModelCatalog(configuredProviderIds)
      .then((snapshot) => {
        if (requestSequence === modelCatalogRequestSequence.current) {
          setModelCatalog(snapshot);
        }
      })
      .catch((error: unknown) => {
        if (requestSequence === modelCatalogRequestSequence.current) {
          setModelCatalogError(
            error instanceof Error
              ? error.message
              : "The media model catalog could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (requestSequence === modelCatalogRequestSequence.current) {
          setModelCatalogLoading(false);
        }
      });
  }, [configuredProviderIds]);

  const refreshWorkspaceModels = useCallback((): void => {
    const normalizedWorkspaceRoot = workspaceRoot?.trim();
    const requestSequence = ++workspaceDiscoveryRequestSequence.current;
    if (!normalizedWorkspaceRoot) {
      setWorkspaceModelDiscovery(null);
      setWorkspaceModelDiscoveryError(null);
      setWorkspaceModelDiscoveryLoading(false);
      return;
    }
    setWorkspaceModelDiscoveryLoading(true);
    setWorkspaceModelDiscoveryError(null);
    void discoverMediaWorkspaceModels(normalizedWorkspaceRoot)
      .then((discovery) => {
        if (requestSequence === workspaceDiscoveryRequestSequence.current) {
          setWorkspaceModelDiscovery(discovery);
        }
      })
      .catch((error: unknown) => {
        if (requestSequence === workspaceDiscoveryRequestSequence.current) {
          setWorkspaceModelDiscoveryError(
            error instanceof Error
              ? error.message
              : "The workspace models directory could not be scanned.",
          );
        }
      })
      .finally(() => {
        if (requestSequence === workspaceDiscoveryRequestSequence.current) {
          setWorkspaceModelDiscoveryLoading(false);
        }
      });
  }, [workspaceRoot]);

  const refreshLocalRuntime = useCallback((): void => {
    if (localRuntimeRefreshInFlight.current) return;
    localRuntimeRefreshInFlight.current = true;
    setLocalRuntimeLoading(true);
    setModelProbeError(null);
    void refreshMediaLocalDiffusersRuntime()
      .then(async () => {
        // Recompute the complete capability snapshot after changing runtimes.
        // Patching only `localDiffusers` leaves directGenerationModelIds from
        // the previous probe and can make a now-ready local model impossible
        // to select until the entire desktop app is restarted.
        const status = await initializeMediaRuntime();
        setRuntimeStatus(status);
        refreshModelCatalog();
      })
      .catch((error: unknown) => {
        setModelProbeError(
          error instanceof Error
            ? error.message
            : "The local Diffusers runtime probe failed.",
        );
      })
      .finally(() => {
        localRuntimeRefreshInFlight.current = false;
        setLocalRuntimeLoading(false);
      });
  }, [refreshModelCatalog]);

  const chooseModelImport = useCallback((): void => {
    if (modelImportLoading || addonImportLoading) return;
    if (!supportsNativeMediaModelImport()) {
      setModelImportError(
        "Local model import is available in the native desktop app only.",
      );
      return;
    }
    setModelImportLoading(true);
    setModelImportError(null);
    setModelImportResult(null);
    void openDialog({
      title: "Import image checkpoint",
      multiple: false,
      directory: false,
      filters: [
        {
          name: "Safe diffusion checkpoints",
          extensions: ["safetensors"],
        },
      ],
    })
      .then(async (selected) => {
        if (typeof selected !== "string") return;
        const inspection = await inspectMediaLocalModel(selected);
        setModelImportInspection(inspection);
      })
      .catch((error: unknown) => {
        setModelImportError(
          error instanceof Error
            ? error.message
            : "The selected model checkpoint could not be inspected.",
        );
      })
      .finally(() => setModelImportLoading(false));
  }, [addonImportLoading, modelImportLoading]);

  const importLocalModel = useCallback(
    (request: ImportMediaLocalModelRequest): void => {
      setModelImportLoading(true);
      setModelImportError(null);
      void importMediaLocalModel(request)
        .then((result) => {
          setModelImportResult(result);
          refreshModelCatalog();
        })
        .catch((error: unknown) => {
          setModelImportError(
            error instanceof Error
              ? error.message
              : "The model checkpoint could not be imported.",
          );
        })
        .finally(() => setModelImportLoading(false));
    },
    [refreshModelCatalog],
  );

  const dismissModelImport = useCallback((): void => {
    if (modelImportLoading) return;
    setModelImportInspection(null);
    setModelImportResult(null);
    setModelImportError(null);
  }, [modelImportLoading]);

  const probeLocalModel = useCallback(
    (modelId: string): void => {
      if (!supportsNativeMediaModelProbe()) {
        setModelProbeError(
          "Local model verification is available in the native desktop app only.",
        );
        return;
      }
      setModelProbeLoadingId(modelId);
      setModelProbeError(null);
      void probeMediaLocalModel(modelId)
        .then(async () => {
          const status = await initializeMediaRuntime();
          setRuntimeStatus(status);
          refreshModelCatalog();
        })
        .catch((error: unknown) => {
          setModelProbeError(
            error instanceof Error
              ? error.message
              : "The model could not be verified with the local runtime.",
          );
        })
        .finally(() => setModelProbeLoadingId(null));
    },
    [refreshModelCatalog],
  );

  const chooseAddonImport = useCallback((): void => {
    if (modelImportLoading || addonImportLoading) return;
    if (!supportsNativeMediaModelAddonImport()) {
      setAddonImportError(
        "LoRA and embedding import is available in the native desktop app only.",
      );
      return;
    }
    setAddonImportLoading(true);
    setAddonImportError(null);
    setAddonImportResult(null);
    setAddonImportCivitaiSource(null);
    void openDialog({
      title: "Import LoRA or textual-inversion embedding",
      multiple: false,
      directory: false,
      filters: [{ name: "Safe model add-ons", extensions: ["safetensors"] }],
    })
      .then(async (selected) => {
        if (typeof selected !== "string") return;
        setAddonImportInspection(await inspectMediaModelAddon(selected));
      })
      .catch((error: unknown) => {
        setAddonImportError(
          error instanceof Error
            ? error.message
            : "The selected model add-on could not be inspected.",
        );
      })
      .finally(() => setAddonImportLoading(false));
  }, [addonImportLoading, modelImportLoading]);

  const inspectWorkspaceArtifact = useCallback(
    (artifact: MediaDiscoveredModelArtifact): void => {
      if (modelImportLoading || addonImportLoading) return;
      if (artifact.status !== "importable") {
        setWorkspaceModelDiscoveryError(
          `${artifact.displayName} is not importable: ${artifact.diagnostic}`,
        );
        return;
      }
      if (artifact.kind === "model-addon") {
        if (!supportsNativeMediaModelAddonImport()) {
          setAddonImportError(
            "LoRA and embedding import is available in the native desktop app only.",
          );
          return;
        }
        setAddonImportLoading(true);
        setAddonImportInspection(null);
        setAddonImportResult(null);
        setAddonImportCivitaiSource(null);
        setAddonImportError(null);
        void inspectMediaModelAddon(artifact.path)
          .then(setAddonImportInspection)
          .catch((error: unknown) => {
            setAddonImportError(
              error instanceof Error
                ? error.message
                : "The discovered model add-on could not be inspected.",
            );
          })
          .finally(() => setAddonImportLoading(false));
        return;
      }
      if (artifact.kind === "checkpoint") {
        if (!supportsNativeMediaModelImport()) {
          setModelImportError(
            "Local model import is available in the native desktop app only.",
          );
          return;
        }
        setModelImportLoading(true);
        setModelImportInspection(null);
        setModelImportResult(null);
        setModelImportError(null);
        void inspectMediaLocalModel(artifact.path)
          .then(setModelImportInspection)
          .catch((error: unknown) => {
            setModelImportError(
              error instanceof Error
                ? error.message
                : "The discovered checkpoint could not be inspected.",
            );
          })
          .finally(() => setModelImportLoading(false));
        return;
      }
      setWorkspaceModelDiscoveryError(
        `${artifact.displayName} is managed as ${artifact.kind.replaceAll("-", " ")} and cannot use the single-file import flow.`,
      );
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
    setAddonImportCivitaiSource(null);
    setAddonImportResult(null);
    void inspectMediaCivitaiModelAddon(source)
      .then((inspection) => setCivitaiAddonInspection(inspection))
      .catch((error: unknown) => {
        setCivitaiAddonError(
          error instanceof Error
            ? error.message
            : "The Civitai model metadata could not be inspected.",
        );
      })
      .finally(() => setCivitaiAddonLoading(false));
  }, []);

  const downloadCivitaiAddon = useCallback(
    (request: DownloadMediaCivitaiModelAddonRequest): void => {
      const reviewedSource = civitaiAddonInspection;
      if (!reviewedSource) return;
      setCivitaiAddonLoading(true);
      setCivitaiAddonError(null);
      void downloadMediaCivitaiModelAddon(request)
        .then((inspection) => {
          setAddonImportCivitaiSource(reviewedSource);
          setAddonImportInspection(inspection);
          setCivitaiAddonInspection(null);
        })
        .catch((error: unknown) => {
          setCivitaiAddonError(
            error instanceof Error
              ? error.message
              : "The Civitai add-on could not be downloaded and verified.",
          );
        })
        .finally(() => setCivitaiAddonLoading(false));
    },
    [civitaiAddonInspection],
  );

  const dismissCivitaiAddon = useCallback((): void => {
    if (civitaiAddonLoading) return;
    setCivitaiAddonInspection(null);
    setCivitaiAddonError(null);
  }, [civitaiAddonLoading]);

  const importAddon = useCallback(
    (request: ImportMediaModelAddonRequest): void => {
      setAddonImportLoading(true);
      setAddonImportError(null);
      void importMediaModelAddon(request)
        .then((result) => {
          setAddonImportResult(result);
          refreshModelCatalog();
        })
        .catch((error: unknown) => {
          setAddonImportError(
            error instanceof Error
              ? error.message
              : "The model add-on could not be imported.",
          );
        })
        .finally(() => setAddonImportLoading(false));
    },
    [refreshModelCatalog],
  );

  const dismissAddonImport = useCallback((): void => {
    if (addonImportLoading) return;
    setAddonImportInspection(null);
    setAddonImportResult(null);
    setAddonImportError(null);
    setAddonImportCivitaiSource(null);
  }, [addonImportLoading]);

  const reviewAddonRemoval = useCallback((addonId: string): void => {
    setAddonRemovalLoading(true);
    setAddonRemovalError(null);
    setAddonRemovalResult(null);
    void planMediaModelAddonRemoval(addonId)
      .then((plan) => setAddonRemovalPlan(plan))
      .catch((error: unknown) => {
        setAddonRemovalError(
          error instanceof Error
            ? error.message
            : "The model add-on removal impact could not be inspected.",
        );
      })
      .finally(() => setAddonRemovalLoading(false));
  }, []);

  const confirmAddonRemoval = useCallback(
    (request: RemoveMediaModelAddonRequest): void => {
      setAddonRemovalLoading(true);
      setAddonRemovalError(null);
      void removeMediaModelAddon(request)
        .then((result) => {
          setAddonRemovalResult(result);
          refreshModelCatalog();
        })
        .catch((error: unknown) => {
          setAddonRemovalError(
            error instanceof Error
              ? error.message
              : "The model add-on could not be removed.",
          );
        })
        .finally(() => setAddonRemovalLoading(false));
    },
    [refreshModelCatalog],
  );

  const dismissAddonRemoval = useCallback((): void => {
    if (addonRemovalLoading) return;
    setAddonRemovalPlan(null);
    setAddonRemovalResult(null);
    setAddonRemovalError(null);
  }, [addonRemovalLoading]);

  const reviewModelInstall = useCallback((modelId: string): void => {
    setModelInstallJob((current) =>
      current && ["failed", "canceled"].includes(current.status)
        ? null
        : current,
    );
    setModelInstallLoading(true);
    setModelInstallError(null);
    void planMediaModelInstall(modelId)
      .then((plan) => setModelInstallPlan(plan))
      .catch((error: unknown) => {
        setModelInstallError(
          error instanceof Error
            ? error.message
            : "The installation plan could not be prepared.",
        );
      })
      .finally(() => setModelInstallLoading(false));
  }, []);

  const startModelInstall = useCallback(
    (request: StartMediaModelInstallRequest): void => {
      setModelInstallLoading(true);
      setModelInstallError(null);
      void startMediaModelInstall(request)
        .then((job) => setModelInstallJob(job))
        .catch((error: unknown) => {
          setModelInstallError(
            error instanceof Error
              ? error.message
              : "The model installation could not be started.",
          );
        })
        .finally(() => setModelInstallLoading(false));
    },
    [],
  );

  const cancelModelInstall = useCallback((jobId: string): void => {
    setModelInstallLoading(true);
    setModelInstallError(null);
    void cancelMediaModelInstall(jobId)
      .then((job) => setModelInstallJob(job))
      .catch((error: unknown) => {
        setModelInstallError(
          error instanceof Error
            ? error.message
            : "The model installation could not be canceled.",
        );
      })
      .finally(() => setModelInstallLoading(false));
  }, []);

  const reviewModelRemoval = useCallback((modelId: string): void => {
    setModelRemovalLoading(true);
    setModelRemovalError(null);
    setModelRemovalResult(null);
    void planMediaModelRemoval(modelId)
      .then((plan) => setModelRemovalPlan(plan))
      .catch((error: unknown) => {
        setModelRemovalError(
          error instanceof Error
            ? error.message
            : "The model removal plan could not be prepared.",
        );
      })
      .finally(() => setModelRemovalLoading(false));
  }, []);

  const confirmModelRemoval = useCallback(
    (request: RemoveMediaModelRequest): void => {
      setModelRemovalLoading(true);
      setModelRemovalError(null);
      void removeMediaModel(request)
        .then((result) => {
          setModelRemovalResult(result);
          setModelInstallJob(null);
          setModelInstallPlan(null);
          refreshModelCatalog();
        })
        .catch((error: unknown) => {
          setModelRemovalError(
            error instanceof Error
              ? error.message
              : "The installed model could not be removed.",
          );
        })
        .finally(() => setModelRemovalLoading(false));
    },
    [refreshModelCatalog],
  );

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
          setRuntimeError(normalizeMediaError(error, "initialize_media_runtime"));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [refreshRuntime]);

  useEffect(() => {
    refreshModelCatalog();
  }, [refreshModelCatalog]);

  useEffect(() => {
    refreshWorkspaceModels();
  }, [refreshWorkspaceModels]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void subscribeToUserSettingsChanged((kind) => {
      if (kind === "provider-keys") {
        refreshModelCatalog();
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
    if (
      !modelInstallJob ||
      ["installed", "failed", "canceled"].includes(modelInstallJob.status)
    ) {
      return;
    }
    const timeout = window.setTimeout(() => {
      void getMediaModelInstallJob(modelInstallJob.id)
        .then((job) => {
          setModelInstallJob(job);
          if (["installed", "failed", "canceled"].includes(job.status)) {
            refreshModelCatalog();
          }
        })
        .catch((error: unknown) => {
          setModelInstallError(
            error instanceof Error
              ? error.message
              : "Model installation progress could not be refreshed.",
          );
        });
    }, 400);
    return () => window.clearTimeout(timeout);
  }, [modelInstallJob, refreshModelCatalog]);

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
    if (
      state.activeSection === "models" &&
      hardware === null &&
      !hardwareLoading &&
      hardwareError === null
    ) {
      refreshHardware();
    }
  }, [
    hardware,
    hardwareError,
    hardwareLoading,
    refreshHardware,
    state.activeSection,
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

  const activeModelCatalog = useMemo<MediaModelCatalogSnapshot>(
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
  const models = activeModelCatalog.models;
  const recipeFlow = useMemo(() => {
    const [baseReference, ...additionalReferences] = state.recipe.referenceImages;
    return baseReference && state.recipe.outputFormat !== "svg"
      ? createImageEditFlow({
          id: "media-image-recipe-draft",
          createdAt: draftCreatedAt,
          settings: state.recipe,
          sourceAssetId: baseReference.assetId,
          referenceAssets: additionalReferences.map((reference) => ({
            assetId: reference.assetId,
            role: reference.role === "base" ? "subject" : reference.role,
            influence: reference.influence,
          })),
        })
      : createImageRecipeFlow({
          id: "media-image-recipe-draft",
          createdAt: draftCreatedAt,
          settings: state.recipe,
        });
  }, [draftCreatedAt, state.recipe]);
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
  const reviewRecipeFlow = useMemo(() => {
    const reviewFlow = createImageRecipeFlow({
      id: "media-image-review-draft",
      createdAt: draftCreatedAt,
      settings: state.recipe,
      review: {
        instructions: "Choose the strongest candidate for publication.",
        maxSelections: 1,
        requireComment: false,
      },
    });
    return {
      ...reviewFlow,
      name: "Generate & choose",
      description:
        "Generate image candidates, pause durably for a decision, and publish only the approved image.",
    };
  }, [draftCreatedAt, state.recipe]);
  const reviewRecipeLayout = useMemo(
    () => createMediaFlowLayout(reviewRecipeFlow),
    [reviewRecipeFlow],
  );
  const reviewRecipePlan = useMemo(
    () =>
      compileMediaFlow({
        flow: reviewRecipeFlow,
        models,
        addons: activeModelCatalog.addons,
        compiledAt: draftCreatedAt,
      }),
    [activeModelCatalog.addons, draftCreatedAt, models, reviewRecipeFlow],
  );
  const flow = useMemo(
    () => state.flow ?? recipeFlow,
    [recipeFlow, state.flow],
  );
  const layout = useMemo(
    () => reconcileMediaFlowLayout(flow, state.flowLayout),
    [flow, state.flowLayout],
  );
  const plan = useMemo(
    () =>
      compileMediaFlow({
        flow,
        models,
        addons: activeModelCatalog.addons,
        compiledAt: draftCreatedAt,
      }),
    [activeModelCatalog.addons, draftCreatedAt, flow, models],
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
  const recipePlanSnapshot = useMemo<MediaRunPlanSnapshot>(
    () => ({
      schemaVersion: 1,
      planId: recipePlan.id,
      flowId: recipeFlow.id,
      flowFingerprint: recipePlan.flowFingerprint,
      compiledAt: recipePlan.compiledAt,
      nodes: recipeFlow.nodes.map(({ id, type, label, layer }) => ({
        id,
        type,
        label,
        layer,
      })),
      steps: recipePlan.steps.map((step) => ({ ...step })),
    }),
    [recipeFlow.id, recipeFlow.nodes, recipePlan],
  );
  const reviewRecipePlanSnapshot = useMemo<MediaRunPlanSnapshot>(
    () => ({
      schemaVersion: 1,
      planId: reviewRecipePlan.id,
      flowId: reviewRecipeFlow.id,
      flowFingerprint: reviewRecipePlan.flowFingerprint,
      compiledAt: reviewRecipePlan.compiledAt,
      nodes: reviewRecipeFlow.nodes.map(({ id, type, label, layer }) => ({
        id,
        type,
        label,
        layer,
      })),
      steps: reviewRecipePlan.steps.map((step) => ({ ...step })),
    }),
    [reviewRecipeFlow.id, reviewRecipeFlow.nodes, reviewRecipePlan],
  );
  const flowPlanSnapshot = useMemo<MediaRunPlanSnapshot>(
    () => ({
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
    }),
    [flow.id, flow.nodes, plan],
  );
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
        reason: "Local utility execution requires exactly one Save asset output.",
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

  const videoFlowExecution = useMemo(() => {
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
    const resolvedFlow = resolveMediaFlowVariables(flow).flow;
    const videoNodes = resolvedFlow.nodes.filter(
      (node) => node.type === "task.generate-video",
    );
    if (videoNodes.length !== 1) {
      return unavailable("This flow does not contain exactly one video generation node.");
    }
    const videoBinding = plan.runtimeBindings.find(
      (binding) =>
        binding.nodeId === videoNodes[0]?.id &&
        binding.modality === "video" &&
        isExecutableLocalVideoModelId(binding.model.id),
    );
    if (plan.status !== "ready" || !videoBinding) {
      return unavailable("Resolve the local video model, runtime, and node contract diagnostics first.");
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
      | (typeof plan.runtimeBindings)[number]["model"]
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
      const imageBinding = plan.runtimeBindings.find(
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
        return unavailable("Choose an available Library image for the first video frame.");
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
      return unavailable("The active workspace root is required to resolve models safely.");
    }
    return {
      supported: true as const,
      reason:
        animatedBackground
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
  }, [
    flow,
    plan.runtimeBindings,
    plan.status,
    runtimeAssets,
    runtimeStatus?.directGenerationModelIds,
    workspaceRoot,
  ]);

  const remoteEditExecution = useMemo(
    () => assessRemoteEditExecution({
      plan,
      flow,
      assets: runtimeAssets,
      runtimeMode: runtimeStatus?.mode ?? null,
      directReferenceImageModelIds:
        runtimeStatus?.directReferenceImageModelIds ?? null,
    }),
    [flow, plan, runtimeAssets, runtimeStatus],
  );
  const recipeRemoteEditExecution = useMemo(
    () => assessRemoteEditExecution({
      plan: recipePlan,
      flow: recipeFlow,
      assets: runtimeAssets,
      runtimeMode: runtimeStatus?.mode ?? null,
      directReferenceImageModelIds:
        runtimeStatus?.directReferenceImageModelIds ?? null,
    }),
    [recipeFlow, recipePlan, runtimeAssets, runtimeStatus],
  );

  const selectSection = useCallback((activeSection: MediaStudioSection) => {
    setState((current) => ({ ...current, activeSection }));
  }, []);
  const changeFlowLayout = useCallback((flowLayout: MediaFlowLayout) => {
    setFlowRevisionNotice(null);
    setState((current) => ({ ...current, flowLayout }));
  }, []);
  const replaceSemanticFlow = useCallback((nextFlow: MediaFlow): void => {
    const recipe = readImageRecipeSettings(resolveMediaFlowVariables(nextFlow).flow);
    setRuntimeError(null);
    setState((current) => ({
      ...current,
      flow: nextFlow,
      recipe: recipe ?? current.recipe,
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
      setFlowRevisionNotice(`Forked ${result.flow.name} as a new editable flow.`);
    },
    [applySemanticFlow, changeFlowLayout],
  );
  const useAssetAsCreateReference = useCallback(
    (asset: MediaAssetRecord): void => {
      if (asset.kind !== "image") return;
      clearSemanticHistory();
      setFlowHistory(null);
      setFlowRunOverlayId(null);
      ++selectedRunDetailSequence.current;
      selectedRunIdRef.current = null;
      setSelectedRunId(null);
      setSelectedRun(null);
      setFlowRevisionNotice(null);
      setState((current) => ({
        ...current,
        activeSection: "generate",
        flow: null,
        flowLayout: null,
        recipe: {
          ...current.recipe,
          prompt: "",
          modelId: null,
          modelAddons: [],
          outputFormat:
            current.recipe.outputFormat === "svg"
              ? "png"
              : current.recipe.outputFormat,
          referenceImages: [
            {
              assetId: asset.id,
              role: "base",
              influence: 1,
            },
          ],
        },
      }));
    },
    [clearSemanticHistory],
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
        aspectRatio,
        loopMode,
        transparentBackground,
      });
      applySemanticFlow(videoFlow);
      changeFlowLayout(createMediaFlowLayout(videoFlow));
      setFlowHistory(null);
      setFlowRunOverlayId(null);
      setFlowRevisionNotice(
        sourceAssetId
          ? `Connected this image to both video endpoints as a ${aspectRatio} ${loopMode === "seamless" ? "closed seamless loop" : "one-way delivery that returns to the source pose; connect a distinct Last frame for progressive action"}. ${transparentBackground ? "Production alpha extraction is enabled because the source has verified cutout provenance." : "Opaque delivery is selected because the source does not have verified transparent-cutout provenance."}`
          : "Created a typed video draft. Connect reviewed first and last frames, then review motion, framing, and delivery settings before running.",
      );
      setState((current) => ({ ...current, activeSection: "flow" }));
    },
    [applySemanticFlow, changeFlowLayout],
  );
  const openVideoCreationFlow = useCallback(
    (): void => {
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
        });
        applySemanticFlow(generatedLoop);
        changeFlowLayout(createMediaFlowLayout(generatedLoop));
        setFlowHistory(null);
        setFlowRunOverlayId(null);
        setFlowRevisionNotice(
          "Created a connected local character loop: image generation → subject cutout → the same first/last video frame → transparent master and animated-background companion.",
        );
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
    },
    [
      applySemanticFlow,
      changeFlowLayout,
      openVideoFlowDraft,
      state.recipe.modelAddons,
      state.recipe.modelId,
      state.recipe.prompt,
      state.recipe.referenceImages,
      runtimeAssets,
    ],
  );
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
          ? "A seamless looping subject animation on a perfectly uniform chroma-green background; locked camera; subtle natural motion; keep the subject centered, fully visible, and unchanged; no shadows or background movement."
          : "A seamless looping animation of the exact supplied image; locked camera; subtle intentional subject motion; preserve identity, composition, lighting, and the existing background; no cuts, zooms, camera shake, or background-only motion.",
      });
    },
    [openVideoFlowDraft],
  );
  const openAssetInLibrary = useCallback((asset: MediaAssetRecord): void => {
    setImportedAssetId(asset.id);
    setState((current) => ({ ...current, activeSection: "library" }));
  }, []);
  const openAssetAsEditFlow = useCallback(
    (asset: MediaAssetRecord): void => {
      if (asset.kind !== "image") return;
      const createdAt = new Date().toISOString();
      const editFlow = createImageEditFlow({
        id: `media-image-edit-${createFlowSaveId()}`,
        createdAt,
        sourceAssetId: asset.id,
        settings: {
          ...state.recipe,
          prompt:
            "Describe the intended change while preserving all unspecified subject details.",
          outputCount: Math.min(state.recipe.outputCount, 4),
        },
      });
      applySemanticFlow(editFlow);
      changeFlowLayout(createMediaFlowLayout(editFlow));
      setFlowHistory(null);
      setFlowRunOverlayId(null);
      setFlowRevisionNotice(
        `Created a non-destructive edit flow from ${asset.digest.slice(0, 12)}. Review the prompt and upload manifest before running.`,
      );
      setState((current) => ({ ...current, activeSection: "flow" }));
    },
    [applySemanticFlow, changeFlowLayout, state.recipe],
  );
  const openTransformAsFlow = useCallback(
    (request: MediaImageTransformRequest): void => {
      const createdAt = new Date().toISOString();
      const transformFlow = createImageTransformFlow({
        id: `media-image-transform-${createFlowSaveId()}`,
        createdAt,
        request,
      });
      applySemanticFlow(transformFlow);
      changeFlowLayout(createMediaFlowLayout(transformFlow));
      setFlowHistory(null);
      setFlowRunOverlayId(null);
      setFlowRevisionNotice(
        "Created a model-free local transform flow. Review every pixel and encoding operation before running.",
      );
      setState((current) => ({ ...current, activeSection: "flow" }));
    },
    [applySemanticFlow, changeFlowLayout],
  );
  const openBackgroundRemovalAsFlow = useCallback(
    (asset: MediaAssetRecord): void => {
      if (asset.kind !== "image") return;
      const createdAt = new Date().toISOString();
      const backgroundFlow = createSubjectCutoutFlow({
        id: `media-subject-cutout-${createFlowSaveId()}`,
        createdAt,
        sourceAssetId: asset.id,
      });
      applySemanticFlow(backgroundFlow);
      changeFlowLayout(createMediaFlowLayout(backgroundFlow));
      setFlowHistory(null);
      setFlowRunOverlayId(null);
      setFlowRevisionNotice(
        "Created a local subject-cutout flow with ordered model priority and fallback. Pixels remain on this device, and the flow can publish both the transparent cutout and its matte.",
      );
      setState((current) => ({ ...current, activeSection: "flow" }));
    },
    [applySemanticFlow, changeFlowLayout],
  );
  const openAlphaMatteAsFlow = useCallback(
    (asset: MediaAssetRecord): void => {
      if (asset.kind !== "image") return;
      const createdAt = new Date().toISOString();
      const alphaFlow = createAlphaMatteFlow({
        id: `media-alpha-matte-${createFlowSaveId()}`,
        createdAt,
        sourceAssetId: asset.id,
      });
      applySemanticFlow(alphaFlow);
      changeFlowLayout(createMediaFlowLayout(alphaFlow));
      setFlowHistory(null);
      setFlowRunOverlayId(null);
      setFlowRevisionNotice(
        "Created a local alpha-channel flow. It publishes the exact 8-bit matte as a lossless immutable asset without a model or network request.",
      );
      setState((current) => ({ ...current, activeSection: "flow" }));
    },
    [applySemanticFlow, changeFlowLayout],
  );
  const openCompositeAsFlow = useCallback(
    (foreground: MediaAssetRecord, background: MediaAssetRecord): void => {
      if (foreground.kind !== "image" || background.kind !== "image") return;
      const createdAt = new Date().toISOString();
      const compositeFlow = createImageCompositeFlow({
        id: `media-composite-${createFlowSaveId()}`,
        createdAt,
        foregroundAssetId: foreground.id,
        backgroundAssetId: background.id,
      });
      applySemanticFlow(compositeFlow);
      changeFlowLayout(createMediaFlowLayout(compositeFlow));
      setFlowHistory(null);
      setFlowRunOverlayId(null);
      setFlowRevisionNotice(
        "Created a local foreground-over-background flow. The background defines the canvas; review fit and opacity before running.",
      );
      setState((current) => ({ ...current, activeSection: "flow" }));
    },
    [applySemanticFlow, changeFlowLayout],
  );
  const openContactSheetAsFlow = useCallback(
    (assets: readonly MediaAssetRecord[]): void => {
      if (assets.length < 2 || assets.some((asset) => asset.kind !== "image")) return;
      const createdAt = new Date().toISOString();
      const contactSheetFlow = createImageContactSheetFlow({
        id: `media-contact-sheet-${createFlowSaveId()}`,
        createdAt,
        sourceAssetIds: assets.map((asset) => asset.id),
      });
      applySemanticFlow(contactSheetFlow);
      changeFlowLayout(createMediaFlowLayout(contactSheetFlow));
      setFlowHistory(null);
      setFlowRunOverlayId(null);
      setFlowRevisionNotice(
        `Created a local comparison flow from ${assets.length} ordered images. Review columns, cell size, labels, and background before running.`,
      );
      setState((current) => ({ ...current, activeSection: "flow" }));
    },
    [applySemanticFlow, changeFlowLayout],
  );
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
  const changeRecipe = useCallback(
    (recipe: ImageRecipeSettings): void => {
      clearSemanticHistory();
      setFlowRevisionNotice(null);
      setState((current) => ({ ...current, recipe, flow: null }));
    },
    [clearSemanticHistory],
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
        setFlowRevisionNotice(`Copied ${clipboard.label} with internal connections.`);
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
        setRuntimeError(normalizeMediaError(error, "media_get_flow"));
      })
      .finally(() => setFlowRevisionLoading(false));
  }, [flow.id]);

  const refreshSavedFlows = useCallback((): void => {
    setSavedFlowsLoading(true);
    void listMediaFlows()
      .then((heads) => {
        setSavedFlows(heads);
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
          const openedFlow = upgradeMediaFlowQualityDefaults({
            flow: head.flow,
            updatedAt: new Date().toISOString(),
          });
          const upgraded =
            createMediaFlowDocumentDigest(openedFlow) !== head.documentDigest;
          const recipe = readImageRecipeSettings(openedFlow);
          clearSemanticHistory();
          setFlowHistory(history);
          setFlowRunOverlayId(null);
          setState((current) => ({
            ...current,
            activeSection: "flow",
            recipe: recipe ?? current.recipe,
            flow: openedFlow,
            flowLayout: head.layout,
          }));
          setFlowRevisionNotice(
            upgraded
              ? `Opened ${openedFlow.name}. New quality defaults are an unsaved draft.`
              : `Opened ${openedFlow.name} at revision ${head.revisionNumber}.`,
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
          void getMediaFlow(sourceFlow.id).then(setFlowHistory).catch(() => undefined);
        }
        return null;
      } finally {
        setFlowRevisionLoading(false);
      }
    },
    [flowHistory, flowRevisionLoading],
  );

  const saveCurrentFlowRevision = useCallback((): void => {
    void persistFlowRevision(flow, layout, "Saved from the guided image recipe");
  }, [flow, layout, persistFlowRevision]);

  const openRecipeAsFlow = useCallback((): void => {
    clearSemanticHistory();
    setFlowHistory(null);
    setFlowRunOverlayId(null);
    setFlowRevisionNotice("Opened the current guided recipe as an editable semantic flow.");
    setState((current) => ({
      ...current,
      activeSection: "flow",
      flow: recipeFlow,
      flowLayout: recipeLayout,
    }));
  }, [clearSemanticHistory, recipeFlow, recipeLayout]);

  const restoreFlowRevision = useCallback(
    (revision: MediaFlowRevision): void => {
      const restoredFlow = upgradeMediaFlowQualityDefaults({
        flow: revision.flow,
        updatedAt: new Date().toISOString(),
      });
      const recipe = readImageRecipeSettings(restoredFlow);
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
          recipe: recipe ?? current.recipe,
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
        setRuntimeError(normalizeMediaError(error, "media_inspect_flow_import"));
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
        const importedFlow = upgradeMediaFlowQualityDefaults({
          flow: result.revision.flow,
          updatedAt: new Date().toISOString(),
        });
        const importedLayout = result.revision.layout;
        const recipe = readImageRecipeSettings(importedFlow);
        const upgraded = importedFlow !== result.revision.flow;
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
          recipe: recipe ?? current.recipe,
          flow: importedFlow,
          flowLayout: importedLayout,
        }));
        setFlowRevisionNotice(
          `${
            result.created
              ? `Imported immutable revision 1 as isolated flow ${result.targetFlowId}.`
              : `This reviewed bundle already exists as ${result.targetFlowId}.`
          }${
            upgraded
              ? " New quality defaults were applied to the local draft; save once to pin the upgraded revision."
              : ""
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
        setRuntimeError(normalizeMediaError(error, "media_export_flow_revision"));
      })
      .finally(() => setFlowPortabilityLoading(false));
  }, [
    flow.id,
    flowHistory,
    flowPortabilityLoading,
    hasUnsavedFlowChanges,
  ]);

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
    setLocalFlowPending(true);
    setRuntimeError(null);
    setFlowRevisionNotice(null);
    void persistFlowRevision(
      flow,
      layout,
      "Pinned automatically for local utility execution",
    )
      .then((revisionResult) => {
        if (!revisionResult) {
          return null;
        }
        const request: ExecuteLocalImageFlowRequest = {
          schemaVersion: 1,
          runId: createRunId(),
          flowId: flow.id,
          flowRevisionId: revisionResult.revision.revisionId,
          planId: plan.id,
          planSnapshot: flowPlanSnapshot,
        };
        ++selectedRunDetailSequence.current;
        selectedRunIdRef.current = request.runId;
        setSelectedRunId(request.runId);
        setSelectedRun(null);
        setFlowRunOverlayId(request.runId);
        return executeMediaLocalImageFlow(request, flow);
      })
      .then((detail) => {
        if (!detail) {
          return undefined;
        }
        ++selectedRunDetailSequence.current;
        selectedRunIdRef.current = detail.id;
        setSelectedRunId(detail.id);
        setSelectedRun(detail);
        setFlowRunOverlayId(detail.id);
        setFlowRevisionNotice(
          runtimeStatus?.mode === "native"
            ? `Executed pinned revision locally and published ${detail.assets.length} immutable output${detail.assets.length === 1 ? "" : "s"}.`
            : `Ran the pinned browser fixture and published ${detail.assets.length} preview asset${detail.assets.length === 1 ? "" : "s"}; no source pixels were transformed.`,
        );
        return refreshRuntime();
      })
      .catch((error: unknown) => {
        setRuntimeError(normalizeMediaError(error, "execute_local_image_flow"));
      })
      .finally(() => setLocalFlowPending(false));
  }, [
    flow,
    flowPlanSnapshot,
    layout,
    localFlowExecution.supported,
    localFlowPending,
    persistFlowRevision,
    plan.id,
    refreshRuntime,
    runtimeStatus?.mode,
  ]);
  const runVideoFlow = useCallback((): void => {
    if (!videoFlowExecution.supported || localFlowPending) {
      return;
    }
    const normalizedWorkspaceRoot = workspaceRoot?.trim();
    if (!normalizedWorkspaceRoot) return;
    setLocalFlowPending(true);
    setRuntimeError(null);
    setFlowRevisionNotice(null);
    void persistFlowRevision(
      flow,
      layout,
      "Pinned automatically for local video execution",
    )
      .then(async (revisionResult) => {
        if (
          !revisionResult ||
          !videoFlowExecution.videoNode ||
          !videoFlowExecution.videoModel
        ) {
          return null;
        }
        const resolvedFlow = resolveMediaFlowVariables(flow).flow;
        const promptNode = resolvedFlow.nodes.find(
          (node) => node.type === "source.prompt",
        );
        const prompt =
          typeof promptNode?.config.prompt === "string"
            ? promptNode.config.prompt.trim()
            : "";
        const configuredAspect =
          videoFlowExecution.videoNode.config.aspectRatio;
        const aspectRatio =
          configuredAspect === "16:9" ||
          configuredAspect === "9:16" ||
          configuredAspect === "21:9"
            ? configuredAspect
            : "1:1";
        const videoConfig = videoFlowExecution.videoNode.config;
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
        const selectedVideoModelId = videoFlowExecution.videoModel.id;
        if (!isExecutableLocalVideoModelId(selectedVideoModelId)) {
          throw new Error(
            "The resolved video model does not have an executable local adapter.",
          );
        }
        const videoExecutionSettings = resolveMediaVideoExecutionSettings(
          videoConfig,
          videoFlowExecution.videoModel.architecture,
        );
        const runVideo = (
          firstFrameAssetId: string,
          lastFrameAssetId: string,
        ) => {
          const request = {
            schemaVersion: 1,
            runId: createRunId(),
            flowId: flow.id,
            flowRevisionId: revisionResult.revision.revisionId,
            flowName: flow.name,
            planId: plan.id,
            prompt,
            modelId: selectedVideoModelId,
            modelLabel: videoFlowExecution.videoModel.displayName,
            diagnosticCount: plan.diagnostics.length,
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
              typeof videoConfig.fps === "number"
                ? videoConfig.fps
                : 8,
            numFrames:
              typeof videoConfig.numFrames === "number"
                ? videoConfig.numFrames
                : 33,
            numInferenceSteps: videoExecutionSettings.numInferenceSteps,
            guidanceScale: videoExecutionSettings.guidanceScale,
            seed:
              typeof videoConfig.seed === "number"
                ? videoConfig.seed
                : 0,
            negativePrompt:
              typeof videoConfig.negativePrompt === "string"
                ? videoConfig.negativePrompt
                : "",
            matteQuality,
            encodingQuality,
            memoryProfile,
            experimentalLowMemory: true,
            animatedBackground: videoFlowExecution.animatedBackground,
            planSnapshot: flowPlanSnapshot,
          } satisfies GenerateMediaVideoRequest;
          ++selectedRunDetailSequence.current;
          selectedRunIdRef.current = request.runId;
          setSelectedRunId(request.runId);
          setSelectedRun(null);
          setFlowRunOverlayId(request.runId);
          return generateMediaVideo(request);
        };
        if (
          videoFlowExecution.generatedFrame &&
          videoFlowExecution.imageModel &&
          videoFlowExecution.imageSettings
        ) {
          const settings = videoFlowExecution.imageSettings;
          const imageRequest = {
            schemaVersion: 1,
            runId: createRunId(),
            flowId: flow.id,
            flowRevisionId: revisionResult.revision.revisionId,
            flowName: `${flow.name} · endpoint frame`,
            planId: plan.id,
            prompt: settings.prompt,
            modelId: videoFlowExecution.imageModel.id,
            modelLabel: videoFlowExecution.imageModel.displayName,
            outputCount: 1,
            diagnosticCount: plan.diagnostics.length,
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
            memoryProfile: settings.memoryProfile ?? "auto",
            planSnapshot: flowPlanSnapshot,
          } satisfies GenerateMediaImagesRequest;
          ++selectedRunDetailSequence.current;
          selectedRunIdRef.current = imageRequest.runId;
          setSelectedRunId(imageRequest.runId);
          setSelectedRun(null);
          setFlowRunOverlayId(imageRequest.runId);
          setFlowRevisionNotice(
            `Generating the shared video endpoint with ${videoFlowExecution.imageModel.displayName}…`,
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
          setFlowRevisionNotice(
            "Endpoint frame published with alpha. Reusing its exact immutable asset id for both video conditions…",
          );
          return runVideo(endpoint.id, endpoint.id);
        }
        if (
          !videoFlowExecution.firstFrameAssetId ||
          !videoFlowExecution.lastFrameAssetId
        ) {
          throw new Error("The video endpoint assets are no longer available.");
        }
        return runVideo(
          videoFlowExecution.firstFrameAssetId,
          videoFlowExecution.lastFrameAssetId,
        );
      })
      .then((detail) => {
        if (!detail) return undefined;
        ++selectedRunDetailSequence.current;
        selectedRunIdRef.current = detail.id;
        setSelectedRunId(detail.id);
        setSelectedRun(detail);
        setFlowRunOverlayId(detail.id);
        const outputs = detail.assets.filter((asset) => asset.kind === "video");
        const videoConfig = videoFlowExecution.videoNode?.config;
        const transparent = videoConfig?.transparentBackground === true;
        const loopMode =
          videoConfig?.loopMode === "ping-pong" ||
          videoConfig?.loopMode === "seamless"
            ? videoConfig.loopMode
            : "none";
        const ending =
          loopMode === "seamless"
            ? "with an exact seamless endpoint"
            : loopMode === "ping-pong"
              ? "with an exact ping-pong endpoint"
              : "as an intentional one-way shot";
        setFlowRevisionNotice(
          outputs.length > 0
            ? outputs.length > 1
              ? `Published the verified VP9 alpha master and animated-background companion ${ending}, with immutable endpoint lineage.`
              : `Published a verified ${transparent ? "transparent" : "opaque"} VP9 WebM ${ending}, with immutable first/last-frame lineage.`
            : "Local video execution completed without a published video; inspect the run evidence.",
        );
        return refreshRuntime();
      })
      .catch((error: unknown) => {
        setRuntimeError(normalizeMediaError(error, "generate_local_video"));
      })
      .finally(() => setLocalFlowPending(false));
  }, [
    flow,
    flowPlanSnapshot,
    layout,
    localFlowPending,
    persistFlowRevision,
    plan.diagnostics.length,
    plan.id,
    refreshRuntime,
    videoFlowExecution,
    workspaceRoot,
  ]);
  const runRemoteEditFlow = useCallback((): void => {
    if (!remoteEditExecution.supported || remoteEditPending) {
      return;
    }
    setRemoteEditPending(true);
    setRuntimeError(null);
    setFlowRevisionNotice(null);
    void persistFlowRevision(
      flow,
      layout,
      "Pinned automatically for confirmed remote image edit",
    )
      .then((revisionResult) => {
        if (!revisionResult) {
          return null;
        }
        const request: ExecuteRemoteImageEditFlowRequest = {
          schemaVersion: 1,
          runId: createRunId(),
          flowId: flow.id,
          flowRevisionId: revisionResult.revision.revisionId,
          planId: plan.id,
          planSnapshot: flowPlanSnapshot,
          allowRemoteUpload: true,
        };
        ++selectedRunDetailSequence.current;
        selectedRunIdRef.current = request.runId;
        setSelectedRunId(request.runId);
        setSelectedRun(null);
        setFlowRunOverlayId(request.runId);
        return executeMediaRemoteImageEditFlow(request, flow);
      })
      .then((detail) => {
        if (!detail) {
          return undefined;
        }
        ++selectedRunDetailSequence.current;
        selectedRunIdRef.current = detail.id;
        setSelectedRunId(detail.id);
        setSelectedRun(detail);
        setFlowRunOverlayId(detail.id);
        setFlowRevisionNotice(
          detail.status === "needs-review"
            ? "OpenAI acceptance is uncertain. Automatic retry is blocked; review the provider job in Runs."
            : runtimeStatus?.mode === "browser-preview"
              ? "Ran the pinned browser edit fixture. No provider request, upload, or charge occurred."
              : `Submitted ${remoteEditExecution.manifest.length} audited reference upload${remoteEditExecution.manifest.length === 1 ? "" : "s"} and published ${detail.assets.length} immutable output${detail.assets.length === 1 ? "" : "s"}.`,
        );
        return refreshRuntime();
      })
      .catch((error: unknown) => {
        setRuntimeError(normalizeMediaError(error, "execute_remote_image_edit_flow"));
      })
      .finally(() => setRemoteEditPending(false));
  }, [
    flow,
    flowPlanSnapshot,
    layout,
    persistFlowRevision,
    plan.id,
    refreshRuntime,
    remoteEditExecution,
    remoteEditPending,
    runtimeStatus?.mode,
  ]);
  const runRecipeGeneration = useCallback((requiresReview: boolean) => {
    const activeFlow = requiresReview ? reviewRecipeFlow : recipeFlow;
    const activeLayout = requiresReview ? reviewRecipeLayout : recipeLayout;
    const activePlan = requiresReview ? reviewRecipePlan : recipePlan;
    const activePlanSnapshot = requiresReview
      ? reviewRecipePlanSnapshot
      : recipePlanSnapshot;
    const model = activePlan.model;
    const isSvg = state.recipe.outputFormat === "svg";
    const isSvgVectorization = isSvg && state.recipe.svgMode === "vectorize";
    const hasReferences = state.recipe.referenceImages.length > 0;
    const localReferenceEdit =
      !isSvg &&
      hasReferences &&
      state.recipe.referenceImages.length === 1 &&
      model?.target === "local" &&
      (runtimeStatus?.directReferenceImageModelIds ?? []).includes(model.id);
    const imageTaskConfig = activeFlow.nodes.find(
      (node) =>
        node.type === "task.generate-image" ||
        node.type === "task.edit-image",
    )?.config;
    if (
      activePlan.status !== "ready" ||
      !model ||
      (requiresReview && (hasReferences || state.recipe.outputCount < 2)) ||
      (isSvg
        ? !(runtimeStatus?.directGenerationModelIds ?? []).includes(model.id) ||
          (hasReferences &&
            !(runtimeStatus?.directReferenceImageModelIds ?? []).includes(model.id))
        : hasReferences
          ? !localReferenceEdit && !recipeRemoteEditExecution.supported
          : !(runtimeStatus?.directGenerationModelIds ?? []).includes(model.id)) ||
      state.recipe.qualityGateEnabled ||
      generationPending
    ) {
      return;
    }
    setGenerationPending(true);
    setRuntimeError(null);
    void persistFlowRevision(
      activeFlow,
      activeLayout,
      requiresReview
        ? "Pinned automatically for guided candidate review"
        : "Pinned automatically for direct image generation",
    )
      .then((revisionResult) => {
        if (!revisionResult) {
          return null;
        }
        if (isSvg) {
          const candidateCount = isSvgVectorization
            ? 1
            : Math.max(
                state.recipe.outputCount,
                Math.min(
                  model.id.startsWith("recraft:") ? 6 : 16,
                  state.recipe.svgCandidateCount ?? 6,
                ),
              );
          return generateMediaSvg({
            schemaVersion: 1,
            runId: createRunId(),
            flowId: activeFlow.id,
            flowRevisionId: revisionResult.revision.revisionId,
            flowName: activeFlow.name,
            planId: activePlan.id,
            prompt: state.recipe.prompt,
            modelId: model.id,
            modelLabel: activePlan.preflight.modelLabel,
            outputCount: activePlan.preflight.generatedCandidates,
            candidateCount,
            diagnosticCount: activePlan.diagnostics.length,
            aspectRatio: state.recipe.aspectRatio,
            modelPolicy: state.recipe.modelPolicy,
            transparentBackground: state.recipe.transparentBackground,
            mode: state.recipe.svgMode ?? "generate",
            autoCrop: state.recipe.svgAutoCrop !== false,
            targetSize: state.recipe.svgTargetSize ?? 1024,
            style: state.recipe.svgStyle ?? "illustration",
            textPolicy: state.recipe.svgTextPolicy ?? "avoid",
            criticEnabled:
              !isSvgVectorization &&
              model.target === "remote" &&
              state.recipe.modelPolicy === "quality" &&
              state.recipe.svgCriticEnabled === true,
            referenceImages: state.recipe.referenceImages,
            allowRemoteUpload: model.target === "remote" && hasReferences,
            planSnapshot: activePlanSnapshot,
          } satisfies GenerateMediaSvgRequest);
        }
        if (hasReferences && !localReferenceEdit) {
          const request: ExecuteRemoteImageEditFlowRequest = {
            schemaVersion: 1,
            runId: createRunId(),
            flowId: activeFlow.id,
            flowRevisionId: revisionResult.revision.revisionId,
            planId: activePlan.id,
            planSnapshot: activePlanSnapshot,
            allowRemoteUpload: true,
          };
          return executeMediaRemoteImageEditFlow(request, activeFlow);
        }
        return generateMediaImages({
          schemaVersion: 1,
          runId: createRunId(),
          flowId: activeFlow.id,
          flowRevisionId: revisionResult.revision.revisionId,
          flowName: activeFlow.name,
          planId: activePlan.id,
          prompt: state.recipe.prompt,
          modelId: model.id,
          modelLabel: activePlan.preflight.modelLabel,
          outputCount: activePlan.preflight.generatedCandidates,
          diagnosticCount: activePlan.diagnostics.length,
          aspectRatio: state.recipe.aspectRatio,
          outputFormat:
            state.recipe.outputFormat === "svg"
              ? "png"
              : state.recipe.outputFormat,
          modelPolicy: state.recipe.modelPolicy,
          modelAddons: state.recipe.modelAddons,
          transparentBackground: state.recipe.transparentBackground,
          subjectCutoutModelPriority: readFlowSubjectCutoutModelPriority(activeFlow),
          negativePrompt: "",
          referenceImageAssetId:
            localReferenceEdit
              ? state.recipe.referenceImages[0]?.assetId ?? null
              : null,
          editStrength:
            localReferenceEdit &&
            typeof imageTaskConfig?.editStrength === "number"
              ? imageTaskConfig.editStrength
              : undefined,
          referenceBoost:
            localReferenceEdit &&
            typeof imageTaskConfig?.referenceBoost === "number"
              ? imageTaskConfig.referenceBoost
              : undefined,
          requireChromaBackground:
            localReferenceEdit &&
            imageTaskConfig?.requireChromaBackground === true,
          groundingPixels:
            localReferenceEdit &&
            typeof imageTaskConfig?.groundingPixels === "number"
              ? imageTaskConfig.groundingPixels
              : undefined,
          referenceFit:
            localReferenceEdit && imageTaskConfig?.referenceFit === "crop"
              ? "crop"
              : localReferenceEdit
                ? "fit"
                : undefined,
          memoryProfile:
            imageTaskConfig?.memoryProfile === "memory-saver" ||
            imageTaskConfig?.memoryProfile === "balanced" ||
            imageTaskConfig?.memoryProfile === "maximum-speed"
              ? imageTaskConfig.memoryProfile
              : "auto",
          planSnapshot: activePlanSnapshot,
        } satisfies GenerateMediaImagesRequest);
      })
      .then((detail) => {
        if (!detail) {
          return undefined;
        }
        ++selectedRunDetailSequence.current;
        selectedRunIdRef.current = detail.id;
        setSelectedRunId(detail.id);
        setSelectedRun(detail);
        return refreshRuntime();
      })
      .catch((error: unknown) => {
        setRuntimeError(
          normalizeMediaError(
            error,
            hasReferences ? "generate_images_with_references" : "generate_images",
          ),
        );
      })
      .finally(() => setGenerationPending(false));
  }, [
    generationPending,
    persistFlowRevision,
    recipeFlow,
    recipeLayout,
    recipePlan,
    recipePlanSnapshot,
    recipeRemoteEditExecution.supported,
    refreshRuntime,
    reviewRecipeFlow,
    reviewRecipeLayout,
    reviewRecipePlan,
    reviewRecipePlanSnapshot,
    runtimeStatus?.directGenerationModelIds,
    runtimeStatus?.directReferenceImageModelIds,
    state.recipe.aspectRatio,
    state.recipe.modelAddons,
    state.recipe.modelPolicy,
    state.recipe.outputCount,
    state.recipe.outputFormat,
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
  const runGeneration = useCallback(
    () => runRecipeGeneration(false),
    [runRecipeGeneration],
  );
  const runGenerationWithReview = useCallback(
    () => runRecipeGeneration(true),
    [runRecipeGeneration],
  );
  const selectRun = useCallback((runId: string) => {
    const requestSequence = ++selectedRunDetailSequence.current;
    selectedRunIdRef.current = runId;
    setSelectedRunId(runId);
    setSelectedRun(null);
    void getMediaRunDetail(runId)
      .then((detail) => {
        if (
          requestSequence !== selectedRunDetailSequence.current ||
          selectedRunIdRef.current !== runId
        ) {
          return;
        }
        setSelectedRun(detail);
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
  }, [presentRunFailure]);
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
    if (
      !loaded ||
      importLoading ||
      claimedImportPath.current === importPath
    ) {
      return;
    }

    claimedImportPath.current = importPath;
    onImportPathHandled?.();
    setState((current) => ({ ...current, activeSection: "library" }));
    setImportLoading(true);
    setRuntimeError(null);
    setExportNotice(null);
    void importMediaImage(importPath)
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
  }, [
    importLoading,
    importPath,
    loaded,
    onImportPathHandled,
    refreshRuntime,
  ]);
  const inspectRunInFlow = useCallback((run: MediaRunDetail): void => {
    ++selectedRunDetailSequence.current;
    selectedRunIdRef.current = run.id;
    setSelectedRunId(run.id);
    setSelectedRun(run);
    setFlowRunOverlayId(run.id);
    setState((current) => ({ ...current, activeSection: "flow" }));
  }, []);
  const cancelRun = useCallback(
    (runId: string) => {
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
          setRuntimeError(normalizeMediaError(error, "resolve_provider_review"));
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
  const importImages = useCallback(() => {
    if (importLoading || !supportsNativeMediaImport()) {
      return;
    }

    setImportLoading(true);
    setRuntimeError(null);
    setExportNotice(null);
    void (async () => {
      const selected = await openDialog({
        multiple: true,
        directory: false,
        title: "Import validated images or safe SVG rasters",
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
      if (paths.length === 0) {
        return;
      }
      if (paths.length > 20) {
        throw new Error("Import at most 20 images in one reviewed batch.");
      }

      let lastDetail: MediaRunDetail | null = null;
      for (const path of paths) {
        lastDetail = (await importMediaImage(path)).detail;
      }
      if (lastDetail) {
        ++selectedRunDetailSequence.current;
        selectedRunIdRef.current = lastDetail.id;
        setSelectedRunId(lastDetail.id);
        setSelectedRun(lastDetail);
      }
      setState((current) => ({ ...current, activeSection: "library" }));
      await refreshRuntime();
    })()
      .catch((error: unknown) => {
        setRuntimeError(normalizeMediaError(error, "import_media"));
      })
      .finally(() => setImportLoading(false));
  }, [importLoading, refreshRuntime]);
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
      const remaining = 8 - state.recipe.referenceImages.length;
      if (paths.length > remaining) {
        throw new Error(
          `Add at most ${remaining} more reference image${remaining === 1 ? "" : "s"}.`,
        );
      }

      const importedAssets: MediaAssetRecord[] = [];
      for (const path of paths) {
        const result = await importMediaImage(path);
        importedAssets.push(result.asset);
      }
      if (importedAssets.length === 0) return;
      setState((current) => {
        const existingIds = new Set(
          current.recipe.referenceImages.map((reference) => reference.assetId),
        );
        const additions = importedAssets
          .filter((asset) => !existingIds.has(asset.id))
          .map((asset, index) => ({
            assetId: asset.id,
            role:
              current.recipe.referenceImages.length === 0 && index === 0
                ? "base" as const
                : "subject" as const,
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
          flow: null,
        };
      });
      await refreshRuntime();
    })()
      .catch((error: unknown) => {
        setRuntimeError(normalizeMediaError(error, "import_reference_images"));
      })
      .finally(() => setImportLoading(false));
  }, [importLoading, refreshRuntime, state.recipe.referenceImages.length]);
  const transformImage = useCallback(
    (request: MediaImageTransformRequest) => {
      if (transformLoading) {
        return;
      }
      setTransformLoading(true);
      setRuntimeError(null);
      setExportNotice(null);
      void transformMediaImage(request)
        .then((detail) => {
          ++selectedRunDetailSequence.current;
          selectedRunIdRef.current = detail.id;
          setSelectedRunId(detail.id);
          setSelectedRun(detail);
          return refreshRuntime();
        })
        .catch((error: unknown) => {
          setRuntimeError(normalizeMediaError(error, "transform_image"));
        })
        .finally(() => setTransformLoading(false));
    },
    [refreshRuntime, transformLoading],
  );
  const analyzeQuality = useCallback(
    (asset: MediaAssetRecord) => {
      if (asset.kind !== "image" || qualityLoadingAssetId !== null) {
        return;
      }
      setQualityLoadingAssetId(asset.id);
      setRuntimeError(null);
      setExportNotice(null);
      void analyzeMediaImageQuality(asset.id)
        .then(({ detail, report }) => {
          const reportAsset = detail.assets.find(
            (candidate) => candidate.kind === "report",
          );
          if (!reportAsset) {
            throw new Error("Quality analysis completed without a report asset.");
          }
          setQualityReports((current) => ({
            ...current,
            [reportAsset.id]: report,
          }));
          ++selectedRunDetailSequence.current;
          selectedRunIdRef.current = detail.id;
          setSelectedRunId(detail.id);
          setSelectedRun(detail);
          return refreshRuntime();
        })
        .catch((error: unknown) => {
          setRuntimeError(normalizeMediaError(error, "analyze_image_quality"));
        })
        .finally(() => setQualityLoadingAssetId(null));
    },
    [qualityLoadingAssetId, refreshRuntime],
  );
  const loadQualityReport = useCallback(
    (reportAssetId: string) => {
      if (qualityReports[reportAssetId] || qualityLoadingAssetId !== null) {
        return;
      }
      setQualityLoadingAssetId(reportAssetId);
      setRuntimeError(null);
      void readMediaQualityReport(reportAssetId)
        .then((report) => {
          setQualityReports((current) => ({
            ...current,
            [reportAssetId]: report,
          }));
        })
        .catch((error: unknown) => {
          setRuntimeError(normalizeMediaError(error, "read_quality_report"));
        })
        .finally(() => setQualityLoadingAssetId(null));
    },
    [qualityLoadingAssetId, qualityReports],
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
  const autoTagAsset = useCallback(
    (assetId: string) => {
      if (tagLoadingAssetId !== null) {
        return;
      }
      setTagLoadingAssetId(assetId);
      setRuntimeError(null);
      void autoTagMediaAsset(assetId)
        .then(() => refreshRuntime())
        .catch((error: unknown) => {
          setRuntimeError(normalizeMediaError(error, "auto_tag_asset"));
        })
        .finally(() => setTagLoadingAssetId(null));
    },
    [refreshRuntime, tagLoadingAssetId],
  );
  const exportAsset = useCallback(
    (asset: MediaAssetRecord, mode: MediaAssetExportMode) => {
      if (exportLoading || !supportsNativeMediaExport()) {
        return;
      }
      const effectiveMode: MediaAssetExportMode =
        asset.mimeType === "image/svg+xml" || asset.mimeType === "video/webm"
          ? "verified-original"
          : mode;
      const extension =
        asset.mimeType === "image/jpeg"
          ? "jpg"
          : asset.mimeType === "image/webp"
            ? "webp"
            : asset.mimeType === "image/svg+xml"
              ? "svg"
              : asset.mimeType === "video/webm"
                ? "webm"
                : "png";
      const formatLabel =
        asset.mimeType === "image/jpeg"
          ? "JPEG image"
          : asset.mimeType === "image/webp"
            ? "WebP image"
            : asset.mimeType === "image/svg+xml"
              ? "Secure Static SVG"
              : asset.mimeType === "video/webm"
                ? "WebM video"
                : "PNG image";
      setExportLoading(true);
      setRuntimeError(null);
      setExportNotice(null);
      void (async () => {
        const destination = await saveDialog({
          title:
            effectiveMode === "metadata-stripped"
              ? "Export privacy-clean Media Studio image"
              : "Export verified Media Studio original",
          defaultPath: `media-${asset.digest.slice(0, 12)}${
            effectiveMode === "metadata-stripped" ? "-clean" : ""
          }.${extension}`,
          filters: [{ name: formatLabel, extensions: [extension] }],
        });
        if (!destination) {
          return;
        }
        const record = await exportMediaAsset({
          assetId: asset.id,
          destinationPath: destination,
          mode: effectiveMode,
        });
        const fileName = record.destinationPath.split(/[\\/]/).at(-1);
        setExportNotice(
          record.metadataStripped
            ? `Exported ${fileName ?? "asset"} without embedded metadata; local lineage ${record.sourceDigest.slice(0, 12)}… remains intact (output ${record.digest.slice(0, 12)}…).`
            : `Exported ${fileName ?? "asset"} after exact-byte SHA-256 verification (${record.digest.slice(0, 12)}…).`,
        );
        await refreshRuntime();
      })()
        .catch((error: unknown) => {
          setRuntimeError(normalizeMediaError(error, "export_asset"));
        })
        .finally(() => setExportLoading(false));
    },
    [exportLoading, refreshRuntime],
  );
  const planAssetDeletion = useCallback(
    async (assetId: string): Promise<MediaAssetDeletionImpact> => {
      setRuntimeError(null);
      setDeletionNotice(null);
      try {
        return await planMediaAssetDeletion(assetId);
      } catch (error: unknown) {
        const failure = normalizeMediaError(error, "plan_asset_deletion");
        setRuntimeError(failure);
        throw new MediaRuntimeError(failure, error);
      }
    },
    [],
  );
  const deleteAsset = useCallback(
    async (
      request: MediaAssetDeletionRequest,
    ): Promise<MediaAssetDeletionResult> => {
      setRuntimeError(null);
      setDeletionNotice(null);
      try {
        const result = await deleteMediaAsset(request);
        const reclaimed = result.reclaimedBytes.toLocaleString();
        setDeletionNotice(
          result.tombstone.mode === "metadata-only"
            ? "Asset metadata was replaced by a tombstone; content-addressed bytes were retained."
            : `Asset metadata was tombstoned and ${reclaimed} byte${result.reclaimedBytes === 1 ? "" : "s"} were reclaimed safely.`,
        );
        await refreshRuntime();
        return result;
      } catch (error: unknown) {
        const failure = normalizeMediaError(error, "delete_asset");
        setRuntimeError(failure);
        throw new MediaRuntimeError(failure, error);
      }
    },
    [refreshRuntime],
  );

  const combinedRuns = useMemo(() => {
    const runtimeIds = new Set(runtimeRuns.map((run) => run.id));
    return [
      ...runtimeRuns,
      ...state.runs.filter((run) => !runtimeIds.has(run.id)),
    ];
  }, [runtimeRuns, state.runs]);
  const recipePromptHistory = useMemo(() => {
    const submittedRuns = combinedRuns
      .filter((run) => MEDIA_RECIPE_PROMPT_FLOW_IDS.has(run.flowId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    let history: string[] = [];

    for (const run of submittedRuns) {
      history = addPromptHistoryEntry(history, run.prompt);
    }

    return history;
  }, [combinedRuns]);

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
          setState((current) => ({ ...current, activeSection: "models" }));
          refreshHardware();
          refreshModelCatalog();
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
      refreshHardware,
      refreshModelCatalog,
      refreshFlowHistory,
      refreshRuntime,
    ],
  );

  const persistenceError = saveError ?? loadError;

  return (
    <main className="flex h-full min-h-0 min-w-0 flex-1 bg-slate-950 text-slate-100">
      <aside className="flex w-20 shrink-0 flex-col border-r border-slate-800/80 bg-slate-950 sm:w-24 lg:w-28">
        <nav
          aria-label="Media Studio"
          className="flex flex-col items-stretch gap-1.5 p-2.5"
        >
          {NAVIGATION_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = state.activeSection === item.id;
            return (
              <Tooltip key={item.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={item.label}
                    aria-current={active ? "page" : undefined}
                    onClick={() => selectSection(item.id)}
                    className={cn(
                      "flex h-14 w-full flex-col items-center justify-center gap-1 rounded-xl border border-transparent px-1 text-slate-400 outline-none transition-colors hover:bg-slate-900 hover:text-slate-100 focus-visible:ring-2 focus-visible:ring-sky-400/60",
                      active &&
                        "border-sky-500/20 bg-slate-900 text-slate-100 shadow-[0_0_18px_rgba(14,165,233,0.08)]",
                    )}
                  >
                    <Icon
                      className={cn(
                        "h-5 w-5",
                        active ? "text-sky-300" : "text-slate-400",
                      )}
                    />
                    <span className="max-w-full truncate text-[9px] font-medium">
                      {item.label}
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {item.label}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </nav>
      </aside>

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
            settings={state.recipe}
            plan={recipePlan}
            catalog={activeModelCatalog}
            directGenerationModelIds={
              runtimeStatus?.directGenerationModelIds ?? null
            }
            directReferenceImageModelIds={
              runtimeStatus?.directReferenceImageModelIds ?? null
            }
            referenceAssets={runtimeAssets}
            referenceImportSupported={supportsNativeMediaImport()}
            referenceImportPending={importLoading}
            generatedRun={
              selectedRun?.flowId === recipeFlow.id ||
              selectedRun?.flowId === reviewRecipeFlow.id
                ? selectedRun
                : null
            }
            persistenceError={persistenceError}
            promptHistory={recipePromptHistory}
            onChange={changeRecipe}
            onOpenFlow={openRecipeAsFlow}
            onOpenVideoFlow={openVideoCreationFlow}
            onOpenModels={() => selectSection("models")}
            onOpenProviderSettings={onOpenProviderSettings}
            onGenerate={runGeneration}
            onGenerateWithReview={runGenerationWithReview}
            onOpenRunReview={() => selectSection("runs")}
            onAddReferenceImages={importReferenceImages}
            onEditResult={useAssetAsCreateReference}
            onAnimateResult={openAssetAsVideoFlow}
            onOpenResult={openAssetInLibrary}
            generationPending={generationPending}
            runtimeMode={runtimeStatus?.mode ?? null}
          />
        ) : null}
        {state.activeSection === "flow" ? (
          <MediaFlowView
            flow={flow}
            layout={layout}
            plan={plan}
            models={models}
            assets={runtimeAssets}
            onLayoutChange={changeFlowLayout}
            onFlowVariablesChange={applySemanticFlow}
            onTemplateApply={applyFlowTemplate}
            onNodeConfigChange={changeFlowNodeConfig}
            onNodeConfigPatch={changeFlowNodeConfigs}
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
              videoFlowExecution.supported ? runVideoFlow : runLocalFlow
            }
            localRunPending={localFlowPending}
            localRunSupported={
              localFlowExecution.supported || videoFlowExecution.supported
            }
            localRunDescription={
              videoFlowExecution.videoNode
                ? videoFlowExecution.reason
                : localFlowExecution.reason
            }
            onRunRemoteEdit={runRemoteEditFlow}
            remoteRunPending={remoteEditPending}
            remoteRunSupported={remoteEditExecution.supported}
            remoteRunDescription={remoteEditExecution.reason}
            remoteRunMode={runtimeStatus?.mode ?? null}
            remoteUploadManifest={remoteEditExecution.manifest}
            runOverlay={
              flowRunOverlayId === selectedRun?.id ? selectedRun : null
            }
            onRunOverlayClear={() => setFlowRunOverlayId(null)}
          />
        ) : null}
        {state.activeSection === "library" ? (
          <MediaLibraryView
            assets={runtimeAssets}
            runtimeStatus={runtimeStatus}
            runtimeError={null}
            importSupported={supportsNativeMediaImport()}
            importLoading={importLoading}
            transformLoading={transformLoading}
            exportSupported={supportsNativeMediaExport()}
            exportLoading={exportLoading}
            exportNotice={exportNotice}
            deletionNotice={deletionNotice}
            qualityLoadingAssetId={qualityLoadingAssetId}
            qualityReports={qualityReports}
            tagLoadingAssetId={tagLoadingAssetId}
            chatWorkspaceAvailable={Boolean(workspaceRoot?.trim())}
            openAssetId={openAssetId ?? importedAssetId}
            onOpenAssetHandled={() => {
              if (openAssetId) onOpenAssetHandled?.();
              if (importedAssetId) setImportedAssetId(null);
            }}
            onImport={importImages}
            onTransform={transformImage}
            onExport={exportAsset}
            onAnalyzeQuality={analyzeQuality}
            onLoadQualityReport={loadQualityReport}
            onUpdateTags={updateAssetTags}
            onAutoTag={autoTagAsset}
            onUseAsReference={useAssetAsCreateReference}
            onOpenVideoAsFlow={openAssetAsVideoFlow}
            onOpenAsFlow={openAssetAsEditFlow}
            onOpenBackgroundRemovalAsFlow={openBackgroundRemovalAsFlow}
            onOpenAlphaMatteAsFlow={openAlphaMatteAsFlow}
            onOpenCompositeAsFlow={openCompositeAsFlow}
            onOpenContactSheetAsFlow={openContactSheetAsFlow}
            onOpenTransformAsFlow={openTransformAsFlow}
            onSendToChat={(asset) => {
              const normalizedWorkspaceRoot = workspaceRoot?.trim();
              if (!normalizedWorkspaceRoot || asset.kind !== "image") return;
              onSendAssetToChat({
                source: "media-asset",
                workspaceRoot: normalizedWorkspaceRoot,
                assetId: asset.id,
                kind: "image",
                displayName: `Media image ${asset.digest.slice(0, 12)}`,
                rendition: "original",
              });
            }}
            onPlanDeletion={planAssetDeletion}
            onDeleteAsset={deleteAsset}
          />
        ) : null}
        {state.activeSection === "runs" ? (
          <MediaRunsView
            runs={combinedRuns}
            selectedRun={selectedRun}
            runtimeStatus={runtimeStatus}
            runtimeError={null}
            onCreate={() => selectSection("generate")}
            onSelect={selectRun}
            onCancel={cancelRun}
            onRetry={retryRun}
            onResolveProviderReview={resolveProviderReview}
            providerReviewPending={providerReviewPending}
            onResolveHumanReview={resolveHumanReview}
            humanReviewPending={humanReviewPending}
            onInspectInFlow={inspectRunInFlow}
            onRefresh={() => void refreshRuntime()}
          />
        ) : null}
        {state.activeSection === "models" ? (
          <MediaModelsView
            catalog={activeModelCatalog}
            catalogLoading={modelCatalogLoading}
            catalogError={modelCatalogError}
            hardware={hardware}
            hardwareLoading={hardwareLoading}
            hardwareError={hardwareError}
            installPlan={modelInstallPlan}
            installJob={modelInstallJob}
            installLoading={modelInstallLoading}
            installError={modelInstallError}
            removalPlan={modelRemovalPlan}
            removalResult={modelRemovalResult}
            removalLoading={modelRemovalLoading}
            removalError={modelRemovalError}
            modelImportInspection={modelImportInspection}
            modelImportResult={modelImportResult}
            modelImportSupported={supportsNativeMediaModelImport()}
            modelImportLoading={modelImportLoading}
            modelImportError={modelImportError}
            modelProbeSupported={supportsNativeMediaModelProbe()}
            modelProbeLoadingId={modelProbeLoadingId}
            modelProbeError={modelProbeError}
            addonImportInspection={addonImportInspection}
            addonImportResult={addonImportResult}
            addonImportSupported={supportsNativeMediaModelAddonImport()}
            addonImportLoading={addonImportLoading}
            addonImportError={addonImportError}
            civitaiAddonInspection={civitaiAddonInspection}
            addonImportCivitaiSource={addonImportCivitaiSource}
            civitaiAddonLoading={civitaiAddonLoading}
            civitaiAddonError={civitaiAddonError}
            addonRemovalPlan={addonRemovalPlan}
            addonRemovalResult={addonRemovalResult}
            addonRemovalLoading={addonRemovalLoading}
            addonRemovalError={addonRemovalError}
            localDiffusers={runtimeStatus?.localDiffusers ?? null}
            workspaceModels={workspaceModelDiscovery}
            workspaceModelsLoading={workspaceModelDiscoveryLoading}
            workspaceModelsError={workspaceModelDiscoveryError}
            localRuntimeLoading={localRuntimeLoading}
            onRefreshWorkspaceModels={refreshWorkspaceModels}
            onRefreshLocalRuntime={refreshLocalRuntime}
            onRefreshHardware={refreshHardware}
            onRefreshCatalog={refreshModelCatalog}
            onReviewInstall={reviewModelInstall}
            onStartInstall={startModelInstall}
            onCancelInstall={cancelModelInstall}
            onDismissInstall={() => {
              setModelInstallPlan(null);
              setModelInstallError(null);
            }}
            onReviewRemoval={reviewModelRemoval}
            onConfirmRemoval={confirmModelRemoval}
            onDismissRemoval={() => {
              setModelRemovalPlan(null);
              setModelRemovalResult(null);
              setModelRemovalError(null);
            }}
            onChooseModelImport={chooseModelImport}
            onInspectWorkspaceArtifact={inspectWorkspaceArtifact}
            onImportModel={importLocalModel}
            onDismissModelImport={dismissModelImport}
            onProbeModel={probeLocalModel}
            onChooseAddonImport={chooseAddonImport}
            onInspectCivitaiAddon={inspectCivitaiAddon}
            onDownloadCivitaiAddon={downloadCivitaiAddon}
            onDismissCivitaiAddon={dismissCivitaiAddon}
            onReviewAddonRemoval={reviewAddonRemoval}
            onConfirmAddonRemoval={confirmAddonRemoval}
            onDismissAddonRemoval={dismissAddonRemoval}
            onImportAddon={importAddon}
            onDismissAddonImport={dismissAddonImport}
            onOpenProviderSettings={onOpenProviderSettings}
          />
        ) : null}
        </div>
      </section>
    </main>
  );
};
