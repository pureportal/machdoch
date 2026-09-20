import { useEffect, useRef, useState } from "react";
import {
  Download,
  ImageOff,
  Settings,
  LoaderCircle,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  CIVITAI_DEFAULT_SEARCH,
  civitaiModelUrl,
  civitaiRequestedVersion,
  civitaiVisibleImages,
  isCivitaiLookup,
  type CivitaiContentMode,
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
import { civitaiRuntime } from "../civitai-runtime";
import {
  CivitaiModelDetail,
  type CivitaiImportActions,
} from "./civitai-model-detail";

import { SearchableSelect } from "../../components/ui/searchable-select";
import {
  loadCivitaiPreferences,
  saveCivitaiPreferences,
} from "../civitai-preferences";
import { CivitaiSettingsPanel } from "./civitai-settings-panel";

const fieldClass =
  "h-10 min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 outline-none focus:border-sky-400";
const numberFormat = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function CivitaiBrowserDialog({
  onClose,
  initialSource = "",
  installedHashes,
  ...importActions
}: CivitaiImportActions & {
  initialSource?: string;
  onClose: () => void;
  installedHashes: ReadonlySet<string>;
}) {
  const [filters, setFilters] = useState<CivitaiSearch>({
    ...CIVITAI_DEFAULT_SEARCH,
  });
  const [ready, setReady] = useState(false);
  const [options, setOptions] = useState<CivitaiOptions>({
    modelTypes: [],
    baseModels: [],
    baseModelsByType: {},
  });
  const baseModels = filters.modelType
    ? (options.baseModelsByType[filters.modelType] ?? [])
    : options.baseModels;
  const [query, setQuery] = useState(initialSource);
  const [items, setItems] = useState<CivitaiModel[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<CivitaiModel | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
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
        setAdvanced(
          Boolean(
            restored.tag ||
            restored.username ||
            restored.favorites ||
            restored.period !== "AllTime",
          ),
        );
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
      setCursor(null);
      setSelected(null);
    }
    try {
      if (isCivitaiLookup(request.query)) {
        const model = await civitaiRuntime.getModel(
          request.query.trim(),
          request.contentMode !== "normal",
        );
        if (sequence.current !== requestId) return;
        if (request.contentMode === "mature" && !model.nsfw) return;
        setItems([model]);
        setSelected(model);
        setSelectedVersion(
          model.matchedVersionId ?? civitaiRequestedVersion(request.query),
        );
        setCursor(null);
      } else {
        let page = await civitaiRuntime.search(request);
        const visited = new Set([request.cursor]);
        for (let scanned = 1; ; scanned++) {
          if (sequence.current !== requestId) return;
          if (page.nextCursor && visited.has(page.nextCursor)) {
            throw new Error(
              "Civitai repeated a results page. Try searching again.",
            );
          }
          if (page.items.length > 0 || !page.nextCursor || scanned >= 5) break;
          visited.add(page.nextCursor);
          page = await civitaiRuntime.search({
            ...request,
            cursor: page.nextCursor,
          });
        }
        if (sequence.current !== requestId) return;
        setItems((previous) =>
          append
            ? [
                ...previous,
                ...page.items.filter(
                  (item) =>
                    !previous.some((existing) => existing.id === item.id),
                ),
              ]
            : page.items,
        );
        setCursor(page.nextCursor);
      }
    } catch (failure) {
      if (sequence.current === requestId) setError((failure as Error).message);
    } finally {
      if (sequence.current === requestId) setLoading(false);
    }
  };

  useEffect(() => {
    if (ready && !selected) void load(filters);
  }, [filters, refresh, ready]);

  const update = (patch: Partial<CivitaiSearch>) =>
    setFilters((value) => ({ ...value, ...patch, cursor: null }));

  const hasFilters =
    filters.modelType ||
    filters.baseModel ||
    filters.tag ||
    filters.username ||
    filters.favorites ||
    filters.sort !== CIVITAI_DEFAULT_SEARCH.sort ||
    filters.period !== CIVITAI_DEFAULT_SEARCH.period;
  const clearFilters = () =>
    setFilters({
      ...CIVITAI_DEFAULT_SEARCH,
      query: filters.query,
      contentMode: filters.contentMode,
    });

  const openModel = async (model: CivitaiModel) => {
    const requestId = ++sequence.current;
    setLoading(true);
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
      if (sequence.current === requestId) setLoading(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchInput.current?.focus();
        }}
        className="flex h-[min(850px,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden border-slate-700 bg-slate-950 p-0 text-slate-100 sm:max-w-6xl"
      >
        <DialogHeader className="shrink-0 border-b border-slate-800 px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <DialogTitle>Civitai</DialogTitle>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label="Civitai settings"
                onClick={() => setConnectionOpen((value) => !value)}
              >
                <Settings className="h-4 w-4" />
                Settings
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Close Civitai"
                disabled={busy}
                onClick={onClose}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </DialogHeader>
        {!selected && (
          <form
            className="shrink-0 space-y-3 border-b border-slate-800 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              update({ query: query.trim() });
            }}
          >
            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" />
                <input
                  ref={searchInput}
                  aria-label="Search Civitai"
                  placeholder="Search models, paste a Civitai link or SHA-256"
                  className={`${fieldClass} w-full pl-9`}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <Button type="submit">Search</Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <SearchableSelect
                label="Resource type"
                className="flex-[1_1_9rem] sm:max-w-48"
                value={filters.modelType}
                options={[
                  { value: "", label: "All types" },
                  ...options.modelTypes.map((value) => ({
                    value,
                    label:
                      (
                        {
                          Checkpoint: "Checkpoint",
                          LORA: "LoRA",
                          TextualInversion: "Embedding",
                        } as Record<string, string>
                      )[value] ?? value,
                  })),
                ]}
                onChange={(modelType) => {
                  const models = modelType
                    ? (options.baseModelsByType[modelType] ?? [])
                    : options.baseModels;
                  update({
                    modelType,
                    baseModel: models.includes(filters.baseModel)
                      ? filters.baseModel
                      : "",
                  });
                }}
              />
              <SearchableSelect
                label="Base model"
                className="flex-[1_1_10rem] sm:max-w-56"
                value={filters.baseModel}
                options={[
                  { value: "", label: "All base models" },
                  ...baseModels.map((value) => ({ value, label: value })),
                ]}
                onChange={(baseModel) => update({ baseModel })}
              />
              <SearchableSelect
                label="Sort Civitai results"
                className="flex-[1_1_10rem] sm:max-w-48"
                value={filters.sort}
                options={["Most Downloaded", "Highest Rated", "Newest"].map(
                  (value) => ({ value, label: value }),
                )}
                onChange={(sort) => update({ sort })}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={advanced}
                onClick={() => setAdvanced((value) => !value)}
              >
                <SlidersHorizontal className="h-4 w-4" /> Filters
              </Button>
              {hasFilters && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={clearFilters}
                >
                  Clear filters
                </Button>
              )}
              <select
                aria-label="Content"
                className={`${fieldClass} ml-auto flex-[1_1_10rem] sm:max-w-48`}
                value={filters.contentMode}
                onChange={(event) =>
                  update({
                    contentMode: event.target.value as CivitaiContentMode,
                  })
                }
              >
                <option value="normal">Normal</option>
                <option value="all">Normal + Mature</option>
                <option value="mature">Mature only</option>
              </select>
            </div>
            {advanced && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <label className="grid gap-1 text-xs text-slate-400">
                  Period
                  <SearchableSelect
                    label="Period"
                    value={filters.period}
                    options={[
                      ["AllTime", "All time"],
                      ["Year", "Year"],
                      ["Month", "Month"],
                      ["Week", "Week"],
                      ["Day", "Today"],
                    ].map(([value, label]) => ({ value, label }))}
                    onChange={(period) => update({ period })}
                  />
                </label>
                <label className="grid gap-1 text-xs text-slate-400">
                  Tag
                  <input
                    className={fieldClass}
                    key={`tag:${filters.tag}`}
                    defaultValue={filters.tag}
                    onBlur={(event) => {
                      if (event.target.value !== filters.tag)
                        update({ tag: event.target.value });
                    }}
                  />
                </label>
                <label className="grid gap-1 text-xs text-slate-400">
                  Creator
                  <input
                    className={fieldClass}
                    key={`username:${filters.username}`}
                    defaultValue={filters.username}
                    onBlur={(event) => {
                      if (event.target.value !== filters.username)
                        update({ username: event.target.value });
                    }}
                  />
                </label>
                <label className="flex items-end gap-2 pb-2 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={filters.favorites}
                    onChange={(event) => {
                      if (!connected) {
                        setConnectionOpen(true);
                        return;
                      }
                      update({ favorites: event.target.checked });
                    }}
                    className="accent-sky-400"
                  />{" "}
                  My favorites
                </label>
              </div>
            )}
          </form>
        )}
        <div
          className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5"
          aria-busy={loading}
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
              mature={filters.contentMode !== "normal"}
              installedHashes={installedHashes}
              onBack={() => {
                setSelected(null);
                setError(null);
              }}
              onBusyChange={setBusy}
              onOpenSettings={() => setConnectionOpen(true)}
              connectionRevision={refresh}
              onImported={onClose}
              {...importActions}
            />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
                {items.map((model) => {
                  const version = model.modelVersions[0];
                  const preview = civitaiVisibleImages(
                    model,
                    version,
                    filters.contentMode !== "normal",
                  )[0];
                  const installed = version?.files.some(
                    (file) =>
                      file.hashes?.SHA256 &&
                      installedHashes.has(file.hashes.SHA256.toLowerCase()),
                  );
                  return (
                    <button
                      key={model.id}
                      onClick={() => void openModel(model)}
                      aria-label={`View ${model.name}`}
                      className="group overflow-hidden rounded-xl border border-slate-800 bg-slate-900/50 text-left transition hover:border-sky-400/60 focus-visible:outline-2 focus-visible:outline-sky-400"
                    >
                      <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-slate-900">
                        {preview ? (
                          <img
                            src={preview.url}
                            alt=""
                            loading="lazy"
                            referrerPolicy="no-referrer"
                            className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                          />
                        ) : (
                          <ImageOff className="h-8 w-8 text-slate-600" />
                        )}
                        {installed && (
                          <span className="absolute bottom-2 left-2 rounded-md bg-slate-950/90 px-2 py-1 text-[11px] text-emerald-300">
                            In library
                          </span>
                        )}
                      </div>
                      <div className="space-y-1.5 p-3">
                        <p className="line-clamp-2 min-h-10 text-sm font-medium text-slate-100">
                          {model.name}
                        </p>
                        <p className="truncate text-xs text-slate-400">
                          {model.creator?.username ?? model.type}
                        </p>
                        <div className="flex flex-wrap items-center justify-between gap-1 text-[11px] text-slate-400">
                          <span>{version?.baseModel ?? model.type}</span>
                          {model.stats?.downloadCount !== null &&
                            model.stats?.downloadCount !== undefined && (
                              <span className="flex items-center gap-1">
                                <Download className="h-3 w-3" />
                                {numberFormat.format(model.stats.downloadCount)}
                              </span>
                            )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
              {loading && (
                <div
                  role="status"
                  aria-label="Loading Civitai models"
                  className="flex min-h-40 items-center justify-center gap-2 text-sm text-slate-400"
                >
                  <LoaderCircle className="h-5 w-5 animate-spin" /> Loading
                  models…
                </div>
              )}
              {!loading && !error && !cursor && items.length === 0 && (
                <div className="flex min-h-56 flex-col items-center justify-center gap-3 text-sm text-slate-400">
                  <Search className="h-8 w-8 text-slate-600" />
                  <p>No matching models</p>
                </div>
              )}
              {cursor && !loading && !error && (
                <div className="flex justify-center pt-5">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void load({ ...filters, cursor }, true)}
                  >
                    {items.length === 0 ? "Search more" : "Load more"}
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
              <DialogTitle>Civitai settings</DialogTitle>
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
