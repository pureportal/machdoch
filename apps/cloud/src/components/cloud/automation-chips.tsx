"use client";

import { Braces } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { PropertyMenu } from "./property-menu";

export function ChipToggle({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: { value: string; label: string; icon?: ReactNode }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="cloud-automation-chips" role="group" aria-label={label}>
      {options.map((option) => {
        const active = selected.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            className="cloud-automation-chip"
            aria-pressed={active}
            onClick={() =>
              onChange(
                active
                  ? selected.filter((value) => value !== option.value)
                  : [...selected, option.value],
              )
            }
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function VariableMenu({
  variables,
  onInsert,
}: {
  variables: string[];
  onInsert: (variable: string) => void;
}) {
  return (
    <PropertyMenu
      label="Insert variable"
      options={variables.map((variable) => ({
        value: variable,
        label: variable,
      }))}
      onSelect={(variable) => onInsert(`{{${variable}}}`)}
      align="end"
    >
      <Button type="button" variant="ghost" size="sm">
        <Braces />
        Variable
      </Button>
    </PropertyMenu>
  );
}
