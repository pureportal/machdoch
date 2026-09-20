import { useId, useRef, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "./command";
import { cn } from "../../lib/utils";

export function SearchableSelect({
  label,
  value,
  options,
  onChange,
  disabled,
  className,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={open ? listId : undefined}
          disabled={disabled}
          className={cn(
            "flex h-10 min-w-0 items-center justify-between gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 text-left text-sm text-slate-100 outline-none hover:border-slate-500 focus-visible:border-sky-400 disabled:opacity-50",
            className,
          )}
        >
          <span className="truncate">
            {options.find((option) => option.value === value)?.label ?? label}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[max(15rem,var(--radix-popover-trigger-width))] p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          input.current?.focus();
        }}
      >
        <Command>
          <CommandInput
            ref={input}
            aria-label={`Search ${label.toLowerCase()}`}
            aria-controls={listId}
            placeholder="Search…"
          />
          <CommandList id={listId}>
            <CommandEmpty>No matches</CommandEmpty>
            {options.map((option) => (
              <CommandItem
                key={option.value}
                data-option-value={option.value}
                value={option.value || "__all"}
                keywords={[option.label]}
                onSelect={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span className="min-w-0 flex-1 break-words">
                  {option.label}
                </span>
                {option.value === value && (
                  <Check className="h-4 w-4 shrink-0 text-sky-400" />
                )}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
