"use client";

import { Check, Pipette } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { brandColorPresets } from "@/lib/organization-brand";
import { cn } from "@/lib/utils";

export function moveRadioSelection<T>(
  event: KeyboardEvent<HTMLElement>,
  options: readonly T[],
  value: T,
  onChange: (value: T) => void,
) {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[
    event.key
  ];
  if (!step) return;
  event.preventDefault();
  const index =
    (options.indexOf(value) + step + options.length) % options.length;
  onChange(options[index]!);
  const radios =
    event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]');
  radios[index]?.focus();
}

export function BrandSegmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string; icon?: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="cloud-brand-segmented"
      onKeyDown={(event) =>
        moveRadioSelection(
          event,
          options.map((option) => option.value),
          value,
          onChange,
        )
      }
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function BrandSwitch({
  id,
  label,
  checked,
  onChange,
  children,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <div className="cloud-brand-switch-row">
      <label htmlFor={id}>
        <span>{label}</span>
        {children}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        className="cloud-brand-switch"
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}

const hexPattern = /^#?([0-9a-f]{6})$/iu;

export function BrandColorField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  const [editing, setEditing] = useState(false);
  const preset = brandColorPresets.some((entry) => entry.color === value);
  const valid = !editing || hexPattern.test(text.trim());
  return (
    <div className="cloud-brand-color">
      <span className="cloud-brand-label" id={`${id}-label`}>
        {label}
      </span>
      <div className="cloud-brand-color-row">
        <div
          role="radiogroup"
          aria-labelledby={`${id}-label`}
          className="cloud-brand-swatches"
          onKeyDown={(event) =>
            moveRadioSelection(
              event,
              brandColorPresets.map((entry) => entry.color),
              value,
              onChange,
            )
          }
        >
          {brandColorPresets.map((entry, index) => (
            <button
              key={entry.color}
              type="button"
              role="radio"
              aria-checked={entry.color === value}
              aria-label={entry.name}
              title={entry.name}
              tabIndex={
                entry.color === value || (!preset && index === 0) ? 0 : -1
              }
              style={{ background: entry.color }}
              onClick={() => onChange(entry.color)}
            >
              {entry.color === value && <Check size={13} strokeWidth={3} />}
            </button>
          ))}
        </div>
        <label
          className="cloud-brand-custom"
          data-active={preset ? undefined : ""}
          style={preset ? undefined : { background: value }}
          title="Custom color"
        >
          <input
            type="color"
            aria-label={`Custom ${label.toLowerCase()}`}
            value={value}
            onChange={(event) => onChange(event.target.value.toLowerCase())}
          />
          {preset ? <Pipette size={13} /> : <Check size={13} strokeWidth={3} />}
        </label>
        <input
          id={id}
          className={cn("cloud-brand-hex", !valid && "cloud-brand-hex-invalid")}
          aria-label={`${label} hex`}
          aria-invalid={!valid}
          spellCheck={false}
          maxLength={7}
          value={editing ? text : value}
          onFocus={() => {
            setText(value);
            setEditing(true);
          }}
          onBlur={() => setEditing(false)}
          onChange={(event) => {
            setText(event.target.value);
            const match = hexPattern.exec(event.target.value.trim());
            if (match) onChange(`#${match[1]!.toLowerCase()}`);
          }}
        />
      </div>
    </div>
  );
}
