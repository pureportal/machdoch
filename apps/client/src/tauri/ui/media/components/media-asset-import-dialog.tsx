import { getCurrentWindow, type DragDropEvent } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Check, Import, LoaderCircle, Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import {
  inferMediaAssetImportType,
  listCompatibleMediaAssetImportTypes,
  type MediaAssetImportProgress,
  type MediaAssetImportType,
} from "../../../../core/media/asset-import.js";
import {
  createEmptyMediaGenerationAssetMetadata,
  isMediaCivitaiSourceUrl,
  normalizeMediaExternalLink,
  normalizeMediaTriggerWords,
  parseMediaTriggerWords,
} from "../../../../core/media/asset-metadata.js";
import type {
  ImportMediaLocalModelRequest,
  ImportMediaModelAddonRequest,
  MediaAssetImportResult,
  MediaAssetCategory,
  MediaAssetRecord,
  MediaCivitaiModelAddonInspection,
  MediaGenerationAssetMetadata,
  MediaLocalModelArchitecture,
  MediaLocalModelImportInspection,
  MediaModelAddonImportInspection,
} from "../../../../core/media/contracts.js";
import { Button } from "../../components/ui/button";
import { ControlTooltip } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import { MediaCategoryPicker } from "./media-category-picker";
import { MediaAssetPreview } from "./media-visual-preview";

interface MediaAssetImportDialogProps {
  assets: readonly MediaAssetRecord[];
  categories: readonly MediaAssetCategory[];
  loading: boolean;
  progress: MediaAssetImportProgress | null;
  modelInspection: MediaLocalModelImportInspection | null;
  addonInspection: MediaModelAddonImportInspection | null;
  civitaiInspection: MediaCivitaiModelAddonInspection | null;
  error: string | null;
  onInspectModel: (path: string) => void;
  onInspectAddon: (path: string) => void;
  onInspectCivitai: (source: string) => void;
  onImportMedia: (
    path: string,
    metadata: MediaGenerationAssetMetadata,
  ) => Promise<MediaAssetImportResult | null>;
  onImportModel: (
    request: ImportMediaLocalModelRequest,
    metadata: MediaGenerationAssetMetadata,
  ) => Promise<boolean>;
  onImportAddon: (
    request: ImportMediaModelAddonRequest,
    metadata: MediaGenerationAssetMetadata,
  ) => Promise<boolean>;
  onDismissInspection: () => void;
  onManageCategories: () => void;
  onClose: () => void;
}

const IMPORT_TYPES: ReadonlyArray<{
  id: MediaAssetImportType;
  label: string;
}> = [
  { id: "model", label: "Model" },
  { id: "lora", label: "LoRA" },
  { id: "embedding", label: "Embedding" },
  { id: "image", label: "Image" },
  { id: "video", label: "Video" },
  { id: "svg", label: "SVG" },
];

const IMPORT_EXTENSIONS = [
  "safetensors",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "webm",
  "svg",
];

const ARCHITECTURES: ReadonlyArray<{
  value: MediaLocalModelArchitecture;
  label: string;
}> = [
  { value: "flux-1", label: "FLUX.1" },
  { value: "flux-2", label: "FLUX.2" },
  { value: "stable-diffusion-xl", label: "SDXL" },
  { value: "stable-diffusion-3", label: "Stable Diffusion 3" },
  { value: "stable-diffusion-2", label: "Stable Diffusion 2" },
  { value: "stable-diffusion-1", label: "Stable Diffusion 1" },
  { value: "krea-2", label: "Krea 2" },
];

const splitValues = (value: string): string[] =>
  [
    ...new Set(
      value
        .split(/[,\n]/u)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ].slice(0, 32);

const fileName = (path: string): string => path.split(/[\\/]/u).at(-1) ?? path;

const IMPORT_PROGRESS_LABELS: Record<
  MediaAssetImportProgress["stage"],
  string
> = {
  inspect: "Inspecting file",
  hash: "Calculating SHA-256",
  "duplicate-check": "Checking library",
  copy: "Importing file",
  register: "Adding to library",
};

export const MediaAssetImportDialog = ({
  assets,
  categories,
  loading,
  progress,
  modelInspection,
  addonInspection,
  civitaiInspection,
  error,
  onInspectModel,
  onInspectAddon,
  onInspectCivitai,
  onImportMedia,
  onImportModel,
  onImportAddon,
  onDismissInspection,
  onManageCategories,
  onClose,
}: MediaAssetImportDialogProps): JSX.Element => {
  const [path, setPath] = useState("");
  const [importType, setImportType] = useState<MediaAssetImportType | null>(
    null,
  );
  const [displayName, setDisplayName] = useState("");
  const [architecture, setArchitecture] =
    useState<MediaLocalModelArchitecture>("flux-1");
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [tags, setTags] = useState("");
  const [triggerWords, setTriggerWords] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [licenseName, setLicenseName] = useState("");
  const [commercialUse, setCommercialUse] = useState<
    "allowed" | "review-required"
  >("review-required");
  const [confirmRights, setConfirmRights] = useState(false);
  const [sampleAssetIds, setSampleAssetIds] = useState<string[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const dirtyEnrichmentFields = useRef(
    new Set<"displayName" | "architecture" | "tags" | "triggerWords">(),
  );
  const imageAssets = assets.filter(
    (asset) => asset.kind === "image" || asset.kind === "vector",
  );
  const importIsAddon = importType === "lora" || importType === "embedding";
  const importIsGenerationAsset = importType === "model" || importIsAddon;
  const compatibleImportTypes = listCompatibleMediaAssetImportTypes(path);
  const requestedAddonKind =
    importType === "lora"
      ? "lora"
      : importType === "embedding"
        ? "textual-inversion"
        : null;
  const detectedAddonKind =
    addonInspection?.detectedKind ?? civitaiInspection?.kind ?? null;
  const inspection =
    importType === "model"
      ? modelInspection
      : importIsAddon
        ? addonInspection
        : null;
  const normalizedSourceUrl = sourceUrl.trim()
    ? normalizeMediaExternalLink(sourceUrl)
    : null;
  const sourceUrlValid = !sourceUrl.trim() || normalizedSourceUrl !== null;
  const localTypeMatches =
    !importIsAddon ||
    !addonInspection?.detectedKind ||
    addonInspection.detectedKind === requestedAddonKind;
  const civitaiTypeMatches =
    !importIsAddon ||
    !civitaiInspection?.canEnrich ||
    !civitaiInspection.kind ||
    civitaiInspection.kind === requestedAddonKind;
  const importTypeMatches =
    importType !== null &&
    compatibleImportTypes.includes(importType) &&
    localTypeMatches &&
    civitaiTypeMatches;

  const resetFields = useCallback((): void => {
    setDisplayName("");
    setArchitecture("flux-1");
    setCategoryIds([]);
    setTags("");
    setTriggerWords("");
    setSourceUrl("");
    setLicenseName("");
    setCommercialUse("review-required");
    setConfirmRights(false);
    setSampleAssetIds([]);
    dirtyEnrichmentFields.current.clear();
    onDismissInspection();
  }, [onDismissInspection]);

  const chooseType = (type: MediaAssetImportType): void => {
    if (loading || !compatibleImportTypes.includes(type)) return;
    resetFields();
    setImportType(type);
    if (type === "model") onInspectModel(path);
    if (type === "lora" || type === "embedding") onInspectAddon(path);
  };

  const selectPath = useCallback(
    (selectedPath: string): void => {
      resetFields();
      setPath(selectedPath);
      const inferredType = inferMediaAssetImportType(selectedPath);
      setImportType(inferredType);
      if (inferredType === "model") onInspectModel(selectedPath);
      if (inferredType === "lora" || inferredType === "embedding") {
        onInspectAddon(selectedPath);
      }
    },
    [onInspectAddon, onInspectModel, resetFields],
  );

  const chooseFile = async (): Promise<void> => {
    setFileError(null);
    try {
      const selected = await openDialog({
        title: "Import asset",
        multiple: false,
        directory: false,
        filters: [
          {
            name: "Media and generation assets",
            extensions: IMPORT_EXTENSIONS,
          },
        ],
      });
      if (typeof selected !== "string") return;
      selectPath(selected);
    } catch {
      setFileError("The file picker could not be opened.");
    }
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onDragDropEvent((event: { payload: DragDropEvent }) => {
        if (loading || event.payload.type !== "drop") return;
        const dropped = event.payload.paths[0];
        if (!dropped) return;
        setFileError(null);
        selectPath(dropped);
      })
      .then((dispose) => {
        unlisten = dispose;
      })
      .catch(() =>
        setFileError("File drop is unavailable. Select a file instead."),
      );
    return () => unlisten?.();
  }, [loading, selectPath]);

  useEffect(() => {
    if (!inspection) return;
    setPath(inspection.sourcePath);
    if (!dirtyEnrichmentFields.current.has("displayName")) {
      setDisplayName(inspection.suggestedDisplayName);
    }
    if (
      inspection.detectedArchitecture &&
      !dirtyEnrichmentFields.current.has("architecture")
    ) {
      setArchitecture(inspection.detectedArchitecture);
    }
    if (
      "suggestedTriggerWords" in inspection &&
      Array.isArray(inspection.suggestedTriggerWords) &&
      !dirtyEnrichmentFields.current.has("triggerWords")
    ) {
      setTriggerWords(
        normalizeMediaTriggerWords(
          inspection.suggestedTriggerWords.filter(
            (value): value is string => typeof value === "string",
          ),
        ),
      );
    }
  }, [inspection]);

  useEffect(() => {
    if (!civitaiInspection?.canEnrich) return;
    if (
      civitaiInspection.modelName &&
      !dirtyEnrichmentFields.current.has("displayName")
    ) {
      setDisplayName(civitaiInspection.modelName);
    }
    if (
      civitaiInspection.suggestedArchitecture &&
      !dirtyEnrichmentFields.current.has("architecture")
    ) {
      setArchitecture(civitaiInspection.suggestedArchitecture);
    }
    if (!dirtyEnrichmentFields.current.has("triggerWords")) {
      setTriggerWords(
        normalizeMediaTriggerWords(civitaiInspection.trainedWords),
      );
    }
    if (!dirtyEnrichmentFields.current.has("tags")) {
      setTags(civitaiInspection.tags.join(", "));
    }
  }, [civitaiInspection]);

  useEffect(() => {
    const validCategoryIds = new Set(categories.map((category) => category.id));
    setCategoryIds((current) =>
      current.filter((categoryId) => validCategoryIds.has(categoryId)),
    );
  }, [categories]);

  const generationMetadata = (): MediaGenerationAssetMetadata => ({
    ...createEmptyMediaGenerationAssetMetadata(),
    categoryIds,
    tags: splitValues(tags),
    triggerWords: normalizeMediaTriggerWords(triggerWords),
    sourceUrl: normalizedSourceUrl,
    sampleAssetIds,
    sampleImages: civitaiInspection?.sampleImages ?? [],
  });

  const submitImport = async (): Promise<void> => {
    if (!path || !importType || !sourceUrlValid || !importTypeMatches) return;
    if (!importIsGenerationAsset) {
      const result = await onImportMedia(path, generationMetadata());
      if (result) onClose();
      return;
    }
    if (!inspection || !displayName.trim()) return;
    if (importType === "model") {
      const imported = await onImportModel(
        {
          sourcePath: inspection.sourcePath,
          reviewToken: inspection.reviewToken,
          displayName: displayName.trim(),
          architecture,
          sourceUrl: normalizedSourceUrl,
          contentDigest: inspection.contentDigest,
          licenseName: licenseName.trim(),
          commercialUse,
          confirmRights,
        },
        generationMetadata(),
      );
      if (imported) onClose();
      return;
    }
    const addonImportInspection = inspection as MediaModelAddonImportInspection;
    const words = parseMediaTriggerWords(triggerWords);
    const imported = await onImportAddon(
      {
        sourcePath: addonImportInspection.sourcePath,
        reviewToken: addonImportInspection.reviewToken,
        displayName: displayName.trim(),
        kind: importType === "lora" ? "lora" : "textual-inversion",
        architecture,
        triggerWords: words,
        token:
          importType === "embedding"
            ? (words[0] ?? addonImportInspection.suggestedToken)
            : null,
        sourceUrl: normalizedSourceUrl,
        contentDigest: addonImportInspection.contentDigest,
        licenseName: licenseName.trim(),
        commercialUse,
        confirmRights,
      },
      generationMetadata(),
    );
    if (imported) onClose();
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="media-import-title"
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-950 shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <h1
            id="media-import-title"
            className="text-base font-semibold text-slate-100"
          >
            Import
          </h1>
          <ControlTooltip content="Close">
            <button
              type="button"
              aria-label="Close import"
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>
          </ControlTooltip>
        </header>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <button
            type="button"
            disabled={loading}
            onClick={() => void chooseFile()}
            className="flex min-h-28 w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-700 bg-slate-900/35 px-5 text-slate-400 hover:border-sky-500 hover:text-sky-200 disabled:cursor-wait"
          >
            {loading ? (
              <LoaderCircle className="h-6 w-6 animate-spin" />
            ) : path ? (
              <Check className="h-6 w-6 text-emerald-300" />
            ) : (
              <Upload className="h-6 w-6" />
            )}
            <span className="max-w-full truncate text-sm">
              {path ? fileName(path) : "Drop or select a file"}
            </span>
            {loading && progress ? (
              <div className="w-full max-w-sm space-y-1.5 px-4">
                <div className="flex items-center justify-between text-xs">
                  <span>{IMPORT_PROGRESS_LABELS[progress.stage]}</span>
                  <span>{Math.round(progress.progress * 100)}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full rounded-full bg-sky-400 transition-[width]"
                    style={{
                      width: `${Math.round(progress.progress * 100)}%`,
                    }}
                  />
                </div>
              </div>
            ) : null}
          </button>

          {path ? (
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-slate-200">
                Type
              </legend>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                {IMPORT_TYPES.filter((item) =>
                  compatibleImportTypes.includes(item.id),
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    disabled={loading}
                    aria-pressed={importType === item.id}
                    onClick={() => chooseType(item.id)}
                    className={cn(
                      "rounded-xl border px-2 py-2.5 text-xs font-medium",
                      importType === item.id
                        ? "border-sky-400 bg-sky-500/10 text-sky-100"
                        : "border-slate-800 text-slate-400 hover:border-slate-600",
                      "disabled:cursor-wait disabled:opacity-60",
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </fieldset>
          ) : null}

          {path && importType ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {importIsGenerationAsset ? (
                <label className="space-y-1 text-xs text-slate-400">
                  <span>Name</span>
                  <input
                    value={displayName}
                    onChange={(event) => {
                      dirtyEnrichmentFields.current.add("displayName");
                      setDisplayName(event.target.value);
                    }}
                    className="h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-slate-100 outline-none focus:border-sky-500"
                  />
                </label>
              ) : null}
              <div className="space-y-1 text-xs text-slate-400">
                <span>Categories</span>
                <MediaCategoryPicker
                  categories={categories}
                  selectedIds={categoryIds}
                  onChange={setCategoryIds}
                  onManage={onManageCategories}
                  compact
                />
              </div>
              <label className="space-y-1 text-xs text-slate-400 sm:col-span-2">
                <span>Tags</span>
                <input
                  value={tags}
                  onChange={(event) => {
                    dirtyEnrichmentFields.current.add("tags");
                    setTags(event.target.value);
                  }}
                  className="h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-slate-100 outline-none focus:border-sky-500"
                />
              </label>
              {importIsGenerationAsset ? (
                <>
                  <label className="space-y-1 text-xs text-slate-400">
                    <span>Base model</span>
                    <select
                      value={architecture}
                      onChange={(event) => {
                        dirtyEnrichmentFields.current.add("architecture");
                        setArchitecture(
                          event.target.value as MediaLocalModelArchitecture,
                        );
                      }}
                      className="h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-slate-100 outline-none focus:border-sky-500"
                    >
                      {ARCHITECTURES.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1 text-xs text-slate-400">
                    <span>License</span>
                    <input
                      value={licenseName}
                      onChange={(event) => setLicenseName(event.target.value)}
                      className="h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-slate-100 outline-none focus:border-sky-500"
                    />
                  </label>
                  <label className="space-y-1 text-xs text-slate-400">
                    <span>Commercial use</span>
                    <select
                      value={commercialUse}
                      onChange={(event) =>
                        setCommercialUse(
                          event.target.value as "allowed" | "review-required",
                        )
                      }
                      className="h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-slate-100 outline-none focus:border-sky-500"
                    >
                      <option value="review-required">Review required</option>
                      <option value="allowed">Allowed</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-2 text-xs text-slate-300 sm:col-span-2">
                    <input
                      type="checkbox"
                      checked={confirmRights}
                      onChange={(event) =>
                        setConfirmRights(event.target.checked)
                      }
                      className="h-4 w-4 rounded border-slate-600 bg-slate-900"
                    />
                    I have the right to use these weights.
                  </label>
                </>
              ) : null}
              <label className="space-y-1 text-xs text-slate-400 sm:col-span-2">
                <span>Source URL</span>
                <div className="flex gap-2">
                  <input
                    type="url"
                    value={sourceUrl}
                    onChange={(event) => setSourceUrl(event.target.value)}
                    className="h-10 min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3 text-slate-100 outline-none focus:border-sky-500"
                  />
                  {importIsGenerationAsset ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        onInspectCivitai(normalizedSourceUrl ?? "")
                      }
                      disabled={
                        loading ||
                        !normalizedSourceUrl ||
                        !isMediaCivitaiSourceUrl(normalizedSourceUrl)
                      }
                    >
                      Enrich
                    </Button>
                  ) : null}
                </div>
                {!sourceUrlValid ? (
                  <span className="text-rose-300">Enter an HTTPS URL</span>
                ) : null}
              </label>
              {importIsAddon ? (
                <label className="space-y-1 text-xs text-slate-400 sm:col-span-2">
                  <span>Trigger words</span>
                  <input
                    value={triggerWords}
                    onChange={(event) => {
                      dirtyEnrichmentFields.current.add("triggerWords");
                      setTriggerWords(event.target.value);
                    }}
                    onBlur={() =>
                      setTriggerWords(normalizeMediaTriggerWords(triggerWords))
                    }
                    className="h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-slate-100 outline-none focus:border-sky-500"
                  />
                </label>
              ) : null}
              {importIsGenerationAsset ? (
                <>
                  <label className="space-y-1 text-xs text-slate-400 sm:col-span-2">
                    <span>Sample images</span>
                    <div className="grid max-h-48 grid-cols-6 gap-2 overflow-y-auto rounded-xl border border-slate-800 p-2">
                      {imageAssets.map((asset) => {
                        const selected = sampleAssetIds.includes(asset.id);
                        return (
                          <button
                            key={asset.id}
                            type="button"
                            aria-pressed={selected}
                            onClick={() =>
                              setSampleAssetIds((current) =>
                                selected
                                  ? current.filter((id) => id !== asset.id)
                                  : [...current, asset.id].slice(0, 12),
                              )
                            }
                            className={cn(
                              "relative aspect-square overflow-hidden rounded-lg border",
                              selected ? "border-sky-400" : "border-slate-700",
                            )}
                          >
                            <MediaAssetPreview
                              asset={asset}
                              className="h-full w-full"
                            />
                            {selected ? (
                              <Check className="absolute right-1 top-1 h-4 w-4 rounded-full bg-sky-500 p-0.5 text-white" />
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </label>
                </>
              ) : null}
            </div>
          ) : null}
          {civitaiInspection?.sampleImages.length ? (
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
              {civitaiInspection.sampleImages.map((sample) => (
                <img
                  key={sample.url}
                  src={sample.url}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="aspect-square w-full rounded-lg object-cover"
                />
              ))}
            </div>
          ) : null}
          {civitaiInspection && !civitaiInspection.canEnrich ? (
            <p className="text-sm text-rose-300">
              {civitaiInspection.blockingReason}
            </p>
          ) : null}
          {inspection?.duplicate ? (
            <p className="text-sm text-amber-300">
              Already imported as {inspection.duplicate.displayName}.
            </p>
          ) : null}
          {importType && !importTypeMatches ? (
            <p className="text-sm text-rose-300">
              {detectedAddonKind === "lora"
                ? "This file is a LoRA."
                : "This file is an embedding."}
            </p>
          ) : null}
          {fileError ? (
            <p className="text-sm text-rose-300">{fileError}</p>
          ) : null}
          {error ? <p className="text-sm text-rose-300">{error}</p> : null}
        </div>
        <footer className="flex justify-end gap-2 border-t border-slate-800 px-5 py-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void submitImport()}
            disabled={
              !path ||
              !importType ||
              loading ||
              !sourceUrlValid ||
              !importTypeMatches ||
              (importIsGenerationAsset &&
                (!inspection ||
                  !displayName.trim() ||
                  !licenseName.trim() ||
                  !confirmRights ||
                  inspection.duplicate !== null))
            }
          >
            {loading ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Import className="h-4 w-4" />
            )}
            Import
          </Button>
        </footer>
      </div>
    </div>
  );
};
