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
  promptContainsMediaModelAddonTrigger,
} from "../../../../core/media/model-addons.js";
import { listSelectableMediaModels } from "../../../../core/media/model-library.js";
import { isMediaModelReady } from "../../../../core/media/model-readiness.js";
import { hasMediaImageMaskContent } from "../../../../core/media/image-mask.js";
import { MEDIA_VIDEO_QUALITY_PRESETS } from "../../../../core/media/video-quality.js";
import type {
  ImageRecipeSettings,
  MediaAssetRecord,
  MediaCompiledPlan,
  MediaGenerationAssetMetadata,
  MediaGenerationTarget,
  MediaModelCatalogSnapshot,
  MediaRunDetail,
  MediaVideoRecipeSettings,
} from "../../../../core/media/contracts.js";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";
import {
  MediaAssetPreview,
  MediaResourcePreview,
} from "./media-visual-preview";
import { MediaModelPicker } from "./media-model-picker";
import { MediaImageMaskEditor } from "./media-image-mask-editor";

interface MediaGenerateViewProps {
  target: MediaGenerationTarget;
  settings: ImageRecipeSettings;
  videoSettings: MediaVideoRecipeSettings;
  assetMetadata: Record<string, MediaGenerationAssetMetadata>;
  plan: MediaCompiledPlan;
  catalog: MediaModelCatalogSnapshot;
  directGenerationModelIds: readonly string[] | null;
  directReferenceImageModelIds: readonly string[] | null;
  videoGenerationSupported: boolean;
  videoGenerationBlockedReason: string | null;
  referenceAssets: readonly MediaAssetRecord[];
  referenceImportSupported: boolean;
  referenceImportPending: boolean;
  generatedRun: MediaRunDetail | null;
  persistenceError: string | null;
  onTargetChange: (target: MediaGenerationTarget) => void;
  onChange: (settings: ImageRecipeSettings) => void;
  onVideoSettingsChange: (settings: MediaVideoRecipeSettings) => void;
  onOpenFlow: () => void;
  onOpenAssets: () => void;
  onOpenActivity: () => void;
  onGenerate: () => void;
  onAddReferenceImages: () => void;
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
  plan,
  catalog,
  directGenerationModelIds,
  directReferenceImageModelIds,
  videoGenerationSupported,
  videoGenerationBlockedReason,
  referenceAssets,
  referenceImportSupported,
  referenceImportPending,
  generatedRun,
  persistenceError,
  onTargetChange,
  onChange,
  onVideoSettingsChange,
  onOpenFlow,
  onOpenAssets,
  onOpenActivity,
  onGenerate,
  onAddReferenceImages,
  onEditResult,
  onAnimateResult,
  onOpenResult,
  generationPending,
}: MediaGenerateViewProps): JSX.Element => {
  const [referencePickerOpen, setReferencePickerOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const visualReferenceAssets = useMemo(
    () =>
      referenceAssets.filter(
        (asset) => asset.kind === "image" || asset.kind === "vector",
      ),
    [referenceAssets],
  );
  const selectedReferenceIds = new Set(
    settings.referenceImages.map((reference) => reference.assetId),
  );
  const isSvgVectorization =
    target === "svg" && settings.svgMode === "vectorize";
  const referenceLimit = target === "video" || isSvgVectorization ? 1 : 8;
  const selectedReferences = settings.referenceImages.flatMap((reference) => {
    const asset = visualReferenceAssets.find(
      (candidate) => candidate.id === reference.assetId,
    );
    return asset ? [{ asset, reference }] : [];
  });
  const availableImageModelIds =
    settings.referenceImages.length > 0
      ? directReferenceImageModelIds
      : directGenerationModelIds;
  const requiredImageCapabilities =
    target !== "image"
      ? undefined
      : hasMediaImageMaskContent(settings.editMask)
        ? (["masked-image-edit"] as const)
        : settings.referenceImages.length > 1
          ? (["multi-reference-edit"] as const)
          : settings.referenceImages.length === 1
            ? (["image-to-image"] as const)
            : (["text-to-image"] as const);
  const models = listSelectableMediaModels(catalog.models, {
    target,
    requiredCapabilities: requiredImageCapabilities,
    allowedModelIds: target === "video" ? null : availableImageModelIds,
  }).sort((left, right) => {
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
  const baseReferenceAsset =
    selectedReferences.find(({ reference }) => reference.role === "base")
      ?.asset ??
    selectedReferences[0]?.asset ??
    null;
  const maskSupported =
    target === "image" &&
    baseReferenceAsset?.kind === "image" &&
    selectedModel?.capabilities.includes("masked-image-edit") === true;
  const addonModel =
    target === "video" && settings.referenceImages.length === 0
      ? (catalog.models.find(
          (model) => model.id === settings.modelId && isMediaModelReady(model),
        ) ?? plan.model)
      : selectedModel;
  const compatibleAddons = addonModel
    ? catalog.addons.filter(
        (addon) =>
          inspectMediaModelAddonCompatibility(addonModel, addon).status !==
          "incompatible",
      )
    : [];
  const selectedAddons = new Map(
    settings.modelAddons.map((selection) => [selection.addonId, selection]),
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
  const promptReady = isSvgVectorization || settings.prompt.trim().length > 0;
  const svgReferenceReady =
    !isSvgVectorization || settings.referenceImages.length > 0;
  const modelReady = selectedModel !== null && isMediaModelReady(selectedModel);
  const runtimeReady =
    target === "video" ||
    (availableImageModelIds !== null &&
      selectedModel !== null &&
      availableImageModelIds.includes(selectedModel.id));
  const planReady = target === "video" || plan.status === "ready";
  const runActive =
    generatedRun !== null &&
    ["queued", "running", "canceling"].includes(generatedRun.status);
  const generationInProgress = generationPending || runActive;
  const canGenerate =
    promptReady &&
    svgReferenceReady &&
    modelReady &&
    runtimeReady &&
    planReady &&
    (target !== "video" || videoGenerationSupported) &&
    !settings.qualityGateEnabled &&
    !generationInProgress;
  const generationBlockedReason = !svgReferenceReady
    ? "Choose an image to vectorize"
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
    generatedRun?.assets.filter((asset) =>
      target === "video"
        ? asset.kind === "video"
        : target === "svg"
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
    generatedRun?.status === "needs-review" ||
    generatedRun?.status === "waiting-for-review";
  const runFailed = generatedRun?.status === "failed";
  const runCanceled = generatedRun?.status === "canceled";
  const runMessage =
    generatedRun?.failure?.message ?? generatedRun?.error ?? null;
  const showGenerationProgress =
    generationInProgress &&
    !runFailed &&
    !runCanceled &&
    !runNeedsReview &&
    generatedRun?.status !== "completed";

  useEffect(() => {
    if (!selectedModel || selectedModel.id === selectedModelId) return;
    if (target === "video") {
      onVideoSettingsChange({
        ...videoSettings,
        modelId: selectedModel.id as MediaVideoRecipeSettings["modelId"],
      });
      return;
    }
    onChange({ ...settings, modelId: selectedModel.id, modelAddons: [] });
  }, [
    onChange,
    onVideoSettingsChange,
    selectedModel,
    selectedModelId,
    settings,
    target,
    videoSettings,
  ]);

  const selectModel = (modelId: string): void => {
    if (target === "video") {
      onVideoSettingsChange({
        ...videoSettings,
        modelId: modelId as MediaVideoRecipeSettings["modelId"],
      });
      return;
    }
    onChange({ ...settings, modelId, modelAddons: [] });
  };

  const toggleAddon = (addonId: string): void => {
    const addon = catalog.addons.find((candidate) => candidate.id === addonId);
    if (!addon) return;
    const existing = selectedAddons.get(addonId);
    if (existing) {
      onChange({
        ...settings,
        modelAddons: settings.modelAddons.filter(
          (selection) => selection.addonId !== addonId,
        ),
      });
      return;
    }
    const capability = addonModel?.addonCapabilities.find(
      (candidate) => candidate.kind === addon.kind,
    );
    const activeKindCount = settings.modelAddons.filter(
      (selection) => selection.enabled && selection.kind === addon.kind,
    ).length;
    if (capability && activeKindCount >= capability.maxActive) return;
    onChange({
      ...settings,
      modelAddons: [
        ...settings.modelAddons,
        createMediaModelAddonSelection(addon),
      ],
    });
  };

  const changeReferences = (
    references: ImageRecipeSettings["referenceImages"],
  ): void => {
    const normalized = references.map((reference, index) => ({
      ...reference,
      role:
        index === 0
          ? ("base" as const)
          : reference.role === "base"
            ? ("subject" as const)
            : reference.role,
    }));
    onChange({
      ...settings,
      referenceImages: normalized,
      editMask:
        normalized[0]?.assetId === settings.editMask?.sourceAssetId
          ? settings.editMask
          : null,
    });
  };

  const addReference = (asset: MediaAssetRecord): void => {
    if (selectedReferenceIds.has(asset.id)) return;
    if (referenceLimit === 1) {
      changeReferences([{ assetId: asset.id, role: "base", influence: 1 }]);
      return;
    }
    if (settings.referenceImages.length >= referenceLimit) return;
    changeReferences([
      ...settings.referenceImages,
      {
        assetId: asset.id,
        role: settings.referenceImages.length === 0 ? "base" : "subject",
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
      editMask:
        referenceImages[0]?.assetId === settings.editMask?.sourceAssetId
          ? settings.editMask
          : null,
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
        <section className="flex min-h-0 flex-col border-slate-800/70 lg:border-r lg:overflow-hidden">
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
                    aria-expanded={referencePickerOpen}
                    onClick={() => setReferencePickerOpen((open) => !open)}
                    className="shrink-0 text-xs font-medium text-sky-300 hover:text-sky-200"
                  >
                    {referencePickerOpen ? "Close" : "Choose from Assets"}
                  </button>
                ) : null}
              </div>
              <div className="flex min-h-11 gap-2 overflow-x-auto pb-1">
                {selectedReferences.map(({ asset }, index) => (
                  <div
                    key={asset.id}
                    className="group relative h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-slate-700"
                  >
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
                            (reference) => reference.assetId !== asset.id,
                          ),
                        )
                      }
                      className="absolute top-1 right-1 rounded-md bg-slate-950/85 p-1 text-slate-200 opacity-80 transition-opacity hover:opacity-100"
                    >
                      <X className="h-3 w-3" />
                    </button>
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
              {referencePickerOpen ? (
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

            {maskSupported && baseReferenceAsset ? (
              <section className="space-y-2">
                <h2 className="text-sm font-medium text-slate-200">Mask</h2>
                <MediaImageMaskEditor
                  asset={baseReferenceAsset}
                  value={settings.editMask}
                  onChange={(editMask) => onChange({ ...settings, editMask })}
                />
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
                      </>
                    )}
                  </div>

                  {(target !== "video" ||
                    settings.referenceImages.length === 0) &&
                  compatibleAddons.length > 0 ? (
                    <section className="space-y-2 border-t border-slate-800 pt-4">
                      <div className="flex items-center justify-between gap-3">
                        <h2 className="text-xs font-medium text-slate-300">
                          Model add-ons
                        </h2>
                        <button
                          type="button"
                          onClick={onOpenAssets}
                          className="text-xs font-medium text-sky-300 hover:text-sky-200"
                        >
                          Browse
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {compatibleAddons.map((addon) => {
                          const selected = selectedAddons.has(addon.id);
                          const compatibility = addonModel
                            ? inspectMediaModelAddonCompatibility(
                                addonModel,
                                addon,
                              )
                            : null;
                          const capability = addonModel?.addonCapabilities.find(
                            (candidate) => candidate.kind === addon.kind,
                          );
                          const atCapacity =
                            !selected &&
                            capability !== undefined &&
                            settings.modelAddons.filter(
                              (selection) =>
                                selection.enabled &&
                                selection.kind === addon.kind,
                            ).length >= capability.maxActive;
                          return (
                            <button
                              key={addon.id}
                              type="button"
                              aria-pressed={selected}
                              disabled={atCapacity}
                              onClick={() => toggleAddon(addon.id)}
                              className={cn(
                                "overflow-hidden rounded-xl border text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45",
                                selected
                                  ? "border-sky-400 bg-sky-500/10"
                                  : "border-slate-800 bg-slate-900/60 hover:border-slate-600",
                              )}
                            >
                              <div className="aspect-[4/3] bg-slate-900">
                                <MediaResourcePreview
                                  resourceId={addon.id}
                                  metadata={assetMetadata}
                                  assets={referenceAssets}
                                  className="h-full w-full"
                                />
                              </div>
                              <div className="flex items-center gap-2 p-2">
                                <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-200">
                                  {addon.displayName}
                                </span>
                                {selected ? (
                                  <Check className="h-4 w-4 text-sky-300" />
                                ) : compatibility?.status === "unverified" ? (
                                  <span className="text-[9px] text-amber-300">
                                    Unverified
                                  </span>
                                ) : null}
                              </div>
                            </button>
                          );
                        })}
                      </div>
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
              {generationInProgress ? (
                <LoaderCircle className="h-5 w-5 animate-spin" />
              ) : target === "video" ? (
                <Video className="h-5 w-5" />
              ) : (
                <Sparkles className="h-5 w-5" />
              )}
              {generationInProgress
                ? `Generating ${target}`
                : `Generate ${target}`}
            </Button>
            {!generationInProgress && generationBlockedReason ? (
              <p className="text-center text-xs text-slate-500">
                {generationBlockedReason}
              </p>
            ) : null}
          </footer>
        </section>

        <section className="flex min-h-[360px] flex-col p-5 lg:min-h-0 lg:overflow-y-auto">
          {showGenerationProgress ? (
            <div
              role="status"
              aria-live="polite"
              className="mb-4 rounded-2xl border border-sky-400/20 bg-sky-400/5 p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                  <LoaderCircle className="h-4 w-4 animate-spin text-sky-300" />
                  Generating {target}
                </span>
                {generatedRun ? (
                  <span className="text-xs tabular-nums text-sky-200">
                    {Math.round(generatedRun.progress * 100)}%
                  </span>
                ) : null}
              </div>
              <p className="mt-2 text-xs text-slate-400">
                {generatedRun?.currentStep || "Preparing generation"}
              </p>
              <div
                role="progressbar"
                aria-label="Generation progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={
                  generatedRun
                    ? Math.round(generatedRun.progress * 100)
                    : undefined
                }
                className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-800"
              >
                <div
                  className={cn(
                    "h-full rounded-full bg-sky-400 transition-[width]",
                    !generatedRun && "animate-pulse",
                  )}
                  style={{
                    width: generatedRun
                      ? `${Math.max(4, Math.round(generatedRun.progress * 100))}%`
                      : "32%",
                  }}
                />
              </div>
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
                    <div className="flex items-center gap-1 p-2">
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
                        className="ml-auto"
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
            generatedRun?.status === "completed" ? (
            <div className="flex min-h-80 flex-1 items-center justify-center rounded-2xl border border-slate-800 bg-slate-900/20 p-6">
              <div className="max-w-sm text-center">
                <AlertTriangle
                  className={cn(
                    "mx-auto h-9 w-9",
                    runFailed || runNeedsReview
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
                {generatedRun ? (
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
