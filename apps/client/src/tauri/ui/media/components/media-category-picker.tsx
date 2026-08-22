import { Check, ChevronDown, Settings2, X } from "lucide-react";
import { useState, type JSX } from "react";
import type { MediaAssetCategory } from "../../../../core/media/contracts.js";
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

interface MediaCategoryPickerProps {
  categories: readonly MediaAssetCategory[];
  selectedIds: readonly string[];
  onChange: (categoryIds: string[]) => void;
  onManage?: () => void;
  compact?: boolean;
  className?: string;
}

export const MediaCategoryPicker = ({
  categories,
  selectedIds,
  onChange,
  onManage,
  compact = false,
  className,
}: MediaCategoryPickerProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const validSelectedIds = selectedIds.filter((categoryId) =>
    categories.some((category) => category.id === categoryId),
  );
  const selectedCategories = validSelectedIds.flatMap((categoryId) => {
    const category = categories.find(
      (candidate) => candidate.id === categoryId,
    );
    return category ? [category] : [];
  });
  const label =
    selectedCategories.length === 0
      ? "Categories"
      : selectedCategories.length === 1
        ? selectedCategories[0]!.name
        : `${selectedCategories.length} categories`;

  const toggleCategory = (categoryId: string): void => {
    onChange(
      validSelectedIds.includes(categoryId)
        ? validSelectedIds.filter((selectedId) => selectedId !== categoryId)
        : [...validSelectedIds, categoryId],
    );
  };

  return (
    <div className={cn("min-w-0", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-label="Choose categories"
            className={cn(
              "flex w-full min-w-0 items-center justify-between gap-2 rounded-xl border border-slate-700 bg-slate-900 px-3 text-left text-xs text-slate-100 outline-none hover:border-slate-600 focus-visible:border-sky-500",
              compact ? "h-10" : "h-9",
            )}
          >
            <span className="truncate">{label}</span>
            <ChevronDown className="h-4 w-4 shrink-0 text-slate-500" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={6}
          className="w-72 overflow-hidden rounded-2xl border-slate-700 bg-slate-950 p-0 shadow-2xl"
        >
          <Command className="bg-slate-950 text-slate-100">
            <CommandInput placeholder="Search categories" />
            <CommandList className="max-h-64">
              <CommandEmpty>No matching categories</CommandEmpty>
              <CommandGroup>
                {categories.map((category) => {
                  const selected = validSelectedIds.includes(category.id);
                  return (
                    <CommandItem
                      key={category.id}
                      value={`${category.name} ${category.id}`}
                      onSelect={() => toggleCategory(category.id)}
                      className="min-h-10 rounded-xl"
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                          selected
                            ? "border-sky-400 bg-sky-500 text-white"
                            : "border-slate-600 bg-slate-900",
                        )}
                      >
                        {selected ? <Check className="h-3 w-3" /> : null}
                      </span>
                      <span className="truncate">{category.name}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
          {onManage ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onManage();
              }}
              className="flex h-10 w-full items-center gap-2 border-t border-slate-800 px-3 text-xs text-slate-400 hover:bg-slate-900 hover:text-slate-100"
            >
              <Settings2 className="h-4 w-4" /> Manage categories
            </button>
          ) : null}
        </PopoverContent>
      </Popover>
      {!compact && selectedCategories.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {selectedCategories.map((category) => (
            <span
              key={category.id}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-2 py-1 text-[10px] text-slate-300"
            >
              <span className="truncate">{category.name}</span>
              <button
                type="button"
                aria-label={`Remove ${category.name}`}
                onClick={() => toggleCategory(category.id)}
                className="shrink-0 text-slate-500 hover:text-white"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
};
