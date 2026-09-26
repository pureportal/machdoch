import { useMediaViewPreference } from "../use-media-view-preference";
import { MediaAssetBrowser } from "./media-asset-browser";
import { MediaBasicImageOutputOptions } from "./media-basic-image-output-options";
import { MediaBasicSamplingOptions } from "./media-basic-sampling-options";
import {
  basicImageModelError,
  basicImageReferenceLimit,
  basicImageUsesEditStrength,
  reconcileBasicImageModelSettings,
} from "../media-basic-image-options";
import { mediaImageSamplingError } from "../../../../core/media/image-sampling.js";
import { defaultMediaImageSteps } from "../../../../core/media/image-sampling.js";
import { MediaSaveAssetButton } from "./media-save-asset-button";
import { MediaGenerationJobs } from "./media-generation-jobs";
import {
  AlertTriangle,
  ChevronDown,
  ImagePlus,
  LoaderCircle,
  SlidersHorizontal,
  Sparkles,
  Video,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import {
  inspectMediaModelAddonCompatibility,
  reconcileMediaModelAddonSelections,
} from "../../../../core/media/model-addons.js";
import { listSelectableMediaModels } from "../../../../core/media/model-library.js";
import { isMediaModelReady } from "../../../../core/media/model-readiness.js";
import { hasMediaImageMaskContent } from "../../../../core/media/image-mask.js";
import {
  getMediaReferenceConditioningCapabilities,
  mediaModelSupportsPromptlessConditioning,
} from "../../../../core/media/reference-conditioning.js";
import {
  MEDIA_VIDEO_QUALITY_PRESETS,
  identifyMediaVideoQualityPreset,
  mediaVideoDimensionsError,
  resolveMediaVideoQualityPresetSettings,
} from "../../../../core/media/video-quality.js";
import type {
  ImageRecipeSettings,
  MediaAssetCategory,
  MediaAssetRecord,
  MediaCompiledPlan,
  MediaCapability,
  MediaGenerationAssetMetadata,
  MediaGenerationTarget,
  MediaModelCatalogSnapshot,
  MediaVideoRecipeSettings,
} from "../../../../core/media/contracts.js";
import { Button } from "../../components/ui/button";
import { AppNotification } from "../../components/ui/notification";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "../../components/ui/submit-shortcut";
import { ControlTooltip } from "../../components/ui/tooltip";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";
import { MediaAssetPreview } from "./media-visual-preview";
import { MediaModelPicker } from "./media-model-picker";
import { MediaBasicBaseImage } from "./media-basic-base-image";
import type { MediaGenerationQueueJob } from "../media-generation-queue";
import { normalizeMediaSubmissionText } from "../media-generation-recipe";
import { MediaAddonDialog } from "./media-addon-dialog";
import { MediaAddonTriggerWarnings } from "./media-addon-trigger-warnings";
import {
  isMediaOpenPoseAsset,
  type MediaPoseMap,
  type MediaSavedPoseScene,
} from "../../../../core/media/pose-map.js";
import { MediaPoseWorkspace } from "./media-pose-workspace";

interface MediaGenerateViewProps {
  target: MediaGenerationTarget;
  settings: ImageRecipeSettings;
  videoSettings: MediaVideoRecipeSettings;
  assetMetadata: Record<string, MediaGenerationAssetMetadata>;
  categories: readonly MediaAssetCategory[];
  plan: MediaCompiledPlan;
  catalog: MediaModelCatalogSnapshot;
  directGenerationModelIds: readonly string[] | null;
  directReferenceImageModelIds: readonly string[] | null;
  directInpaintingModelIds: readonly string[] | null;
  directPoseModelIds: readonly string[] | null;
  videoGenerationSupported: boolean;
  videoGenerationBlockedReason: string | null;
  referenceAssets: readonly MediaAssetRecord[];
  referenceImportSupported: boolean;
  referenceImportPending: boolean;
  generationJob: MediaGenerationQueueJob | null;
  generationJobs: readonly MediaGenerationQueueJob[];
  queueBusy: boolean;
  persistenceError: string | null;
  onTargetChange: (target: MediaGenerationTarget) => void;
  onChange: (settings: ImageRecipeSettings) => void;
  onVideoSettingsChange: (settings: MediaVideoRecipeSettings) => void;
  onOpenFlow: () => void;
  flowOpening: boolean;
  onOpenAssets: (modelId?: string) => void;
  onOpenActivity: (runId: string) => void;
  onSelectGenerationJob: (runId: string) => void;
  onCancelGeneration: (runId: string) => void;
  onGenerate: () => void;
  onAddReferenceImages: () => void;
  onAddBaseImage: () => void;
  onSelectPosePreset: (map: MediaPoseMap) => void;
  onGeneratePoseChat: (map: MediaPoseMap | null) => void | Promise<void>;
  savedPoseScenes?: readonly MediaSavedPoseScene[];
  onRenamePoseScene?: (id: string, title: string) => void;
  onInstallPoseControl: (architecture: string) => void;
  poseInstallPending: boolean;
  onEditResult: (asset: MediaAssetRecord) => void;
  onAnimateResult: (asset: MediaAssetRecord) => void;
  onOpenResult: (asset: MediaAssetRecord) => void;
  generationPending: boolean;
}

const TARGETS: ReadonlyArray<{
  id: MediaGenerationTarget;
  label: string;
}> = [
  { id: "image", label: "Image" },
  { id: "video", label: "Video" },
  { id: "svg", label: "SVG" },
];

export const MediaGenerateView = ({
  target,
  settings,
  videoSettings,
  assetMetadata,
  categories,
  plan,
  catalog,
  directGenerationModelIds,
  directReferenceImageModelIds,
  directInpaintingModelIds,
  directPoseModelIds,
  videoGenerationSupported,
  videoGenerationBlockedReason,
  referenceAssets,
  referenceImportSupported,
  referenceImportPending,
  generationJob,
  generationJobs,
  queueBusy,
  persistenceError,
  onTargetChange,
  onChange,
  onVideoSettingsChange,
  onOpenFlow,
  flowOpening,
  onOpenAssets,
  onOpenActivity,
  onSelectGenerationJob,
  onCancelGeneration,
  onGenerate,
  onAddReferenceImages,
  onAddBaseImage,
  onSelectPosePreset,
  onGeneratePoseChat,
  savedPoseScenes = [],
  onRenamePoseScene,
  onInstallPoseControl,
  poseInstallPending,
  onEditResult,
  onAnimateResult,
  onOpenResult,
  generationPending,
}: MediaGenerateViewProps): JSX.Element => {
  const [assetPicker, setAssetPicker] = useState<
    "reference" | "base" | "pose" | null
  >(null);
  const [advancedOpen, setAdvancedOpen] = useMediaViewPreference(
    "optionsExpanded",
    false,
  );
  const [maskHasPixels, setMaskHasPixels] = useState(true);
  const [modelSettingsNotice, setModelSettingsNotice] = useState<string | null>(
    null,
  );
  const visualReferenceAssets = useMemo(
    () => referenceAssets.filter((asset) => asset.kind === "image"),
    [referenceAssets],
  );
  const selectedReferenceIds = new Set(
    settings.referenceImages.map((reference) => reference.assetId),
  );
  const isSvgVectorization =
    target === "svg" && settings.svgMode === "vectorize";
  const selectedReferences = settings.referenceImages.map((reference) => {
    const asset = visualReferenceAssets.find(
      (candidate) => candidate.id === reference.assetId,
    );
    return { asset, reference };
  });
  const baseImageAsset =
    visualReferenceAssets.find(
      (asset) =>
        asset.kind === "image" && asset.id === settings.baseImageAssetId,
    ) ?? null;
  const poseImageAsset =
    visualReferenceAssets.find(
      (asset) =>
        asset.kind === "image" && asset.id === settings.poseImageAssetId,
    ) ?? null;
  const poseMapAssets = visualReferenceAssets.filter(
    (asset) =>
      isMediaOpenPoseAsset(asset) || asset.id === settings.poseImageAssetId,
  );
  const intersectModelIds = (
    left: readonly string[] | null,
    right: readonly string[] | null,
  ): readonly string[] | null => {
    if (left === null || right === null) return null;
    const rightIds = new Set(right);
    return left.filter((modelId) => rightIds.has(modelId));
  };
  let availableImageModelIds = directGenerationModelIds;
  if (
    settings.referenceImages.length > 0 ||
    (target === "image" && settings.baseImageAssetId)
  ) {
    availableImageModelIds = directReferenceImageModelIds;
  }
  if (target === "image" && settings.editMask) {
    availableImageModelIds = intersectModelIds(
      availableImageModelIds,
      directInpaintingModelIds,
    );
  }
  if (target === "image" && settings.poseImageAssetId) {
    availableImageModelIds = intersectModelIds(
      availableImageModelIds,
      directPoseModelIds,
    );
  }
  const requiredImageCapabilities: readonly MediaCapability[] | undefined =
    target !== "image"
      ? undefined
      : [
          ...(settings.baseImageAssetId
            ? settings.editMask
              ? (["masked-image-edit"] as const)
              : []
            : []),
          ...(settings.referenceImages.length +
            (settings.baseImageAssetId ? 1 : 0) >
          1
            ? (["multi-reference-edit"] as const)
            : settings.referenceImages.length +
                  (settings.baseImageAssetId ? 1 : 0) ===
                1
              ? (["image-to-image"] as const)
              : !settings.baseImageAssetId &&
                  settings.referenceImages.length === 0
                ? (["text-to-image"] as const)
                : []),
        ];
  const models = listSelectableMediaModels(catalog.models, {
    target,
    requiredCapabilities:
      target === "image" ? undefined : requiredImageCapabilities,
    allowedModelIds:
      target === "image"
        ? directGenerationModelIds
        : target === "video"
          ? null
          : availableImageModelIds,
  }).sort((left, right) => {
    return (
      Number(right.recommended) - Number(left.recommended) ||
      left.displayName.localeCompare(right.displayName)
    );
  });
  const selectedModelId =
    target === "video" ? videoSettings.modelId : settings.modelId;
  const setupModel =
    target === "video"
      ? null
      : catalog.models.find(
          (model) =>
            model.management.acquisition === "managed-install" &&
            (requiredImageCapabilities ?? []).every((capability) =>
              model.capabilities.includes(capability),
            ),
        );
  const selectedModel =
    target === "video"
      ? (models.find((model) => model.id === selectedModelId) ?? null)
      : ((target === "image" && selectedModelId
          ? catalog.models.find((model) => model.id === selectedModelId)
          : models.find((model) => model.id === selectedModelId)) ??
        models.find((model) => model.id === plan.model?.id) ??
        models[0] ??
        null);
  const poseModelReady =
    selectedModel !== null &&
    (directPoseModelIds?.includes(selectedModel.id) ?? false);
  const poseModelFamily = selectedModel?.architecture;
  const poseSetupMessage =
    !selectedModel ||
    selectedModel.target !== "local" ||
    ![
      "stable-diffusion-1",
      "stable-diffusion-2",
      "stable-diffusion-xl",
      "pony",
    ].includes(poseModelFamily ?? "")
      ? "Choose a local Stable Diffusion model to use a pose."
      : selectedModel.runtimeReadiness !== "ready"
        ? "Verify this model in Assets to use a pose."
        : poseModelFamily === "stable-diffusion-2" &&
            directPoseModelIds !== null &&
            !poseModelReady
          ? "SD 2 needs a matching OpenPose ControlNet installed manually."
          : null;
  const addonModel =
    target === "video" && settings.referenceImages.length === 0
      ? (catalog.models.find(
          (model) => model.id === settings.modelId && isMediaModelReady(model),
        ) ?? plan.model)
      : selectedModel;
  const videoAddonModel =
    target === "video"
      ? (selectedModel ??
        plan.runtimeBindings.find((binding) => binding.modality === "video")
          ?.model ??
        null)
      : null;
  const videoAddons = useMemo(
    () =>
      reconcileMediaModelAddonSelections(
        videoAddonModel,
        catalog.addons,
        videoSettings.modelAddons,
      ),
    [videoAddonModel, catalog.addons, videoSettings.modelAddons],
  );
  const referenceCapabilities =
    getMediaReferenceConditioningCapabilities(selectedModel);
  const referenceLimit =
    target === "video" || isSvgVectorization
      ? 1
      : basicImageReferenceLimit(settings, selectedModel);
  const modelDisabledReasons = Object.fromEntries(
    target === "image"
      ? models.flatMap((model) => {
          const reason = basicImageModelError(
            reconcileBasicImageModelSettings(settings, model).settings,
            model,
          );
          return reason ? [[model.id, reason]] : [];
        })
      : [],
  );
  const imageModelError =
    target === "image" && selectedModel
      ? basicImageModelError(settings, selectedModel)
      : null;
  const baseImageSupported =
    selectedModel?.capabilities.includes("image-to-image") === true &&
    (directReferenceImageModelIds?.includes(selectedModel.id) ?? false) &&
    (settings.referenceImages.length === 0 ||
      selectedModel.capabilities.includes("multi-reference-edit"));
  const maskSupported =
    selectedModel?.capabilities.includes("masked-image-edit") === true &&
    (directInpaintingModelIds?.includes(selectedModel.id) ?? false);
  const missingImage =
    target === "image" &&
    [
      settings.baseImageAssetId,
      settings.poseImageAssetId,
      ...settings.referenceImages.map((reference) => reference.assetId),
    ].some(
      (id) => id && !visualReferenceAssets.some((asset) => asset.id === id),
    );
  const samplingError =
    target === "image"
      ? mediaImageSamplingError(settings.sampling ?? {})
      : null;
  const compatibleAddons = addonModel
    ? catalog.addons.filter(
        (addon) =>
          inspectMediaModelAddonCompatibility(addonModel, addon).status ===
          "compatible",
      )
    : [];
  const reconciledModelAddons = useMemo(
    () =>
      reconcileMediaModelAddonSelections(
        addonModel,
        catalog.addons,
        settings.modelAddons,
      ),
    [addonModel, catalog.addons, settings.modelAddons],
  );
  const hasImageConditioning =
    settings.referenceImages.length > 0 ||
    settings.baseImageAssetId !== null ||
    settings.poseImageAssetId !== null;
  const promptReady =
    isSvgVectorization ||
    settings.prompt.trim().length > 0 ||
    (target === "image" &&
      mediaModelSupportsPromptlessConditioning(
        selectedModel,
        hasImageConditioning,
      ));
  const svgReferenceReady =
    !isSvgVectorization || settings.referenceImages.length > 0;
  const baseMaskReady =
    target !== "image" ||
    !settings.editMask ||
    (settings.editMask?.sourceAssetId === settings.baseImageAssetId &&
      hasMediaImageMaskContent(settings.editMask));
  const modelReady = selectedModel !== null && isMediaModelReady(selectedModel);
  const seamlessSupported =
    selectedModel?.capabilities.includes("start-end-to-video") === true;
  const minimaxH3 = selectedModel?.architecture === "minimax-h3-ref2va";
  const videoFpsError =
    target === "video" && minimaxH3 && videoSettings.fps !== 24
      ? "MiniMax H3 requires 24 fps."
      : null;
  const videoLoopError =
    target === "video" &&
    selectedModel !== null &&
    ((minimaxH3 && (videoSettings.loopMode !== "none" || videoSettings.transparentBackground)) ||
      (videoSettings.loopMode === "seamless" && !seamlessSupported))
      ? minimaxH3
        ? "MiniMax H3 requires opaque, non-looping video."
        : "This model cannot close a seamless loop. Choose Crossfade or Ping-pong."
      : null;
  const runtimeReady =
    target === "video" ||
    (availableImageModelIds !== null &&
      selectedModel !== null &&
      availableImageModelIds.includes(selectedModel.id));
  const planReady = target === "video" || plan.status === "ready";
  const runActive =
    generationJob !== null &&
    ["queued", "running", "canceling"].includes(generationJob.status);
  const generationInProgress = generationPending || runActive;
  const canGenerate =
    !referenceImportPending &&
    !imageModelError &&
    !videoLoopError &&
    !videoFpsError &&
    !missingImage &&
    (target !== "image" ||
      mediaImageSamplingError(settings.sampling ?? {}) === null) &&
    (target !== "video" || mediaVideoDimensionsError(videoSettings) === null) &&
    promptReady &&
    svgReferenceReady &&
    baseMaskReady &&
    (!settings.editMask || maskHasPixels) &&
    modelReady &&
    runtimeReady &&
    planReady &&
    (target !== "video" || videoGenerationSupported) &&
    !settings.qualityGateEnabled &&
    !generationPending;
  const generationBlockedReason =
    (referenceImportPending ? "Adding image" : null) ??
    imageModelError ??
    videoLoopError ??
    videoFpsError ??
    samplingError ??
    (missingImage
      ? "Remove or replace the unavailable image."
      : settings.editMask && !maskHasPixels
        ? "Paint the area to change"
        : !svgReferenceReady
          ? "Choose an image to vectorize"
          : !baseMaskReady
            ? "Paint the area to change"
            : !promptReady
              ? "Add a prompt"
              : !selectedModel
                ? "Choose a model"
                : !modelReady
                  ? `${selectedModel.displayName} is unavailable`
                  : target !== "video" && availableImageModelIds === null
                    ? "Checking model availability"
                    : !runtimeReady
                      ? "This model cannot run this setup"
                      : target === "video" && !videoGenerationSupported
                        ? (videoGenerationBlockedReason ??
                          "Resolve the video generation settings")
                        : !planReady
                          ? (plan.diagnostics.find(
                              (diagnostic) => diagnostic.severity === "error",
                            )?.message ?? "Resolve the generation settings")
                          : settings.qualityGateEnabled
                            ? "Run quality gates in Advanced"
                            : null);
  const resultAssets =
    generationJob?.assets.filter((asset) =>
      generationJob.recipe.target === "video"
        ? asset.kind === "video"
        : generationJob.recipe.target === "svg"
          ? asset.kind === "vector"
          : asset.kind === "image",
    ) ?? [];
  const selectedVideoPreset = MEDIA_VIDEO_QUALITY_PRESETS.find(
    (preset) =>
      videoSettings.width == null &&
      videoSettings.height == null &&
      preset.id ===
        identifyMediaVideoQualityPreset(
          { ...videoSettings },
          selectedModel?.architecture,
        ),
  );
  const svgStyle = settings.svgStyle ?? "illustration";
  const svgStyleLabel = `${svgStyle[0].toLocaleUpperCase()}${svgStyle.slice(1)}`;
  const settingsSummary = [
    target === "video"
      ? videoSettings.width && videoSettings.height
        ? `${videoSettings.width} × ${videoSettings.height}`
        : videoSettings.aspectRatio
      : target === "svg"
        ? isSvgVectorization
          ? "Vectorize"
          : svgStyleLabel
        : settings.editMask && baseImageAsset
          ? `${baseImageAsset.width} × ${baseImageAsset.height}`
          : settings.sampling?.width && settings.sampling.height
            ? `${settings.sampling.width} × ${settings.sampling.height}`
            : settings.aspectRatio,
    target === "video"
      ? (selectedVideoPreset?.label ?? "Custom")
      : target === "svg"
        ? settings.aspectRatio
        : `${settings.outputCount} output${settings.outputCount === 1 ? "" : "s"}`,
    (
      target === "video"
        ? videoSettings.transparentBackground
        : settings.transparentBackground
    )
      ? "Transparent"
      : null,
  ]
    .filter((value): value is string => value !== null)
    .join(" · ");
  const referenceHeading = isSvgVectorization
    ? "Source image"
    : target === "video"
      ? "Starting image"
      : "Reference images";
  const runNeedsReview =
    generationJob?.status === "needs-review" ||
    generationJob?.status === "waiting-for-review";
  const runFailed = generationJob?.status === "failed";
  const runCanceled = generationJob?.status === "canceled";
  const runMessage =
    generationJob?.failure?.message ?? generationJob?.error ?? null;
  const showGenerationProgress =
    generationInProgress &&
    !runFailed &&
    !runCanceled &&
    !runNeedsReview &&
    generationJob?.status !== "completed";

  useEffect(() => {
    if (target === "video") return;
    if (!selectedModel || selectedModel.id === selectedModelId) return;
    if (selectedModelId) return;
    onChange({
      ...settings,
      modelId: selectedModel.id,
    });
  }, [onChange, selectedModel, selectedModelId, settings, target]);

  const selectModel = (modelId: string): void => {
    setModelSettingsNotice(null);
    if (target === "video") {
      const model = models.find((candidate) => candidate.id === modelId);
      onVideoSettingsChange({
        ...videoSettings,
        ...resolveMediaVideoQualityPresetSettings(
          selectedVideoPreset ?? MEDIA_VIDEO_QUALITY_PRESETS[0]!,
          model?.architecture,
        ),
        ...(model?.architecture === "minimax-h3-ref2va"
          ? { loopMode: "none" as const, transparentBackground: false }
          : {}),
        modelId: modelId as MediaVideoRecipeSettings["modelId"],
        modelAddons: reconcileMediaModelAddonSelections(
          model ?? null,
          catalog.addons,
          videoSettings.modelAddons,
        ),
      });
      return;
    }
    if (modelDisabledReasons[modelId]) return;
    const model = models.find((candidate) => candidate.id === modelId) ?? null;
    const reconciled =
      target === "image" && model
        ? reconcileBasicImageModelSettings(settings, model)
        : { settings, changes: [] };
    onChange({
      ...reconciled.settings,
      modelId,
      modelAddons: reconcileMediaModelAddonSelections(
        model,
        catalog.addons,
        settings.modelAddons,
      ),
    });
    if (reconciled.changes.length > 0)
      setModelSettingsNotice(reconciled.changes.join(" "));
  };

  const changeReferences = (
    references: ImageRecipeSettings["referenceImages"],
  ): void => {
    onChange({
      ...settings,
      referenceImages: references,
    });
  };

  const addReference = (asset: MediaAssetRecord): void => {
    if (selectedReferenceIds.has(asset.id)) return;
    if (
      asset.id === settings.baseImageAssetId ||
      asset.id === settings.poseImageAssetId
    ) {
      return;
    }
    if (target === "video" || isSvgVectorization) {
      changeReferences([{ assetId: asset.id, role: "base", influence: 1 }]);
      return;
    }
    if (settings.referenceImages.length >= referenceLimit) return;
    const role = referenceCapabilities.roles[0];
    if (!role) return;
    changeReferences([
      ...settings.referenceImages,
      {
        assetId: asset.id,
        role,
        influence: 1,
      },
    ]);
  };

  const changeSvgMode = (
    svgMode: NonNullable<ImageRecipeSettings["svgMode"]>,
  ): void => {
    const referenceImages =
      svgMode === "vectorize"
        ? settings.referenceImages.slice(0, 1)
        : settings.referenceImages;
    onChange({
      ...settings,
      svgMode,
      outputCount: svgMode === "vectorize" ? 1 : settings.outputCount,
      referenceImages,
    });
  };

  const modelField = (
    <div className="space-y-2">
      <label
        htmlFor="media-quick-model"
        className="block text-sm font-medium text-slate-200"
      >
        Model
      </label>
      <MediaModelPicker
        id="media-quick-model"
        models={models}
        value={selectedModel?.id ?? null}
        placeholder={selectedModel?.displayName ?? "Choose model"}
        disabledReasons={modelDisabledReasons}
        assets={referenceAssets}
        metadata={assetMetadata}
        categories={categories}
        onChange={(modelId) => {
          if (modelId) selectModel(modelId);
        }}
        className="w-full"
      />
      {modelSettingsNotice ? (
        <AppNotification
          tone="info"
          title="Model settings updated"
          onDismiss={() => setModelSettingsNotice(null)}
        >
          {modelSettingsNotice}
        </AppNotification>
      ) : null}
      {models.length === 0 ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onOpenAssets(setupModel?.id)}
        >
          {setupModel
            ? `${setupModel.installed ? "Set up" : "Install"} ${setupModel.displayName}`
            : "Manage models"}
        </Button>
      ) : null}
    </div>
  );

  return (
    <SubmitShortcut asChild>
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-slate-950">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 px-5 py-3">
          <div className="flex rounded-xl border border-slate-800 bg-slate-900/70 p-1">
            {TARGETS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={target === item.id}
                onClick={() => onTargetChange(item.id)}
                className={cn(
                  "rounded-lg px-4 py-2 text-sm font-medium transition-colors",
                  target === item.id
                    ? "bg-slate-700 text-white"
                    : "text-slate-400 hover:text-slate-100",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={onOpenFlow}
            disabled={flowOpening}
          >
            {flowOpening ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Workflow className="h-4 w-4" />
            )}
            {flowOpening ? "Loading workflow" : "Convert to Advanced"}
          </Button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto xl:grid-cols-[minmax(420px,1fr)_minmax(420px,1fr)] xl:overflow-hidden">
          <section className="flex flex-col border-slate-800/70 xl:min-h-0 xl:border-r xl:overflow-hidden">
            <div className="space-y-6 p-5 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:p-6">
              {target === "svg" ? (
                <div className="space-y-2">
                  <span className="block text-sm font-medium text-slate-200">
                    Mode
                  </span>
                  <div className="grid grid-cols-2 rounded-xl border border-slate-800 bg-slate-900/70 p-1">
                    {(["generate", "vectorize"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={(settings.svgMode ?? "generate") === mode}
                        onClick={() => changeSvgMode(mode)}
                        className={cn(
                          "rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                          (settings.svgMode ?? "generate") === mode
                            ? "bg-slate-700 text-white"
                            : "text-slate-400 hover:text-slate-100",
                        )}
                      >
                        {mode === "generate" ? "Create" : "Vectorize"}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {target === "image" ? modelField : null}

              {!isSvgVectorization ? (
                <div>
                  <label
                    htmlFor="media-quick-prompt"
                    className="mb-2 block text-sm font-medium text-slate-200"
                  >
                    Prompt
                  </label>
                  <Textarea
                    id="media-quick-prompt"
                    value={settings.prompt}
                    onChange={(event) =>
                      onChange({ ...settings, prompt: event.target.value })
                    }
                    onBlur={(event) => {
                      const normalizedPrompt = normalizeMediaSubmissionText(
                        event.target.value,
                        8_000,
                      );
                      if (normalizedPrompt !== event.target.value) {
                        onChange({ ...settings, prompt: normalizedPrompt });
                      }
                    }}
                    rows={6}
                    placeholder={
                      target === "video"
                        ? settings.referenceImages.length > 0
                          ? "Describe the motion"
                          : "Describe the scene and motion"
                        : target === "svg"
                          ? "Describe the graphic"
                          : "Describe the image"
                    }
                    className="min-h-32 resize-y border-slate-700 bg-slate-900/70 text-base leading-6"
                  />
                </div>
              ) : null}

              {target === "image" &&
              (baseImageSupported || settings.baseImageAssetId) ? (
                <MediaBasicBaseImage
                  settings={settings}
                  visualReferenceAssets={visualReferenceAssets}
                  metadata={assetMetadata}
                  categories={categories}
                  baseImageSupported={baseImageSupported}
                  maskSupported={maskSupported}
                  referenceImportSupported={referenceImportSupported}
                  referenceImportPending={referenceImportPending}
                  assetPickerOpen={assetPicker === "base"}
                  onAssetPickerChange={(open) =>
                    setAssetPicker(open ? "base" : null)
                  }
                  onAddBaseImage={onAddBaseImage}
                  onChange={onChange}
                  onMaskContentChange={setMaskHasPixels}
                />
              ) : null}

              {referenceLimit > 0 || selectedReferences.length > 0 ? (
                <section className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-sm font-medium text-slate-200">
                      {referenceHeading}
                    </h2>
                    {visualReferenceAssets.length > 0 ? (
                      <button
                        type="button"
                        aria-expanded={assetPicker === "reference"}
                        onClick={() =>
                          setAssetPicker((current) =>
                            current === "reference" ? null : "reference",
                          )
                        }
                        className="shrink-0 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-sky-300 hover:bg-slate-800 hover:text-sky-200"
                      >
                        {assetPicker === "reference"
                          ? "Close"
                          : "Choose from Assets"}
                      </button>
                    ) : null}
                  </div>
                  <div className="flex min-h-11 gap-2 overflow-x-auto pb-1">
                    {selectedReferences.map(({ asset, reference }, index) => (
                      <div
                        key={reference.assetId}
                        className="w-32 shrink-0 space-y-2"
                      >
                        <div className="group relative aspect-square overflow-hidden rounded-xl border border-slate-700">
                          {asset ? (
                            <MediaAssetPreview
                              asset={asset}
                              className="h-full w-full"
                            />
                          ) : (
                            <span className="text-xs text-slate-400">
                              Image unavailable
                            </span>
                          )}
                          <ControlTooltip
                            content={`Remove reference ${index + 1}`}
                          >
                            <button
                              type="button"
                              aria-label={`Remove reference ${index + 1}`}
                              onClick={() =>
                                changeReferences(
                                  settings.referenceImages.filter(
                                    (candidate) =>
                                      candidate.assetId !== reference.assetId,
                                  ),
                                )
                              }
                              className="absolute top-1 right-1 rounded-md bg-slate-950/85 p-1.5 text-slate-200 opacity-80 transition-opacity hover:opacity-100"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </ControlTooltip>
                        </div>
                        {target === "image" ? (
                          <select
                            aria-label={`Reference ${index + 1} role`}
                            value={reference.role}
                            onChange={(event) =>
                              changeReferences(
                                settings.referenceImages.map((candidate) =>
                                  candidate.assetId === reference.assetId
                                    ? {
                                        ...candidate,
                                        role: event.target
                                          .value as typeof candidate.role,
                                      }
                                    : candidate,
                                ),
                              )
                            }
                            className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm text-slate-300"
                          >
                            {referenceCapabilities.roles.map((role) => (
                              <option key={role} value={role}>
                                {role[0]?.toLocaleUpperCase()}
                                {role.slice(1)}
                              </option>
                            ))}
                          </select>
                        ) : null}
                        {target === "image" &&
                        referenceCapabilities.adjustableInfluence ? (
                          <label className="block text-xs text-slate-400">
                            <span>
                              Influence {reference.influence.toFixed(2)}
                            </span>
                            <input
                              aria-label={`Reference ${index + 1} influence`}
                              type="range"
                              min={0.1}
                              max={2}
                              step={0.05}
                              value={reference.influence}
                              onChange={(event) =>
                                changeReferences(
                                  settings.referenceImages.map((candidate) =>
                                    candidate.assetId === reference.assetId
                                      ? {
                                          ...candidate,
                                          influence: Number(event.target.value),
                                        }
                                      : candidate,
                                  ),
                                )
                              }
                              className="block w-full accent-sky-400"
                            />
                          </label>
                        ) : null}
                      </div>
                    ))}
                    {settings.referenceImages.length < referenceLimit ? (
                      <ControlTooltip
                        content={
                          referenceImportSupported
                            ? `Add ${referenceHeading.toLocaleLowerCase()}`
                            : "Add images in the desktop app"
                        }
                      >
                        <span className="inline-flex">
                          <button
                            type="button"
                            aria-label={`Add ${referenceHeading.toLocaleLowerCase()}`}
                            onClick={onAddReferenceImages}
                            disabled={
                              !referenceImportSupported ||
                              referenceImportPending
                            }
                            className="flex h-24 w-24 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-slate-700 text-slate-400 transition-colors hover:border-sky-500 hover:text-sky-300 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {referenceImportPending ? (
                              <LoaderCircle className="h-5 w-5 animate-spin" />
                            ) : (
                              <ImagePlus className="h-5 w-5" />
                            )}
                            <span className="text-xs">
                              {referenceImportPending ? "Adding" : "Add image"}
                            </span>
                          </button>
                        </span>
                      </ControlTooltip>
                    ) : null}
                  </div>
                  {assetPicker === "reference" ? (
                    <MediaAssetBrowser
                      assets={visualReferenceAssets}
                      metadata={assetMetadata}
                      categories={categories}
                      selectedIds={[...selectedReferenceIds]}
                      disabledReason={(asset) =>
                        selectedReferenceIds.has(asset.id)
                          ? undefined
                          : asset.id === settings.baseImageAssetId
                            ? "Already used as the base image"
                            : asset.id === settings.poseImageAssetId
                              ? "Already used as the pose image"
                              : settings.referenceImages.length >=
                                  referenceLimit
                                ? "Reference limit reached"
                                : undefined
                      }
                      onSelect={(asset) =>
                        selectedReferenceIds.has(asset.id)
                          ? changeReferences(
                              settings.referenceImages.filter(
                                (reference) => reference.assetId !== asset.id,
                              ),
                            )
                          : addReference(asset)
                      }
                    />
                  ) : null}
                </section>
              ) : null}

              {target === "image" ? (
                <section className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-sm font-medium text-slate-200">
                      Pose map
                    </h2>
                    {poseMapAssets.length > 0 ? (
                      <button
                        type="button"
                        aria-expanded={assetPicker === "pose"}
                        onClick={() =>
                          setAssetPicker((current) =>
                            current === "pose" ? null : "pose",
                          )
                        }
                        className="shrink-0 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-sky-300 hover:bg-slate-800 hover:text-sky-200"
                      >
                        {assetPicker === "pose"
                          ? "Show poses"
                          : "Choose pose image"}
                      </button>
                    ) : null}
                  </div>
                  {assetPicker === "pose" ? (
                    <MediaAssetBrowser
                      assets={poseMapAssets}
                      label="pose maps"
                      compact
                      metadata={assetMetadata}
                      categories={categories}
                      selectedIds={
                        settings.poseImageAssetId
                          ? [settings.poseImageAssetId]
                          : []
                      }
                      onSelect={(asset) => {
                        onChange({
                          ...settings,
                          poseImageAssetId: asset.id,
                          baseImageAssetId:
                            settings.baseImageAssetId === asset.id
                              ? null
                              : settings.baseImageAssetId,
                          editMask:
                            settings.baseImageAssetId === asset.id
                              ? null
                              : settings.editMask,
                          referenceImages: settings.referenceImages.filter(
                            (reference) => reference.assetId !== asset.id,
                          ),
                        });
                        setAssetPicker(null);
                      }}
                    />
                  ) : null}
                  <MediaPoseWorkspace
                    aspectRatio={settings.aspectRatio}
                    savedScenes={savedPoseScenes}
                    onRenamePoseScene={onRenamePoseScene}
                    onLoadScene={(scene, guidance) =>
                      onChange({
                        ...settings,
                        aspectRatio: scene.aspectRatio,
                        ...(guidance
                          ? {
                              poseStrength: guidance.strength,
                              poseStart: guidance.start,
                              poseEnd: guidance.end,
                            }
                          : {}),
                      })
                    }
                    disabled={referenceImportPending}
                    externalPoseSelected={Boolean(poseImageAsset)}
                    appliedPreview={
                      poseImageAsset ? (
                        <MediaAssetPreview
                          asset={poseImageAsset}
                          fit="contain"
                          className="h-full w-full"
                        />
                      ) : undefined
                    }
                    onRemoveApplied={() =>
                      onChange({ ...settings, poseImageAssetId: null })
                    }
                    guidance={{
                      strength: settings.poseStrength,
                      start: settings.poseStart ?? 0,
                      end: settings.poseEnd ?? 1,
                    }}
                    onGuidanceChange={(guidance) =>
                      onChange({
                        ...settings,
                        poseStrength: guidance.strength,
                        poseStart: guidance.start,
                        poseEnd: guidance.end,
                      })
                    }
                    onGenerate={onGeneratePoseChat}
                    onApply={onSelectPosePreset}
                  />
                  {poseImageAsset && poseSetupMessage ? (
                    <p className="text-xs text-amber-300">{poseSetupMessage}</p>
                  ) : null}
                  {poseImageAsset &&
                  selectedModel &&
                  [
                    "stable-diffusion-1",
                    "stable-diffusion-xl",
                    "pony",
                  ].includes(selectedModel.architecture ?? "") &&
                  directPoseModelIds !== null &&
                  !poseModelReady &&
                  selectedModel.runtimeReadiness === "ready" ? (
                    <button
                      type="button"
                      disabled={poseInstallPending}
                      onClick={() =>
                        onInstallPoseControl(selectedModel.architecture!)
                      }
                      className="rounded-md border border-sky-700 px-4 py-2 text-sm font-medium text-sky-300 disabled:opacity-50"
                    >
                      {poseInstallPending
                        ? "Installing OpenPose…"
                        : `Install OpenPose (${selectedModel.architecture === "stable-diffusion-1" ? "1.5" : "2.5"} GB)`}
                    </button>
                  ) : null}
                </section>
              ) : null}

              {target !== "image" ? modelField : null}

              {target !== "video" || settings.referenceImages.length === 0 ? (
                <MediaAddonTriggerWarnings
                  prompt={settings.prompt}
                  addons={compatibleAddons}
                  selections={reconciledModelAddons}
                  onPromptChange={(prompt) => onChange({ ...settings, prompt })}
                />
              ) : null}

              {target === "video" && videoAddonModel ? (
                <section className="space-y-2 border-t border-slate-800 pt-4">
                  <h2 className="text-xs font-medium text-slate-300">
                    Video LoRAs
                  </h2>
                  <MediaAddonTriggerWarnings
                    prompt={settings.prompt}
                    addons={catalog.addons}
                    selections={videoAddons}
                    onPromptChange={(prompt) =>
                      onChange({ ...settings, prompt })
                    }
                  />
                  <MediaAddonDialog
                    model={videoAddonModel}
                    addons={catalog.addons}
                    assets={referenceAssets}
                    metadata={assetMetadata}
                    categories={categories}
                    selections={videoAddons}
                    onChange={(modelAddons) =>
                      onVideoSettingsChange({ ...videoSettings, modelAddons })
                    }
                  />
                </section>
              ) : null}

              {(target !== "video" || settings.referenceImages.length === 0) &&
              addonModel &&
              compatibleAddons.length > 0 ? (
                <section className="space-y-2 border-t border-slate-800 pt-4">
                  <h2 className="text-xs font-medium text-slate-300">
                    {target === "video"
                      ? "Starting image add-ons"
                      : addonModel.addonCapabilities.some(
                            (capability) =>
                              capability.kind === "textual-inversion",
                          )
                        ? "LoRAs and embeddings"
                        : "LoRAs"}
                  </h2>
                  <MediaAddonDialog
                    model={addonModel}
                    addons={compatibleAddons}
                    selections={reconciledModelAddons}
                    assets={referenceAssets}
                    metadata={assetMetadata}
                    categories={categories}
                    onChange={(modelAddons) =>
                      onChange({ ...settings, modelAddons })
                    }
                  />
                </section>
              ) : null}

              <section className="rounded-xl border border-slate-800 bg-slate-900/40">
                <button
                  type="button"
                  aria-expanded={advancedOpen}
                  aria-controls="media-basic-options"
                  onClick={() => setAdvancedOpen((open) => !open)}
                  className="flex w-full items-center justify-between gap-3 rounded-xl px-4 py-3.5 text-left transition-colors hover:bg-slate-800/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400/60"
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-slate-300">
                    <SlidersHorizontal className="h-4 w-4" /> More options
                  </span>
                  <span className="flex min-w-0 items-center gap-2">
                    {!advancedOpen ? (
                      <span className="truncate text-xs text-slate-400">
                        {settingsSummary}
                      </span>
                    ) : null}
                    <ChevronDown
                      className={cn(
                        "h-4 w-4 shrink-0 text-slate-500 transition-transform",
                        advancedOpen && "rotate-180",
                      )}
                    />
                  </span>
                </button>
                {advancedOpen ? (
                  <div
                    id="media-basic-options"
                    className="@container/options space-y-5 border-t border-slate-800 p-4"
                  >
                    <div
                      className={
                        target === "image"
                          ? "grid items-start gap-6 @min-[42rem]/options:has-[[data-sampling-options]]:grid-cols-2"
                          : "space-y-4"
                      }
                    >
                      {target === "image" ? (
                        <MediaBasicImageOutputOptions
                          settings={settings}
                          baseImageAsset={baseImageAsset ?? null}
                          onChange={onChange}
                        />
                      ) : (
                        <div className="grid gap-4 sm:grid-cols-2">
                          {target === "video" ? (
                            <>
                              <label className="space-y-1 text-xs text-slate-400">
                                <span>Aspect ratio</span>
                                <select
                                  value={videoSettings.aspectRatio}
                                  disabled={
                                    videoSettings.width != null ||
                                    videoSettings.height != null
                                  }
                                  onChange={(event) =>
                                    onVideoSettingsChange({
                                      ...videoSettings,
                                      aspectRatio: event.target
                                        .value as MediaVideoRecipeSettings["aspectRatio"],
                                    })
                                  }
                                  className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 text-slate-200"
                                >
                                  {(
                                    ["1:1", "16:9", "9:16", "21:9"] as const
                                  ).map((value) => (
                                    <option key={value}>{value}</option>
                                  ))}
                                </select>
                              </label>
                              {!minimaxH3 ? <label className="space-y-1 text-xs text-slate-400">
                                <span>Loop</span>
                                <select
                                  value={videoSettings.loopMode}
                                  onChange={(event) =>
                                    onVideoSettingsChange({
                                      ...videoSettings,
                                      loopMode: event.target
                                        .value as MediaVideoRecipeSettings["loopMode"],
                                    })
                                  }
                                  className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 text-slate-200"
                                >
                                  <option value="none">None</option>
                                  <option value="crossfade">Crossfade</option>
                                  <option
                                    value="seamless"
                                    disabled={!seamlessSupported}
                                  >
                                    Seamless
                                  </option>
                                  <option value="ping-pong">Ping-pong</option>
                                </select>
                              </label> : null}
                              <label className="space-y-1 text-xs text-slate-400">
                                <span>Quality</span>
                                <select
                                  value={selectedVideoPreset?.id ?? "custom"}
                                  onChange={(event) => {
                                    const preset =
                                      MEDIA_VIDEO_QUALITY_PRESETS.find(
                                        (candidate) =>
                                          candidate.id === event.target.value,
                                      );
                                    if (!preset) return;
                                    onVideoSettingsChange({
                                      ...videoSettings,
                                      width: null,
                                      height: null,
                                      ...resolveMediaVideoQualityPresetSettings(
                                        preset,
                                        selectedModel?.architecture,
                                      ),
                                    });
                                  }}
                                  className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 text-slate-200"
                                >
                                  {!selectedVideoPreset ? (
                                    <option value="custom" disabled>
                                      Custom
                                    </option>
                                  ) : null}
                                  {MEDIA_VIDEO_QUALITY_PRESETS.map((preset) => (
                                    <option key={preset.id} value={preset.id}>
                                      {preset.label}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              {!minimaxH3 ? <label className="flex items-center gap-2 self-end pb-2 text-xs text-slate-300">
                                <input
                                  type="checkbox"
                                  checked={videoSettings.transparentBackground}
                                  onChange={(event) =>
                                    onVideoSettingsChange({
                                      ...videoSettings,
                                      transparentBackground:
                                        event.target.checked,
                                    })
                                  }
                                />
                                Transparent background
                              </label> : null}
                            </>
                          ) : target === "svg" ? (
                            <>
                              {!isSvgVectorization ? (
                                <label className="space-y-1 text-xs text-slate-400">
                                  <span>Style</span>
                                  <select
                                    value={svgStyle}
                                    onChange={(event) =>
                                      onChange({
                                        ...settings,
                                        svgStyle: event.target
                                          .value as ImageRecipeSettings["svgStyle"],
                                      })
                                    }
                                    className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 text-slate-200"
                                  >
                                    <option value="illustration">
                                      Illustration
                                    </option>
                                    <option value="icon">Icon</option>
                                    <option value="logo">Logo</option>
                                    <option value="diagram">Diagram</option>
                                    <option value="technical">Technical</option>
                                  </select>
                                </label>
                              ) : null}
                              <label className="space-y-1 text-xs text-slate-400">
                                <span>Aspect ratio</span>
                                <select
                                  value={settings.aspectRatio}
                                  onChange={(event) =>
                                    onChange({
                                      ...settings,
                                      aspectRatio: event.target
                                        .value as ImageRecipeSettings["aspectRatio"],
                                    })
                                  }
                                  className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 text-slate-200"
                                >
                                  {(
                                    ["1:1", "4:5", "16:9", "9:16"] as const
                                  ).map((value) => (
                                    <option key={value}>{value}</option>
                                  ))}
                                </select>
                              </label>
                              <label className="flex items-center gap-2 self-end pb-2 text-xs text-slate-300">
                                <input
                                  type="checkbox"
                                  checked={settings.transparentBackground}
                                  onChange={(event) =>
                                    onChange({
                                      ...settings,
                                      transparentBackground:
                                        event.target.checked,
                                    })
                                  }
                                />
                                Transparent background
                              </label>
                            </>
                          ) : null}
                        </div>
                      )}
                      <MediaBasicSamplingOptions
                        target={target}
                        settings={settings}
                        videoSettings={videoSettings}
                        model={selectedModel}
                        onChange={onChange}
                        onVideoChange={onVideoSettingsChange}
                      />
                    </div>
                    {target === "video" &&
                    settings.referenceImages.length === 0 ? (
                      <div className="space-y-2 border-t border-slate-800 pt-4">
                        <label
                          htmlFor="media-starting-image-model"
                          className="block text-xs text-slate-400"
                        >
                          Starting image model
                        </label>
                        <MediaModelPicker
                          id="media-starting-image-model"
                          models={listSelectableMediaModels(catalog.models, {
                            target: "image",
                            requiredCapabilities: ["text-to-image"],
                            allowedModelIds: directGenerationModelIds,
                          })}
                          value={addonModel?.id ?? null}
                          assets={referenceAssets}
                          metadata={assetMetadata}
                          categories={categories}
                          onChange={(modelId) => {
                            if (modelId)
                              onChange({
                                ...settings,
                                modelId,
                                modelAddons: reconcileMediaModelAddonSelections(
                                  models.find(
                                    (model) => model.id === modelId,
                                  ) ?? null,
                                  catalog.addons,
                                  settings.modelAddons,
                                ),
                                sampling: {},
                              });
                          }}
                          className="w-full"
                        />
                      </div>
                    ) : null}
                    {target === "image" &&
                    selectedModel !== null &&
                    selectedModel.target === "local" &&
                    basicImageUsesEditStrength(settings, selectedModel) ? (
                      <div className="grid gap-3 border-t border-slate-800 pt-4 sm:grid-cols-2">
                        <label className="space-y-1 text-xs text-slate-400 sm:col-span-2">
                          <span>
                            Edit strength{" "}
                            {(settings.editStrength ?? 0.65).toFixed(2)}
                          </span>
                          <input
                            type="range"
                            min={
                              Math.ceil(
                                20 /
                                  (settings.sampling?.numInferenceSteps ??
                                    defaultMediaImageSteps(
                                      selectedModel.architecture,
                                      settings.modelPolicy,
                                    )),
                              ) / 20
                            }
                            max={1}
                            step={0.05}
                            value={settings.editStrength ?? 0.65}
                            onChange={(event) =>
                              onChange({
                                ...settings,
                                editStrength: Number(event.target.value),
                              })
                            }
                            className="block w-full accent-sky-400"
                          />
                        </label>
                        {settings.editMask !== null ? (
                          <label className="space-y-1 text-xs text-slate-400 sm:col-span-2">
                            <span>
                              Mask strength{" "}
                              {(settings.maskStrength ?? 1).toFixed(2)}
                            </span>
                            <input
                              type="range"
                              min={0.05}
                              max={1}
                              step={0.05}
                              value={settings.maskStrength ?? 1}
                              onChange={(event) =>
                                onChange({
                                  ...settings,
                                  maskStrength: Number(event.target.value),
                                })
                              }
                              className="block w-full accent-sky-400"
                            />
                          </label>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </section>
            </div>

            <footer className="sticky bottom-0 z-10 shrink-0 space-y-2 border-t border-slate-800/80 bg-slate-950/95 p-4 backdrop-blur lg:static">
              {persistenceError ? (
                <p className="text-xs text-rose-300">{persistenceError}</p>
              ) : null}
              <Button
                type="button"
                size="lg"
                disabled={!canGenerate}
                onClick={onGenerate}
                {...SUBMIT_SHORTCUT_ACTION_PROPS}
                className="h-12 w-full bg-sky-500 text-base font-semibold text-slate-950 hover:bg-sky-400 disabled:bg-slate-800 disabled:text-slate-500"
              >
                {generationPending ? (
                  <LoaderCircle className="h-5 w-5 animate-spin" />
                ) : target === "video" ? (
                  <Video className="h-5 w-5" />
                ) : (
                  <Sparkles className="h-5 w-5" />
                )}
                {generationPending
                  ? `Preparing ${target}`
                  : queueBusy
                    ? `Queue ${target}`
                    : `Generate ${target}`}
              </Button>
              {!generationPending && generationBlockedReason ? (
                <p className="text-center text-xs text-slate-500">
                  {generationBlockedReason}
                </p>
              ) : null}
            </footer>
          </section>

          <section className="flex min-h-[360px] flex-col p-5 xl:min-h-0 xl:overflow-y-auto xl:p-6">
            {generationPending ? (
              <div
                role="status"
                className="mb-3 flex items-center gap-2 text-sm text-slate-300"
              >
                <LoaderCircle className="h-4 w-4 animate-spin" /> Preparing{" "}
                {target}
              </div>
            ) : null}
            <MediaGenerationJobs
              jobs={generationJobs}
              selectedJobId={generationJob?.id ?? null}
              onSelect={onSelectGenerationJob}
              onOpenActivity={onOpenActivity}
              onCancel={onCancelGeneration}
            />

            {resultAssets.length > 0 ? (
              <>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold text-slate-100">
                    Results
                  </h2>
                  <span className="text-xs text-slate-500">
                    {resultAssets.length}
                  </span>
                </div>
                {runFailed || runNeedsReview ? (
                  <div className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-amber-400/20 bg-amber-400/5 p-3">
                    <div className="flex min-w-0 items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                      <p className="text-xs text-amber-100">
                        {runMessage ??
                          (runNeedsReview
                            ? "Review this generation before continuing."
                            : "Generation stopped after creating partial results.")}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        generationJob && onOpenActivity(generationJob.id)
                      }
                      className="shrink-0 text-amber-200 hover:text-white"
                    >
                      Activity
                    </Button>
                  </div>
                ) : null}
                <div className="grid items-start gap-4 sm:grid-cols-2">
                  {resultAssets.map((asset) => (
                    <article
                      key={asset.id}
                      className="group overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/50"
                    >
                      <div
                        className={cn(
                          "w-full bg-slate-950",
                          asset.height > asset.width
                            ? "aspect-[3/4]"
                            : asset.width > asset.height
                              ? "aspect-video"
                              : "aspect-square",
                        )}
                      >
                        <MediaAssetPreview
                          asset={asset}
                          className="h-full w-full"
                          controls={asset.kind === "video"}
                          fit="contain"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-1 p-2">
                        <MediaSaveAssetButton asset={asset} />
                        {asset.kind === "image" ? (
                          <>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => onEditResult(asset)}
                            >
                              Edit image
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => onAnimateResult(asset)}
                            >
                              Animate
                            </Button>
                          </>
                        ) : null}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => onOpenResult(asset)}
                          className="col-span-2"
                        >
                          View in Assets
                        </Button>
                      </div>
                    </article>
                  ))}
                </div>
              </>
            ) : showGenerationProgress ? null : runFailed ||
              runNeedsReview ||
              runCanceled ||
              generationJob?.status === "completed" ? (
              <div className="flex min-h-80 flex-1 items-center justify-center rounded-2xl border border-slate-800 bg-slate-900/20 p-6">
                <div className="max-w-sm text-center">
                  <AlertTriangle
                    className={cn(
                      "mx-auto h-9 w-9",
                      runFailed || generationJob?.status === "completed"
                        ? "text-rose-300"
                        : runNeedsReview
                          ? "text-amber-300"
                          : "text-slate-500",
                    )}
                  />
                  <h2 className="mt-3 text-sm font-semibold text-slate-100">
                    {runNeedsReview
                      ? "Review required"
                      : runFailed
                        ? "Generation failed"
                        : runCanceled
                          ? "Generation canceled"
                          : "No output created"}
                  </h2>
                  {runMessage ? (
                    <p className="mt-2 text-xs leading-5 text-slate-400">
                      {runMessage}
                    </p>
                  ) : null}
                  {generationJob ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        generationJob && onOpenActivity(generationJob.id)
                      }
                      className="mt-4"
                    >
                      View activity
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="flex min-h-80 flex-1 items-center justify-center rounded-2xl border border-dashed border-slate-800 bg-slate-900/20">
                <div className="flex flex-col items-center gap-3 text-slate-600">
                  {target === "video" ? (
                    <Video className="h-10 w-10" />
                  ) : (
                    <ImagePlus className="h-10 w-10" />
                  )}
                  <span className="text-sm">
                    {target === "video"
                      ? "Video output"
                      : target === "svg"
                        ? "SVG output"
                        : "Image output"}
                  </span>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </SubmitShortcut>
  );
};
