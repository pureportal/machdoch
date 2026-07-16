import {
  ArrowDown,
  ArrowUp,
  AlertTriangle,
  ChevronDown,
  CircleAlert,
  ImagePlus,
  ImageIcon,
  Images,
  Info,
  ListChecks,
  LoaderCircle,
  Minus,
  Plus,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Upload,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import { inspectMediaModelAddonCompatibility } from "../../../../core/media/model-addons.js";
import type {
  ImageRecipeSettings,
  MediaAssetRecord,
  MediaCompiledPlan,
  MediaDiagnosticSeverity,
  MediaModelCatalogSnapshot,
  MediaModelDescriptor,
  MediaImageReference,
  MediaImageReferenceRole,
  MediaRunDetail,
} from "../../../../core/media/contracts.js";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { usePromptHistoryNavigation } from "../../_helpers/use-prompt-history-navigation";
import { cn } from "../../lib/utils";
import { readMediaAssetReferencePreview } from "../media-runtime";

interface MediaGenerateViewProps {
  settings: ImageRecipeSettings;
  plan: MediaCompiledPlan;
  catalog: MediaModelCatalogSnapshot;
  directGenerationModelIds: readonly string[] | null;
  directReferenceImageModelIds: readonly string[] | null;
  referenceAssets: readonly MediaAssetRecord[];
  referenceImportSupported: boolean;
  referenceImportPending: boolean;
  generatedRun: MediaRunDetail | null;
  persistenceError: string | null;
  promptHistory?: readonly string[];
  onChange: (settings: ImageRecipeSettings) => void;
  onOpenFlow: () => void;
  onOpenModels: () => void;
  onOpenProviderSettings: () => void;
  onGenerate: () => void;
  onGenerateWithReview?: () => void;
  onOpenRunReview?: () => void;
  onAddReferenceImages: () => void;
  generationPending: boolean;
  runtimeMode: "native" | "browser-preview" | null;
}

interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
}

const ASPECT_CLASSES: Record<ImageRecipeSettings["aspectRatio"], string> = {
  "1:1": "aspect-square",
  "4:5": "aspect-[4/5]",
  "16:9": "aspect-video",
  "9:16": "aspect-[9/16]",
};

const REFERENCE_ROLE_OPTIONS: ReadonlyArray<{
  value: Exclude<MediaImageReferenceRole, "base">;
  label: string;
}> = [
  { value: "subject", label: "Subject" },
  { value: "style", label: "Style" },
  { value: "composition", label: "Composition" },
  { value: "palette", label: "Color palette" },
  { value: "detail", label: "Detail" },
];

const DIAGNOSTIC_STYLES: Record<
  MediaDiagnosticSeverity,
  { icon: typeof Info; className: string }
> = {
  error: {
    icon: CircleAlert,
    className: "border-rose-500/20 bg-rose-500/7 text-rose-200",
  },
  warning: {
    icon: AlertTriangle,
    className: "border-amber-400/20 bg-amber-400/7 text-amber-100",
  },
  info: {
    icon: Info,
    className: "border-sky-400/15 bg-sky-400/6 text-sky-100",
  },
};

const HIDDEN_GENERATE_DIAGNOSTIC_CODES = new Set([
  "MODEL_NOT_READY",
  "LOCAL_MODEL_DOWNLOAD_REQUIRED",
  "PROMPT_REQUIRED",
]);

const simpleDiagnosticMessage = (
  code: string,
  fallback: string,
): string => {
  if (code === "TRANSPARENCY_REQUIRES_POSTPROCESS") {
    return "Machdoch will remove the generated background locally because GPT Image 2 does not provide native transparency.";
  }
  return fallback;
};

const isSimpleGenerationModelAvailable = (
  model: MediaModelDescriptor,
  directGenerationModelIds: readonly string[] | null,
): boolean => {
  if (directGenerationModelIds?.includes(model.id) !== true) return false;
  if (model.target === "remote") return model.configured;
  if (model.providerId === "local-diffusers") {
    return model.installed && model.runtimeReadiness === "ready";
  }
  return model.installed;
};

const SegmentedControl = <T extends string,>({
  label,
  value,
  options,
  onChange,
}: SegmentedControlProps<T>): JSX.Element => {
  return (
    <fieldset className="space-y-2">
      <legend className="text-[11px] font-semibold text-slate-400">
        {label}
      </legend>
      <div
        className="grid gap-1 rounded-xl border border-slate-800/80 bg-slate-950/70 p-1"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-lg px-2 py-2 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60",
              option.value === value
                ? "bg-slate-800 text-slate-50 shadow-sm"
                : "text-slate-500 hover:bg-slate-900 hover:text-slate-300",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
};

const GeneratedAssetPreview = ({
  asset,
  index,
  fixture,
}: {
  asset: MediaAssetRecord;
  index: number;
  fixture: boolean;
}): JSX.Element => {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const assetId = asset.id;
  const isVector = asset.kind === "vector";
  const svgOperation = asset.operation?.kind === "remote-svg-generation"
    ? asset.operation
    : null;
  const svgScoreSummary = svgOperation
    ? [
        `Score ${svgOperation.score.score.toFixed(1)}`,
        svgOperation.score.sourceFidelityScore != null
          ? `Source match ${svgOperation.score.sourceFidelityScore.toFixed(0)}`
          : null,
        svgOperation.score.structuralQualityScore != null
          ? `Structure ${svgOperation.score.structuralQualityScore.toFixed(0)}`
          : null,
        svgOperation.score.multiScaleConsistencyScore != null
          ? `Scale stability ${svgOperation.score.multiScaleConsistencyScore.toFixed(0)}`
          : null,
        `Geometry ${svgOperation.score.geometryEfficiencyScore.toFixed(0)}`,
        `Editability ${svgOperation.score.editabilityScore.toFixed(0)}`,
      ].filter((value): value is string => value !== null).join(" · ")
    : null;

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    void readMediaAssetReferencePreview(assetId)
      .then((blob) => {
        if (cancelled || typeof URL.createObjectURL !== "function") {
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [assetId]);

  return (
    <div className="group relative h-full min-h-40 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/55">
      {url ? (
        <img
          src={url}
          alt={`${fixture ? "Deterministic preview" : isVector ? "Generated SVG" : "Generated image"} ${index + 1}`}
          className={cn("h-full w-full", isVector ? "object-contain p-3" : "object-cover")}
        />
      ) : (
        <div className="flex h-full min-h-40 w-full items-center justify-center text-slate-600">
          {failed ? (
            <div className="text-center">
              <ImageIcon className="mx-auto h-7 w-7" />
              <span className="mt-2 block text-xs">Preview unavailable</span>
            </div>
          ) : (
            <LoaderCircle className="h-5 w-5 animate-spin" />
          )}
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-slate-950/75 px-3 py-2 text-[10px] text-slate-300 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <span>{isVector ? `SVG ${index + 1}` : `Image ${index + 1}`}</span>
        <span>
          {svgScoreSummary ? `${svgScoreSummary} · ` : ""}
          {asset.width} × {asset.height}
        </span>
      </div>
    </div>
  );
};

const ReferenceImageCard = ({
  reference,
  asset,
  index,
  onRoleChange,
  onRemove,
}: {
  reference: MediaImageReference;
  asset: MediaAssetRecord | null;
  index: number;
  onRoleChange: (role: Exclude<MediaImageReferenceRole, "base">) => void;
  onRemove: () => void;
}): JSX.Element => {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const assetId = asset?.id ?? null;

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    if (!assetId) {
      setFailed(true);
      return;
    }
    void readMediaAssetReferencePreview(assetId)
      .then((blob) => {
        if (cancelled || typeof URL.createObjectURL !== "function") return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId]);

  const role = reference.role === "base" ? "subject" : reference.role;
  return (
    <article className="min-w-0 overflow-hidden rounded-xl border border-slate-800 bg-slate-950/65">
      <div className="relative aspect-square bg-slate-900/60">
        {url ? (
          <img
            src={url}
            alt={index === 0 ? "Base reference" : `Reference ${index + 1}`}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-slate-600">
            {failed ? <ImageIcon className="h-6 w-6" /> : <LoaderCircle className="h-5 w-5 animate-spin" />}
          </div>
        )}
        <Button
          type="button"
          variant="secondary"
          size="icon-sm"
          aria-label={`Remove ${index === 0 ? "base reference" : `reference ${index + 1}`}`}
          onClick={onRemove}
          className="absolute right-2 top-2 rounded-lg border border-slate-700 bg-slate-950/85 text-slate-300 hover:bg-slate-800 hover:text-white"
        >
          <X />
        </Button>
      </div>
      <div className="p-2.5">
        {index === 0 ? (
          <div className="flex h-9 items-center rounded-lg border border-sky-400/15 bg-sky-400/5 px-2.5 text-xs font-medium text-sky-200">
            Base image
          </div>
        ) : (
          <label>
            <span className="sr-only">Reference {index + 1} role</span>
            <select
              value={role}
              onChange={(event) =>
                onRoleChange(
                  event.target.value as Exclude<MediaImageReferenceRole, "base">,
                )
              }
              className="h-9 w-full rounded-lg border border-slate-800 bg-slate-900 px-2 text-xs text-slate-300 outline-none focus:border-sky-400/40 focus:ring-2 focus:ring-sky-400/15"
            >
              {REFERENCE_ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </article>
  );
};

const ReferenceLibraryAssetButton = ({
  asset,
  onSelect,
}: {
  asset: MediaAssetRecord;
  onSelect: () => void;
}): JSX.Element => {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    void readMediaAssetReferencePreview(asset.id)
      .then((blob) => {
        if (cancelled || typeof URL.createObjectURL !== "function") return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset.id]);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Add library image ${asset.digest.slice(0, 12)}`}
      className="group min-w-0 overflow-hidden rounded-xl border border-slate-800 bg-slate-950/65 text-left outline-none transition-colors hover:border-sky-400/35 hover:bg-sky-400/5 focus-visible:ring-2 focus-visible:ring-sky-400/60"
    >
      <span className="flex aspect-square items-center justify-center overflow-hidden bg-slate-900/60 text-slate-600">
        {url ? (
          <img src={url} alt="" className="h-full w-full object-cover" />
        ) : failed ? (
          <ImageIcon className="h-6 w-6" />
        ) : (
          <LoaderCircle className="h-5 w-5 animate-spin" />
        )}
      </span>
      <span className="block truncate px-2.5 pt-2 text-xs font-medium text-slate-300">
        {asset.digest.slice(0, 12)}
      </span>
      <span className="block px-2.5 pb-2 pt-0.5 text-[10px] text-slate-600">
        {asset.width} × {asset.height}
      </span>
    </button>
  );
};

const GeneratedImages = ({
  run,
  aspectRatio,
  onOpenRunReview,
}: {
  run: MediaRunDetail | null;
  aspectRatio: ImageRecipeSettings["aspectRatio"];
  onOpenRunReview?: () => void;
}): JSX.Element => {
  const images = run?.assets.filter(
    (asset) => asset.kind === "image" || asset.kind === "vector",
  ) ?? [];
  const isVectorRun = images.some((asset) => asset.kind === "vector");
  const isRunning =
    run !== null && ["queued", "running", "canceling"].includes(run.status);
  const fixture = run?.executor === "deterministic-fixture";

  return (
    <section aria-labelledby="media-results-heading" className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <h2 id="media-results-heading" className="text-sm font-semibold text-slate-200">
          {fixture ? "Browser previews" : isVectorRun ? "Your SVGs" : "Your images"}
        </h2>
        {images.length > 0 ? (
          <span className="text-xs text-slate-500">
            {images.length} {isVectorRun ? "SVG" : "image"}{images.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      {isRunning ? (
        <div className="flex min-h-56 flex-col items-center justify-center rounded-2xl border border-sky-500/15 bg-sky-500/5 px-6 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-400/10 text-sky-300">
            <LoaderCircle className="h-6 w-6 animate-spin" />
          </span>
          <p className="mt-4 text-sm font-semibold text-slate-200">
            {fixture ? "Building browser previews…" : isVectorRun ? "Verifying SVG candidates…" : "Generating your images…"}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {run.currentStep || "This can take a moment."}
          </p>
        </div>
      ) : images.length > 0 ? (
        <>
          {run?.status === "waiting-for-review" ? (
            <div className="flex flex-col gap-3 rounded-2xl border border-fuchsia-400/25 bg-fuchsia-400/6 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-fuchsia-100">
                  Candidates are ready for your decision
                </p>
                <p className="mt-1 text-xs leading-5 text-fuchsia-100/60">
                  Nothing is published to the active Library until you approve the final image in Runs.
                </p>
              </div>
              {onOpenRunReview ? (
                <Button
                  type="button"
                  onClick={onOpenRunReview}
                  className="shrink-0 bg-fuchsia-300 text-slate-950 hover:bg-fuchsia-200"
                >
                  <ListChecks /> Review {images.length} candidates
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {images.map((asset, index) => (
              <div key={asset.id} className={ASPECT_CLASSES[aspectRatio]}>
                <GeneratedAssetPreview asset={asset} index={index} fixture={fixture} />
              </div>
            ))}
          </div>
        </>
      ) : run?.status === "needs-review" ? (
        <div className="flex min-h-44 flex-col items-center justify-center rounded-2xl border border-amber-400/20 bg-amber-400/5 px-6 text-center">
          <ShieldAlert className="h-7 w-7 text-amber-300" />
          <p className="mt-3 text-sm font-semibold text-amber-100">
            Provider decision needs review
          </p>
          <p className="mt-1 max-w-xl text-xs leading-5 text-amber-100/65">
            OpenAI may have accepted or charged this request. It will not be submitted
            again automatically. Open the run to review the duplicate-charge guard.
          </p>
        </div>
      ) : run?.status === "failed" ? (
        <div className="flex min-h-44 flex-col items-center justify-center rounded-2xl border border-rose-500/20 bg-rose-500/5 px-6 text-center">
          <CircleAlert className="h-7 w-7 text-rose-300" />
          <p className="mt-3 text-sm font-semibold text-rose-100">
            {isVectorRun ? "SVGs could not be generated" : "Images could not be generated"}
          </p>
          <p className="mt-1 max-w-xl text-xs leading-5 text-rose-200/65">
            {run.error ?? "Review the message above, then try again."}
          </p>
        </div>
      ) : (
        <div className="flex min-h-36 items-center justify-center rounded-xl border border-dashed border-slate-800 px-6 text-center text-sm text-slate-600">
          <ImageIcon className="mr-2 h-5 w-5" />
          Images and SVGs will appear here
        </div>
      )}
    </section>
  );
};

export const MediaGenerateView = ({
  settings,
  plan,
  catalog,
  directGenerationModelIds,
  directReferenceImageModelIds,
  referenceAssets,
  referenceImportSupported,
  referenceImportPending,
  generatedRun,
  persistenceError,
  promptHistory = [],
  onChange,
  onOpenFlow,
  onOpenModels,
  onOpenProviderSettings,
  onGenerate,
  onGenerateWithReview,
  onOpenRunReview,
  onAddReferenceImages,
  generationPending,
  runtimeMode,
}: MediaGenerateViewProps): JSX.Element => {
  const [referencePickerOpen, setReferencePickerOpen] = useState(false);
  const isSvg = settings.outputFormat === "svg";
  const isSvgVectorization = isSvg && settings.svgMode === "vectorize";
  const hasReferences = settings.referenceImages.length > 0;
  const requiredGenerationCapability = isSvgVectorization
    ? "image-to-svg"
    : isSvg && hasReferences
      ? "guided-svg-generation"
      : isSvg
        ? "text-to-svg"
        : "text-to-image";
  const imageModels = useMemo(
    () =>
      catalog.models.filter(
        (model) =>
          model.capabilities.includes(requiredGenerationCapability) &&
          (!isSvg ||
            isSvgVectorization ||
            model.id !== "quiver:arrow-1.1" ||
            settings.referenceImages.length <= 4) &&
          model.lifecycle !== "removed",
      ),
    [
      catalog.models,
      isSvg,
      isSvgVectorization,
      requiredGenerationCapability,
      settings.referenceImages.length,
    ],
  );
  const providersById = useMemo(
    () =>
      new Map(
        catalog.providers.map((provider) => [provider.id, provider.displayName]),
      ),
    [catalog.providers],
  );
  const availableImageModels = useMemo(
    () =>
      imageModels.filter((model) =>
        isSimpleGenerationModelAvailable(model, directGenerationModelIds),
      ),
    [directGenerationModelIds, imageModels],
  );
  const resolvedModelId = settings.modelId ?? plan.model?.id ?? null;
  const selectedModel =
    availableImageModels.find((model) => model.id === resolvedModelId) ??
    availableImageModels[0] ??
    null;
  const selectedProviderName = selectedModel
    ? (providersById.get(selectedModel.providerId) ?? selectedModel.providerId)
    : "Unknown provider";
  const openAiConfigured = catalog.providers.some(
    (provider) => provider.id === "openai" && provider.configured,
  );
  const svgCriticAvailable = Boolean(
    selectedModel?.target === "remote" &&
      settings.modelPolicy === "quality" &&
      openAiConfigured,
  );
  const addOnRows = useMemo(
    () => {
      const addonsById = new Map(catalog.addons.map((addon) => [addon.id, addon]));
      const selectedIds = new Set(
        settings.modelAddons.map((selection) => selection.addonId),
      );
      const orderedAddons = [
        ...settings.modelAddons.flatMap((selection) => {
          const addon = addonsById.get(selection.addonId);
          return addon ? [addon] : [];
        }),
        ...catalog.addons.filter((addon) => !selectedIds.has(addon.id)),
      ];
      return orderedAddons.map((addon) => {
        const selectionIndex = settings.modelAddons.findIndex(
          (candidate) => candidate.addonId === addon.id,
        );
        const selection = settings.modelAddons[selectionIndex];
        return {
          addon,
          selection,
          selectionIndex,
          stackPosition: selection?.enabled
            ? settings.modelAddons
                .filter((candidate) => candidate.enabled)
                .findIndex((candidate) => candidate.addonId === addon.id) + 1
            : null,
          compatibility: selectedModel
            ? inspectMediaModelAddonCompatibility(selectedModel, addon)
            : null,
        };
      });
    },
    [catalog.addons, selectedModel, settings.modelAddons],
  );
  const referenceSupported =
    selectedModel !== null &&
    directReferenceImageModelIds?.includes(selectedModel.id) === true &&
    selectedModel.capabilities.includes(
      isSvgVectorization
        ? "image-to-svg"
        : isSvg
          ? "guided-svg-generation"
          : "image-to-image",
    );
  const maxReferenceCount = isSvgVectorization
    ? 1
    : isSvg && selectedModel?.id === "quiver:arrow-1.1"
      ? 4
      : 8;
  const assetsById = new Map(referenceAssets.map((asset) => [asset.id, asset]));
  const selectableReferenceAssets = useMemo(() => {
    const selectedAssetIds = new Set(
      settings.referenceImages.map((reference) => reference.assetId),
    );
    const selectedDigests = new Set(
      settings.referenceImages
        .map((reference) =>
          referenceAssets.find((asset) => asset.id === reference.assetId)?.digest,
        )
        .filter((digest): digest is string => typeof digest === "string"),
    );
    const seenDigests = new Set<string>();
    return referenceAssets.filter((asset) => {
      if (
        !["image", "vector"].includes(asset.kind) ||
        selectedAssetIds.has(asset.id) ||
        selectedDigests.has(asset.digest) ||
        seenDigests.has(asset.digest)
      ) {
        return false;
      }
      seenDigests.add(asset.digest);
      return true;
    });
  }, [referenceAssets, settings.referenceImages]);
  const canAddReferences =
    referenceSupported &&
    settings.referenceImages.length < maxReferenceCount &&
    (referenceImportSupported || selectableReferenceAssets.length > 0);
  const isReady = plan.status === "ready";
  const hasPrompt = settings.prompt.trim().length > 0;
  const maxOutputCount = isSvgVectorization
    ? 1
    : isSvg && selectedModel?.id.startsWith("recraft:")
      ? 6
      : 8;
  const canGenerate =
    isReady &&
    (hasPrompt || isSvgVectorization) &&
    selectedModel !== null &&
    plan.model?.id === selectedModel.id &&
    settings.outputCount <= maxOutputCount &&
    settings.referenceImages.length <= maxReferenceCount &&
    (!isSvgVectorization || settings.referenceImages.length === 1) &&
    (!hasReferences || referenceSupported) &&
    !generationPending;
  const visibleDiagnostics = plan.diagnostics.filter(
    (diagnostic) =>
      diagnostic.severity !== "info" &&
      !HIDDEN_GENERATE_DIAGNOSTIC_CODES.has(diagnostic.code),
  );

  const updateSettings = <K extends keyof ImageRecipeSettings>(
    key: K,
    value: ImageRecipeSettings[K],
  ): void => {
    onChange({ ...settings, [key]: value });
  };

  const promptHistoryNavigation = usePromptHistoryNavigation({
    value: settings.prompt,
    history: promptHistory,
    onValueChange: (value) => updateSettings("prompt", value),
  });

  const updateModelAddon = (
    addonId: string,
    update: (selection: ImageRecipeSettings["modelAddons"][number]) =>
      ImageRecipeSettings["modelAddons"][number],
  ): void => {
    updateSettings(
      "modelAddons",
      settings.modelAddons.map((selection) =>
        selection.addonId === addonId ? update(selection) : selection,
      ),
    );
  };

  const toggleModelAddon = (
    row: (typeof addOnRows)[number],
  ): void => {
    if (row.selection) {
      updateModelAddon(row.addon.id, (selection) => ({
        ...selection,
        enabled: !selection.enabled,
      }));
      return;
    }
    updateSettings("modelAddons", [
      ...settings.modelAddons,
      row.addon.kind === "lora"
        ? {
            kind: "lora",
            addonId: row.addon.id,
            enabled: true,
            modelStrength: 1,
            textEncoderStrength: null,
            denoisingSchedule: null,
          }
        : {
            kind: "textual-inversion",
            addonId: row.addon.id,
            enabled: true,
            token: row.addon.defaultToken ?? `<${row.addon.displayName.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/(^-|-$)/g, "")}>`,
            placement: "positive",
          },
    ]);
  };

  const moveModelAddon = (addonId: string, offset: -1 | 1): void => {
    const currentIndex = settings.modelAddons.findIndex(
      (selection) => selection.addonId === addonId,
    );
    const targetIndex = currentIndex + offset;
    if (
      currentIndex < 0 ||
      targetIndex < 0 ||
      targetIndex >= settings.modelAddons.length
    ) {
      return;
    }
    const next = [...settings.modelAddons];
    [next[currentIndex], next[targetIndex]] = [next[targetIndex]!, next[currentIndex]!];
    updateSettings("modelAddons", next);
  };

  const generate = (): void => {
    if (canGenerate) {
      onGenerate();
    }
  };

  const generateLabel = isSvgVectorization
    ? "Vectorize image"
    : settings.outputCount === 1
      ? isSvg ? "Generate SVG" : "Generate image"
      : `Generate ${settings.outputCount} ${isSvg ? "SVGs" : "images"}`;

  useEffect(() => {
    const selectedModelIsAvailable = availableImageModels.some(
      (model) => model.id === settings.modelId,
    );
    const fallbackModel = availableImageModels[0] ?? null;
    const shouldNormalizeModel = !selectedModelIsAvailable && fallbackModel !== null;
    const resolvedModel = shouldNormalizeModel ? fallbackModel : selectedModel;
    const resolvedMaxOutputCount = isSvgVectorization
      ? 1
      : isSvg && resolvedModel?.id.startsWith("recraft:")
        ? 6
        : 8;
    const resolvedMaxCandidateCount = isSvgVectorization
      ? 1
      : isSvg && resolvedModel?.id.startsWith("recraft:")
        ? 6
        : 16;
    const shouldNormalizeOutputCount =
      (isSvgVectorization && settings.outputCount !== resolvedMaxOutputCount) ||
      settings.outputCount > resolvedMaxOutputCount;
    const shouldNormalizeReferences =
      isSvgVectorization && settings.referenceImages.length > 1;

    if (
      !shouldNormalizeModel &&
      !shouldNormalizeOutputCount &&
      !shouldNormalizeReferences &&
      !settings.qualityGateEnabled
    ) {
      return;
    }

    onChange({
      ...settings,
      ...(shouldNormalizeModel
        ? {
            providerPolicy: fallbackModel.target,
            modelId: fallbackModel.id,
          }
        : {}),
      qualityGateEnabled: false,
      outputCount: Math.min(settings.outputCount, resolvedMaxOutputCount),
      referenceImages: shouldNormalizeReferences
        ? settings.referenceImages.slice(0, 1).map((reference) => ({
            ...reference,
            role: "base" as const,
          }))
        : settings.referenceImages,
      ...(isSvg
        ? {
            svgCandidateCount: Math.max(
              Math.min(settings.svgCandidateCount ?? 6, resolvedMaxCandidateCount),
              Math.min(settings.outputCount, resolvedMaxOutputCount),
            ),
          }
        : {}),
    });
  }, [
    availableImageModels,
    isSvg,
    isSvgVectorization,
    onChange,
    selectedModel,
    settings,
  ]);

  const removeReference = (index: number): void => {
    const referenceImages = settings.referenceImages
      .filter((_, candidateIndex) => candidateIndex !== index)
      .map((reference, candidateIndex) => ({
        ...reference,
        role:
          candidateIndex === 0
            ? "base" as const
            : reference.role === "base"
              ? "subject" as const
              : reference.role,
      }));
    updateSettings("referenceImages", referenceImages);
  };

  const addLibraryReference = (assetId: string): void => {
    if (settings.referenceImages.length >= maxReferenceCount) return;
    updateSettings("referenceImages", [
      ...settings.referenceImages,
      {
        assetId,
        role: settings.referenceImages.length === 0 ? "base" : "subject",
        influence: 1,
      },
    ]);
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl space-y-6 px-5 py-7 sm:px-8 lg:px-10 lg:py-9">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
            Create {isSvg ? "SVG" : "image"}
          </h1>
          <div className="flex rounded-xl border border-slate-800 bg-slate-950/70 p-1" aria-label="Asset type">
            {(["image", "svg"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                aria-pressed={(kind === "svg") === isSvg}
                onClick={() => onChange({
                  ...settings,
                  outputFormat: kind === "svg" ? "svg" : "png",
                  modelId: null,
                  referenceImages: settings.referenceImages,
                  qualityGateEnabled: false,
                })}
                className={cn(
                  "rounded-lg px-4 py-1.5 text-xs font-semibold capitalize transition-colors",
                  (kind === "svg") === isSvg
                    ? "bg-sky-400 text-slate-950"
                    : "text-slate-500 hover:text-slate-200",
                )}
              >
                {kind}
              </button>
            ))}
          </div>
        </header>

        {isSvg ? (
          <SegmentedControl
            label="SVG workflow"
            value={settings.svgMode ?? "generate"}
            options={[
              { value: "generate", label: "Create from prompt" },
              { value: "vectorize", label: "Vectorize image" },
            ]}
            onChange={(value) => {
              const mode = value as NonNullable<ImageRecipeSettings["svgMode"]>;
              onChange({
                ...settings,
                svgMode: mode,
                modelId: null,
                outputCount: mode === "vectorize" ? 1 : settings.outputCount,
                svgCandidateCount:
                  mode === "vectorize" ? 1 : Math.max(1, settings.svgCandidateCount ?? 6),
                svgCriticEnabled:
                  mode === "vectorize" ? false : settings.svgCriticEnabled,
                referenceImages:
                  mode === "vectorize"
                    ? settings.referenceImages.slice(0, 1).map((reference) => ({
                        ...reference,
                        role: "base" as const,
                      }))
                    : settings.referenceImages,
              });
            }}
          />
        ) : null}

        {!isSvgVectorization ? (
        <section aria-labelledby="media-prompt-heading">
          <label
            id="media-prompt-heading"
            htmlFor="media-image-prompt"
            className="sr-only"
          >
            Describe your image
          </label>
          <div className="relative">
            {settings.prompt.length >= 7_000 ? (
              <span className="absolute right-3 bottom-2 z-10 text-[10px] text-slate-600">
                {settings.prompt.length.toLocaleString()} / 8,000
              </span>
            ) : null}
            <div className="rounded-xl border border-slate-800 bg-slate-900/35 p-1 focus-within:border-sky-500/40 focus-within:ring-1 focus-within:ring-sky-500/20">
              <Textarea
                id="media-image-prompt"
                value={settings.prompt}
                maxLength={8_000}
                rows={4}
                placeholder="Describe the image you want to create…"
                onChange={(event) =>
                  promptHistoryNavigation.handleValueChange(event.target.value)
                }
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                    event.preventDefault();
                    generate();
                    return;
                  }

                  promptHistoryNavigation.handleKeyDown(event);
                }}
                className="min-h-28 resize-none border-0 bg-transparent px-4 py-3 text-base leading-7 text-slate-100 shadow-none placeholder:text-slate-600 focus-visible:ring-0"
              />
            </div>
          </div>
        </section>
        ) : (
          <div className="rounded-xl border border-sky-400/15 bg-sky-400/5 px-4 py-3 text-xs leading-5 text-sky-100/75">
            Choose one source below. Its visible geometry is converted to editable SVG paths, then validated and rendered locally before publication.
          </div>
        )}

        {hasReferences || canAddReferences ? (
          <section
            aria-labelledby="media-reference-images-heading"
            className="rounded-2xl border border-slate-800/80 bg-gradient-to-br from-slate-900/65 to-slate-950/35 p-4 shadow-[0_12px_36px_rgba(2,6,23,0.12)]"
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3.5">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-sky-400/15 bg-sky-400/8 text-sky-300">
                  <ImagePlus className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <h2
                    id="media-reference-images-heading"
                    className="text-sm font-semibold text-slate-100"
                  >
                    Reference images
                    <span className="ml-2 font-normal text-slate-500">
                      {isSvgVectorization ? "Required" : "Optional"}
                    </span>
                  </h2>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    {isSvgVectorization
                      ? "Choose exactly one raster image or existing SVG. Existing vectors are securely rendered before provider upload."
                      : isSvg
                      ? "Guide vector geometry, style, colors, or composition. References are reconstructed as editable SVG—not embedded as pixels."
                      : "Guide the subject, style, colors, or composition. The first image becomes the base."}
                  </p>
                </div>
              </div>
              {referenceSupported &&
              (referenceImportSupported || selectableReferenceAssets.length > 0) ? (
                <div className="flex shrink-0 items-center gap-2.5 self-end sm:self-auto">
                  <span className="rounded-full border border-slate-800 bg-slate-950/60 px-2.5 py-1 text-[10px] font-medium tabular-nums text-slate-500">
                    {settings.referenceImages.length} / {maxReferenceCount}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    aria-expanded={referencePickerOpen}
                    disabled={
                      referenceImportPending ||
                      settings.referenceImages.length >= maxReferenceCount
                    }
                    onClick={() => setReferencePickerOpen((current) => !current)}
                    className="rounded-xl border-sky-400/25 bg-sky-400/8 text-sky-100 shadow-sm hover:border-sky-300/35 hover:bg-sky-400/15 hover:text-white"
                  >
                    {referenceImportPending ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <ImagePlus />
                    )}
                    {referenceImportPending ? "Adding…" : "Add images"}
                  </Button>
                </div>
              ) : null}
            </div>

            {referencePickerOpen && canAddReferences ? (
              <div className="mt-4 rounded-xl border border-slate-800/80 bg-slate-950/65 p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
                    <Images className="h-4 w-4 text-sky-300" /> Choose from Library
                  </div>
                  {referenceImportSupported ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={referenceImportPending}
                      onClick={onAddReferenceImages}
                      className="border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800"
                    >
                      {referenceImportPending ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        <Upload />
                      )}
                      Upload images
                    </Button>
                  ) : null}
                </div>
                {selectableReferenceAssets.length > 0 ? (
                  <div className="mt-3 grid max-h-80 grid-cols-2 gap-3 overflow-y-auto pr-1 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                    {selectableReferenceAssets.map((asset) => (
                      <ReferenceLibraryAssetButton
                        key={asset.id}
                        asset={asset}
                        onSelect={() => addLibraryReference(asset.id)}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 rounded-lg border border-dashed border-slate-800 px-3 py-4 text-center text-xs text-slate-600">
                    No unused Library images are available.
                  </p>
                )}
              </div>
            ) : null}

            {settings.referenceImages.length > 0 ? (
              <div className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-800/70 pt-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                {settings.referenceImages.map((reference, index) => (
                  <ReferenceImageCard
                    key={reference.assetId}
                    reference={reference}
                    asset={assetsById.get(reference.assetId) ?? null}
                    index={index}
                    onRoleChange={(role) =>
                      updateSettings(
                        "referenceImages",
                        settings.referenceImages.map((candidate, candidateIndex) =>
                          candidateIndex === index ? { ...candidate, role } : candidate,
                        ),
                      )
                    }
                    onRemove={() => removeReference(index)}
                  />
                ))}
              </div>
            ) : null}

            {hasReferences && !referenceSupported ? (
              <p className="mt-3 border-t border-amber-300/10 pt-3 text-xs text-amber-200/75">
                This model cannot use the selected references.
              </p>
            ) : hasReferences ? (
              <p className="mt-3 border-t border-slate-800/70 pt-3 text-xs leading-5 text-slate-500">
                {runtimeMode === "browser-preview"
                  ? "Browser preview: no reference pixels are uploaded."
                  : selectedModel?.target === "remote"
                    ? `On Generate, metadata-stripped copies of these images are sent to ${selectedProviderName}.`
                    : "References stay on this device and are passed to the selected local model runtime."}
              </p>
            ) : null}
          </section>
        ) : null}

        <section
          aria-labelledby="media-basic-options-heading"
          className="border-t border-slate-800/70 pt-6"
        >
          <div className="mb-5 flex items-end gap-2">
            <label htmlFor="media-image-model" className="min-w-0 flex-1 space-y-2">
              <span className="block text-[11px] font-semibold text-slate-400">
                Model / provider
              </span>
              <select
                id="media-image-model"
                value={selectedModel?.id ?? ""}
                disabled={availableImageModels.length === 0}
                onChange={(event) => {
                  const model = availableImageModels.find(
                    (candidate) => candidate.id === event.target.value,
                  );
                  if (!model) return;
                  onChange({
                    ...settings,
                    providerPolicy: model.target,
                    modelId: model.id,
                  });
                }}
                className="h-[46px] w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 text-sm text-slate-200 outline-none focus:border-sky-400/40 focus:ring-2 focus:ring-sky-400/15"
              >
                {selectedModel === null ? (
                  <option value="" disabled>
                    No available image models
                  </option>
                ) : null}
                {availableImageModels.map((model) => {
                  const providerName =
                    providersById.get(model.providerId) ?? model.providerId;
                  return (
                    <option key={model.id} value={model.id}>
                      {model.displayName} · {providerName}
                    </option>
                  );
                })}
              </select>
            </label>
          </div>

          {!isSvg ? (
            <div className="mb-5 rounded-xl border border-slate-800 bg-slate-950/35 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                    <Sparkles className="h-3.5 w-3.5 text-cyan-300" /> Looks &amp; concepts
                  </h2>
                  <p className="mt-1 text-[10px] leading-4 text-slate-500">
                    Optional LoRAs and embeddings. Compatibility follows the selected provider and model.
                  </p>
                </div>
                <Button type="button" variant="ghost" size="xs" onClick={onOpenModels} className="text-cyan-300 hover:bg-cyan-950/30">
                  Manage library
                </Button>
              </div>

              {selectedModel?.addonCapabilities.length === 0 ? (
                <div className="mt-3 rounded-lg border border-slate-800 bg-slate-900/35 px-3 py-2.5 text-[11px] leading-5 text-slate-500">
                  {selectedModel?.providerId === "openai"
                    ? "OpenAI image generation does not accept LoRA weights or textual-inversion tokens. Choose a compatible local SD or FLUX model to use them."
                    : "This model does not advertise LoRA or textual-inversion support."}
                  {selectedModel?.target === "remote" && !selectedModel.configured ? (
                    <button type="button" onClick={onOpenProviderSettings} className="ml-1 text-sky-300 underline decoration-sky-400/30 underline-offset-2">Configure provider</button>
                  ) : null}
                </div>
              ) : addOnRows.length === 0 ? (
                <button type="button" onClick={onOpenModels} className="mt-3 w-full rounded-lg border border-dashed border-slate-800 px-3 py-4 text-center text-[11px] text-slate-600 hover:border-cyan-400/25 hover:text-cyan-300">
                  Import a LoRA or embedding in Models
                </button>
              ) : (
                <div className="mt-3 grid gap-2 md:grid-cols-2">
                  {addOnRows.map((row) => {
                    const active = row.selection?.enabled === true;
                    const incompatible = row.compatibility?.status === "incompatible";
                    return (
                      <div key={row.addon.id} className={cn("rounded-lg border p-3", active ? "border-cyan-400/25 bg-cyan-950/10" : "border-slate-800 bg-slate-900/25")}>
                        <div className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            checked={active}
                            disabled={incompatible && !active}
                            aria-label={`Use ${row.addon.displayName}`}
                            onChange={() => toggleModelAddon(row)}
                            className="mt-0.5 h-4 w-4 accent-cyan-400"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate text-[11px] font-semibold text-slate-200">{row.addon.displayName}</span>
                              <div className="flex shrink-0 items-center gap-1">
                                {row.stackPosition !== null ? (
                                  <span className="text-[8px] font-semibold uppercase text-cyan-400/70">
                                    Stack {row.stackPosition}
                                  </span>
                                ) : null}
                                {row.selection ? (
                                  <>
                                    <button
                                      type="button"
                                      aria-label={`Move ${row.addon.displayName} up`}
                                      disabled={row.selectionIndex <= 0}
                                      onClick={() => moveModelAddon(row.addon.id, -1)}
                                      className="rounded p-0.5 text-slate-500 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-25"
                                    >
                                      <ArrowUp className="h-3 w-3" />
                                    </button>
                                    <button
                                      type="button"
                                      aria-label={`Move ${row.addon.displayName} down`}
                                      disabled={row.selectionIndex >= settings.modelAddons.length - 1}
                                      onClick={() => moveModelAddon(row.addon.id, 1)}
                                      className="rounded p-0.5 text-slate-500 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-25"
                                    >
                                      <ArrowDown className="h-3 w-3" />
                                    </button>
                                  </>
                                ) : null}
                                <span className="text-[8px] font-semibold uppercase text-slate-600">{row.addon.kind === "lora" ? "LoRA" : "Embedding"}</span>
                              </div>
                            </div>
                            <p className={cn("mt-1 text-[9px] leading-4", incompatible ? "text-amber-300/70" : row.compatibility?.status === "unverified" ? "text-amber-200/60" : "text-slate-600")}>
                              {row.compatibility?.reason ?? "Choose a model to check compatibility."}
                            </p>
                          </div>
                        </div>

                        {active && row.selection?.kind === "lora" ? (
                          <details className="mt-3 border-t border-slate-800/70 pt-2">
                            <summary className="cursor-pointer text-[9px] text-slate-500">Strength · {row.selection.modelStrength.toFixed(2)}</summary>
                            <div className="mt-2 grid grid-cols-[1fr_72px] items-center gap-2">
                              <input type="range" min={-2} max={2} step={0.05} value={Math.max(-2, Math.min(2, row.selection.modelStrength))} onChange={(event) => updateModelAddon(row.addon.id, (selection) => selection.kind === "lora" ? { ...selection, modelStrength: event.target.valueAsNumber } : selection)} className="accent-cyan-400" />
                              <input type="number" min={-100} max={100} step={0.05} value={row.selection.modelStrength} aria-label={`${row.addon.displayName} model strength`} onChange={(event) => Number.isFinite(event.target.valueAsNumber) && updateModelAddon(row.addon.id, (selection) => selection.kind === "lora" ? { ...selection, modelStrength: Math.max(-100, Math.min(100, event.target.valueAsNumber)) } : selection)} className="h-8 rounded border border-slate-800 bg-slate-950 px-2 text-[10px] text-slate-300" />
                            </div>
                            {selectedModel?.addonCapabilities.find((capability) => capability.kind === "lora")?.supportsSeparateComponentStrengths && row.addon.targetComponents.some((component) => component === "text-encoder" || component === "text-encoder-2") ? (
                              <div className="mt-2 border-t border-slate-800/60 pt-2">
                                <label className="flex items-center gap-2 text-[9px] text-slate-500">
                                  <input type="checkbox" checked={row.selection.textEncoderStrength !== null} onChange={(event) => updateModelAddon(row.addon.id, (selection) => selection.kind === "lora" ? { ...selection, textEncoderStrength: event.target.checked ? selection.modelStrength : null } : selection)} className="accent-cyan-400" />
                                  Separate text-encoder strength
                                </label>
                                {row.selection.textEncoderStrength !== null ? (
                                  <input type="number" min={-100} max={100} step={0.05} value={row.selection.textEncoderStrength} aria-label={`${row.addon.displayName} text encoder strength`} onChange={(event) => Number.isFinite(event.target.valueAsNumber) && updateModelAddon(row.addon.id, (selection) => selection.kind === "lora" ? { ...selection, textEncoderStrength: Math.max(-100, Math.min(100, event.target.valueAsNumber)) } : selection)} className="mt-2 h-8 w-full rounded border border-slate-800 bg-slate-950 px-2 text-[10px] text-slate-300" />
                                ) : null}
                              </div>
                            ) : null}
                            {selectedModel?.addonCapabilities.find((capability) => capability.kind === "lora")?.supportsDenoisingSchedules && row.addon.targetComponents.length === 1 && row.addon.targetComponents[0] === "denoiser" ? (
                              <div className="mt-2 border-t border-slate-800/60 pt-2">
                                <label className="flex items-center gap-2 text-[9px] text-slate-500">
                                  <input type="checkbox" checked={row.selection.denoisingSchedule !== null} onChange={(event) => updateModelAddon(row.addon.id, (selection) => selection.kind === "lora" ? { ...selection, denoisingSchedule: event.target.checked ? { start: 0, end: 1 } : null } : selection)} className="accent-cyan-400" />
                                  Limit to part of denoising
                                </label>
                                {row.selection.denoisingSchedule !== null ? (
                                  <div className="mt-2 grid grid-cols-2 gap-2">
                                    <label className="text-[8px] uppercase tracking-wide text-slate-600">
                                      Start %
                                      <input type="number" min={0} max={Math.round((row.selection.denoisingSchedule.end - 0.01) * 100)} step={1} value={Math.round(row.selection.denoisingSchedule.start * 100)} aria-label={`${row.addon.displayName} denoising start percent`} onChange={(event) => Number.isFinite(event.target.valueAsNumber) && updateModelAddon(row.addon.id, (selection) => selection.kind === "lora" && selection.denoisingSchedule !== null ? { ...selection, denoisingSchedule: { ...selection.denoisingSchedule, start: Math.min(selection.denoisingSchedule.end - 0.01, Math.max(0, event.target.valueAsNumber / 100)) } } : selection)} className="mt-1 h-8 w-full rounded border border-slate-800 bg-slate-950 px-2 text-[10px] text-slate-300" />
                                    </label>
                                    <label className="text-[8px] uppercase tracking-wide text-slate-600">
                                      End %
                                      <input type="number" min={Math.round((row.selection.denoisingSchedule.start + 0.01) * 100)} max={100} step={1} value={Math.round(row.selection.denoisingSchedule.end * 100)} aria-label={`${row.addon.displayName} denoising end percent`} onChange={(event) => Number.isFinite(event.target.valueAsNumber) && updateModelAddon(row.addon.id, (selection) => selection.kind === "lora" && selection.denoisingSchedule !== null ? { ...selection, denoisingSchedule: { ...selection.denoisingSchedule, end: Math.max(selection.denoisingSchedule.start + 0.01, Math.min(1, event.target.valueAsNumber / 100)) } } : selection)} className="mt-1 h-8 w-full rounded border border-slate-800 bg-slate-950 px-2 text-[10px] text-slate-300" />
                                    </label>
                                  </div>
                                ) : null}
                              </div>
                            ) : row.addon.targetComponents.some((component) => component === "text-encoder" || component === "text-encoder-2") ? (
                              <p className="mt-2 border-t border-slate-800/60 pt-2 text-[9px] leading-4 text-slate-600">
                                Denoising windows require denoiser-only weights; text-encoder conditioning is resolved before denoising begins.
                              </p>
                            ) : null}
                            {row.addon.triggerWords.length > 0 ? (
                              <button type="button" onClick={() => updateSettings("prompt", [settings.prompt.trim(), ...row.addon.triggerWords].filter(Boolean).join(", "))} className="mt-2 text-left font-mono text-[9px] text-cyan-300/70 hover:text-cyan-200">
                                Add trigger: {row.addon.triggerWords.join(", ")}
                              </button>
                            ) : null}
                          </details>
                        ) : null}

                        {active && row.selection?.kind === "textual-inversion" ? (
                          <div className="mt-3 grid grid-cols-[1fr_110px] gap-2 border-t border-slate-800/70 pt-2">
                            <input value={row.selection.token} maxLength={128} aria-label={`${row.addon.displayName} token`} onChange={(event) => updateModelAddon(row.addon.id, (selection) => selection.kind === "textual-inversion" ? { ...selection, token: event.target.value } : selection)} className="h-8 min-w-0 rounded border border-slate-800 bg-slate-950 px-2 font-mono text-[10px] text-slate-300" />
                            <select value={row.selection.placement} aria-label={`${row.addon.displayName} prompt placement`} onChange={(event) => updateModelAddon(row.addon.id, (selection) => selection.kind === "textual-inversion" ? { ...selection, placement: event.target.value as "positive" | "negative" | "both" } : selection)} className="h-8 rounded border border-slate-800 bg-slate-950 px-2 text-[10px] text-slate-300">
                              <option value="positive">Positive</option>
                              <option value="negative" disabled={selectedModel?.architecture === "flux-1"}>Negative</option>
                              <option value="both" disabled={selectedModel?.architecture === "flux-1"}>Both</option>
                            </select>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}

          <div className="grid items-end gap-5 md:grid-cols-[minmax(0,1fr)_180px_auto]">
            {isSvgVectorization ? (
              <div className="flex h-[46px] items-center rounded-xl border border-slate-800/80 bg-slate-950/70 px-3 text-xs text-slate-400">
                Source proportions and canvas geometry are preserved.
              </div>
            ) : (
            <fieldset className="space-y-2">
              <legend
                id="media-basic-options-heading"
                className="text-[11px] font-semibold text-slate-400"
              >
                Shape
              </legend>
              <div className="grid grid-cols-4 gap-1 rounded-xl border border-slate-800/80 bg-slate-950/70 p-1">
                {(["1:1", "4:5", "16:9", "9:16"] as const).map((aspect) => (
                  <button
                    key={aspect}
                    type="button"
                    aria-pressed={settings.aspectRatio === aspect}
                    onClick={() => updateSettings("aspectRatio", aspect)}
                    className={cn(
                      "rounded-lg py-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60",
                      settings.aspectRatio === aspect
                        ? "bg-slate-800 text-slate-100"
                        : "text-slate-500 hover:text-slate-300",
                    )}
                  >
                    {aspect}
                  </button>
                ))}
              </div>
            </fieldset>
            )}

            {isSvgVectorization ? (
              <div className="space-y-2">
                <span className="block text-[11px] font-semibold text-slate-400">Outputs</span>
                <div className="flex h-[46px] items-center justify-center rounded-xl border border-slate-800/80 bg-slate-950/70 text-sm font-semibold text-slate-200">
                  1 verified SVG
                </div>
              </div>
            ) : (
            <div className="space-y-2">
              <span className="block text-[11px] font-semibold text-slate-400">
                Number of {isSvg ? "SVGs" : "images"}
              </span>
              <div className="flex h-[46px] items-center justify-between rounded-xl border border-slate-800/80 bg-slate-950/70 px-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Generate fewer ${isSvg ? "SVGs" : "images"}`}
                  disabled={settings.outputCount <= 1}
                  onClick={() =>
                    updateSettings("outputCount", settings.outputCount - 1)
                  }
                  className="rounded-lg text-slate-500 hover:bg-slate-800 hover:text-slate-200"
                >
                  <Minus />
                </Button>
                <span className="text-sm font-semibold tabular-nums text-slate-200">
                  {settings.outputCount}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Generate more ${isSvg ? "SVGs" : "images"}`}
                  disabled={settings.outputCount >= maxOutputCount}
                  onClick={() =>
                    updateSettings("outputCount", settings.outputCount + 1)
                  }
                  className="rounded-lg text-slate-500 hover:bg-slate-800 hover:text-slate-200"
                >
                  <Plus />
                </Button>
              </div>
            </div>
            )}

            <div className="flex flex-col gap-2">
              <Button
                type="button"
                size="lg"
                disabled={!canGenerate}
                onClick={generate}
                className="h-[46px] min-w-52 rounded-xl bg-sky-400 px-6 text-slate-950 shadow-[0_10px_30px_rgba(56,189,248,0.15)] hover:bg-sky-300"
              >
                {generationPending ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Sparkles />
                )}
                {generationPending
                  ? isSvgVectorization
                    ? "Vectorizing…"
                    : "Generating…"
                  : generateLabel}
              </Button>
              {onGenerateWithReview ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={!canGenerate || settings.outputCount < 2 || hasReferences}
                  title={
                    hasReferences
                      ? "Generate & choose currently supports prompt-only variant sets"
                      : settings.outputCount < 2
                        ? "Choose at least two images to compare candidates"
                        : "Generate candidates, pause durably, then approve one in Runs"
                  }
                  onClick={onGenerateWithReview}
                  className="min-w-52 rounded-xl border-fuchsia-400/25 bg-fuchsia-400/5 text-fuchsia-100 hover:bg-fuchsia-400/10"
                >
                  <ListChecks /> Generate & choose
                </Button>
              ) : null}
            </div>
          </div>
        </section>

        {visibleDiagnostics.length > 0 || persistenceError ? (
          <section aria-labelledby="media-generation-help-heading" className="space-y-2">
            <h2 id="media-generation-help-heading" className="sr-only">
              Generation help
            </h2>
            {visibleDiagnostics.map((diagnostic, index) => {
              const presentation = DIAGNOSTIC_STYLES[diagnostic.severity];
              const Icon = presentation.icon;
              return (
                <div
                  key={diagnostic.code + "-" + index}
                  className={cn(
                    "rounded-xl border p-3 text-xs leading-5",
                    presentation.className,
                  )}
                >
                  <div className="flex items-start gap-2">
                    <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                    <div>
                      <p>
                        {simpleDiagnosticMessage(
                          diagnostic.code,
                          diagnostic.message,
                        )}
                      </p>
                      {diagnostic.action ? (
                        <p className="mt-0.5 opacity-65">{diagnostic.action}</p>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
            {persistenceError ? (
              <div className="rounded-xl border border-rose-500/20 bg-rose-500/8 p-3 text-xs text-rose-200">
                {persistenceError}
              </div>
            ) : null}
          </section>
        ) : null}

        <details className="group border-t border-slate-800/70">
          <summary className="flex cursor-pointer list-none items-center gap-2 py-4 text-sm font-medium text-slate-400 outline-none hover:text-slate-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400/60">
            <SlidersHorizontal className="h-4 w-4 text-slate-500" />
            More options
            <ChevronDown className="ml-auto h-4 w-4 text-slate-600 transition-transform group-open:rotate-180" />
          </summary>
          <div className="pb-1 pt-3">
            <div className="grid gap-5 md:grid-cols-3">
              <SegmentedControl
                label="Prioritize"
                value={settings.modelPolicy}
                options={[
                  { value: "balanced", label: "Balanced" },
                  { value: "fast", label: "Speed" },
                  { value: "quality", label: "Quality" },
                ]}
                onChange={(value) => updateSettings("modelPolicy", value)}
              />
              <label className="space-y-2">
                <span className="block text-[11px] font-semibold text-slate-400">
                  File format
                </span>
                <select
                  value={settings.outputFormat}
                  onChange={(event) =>
                    updateSettings(
                      "outputFormat",
                      event.target.value as ImageRecipeSettings["outputFormat"],
                    )
                  }
                  className="h-[42px] w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 text-xs text-slate-300 outline-none focus:border-sky-400/40 focus:ring-2 focus:ring-sky-400/15"
                >
                  <option value="png">PNG · lossless</option>
                  <option value="webp">WebP · smaller files</option>
                  <option value="jpeg" disabled={settings.transparentBackground}>
                    JPEG · photographs
                  </option>
                  <option value="svg">SVG · editable vector</option>
                </select>
              </label>
              <label className="space-y-2">
                <span className="block text-[11px] font-semibold text-slate-400">
                  Background
                </span>
                <span
                  className={cn(
                    "flex h-[42px] items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/70 px-3 text-xs",
                    isSvgVectorization
                      ? "cursor-not-allowed text-slate-600"
                      : "cursor-pointer text-slate-300",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={isSvgVectorization ? false : settings.transparentBackground}
                    disabled={isSvgVectorization}
                    onChange={(event) =>
                      onChange({
                        ...settings,
                        transparentBackground: event.target.checked,
                        outputFormat:
                          event.target.checked && settings.outputFormat === "jpeg"
                            ? "png"
                            : settings.outputFormat,
                      })
                    }
                    className="h-4 w-4 rounded border-slate-700 bg-slate-900 accent-sky-400"
                  />
                  {isSvgVectorization
                    ? "Preserve source background"
                    : "Transparent background"}
                </span>
              </label>
            </div>
            {isSvgVectorization ? (
              <div className="mt-5 grid gap-5 border-t border-slate-800/70 pt-5 md:grid-cols-2">
                {selectedModel?.id.startsWith("recraft:") ? (
                  <div className="rounded-xl border border-slate-800 bg-slate-950/55 px-4 py-3 text-xs leading-5 text-slate-400 md:col-span-2">
                    Recraft analyzes the prepared source at its uploaded dimensions. Auto-crop and target-size controls are available with Quiver and compatible local runtimes.
                  </div>
                ) : (
                <>
                <label className="space-y-2">
                  <span className="block text-[11px] font-semibold text-slate-400">Analysis size</span>
                  <select
                    value={settings.svgTargetSize ?? 1024}
                    onChange={(event) =>
                      updateSettings("svgTargetSize", Number(event.target.value))
                    }
                    className="h-[42px] w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 text-xs text-slate-300 outline-none focus:border-sky-400/40"
                  >
                    <option value={512}>512 px · fast</option>
                    <option value={1024}>1024 px · balanced</option>
                    <option value={2048}>2048 px · detailed</option>
                    <option value={4096}>4096 px · maximum</option>
                  </select>
                </label>
                <label className="space-y-2">
                  <span className="block text-[11px] font-semibold text-slate-400">Subject framing</span>
                  <span className="flex h-[42px] cursor-pointer items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/70 px-3 text-xs text-slate-300">
                    <input
                      type="checkbox"
                      checked={settings.svgAutoCrop !== false}
                      onChange={(event) => updateSettings("svgAutoCrop", event.target.checked)}
                      className="h-4 w-4 rounded border-slate-700 bg-slate-900 accent-sky-400"
                    />
                    Auto-crop dominant subject
                  </span>
                </label>
                </>
                )}
              </div>
            ) : isSvg ? (
              <div className="mt-5 grid gap-5 border-t border-slate-800/70 pt-5 md:grid-cols-4">
                <label className="space-y-2">
                  <span className="block text-[11px] font-semibold text-slate-400">Design lane</span>
                  <select
                    value={settings.svgStyle ?? "illustration"}
                    onChange={(event) => updateSettings(
                      "svgStyle",
                      event.target.value as NonNullable<ImageRecipeSettings["svgStyle"]>,
                    )}
                    className="h-[42px] w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 text-xs text-slate-300 outline-none focus:border-sky-400/40"
                  >
                    <option value="illustration">Illustration</option>
                    <option value="icon">Icon</option>
                    <option value="logo">Logo</option>
                    <option value="diagram">Diagram</option>
                    <option value="technical">Technical figure</option>
                  </select>
                </label>
                <label className="space-y-2">
                  <span className="block text-[11px] font-semibold text-slate-400">Text policy</span>
                  <select
                    value={settings.svgTextPolicy ?? "avoid"}
                    onChange={(event) => updateSettings(
                      "svgTextPolicy",
                      event.target.value as NonNullable<ImageRecipeSettings["svgTextPolicy"]>,
                    )}
                    className="h-[42px] w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 text-xs text-slate-300 outline-none focus:border-sky-400/40"
                  >
                    <option value="avoid">Avoid</option>
                    <option value="editable">Keep editable</option>
                    <option value="outlines">Convert to outlines</option>
                  </select>
                </label>
                <label className="space-y-2">
                  <span className="block text-[11px] font-semibold text-slate-400">Candidate pool</span>
                  <input
                    type="number"
                    min={settings.outputCount}
                    max={selectedModel?.id.startsWith("recraft:") ? 6 : 16}
                    value={Math.max(settings.outputCount, settings.svgCandidateCount ?? 6)}
                    onChange={(event) => {
                      const value = event.target.valueAsNumber;
                      if (Number.isFinite(value)) {
                        updateSettings(
                          "svgCandidateCount",
                          Math.max(settings.outputCount, Math.round(value)),
                        );
                      }
                    }}
                    className="h-[42px] w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 text-xs text-slate-300 outline-none focus:border-sky-400/40"
                  />
                </label>
                <label className="space-y-2">
                  <span className="block text-[11px] font-semibold text-slate-400">Quality loop</span>
                  <span className={cn(
                    "flex h-[42px] items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/70 px-3 text-xs",
                    svgCriticAvailable || settings.svgCriticEnabled === true
                      ? "cursor-pointer text-slate-300"
                      : "cursor-not-allowed text-slate-600",
                  )}>
                    <input
                      type="checkbox"
                      checked={settings.svgCriticEnabled === true}
                      disabled={!svgCriticAvailable && settings.svgCriticEnabled !== true}
                      onChange={(event) => updateSettings("svgCriticEnabled", event.target.checked)}
                      className="h-4 w-4 rounded border-slate-700 bg-slate-900 accent-sky-400"
                    />
                    OpenAI render-and-verify
                  </span>
                  <span className="block text-[10px] leading-4 text-slate-500">
                    Opt-in. Only shortlisted weak candidates are sent. Each repair can use two paid, audited OpenAI requests: one proposal and one independent before/after visual check.
                  </span>
                </label>
              </div>
            ) : null}
            <p className="mt-4 text-[11px] leading-5 text-slate-500">
              {plan.preflight.privacySummary}
            </p>
          </div>
        </details>

        {generatedRun ? (
          <GeneratedImages
            run={generatedRun}
            aspectRatio={settings.aspectRatio}
            onOpenRunReview={onOpenRunReview}
          />
        ) : null}

        <div className="flex justify-center border-t border-slate-800/70 pt-4">
          <Button
            type="button"
            variant="ghost"
            onClick={onOpenFlow}
            className="rounded-xl text-slate-500 hover:bg-slate-900 hover:text-slate-200"
          >
            <Workflow /> Open in Flow
          </Button>
        </div>
      </div>
    </div>
  );
};
