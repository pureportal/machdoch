"use client";

import { Command } from "cmdk";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useRef, useState, type ReactElement } from "react";
import type { PropertyOption } from "./property-menu";

export interface FilterMenuField {
  key: string;
  label: string;
  icon: LucideIcon;
  options: PropertyOption[];
  multiple: boolean;
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    !!target.closest(
      "input,textarea,select,[contenteditable=true],[role=dialog]",
    )
  );
}

export function FilterMenu({
  fields,
  selected,
  onToggle,
  initialKey = null,
  shortcut = false,
  align = "start",
  children,
}: {
  fields: FilterMenuField[];
  selected: (key: string) => string[];
  onToggle: (key: string, value: string) => void;
  initialKey?: string | null;
  shortcut?: boolean;
  align?: "start" | "end";
  children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<string | null>(initialKey);
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const field = fields.find((entry) => entry.key === step) ?? null;
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open, step]);
  useEffect(() => {
    if (!shortcut) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "f" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isTyping(event.target)
      )
        return;
      event.preventDefault();
      setOpen(true);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [shortcut]);
  const change = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setStep(initialKey);
      setQuery("");
    }
  };
  const choose = (entry: FilterMenuField, value: string) => {
    onToggle(entry.key, value);
    if (!entry.multiple) change(false);
    else if (step !== entry.key) {
      setStep(entry.key);
      setQuery("");
    }
  };
  const valueItem = (entry: FilterMenuField, option: PropertyOption) => {
    const active = selected(entry.key).includes(option.value);
    return (
      <Command.Item
        key={`${entry.key}:${option.value}`}
        value={`${entry.label} ${option.label} ${entry.key}:${option.value}`}
        onSelect={() => choose(entry, option.value)}
      >
        {entry.multiple && (
          <span
            className="cloud-filter-check"
            data-checked={active || undefined}
          >
            {active && <Check size={11} strokeWidth={3} />}
          </span>
        )}
        {option.icon}
        <span className="cloud-menu-label">
          {field ? option.label : `${entry.label}: ${option.label}`}
        </span>
        {!entry.multiple && active && <Check size={14} />}
      </Command.Item>
    );
  };
  return (
    <Popover.Root open={open} onOpenChange={change}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="cloud-menu cloud-filter-menu"
          align={align}
          sideOffset={4}
          collisionPadding={12}
        >
          <Command label="Filter" loop>
            <div className="cloud-filter-menu-head">
              {field && !initialKey && (
                <button
                  type="button"
                  aria-label="All filters"
                  onClick={() => {
                    setStep(null);
                    setQuery("");
                  }}
                >
                  <ChevronLeft size={14} />
                </button>
              )}
              <Command.Input
                ref={input}
                className="cloud-menu-search"
                placeholder={field ? `${field.label}…` : "Filter…"}
                value={query}
                onValueChange={setQuery}
                autoFocus
                onKeyDown={(event) => {
                  if (
                    event.key === "Backspace" &&
                    !query &&
                    field &&
                    !initialKey
                  ) {
                    event.preventDefault();
                    setStep(null);
                  }
                }}
              />
            </div>
            <Command.List className="cloud-menu-list">
              <Command.Empty className="cloud-menu-empty">
                No matches
              </Command.Empty>
              {field
                ? field.options.map((option) => valueItem(field, option))
                : fields.map((entry) => {
                    const Icon = entry.icon;
                    const count = selected(entry.key).length;
                    return (
                      <Command.Item
                        key={entry.key}
                        value={`${entry.label} ${entry.key}`}
                        onSelect={() => {
                          setStep(entry.key);
                          setQuery("");
                        }}
                      >
                        <Icon size={14} aria-hidden="true" />
                        <span className="cloud-menu-label">{entry.label}</span>
                        {count > 0 && (
                          <span className="cloud-filter-count">{count}</span>
                        )}
                        <ChevronRight size={13} aria-hidden="true" />
                      </Command.Item>
                    );
                  })}
              {!field &&
                query.trim() &&
                fields.flatMap((entry) =>
                  entry.options.map((option) => valueItem(entry, option)),
                )}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
