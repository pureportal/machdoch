import { Bot, Check, ChevronDown, Search } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui/popover";
import { cn } from "../../lib/utils";
import {
  getCatalogModelsForProvider,
  getModelLabelForProvider,
  getProviderLabel,
  type ProviderModelCatalogSnapshot,
  type RuntimeProvider,
} from "../../model-catalog";
import { loadProviderModelCatalog } from "../../runtime";

export interface SessionModelPickerProps {
  chooserProviders: RuntimeProvider[];
  activeProvider: RuntimeProvider;
  activeModel: string;
  onSessionModelSelection: (provider: RuntimeProvider, model: string) => void;
}

const normalizeModelSearchText = (value: string): string => {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
};

const scoreModelSearchCandidate = (
  candidate: string,
  normalizedQuery: string,
  tokens: readonly string[],
  labelBonus: number,
): number => {
  const normalizedCandidate = normalizeModelSearchText(candidate);

  if (!normalizedCandidate) {
    return 0;
  }

  const words = normalizedCandidate.split(" ");
  let score = 0;

  for (const token of tokens) {
    if (normalizedCandidate === token) {
      score += 500;
      continue;
    }

    if (normalizedCandidate.startsWith(token)) {
      score += 420;
      continue;
    }

    if (words.includes(token)) {
      score += 360;
      continue;
    }

    if (words.some((word) => word.startsWith(token))) {
      score += 300;
      continue;
    }

    const tokenIndex = normalizedCandidate.indexOf(token);

    if (tokenIndex < 0) {
      return 0;
    }

    score += 160 - Math.min(tokenIndex, 100);
  }

  if (normalizedCandidate === normalizedQuery) {
    return score + 800 + labelBonus;
  }

  if (normalizedCandidate.startsWith(normalizedQuery)) {
    return score + 620 + labelBonus;
  }

  const phraseIndex = normalizedCandidate.indexOf(normalizedQuery);

  if (phraseIndex >= 0) {
    return score + 420 - Math.min(phraseIndex, 100) + labelBonus;
  }

  return score + labelBonus;
};

const MAX_CATALOG_ERROR_LENGTH = 180;

const formatCatalogError = (error: string | undefined): string => {
  const normalizedError = error?.replace(/\s+/gu, " ").trim();

  if (!normalizedError) {
    return "The provider did not return a model-list status.";
  }

  if (normalizedError.length <= MAX_CATALOG_ERROR_LENGTH) {
    return normalizedError;
  }

  return `${normalizedError.slice(0, MAX_CATALOG_ERROR_LENGTH - 1).trimEnd()}…`;
};

export const SessionModelPicker = ({
  chooserProviders,
  activeProvider,
  activeModel,
  onSessionModelSelection,
}: SessionModelPickerProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [visibleProvider, setVisibleProvider] = useState(activeProvider);
  const [modelSearchText, setModelSearchText] = useState("");
  const [isCatalogLoading, setIsCatalogLoading] = useState(false);
  const [providerModelCatalog, setProviderModelCatalog] =
    useState<ProviderModelCatalogSnapshot | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setVisibleProvider(activeProvider);
  }, [activeProvider]);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;
    setIsCatalogLoading(true);

    void loadProviderModelCatalog()
      .then((catalog) => {
        if (!cancelled) {
          setProviderModelCatalog(catalog);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsCatalogLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  const activeModelLabel = getModelLabelForProvider(
    activeProvider,
    activeModel,
    providerModelCatalog,
  );
  const selectedProvider = chooserProviders.includes(visibleProvider)
    ? visibleProvider
    : (chooserProviders[0] ?? activeProvider);
  const selectedRuntimeCatalog = providerModelCatalog?.providers.find(
    (entry) => entry.provider === selectedProvider,
  );
  const selectedProviderModels = isCatalogLoading
    ? []
    : getCatalogModelsForProvider(selectedProvider, providerModelCatalog);
  const visibleSelectedProviderModels = useMemo(() => {
    const normalizedQuery = normalizeModelSearchText(modelSearchText);

    if (!normalizedQuery) {
      return selectedProviderModels;
    }

    const tokens = normalizedQuery.split(" ");

    return selectedProviderModels
      .map((model, order) => ({
        model,
        order,
        score: Math.max(
          scoreModelSearchCandidate(model.label, normalizedQuery, tokens, 120),
          scoreModelSearchCandidate(model.id, normalizedQuery, tokens, 0),
        ),
      }))
      .filter((entry) => entry.score > 0)
      .sort((firstEntry, secondEntry) => {
        const scoreDifference = secondEntry.score - firstEntry.score;

        if (scoreDifference !== 0) {
          return scoreDifference;
        }

        return firstEntry.order - secondEntry.order;
      })
      .map((entry) => entry.model);
  }, [modelSearchText, selectedProviderModels]);
  const availabilityLabel = isCatalogLoading
    ? "Checking availability"
    : selectedRuntimeCatalog?.available
      ? `${selectedProviderModels.length} available`
      : "Unavailable";
  const emptyStateDescription = isCatalogLoading
    ? `Checking ${getProviderLabel(selectedProvider)} model list…`
    : !selectedRuntimeCatalog?.available
      ? formatCatalogError(selectedRuntimeCatalog?.error)
      : selectedProviderModels.length === 0
        ? "The provider returned no supported models."
        : "No matching models.";

  const handleOpenChange = (nextOpen: boolean): void => {
    setOpen(nextOpen);

    if (nextOpen) {
      setModelSearchText("");
      setProviderModelCatalog(null);
      setIsCatalogLoading(true);
    }
  };

  const handleSessionModelSelection = (
    provider: RuntimeProvider,
    model: string,
  ): void => {
    onSessionModelSelection(provider, model);
    setOpen(false);
    setModelSearchText("");
  };

  const handleSearchKeyDown = (
    event: KeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.key !== "Enter" || !modelSearchText.trim()) {
      return;
    }

    const bestMatch = visibleSelectedProviderModels[0];

    if (!bestMatch) {
      return;
    }

    event.preventDefault();
    handleSessionModelSelection(selectedProvider, bestMatch.id);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label={`Session model: ${getProviderLabel(activeProvider)} ${activeModelLabel}`}
          disabled={chooserProviders.length === 0}
          className="app-model-picker-button h-8 max-w-68 rounded-full border-slate-800 bg-slate-950/70 px-3 text-xs font-medium text-slate-300 shadow-none hover:border-sky-500/30 hover:bg-slate-900 hover:text-slate-100 disabled:opacity-50"
        >
          <Bot className="h-3.5 w-3.5 text-sky-300" />
          <span className="min-w-0 truncate">
            {getProviderLabel(activeProvider)} / {activeModelLabel}
          </span>
          <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-3xl border-slate-800 bg-slate-950/98 p-0 shadow-2xl shadow-sky-950/30 backdrop-blur-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchInputRef.current?.focus();
        }}
      >
        <div className="border-b border-slate-800/80 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold tracking-[0.16em] text-slate-500 uppercase">
                Session model
              </p>
              <p className="mt-1 truncate text-sm font-semibold text-slate-100">
                {getProviderLabel(activeProvider)} / {activeModelLabel}
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-3 p-3">
          <div className="grid gap-2">
            <div
              className="flex flex-wrap gap-2"
              role="tablist"
              aria-label="Model providers"
            >
              {chooserProviders.map((provider) => {
                const isVisible = selectedProvider === provider;
                const isCurrent = activeProvider === provider;

                return (
                  <button
                    key={provider}
                    type="button"
                    role="tab"
                    aria-selected={isVisible}
                    onClick={() => setVisibleProvider(provider)}
                    className={cn(
                      "flex h-8 items-center gap-2 rounded-full border px-3 text-xs font-semibold transition-all",
                      isVisible
                        ? "border-sky-500/30 bg-sky-500/12 text-sky-100 shadow-[0_0_18px_rgba(14,165,233,0.14)]"
                        : "border-slate-800 bg-slate-900/70 text-slate-400 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
                    )}
                  >
                    {isCurrent ? <Check className="h-3.5 w-3.5" /> : null}
                    {getProviderLabel(provider)}
                  </button>
                );
              })}
            </div>

            <div className="grid gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <Input
                  ref={searchInputRef}
                  type="search"
                  value={modelSearchText}
                  onChange={(event) => setModelSearchText(event.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  aria-label="Search models"
                  placeholder="Search models"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-9 rounded-2xl border-slate-800 bg-slate-900/70 pr-3 pl-9 text-sm text-slate-100 shadow-none placeholder:text-slate-500 focus-visible:border-sky-400/50 focus-visible:ring-sky-400/30"
                />
              </div>

              <div className="flex items-center justify-between gap-3 px-1">
                <p className="text-sm font-semibold text-slate-100">
                  {getProviderLabel(selectedProvider)} models
                </p>
                <span
                  aria-live="polite"
                  className="text-xs text-slate-500"
                >
                  {availabilityLabel}
                </span>
              </div>

              <div className="grid max-h-72 gap-1.5 overflow-y-auto pr-1">
                {visibleSelectedProviderModels.length === 0 ? (
                  <div
                    role="status"
                    className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-sm leading-5 text-slate-400"
                  >
                    {emptyStateDescription}
                  </div>
                ) : null}

                {visibleSelectedProviderModels.map((model) => {
                  const isSelected =
                    activeProvider === selectedProvider &&
                    activeModel === model.id;

                  return (
                    <button
                      key={`${selectedProvider}-${model.id}`}
                      type="button"
                      aria-label={`Choose ${getProviderLabel(selectedProvider)} ${model.label}`}
                      aria-pressed={isSelected}
                      onClick={() =>
                        handleSessionModelSelection(selectedProvider, model.id)
                      }
                      className={cn(
                        "group grid w-full grid-cols-[auto_minmax(0,1fr)] gap-2 rounded-xl border px-3 py-2.5 text-left transition-all",
                        isSelected
                          ? "border-sky-500/35 bg-sky-500/10 text-sky-100 shadow-[0_0_18px_rgba(14,165,233,0.12)]"
                          : "border-slate-800 bg-slate-900/65 text-slate-300 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors",
                          isSelected
                            ? "border-sky-400/30 bg-sky-400/15 text-sky-200"
                            : "border-slate-700 bg-transparent group-hover:border-slate-500",
                        )}
                      >
                        {isSelected ? <Check className="h-3.5 w-3.5" /> : null}
                      </span>

                      <span className="grid min-w-0">
                        <span className="min-w-0 truncate text-sm font-semibold text-slate-100">
                          {model.label}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};
