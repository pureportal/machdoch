"use client";

import { Command } from "cmdk";
import { Check } from "lucide-react";
import { Popover } from "radix-ui";
import { useState, type ReactElement, type ReactNode } from "react";

export interface PropertyOption {
  value: string;
  label: string;
  icon?: ReactNode;
  group?: string;
}

const searchThreshold = 7;

export function PropertyMenu({
  label,
  options,
  value,
  onSelect,
  children,
  align = "start",
}: {
  label: string;
  options: PropertyOption[];
  value?: string;
  onSelect: (value: string) => void;
  children: ReactElement;
  align?: "start" | "end" | "center";
}) {
  const [open, setOpen] = useState(false);
  const groups = [...new Set(options.map((option) => option.group ?? ""))];
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="cloud-menu"
          align={align}
          sideOffset={4}
          collisionPadding={12}
          onClick={(event) => event.stopPropagation()}
        >
          <Command label={label} loop>
            {options.length >= searchThreshold && (
              <Command.Input
                className="cloud-menu-search"
                placeholder={`${label}…`}
                autoFocus
              />
            )}
            <Command.List className="cloud-menu-list">
              <Command.Empty className="cloud-menu-empty">
                No matches
              </Command.Empty>
              {groups.map((group) => (
                <Command.Group key={group} heading={group || undefined}>
                  {options
                    .filter((option) => (option.group ?? "") === group)
                    .map((option) => (
                      <Command.Item
                        key={option.value}
                        value={`${option.group ?? ""} ${option.label} ${option.value}`}
                        onSelect={() => {
                          setOpen(false);
                          if (option.value !== value) onSelect(option.value);
                        }}
                      >
                        {option.icon}
                        <span className="cloud-menu-label">{option.label}</span>
                        {option.value === value && <Check size={14} />}
                      </Command.Item>
                    ))}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
