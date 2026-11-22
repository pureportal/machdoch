import { useEffect, useState, type RefObject } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import {
  CIVITAI_DEFAULT_SEARCH,
  CIVITAI_PERIODS,
  CIVITAI_SORTS,
  civitaiTypeLabel,
  type CivitaiContentMode,
  type CivitaiOptions,
  type CivitaiSearch,
} from "../../../../core/media/civitai.js";
import { Button } from "../../components/ui/button";
import { SearchableSelect } from "../../components/ui/searchable-select";
import { cn } from "../../lib/utils";

const fieldClass =
  "h-10 min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 outline-none focus:border-sky-400";

const CONTENT_MODES: ReadonlyArray<{ value: CivitaiContentMode; label: string }> = [
  { value: "normal", label: "Safe" },
  { value: "all", label: "Safe + mature" },
  { value: "mature", label: "Mature only" },
];

export const civitaiBaseModelsForType = (
  options: CivitaiOptions,
  modelType: string,
): string[] =>
  modelType ? (options.baseModelsByType[modelType] ?? []) : options.baseModels;

export function CivitaiSearchFilters({
  filters,
  options,
  query,
  connected,
  inputRef,
  onQueryChange,
  onChange,
  onRequireConnection,
}: {
  filters: CivitaiSearch;
  options: CivitaiOptions;
  query: string;
  connected: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onQueryChange: (query: string) => void;
  onChange: (patch: Partial<CivitaiSearch>) => void;
  onRequireConnection: () => void;
}) {
  const [tag, setTag] = useState(filters.tag);
  const [username, setUsername] = useState(filters.username);
  const advancedCount = [
    filters.tag,
    filters.username,
    filters.favorites,
    filters.period !== CIVITAI_DEFAULT_SEARCH.period,
  ].filter(Boolean).length;
  const [advanced, setAdvanced] = useState(advancedCount > 0);
  const baseModels = civitaiBaseModelsForType(options, filters.modelType);
  const hasFilters =
    Boolean(filters.modelType || filters.baseModel) ||
    advancedCount > 0 ||
    filters.sort !== CIVITAI_DEFAULT_SEARCH.sort;

  useEffect(() => {
    if (advancedCount > 0) setAdvanced(true);
  }, [advancedCount > 0]);
  useEffect(() => setTag(filters.tag), [filters.tag]);
  useEffect(() => setUsername(filters.username), [filters.username]);

  const submit = () =>
    onChange({
      query: query.trim(),
      tag: tag.trim(),
      username: username.trim(),
    });

  return (
    <form
      className="shrink-0 space-y-3 border-b border-slate-800 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" />
          <input
            ref={inputRef}
            aria-label="Search Civitai"
            placeholder="Search models, paste a Civitai link or SHA-256"
            className={`${fieldClass} w-full pl-9 pr-9`}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              className="absolute right-2 top-2 rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
              onClick={() => {
                onQueryChange("");
                onChange({ query: "" });
                inputRef.current?.focus();
              }}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <Button type="submit">Search</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="radiogroup"
          aria-label="Resource type"
          className="flex h-10 shrink-0 rounded-lg border border-slate-700 bg-slate-900 p-1"
        >
          {["", ...options.modelTypes].map((value) => (
            <button
              key={value || "all"}
              type="button"
              role="radio"
              aria-checked={filters.modelType === value}
              className={cn(
                "rounded-md px-3 text-sm text-slate-300 transition hover:text-slate-100",
                filters.modelType === value && "bg-slate-700 text-slate-50",
              )}
              onClick={() =>
                onChange({
                  modelType: value,
                  baseModel: civitaiBaseModelsForType(options, value).includes(
                    filters.baseModel,
                  )
                    ? filters.baseModel
                    : "",
                })
              }
            >
              {value ? civitaiTypeLabel(value) : "All"}
            </button>
          ))}
        </div>
        <SearchableSelect
          label="Base model"
          className="flex-[1_1_10rem] sm:max-w-56"
          value={filters.baseModel}
          options={[
            { value: "", label: "All base models" },
            ...baseModels.map((value) => ({ value, label: value })),
          ]}
          onChange={(baseModel) => onChange({ baseModel })}
        />
        <SearchableSelect
          label="Sort"
          className="flex-[1_1_10rem] sm:max-w-48"
          value={filters.sort}
          options={CIVITAI_SORTS.map((value) => ({ value, label: value }))}
          onChange={(sort) => onChange({ sort })}
        />
        <SearchableSelect
          label="Content"
          className="flex-[1_1_9rem] sm:max-w-44"
          value={filters.contentMode}
          options={CONTENT_MODES}
          onChange={(contentMode) =>
            onChange({ contentMode: contentMode as CivitaiContentMode })
          }
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={advanced}
          onClick={() => setAdvanced((value) => !value)}
        >
          <SlidersHorizontal className="h-4 w-4" /> More
          {advancedCount > 0 && (
            <span className="rounded-full bg-sky-400/15 px-1.5 text-xs tabular-nums text-sky-200">
              {advancedCount}
            </span>
          )}
        </Button>
        {hasFilters && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() =>
              onChange({
                ...CIVITAI_DEFAULT_SEARCH,
                query: filters.query,
                contentMode: filters.contentMode,
              })
            }
          >
            Reset
          </Button>
        )}
      </div>
      {advanced && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="grid gap-1 text-xs text-slate-400">
            Period
            <SearchableSelect
              label="Period"
              value={filters.period}
              options={CIVITAI_PERIODS.map(([value, label]) => ({
                value,
                label,
              }))}
              onChange={(period) => onChange({ period })}
            />
          </label>
          <label className="grid gap-1 text-xs text-slate-400">
            Tag
            <input
              className={fieldClass}
              value={tag}
              onChange={(event) => setTag(event.target.value)}
              onBlur={() => {
                if (tag.trim() !== filters.tag) onChange({ tag: tag.trim() });
              }}
            />
          </label>
          <label className="grid gap-1 text-xs text-slate-400">
            Creator
            <input
              className={fieldClass}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              onBlur={() => {
                if (username.trim() !== filters.username)
                  onChange({ username: username.trim() });
              }}
            />
          </label>
          <label className="flex items-end gap-2 pb-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={filters.favorites}
              onChange={(event) => {
                if (!connected) {
                  onRequireConnection();
                  return;
                }
                onChange({ favorites: event.target.checked });
              }}
              className="accent-sky-400"
            />
            My favorites
          </label>
        </div>
      )}
    </form>
  );
}
