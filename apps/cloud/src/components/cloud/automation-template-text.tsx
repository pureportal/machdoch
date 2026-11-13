"use client";

import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { VariableMenu } from "./automation-chips";

export function TemplateText({
  label,
  value,
  variables,
  rows = 4,
  maxLength,
  onChange,
}: {
  label: string;
  value: string;
  variables: string[];
  rows?: number;
  maxLength: number;
  onChange: (value: string) => void;
}) {
  return (
    <div className="cloud-automation-template">
      <div className="cloud-automation-template-heading">
        <Label>{label}</Label>
        <VariableMenu
          variables={variables}
          onInsert={(variable) => onChange(`${value}${variable}`)}
        />
      </div>
      <Textarea
        aria-label={label}
        rows={rows}
        maxLength={maxLength}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
