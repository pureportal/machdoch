import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { JSX } from "react";
import type {
  WorkspaceRunCompositeConfiguration,
  WorkspaceRunInput,
  WorkspaceRunTaskConfiguration,
} from "../../../shared/workspace-run.js";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import { ChoiceButtons } from "../chat-session/components/settings-dialog-panels/shared";
import {
  changeWorkspaceRunInputType,
  moveWorkspaceRunChild,
  toggleWorkspaceRunChild,
} from "./workspace-run-editor-model";
import {
  RUN_INPUT_CLASS,
  RUN_MONO_INPUT_CLASS,
  RUN_SELECT_CLASS,
  RunAdvancedDetails,
  RunCheckbox,
  RunField,
  RunParsedField,
  RunSection,
} from "./workspace-run-form-fields";

const START_ORDER_OPTIONS = [
  { value: "parallel", label: "Together" },
  { value: "sequence", label: "In order" },
] as const;

export const WorkspaceRunCompositeForm = ({
  configuration,
  candidates,
  disabled,
  onChange,
  onMakeDefault,
}: {
  configuration: WorkspaceRunCompositeConfiguration;
  candidates: readonly WorkspaceRunTaskConfiguration[];
  disabled: boolean;
  onChange: (next: WorkspaceRunCompositeConfiguration) => void;
  onMakeDefault: () => void;
}): JSX.Element => {
  const sequence = configuration.startOrder === "sequence";
  const ordered = [
    ...configuration.children.flatMap((id) =>
      candidates.filter((candidate) => candidate.id === id),
    ),
    ...candidates.filter(
      (candidate) => !configuration.children.includes(candidate.id),
    ),
  ];

  return (
    <div className="grid gap-6">
      <RunSection title="General">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
          <RunField label="Name">
            <Input
              value={configuration.name}
              disabled={disabled}
              onChange={(event) =>
                onChange({ ...configuration, name: event.target.value })
              }
              className={RUN_INPUT_CLASS}
            />
          </RunField>
          <RunField label="Start">
            <ChoiceButtons
              label="Start"
              value={configuration.startOrder}
              options={START_ORDER_OPTIONS}
              disabled={disabled}
              onChange={(startOrder) =>
                onChange({ ...configuration, startOrder })
              }
            />
          </RunField>
        </div>
        <RunCheckbox
          label="Default configuration"
          checked={configuration.primary}
          disabled={disabled || configuration.primary}
          onChange={onMakeDefault}
        />
      </RunSection>

      <RunSection title="Configurations">
        {ordered.length === 0 ? (
          <p className="text-sm text-slate-500">Add a service or job first.</p>
        ) : (
          <ul className="grid gap-1">
            {ordered.map((candidate) => {
              const included = configuration.children.includes(candidate.id);
              const position = configuration.children.indexOf(candidate.id);
              return (
                <li
                  key={candidate.id}
                  className="flex min-h-9 items-center gap-2 rounded-md border border-slate-800/70 px-2.5"
                >
                  <input
                    type="checkbox"
                    aria-label={`Include ${candidate.name}`}
                    checked={included}
                    disabled={disabled}
                    onChange={(event) =>
                      onChange(
                        toggleWorkspaceRunChild(
                          configuration,
                          candidate.id,
                          event.target.checked,
                        ),
                      )
                    }
                    className="size-3.5 accent-sky-500"
                  />
                  {sequence && included ? (
                    <span className="w-4 text-xs tabular-nums text-slate-500">
                      {position + 1}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-200">
                    {candidate.name}
                  </span>
                  <span className="shrink-0 text-xs text-slate-500">
                    {candidate.runType === "job" ? "Job" : "Service"}
                  </span>
                  {sequence && included ? (
                    <span className="flex shrink-0">
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Move ${candidate.name} up`}
                        disabled={disabled || position === 0}
                        onClick={() =>
                          onChange(
                            moveWorkspaceRunChild(
                              configuration,
                              candidate.id,
                              -1,
                            ),
                          )
                        }
                      >
                        <ArrowUp aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Move ${candidate.name} down`}
                        disabled={
                          disabled ||
                          position === configuration.children.length - 1
                        }
                        onClick={() =>
                          onChange(
                            moveWorkspaceRunChild(
                              configuration,
                              candidate.id,
                              1,
                            ),
                          )
                        }
                      >
                        <ArrowDown aria-hidden="true" />
                      </Button>
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </RunSection>

      <RunAdvancedDetails>
        <RunSection title="Identity">
          <RunField label="ID" className="md:max-w-sm">
            <Input
              value={configuration.id}
              disabled={disabled}
              spellCheck={false}
              onChange={(event) =>
                onChange({ ...configuration, id: event.target.value.trim() })
              }
              className={RUN_MONO_INPUT_CLASS}
            />
          </RunField>
        </RunSection>
      </RunAdvancedDetails>
    </div>
  );
};

const InputDefaultField = ({
  input,
  disabled,
  onChange,
}: {
  input: WorkspaceRunInput;
  disabled: boolean;
  onChange: (next: WorkspaceRunInput) => void;
}): JSX.Element => {
  if (input.type === "boolean") {
    return (
      <RunCheckbox
        label="On by default"
        checked={input.default}
        disabled={disabled}
        onChange={(value) => onChange({ ...input, default: value })}
      />
    );
  }
  if (input.type === "select") {
    return (
      <RunField label="Default">
        <select
          value={input.default ?? input.options[0]?.value ?? ""}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...input, default: event.target.value })
          }
          className={RUN_SELECT_CLASS}
        >
          {input.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label ?? option.value}
            </option>
          ))}
        </select>
      </RunField>
    );
  }
  return (
    <RunField label="Default">
      <Input
        value={input.default}
        disabled={disabled}
        onChange={(event) =>
          onChange({ ...input, default: event.target.value })
        }
        className={RUN_INPUT_CLASS}
      />
    </RunField>
  );
};

const parseOptions = (
  text: string,
): { value: { value: string; label?: string }[]; error: string | null } => {
  const options = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator <= 0) return { value: line };
      return {
        value: line.slice(0, separator).trim(),
        label: line.slice(separator + 1).trim(),
      };
    });
  const values = options.map((option) => option.value);
  if (options.length === 0) return { value: options, error: "Add an option." };
  if (new Set(values).size !== values.length) {
    return { value: options, error: "Options must be unique." };
  }
  return { value: options, error: null };
};

export const WorkspaceRunInputsForm = ({
  inputs,
  disabled,
  onChange,
  onAdd,
}: {
  inputs: readonly WorkspaceRunInput[];
  disabled: boolean;
  onChange: (inputs: WorkspaceRunInput[]) => void;
  onAdd: () => void;
}): JSX.Element => {
  const replace = (index: number, next: WorkspaceRunInput): void =>
    onChange(
      inputs.map((input, current) => (current === index ? next : input)),
    );

  return (
    <RunSection
      title="Inputs"
      action={
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={onAdd}
        >
          <Plus aria-hidden="true" />
          Add input
        </Button>
      }
    >
      {inputs.length === 0 ? (
        <p className="text-sm text-slate-500">
          Reference inputs in commands as{" "}
          <code className="font-mono text-slate-300">{"${input:id}"}</code>.
        </p>
      ) : null}
      {inputs.map((input, index) => (
        <div
          key={index}
          className="grid gap-3 rounded-lg border border-slate-800/80 bg-slate-950/40 p-3"
        >
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_9rem_auto] md:items-end">
            <RunField label="Label">
              <Input
                value={input.label}
                disabled={disabled}
                onChange={(event) =>
                  replace(index, { ...input, label: event.target.value })
                }
                className={RUN_INPUT_CLASS}
              />
            </RunField>
            <RunField label="ID">
              <Input
                value={input.id}
                disabled={disabled}
                spellCheck={false}
                onChange={(event) =>
                  replace(index, { ...input, id: event.target.value.trim() })
                }
                className={RUN_MONO_INPUT_CLASS}
              />
            </RunField>
            <RunField label="Type">
              <select
                value={input.type}
                disabled={disabled}
                onChange={(event) =>
                  replace(
                    index,
                    changeWorkspaceRunInputType(
                      input,
                      event.target.value as WorkspaceRunInput["type"],
                    ),
                  )
                }
                className={RUN_SELECT_CLASS}
              >
                <option value="text">Text</option>
                <option value="select">Choice</option>
                <option value="boolean">Switch</option>
              </select>
            </RunField>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove ${input.label || input.id}`}
              disabled={disabled}
              onClick={() =>
                onChange(inputs.filter((_input, current) => current !== index))
              }
              className="text-slate-400 hover:text-red-300"
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
          <div className="grid gap-3 md:grid-cols-2 md:items-end">
            {input.type === "select" ? (
              <RunParsedField
                fieldKey={`input:${input.id}:options`}
                key={`${index}-${input.type}`}
                label="Options"
                multiline
                initialText={input.options
                  .map((option) =>
                    option.label
                      ? `${option.value}=${option.label}`
                      : option.value,
                  )
                  .join("\n")}
                placeholder={"dev=Development\nprod=Production"}
                disabled={disabled}
                parse={parseOptions}
                onCommit={(options) =>
                  replace(index, {
                    ...input,
                    options,
                    default: options.some(
                      (option) => option.value === input.default,
                    )
                      ? input.default
                      : options[0]?.value,
                  })
                }
              />
            ) : null}
            <InputDefaultField
              input={input}
              disabled={disabled}
              onChange={(next) => replace(index, next)}
            />
            {input.type === "text" ? (
              <RunCheckbox
                label="Required"
                checked={input.required}
                disabled={disabled}
                onChange={(required) => replace(index, { ...input, required })}
              />
            ) : null}
            {input.type === "boolean" ? (
              <div className="grid grid-cols-2 gap-3">
                <RunField label="When on">
                  <Input
                    value={input.trueValue}
                    disabled={disabled}
                    onChange={(event) =>
                      replace(index, {
                        ...input,
                        trueValue: event.target.value,
                      })
                    }
                    className={RUN_MONO_INPUT_CLASS}
                  />
                </RunField>
                <RunField label="When off">
                  <Input
                    value={input.falseValue}
                    disabled={disabled}
                    onChange={(event) =>
                      replace(index, {
                        ...input,
                        falseValue: event.target.value,
                      })
                    }
                    className={RUN_MONO_INPUT_CLASS}
                  />
                </RunField>
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </RunSection>
  );
};
