import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LoaderCircle, Search, Settings, X } from "lucide-react";
import type { MediaModelDescriptor } from "../../../../core/media/contracts.js";
import {
  CIVITAI_DEFAULT_SEARCH,
  civitaiModelUrl,
  civitaiRequestedVersion,
  isCivitaiLookup,
  type CivitaiModel,
  type CivitaiOptions,
  type CivitaiSearch,
} from "../../../../core/media/civitai.js";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { CivitaiSearchResults } from "../civitai-search-results";
import { civitaiRuntime } from "../civitai-runtime";
import {
  CivitaiModelDetail,
  type CivitaiImportActions,
} from "./civitai-model-detail";
import {
  loadCivitaiPreferences,
  saveCivitaiPreferences,
} from "../civitai-preferences";
import { CivitaiSettingsPanel } from "./civitai-settings-panel";
import {
  CivitaiSearchFilters,
  civitaiBaseModelsForType,
} from "./civitai-search-filters";
import {
  CivitaiResultCard,
  CivitaiResultSkeleton,
} from "./civitai-result-card";

const hasNarrowingFilters = (filters: CivitaiSearch): boolean =>
  Boolean(
    filters.modelType ||
      filters.baseModel ||
      filters.tag ||
      filters.username ||
      filters.favorites ||
      filters.period !== CIVITAI_DEFAULT_SEARCH.period,
  );

export function CivitaiBrowserDialog({
  onClose,
  initialSource = "",
  installedHashes,
  installedModels,
  ...importActions
}: CivitaiImportActions & {
  initialSource?: string;
  onClose: () => void;
  installedHashes: ReadonlySet<string>;
  installedModels: readonly MediaModelDescriptor[];
}) {
  const [filters, setFilters] = useState<CivitaiSearch>({
    ...CIVITAI_DEFAULT_SEARCH,
  });
  const [ready, setReady] = useState(false);
  const [options, setOptions] = useState<CivitaiOptions>({
    modelTypes: [],
    baseModels: [],
    baseModelsByType: {},
    baseModelArchitectures: {},
  });
  const [query, setQuery] = useState(initialSource);
  const [items, setItems] = useState<CivitaiModel[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const results = useRef<CivitaiSearchResults | null>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const resultsScroll = useRef(0);
  const openedModel = useRef<number | null>(null);
  const loadMore = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<CivitaiModel | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [opening, setOpening] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const sequence = useRef(0);
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void loadCivitaiPreferences()
      .then((saved) => {
        if (!active) return;
        const restored: CivitaiSearch = initialSource
          ? {
              ...saved,
              query: initialSource,
              contentMode:
                saved.contentMode === "normal" &&
                initialSource.includes("civitai.red")
                  ? "all"
                  : saved.contentMode,
            }
          : saved;
        setFilters(restored);
        setQuery(restored.query);
        setReady(true);
      })
      .catch((failure: Error) => {
        if (active) {
          setError(failure.message);
          setReady(true);
        }
      });
    return () => {
      active = false;
    };
  }, [initialSource]);

  useEffect(() => {
    if (!ready) return;
    void saveCivitaiPreferences(filters).then((saved) => {
      if (!saved)
        setError(
          "Could not save Civitai filters. Check your storage and try again.",
        );
    });
  }, [filters, ready]);

  useEffect(() => {
    let active = true;
    void civitaiRuntime
      .options()
      .then((value) => {
        if (active) setOptions(value);
      })
      .catch((failure: Error) => {
        if (active) setError(failure.message);
      });
    void civitaiRuntime
      .connection()
      .then((value) => {
        if (active) setConnected(value);
      })
      .catch((failure: Error) => {
        if (active) setError(failure.message);
      });
    return () => {
      active = false;
      sequence.current++;
    };
  }, [refresh]);

  const load = async (request: CivitaiSearch, append = false) => {
    const requestId = ++sequence.current;
    setLoading(true);
    setError(null);
    if (!append) {
      setItems([]);
      setHasMore(false);
      setSelected(null);
      resultsScroll.current = 0;
      if (scrollArea.current) scrollArea.current.scrollTop = 0;
    }
    try {
      if (isCivitaiLookup(request.query)) {
        const model = await civitaiRuntime.getModel(
          request.query.trim(),
          request.contentMode !== "normal",
        );
        if (sequence.current !== requestId) return;
        setItems([model]);
        setSelected(model);
        setSelectedVersion(
          model.matchedVersionId ?? civitaiRequestedVersion(request.query),
        );
        setHasMore(false);
      } else {
        if (!append || !results.current) {
          results.current = new CivitaiSearchResults(
            request,
            civitaiRuntime.search,
          );
        }
        const page = await results.current.next(
          () => sequence.current === requestId,
        );
        if (sequence.current !== requestId) return;
        setItems((previous) =>
          append ? [...previous, ...page.items] : page.items,
        );
        setHasMore(page.hasMore);
      }
    } catch (failure) {
      if (sequence.current === requestId) setError((failure as Error).message);
    } finally {
      if (sequence.current === requestId) setLoading(false);
    }
  };

  useEffect(() => {
    if (!ready || selected || options.modelTypes.length === 0) return;
    const modelType = options.modelTypes.includes(filters.modelType)
      ? filters.modelType
      : "";
    const baseModel = civitaiBaseModelsForType(options, modelType).includes(
      filters.baseModel,
    )
      ? filters.baseModel
      : "";
    if (modelType !== filters.modelType || baseModel !== filters.baseModel) {
      setFilters({ ...filters, modelType, baseModel, cursor: null });
      return;
    }
    void load(filters);
  }, [filters, refresh, ready, options]);

  useEffect(() => {
    if (!hasMore || loading || error || selected || !loadMore.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) void load(filters, true);
      },
      { root: scrollArea.current, rootMargin: "400px" },
    );
    observer.observe(loadMore.current);
    return () => observer.disconnect();
  }, [hasMore, loading, error, selected, filters]);

  const update = (patch: Partial<CivitaiSearch>) =>
    setFilters((value) => ({ ...value, ...patch, cursor: null }));

  const resetFilters = () =>
    update({
      ...CIVITAI_DEFAULT_SEARCH,
      query: filters.query,
      contentMode: filters.contentMode,
    });

  const openModel = async (model: CivitaiModel) => {
    const requestId = ++sequence.current;
    resultsScroll.current = scrollArea.current?.scrollTop ?? 0;
    openedModel.current = model.id;
    setOpening(model.id);
    setError(null);
    try {
      const detail = await civitaiRuntime.getModel(
        civitaiModelUrl(model, model.modelVersions[0]?.id),
        filters.contentMode !== "normal",
      );
      if (sequence.current === requestId) {
        setSelected(detail);
        setSelectedVersion(model.modelVersions[0]?.id ?? null);
      }
    } catch (failure) {
      if (sequence.current === requestId) setError((failure as Error).message);
    } finally {
      if (sequence.current === requestId) setOpening(null);
    }
  };

  const closeModel = () => {
    setSelected(null);
    setError(null);
  };

  useLayoutEffect(() => {
    const area = scrollArea.current;
    if (!area) return;
    area.scrollTop = selected ? 0 : resultsScroll.current;
    if (!selected && openedModel.current !== null)
      area
        .querySelector<HTMLElement>(
          `[data-model-id="${openedModel.current}"]`,
        )
        ?.focus({ preventScroll: true });
  }, [selected]);

  const mature = filters.contentMode !== "normal";
  const firstPage = loading && items.length === 0;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchInput.current?.focus();
        }}
        onEscapeKeyDown={(event) => {
          if (!selected) return;
          event.preventDefault();
          closeModel();
        }}
        className="flex h-[min(900px,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden border-slate-700 bg-slate-950 p-0 text-slate-100 sm:max-w-6xl"
      >
        <DialogHeader className="shrink-0 border-b border-slate-800 px-5 py-3">
          <div className="flex items-center justify-between gap-3">
            <DialogTitle>Civitai</DialogTitle>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Civitai settings"
                onClick={() => setConnectionOpen((value) => !value)}
              >
                <Settings className="h-4 w-4" />
                {connected ? "API key" : "Connect"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Close Civitai"
                onClick={onClose}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </DialogHeader>
        <div hidden={selected !== null} className="shrink-0">
          <CivitaiSearchFilters
            filters={filters}
            options={options}
            query={query}
            connected={connected}
            inputRef={searchInput}
            onQueryChange={setQuery}
            onChange={update}
            onRequireConnection={() => setConnectionOpen(true)}
          />
        </div>
        <div
          ref={scrollArea}
          className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5"
          aria-busy={loading || opening !== null}
        >
          {error && (
            <div
              role="alert"
              className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-rose-500/25 bg-rose-500/5 p-3 text-sm text-rose-200"
            >
              <p className="min-w-0 flex-1">{error}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setRefresh((value) => value + 1)}
                disabled={loading}
              >
                Retry
              </Button>
            </div>
          )}
          {selected ? (
            <CivitaiModelDetail
              key={selected.id}
              model={selected}
              initialVersionId={selectedVersion}
              mature={mature}
              options={options}
              installedHashes={installedHashes}
              installedModels={installedModels}
              onBack={closeModel}
              onOpenSettings={() => setConnectionOpen(true)}
              connectionRevision={refresh}
              {...importActions}
            />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {items.map((model) => (
                  <div key={model.id} className="relative flex">
                    <CivitaiResultCard
                      model={model}
                      mature={mature}
                      installedHashes={installedHashes}
                      onOpen={() => void openModel(model)}
                    />
                    {opening === model.id && (
                      <div
                        role="status"
                        aria-label={`Opening ${model.name}`}
                        className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-slate-950/60"
                      >
                        <LoaderCircle className="h-6 w-6 animate-spin text-sky-300" />
                      </div>
                    )}
                  </div>
                ))}
                {firstPage &&
                  Array.from({ length: 10 }, (_, index) => (
                    <CivitaiResultSkeleton key={index} />
                  ))}
              </div>
              {loading && (
                <div
                  role="status"
                  aria-label="Loading Civitai models"
                  className={
                    firstPage
                      ? "sr-only"
                      : "flex items-center justify-center py-6 text-slate-400"
                  }
                >
                  <LoaderCircle className="h-5 w-5 animate-spin" />
                </div>
              )}
              {!loading && !error && !hasMore && items.length === 0 && (
                <div className="flex min-h-56 flex-col items-center justify-center gap-3 text-sm text-slate-400">
                  <Search className="h-8 w-8 text-slate-600" />
                  <p>No matching models</p>
                  {hasNarrowingFilters(filters) && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={resetFilters}
                    >
                      Reset filters
                    </Button>
                  )}
                </div>
              )}
              {hasMore && !loading && !error && (
                <div ref={loadMore} className="flex justify-center pt-5">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void load(filters, true)}
                  >
                    Load more
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
      {connectionOpen && (
        <Dialog open onOpenChange={setConnectionOpen}>
          <DialogContent
            aria-describedby={undefined}
            className="border-slate-700 bg-slate-950 text-slate-100 sm:max-w-lg"
          >
            <DialogHeader>
              <DialogTitle>Civitai API key</DialogTitle>
            </DialogHeader>
            <CivitaiSettingsPanel
              onChanged={(value) => {
                setConnected(value);
                if (!value) update({ favorites: false });
                setRefresh((revision) => revision + 1);
              }}
            />
          </DialogContent>
        </Dialog>
      )}
    </Dialog>
  );
}
