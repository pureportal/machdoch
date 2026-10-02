"use client";

import { useState } from "react";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ShowMore } from "@/components/show-more";
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
  onChange,
  onSave,
}: {
  draft: ProfileGeneralDraft;
  disabled: boolean;
  onChange: (values: ProfileGeneralValues) => void;
  onSave: () => Promise<void>;
}): React.ReactElement {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const { values } = draft;
  const { defaults, agentLimits: limits } = values;
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
          <div className="grid gap-5 md:grid-cols-2">
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
          <h3 className="font-medium">Defaults</h3>
          <div className="grid gap-5 md:grid-cols-2">
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
              value={defaults.mode}
              onChange={(value) => changeDefault("mode", value)}
              options={["ask", "machdoch"]}
            />
            <SelectField
              label="Reasoning"
              name="reasoning"
              value={defaults.reasoning}
              onChange={(value) => changeDefault("reasoning", value)}
              options={reasoningOptions}
            />
          </div>
        </div>
        <ShowMore>
          <div className="grid gap-5 md:grid-cols-2">
            <SelectField
              label="Web search"
              name="webSearchProvider"
              value={defaults.webSearchProvider}
              onChange={(value) => changeDefault("webSearchProvider", value)}
              options={["none", "perplexity", "tavily", "serper"]}
            />
            <SelectField
              label="Theme"
              name="theme"
              value={defaults.theme}
              onChange={(value) => changeDefault("theme", value)}
              options={["dark", "light"]}
            />
            <SelectField
              label="Density"
              name="density"
              value={defaults.density}
              onChange={(value) => changeDefault("density", value)}
              options={["comfortable", "compact"]}
            />
            <SelectField
              label="Accent"
              name="accent"
              value={defaults.accent}
              onChange={(value) => changeDefault("accent", value)}
              options={["sky", "emerald", "violet", "amber"]}
            />
          </div>
          <div className="grid gap-5">
            <h3 className="font-medium">Agent limits</h3>
            <div className="grid gap-5 md:grid-cols-3">
              <SelectField
                label="Infinite mode"
                name="infinite"
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

function SelectField({
  label,
  name,
  value,
  onChange,
  options,
  labels = {},
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  labels?: Record<string, string>;
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
    </Field>
  );
}

function NumberField({
  label,
  name,
  value,
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
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
    </Field>
  );
}
