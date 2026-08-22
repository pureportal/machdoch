import { Check, ChevronDown } from "lucide-react";
import { useState, type JSX } from "react";
import { listSelectableMediaModels } from "../../../../core/media/model-library.js";
import type {
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

interface MediaModelPickerProps {
  id?: string;
  models: readonly MediaModelDescriptor[];
  value: string | null;
  assets: readonly MediaAssetRecord[];
  metadata: Readonly<Record<string, MediaGenerationAssetMetadata>>;
  onChange: (modelId: string | null) => void;
  automaticLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  compact?: boolean;
  className?: string;
}

export const MediaModelPicker = ({
  id,
  models,
  value,
  assets,
  metadata,
  onChange,
  automaticLabel,
  placeholder = "Choose model",
  disabled = false,
  invalid = false,
  describedBy,
  compact = false,
  className,
}: MediaModelPickerProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const selectableModels = listSelectableMediaModels(models);
  const selectedModel =
    selectableModels.find((model) => model.id === value) ?? null;
  const label = selectedModel?.displayName ?? automaticLabel ?? placeholder;
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
            "flex min-w-0 items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-2 text-left text-slate-100 outline-none transition-colors hover:border-slate-600 focus-visible:border-sky-500 disabled:cursor-not-allowed disabled:opacity-55",
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
        className="w-[var(--radix-popover-trigger-width)] min-w-72 overflow-hidden rounded-2xl border-slate-700 bg-slate-950 p-0 shadow-2xl"
      >
        <Command className="bg-slate-950 text-slate-100">
          <CommandInput placeholder="Search models" />
          <CommandList className="max-h-72">
            <CommandEmpty>No available models</CommandEmpty>
            <CommandGroup>
              {automaticLabel ? (
                <CommandItem
                  value={automaticLabel}
                  onSelect={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                  className="min-h-11 rounded-xl"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {automaticLabel}
                  </span>
                  {selectedModel === null ? (
                    <Check className="h-4 w-4 text-sky-300" />
                  ) : null}
                </CommandItem>
              ) : null}
              {selectableModels.map((model) => (
                <CommandItem
                  key={model.id}
                  value={`${model.displayName} ${model.family} ${model.id}`}
                  onSelect={() => {
                    onChange(model.id);
                    setOpen(false);
                  }}
                  className="min-h-14 rounded-xl"
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
                    <span className="block truncate text-[10px] text-slate-500">
                      {model.family} ·{" "}
                      {model.target === "local" ? "Local" : "Remote"}
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
