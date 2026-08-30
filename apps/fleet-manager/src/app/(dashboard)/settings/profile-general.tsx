"use client";

import { useState } from "react";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ManagedSettingsDocument, SettingsProfile } from "./types";

const agentOptions = ["codex-cli", "claude-cli", "copilot-cli"];
const providerOptions = [
  "openai",
  "anthropic",
  "google",
  "langdock",
  "quiver",
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
];

export function ProfileGeneral({
  profile,
  onSave,
}: {
  profile: SettingsProfile;
  onSave: (
    document: ManagedSettingsDocument,
    summary: string,
    details: { name: string; description: string },
  ) => Promise<void>;
}): React.ReactElement {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const defaults = profile.document.defaults;
  const limits = profile.document.agentLimits;
  return (
    <form
      className="grid gap-8"
      onSubmit={(event) => {
        event.preventDefault();
        setError("");
        const form = new FormData(event.currentTarget);
        let customValues: Record<string, unknown>;
        try {
          const parsed = JSON.parse(
            String(form.get("customValues") || "{}"),
          ) as unknown;
          if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
            throw new Error("Custom values must be a JSON object.");
          }
          customValues = parsed as Record<string, unknown>;
        } catch (reason) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Custom values are invalid.",
          );
          return;
        }
        const document = structuredClone(profile.document);
        document.defaults = {
          preferredToolingAgent: optional(form, "preferredToolingAgent"),
          provider: optional(form, "provider"),
          model: optional(form, "model"),
          mode: optional(form, "mode"),
          reasoning: optional(form, "reasoning"),
          webSearchProvider: optional(form, "webSearchProvider"),
          theme: optional(form, "theme"),
          density: optional(form, "density"),
          accent: optional(form, "accent"),
        };
        document.agentLimits = {
          infinite:
            form.get("infinite") === ""
              ? null
              : form.get("infinite") === "true",
          executorTurns: optionalNumber(form, "executorTurns"),
          autopilotExecutorIterations: optionalNumber(
            form,
            "autopilotExecutorIterations",
          ),
        };
        document.customValues = customValues;
        setPending(true);
        void onSave(document, "Updated profile", {
          name: String(form.get("name")),
          description: String(form.get("description")),
        })
          .catch(() => undefined)
          .finally(() => setPending(false));
      }}
    >
      <div className="grid gap-5">
        <h3 className="font-medium">Profile</h3>
        <div className="grid gap-5 md:grid-cols-2">
          <Field label="Name" htmlFor="settings-profile-name">
            <Input
              id="settings-profile-name"
              name="name"
              defaultValue={profile.name}
              required
            />
          </Field>
          <Field label="Description" htmlFor="settings-profile-description">
            <Input
              id="settings-profile-description"
              name="description"
              defaultValue={profile.description}
            />
          </Field>
        </div>
      </div>
      <div className="grid gap-5">
        <h3 className="font-medium">Defaults</h3>
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          <SelectField
            label="Tooling agent"
            name="preferredToolingAgent"
            value={defaults.preferredToolingAgent}
            options={agentOptions}
          />
          <SelectField
            label="Provider"
            name="provider"
            value={defaults.provider}
            options={providerOptions}
          />
          <Field label="Model" htmlFor="model">
            <Input
              id="model"
              name="model"
              defaultValue={defaults.model ?? ""}
            />
          </Field>
          <SelectField
            label="Mode"
            name="mode"
            value={defaults.mode}
            options={["ask", "machdoch"]}
          />
          <SelectField
            label="Reasoning"
            name="reasoning"
            value={defaults.reasoning}
            options={reasoningOptions}
          />
          <SelectField
            label="Web search"
            name="webSearchProvider"
            value={defaults.webSearchProvider}
            options={["none", "perplexity", "tavily", "serper"]}
          />
          <SelectField
            label="Theme"
            name="theme"
            value={defaults.theme}
            options={["dark", "light"]}
          />
          <SelectField
            label="Density"
            name="density"
            value={defaults.density}
            options={["comfortable", "compact"]}
          />
          <SelectField
            label="Accent"
            name="accent"
            value={defaults.accent}
            options={["sky", "emerald", "violet", "amber"]}
          />
        </div>
      </div>
      <div className="grid gap-5">
        <h3 className="font-medium">Agent limits</h3>
        <div className="grid gap-5 md:grid-cols-3">
          <SelectField
            label="Infinite mode"
            name="infinite"
            value={limits.infinite === null ? null : String(limits.infinite)}
            options={["true", "false"]}
            labels={{ true: "Enabled", false: "Disabled" }}
          />
          <NumberField
            label="Executor turns"
            name="executorTurns"
            value={limits.executorTurns}
          />
          <NumberField
            label="Autopilot iterations"
            name="autopilotExecutorIterations"
            value={limits.autopilotExecutorIterations}
          />
        </div>
      </div>
      <Field
        label="Custom values"
        htmlFor="custom-values"
        hint="Enter a JSON object."
      >
        <Textarea
          id="custom-values"
          name="customValues"
          className="min-h-36 font-mono text-xs"
          defaultValue={JSON.stringify(profile.document.customValues, null, 2)}
        />
      </Field>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" className="w-fit" disabled={pending}>
        {pending ? "Saving…" : "Save profile"}
      </Button>
    </form>
  );
}

function SelectField({
  label,
  name,
  value,
  options,
  labels = {},
}: {
  label: string;
  name: string;
  value: string | null;
  options: string[];
  labels?: Record<string, string>;
}): React.ReactElement {
  return (
    <Field label={label} htmlFor={name}>
      <Select id={name} name={name} defaultValue={value ?? ""}>
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
}: {
  label: string;
  name: string;
  value: number | null;
}): React.ReactElement {
  return (
    <Field label={label} htmlFor={name}>
      <Input
        id={name}
        name={name}
        type="number"
        min={1}
        max={100000}
        defaultValue={value ?? ""}
      />
    </Field>
  );
}

function optional(form: FormData, name: string): string | null {
  return String(form.get(name) ?? "").trim() || null;
}

function optionalNumber(form: FormData, name: string): number | null {
  const value = String(form.get(name) ?? "").trim();
  return value ? Number(value) : null;
}
