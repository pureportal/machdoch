import { Bot, Check, ChevronDown } from "lucide-react";
import { useEffect, useState, type JSX } from "react";
import { Button } from "../../components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui/popover";
import { cn } from "../../lib/utils";
import {
  getCatalogModelsForProvider,
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

export const SessionModelPicker = ({
  chooserProviders,
  activeProvider,
  activeModel,
  onSessionModelSelection,
}: SessionModelPickerProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [visibleProvider, setVisibleProvider] = useState(activeProvider);
  const [providerModelCatalog, setProviderModelCatalog] =
    useState<ProviderModelCatalogSnapshot | null>(null);

  useEffect(() => {
    setVisibleProvider(activeProvider);
  }, [activeProvider]);

  useEffect(() => {
    let cancelled = false;

    void loadProviderModelCatalog().then((catalog) => {
      if (!cancelled) {
        setProviderModelCatalog(catalog);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const activeProviderModels = getCatalogModelsForProvider(
    activeProvider,
    providerModelCatalog,
  );
  const activeModelMeta = activeProviderModels.find(
    (model) => model.id === activeModel,
  );
  const activeModelLabel = activeModelMeta?.label ?? activeModel;
  const selectedProvider = chooserProviders.includes(visibleProvider)
    ? visibleProvider
    : (chooserProviders[0] ?? activeProvider);
  const selectedProviderModels = getCatalogModelsForProvider(
    selectedProvider,
    providerModelCatalog,
  );

  const handleSessionModelSelection = (
    provider: RuntimeProvider,
    model: string,
  ): void => {
    onSessionModelSelection(provider, model);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
              <div className="flex items-center justify-between gap-3 px-1">
                <p className="text-sm font-semibold text-slate-100">
                  {getProviderLabel(selectedProvider)} models
                </p>
                <span className="text-xs text-slate-500">
                  {selectedProviderModels.length} available
                </span>
              </div>

              <div className="grid max-h-72 gap-1.5 overflow-y-auto pr-1">
                {selectedProviderModels.map((model) => {
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
