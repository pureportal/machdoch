import {
  AlertTriangle,
  Check,
  ChevronDown,
  ImagePlus,
  LoaderCircle,
  SlidersHorizontal,
  Sparkles,
  Video,
  Workflow,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  createMediaModelAddonSelection,
  getMediaModelAddonTriggerWords,
  inspectMediaModelAddonCompatibility,
  mediaModelAddonSelectionsEqual,
  promptContainsMediaModelAddonTrigger,
  reconcileMediaModelAddonSelections,
} from "../../../../core/media/model-addons.js";
import { listSelectableMediaModels } from "../../../../core/media/model-library.js";
import { isMediaModelReady } from "../../../../core/media/model-readiness.js";
import { hasMediaImageMaskContent } from "../../../../core/media/image-mask.js";
import {
  getMediaReferenceConditioningCapabilities,
  mediaModelSupportsPromptlessConditioning,
  mediaModelSupportsReferenceRole,
} from "../../../../core/media/reference-conditioning.js";
import { MEDIA_VIDEO_QUALITY_PRESETS } from "../../../../core/media/video-quality.js";
import type {
  ImageRecipeSettings,
  MediaAssetCategory,
  MediaAssetRecord,
  MediaCompiledPlan,
  MediaCapability,
  MediaGenerationAssetMetadata,
  MediaGenerationTarget,
  MediaModelAddonSelection,
  MediaModelCatalogSnapshot,
  MediaVideoRecipeSettings,
} from "../../../../core/media/contracts.js";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";
import { MediaAssetPreview } from "./media-visual-preview";
import { MediaModelPicker } from "./media-model-picker";
import { MediaImageMaskEditor } from "./media-image-mask-editor";
import type { MediaGenerationQueueJob } from "../media-generation-queue";
import { normalizeMediaSubmissionText } from "../media-generation-recipe";
import { MediaAddonBrowser } from "./media-addon-picker";

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
  onOpenAssets: () => void;
  onOpenActivity: () => void;
  onGenerate: () => void;
  onAddReferenceImages: () => void;
  onAddBaseImage: () => void;
  onAddPoseImage: () => void;
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
  onOpenAssets,
  onOpenActivity,
  onGenerate,
  onAddReferenceImages,
  onAddBaseImage,
  onAddPoseImage,
  onEditResult,
  onAnimateResult,
  onOpenResult,
  generationPending,
}: MediaGenerateViewProps): JSX.Element => {
  const [assetPicker, setAssetPicker] = useState<
    "reference" | "base" | "pose" | null
  >(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [addonPickerOpen, setAddonPickerOpen] = useState(false);
  const visualReferenceAssets = useMemo(
    () => referenceAssets.filter((asset) => asset.kind === "image"),
    [referenceAssets],
  );
  const selectedReferenceIds = new Set(
    settings.referenceImages.map((reference) => reference.assetId),
  );
  const isSvgVectorization =
    target === "svg" && settings.svgMode === "vectorize";
  const selectedReferences = settings.referenceImages.flatMap((reference) => {
    const asset = visualReferenceAssets.find(
      (candidate) => candidate.id === reference.assetId,
    );
    return asset ? [{ asset, reference }] : [];
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
  const poseStart = settings.poseStart ?? 0;
  const poseEnd = settings.poseEnd ?? 1;
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
    requiredCapabilities: requiredImageCapabilities,
    allowedModelIds: target === "video" ? null : availableImageModelIds,
  })
    .filter(
      (model) =>
        target !== "image" ||
        (settings.referenceImages.length <=
          getMediaReferenceConditioningCapabilities(model)
            .maximumReferenceImages &&
          settings.referenceImages.every((reference) =>
            mediaModelSupportsReferenceRole(model, reference.role),
          )),
    )
    .sort((left, right) => {
      return (
        Number(right.recommended) - Number(left.recommended) ||
        left.displayName.localeCompare(right.displayName)
      );
    });
  const selectedModelId =
    target === "video" ? videoSettings.modelId : settings.modelId;
  const selectedModel =
    models.find((model) => model.id === selectedModelId) ??
    (target !== "video"
      ? models.find((model) => model.id === plan.model?.id)
      : undefined) ??
    models[0] ??
    null;
  const addonModel =
    target === "video" && settings.referenceImages.length === 0
      ? (catalog.models.find(
          (model) => model.id === settings.modelId && isMediaModelReady(model),
        ) ?? plan.model)
      : selectedModel;
  const referenceCapabilities =
    getMediaReferenceConditioningCapabilities(selectedModel);
  const referenceLimit =
    target === "video" || isSvgVectorization
      ? 1
      : Math.min(
          referenceCapabilities.maximumReferenceImages,
          Math.max(
            0,
            8 -
              (settings.baseImageAssetId ? 1 : 0) -
              (settings.poseImageAssetId ? 1 : 0),
          ),
        );
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
  const selectedAddons = new Map(
    reconciledModelAddons.map((selection) => [selection.addonId, selection]),
  );
  const missingTriggers = compatibleAddons.flatMap((addon) => {
    const selection = selectedAddons.get(addon.id);
    if (!selection?.enabled) return [];
    const triggers = getMediaModelAddonTriggerWords(addon);
    if (promptContainsMediaModelAddonTrigger(settings.prompt, addon)) {
      return [];
    }
    return [{ addon, triggers }];
  });
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
    promptReady &&
    svgReferenceReady &&
    baseMaskReady &&
    modelReady &&
    runtimeReady &&
    planReady &&
    (target !== "video" || videoGenerationSupported) &&
    !settings.qualityGateEnabled &&
    !generationPending;
  const generationBlockedReason = !svgReferenceReady
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
                    ? "Resolve the generation settings"
                    : settings.qualityGateEnabled
                      ? "Run quality gates in Advanced"
                      : null;
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
      preset.settings.resolution === videoSettings.resolution &&
      preset.settings.numFrames === videoSettings.numFrames &&
      preset.settings.fps === videoSettings.fps,
  );
  const svgStyle = settings.svgStyle ?? "illustration";
  const svgStyleLabel = `${svgStyle[0].toLocaleUpperCase()}${svgStyle.slice(1)}`;
  const settingsSummary = [
    target === "video"
      ? videoSettings.aspectRatio
      : target === "svg"
        ? isSvgVectorization
          ? "Vectorize"
          : svgStyleLabel
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
    if (!selectedModel || selectedModel.id === selectedModelId) return;
    if (target === "video") {
      onVideoSettingsChange({
        ...videoSettings,
        modelId: selectedModel.id as MediaVideoRecipeSettings["modelId"],
      });
      return;
    }
    onChange({
      ...settings,
      modelId: selectedModel.id,
      modelAddons: [],
      referenceImages: settings.referenceImages
        .filter((reference) =>
          mediaModelSupportsReferenceRole(selectedModel, reference.role),
        )
        .map((reference) => ({ ...reference, influence: 1 })),
    });
  }, [
    onChange,
    onVideoSettingsChange,
    selectedModel,
    selectedModelId,
    settings,
    target,
    videoSettings,
  ]);

  useEffect(() => {
    if (
      mediaModelAddonSelectionsEqual(
        settings.modelAddons,
        reconciledModelAddons,
      )
    ) {
      return;
    }
    onChange({ ...settings, modelAddons: reconciledModelAddons });
  }, [onChange, reconciledModelAddons, settings]);

  const selectModel = (modelId: string): void => {
    if (target === "video") {
      onVideoSettingsChange({
        ...videoSettings,
        modelId: modelId as MediaVideoRecipeSettings["modelId"],
      });
      return;
    }
    const model = models.find((candidate) => candidate.id === modelId);
    onChange({
      ...settings,
      modelId,
      modelAddons: [],
      referenceImages: settings.referenceImages
        .filter((reference) =>
          mediaModelSupportsReferenceRole(model ?? null, reference.role),
        )
        .map((reference) => ({ ...reference, influence: 1 })),
    });
  };

  const toggleAddon = (addonId: string): void => {
    const addon = catalog.addons.find((candidate) => candidate.id === addonId);
    if (
      !addon ||
      !addonModel ||
      inspectMediaModelAddonCompatibility(addonModel, addon).status !==
        "compatible"
    ) {
      return;
    }
    const existing = selectedAddons.get(addonId);
    if (existing) {
      onChange({
        ...settings,
        modelAddons: reconciledModelAddons.filter(
          (selection) => selection.addonId !== addonId,
        ),
      });
      return;
    }
    const capability = addonModel?.addonCapabilities.find(
      (candidate) => candidate.kind === addon.kind,
    );
    const activeKindCount = reconciledModelAddons.filter(
      (selection) => selection.enabled && selection.kind === addon.kind,
    ).length;
    if (capability && activeKindCount >= capability.maxActive) return;
    onChange({
      ...settings,
      modelAddons: [
        ...reconciledModelAddons,
        createMediaModelAddonSelection(addon),
      ],
    });
  };

  const changeAddonSelection = (selection: MediaModelAddonSelection): void => {
    onChange({
      ...settings,
      modelAddons: reconciledModelAddons.map((candidate) =>
        candidate.addonId === selection.addonId ? selection : candidate,
      ),
    });
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

  const generateFromShortcut = (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if (
      event.key !== "Enter" ||
      (!event.ctrlKey && !event.metaKey) ||
      !canGenerate
    ) {
      return;
    }
    event.preventDefault();
    onGenerate();
  };

  return (
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
        <Button type="button" variant="outline" onClick={onOpenFlow}>
          <Workflow className="h-4 w-4" /> Convert to Advanced
        </Button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(360px,0.85fr)_minmax(420px,1.15fr)] lg:overflow-hidden">
        <section className="flex flex-col border-slate-800/70 lg:min-h-0 lg:border-r lg:overflow-hidden">
          <div className="space-y-5 p-5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
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
                        "rounded-lg px-3 py-2 text-xs font-medium transition-colors",
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
                  onKeyDown={generateFromShortcut}
                  aria-keyshortcuts="Control+Enter Meta+Enter"
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
                    className="shrink-0 text-xs font-medium text-sky-300 hover:text-sky-200"
                  >
                    {assetPicker === "reference"
                      ? "Close"
                      : "Choose from Assets"}
                  </button>
                ) : null}
              </div>
              <div className="flex min-h-11 gap-2 overflow-x-auto pb-1">
                {selectedReferences.map(({ asset, reference }, index) => (
                  <div key={asset.id} className="w-28 shrink-0 space-y-1.5">
                    <div className="group relative aspect-square overflow-hidden rounded-xl border border-slate-700">
                      <MediaAssetPreview
                        asset={asset}
                        className="h-full w-full"
                      />
                      <button
                        type="button"
                        aria-label={`Remove reference ${index + 1}`}
                        onClick={() =>
                          changeReferences(
                            settings.referenceImages.filter(
                              (candidate) => candidate.assetId !== asset.id,
                            ),
                          )
                        }
                        className="absolute top-1 right-1 rounded-md bg-slate-950/85 p-1 text-slate-200 opacity-80 transition-opacity hover:opacity-100"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                    {target === "image" ? (
                      <select
                        aria-label={`Reference ${index + 1} role`}
                        value={reference.role}
                        onChange={(event) =>
                          changeReferences(
                            settings.referenceImages.map((candidate) =>
                              candidate.assetId === asset.id
                                ? {
                                    ...candidate,
                                    role: event.target
                                      .value as typeof candidate.role,
                                  }
                                : candidate,
                            ),
                          )
                        }
                        className="h-7 w-full rounded-lg border border-slate-700 bg-slate-950 px-1.5 text-[10px] text-slate-300"
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
                      <label className="block text-[10px] text-slate-500">
                        <span>Influence {reference.influence.toFixed(2)}</span>
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
                                candidate.assetId === asset.id
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
                  <button
                    type="button"
                    aria-label={`Add ${referenceHeading.toLocaleLowerCase()}`}
                    title={
                      referenceImportSupported
                        ? undefined
                        : "Add images in the desktop app"
                    }
                    onClick={onAddReferenceImages}
                    disabled={
                      !referenceImportSupported || referenceImportPending
                    }
                    className="flex h-20 w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-slate-700 text-slate-400 transition-colors hover:border-sky-500 hover:text-sky-300 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {referenceImportPending ? (
                      <LoaderCircle className="h-5 w-5 animate-spin" />
                    ) : (
                      <ImagePlus className="h-5 w-5" />
                    )}
                    <span className="text-[10px]">
                      {referenceImportPending ? "Adding" : "Add image"}
                    </span>
                  </button>
                ) : null}
              </div>
              {assetPicker === "reference" ? (
                <div className="grid max-h-64 grid-cols-4 gap-2 overflow-y-auto rounded-xl border border-slate-800 bg-slate-900/60 p-2 sm:grid-cols-6">
                  {visualReferenceAssets.map((asset) => {
                    const selected = selectedReferenceIds.has(asset.id);
                    return (
                      <button
                        key={asset.id}
                        type="button"
                        aria-pressed={selected}
                        aria-label={`${selected ? "Remove" : "Choose"} asset ${asset.outputIndex + 1}`}
                        onClick={() =>
                          selected
                            ? changeReferences(
                                settings.referenceImages.filter(
                                  (reference) => reference.assetId !== asset.id,
                                ),
                              )
                            : addReference(asset)
                        }
                        className={cn(
                          "relative aspect-square overflow-hidden rounded-lg border",
                          selected
                            ? "border-sky-400 ring-1 ring-sky-400"
                            : "border-slate-700 hover:border-slate-500",
                        )}
                      >
                        <MediaAssetPreview
                          asset={asset}
                          className="h-full w-full"
                        />
                        {selected ? (
                          <Check className="absolute top-1 right-1 h-4 w-4 rounded-full bg-sky-500 p-0.5 text-white" />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </section>

            {target === "image" ? (
              <section className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-medium text-slate-200">
                    Base image
                  </h2>
                  {visualReferenceAssets.some(
                    (asset) => asset.kind === "image",
                  ) ? (
                    <button
                      type="button"
                      aria-expanded={assetPicker === "base"}
                      onClick={() =>
                        setAssetPicker((current) =>
                          current === "base" ? null : "base",
                        )
                      }
                      className="shrink-0 text-xs font-medium text-sky-300 hover:text-sky-200"
                    >
                      {assetPicker === "base" ? "Close" : "Choose from Assets"}
                    </button>
                  ) : null}
                </div>
                <div className="flex min-h-11 gap-2">
                  {baseImageAsset ? (
                    <div className="group relative h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-slate-700">
                      <MediaAssetPreview
                        asset={baseImageAsset}
                        className="h-full w-full"
                      />
                      <button
                        type="button"
                        aria-label="Remove base image"
                        onClick={() =>
                          onChange({
                            ...settings,
                            baseImageAssetId: null,
                            editMask: null,
                          })
                        }
                        className="absolute top-1 right-1 rounded-md bg-slate-950/85 p-1 text-slate-200"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      aria-label="Add base image"
                      onClick={onAddBaseImage}
                      disabled={
                        !referenceImportSupported || referenceImportPending
                      }
                      className="flex h-20 w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-slate-700 text-slate-400 hover:border-sky-500 hover:text-sky-300 disabled:opacity-40"
                    >
                      <ImagePlus className="h-5 w-5" />
                      <span className="text-[10px]">Add image</span>
                    </button>
                  )}
                </div>
                {assetPicker === "base" ? (
                  <div className="grid max-h-64 grid-cols-4 gap-2 overflow-y-auto rounded-xl border border-slate-800 bg-slate-900/60 p-2 sm:grid-cols-6">
                    {visualReferenceAssets
                      .filter((asset) => asset.kind === "image")
                      .map((asset) => (
                        <button
                          key={asset.id}
                          type="button"
                          aria-pressed={asset.id === settings.baseImageAssetId}
                          aria-label={`Choose base asset ${asset.outputIndex + 1}`}
                          onClick={() => {
                            onChange({
                              ...settings,
                              baseImageAssetId: asset.id,
                              poseImageAssetId:
                                settings.poseImageAssetId === asset.id
                                  ? null
                                  : settings.poseImageAssetId,
                              referenceImages: settings.referenceImages.filter(
                                (reference) => reference.assetId !== asset.id,
                              ),
                              editMask: null,
                              transparentBackground: false,
                            });
                            setAssetPicker(null);
                          }}
                          className={cn(
                            "relative aspect-square overflow-hidden rounded-lg border",
                            asset.id === settings.baseImageAssetId
                              ? "border-sky-400 ring-1 ring-sky-400"
                              : "border-slate-700 hover:border-slate-500",
                          )}
                        >
                          <MediaAssetPreview
                            asset={asset}
                            className="h-full w-full"
                          />
                        </button>
                      ))}
                  </div>
                ) : null}
                {baseImageAsset ? (
                  <>
                    <div className="grid grid-cols-2 rounded-xl border border-slate-800 bg-slate-900/70 p-1">
                      <button
                        type="button"
                        aria-pressed={settings.editMask === null}
                        onClick={() =>
                          onChange({ ...settings, editMask: null })
                        }
                        className={cn(
                          "rounded-lg px-3 py-2 text-xs font-medium",
                          settings.editMask === null
                            ? "bg-slate-700 text-white"
                            : "text-slate-400 hover:text-slate-100",
                        )}
                      >
                        Full image
                      </button>
                      <button
                        type="button"
                        aria-pressed={settings.editMask !== null}
                        onClick={() =>
                          onChange({
                            ...settings,
                            editMask:
                              settings.editMask ??
                              ({
                                schemaVersion: 2,
                                sourceAssetId: baseImageAsset.id,
                                inverted: false,
                                strokes: [],
                              } as const),
                            outputFormat: "png",
                            transparentBackground: false,
                          })
                        }
                        className={cn(
                          "rounded-lg px-3 py-2 text-xs font-medium",
                          settings.editMask !== null
                            ? "bg-slate-700 text-white"
                            : "text-slate-400 hover:text-slate-100",
                        )}
                      >
                        Mask area
                      </button>
                    </div>
                    {settings.editMask ? (
                      <MediaImageMaskEditor
                        asset={baseImageAsset}
                        value={settings.editMask}
                        onChange={(editMask) =>
                          onChange({ ...settings, editMask })
                        }
                      />
                    ) : null}
                  </>
                ) : null}
              </section>
            ) : null}

            {target === "image" &&
            (settings.poseImageAssetId !== null ||
              (directPoseModelIds !== null &&
                directPoseModelIds.length > 0)) ? (
              <section className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-medium text-slate-200">
                    Pose map
                  </h2>
                  {visualReferenceAssets.some(
                    (asset) => asset.kind === "image",
                  ) ? (
                    <button
                      type="button"
                      aria-expanded={assetPicker === "pose"}
                      onClick={() =>
                        setAssetPicker((current) =>
                          current === "pose" ? null : "pose",
                        )
                      }
                      className="shrink-0 text-xs font-medium text-sky-300 hover:text-sky-200"
                    >
                      {assetPicker === "pose" ? "Close" : "Choose from Assets"}
                    </button>
                  ) : null}
                </div>
                <div className="flex min-h-11 gap-2">
                  {poseImageAsset ? (
                    <div className="group relative h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-slate-700">
                      <MediaAssetPreview
                        asset={poseImageAsset}
                        className="h-full w-full"
                      />
                      <button
                        type="button"
                        aria-label="Remove pose map"
                        onClick={() =>
                          onChange({ ...settings, poseImageAssetId: null })
                        }
                        className="absolute top-1 right-1 rounded-md bg-slate-950/85 p-1 text-slate-200"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      aria-label="Add pose map"
                      onClick={onAddPoseImage}
                      disabled={
                        !referenceImportSupported || referenceImportPending
                      }
                      className="flex h-20 w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-slate-700 text-slate-400 hover:border-sky-500 hover:text-sky-300 disabled:opacity-40"
                    >
                      <ImagePlus className="h-5 w-5" />
                      <span className="text-[10px]">Add image</span>
                    </button>
                  )}
                </div>
                {poseImageAsset ? (
                  <div className="grid gap-2">
                    <label className="flex items-center gap-3 text-xs text-slate-300">
                      <span className="w-14">Strength</span>
                      <input
                        type="range"
                        min={0}
                        max={2}
                        step={0.05}
                        value={settings.poseStrength}
                        onChange={(event) =>
                          onChange({
                            ...settings,
                            poseStrength: Number(event.target.value),
                          })
                        }
                        className="min-w-0 flex-1"
                      />
                      <span className="w-8 text-right tabular-nums">
                        {settings.poseStrength.toFixed(2)}
                      </span>
                    </label>
                    <label className="flex items-center gap-3 text-xs text-slate-300">
                      <span className="w-14">Start</span>
                      <input
                        type="range"
                        min={0}
                        max={Math.max(0, poseEnd - 0.05)}
                        step={0.05}
                        value={poseStart}
                        onChange={(event) =>
                          onChange({
                            ...settings,
                            poseStart: Number(event.target.value),
                          })
                        }
                        className="min-w-0 flex-1"
                      />
                      <span className="w-8 text-right tabular-nums">
                        {poseStart.toFixed(2)}
                      </span>
                    </label>
                    <label className="flex items-center gap-3 text-xs text-slate-300">
                      <span className="w-14">End</span>
                      <input
                        type="range"
                        min={Math.min(1, poseStart + 0.05)}
                        max={1}
                        step={0.05}
                        value={poseEnd}
                        onChange={(event) =>
                          onChange({
                            ...settings,
                            poseEnd: Number(event.target.value),
                          })
                        }
                        className="min-w-0 flex-1"
                      />
                      <span className="w-8 text-right tabular-nums">
                        {poseEnd.toFixed(2)}
                      </span>
                    </label>
                  </div>
                ) : null}
                {assetPicker === "pose" ? (
                  <div className="grid max-h-64 grid-cols-4 gap-2 overflow-y-auto rounded-xl border border-slate-800 bg-slate-900/60 p-2 sm:grid-cols-6">
                    {visualReferenceAssets
                      .filter((asset) => asset.kind === "image")
                      .map((asset) => (
                        <button
                          key={asset.id}
                          type="button"
                          aria-pressed={asset.id === settings.poseImageAssetId}
                          aria-label={`Choose pose map ${asset.outputIndex + 1}`}
                          onClick={() => {
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
                          className={cn(
                            "relative aspect-square overflow-hidden rounded-lg border",
                            asset.id === settings.poseImageAssetId
                              ? "border-sky-400 ring-1 ring-sky-400"
                              : "border-slate-700 hover:border-slate-500",
                          )}
                        >
                          <MediaAssetPreview
                            asset={asset}
                            className="h-full w-full"
                          />
                        </button>
                      ))}
                  </div>
                ) : null}
              </section>
            ) : null}

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
                assets={referenceAssets}
                metadata={assetMetadata}
                onChange={(modelId) => {
                  if (modelId) selectModel(modelId);
                }}
                className="w-full"
              />
              {models.length === 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onOpenAssets}
                >
                  Manage models
                </Button>
              ) : null}
            </div>

            {missingTriggers.map(({ addon, triggers }) => (
              <div
                key={addon.id}
                className="flex items-center gap-3 rounded-xl border border-amber-400/20 bg-amber-400/5 px-3 py-2"
              >
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-300" />
                <span className="min-w-0 flex-1 text-xs text-amber-100">
                  {addon.displayName} needs a trigger word.
                </span>
                <button
                  type="button"
                  onClick={() =>
                    onChange({
                      ...settings,
                      prompt: `${settings.prompt.trim()}${settings.prompt.trim() ? ", " : ""}${triggers[0] ?? ""}`,
                    })
                  }
                  className="shrink-0 text-xs font-semibold text-amber-200 hover:text-white"
                >
                  Add {triggers[0]}
                </button>
              </div>
            ))}

            <section className="rounded-xl border border-slate-800 bg-slate-900/40">
              <button
                type="button"
                aria-expanded={advancedOpen}
                aria-controls="media-basic-options"
                onClick={() => setAdvancedOpen((open) => !open)}
                className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left"
              >
                <span className="flex items-center gap-2 text-sm font-medium text-slate-300">
                  <SlidersHorizontal className="h-4 w-4" /> More options
                </span>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[10px] text-slate-500">
                    {settingsSummary}
                  </span>
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
                  className="space-y-4 border-t border-slate-800 p-3"
                >
                  <div className="grid gap-4 sm:grid-cols-2">
                    {target === "video" ? (
                      <>
                        <label className="space-y-1 text-xs text-slate-400">
                          <span>Aspect ratio</span>
                          <select
                            value={videoSettings.aspectRatio}
                            onChange={(event) =>
                              onVideoSettingsChange({
                                ...videoSettings,
                                aspectRatio: event.target
                                  .value as MediaVideoRecipeSettings["aspectRatio"],
                              })
                            }
                            className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 text-slate-200"
                          >
                            {(["1:1", "16:9", "9:16", "21:9"] as const).map(
                              (value) => (
                                <option key={value}>{value}</option>
                              ),
                            )}
                          </select>
                        </label>
                        <label className="space-y-1 text-xs text-slate-400">
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
                            <option value="seamless">Seamless</option>
                            <option value="ping-pong">Ping-pong</option>
                          </select>
                        </label>
                        <label className="space-y-1 text-xs text-slate-400">
                          <span>Quality</span>
                          <select
                            value={selectedVideoPreset?.id ?? "custom"}
                            onChange={(event) => {
                              const preset = MEDIA_VIDEO_QUALITY_PRESETS.find(
                                (candidate) =>
                                  candidate.id === event.target.value,
                              );
                              if (!preset) return;
                              onVideoSettingsChange({
                                ...videoSettings,
                                resolution: preset.settings.resolution,
                                numFrames: preset.settings.numFrames,
                                fps: preset.settings.fps,
                                memoryProfile: preset.settings.memoryProfile,
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
                        <label className="flex items-center gap-2 self-end pb-2 text-xs text-slate-300">
                          <input
                            type="checkbox"
                            checked={videoSettings.transparentBackground}
                            onChange={(event) =>
                              onVideoSettingsChange({
                                ...videoSettings,
                                transparentBackground: event.target.checked,
                              })
                            }
                          />
                          Transparent background
                        </label>
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
                              <option value="illustration">Illustration</option>
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
                            {(["1:1", "4:5", "16:9", "9:16"] as const).map(
                              (value) => (
                                <option key={value}>{value}</option>
                              ),
                            )}
                          </select>
                        </label>
                        <label className="flex items-center gap-2 self-end pb-2 text-xs text-slate-300">
                          <input
                            type="checkbox"
                            checked={settings.transparentBackground}
                            onChange={(event) =>
                              onChange({
                                ...settings,
                                transparentBackground: event.target.checked,
                              })
                            }
                          />
                          Transparent background
                        </label>
                      </>
                    ) : (
                      <>
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
                            {(["1:1", "4:5", "16:9", "9:16"] as const).map(
                              (value) => (
                                <option key={value}>{value}</option>
                              ),
                            )}
                          </select>
                        </label>
                        <label className="space-y-1 text-xs text-slate-400">
                          <span>Outputs</span>
                          <input
                            type="number"
                            min={1}
                            max={8}
                            value={settings.outputCount}
                            onChange={(event) =>
                              onChange({
                                ...settings,
                                outputCount: Math.min(
                                  8,
                                  Math.max(1, Number(event.target.value) || 1),
                                ),
                              })
                            }
                            className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 text-slate-200"
                          />
                        </label>
                        {!settings.baseImageAssetId ? (
                          <label className="flex items-center gap-2 text-xs text-slate-300 sm:col-span-2">
                            <input
                              type="checkbox"
                              checked={settings.transparentBackground}
                              onChange={(event) =>
                                onChange({
                                  ...settings,
                                  transparentBackground: event.target.checked,
                                })
                              }
                            />
                            Transparent background
                          </label>
                        ) : null}
                      </>
                    )}
                  </div>

                  {target === "image" &&
                  selectedModel !== null &&
                  (settings.baseImageAssetId !== null ||
                    settings.referenceImages.length > 0) &&
                  (selectedModel.architecture !== "flux-2" ||
                    settings.editMask !== null) ? (
                    <div className="grid gap-3 border-t border-slate-800 pt-4 sm:grid-cols-2">
                      <label className="space-y-1 text-xs text-slate-400 sm:col-span-2">
                        <span>
                          Edit strength{" "}
                          {(settings.editStrength ?? 0.65).toFixed(2)}
                        </span>
                        <input
                          type="range"
                          min={0.05}
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
                            min={0}
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

                  {(target !== "video" ||
                    settings.referenceImages.length === 0) &&
                  addonModel &&
                  catalog.addons.length > 0 ? (
                    <section className="space-y-2 border-t border-slate-800 pt-4">
                      <div className="flex items-center justify-between gap-3">
                        <h2 className="text-xs font-medium text-slate-300">
                          Model add-ons
                        </h2>
                        <button
                          type="button"
                          onClick={() => setAddonPickerOpen(true)}
                          className="text-xs font-medium text-sky-300 hover:text-sky-200 lg:hidden"
                        >
                          Browse
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-1.5 lg:hidden">
                        {reconciledModelAddons.map((selection) => {
                          const addon = catalog.addons.find(
                            (candidate) => candidate.id === selection.addonId,
                          );
                          return addon ? (
                            <button
                              key={addon.id}
                              type="button"
                              onClick={() => toggleAddon(addon.id)}
                              className="rounded-full border border-sky-400/30 bg-sky-400/10 px-2 py-1 text-[10px] text-sky-100"
                            >
                              {addon.displayName} ×
                            </button>
                          ) : null;
                        })}
                        {reconciledModelAddons.length === 0 ? (
                          <span className="text-[10px] text-slate-500">
                            None selected
                          </span>
                        ) : null}
                      </div>
                      <MediaAddonBrowser
                        model={addonModel}
                        addons={compatibleAddons}
                        selections={reconciledModelAddons}
                        assets={referenceAssets}
                        metadata={assetMetadata}
                        categories={categories}
                        onToggle={toggleAddon}
                        onChangeSelection={changeAddonSelection}
                        onClear={() =>
                          onChange({ ...settings, modelAddons: [] })
                        }
                        className="hidden lg:block"
                      />
                      <Dialog
                        open={addonPickerOpen}
                        onOpenChange={setAddonPickerOpen}
                      >
                        <DialogContent className="max-h-[calc(100%-2rem)] overflow-y-auto border-slate-700 bg-slate-950 text-slate-100 sm:max-w-4xl">
                          <DialogHeader>
                            <DialogTitle>Model add-ons</DialogTitle>
                          </DialogHeader>
                          <MediaAddonBrowser
                            model={addonModel}
                            addons={compatibleAddons}
                            selections={reconciledModelAddons}
                            assets={referenceAssets}
                            metadata={assetMetadata}
                            categories={categories}
                            onToggle={toggleAddon}
                            onChangeSelection={changeAddonSelection}
                            onClear={() =>
                              onChange({ ...settings, modelAddons: [] })
                            }
                          />
                        </DialogContent>
                      </Dialog>
                    </section>
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
              aria-keyshortcuts="Control+Enter Meta+Enter"
              disabled={!canGenerate}
              onClick={onGenerate}
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

        <section className="flex min-h-[360px] flex-col p-5 lg:min-h-0 lg:overflow-y-auto">
          {generationPending || generationJobs.length > 0 ? (
            <div role="status" aria-live="polite" className="mb-4 space-y-2">
              {generationPending && generationJobs.length === 0 ? (
                <div className="rounded-2xl border border-sky-400/20 bg-sky-400/5 p-4">
                  <span className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                    <LoaderCircle className="h-4 w-4 animate-spin text-sky-300" />
                    Preparing {target}
                  </span>
                </div>
              ) : null}
              {generationJobs.map((job) => {
                const active = ["queued", "running", "canceling"].includes(
                  job.status,
                );
                return (
                  <button
                    key={job.id}
                    type="button"
                    onClick={onOpenActivity}
                    className={cn(
                      "block w-full rounded-2xl border p-4 text-left",
                      active
                        ? "border-sky-400/20 bg-sky-400/5"
                        : job.status === "failed"
                          ? "border-rose-400/20 bg-rose-400/5"
                          : "border-slate-800 bg-slate-900/45",
                    )}
                  >
                    <span className="flex items-center justify-between gap-3">
                      <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-100">
                        {job.status === "running" ||
                        job.status === "canceling" ? (
                          <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-sky-300" />
                        ) : null}
                        <span className="truncate">
                          {job.recipe.modelLabel} · {job.recipe.target}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs capitalize tabular-nums text-slate-300">
                        {job.status === "canceled" ? "cancelled" : job.status}
                        {active ? ` · ${Math.round(job.progress * 100)}%` : ""}
                      </span>
                    </span>
                    <span className="mt-1 block truncate text-xs text-slate-400">
                      {job.currentStep}
                    </span>
                    {active ? (
                      <span
                        role="progressbar"
                        aria-label={`${job.recipe.modelLabel} progress`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(job.progress * 100)}
                        className="mt-3 block h-1.5 overflow-hidden rounded-full bg-slate-800"
                      >
                        <span
                          className="block h-full rounded-full bg-sky-400 transition-[width]"
                          style={{
                            width: `${Math.max(4, Math.round(job.progress * 100))}%`,
                          }}
                        />
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}

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
                    onClick={onOpenActivity}
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
                    onClick={onOpenActivity}
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
  );
};
