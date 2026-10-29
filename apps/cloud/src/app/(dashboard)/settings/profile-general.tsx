"use client";

import { useState } from "react";
import type { ManagedSettingsPolicyField } from "@machdoch/fleet-protocol";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ShowMore } from "@/components/show-more";
import { isDraftFieldSet } from "./profile-drafts";
import type {
  ProfileGeneralDraft,
  ProfileGeneralValues,
} from "./profile-drafts";
import { settingsError } from "./use-settings-profiles";

const providerOptions = [
  "openai",
  "anthropic",
  "google",
  "langdock",
  "codex-cli",
  "claude-cli",
  "copilot-cli",
];
const reasoningOptions = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "aeon",
];

export function ProfileGeneral({
  draft,
  disabled,
  legacyPolicy,
  onChange,
  onSave,
}: {
  draft: ProfileGeneralDraft;
  disabled: boolean;
  legacyPolicy: boolean;
  onChange: (values: ProfileGeneralValues) => void;
  onSave: () => Promise<void>;
}): React.ReactElement {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const { values } = draft;
  const { defaults, agentLimits: limits } = values;
  const enforce = (field: ManagedSettingsPolicyField, label: string) => {
    // Unset values are not delivered, so there is nothing to enforce.
    const set = isDraftFieldSet(values, field);
    return (
      <EnforceToggle
        label={label}
        set={set}
        checked={set && values.enforced.includes(field)}
        onChange={(checked) =>
          onChange({
            ...values,
            enforced: checked
              ? [...values.enforced, field]
              : values.enforced.filter((entry) => entry !== field),
          })
        }
      />
    );
  };
  const changeDefault = (
    name: keyof ProfileGeneralValues["defaults"],
    value: string,
  ) => {
    onChange({ ...values, defaults: { ...defaults, [name]: value } });
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (pending || disabled) return;
        setPending(true);
        setError("");
        void Promise.resolve()
          .then(onSave)
          .catch((reason: unknown) => setError(settingsError(reason)))
          .finally(() => setPending(false));
      }}
    >
      <fieldset disabled={pending} className="grid min-w-0 gap-6">
        <div className="grid gap-5">
          <h3 className="font-medium">Profile</h3>
          <div className="grid items-start gap-5 md:grid-cols-2">
            <Field label="Name" htmlFor="settings-profile-name">
              <Input
                id="settings-profile-name"
                name="name"
                value={values.name}
                onChange={(event) =>
                  onChange({ ...values, name: event.target.value })
                }
                required
              />
            </Field>
            <Field label="Description" htmlFor="settings-profile-description">
              <Input
                id="settings-profile-description"
                name="description"
                value={values.description}
                onChange={(event) =>
                  onChange({ ...values, description: event.target.value })
                }
              />
            </Field>
          </div>
        </div>
        <div className="grid gap-5">
          <div className="grid gap-1">
            <h3 className="font-medium">Defaults</h3>
            <p className="text-sm text-muted-foreground">
              Defaults are applied once and users can change them. Enforced
              values always win on every device. Settings left unset are not
              delivered.
            </p>
            {legacyPolicy ? (
              <p role="status" className="text-sm">
                This profile was created before per-setting enforcement, so
                every configured value is enforced. Clear a checkbox and save to
                turn a value into a default.
              </p>
            ) : null}
          </div>
          <div className="grid items-start gap-5 md:grid-cols-2">
            <Field label="Provider" htmlFor="provider">
              <Select
                id="provider"
                name="provider"
                value={defaults.provider}
                onChange={(event) =>
                  changeDefault("provider", event.target.value)
                }
              >
                <option value="">Not set</option>
                {providerOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
              {enforce("model", "provider and model")}
            </Field>
            <Field label="Model" htmlFor="model">
              <Input
                id="model"
                name="model"
                value={defaults.model}
                onChange={(event) => changeDefault("model", event.target.value)}
                disabled={!defaults.provider}
              />
            </Field>
            <SelectField
              label="Mode"
              name="mode"
              enforcement={enforce("mode", "mode")}
              value={defaults.mode}
              onChange={(value) => changeDefault("mode", value)}
              options={["ask", "machdoch"]}
            />
            <SelectField
              label="Reasoning"
              name="reasoning"
              enforcement={enforce("reasoning", "reasoning")}
              value={defaults.reasoning}
              onChange={(value) => changeDefault("reasoning", value)}
              options={reasoningOptions}
            />
          </div>
        </div>
        <ShowMore>
          <div className="grid items-start gap-5 md:grid-cols-2">
            <SelectField
              label="Web search"
              name="webSearchProvider"
              enforcement={enforce("webSearchProvider", "web search")}
              value={defaults.webSearchProvider}
              onChange={(value) => changeDefault("webSearchProvider", value)}
              options={["none", "perplexity", "tavily", "serper"]}
            />
            <SelectField
              label="Theme"
              name="theme"
              enforcement={enforce("theme", "theme")}
              value={defaults.theme}
              onChange={(value) => changeDefault("theme", value)}
              options={["dark", "light"]}
            />
            <SelectField
              label="Density"
              name="density"
              enforcement={enforce("density", "density")}
              value={defaults.density}
              onChange={(value) => changeDefault("density", value)}
              options={["comfortable", "compact"]}
            />
            <SelectField
              label="Accent"
              name="accent"
              enforcement={enforce("accent", "accent")}
              value={defaults.accent}
              onChange={(value) => changeDefault("accent", value)}
              options={["sky", "emerald", "violet", "amber"]}
            />
          </div>
          <div className="grid gap-5">
            <h3 className="font-medium">Agent limits</h3>
            <div className="grid items-start gap-5 md:grid-cols-3">
              <SelectField
                label="Infinite mode"
                name="infinite"
                enforcement={enforce("infinite", "infinite mode")}
                value={limits.infinite}
                onChange={(value) =>
                  onChange({
                    ...values,
                    agentLimits: {
                      ...limits,
                      infinite:
                        value as ProfileGeneralValues["agentLimits"]["infinite"],
                    },
                  })
                }
                options={["true", "false"]}
                labels={{ true: "Enabled", false: "Disabled" }}
              />
              <NumberField
                label="Executor turns"
                name="executorTurns"
                enforcement={enforce("executorTurns", "executor turns")}
                value={limits.executorTurns}
                onChange={(value) =>
                  onChange({
                    ...values,
                    agentLimits: { ...limits, executorTurns: value },
                  })
                }
              />
              <NumberField
                label="Autopilot iterations"
                name="autopilotExecutorIterations"
                enforcement={enforce(
                  "autopilotExecutorIterations",
                  "autopilot iterations",
                )}
                value={limits.autopilotExecutorIterations}
                onChange={(value) =>
                  onChange({
                    ...values,
                    agentLimits: {
                      ...limits,
                      autopilotExecutorIterations: value,
                    },
                  })
                }
              />
            </div>
          </div>
        </ShowMore>
        {error ? (
          <p role="alert" className="break-words text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button
          type="submit"
          className="w-full sm:w-fit"
          disabled={pending || disabled}
        >
          {pending ? "Saving…" : "Save profile"}
        </Button>
      </fieldset>
    </form>
  );
}

function EnforceToggle({
  label,
  set,
  checked,
  onChange,
}: {
  label: string;
  set: boolean;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): React.ReactElement {
  return (
    <label className="flex min-h-8 w-fit items-center gap-2 text-xs text-muted-foreground has-[:disabled]:opacity-70">
      <input
        type="checkbox"
        className="size-4 accent-primary"
        checked={checked}
        disabled={!set}
        aria-label={`Enforce ${label}`}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span aria-hidden="true">
        {!set
          ? "Not set · choose a value to deliver it"
          : checked
            ? "Enforced · always wins"
            : "Default · users can change it"}
      </span>
    </label>
  );
}

function SelectField({
  label,
  name,
  value,
  onChange,
  options,
  labels = {},
  enforcement,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  labels?: Record<string, string>;
  enforcement?: React.ReactNode;
}): React.ReactElement {
  return (
    <Field label={label} htmlFor={name}>
      <Select
        id={name}
        name={name}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Not set</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {labels[option] ?? option}
          </option>
        ))}
      </Select>
      {enforcement}
    </Field>
  );
}

function NumberField({
  label,
  name,
  value,
  onChange,
  enforcement,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  enforcement?: React.ReactNode;
}): React.ReactElement {
  return (
    <Field label={label} htmlFor={name}>
      <Input
        id={name}
        name={name}
        type="number"
        min={1}
        max={100000}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {enforcement}
    </Field>
  );
}
