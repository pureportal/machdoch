import { Bot, Check, ChevronDown, Search } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

export interface ComposerModelOption {
  id: string;
  label: string;
}

export interface ComposerModelProvider {
  id: string;
  label: string;
  available: boolean;
  error?: string;
  models: readonly ComposerModelOption[];
}

export interface ComposerModelPickerProps {
  providers: readonly ComposerModelProvider[];
  activeProvider: string;
  activeProviderLabel: string;
  activeModel: string;
  activeModelLabel: string;
  loading: boolean;
  onOpenChange?: (open: boolean) => void;
  onSelect: (provider: string, model: string) => void;
}

const normalizeSearchText = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");

const scoreSearchCandidate = (
  candidate: string,
  query: string,
  tokens: readonly string[],
  labelBonus: number,
): number => {
  const normalizedCandidate = normalizeSearchText(candidate);
  if (!normalizedCandidate) return 0;

  const words = normalizedCandidate.split(" ");
  let score = 0;
  for (const token of tokens) {
    if (normalizedCandidate === token) {
      score += 500;
    } else if (normalizedCandidate.startsWith(token)) {
      score += 420;
    } else if (words.includes(token)) {
      score += 360;
    } else if (words.some((word) => word.startsWith(token))) {
      score += 300;
    } else {
      const tokenIndex = normalizedCandidate.indexOf(token);
      if (tokenIndex < 0) return 0;
      score += 160 - Math.min(tokenIndex, 100);
    }
  }

  if (normalizedCandidate === query) return score + 800 + labelBonus;
  if (normalizedCandidate.startsWith(query)) return score + 620 + labelBonus;

  const phraseIndex = normalizedCandidate.indexOf(query);
  return phraseIndex >= 0
    ? score + 420 - Math.min(phraseIndex, 100) + labelBonus
    : score + labelBonus;
};

export function ComposerModelPicker({
  providers,
  activeProvider,
  activeProviderLabel,
  activeModel,
  activeModelLabel,
  loading,
  onOpenChange,
  onSelect,
}: ComposerModelPickerProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [visibleProviderId, setVisibleProviderId] = useState(activeProvider);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const popoverId = useId();

  useEffect(() => {
    setVisibleProviderId(activeProvider);
  }, [activeProvider]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    onOpenChange?.(open);
    if (open) searchRef.current?.focus();
  }, [onOpenChange, open]);

  const selectedProvider =
    providers.find((provider) => provider.id === visibleProviderId) ??
    providers.find((provider) => provider.id === activeProvider) ??
    providers[0];
  const visibleModels = useMemo(() => {
    const models = selectedProvider?.models ?? [];
    const normalizedQuery = normalizeSearchText(search);
    if (!normalizedQuery) return models;

    const tokens = normalizedQuery.split(" ");
    return models
      .map((model, order) => ({
        model,
        order,
        score: Math.max(
          scoreSearchCandidate(model.label, normalizedQuery, tokens, 120),
          scoreSearchCandidate(model.id, normalizedQuery, tokens, 0),
        ),
      }))
      .filter((entry) => entry.score > 0)
      .sort(
        (left, right) => right.score - left.score || left.order - right.order,
      )
      .map((entry) => entry.model);
  }, [search, selectedProvider]);

  const setPickerOpen = (nextOpen: boolean): void => {
    setOpen(nextOpen);
    if (nextOpen) {
      setVisibleProviderId(activeProvider);
      setSearch("");
    }
  };
  const selectModel = (provider: string, model: string): void => {
    onSelect(provider, model);
    setPickerOpen(false);
  };
  const handleSearchKeyDown = (
    event: KeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.key !== "Enter" || !search.trim() || !selectedProvider) return;
    const bestMatch = visibleModels[0];
    if (!bestMatch) return;
    event.preventDefault();
    selectModel(selectedProvider.id, bestMatch.id);
  };
  const availability = loading
    ? "Checking availability"
    : selectedProvider?.available
      ? `${selectedProvider.models.length} available`
      : "Unavailable";
  const emptyState = loading
    ? `Checking ${selectedProvider?.label ?? "provider"} models…`
    : !selectedProvider?.available
      ? (selectedProvider?.error ?? "Model discovery is unavailable.")
      : selectedProvider.models.length === 0
        ? "No models are available."
        : "No matching models.";

  return (
    <div className="m-composer-model-picker" ref={rootRef}>
      <button
        type="button"
        className="m-composer-model-trigger app-model-picker-button"
        aria-label={`Session model: ${activeProviderLabel} ${activeModelLabel}`}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-haspopup="dialog"
        disabled={providers.length === 0}
        onClick={() => setPickerOpen(!open)}
      >
        <Bot aria-hidden="true" />
        <span>
          {activeProviderLabel} / {activeModelLabel}
        </span>
        <ChevronDown aria-hidden="true" />
      </button>
      {open ? (
        <div
          id={popoverId}
          className="m-composer-model-popover"
          role="dialog"
          aria-label="Session model"
        >
          <div className="m-composer-model-heading">
            <span>Session model</span>
            <strong>
              {activeProviderLabel} / {activeModelLabel}
            </strong>
          </div>
          <div className="m-composer-model-content">
            <div
              className="m-composer-provider-tabs"
              role="tablist"
              aria-label="Model providers"
            >
              {providers.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  role="tab"
                  aria-selected={selectedProvider?.id === provider.id}
                  data-active={selectedProvider?.id === provider.id}
                  onClick={() => {
                    setVisibleProviderId(provider.id);
                    setSearch("");
                  }}
                >
                  {provider.id === activeProvider ? (
                    <Check aria-hidden="true" />
                  ) : null}
                  {provider.label}
                </button>
              ))}
            </div>
            <label className="m-composer-model-search">
              <Search aria-hidden="true" />
              <input
                ref={searchRef}
                value={search}
                aria-label="Search models"
                placeholder="Search models"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={handleSearchKeyDown}
              />
            </label>
            <div className="m-composer-model-list-heading">
              <strong>{selectedProvider?.label ?? "Models"}</strong>
              <span aria-live="polite">{availability}</span>
            </div>
            <div className="m-composer-model-list">
              {visibleModels.length === 0 ? (
                <div className="m-composer-model-empty" role="status">
                  {emptyState}
                </div>
              ) : null}
              {visibleModels.map((model) => {
                const selected =
                  selectedProvider?.id === activeProvider &&
                  model.id === activeModel;
                return (
                  <button
                    key={`${selectedProvider?.id}:${model.id}`}
                    type="button"
                    className="m-composer-model-option"
                    data-active={selected}
                    aria-label={`Choose ${selectedProvider?.label} ${model.label}`}
                    aria-pressed={selected}
                    onClick={() =>
                      selectedProvider &&
                      selectModel(selectedProvider.id, model.id)
                    }
                  >
                    <span className="m-composer-model-check">
                      {selected ? <Check aria-hidden="true" /> : null}
                    </span>
                    <strong>{model.label}</strong>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
