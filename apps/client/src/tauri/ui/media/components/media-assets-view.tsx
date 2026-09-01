import {
  FileImage,
  FileType,
  Import,
  MoreVertical,
  Play,
  Search,
  Trash2,
  Video,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import {
  mediaAssetCategoryNames,
  matchesMediaAssetCategoryFilter,
} from "../../../../core/media/asset-categories.js";
import {
  createEmptyMediaGenerationAssetMetadata,
  normalizeMediaTriggerWords,
} from "../../../../core/media/asset-metadata.js";
import { listMediaLibraryModels } from "../../../../core/media/model-library.js";
import type { MediaAssetImportProgress } from "../../../../core/media/asset-import.js";
import { inspectMediaModelAddonCompatibility } from "../../../../core/media/model-addons.js";
import {
  describeMediaModelReadiness,
  isMediaModelReady,
} from "../../../../core/media/model-readiness.js";
import type {
  ImportMediaLocalModelRequest,
  ImportMediaModelAddonRequest,
  MediaAssetImportResult,
  MediaAssetCategory,
  MediaAssetDeletionImpact,
  MediaAssetRecord,
  MediaAssetTagUpdate,
  MediaCivitaiModelAddonInspection,
  MediaGenerationAssetMetadata,
  MediaLocalModelImportInspection,
  MediaModelAddonImportInspection,
  MediaModelCatalogSnapshot,
  MediaModelDescriptor,
} from "../../../../core/media/contracts.js";
import { Button } from "../../components/ui/button";
import { ControlTooltip } from "../../components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { cn } from "../../lib/utils";
import { MediaAssetImportDialog } from "./media-asset-import-dialog";
import { MediaAssetMetadataEditor } from "./media-asset-metadata-editor";
import { MediaCategoryManagerDialog } from "./media-category-manager-dialog";
import { MediaCategoryPicker } from "./media-category-picker";
import {
  MediaAssetPreview,
  MediaResourcePreview,
} from "./media-visual-preview";

type AssetFilter =
  | "all"
  | "model"
  | "lora"
  | "embedding"
  | "image"
  | "video"
  | "svg";

interface MediaAssetsViewProps {
  assets: readonly MediaAssetRecord[];
  catalog: MediaModelCatalogSnapshot;
  categories: readonly MediaAssetCategory[];
  metadata: Record<string, MediaGenerationAssetMetadata>;
  selectedModelId: string | null;
  importSupported: boolean;
  importLoading: boolean;
  importProgress: MediaAssetImportProgress | null;
  modelImportInspection: MediaLocalModelImportInspection | null;
  addonImportInspection: MediaModelAddonImportInspection | null;
  civitaiInspection: MediaCivitaiModelAddonInspection | null;
  importError: string | null;
  persistenceError: string | null;
  openAssetId?: string | null;
  onOpenAssetHandled?: () => void;
  openResourceId?: string | null;
  onOpenResourceHandled?: () => void;
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
  onImportSampleUrl: (url: string) => Promise<MediaAssetImportResult | null>;
  onRetryPersistence: () => void;
  onDismissImport: () => void;
  onUseModel: (model: MediaModelDescriptor) => void;
  onRefreshLocalRuntime: () => void;
  onVerifyModel: (model: MediaModelDescriptor) => void;
  localRuntimeRefreshing: boolean;
  verifyingModelId: string | null;
  onUseAddon: (addonId: string) => void;
  onUseAsReference: (asset: MediaAssetRecord) => void;
  onOpenVideoAsFlow: (asset: MediaAssetRecord) => void;
  onInspectSettings: (runId: string) => void;
  onReuseSettings: (runId: string) => void;
  onPlanAssetDeletion: (assetId: string) => Promise<MediaAssetDeletionImpact>;
  onDeleteAsset: (impact: MediaAssetDeletionImpact) => Promise<void>;
  onUpdateTags: (update: MediaAssetTagUpdate) => void;
  onUpdateMetadata: (
    resourceId: string,
    metadata: MediaGenerationAssetMetadata,
  ) => void;
  onCategoryStateChange: (
    categories: MediaAssetCategory[],
    metadata: Record<string, MediaGenerationAssetMetadata>,
  ) => void;
  tagLoadingAssetId: string | null;
}

const FILTERS: ReadonlyArray<{ id: AssetFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "model", label: "Models" },
  { id: "lora", label: "LoRAs" },
  { id: "embedding", label: "Embeddings" },
  { id: "image", label: "Images" },
  { id: "video", label: "Videos" },
  { id: "svg", label: "SVGs" },
];

const resourceMatches = (
  values: Array<string | null | undefined>,
  query: string,
): boolean => {
  const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const haystack = values.filter(Boolean).join(" ").toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
};

export const MediaAssetsView = ({
  assets,
  catalog,
  categories,
  metadata,
  selectedModelId,
  importSupported,
  importLoading,
  importProgress,
  modelImportInspection,
  addonImportInspection,
  civitaiInspection,
  importError,
  persistenceError,
  openAssetId,
  onOpenAssetHandled,
  openResourceId,
  onOpenResourceHandled,
  onInspectModel,
  onInspectAddon,
  onInspectCivitai,
  onImportMedia,
  onImportModel,
  onImportAddon,
  onImportSampleUrl,
  onRetryPersistence,
  onDismissImport,
  onUseModel,
  onRefreshLocalRuntime,
  onVerifyModel,
  localRuntimeRefreshing,
  verifyingModelId,
  onUseAddon,
  onUseAsReference,
  onOpenVideoAsFlow,
  onInspectSettings,
  onReuseSettings,
  onPlanAssetDeletion,
  onDeleteAsset,
  onUpdateTags,
  onUpdateMetadata,
  onCategoryStateChange,
  tagLoadingAssetId,
}: MediaAssetsViewProps): JSX.Element => {
  const [filter, setFilter] = useState<AssetFilter>("all");
  const [query, setQuery] = useState("");
  const [categoryFilterIds, setCategoryFilterIds] = useState<string[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(
    openAssetId ?? null,
  );
  const [selectedResourceId, setSelectedResourceId] = useState<string | null>(
    null,
  );
  const [contextAssetId, setContextAssetId] = useState<string | null>(null);
  const [deletionImpact, setDeletionImpact] =
    useState<MediaAssetDeletionImpact | null>(null);
  const [deletionPending, setDeletionPending] = useState(false);
  const [deletionError, setDeletionError] = useState<string | null>(null);
  const cardRefs = useRef<Record<string, HTMLElement | null>>({});
  const selectedModel =
    catalog.models.find((model) => model.id === selectedModelId) ?? null;
  const selectedAsset =
    assets.find((asset) => asset.id === selectedAssetId) ?? null;
  const libraryModels = listMediaLibraryModels(catalog.models);
  const selectedResourceModel =
    libraryModels.find((model) => model.id === selectedResourceId) ?? null;
  const selectedResourceAddon =
    catalog.addons.find((addon) => addon.id === selectedResourceId) ?? null;
  const selectedResourceMetadata = selectedResourceId
    ? (metadata[selectedResourceId] ?? {
        ...createEmptyMediaGenerationAssetMetadata(),
        triggerWords: selectedResourceAddon
          ? normalizeMediaTriggerWords(selectedResourceAddon.triggerWords)
          : "",
        sourceUrl:
          selectedResourceAddon?.sourceUrl ??
          selectedResourceModel?.lifecycleSourceUrl ??
          null,
      })
    : null;
  const selectedAssetMetadata = selectedAsset
    ? (metadata[selectedAsset.id] ?? createEmptyMediaGenerationAssetMetadata())
    : null;
  const selectedModelReadiness = selectedResourceModel
    ? describeMediaModelReadiness(selectedResourceModel)
    : null;
  const categoryNamesFor = (resourceId: string): string[] =>
    mediaAssetCategoryNames(
      metadata[resourceId]?.categoryIds ?? [],
      categories,
    );
  const matchesCategoryFilter = (resourceId: string): boolean =>
    matchesMediaAssetCategoryFilter(
      metadata[resourceId]?.categoryIds ?? [],
      categoryFilterIds,
    );
  const visibleModels =
    filter === "all" || filter === "model"
      ? libraryModels
          .filter((model) => matchesCategoryFilter(model.id))
          .filter((model) =>
            resourceMatches(
              [
                model.displayName,
                model.family,
                model.architecture,
                ...categoryNamesFor(model.id),
                ...(metadata[model.id]?.tags ?? []),
                metadata[model.id]?.triggerWords,
                metadata[model.id]?.sourceUrl,
              ],
              query,
            ),
          )
      : [];
  const visibleAddons =
    filter === "all" || filter === "lora" || filter === "embedding"
      ? catalog.addons
          .filter(
            (addon) =>
              filter === "all" ||
              (filter === "lora"
                ? addon.kind === "lora"
                : addon.kind === "textual-inversion"),
          )
          .filter((addon) => matchesCategoryFilter(addon.id))
          .filter((addon) =>
            resourceMatches(
              [
                addon.displayName,
                addon.architecture,
                addon.baseModelHint,
                ...addon.triggerWords,
                metadata[addon.id]?.triggerWords,
                ...categoryNamesFor(addon.id),
                ...(metadata[addon.id]?.tags ?? []),
                metadata[addon.id]?.sourceUrl,
              ],
              query,
            ),
          )
      : [];
  const visibleMedia = assets
    .filter((asset) => {
      if (filter === "all") return asset.kind !== "report";
      if (filter === "image") return asset.kind === "image";
      if (filter === "video") return asset.kind === "video";
      if (filter === "svg") return asset.kind === "vector";
      return false;
    })
    .filter((asset) => matchesCategoryFilter(asset.id))
    .filter((asset) =>
      resourceMatches(
        [
          asset.id,
          asset.mimeType,
          ...asset.tags.map((tag) => tag.label),
          ...categoryNamesFor(asset.id),
          ...(metadata[asset.id]?.tags ?? []),
          metadata[asset.id]?.sourceUrl,
        ],
        query,
      ),
    );
  const totalVisible =
    visibleModels.length + visibleAddons.length + visibleMedia.length;

  const showResource = useCallback(
    (resourceId: string): boolean => {
      const model = listMediaLibraryModels(catalog.models).find(
        (item) => item.id === resourceId,
      );
      const addon = catalog.addons.find((item) => item.id === resourceId);
      if (!model && !addon) return false;
      setSelectedAssetId(null);
      setSelectedResourceId(resourceId);
      setFilter(
        model ? "model" : addon?.kind === "lora" ? "lora" : "embedding",
      );
      setQuery("");
      setCategoryFilterIds([]);
      requestAnimationFrame(() =>
        cardRefs.current[resourceId]?.scrollIntoView?.({ block: "center" }),
      );
      return true;
    },
    [catalog.addons, catalog.models],
  );

  useEffect(() => {
    if (!openAssetId) return;
    setSelectedAssetId(openAssetId);
    setSelectedResourceId(null);
    setFilter("all");
    setQuery("");
    setCategoryFilterIds([]);
    requestAnimationFrame(() =>
      cardRefs.current[openAssetId]?.scrollIntoView?.({ block: "center" }),
    );
    onOpenAssetHandled?.();
  }, [onOpenAssetHandled, openAssetId]);

  useEffect(() => {
    if (!openResourceId) return;
    if (showResource(openResourceId)) onOpenResourceHandled?.();
  }, [onOpenResourceHandled, openResourceId, showResource]);

  useEffect(() => {
    const validCategoryIds = new Set(categories.map((category) => category.id));
    setCategoryFilterIds((current) =>
      current.filter((categoryId) => validCategoryIds.has(categoryId)),
    );
  }, [categories]);

  const addonCompatible = (addonId: string): boolean => {
    if (!selectedModel) return false;
    const addon = catalog.addons.find((candidate) => candidate.id === addonId);
    return addon
      ? inspectMediaModelAddonCompatibility(selectedModel, addon).status !==
          "incompatible"
      : false;
  };

  const requestAssetDeletion = async (assetId: string): Promise<void> => {
    setContextAssetId(null);
    setDeletionError(null);
    setDeletionPending(true);
    try {
      setDeletionImpact(await onPlanAssetDeletion(assetId));
    } catch (error: unknown) {
      setDeletionError(
        error instanceof Error ? error.message : "Could not inspect the asset.",
      );
    } finally {
      setDeletionPending(false);
    }
  };

  const confirmAssetDeletion = async (): Promise<void> => {
    if (!deletionImpact || deletionPending) return;
    setDeletionError(null);
    setDeletionPending(true);
    try {
      await onDeleteAsset(deletionImpact);
      if (selectedAssetId === deletionImpact.assetId) setSelectedAssetId(null);
      setDeletionImpact(null);
    } catch (error: unknown) {
      setDeletionError(
        error instanceof Error ? error.message : "Could not delete the asset.",
      );
    } finally {
      setDeletionPending(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-950">
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-800/80 px-5 py-3">
        <div className="relative min-w-56 flex-1 max-w-xl">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search assets"
            className="h-10 w-full rounded-xl border border-slate-800 bg-slate-900/70 pl-9 pr-3 text-sm text-slate-100 outline-none focus:border-sky-500"
          />
        </div>
        <MediaCategoryPicker
          categories={categories}
          selectedIds={categoryFilterIds}
          onChange={setCategoryFilterIds}
          onManage={() => setCategoryManagerOpen(true)}
          compact
          className="w-48"
        />
        <Button
          type="button"
          onClick={() => setImportOpen(true)}
          disabled={!importSupported}
        >
          <Import className="h-4 w-4" /> Import
        </Button>
        {persistenceError ? (
          <div
            role="alert"
            className="flex w-full items-center gap-3 text-xs text-rose-300"
          >
            <span className="min-w-0 flex-1">{persistenceError}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRetryPersistence}
            >
              Retry save
            </Button>
          </div>
        ) : null}
      </header>
      <div className="flex gap-2 overflow-x-auto border-b border-slate-800/70 px-5 py-2">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={filter === item.id}
            onClick={() => setFilter(item.id)}
            className={cn(
              "shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium",
              filter === item.id
                ? "bg-slate-700 text-white"
                : "text-slate-400 hover:bg-slate-900 hover:text-white",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {totalVisible === 0 ? (
          <div className="flex min-h-72 items-center justify-center rounded-2xl border border-dashed border-slate-800 text-sm text-slate-500">
            {query || categoryFilterIds.length > 0
              ? "No matching assets"
              : "Import an asset"}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 2xl:grid-cols-4">
            {visibleModels.map((model) => {
              const ready = isMediaModelReady(model);
              const readiness = describeMediaModelReadiness(model);
              const categorySummary = categoryNamesFor(model.id).join(", ");
              return (
                <article
                  key={model.id}
                  ref={(element) => {
                    cardRefs.current[model.id] = element;
                  }}
                  className={cn(
                    "overflow-hidden rounded-2xl border bg-slate-900/55",
                    selectedResourceId === model.id
                      ? "border-sky-400"
                      : "border-slate-800",
                  )}
                >
                  <button
                    type="button"
                    aria-label={`View ${model.displayName}`}
                    onClick={() => {
                      setSelectedAssetId(null);
                      setSelectedResourceId(model.id);
                    }}
                    className="block w-full"
                  >
                    <MediaResourcePreview
                      resourceId={model.id}
                      metadata={metadata}
                      assets={assets}
                      className="aspect-[4/3] w-full"
                    />
                  </button>
                  <div className="space-y-2 p-3">
                    <div>
                      <h2 className="truncate text-sm font-semibold text-slate-100">
                        {model.displayName}
                      </h2>
                      <p className="truncate text-xs text-slate-500">
                        {categorySummary || readiness?.action || model.family}
                      </p>
                    </div>
                    {ready ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onUseModel(model)}
                        className="w-full"
                      >
                        Use model
                      </Button>
                    ) : model.runtimeReadiness === "runtime-unavailable" ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={onRefreshLocalRuntime}
                        disabled={localRuntimeRefreshing}
                        className="w-full"
                      >
                        {localRuntimeRefreshing
                          ? "Refreshing…"
                          : "Refresh runtime"}
                      </Button>
                    ) : model.installed &&
                      model.management.verification !== "none" ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onVerifyModel(model)}
                        disabled={verifyingModelId === model.id}
                        className="w-full"
                      >
                        {verifyingModelId === model.id
                          ? "Verifying…"
                          : "Verify model"}
                      </Button>
                    ) : null}
                  </div>
                </article>
              );
            })}
            {visibleAddons.map((addon) => {
              const compatible = addonCompatible(addon.id);
              return (
                <article
                  key={addon.id}
                  ref={(element) => {
                    cardRefs.current[addon.id] = element;
                  }}
                  className={cn(
                    "overflow-hidden rounded-2xl border bg-slate-900/55",
                    selectedResourceId === addon.id
                      ? "border-sky-400"
                      : "border-slate-800",
                  )}
                >
                  <button
                    type="button"
                    aria-label={`View ${addon.displayName}`}
                    onClick={() => {
                      setSelectedAssetId(null);
                      setSelectedResourceId(addon.id);
                    }}
                    className="block w-full"
                  >
                    <MediaResourcePreview
                      resourceId={addon.id}
                      metadata={metadata}
                      assets={assets}
                      className="aspect-[4/3] w-full"
                    />
                  </button>
                  <div className="space-y-2 p-3">
                    <div>
                      <h2 className="truncate text-sm font-semibold text-slate-100">
                        {addon.displayName}
                      </h2>
                      <p className="truncate text-xs text-slate-500">
                        {categoryNamesFor(addon.id).join(", ") ||
                          addon.architecture}
                      </p>
                    </div>
                    {compatible ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onUseAddon(addon.id)}
                        className="w-full"
                      >
                        Add to create
                      </Button>
                    ) : null}
                  </div>
                </article>
              );
            })}
            {visibleMedia.map((asset) => (
              <article
                key={asset.id}
                ref={(element) => {
                  cardRefs.current[asset.id] = element;
                }}
                className={cn(
                  "relative overflow-hidden rounded-2xl border bg-slate-900/55",
                  selectedAssetId === asset.id
                    ? "border-sky-400"
                    : "border-slate-800",
                )}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContextAssetId(asset.id);
                }}
              >
                <DropdownMenu
                  open={contextAssetId === asset.id}
                  onOpenChange={(open) =>
                    setContextAssetId(open ? asset.id : null)
                  }
                >
                  <ControlTooltip content="Asset actions">
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label="Asset actions"
                        className="absolute right-2 top-2 z-10 rounded-lg bg-slate-950/85 p-1.5 text-slate-200 hover:bg-slate-900"
                      >
                        <MoreVertical className="h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                  </ControlTooltip>
                  <DropdownMenuContent align="end">
                    {asset.kind === "image" ? (
                      <DropdownMenuItem
                        onSelect={() => onUseAsReference(asset)}
                      >
                        Use as reference
                      </DropdownMenuItem>
                    ) : null}
                    {asset.kind === "image" ? (
                      <DropdownMenuItem
                        onSelect={() => onOpenVideoAsFlow(asset)}
                      >
                        Animate image
                      </DropdownMenuItem>
                    ) : null}
                    {asset.operation?.kind !== "local-import" ? (
                      <>
                        <DropdownMenuItem
                          onSelect={() => onInspectSettings(asset.runId)}
                        >
                          View settings
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => onReuseSettings(asset.runId)}
                        >
                          Reuse settings
                        </DropdownMenuItem>
                      </>
                    ) : null}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => void requestAssetDeletion(asset.id)}
                    >
                      <Trash2 /> Delete asset
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <button
                  type="button"
                  aria-label={`View ${asset.kind === "vector" ? "SVG" : asset.kind} output ${asset.outputIndex + 1}`}
                  onClick={() => {
                    setSelectedResourceId(null);
                    setSelectedAssetId(asset.id);
                  }}
                  className="block w-full"
                >
                  <MediaAssetPreview
                    asset={asset}
                    className="aspect-[4/3] w-full"
                  />
                </button>
                <div className="space-y-2 p-3">
                  <div className="flex items-center gap-2">
                    {asset.kind === "video" ? (
                      <Video className="h-4 w-4 text-emerald-300" />
                    ) : asset.kind === "vector" ? (
                      <FileType className="h-4 w-4 text-violet-300" />
                    ) : (
                      <FileImage className="h-4 w-4 text-sky-300" />
                    )}
                    <span className="truncate text-xs text-slate-400">
                      {asset.width} × {asset.height}
                    </span>
                  </div>
                  {categoryNamesFor(asset.id).length > 0 ? (
                    <p className="truncate text-[10px] text-slate-500">
                      {categoryNamesFor(asset.id).join(", ")}
                    </p>
                  ) : null}
                  <div className="flex gap-2">
                    {asset.kind === "image" ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onUseAsReference(asset)}
                        className="flex-1"
                      >
                        Use
                      </Button>
                    ) : null}
                    {asset.kind === "image" ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => onOpenVideoAsFlow(asset)}
                      >
                        <Play className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {(selectedResourceModel || selectedResourceAddon) &&
      selectedResourceMetadata ? (
        <aside className="absolute bottom-4 right-4 z-20 max-h-[calc(100%-2rem)] w-80 overflow-y-auto rounded-2xl border border-slate-700 bg-slate-950/95 p-4 shadow-2xl backdrop-blur">
          <div className="mb-3 flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-sm font-semibold text-slate-100">
              {selectedResourceModel?.displayName ??
                selectedResourceAddon?.displayName}
            </span>
            <ControlTooltip content="Close">
              <button
                type="button"
                aria-label="Close asset details"
                onClick={() => setSelectedResourceId(null)}
                className="rounded-md p-1 text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </ControlTooltip>
          </div>
          <MediaResourcePreview
            resourceId={selectedResourceId ?? ""}
            metadata={metadata}
            assets={assets}
            className="mb-3 aspect-video w-full rounded-xl"
          />
          <div className="space-y-3">
            <MediaAssetMetadataEditor
              key={selectedResourceId}
              resourceId={selectedResourceId ?? ""}
              metadata={selectedResourceMetadata}
              categories={categories}
              showTriggerWords
              onChange={(nextMetadata) => {
                if (selectedResourceId) {
                  onUpdateMetadata(selectedResourceId, nextMetadata);
                }
              }}
              onManageCategories={() => setCategoryManagerOpen(true)}
            />
            {selectedResourceModel &&
            isMediaModelReady(selectedResourceModel) ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onUseModel(selectedResourceModel)}
                className="w-full"
              >
                Use model
              </Button>
            ) : selectedResourceModel && selectedModelReadiness ? (
              <div className="space-y-2">
                <p className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-[10px] leading-4 text-amber-100">
                  {selectedResourceModel.runtimeReadinessDiagnostic ??
                    selectedModelReadiness.message}
                </p>
                {selectedResourceModel.runtimeReadiness ===
                "runtime-unavailable" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onRefreshLocalRuntime}
                    disabled={localRuntimeRefreshing}
                    className="w-full"
                  >
                    {localRuntimeRefreshing ? "Refreshing…" : "Refresh runtime"}
                  </Button>
                ) : selectedResourceModel.installed &&
                  selectedResourceModel.management.verification !== "none" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onVerifyModel(selectedResourceModel)}
                    disabled={verifyingModelId === selectedResourceModel.id}
                    className="w-full"
                  >
                    {verifyingModelId === selectedResourceModel.id
                      ? "Verifying…"
                      : "Verify model"}
                  </Button>
                ) : null}
              </div>
            ) : selectedResourceAddon &&
              addonCompatible(selectedResourceAddon.id) ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onUseAddon(selectedResourceAddon.id)}
                className="w-full"
              >
                Add to create
              </Button>
            ) : null}
          </div>
        </aside>
      ) : null}

      {selectedAsset && selectedAssetMetadata ? (
        <aside className="absolute bottom-4 right-4 z-20 max-h-[calc(100%-2rem)] w-80 overflow-y-auto rounded-2xl border border-slate-700 bg-slate-950/95 p-4 shadow-2xl backdrop-blur">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-100">
              {selectedAsset.kind === "vector"
                ? "SVG"
                : selectedAsset.kind[0]?.toUpperCase() +
                  selectedAsset.kind.slice(1)}
            </span>
            <ControlTooltip content="Close">
              <button
                type="button"
                aria-label="Close asset details"
                onClick={() => setSelectedAssetId(null)}
                className="rounded-md p-1 text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </ControlTooltip>
          </div>
          <MediaAssetPreview
            asset={selectedAsset}
            className="mb-3 aspect-video w-full rounded-xl"
            controls={selectedAsset.kind === "video"}
            fit="contain"
          />
          {selectedAsset.operation?.kind !== "local-import" ? (
            <div className="mb-3 grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onInspectSettings(selectedAsset.runId)}
              >
                View settings
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onReuseSettings(selectedAsset.runId)}
              >
                Reuse settings
              </Button>
            </div>
          ) : null}
          <MediaAssetMetadataEditor
            key={selectedAsset.id}
            resourceId={selectedAsset.id}
            metadata={{
              ...selectedAssetMetadata,
              tags:
                metadata[selectedAsset.id] !== undefined
                  ? selectedAssetMetadata.tags
                  : selectedAsset.tags
                      .filter((tag) => tag.source === "user")
                      .map((tag) => tag.label),
            }}
            categories={categories}
            showTriggerWords={false}
            showSourceUrl={false}
            tagLoading={tagLoadingAssetId === selectedAsset.id}
            onChange={(nextMetadata) =>
              onUpdateMetadata(selectedAsset.id, nextMetadata)
            }
            onTagsChange={(tags) =>
              onUpdateTags({ assetId: selectedAsset.id, tags })
            }
            onManageCategories={() => setCategoryManagerOpen(true)}
          />
        </aside>
      ) : null}

      {importOpen ? (
        <MediaAssetImportDialog
          assets={assets}
          categories={categories}
          loading={importLoading}
          progress={importProgress}
          modelInspection={modelImportInspection}
          addonInspection={addonImportInspection}
          civitaiInspection={civitaiInspection}
          error={importError}
          onInspectModel={onInspectModel}
          onInspectAddon={onInspectAddon}
          onInspectCivitai={onInspectCivitai}
          onImportMedia={onImportMedia}
          onImportModel={onImportModel}
          onImportAddon={onImportAddon}
          onImportSampleUrl={onImportSampleUrl}
          onViewResource={(resourceId) => {
            if (showResource(resourceId)) setImportOpen(false);
          }}
          onDismissInspection={onDismissImport}
          onManageCategories={() => setCategoryManagerOpen(true)}
          onClose={() => {
            setImportOpen(false);
            onDismissImport();
          }}
        />
      ) : null}
      {categoryManagerOpen ? (
        <MediaCategoryManagerDialog
          categories={categories}
          metadata={metadata}
          onChange={onCategoryStateChange}
          onClose={() => setCategoryManagerOpen(false)}
        />
      ) : null}
      <Dialog
        open={deletionImpact !== null || deletionError !== null}
        onOpenChange={(open) => {
          if (!open && !deletionPending) {
            setDeletionImpact(null);
            setDeletionError(null);
          }
        }}
      >
        <DialogContent className="border-slate-700 bg-slate-950 text-slate-100 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete asset?</DialogTitle>
          </DialogHeader>
          {deletionImpact ? (
            <p className="text-sm text-slate-300">
              This removes the asset from Media Studio.
              {deletionImpact.dependentAssetIds.length > 0
                ? ` ${deletionImpact.dependentAssetIds.length} dependent ${deletionImpact.dependentAssetIds.length === 1 ? "asset will" : "assets will"} show a missing source.`
                : ""}
              {deletionImpact.exportCount > 0 ? " Exported copies remain." : ""}
            </p>
          ) : null}
          {deletionImpact?.activeExportCount ? (
            <p className="text-sm text-rose-300">
              Deletion is blocked until the active export finishes.
            </p>
          ) : null}
          {deletionError ? (
            <p className="text-sm text-rose-300">{deletionError}</p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setDeletionImpact(null);
                setDeletionError(null);
              }}
              disabled={deletionPending}
            >
              Cancel
            </Button>
            {deletionImpact ? (
              <Button
                type="button"
                onClick={() => void confirmAssetDeletion()}
                disabled={
                  deletionPending || deletionImpact.activeExportCount > 0
                }
                className="bg-rose-600 text-white hover:bg-rose-500"
              >
                Delete asset
              </Button>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};
