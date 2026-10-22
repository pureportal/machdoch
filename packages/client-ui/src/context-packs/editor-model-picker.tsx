import { useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@machdoch/media-studio/tauri/ui/components/ui/popover.js";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from "@machdoch/media-studio/tauri/ui/components/ui/command.js";
import type { PackModelOption } from "./editor";

export function PackModelPicker({
  value,
  options,
  onChange,
}: {
  value: string;
  options: PackModelOption[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const customModel = query.trim();
  const choose = (model: string) => {
    onChange(model);
    setOpen(false);
  };
  return (
    <div className="app-pack-field">
      <label htmlFor={id}>Model</label>
      <Popover
        modal
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          setQuery("");
        }}
      >
        <PopoverTrigger asChild>
          <button
            id={id}
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="dialog"
            className="app-pack-control app-pack-select"
            data-placeholder={!value}
          >
            <span>
              {options.find((option) => option.id === value)?.label ??
                (value || "Select model")}
            </span>
            <ChevronDown size={16} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          aria-label="Select model"
          align="start"
          className="app-pack-model-menu"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            input.current?.focus();
          }}
        >
          <Command label="Search models or enter model ID">
            <CommandInput
              ref={input}
              value={query}
              onValueChange={setQuery}
              placeholder="Search or enter model ID"
            />
            <CommandList label="Models">
              {options.map((option) => (
                <CommandItem
                  key={option.id}
                  value={option.id}
                  keywords={[option.label]}
                  onSelect={() => choose(option.id)}
                >
                  <span>{option.label}</span>
                  {value === option.id && <Check size={16} />}
                </CommandItem>
              ))}
              {customModel &&
                !options.some((option) => option.id === customModel) && (
                  <CommandItem
                    value={customModel}
                    onSelect={() => choose(customModel)}
                  >
                    Use “{customModel}”
                  </CommandItem>
                )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
