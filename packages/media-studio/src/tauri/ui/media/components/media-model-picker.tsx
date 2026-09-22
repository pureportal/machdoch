import { Check, ChevronDown } from "lucide-react";
import { useState, type JSX } from "react";
import { MEDIA_MODEL_ARCHITECTURES } from "../../../../core/media/model-architectures.js";
import { listSelectableMediaModels } from "../../../../core/media/model-library.js";
import type {
  MediaAssetCategory,
  MediaAssetRecord,
  MediaGenerationAssetMetadata,
  MediaModelDescriptor,
} from "../../../../core/media/contracts.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../../components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui/popover";
import { cn } from "../../lib/utils";
import { MediaResourcePreview } from "./media-visual-preview";
import {
  MediaResourceFilters,
  useMediaResourceDiscovery,
} from "./media-resource-filters";

interface MediaModelPickerProps {
  id?: string;
  models: readonly MediaModelDescriptor[];
  value: string | null;
  assets: readonly MediaAssetRecord[];
  metadata: Readonly<Record<string, MediaGenerationAssetMetadata>>;
  categories: readonly MediaAssetCategory[];
  onChange: (modelId: string | null) => void;
  automaticLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  disabledReasons?: Readonly<Record<string, string>>;
  compact?: boolean;
  className?: string;
}

export const MediaModelPicker = ({
  id,
  models,
  value,
  assets,
  metadata,
  categories,
  onChange,
  automaticLabel,
  placeholder = "Choose model",
  disabled = false,
  invalid = false,
  describedBy,
  disabledReasons,
  compact = false,
  className,
}: MediaModelPickerProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [baseModel, setBaseModel] = useState("all");
  const [target, setTarget] = useState("all");
  const selectableModels = listSelectableMediaModels(models);
  const discovery = useMediaResourceDiscovery(
    selectableModels,
    metadata,
    categories,
  );
  const baseModels = MEDIA_MODEL_ARCHITECTURES.filter((base) =>
    selectableModels.some((model) => model.architecture === base.value),
  );
  const visibleModels = discovery.visibleResources.filter((model) =>
    (baseModel === "all" || model.architecture === baseModel) &&
    (target === "all" || model.target === target),
  );
  const selectedModel =
    selectableModels.find((model) => model.id === value) ?? null;
  const label =
    selectedModel?.displayName ??
    (value === null ? automaticLabel : undefined) ??
    placeholder;
  const pickerDisabled =
    disabled || (selectableModels.length === 0 && automaticLabel === undefined);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-invalid={invalid}
          aria-describedby={describedBy}
          disabled={pickerDisabled}
          className={cn(
            "flex min-w-0 cursor-pointer items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-2 text-left text-slate-100 outline-none transition-colors hover:border-slate-600 focus-visible:border-sky-500 disabled:cursor-not-allowed disabled:opacity-55",
            compact ? "h-8" : "h-11",
            className,
          )}
        >
          {!compact ? (
            <MediaResourcePreview
              resourceId={selectedModel?.id ?? ""}
              metadata={metadata}
              assets={assets}
              className="h-8 w-10 shrink-0 rounded-lg"
            />
          ) : null}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium">{label}</span>
            {!compact && selectedModel ? (
              <span className="block truncate text-[10px] text-slate-500">
                {selectedModel.family} ·{" "}
                {selectedModel.target === "local" ? "Local" : "Remote"}
              </span>
            ) : null}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-slate-500" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[max(24rem,var(--radix-popover-trigger-width))] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border-slate-700 bg-slate-950 p-0 shadow-2xl"
      >
        <Command shouldFilter={false} className="bg-slate-950 text-slate-100">
          <CommandInput
            aria-label="Search models"
            placeholder="Search models"
            value={discovery.filters.query}
            onValueChange={(query) =>
              discovery.setFilters({ ...discovery.filters, query })
            }
          />
          <div className="space-y-2 p-2" onKeyDown={(event) => event.stopPropagation()}>
            <div className="flex gap-2">
              <select aria-label="Filter models by base model" value={baseModel} onChange={(event) => setBaseModel(event.target.value)} className="h-9 min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2 text-xs text-slate-200">
                <option value="all">All base models</option>
                {baseModels.map((base) => <option key={base.value} value={base.value}>{base.label}</option>)}
              </select>
              <select aria-label="Filter models by location" value={target} onChange={(event) => setTarget(event.target.value)} className="h-9 min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2 text-xs text-slate-200">
                <option value="all">Local + Remote</option>
                <option value="local">Local</option>
                <option value="remote">Remote</option>
              </select>
            </div>
            <MediaResourceFilters
              label="models"
              filters={discovery.filters}
              onChange={discovery.setFilters}
              categories={categories}
              tags={discovery.tags}
              showSearch={false}
            />
          </div>
          <CommandList className="max-h-72">
            <CommandEmpty>No matching models</CommandEmpty>
            <CommandGroup>
              {automaticLabel ? (
                <CommandItem
                  value={automaticLabel}
                  onSelect={() => {
                    if (value !== null) onChange(null);
                    setOpen(false);
                  }}
                  className="min-h-11 cursor-pointer rounded-xl data-[disabled=true]:cursor-not-allowed"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {automaticLabel}
                  </span>
                  {value === null ? (
                    <Check className="h-4 w-4 text-sky-300" />
                  ) : null}
                </CommandItem>
              ) : null}
              {visibleModels.map((model) => (
                <CommandItem
                  key={model.id}
                  value={model.id}
                  disabled={Boolean(disabledReasons?.[model.id])}
                  onSelect={() => {
                    if (value !== model.id) onChange(model.id);
                    setOpen(false);
                  }}
                  className="min-h-14 cursor-pointer rounded-xl data-[disabled=true]:cursor-not-allowed"
                >
                  <MediaResourcePreview
                    resourceId={model.id}
                    metadata={metadata}
                    assets={assets}
                    className="h-10 w-12 shrink-0 rounded-lg"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-slate-100">
                      {model.displayName}
                    </span>
                    <span
                      className={cn(
                        "block text-[10px] text-slate-500",
                        disabledReasons?.[model.id]
                          ? "whitespace-normal"
                          : "truncate",
                      )}
                    >
                      {disabledReasons?.[model.id] ??
                        `${model.family} · ${model.target === "local" ? "Local" : "Remote"}`}
                    </span>
                  </span>
                  {model.id === selectedModel?.id ? (
                    <Check className="h-4 w-4 text-sky-300" />
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};
