"use client";

import { Command } from "cmdk";
import { Check, ChevronDown } from "lucide-react";
import { Popover } from "radix-ui";
import {
  Children,
  Fragment,
  isValidElement,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

interface SelectOption {
  value: string;
  label: string;
  disabled: boolean;
  group: string;
}

const searchThreshold = 8;

function itemValue(option: SelectOption): string {
  return `${option.label}${option.group}${option.value}`;
}
const openKeys = new Set(["Enter", " ", "ArrowDown", "ArrowUp", "F4"]);

function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<{ children?: ReactNode }>(node))
    return text(node.props.children);
  return "";
}

function collect(children: ReactNode, group = ""): SelectOption[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return [];
    if (child.type === Fragment)
      return collect(child.props.children as ReactNode, group);
    if (child.type === "optgroup")
      return collect(
        child.props.children as ReactNode,
        String(child.props.label ?? ""),
      );
    if (child.type !== "option") return [];
    const label = text(child.props.children as ReactNode);
    return [
      {
        value: String(child.props.value ?? label),
        label,
        disabled: child.props.disabled === true,
        group,
      },
    ];
  });
}

export function Select({
  className,
  children,
  onChange,
  onKeyDown,
  value,
  defaultValue,
  disabled,
  ...props
}: ComponentProps<"select">): ReactElement {
  const native = useRef<HTMLSelectElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [uncontrolled, setUncontrolled] = useState(
    defaultValue === undefined ? undefined : String(defaultValue),
  );
  const options = collect(children);
  const current =
    value !== undefined
      ? String(value)
      : (uncontrolled ?? options.find((option) => !option.disabled)?.value);
  const selected = options.find((option) => option.value === current);
  const placeholder = options.find(
    (option) => option.value === "" && option.disabled,
  );
  const groups = [...new Set(options.map((option) => option.group))];

  function choose(next: string) {
    setOpen(false);
    const element = native.current;
    if (!element) return;
    element.focus();
    if (element.value === next) return;
    element.value = next;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <div className={cn("cloud-select relative min-w-0 w-full", className)}>
          <select
            {...props}
            ref={native}
            value={value}
            defaultValue={defaultValue}
            disabled={disabled}
            className="cloud-select-native"
            onChange={(event) => {
              setUncontrolled(event.target.value);
              onChange?.(event);
            }}
            onKeyDown={(event: KeyboardEvent<HTMLSelectElement>) => {
              onKeyDown?.(event);
              if (event.defaultPrevented || !openKeys.has(event.key)) return;
              event.preventDefault();
              setOpen(true);
            }}
            onMouseDown={(event) => {
              event.preventDefault();
              if (!disabled) setOpen(true);
            }}
          >
            {children}
          </select>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            disabled={disabled}
            className="cloud-select-trigger"
            onClick={() => setOpen((state) => !state)}
          >
            <span
              className="cloud-select-value"
              data-placeholder={!selected || selected === placeholder}
            >
              {selected?.label || placeholder?.label || ""}
            </span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          className="cloud-menu cloud-select-menu"
          align="start"
          sideOffset={4}
          collisionPadding={12}
          onOpenAutoFocus={(event) => {
            if (options.length < searchThreshold) return;
            event.preventDefault();
            search.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            native.current?.focus();
          }}
        >
          <Command
            label={props["aria-label"] ?? "Options"}
            loop
            value={selected ? itemValue(selected) : undefined}
          >
            {options.length >= searchThreshold && (
              <Command.Input
                ref={search}
                className="cloud-menu-search"
                placeholder="Search…"
              />
            )}
            <Command.List className="cloud-menu-list">
              <Command.Empty className="cloud-menu-empty">
                No matches
              </Command.Empty>
              {groups.map((group) => (
                <Command.Group key={group} heading={group || undefined}>
                  {options
                    .filter(
                      (option) =>
                        option.group === group &&
                        !(option.disabled && option.value === ""),
                    )
                    .map((option) => (
                      <Command.Item
                        key={option.value}
                        value={itemValue(option)}
                        disabled={option.disabled}
                        onSelect={() => choose(option.value)}
                      >
                        <span className="cloud-menu-label">{option.label}</span>
                        {option.value === current && <Check size={14} />}
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
