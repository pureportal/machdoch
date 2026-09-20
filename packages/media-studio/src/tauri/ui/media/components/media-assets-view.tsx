import { CivitaiBrowserDialog } from "./civitai-browser-dialog";
import { MediaModelEditDialog } from "./media-model-edit-dialog";
import {
  discoverMediaResources,
  listMediaResourceTags,
  type MediaResourceSort,
} from "../../../../core/media/resource-discovery.js";
import { MediaImportJobs } from "./media-import-jobs";
import { MediaAssetDetailsDialog } from "./media-asset-details-dialog";
import { MediaModelInstallDialog } from "./media-model-install-dialog";
import { MediaRemoveResourceButton } from "./media-remove-resource-button";
import {
  Copy,
  FileImage,
  FileType,
  Import,
  MoreVertical,
  Pencil,
  Play,
  Search,
  Trash2,
  Video,
  X,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
} from "react";
import {
  EMPTY_MEDIA_ASSET_FILTERS,
  matchesMediaAssetFilters,
  mediaAssetOrigin,
} from "../../../../core/media/asset-discovery.js";
import {
  EMPTY_MEDIA_LIBRARY_MODEL_FILTERS,
  MediaAssetsFilters,
  type MediaAssetTypeFilter,
} from "./media-assets-filters";
import {
  mediaAssetCategoryNames,
  matchesMediaAssetCategoryFilter,
} from "../../../../core/media/asset-categories.js";
import {
  createEmptyMediaGenerationAssetMetadata,
  normalizeMediaTriggerWords,
  isMediaCivitaiSourceUrl,
} from "../../../../core/media/asset-metadata.js";
import { listMediaLibraryModels } from "../../../../core/media/model-library.js";
import type { MediaAssetImportProgress } from "../../../../core/media/asset-import.js";
import { inspectMediaModelAddonCompatibility } from "../../../../core/media/model-addons.js";
import {
  describeMediaModelReadiness,
  isMediaModelReady,
} from "../../../../core/media/model-readiness.js";
import { mediaAssetLabel } from "../../../../core/media/asset-label.js";
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
  UpdateMediaModelResourceRequest,
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
  ContextActionMenu,
  openContextMenuFromButton,
} from "../../components/ui/context-action-menu";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/utils";
import { MediaAssetImportDialog } from "./media-asset-import-dialog";
import { MediaAssetMetadataEditor } from "./media-asset-metadata-editor";
import { MediaCategoryManagerDialog } from "./media-category-manager-dialog";
import { MediaCategoryPicker } from "./media-category-picker";
import {
  isMediaRuntimeSetupActive,
  mediaRuntimeSetupLabel,
  type MediaRuntimeSetupStatus,
} from "../media-runtime-setup";
import {
  MediaAssetPreview,
  MediaResourcePreview,
} from "./media-visual-preview";

interface MediaAssetsViewProps {
  discoveredFiles: readonly import("../../../../core/media/contracts.js").MediaDiscoveredModelArtifact[];
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
  onSetupRuntime: () => void;
  onVerifyModel: (model: MediaModelDescriptor) => void;
  onRefreshModels: (removedResourceId?: string) => Promise<void>;
  onScanModels: () => void;
  runtimeSetup: MediaRuntimeSetupStatus;
  runtimeReady: boolean;
  verifyingModelId: string | null;
  onUseAddon: (addonId: string) => void;
  onUseAsReference: (asset: MediaAssetRecord) => void;
  onEditImage: (asset: MediaAssetRecord) => void;
  onAnimateImage: (asset: MediaAssetRecord) => void;
  onOpenVideoAsFlow: (asset: MediaAssetRecord) => void;
  onInspectSettings: (runId: string) => void;
  onReuseSettings: (runId: string) => void;
  onPlanAssetDeletion: (assetId: string) => Promise<MediaAssetDeletionImpact>;
  onDeleteAsset: (impact: MediaAssetDeletionImpact) => Promise<void>;
  onUpdateTags: (update: MediaAssetTagUpdate) => void;
  onSaveResource: (
    resourceId: string,
    request: UpdateMediaModelResourceRequest | null,
    metadata: MediaGenerationAssetMetadata,
  ) => Promise<void>;
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

const FILTERS: ReadonlyArray<{ id: MediaAssetTypeFilter; label: string }> = [
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
  discoveredFiles,
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
  onSetupRuntime,
  onVerifyModel,
  onRefreshModels,
  onScanModels,
  runtimeSetup,
  runtimeReady,
  verifyingModelId,
  onUseAddon,
  onUseAsReference,
  onEditImage,
  onAnimateImage,
  onOpenVideoAsFlow,
  onInspectSettings,
  onReuseSettings,
  onPlanAssetDeletion,
  onDeleteAsset,
  onUpdateTags,
  onSaveResource,
  onUpdateMetadata,
  onCategoryStateChange,
  tagLoadingAssetId,
}: MediaAssetsViewProps): JSX.Element => {
  const setupActive = isMediaRuntimeSetupActive(runtimeSetup);
  const setupLabel =
    runtimeSetup.phase === "ready"
      ? "Set up Media Studio"
      : mediaRuntimeSetupLabel(runtimeSetup);
  const [filter, setFilter] = useState<MediaAssetTypeFilter>("all");
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("all");
  const [architectureFilter, setArchitectureFilter] = useState("all");
  const [sort, setSort] = useState<MediaResourceSort | "default">("default");
  const [mediaFilters, setMediaFilters] = useState(EMPTY_MEDIA_ASSET_FILTERS);
  const [modelFilters, setModelFilters] = useState(
    EMPTY_MEDIA_LIBRARY_MODEL_FILTERS,
  );
  const [categoryFilterIds, setCategoryFilterIds] = useState<string[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [civitaiOpen, setCivitaiOpen] = useState(false);
  const [civitaiSource, setCivitaiSource] = useState("");
  const [importPath, setImportPath] = useState<string | undefined>();
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(
    openAssetId ?? null,
  );
  const [selectedResourceId, setSelectedResourceId] = useState<string | null>(
    null,
  );
  const [editingResourceId, setEditingResourceId] = useState<string | null>(
    null,
  );
  const editingResource = libraryResource(editingResourceId);
  function libraryResource(id: string | null) {
    return (
      catalog.models.find((model) => model.id === id) ??
      catalog.addons.find((addon) => addon.id === id) ??
      null
    );
  }
  const editResource = (id: string) => {
    setSelectedResourceId(null);
    setSelectedAssetId(null);
    setEditingResourceId(id);
  };
  const resourceMetadata = (id: string): MediaGenerationAssetMetadata => {
    const resource = libraryResource(id);
    const addon = resource && "kind" in resource ? resource : null;
    return {
      ...createEmptyMediaGenerationAssetMetadata(),
      ...metadata[id],
      triggerWords: addon
        ? addon.kind === "textual-inversion"
          ? (addon.defaultToken ?? "")
          : normalizeMediaTriggerWords(addon.triggerWords)
        : (metadata[id]?.triggerWords ?? ""),
      sourceUrl: metadata[id]
        ? metadata[id].sourceUrl
        : (addon?.sourceUrl ??
          (resource && "lifecycleSourceUrl" in resource
            ? resource.lifecycleSourceUrl
            : null) ??
          null),
    };
  };
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
    ? resourceMetadata(selectedResourceId)
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
  const resourceFilters = {
    query,
    tag: tagFilter,
    categoryId: "all",
    sort: sort === "default" ? ("name" as const) : sort,
  };
  const resourceTypesOnly = ["model", "lora", "embedding"].includes(filter);
  const mediaFilterCount = Object.entries(mediaFilters).filter(
    ([key, value]) =>
      value !== EMPTY_MEDIA_ASSET_FILTERS[key as keyof typeof mediaFilters],
  ).length;
  const activeFilterCount =
    Number(query.trim().length > 0) +
    Number(tagFilter !== "all") +
    Number(categoryFilterIds.length > 0) +
    (resourceTypesOnly
      ? Number(architectureFilter !== "all")
      : mediaFilterCount) +
    (filter === "model"
      ? Number(modelFilters.target !== "all") +
        Number(modelFilters.readiness !== "all")
      : 0);
  const showResources = resourceTypesOnly || mediaFilterCount === 0;
  const matchesArchitecture = (architecture: string | null): boolean =>
    !resourceTypesOnly ||
    architectureFilter === "all" ||
    architecture === architectureFilter;
  const visibleModels =
    showResources && (filter === "all" || filter === "model")
      ? discoverMediaResources(
          libraryModels,
          metadata,
          categories,
          resourceFilters,
        ).filter(
          (model) =>
            matchesCategoryFilter(model.id) &&
            matchesArchitecture(model.architecture) &&
            (filter !== "model" ||
              ((modelFilters.target === "all" ||
                model.target === modelFilters.target) &&
                (modelFilters.readiness === "all" ||
                  isMediaModelReady(model) ===
                    (modelFilters.readiness === "ready")))),
        )
      : [];
  const visibleAddons =
    showResources && ["all", "lora", "embedding"].includes(filter)
      ? discoverMediaResources(
          catalog.addons,
          metadata,
          categories,
          resourceFilters,
        ).filter(
          (addon) =>
            matchesCategoryFilter(addon.id) &&
            matchesArchitecture(addon.architecture) &&
            (filter === "all" ||
              (filter === "lora"
                ? addon.kind === "lora"
                : addon.kind === "textual-inversion")),
        )
      : [];
  const visibleMedia = discoverMediaResources(assets, metadata, categories, {
    ...resourceFilters,
    sort: sort === "default" ? "newest" : sort,
  }).filter(
    (asset) =>
      matchesCategoryFilter(asset.id) &&
      matchesMediaAssetFilters(asset, mediaFilters) &&
      (filter === "all"
        ? asset.kind !== "report"
        : filter === "svg"
          ? asset.kind === "vector"
          : asset.kind === filter),
  );
  const mediaGroups = [
    {
      id: "generated",
      label: "Generations",
      assets: visibleMedia.filter(
        (asset) => mediaAssetOrigin(asset) === "generated",
      ),
    },
    {
      id: "added",
      label: "Uploads and imports",
      assets: visibleMedia.filter(
        (asset) => mediaAssetOrigin(asset) === "added",
      ),
    },
  ];
  const filteredTypeResources =
    filter === "model"
      ? libraryModels
      : filter === "lora" || filter === "embedding"
        ? catalog.addons.filter(
            (addon) =>
              addon.kind === (filter === "lora" ? "lora" : "textual-inversion"),
          )
        : filter === "all"
          ? [...libraryModels, ...catalog.addons, ...assets]
          : assets.filter(
              (asset) => asset.kind === (filter === "svg" ? "vector" : filter),
            );
  const availableTags = listMediaResourceTags(filteredTypeResources, metadata);
  const architectures = [
    ...new Set(
      filteredTypeResources.flatMap((resource) =>
        "architecture" in resource && resource.architecture
          ? [resource.architecture]
          : [],
      ),
    ),
  ].sort();
  const totalVisible =
    visibleModels.length + visibleAddons.length + visibleMedia.length;
  const formats = [
    ...new Set(
      assets
        .filter(
          (asset) =>
            asset.kind !== "report" &&
            (filter === "all" ||
              asset.kind === (filter === "svg" ? "vector" : filter)),
        )
        .map((asset) => asset.mimeType),
    ),
  ].sort();
  const clearFilters = () => {
    setQuery("");
    setTagFilter("all");
    setCategoryFilterIds([]);
    setArchitectureFilter("all");
    setMediaFilters(EMPTY_MEDIA_ASSET_FILTERS);
    setModelFilters(EMPTY_MEDIA_LIBRARY_MODEL_FILTERS);
  };

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
      setTagFilter("all");
      setArchitectureFilter("all");
      setSort("default");
      setMediaFilters(EMPTY_MEDIA_ASSET_FILTERS);
      setModelFilters(EMPTY_MEDIA_LIBRARY_MODEL_FILTERS);
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
    setTagFilter("all");
    setArchitectureFilter("all");
    setSort("default");
    setMediaFilters(EMPTY_MEDIA_ASSET_FILTERS);
    setModelFilters(EMPTY_MEDIA_LIBRARY_MODEL_FILTERS);
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

  const [installModel, setInstallModel] = useState<MediaModelDescriptor | null>(
    null,
  );
  const closeInstall = useCallback(() => setInstallModel(null), []);
  const installed = useCallback(async () => {
    await onRefreshModels();
    if (installModel) onVerifyModel(installModel);
  }, [onRefreshModels, onVerifyModel, installModel]);
  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-950">
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-800/80 px-5 py-3">
        <div className="relative min-w-56 flex-1 max-w-xl">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search assets"
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
        <select
          aria-label="Asset tag"
          value={tagFilter}
          onChange={(event) => setTagFilter(event.target.value)}
          className="h-10 max-w-48 rounded-xl border border-slate-700 bg-slate-950 px-2 text-xs text-slate-200"
        >
          <option value="all">All tags</option>
          {tagFilter !== "all" && !availableTags.includes(tagFilter) ? (
            <option value={tagFilter}>{tagFilter}</option>
          ) : null}
          {availableTags.map((tag) => (
            <option key={tag} value={tag}>
              {tag}
            </option>
          ))}
        </select>
        <select
          aria-label="Sort assets"
          value={sort}
          onChange={(event) =>
            setSort(event.target.value as MediaResourceSort | "default")
          }
          className="h-10 rounded-xl border border-slate-700 bg-slate-950 px-2 text-xs text-slate-200"
        >
          <option value="default">
            {filter === "all"
              ? "Default order"
              : resourceTypesOnly
                ? "Name A–Z"
                : "Newest first"}
          </option>
          {!resourceTypesOnly ? <option value="name">Name A–Z</option> : null}
          <option value="name-desc">Name Z–A</option>
          {filter !== "model" ? (
            <>
              {resourceTypesOnly || filter === "all" ? (
                <option value="newest">Newest first</option>
              ) : null}
              <option value="oldest">Oldest first</option>
              <option value="largest">Largest files first</option>
              <option value="smallest">Smallest files first</option>
            </>
          ) : null}
        </select>
        <Button
          type="button"
          onClick={() => {
            setImportPath(undefined);
            setImportOpen(true);
          }}
          disabled={!importSupported}
        >
          <Import className="h-4 w-4" /> Import
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setCivitaiSource("");
            setCivitaiOpen(true);
          }}
        >
          Browse Civitai
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onScanModels}
          disabled={importLoading}
        >
          Scan models
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
      <MediaImportJobs onOpen={showResource} />
      <div className="flex gap-2 overflow-x-auto border-b border-slate-800/70 px-5 py-2">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={filter === item.id}
            onClick={() => {
              setFilter(item.id);
              setSort("default");
              setArchitectureFilter("all");
              setMediaFilters(EMPTY_MEDIA_ASSET_FILTERS);
              setModelFilters(EMPTY_MEDIA_LIBRARY_MODEL_FILTERS);
            }}
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

      <MediaAssetsFilters
        type={filter}
        media={mediaFilters}
        onMediaChange={setMediaFilters}
        models={modelFilters}
        onModelsChange={setModelFilters}
        formats={formats}
        architecture={architectureFilter}
        onArchitectureChange={setArchitectureFilter}
        architectures={architectures.map((architecture) => ({
          id: architecture,
          label:
            libraryModels.find((model) => model.architecture === architecture)
              ?.family ?? architecture,
        }))}
        activeCount={activeFilterCount}
        onClear={clearFilters}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {discoveredFiles.some((file) => file.status === "importable") &&
        showResources &&
        ["all", "model", "lora", "embedding"].includes(filter) ? (
          <details className="mb-4 rounded-xl border border-slate-800 p-3">
            <summary className="cursor-pointer text-sm text-slate-300">
              Workspace files
            </summary>
            {discoveredFiles
              .filter(
                (file) =>
                  file.status === "importable" &&
                  resourceMatches([file.displayName, file.relativePath], query),
              )
              .sort((left, right) =>
                left.displayName.localeCompare(right.displayName, undefined, {
                  numeric: true,
                  sensitivity: "base",
                }),
              )
              .map((file) => (
                <div key={file.path} className="mt-3 flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-300">
                    {file.relativePath}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={importLoading}
                    onClick={() => {
                      setImportPath(file.path);
                      setImportOpen(true);
                    }}
                  >
                    Import {file.displayName}
                  </Button>
                </div>
              ))}
          </details>
        ) : null}
        {totalVisible === 0 ? (
          <div className="flex min-h-72 items-center justify-center rounded-2xl border border-dashed border-slate-800 text-sm text-slate-500">
            {activeFilterCount > 0 ? "No matching assets" : "Import an asset"}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 2xl:grid-cols-4">
            {filter === "all" && visibleModels.length > 0 ? (
              <h2 className="col-span-full text-sm font-medium text-slate-300">
                Models
              </h2>
            ) : null}
            {visibleModels.map((model) => {
              const ready = isMediaModelReady(model);
              const readiness = describeMediaModelReadiness(model);
              const categorySummary = categoryNamesFor(model.id).join(", ");
              return (
                <ContextActionMenu
                  key={model.id}
                  label="Model actions"
                  actions={[
                    {
                      label: "Edit",
                      icon: Pencil,
                      onSelect: () => editResource(model.id),
                    },
                    {
                      label: "Copy name",
                      icon: Copy,
                      onSelect: () => copyText(model.displayName),
                    },
                  ]}
                >
                  <article
                    ref={(element) => {
                      cardRefs.current[model.id] = element;
                    }}
                    className={cn(
                      "relative overflow-hidden rounded-2xl border bg-slate-900/55",
                      selectedResourceId === model.id
                        ? "border-sky-400"
                        : "border-slate-800",
                    )}
                  >
                    <button
                      type="button"
                      aria-label={`Actions for ${model.displayName}`}
                      aria-haspopup="menu"
                      onClick={openContextMenuFromButton}
                      className="absolute right-2 top-2 z-10 rounded-lg bg-slate-950/85 p-1.5 text-slate-200 hover:bg-slate-900"
                    >
                      <MoreVertical className="h-4 w-4" />
                    </button>
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
                          {categorySummary ||
                            (model.runtimeReadiness === "runtime-unavailable"
                              ? model.family
                              : readiness?.action) ||
                            model.family}
                        </p>
                      </div>
                      {!model.installed &&
                      model.management.acquisition === "managed-install" ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="w-full"
                          onClick={() => setInstallModel(model)}
                          disabled={!importSupported}
                        >
                          Install model
                        </Button>
                      ) : ready ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => onUseModel(model)}
                          disabled={setupActive && model.target === "local"}
                          className="w-full"
                        >
                          Use model
                        </Button>
                      ) : model.runtimeReadiness === "runtime-unavailable" &&
                        !runtimeReady &&
                        model.providerId === "local-diffusers" ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={onSetupRuntime}
                          disabled={setupActive || !importSupported}
                          className="w-full"
                        >
                          {setupLabel}
                        </Button>
                      ) : model.runtimeReadiness !== "runtime-unavailable" &&
                        model.installed &&
                        model.management.verification !== "none" ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => onVerifyModel(model)}
                          disabled={setupActive || verifyingModelId !== null}
                          className="w-full"
                        >
                          {verifyingModelId === model.id
                            ? "Verifying…"
                            : "Verify model"}
                        </Button>
                      ) : null}
                    </div>
                  </article>
                </ContextActionMenu>
              );
            })}
            {filter === "all" && visibleAddons.length > 0 ? (
              <h2 className="col-span-full text-sm font-medium text-slate-300">
                LoRAs and embeddings
              </h2>
            ) : null}
            {visibleAddons.map((addon) => {
              const compatible = addonCompatible(addon.id);
              return (
                <ContextActionMenu
                  key={addon.id}
                  label="Model actions"
                  actions={[
                    {
                      label: "Edit",
                      icon: Pencil,
                      onSelect: () => editResource(addon.id),
                    },
                    {
                      label: "Copy name",
                      icon: Copy,
                      onSelect: () => copyText(addon.displayName),
                    },
                  ]}
                >
                  <article
                    ref={(element) => {
                      cardRefs.current[addon.id] = element;
                    }}
                    className={cn(
                      "relative overflow-hidden rounded-2xl border bg-slate-900/55",
                      selectedResourceId === addon.id
                        ? "border-sky-400"
                        : "border-slate-800",
                    )}
                  >
                    <button
                      type="button"
                      aria-label={`Actions for ${addon.displayName}`}
                      aria-haspopup="menu"
                      onClick={openContextMenuFromButton}
                      className="absolute right-2 top-2 z-10 rounded-lg bg-slate-950/85 p-1.5 text-slate-200 hover:bg-slate-900"
                    >
                      <MoreVertical className="h-4 w-4" />
                    </button>
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
                </ContextActionMenu>
              );
            })}
            {mediaGroups
              .filter((group) => group.assets.length > 0)
              .map((group) => (
                <Fragment key={group.id}>
                  <h2 className="col-span-full text-sm font-medium text-slate-300">
                    {group.label}
                  </h2>
                  {group.assets.map((asset) => (
                    <ContextActionMenu
                      key={asset.id}
                      label="Asset actions"
                      actions={[
                        {
                          label: "Copy name",
                          icon: Copy,
                          onSelect: () => copyText(mediaAssetLabel(asset)),
                        },
                        {
                          label: "Copy asset ID",
                          icon: Copy,
                          onSelect: () => copyText(asset.id),
                        },
                        ...(asset.kind === "image"
                          ? [
                              {
                                label: "Edit image",
                                onSelect: () => onEditImage(asset),
                              },
                              {
                                label: "Use as reference",
                                onSelect: () => onUseAsReference(asset),
                              },
                              {
                                label: "Animate image",
                                onSelect: () => onAnimateImage(asset),
                              },
                              {
                                label: "Animate in Advanced",
                                onSelect: () => onOpenVideoAsFlow(asset),
                              },
                            ]
                          : []),
                        ...(asset.operation?.kind !== "local-import"
                          ? [
                              {
                                label: "View settings",
                                onSelect: () => onInspectSettings(asset.runId),
                              },
                              {
                                label: "Reuse settings",
                                onSelect: () => onReuseSettings(asset.runId),
                              },
                            ]
                          : []),
                        {
                          label: "Delete asset",
                          icon: Trash2,
                          destructive: true,
                          onSelect: () => requestAssetDeletion(asset.id),
                        },
                      ]}
                    >
                      <article
                        tabIndex={-1}
                        ref={(element) => {
                          cardRefs.current[asset.id] = element;
                        }}
                        className={cn(
                          "relative overflow-hidden rounded-2xl border bg-slate-900/55",
                          selectedAssetId === asset.id
                            ? "border-sky-400"
                            : "border-slate-800",
                        )}
                      >
                        <ControlTooltip content="Asset actions">
                          <button
                            type="button"
                            aria-label="Asset actions"
                            aria-haspopup="menu"
                            onClick={openContextMenuFromButton}
                            className="absolute right-2 top-2 z-10 rounded-lg bg-slate-950/85 p-1.5 text-slate-200 hover:bg-slate-900"
                          >
                            <MoreVertical className="h-4 w-4" />
                          </button>
                        </ControlTooltip>
                        <button
                          type="button"
                          aria-label={`View ${mediaAssetLabel(asset)}`}
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
                          <time
                            dateTime={asset.createdAt}
                            className="block text-xs text-slate-500"
                          >
                            {new Date(asset.createdAt).toLocaleString()}
                          </time>
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
                                Use as reference
                              </Button>
                            ) : null}
                            {asset.kind === "image" ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => onAnimateImage(asset)}
                                aria-label="Animate image"
                              >
                                <Play className="h-4 w-4" />
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      </article>
                    </ContextActionMenu>
                  ))}
                </Fragment>
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
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => {
                if (selectedResourceId) editResource(selectedResourceId);
              }}
            >
              <Pencil className="h-4 w-4" /> Edit details
            </Button>
            {selectedResourceId && metadata[selectedResourceId]?.sourceUrl &&
            isMediaCivitaiSourceUrl(metadata[selectedResourceId]!.sourceUrl!) ? (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => {
                  setCivitaiSource(metadata[selectedResourceId]!.sourceUrl!);
                  setSelectedResourceId(null);
                  setCivitaiOpen(true);
                }}
              >
                Browse versions on Civitai
              </Button>
            ) : null}
            {selectedResourceModel?.installed &&
            ["managed-install", "file-import"].includes(
              selectedResourceModel.management.acquisition,
            ) ? (
              <MediaRemoveResourceButton
                key={selectedResourceModel.id}
                id={selectedResourceModel.id}
                kind="model"
                disabled={verifyingModelId !== null}
                onRemoved={async () => {
                  setSelectedResourceId(null);
                  await onRefreshModels(selectedResourceModel.id);
                }}
              />
            ) : selectedResourceAddon ? (
              <MediaRemoveResourceButton
                key={selectedResourceAddon.id}
                id={selectedResourceAddon.id}
                kind="addon"
                onRemoved={async () => {
                  setSelectedResourceId(null);
                  await onRefreshModels(selectedResourceAddon.id);
                }}
              />
            ) : null}
            {selectedResourceModel &&
            isMediaModelReady(selectedResourceModel) ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onUseModel(selectedResourceModel)}
                disabled={
                  setupActive && selectedResourceModel.target === "local"
                }
                className="w-full"
              >
                Use model
              </Button>
            ) : selectedResourceModel && selectedModelReadiness ? (
              <div className="space-y-2">
                <p className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-[10px] leading-4 text-amber-100">
                  {selectedResourceModel.runtimeReadiness ===
                  "runtime-unavailable"
                    ? runtimeReady
                      ? "This model cannot run on this computer."
                      : "Set up Media Studio to use local models."
                    : selectedModelReadiness.message}
                </p>
                {selectedResourceModel.runtimeReadinessDiagnostic ? (
                  <details className="text-xs text-slate-400">
                    <summary className="cursor-pointer">Show details</summary>
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words">
                      {selectedResourceModel.runtimeReadinessDiagnostic}
                    </pre>
                  </details>
                ) : null}
                {!selectedResourceModel.installed &&
                selectedResourceModel.management.acquisition ===
                  "managed-install" ? (
                  <Button
                    type="button"
                    className="w-full"
                    onClick={() => setInstallModel(selectedResourceModel)}
                    disabled={!importSupported}
                  >
                    Install model
                  </Button>
                ) : selectedResourceModel.runtimeReadiness ===
                    "runtime-unavailable" &&
                  !runtimeReady &&
                  selectedResourceModel.providerId === "local-diffusers" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onSetupRuntime}
                    disabled={setupActive || !importSupported}
                    className="w-full"
                  >
                    {setupLabel}
                  </Button>
                ) : selectedResourceModel.runtimeReadiness !==
                    "runtime-unavailable" &&
                  selectedResourceModel.installed &&
                  selectedResourceModel.management.verification !== "none" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onVerifyModel(selectedResourceModel)}
                    disabled={setupActive || verifyingModelId !== null}
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

      {editingResource ? (
        <MediaModelEditDialog
          key={editingResource.id}
          resource={editingResource}
          metadata={resourceMetadata(editingResource.id)}
          categories={categories}
          assets={assets}
          onSave={(request, nextMetadata) =>
            onSaveResource(editingResource.id, request, nextMetadata)
          }
          onImportMedia={onImportMedia}
          onImportSampleUrl={onImportSampleUrl}
          onManageCategories={() => setCategoryManagerOpen(true)}
          onClose={() => setEditingResourceId(null)}
        />
      ) : null}

      {installModel ? (
        <MediaModelInstallDialog
          model={installModel}
          onClose={closeInstall}
          onInstalled={installed}
        />
      ) : null}
      {selectedAsset && selectedAssetMetadata ? (
        <MediaAssetDetailsDialog
          asset={selectedAsset}
          onClose={() => setSelectedAssetId(null)}
          onEdit={onEditImage}
          onUseAsReference={onUseAsReference}
          onAnimate={onAnimateImage}
          onInspectSettings={onInspectSettings}
          onReuseSettings={onReuseSettings}
        >
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
        </MediaAssetDetailsDialog>
      ) : null}

      {civitaiOpen ? (
        <CivitaiBrowserDialog
          onClose={() => setCivitaiOpen(false)}
          initialSource={civitaiSource}
          onImportSampleUrl={onImportSampleUrl}
          onImportModel={onImportModel}
          onImportAddon={onImportAddon}
          installedHashes={new Set(
            [
              ...catalog.models.map((model) => model.installedRevision),
              ...catalog.addons.map((addon) => addon.digest),
            ]
              .filter((value): value is string => Boolean(value))
              .map((value) => value.toLowerCase()),
          )}
        />
      ) : null}
      {importOpen ? (
        <MediaAssetImportDialog
          initialPath={importPath}
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
