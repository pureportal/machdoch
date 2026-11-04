import { useId, type JSX } from "react";
import type {
  WorkspaceRunInput,
  WorkspaceRunInputValue,
  WorkspaceRunInputValues,
  WorkspaceRunSelectInput,
} from "../../../shared/workspace-run.js";
import { workspaceRunDefaultInputValue } from "../../../shared/workspace-run-inputs.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import { SettingsToggle } from "../chat-session/components/settings-dialog-panels/settings-toggle";
import { workspaceRunInputValueLabel } from "./workspace-run-model";

const MAX_SEGMENTED_OPTIONS = 4;
const MAX_SEGMENTED_LABEL_CHARACTERS = 18;

const usesSegmentedControl = (input: WorkspaceRunSelectInput): boolean =>
  input.options.length <= MAX_SEGMENTED_OPTIONS &&
  input.options.every(
    (option) =>
      workspaceRunInputValueLabel(input, option.value).length <=
      MAX_SEGMENTED_LABEL_CHARACTERS,
  );

const SelectField = ({
  input,
  value,
  labelId,
  describedBy,
  onChange,
}: {
  input: WorkspaceRunSelectInput;
  value: string;
  labelId: string;
  describedBy: string | undefined;
  onChange: (value: string) => void;
}): JSX.Element =>
  usesSegmentedControl(input) ? (
    <div
      role="radiogroup"
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      className="inline-flex w-fit max-w-full flex-wrap gap-1 rounded-lg border border-slate-800 bg-slate-950/70 p-0.5"
    >
      {input.options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            onClick={() => onChange(option.value)}
            className={cn(
              "h-7 rounded-md px-3 text-xs font-medium text-slate-400 outline-none transition-colors hover:text-slate-100 focus-visible:ring-2 focus-visible:ring-sky-500/70",
              checked && "bg-sky-500/15 text-sky-100 ring-1 ring-sky-400/40",
            )}
          >
            {workspaceRunInputValueLabel(input, option.value)}
          </button>
        );
      })}
    </div>
  ) : (
    <select
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      className="h-8 w-full rounded-md border border-slate-800 bg-slate-950 px-2 text-sm text-slate-100 outline-none focus-visible:border-sky-500 focus-visible:ring-2 focus-visible:ring-sky-500/40"
    >
      {input.options.map((option) => (
        <option key={option.value} value={option.value}>
          {workspaceRunInputValueLabel(input, option.value)}
        </option>
      ))}
    </select>
  );

const ArgumentField = ({
  input,
  value,
  error,
  onChange,
}: {
  input: WorkspaceRunInput;
  value: WorkspaceRunInputValue;
  error: string | undefined;
  onChange: (value: WorkspaceRunInputValue) => void;
}): JSX.Element => {
  const fieldId = useId();
  const labelId = `${fieldId}-label`;
  const descriptionId = input.description ? `${fieldId}-description` : null;
  const errorId = error ? `${fieldId}-error` : null;
  const describedBy =
    [descriptionId, errorId].filter(Boolean).join(" ") || undefined;
  const label = (
    <label
      id={labelId}
      htmlFor={input.type === "text" ? fieldId : undefined}
      className="text-xs font-medium text-slate-300"
    >
      {input.label}
    </label>
  );
  const description = input.description ? (
    <p
      id={descriptionId ?? undefined}
      className="text-[11px] leading-4 text-slate-500"
    >
      {input.description}
    </p>
  ) : null;
  const errorMessage = error ? (
    <p
      id={errorId ?? undefined}
      role="alert"
      className="text-[11px] text-red-300"
    >
      {error}
    </p>
  ) : null;

  if (input.type === "boolean") {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-800/80 bg-slate-950/40 py-1 pr-1 pl-3">
        <div className="grid min-w-0 gap-0.5">
          {label}
          {description}
        </div>
        <SettingsToggle
          label={input.label}
          checked={value === true}
          onCheckedChange={onChange}
        />
      </div>
    );
  }

  return (
    <div className="grid content-start gap-1.5">
      {label}
      {input.type === "select" ? (
        <SelectField
          input={input}
          value={String(value)}
          labelId={labelId}
          describedBy={describedBy}
          onChange={onChange}
        />
      ) : (
        <Input
          id={fieldId}
          value={String(value)}
          required={input.required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => onChange(event.currentTarget.value)}
          className="h-8 border-slate-800 bg-slate-950 font-mono text-xs"
        />
      )}
      {description}
      {errorMessage}
    </div>
  );
};

export const WorkspaceRunArguments = ({
  inputs,
  values,
  errors,
  disabled,
  onChange,
}: {
  inputs: readonly WorkspaceRunInput[];
  values: WorkspaceRunInputValues;
  errors: Record<string, string>;
  disabled: boolean;
  onChange: (values: WorkspaceRunInputValues) => void;
}): JSX.Element => (
  <fieldset disabled={disabled} className="grid gap-2.5 disabled:opacity-60">
    <legend className="mb-2.5 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
      Arguments
    </legend>
    <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
      {inputs.map((input) => (
        <ArgumentField
          key={input.id}
          input={input}
          value={values[input.id] ?? workspaceRunDefaultInputValue(input)}
          error={errors[input.id]}
          onChange={(value) => onChange({ ...values, [input.id]: value })}
        />
      ))}
    </div>
  </fieldset>
);
