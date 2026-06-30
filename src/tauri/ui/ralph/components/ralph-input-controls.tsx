import type { JSX } from "react";

import type {
  RalphFlowVariable,
  RalphInputField,
  RalphInputValue,
} from "../../../../core/ralph.js";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";
import { normalizeRalphBooleanVariableValue } from "../_helpers/validate-ralph-flow-variable-values.helper";

interface RalphInputControlProps {
  field: RalphInputField;
  value: RalphInputValue | undefined;
  onChange: (value: RalphInputValue) => void;
}

interface RalphSetupVariableControlProps {
  variable: RalphFlowVariable;
  value: string;
  error?: string | undefined;
  errorId?: string | undefined;
  onChange: (variableName: string, value: string) => void;
}

const COMMON_INPUT_CLASS_NAME =
  "border-slate-700 bg-slate-950 text-sm text-slate-100";

const COMMON_SETUP_CLASS_NAME =
  "border border-slate-700 bg-slate-950 text-sm text-slate-100 placeholder:text-slate-600";

const ERROR_SETUP_CLASS_NAME =
  "border-rose-400/80 bg-rose-950/20 ring-1 ring-rose-400/25 focus-visible:border-rose-300 focus-visible:ring-rose-400/40";

export const RalphInputControl = ({
  field,
  value,
  onChange,
}: RalphInputControlProps): JSX.Element => {
  if (field.type === "textarea") {
    return (
      <Textarea
        value={typeof value === "string" ? value : ""}
        aria-label={field.label}
        placeholder={field.placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={cn("min-h-24", COMMON_INPUT_CLASS_NAME)}
      />
    );
  }

  if (field.type === "number") {
    return (
      <Input
        type="number"
        value={typeof value === "number" ? value : typeof value === "string" ? value : ""}
        aria-label={field.label}
        placeholder={field.placeholder}
        onChange={(event) =>
          onChange(event.target.value ? Number(event.target.value) : null)
        }
        className={cn("h-9", COMMON_INPUT_CLASS_NAME)}
      />
    );
  }

  if (field.type === "boolean") {
    return (
      <label className="flex items-center gap-2 rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        Yes
      </label>
    );
  }

  if (field.type === "select") {
    return (
      <select
        value={typeof value === "string" ? value : ""}
        aria-label={field.label}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
      >
        <option value="">Select...</option>
        {(field.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  if (field.type === "multiselect") {
    const values = Array.isArray(value) ? value : [];

    return (
      <div className="grid gap-1.5 rounded border border-slate-800 bg-slate-950 p-2">
        {(field.options ?? []).map((option) => {
          const checked = values.includes(option.value);

          return (
            <label
              key={option.value}
              className="flex items-center gap-2 text-sm text-slate-200"
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) => {
                  const nextValues = event.target.checked
                    ? [...values, option.value]
                    : values.filter((entry) => entry !== option.value);
                  onChange(nextValues);
                }}
              />
              {option.label}
            </label>
          );
        })}
      </div>
    );
  }

  if (field.type === "files" || field.type === "images") {
    return (
      <Textarea
        value={Array.isArray(value) ? value.join("\n") : ""}
        aria-label={field.label}
        placeholder={field.placeholder ?? "One path per line"}
        onChange={(event) =>
          onChange(
            event.target.value
              .split("\n")
              .map((entry) => entry.trim())
              .filter(Boolean),
          )
        }
        className={cn("min-h-20 font-mono text-xs", COMMON_INPUT_CLASS_NAME)}
      />
    );
  }

  return (
    <Input
      value={typeof value === "string" ? value : ""}
      aria-label={field.label}
      placeholder={field.placeholder}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        "h-9",
        field.type === "path" ||
          field.type === "file" ||
          field.type === "image" ||
          field.type === "url"
          ? "font-mono text-xs"
          : "",
        COMMON_INPUT_CLASS_NAME,
      )}
    />
  );
};

export const RalphSetupVariableControl = ({
  variable,
  value,
  error,
  errorId,
  onChange,
}: RalphSetupVariableControlProps): JSX.Element => {
  const commonClassName = cn(
    COMMON_SETUP_CLASS_NAME,
    error && ERROR_SETUP_CLASS_NAME,
  );

  if (variable.type === "boolean") {
    const normalizedValue = normalizeRalphBooleanVariableValue(value);
    const selectedValue = normalizedValue ?? "";
    const showUnsetOption =
      !variable.required || variable.default === undefined || !selectedValue;

    return (
      <select
        value={selectedValue}
        aria-label={`Ralph variable ${variable.name}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        onChange={(event) => onChange(variable.name, event.target.value)}
        className={cn("h-9 rounded-md px-3", commonClassName)}
      >
        {showUnsetOption ? <option value="">Unset</option> : null}
        <option value="true">True</option>
        <option value="false">False</option>
      </select>
    );
  }

  if (variable.type === "files" || variable.type === "images") {
    return (
      <Textarea
        value={value}
        aria-label={`Ralph variable ${variable.name}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        placeholder={variable.default ?? "One path per line"}
        onChange={(event) => onChange(variable.name, event.target.value)}
        className={cn("min-h-20", "font-mono text-xs", commonClassName)}
      />
    );
  }

  return (
    <Input
      type={variable.type === "number" || variable.type === "url" ? variable.type : "text"}
      inputMode={variable.type === "number" ? "decimal" : undefined}
      value={value}
      aria-label={`Ralph variable ${variable.name}`}
      aria-invalid={error ? true : undefined}
      aria-describedby={errorId}
      placeholder={variable.default ?? variable.name}
      onChange={(event) => onChange(variable.name, event.target.value)}
      className={cn(
        "h-9",
        variable.type === "path" ||
          variable.type === "file" ||
          variable.type === "image" ||
          variable.type === "number" ||
          variable.type === "url"
          ? "font-mono text-xs"
          : "",
        commonClassName,
      )}
    />
  );
};
