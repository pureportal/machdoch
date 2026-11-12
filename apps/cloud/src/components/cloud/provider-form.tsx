"use client";

import { useRef, useState } from "react";
import {
  isCloudCliProvider,
  type CloudAiProvider,
  type CloudProviderKind,
} from "@machdoch/fleet-protocol/cloud-providers";
import {
  defaultProviderLimits,
  defaultProviderModels,
  keyLabels,
  providerChoices,
  providerLabels,
  providerModelChoices,
  splitProviderModels,
} from "@/lib/cloud-provider-presets";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createCommandSender, formText } from "./api-client";

type Authentication = "sign-in" | "api-key";

function customModels(text: string): string[] {
  return text
    .split("\n")
    .map((model) => model.trim())
    .filter(Boolean);
}

export function ProviderDialog({
  provider,
  onClose,
  onSaved,
}: {
  provider: CloudAiProvider | null;
  onClose: () => void;
  onSaved: (id: string, signIn: boolean) => void;
}) {
  const sender = useRef(createCommandSender());
  const initial = provider
    ? splitProviderModels(provider.provider, provider.models)
    : null;
  const [kind, setKind] = useState<CloudProviderKind>(
    provider?.provider ?? "claude-code-cli",
  );
  const [name, setName] = useState(
    provider?.name ?? providerLabels["claude-code-cli"],
  );
  const [authentication, setAuthentication] = useState<Authentication>(
    !provider || provider.signIn ? "sign-in" : "api-key",
  );
  const [selected, setSelected] = useState<string[]>(
    initial?.known ?? defaultProviderModels("claude-code-cli"),
  );
  const [custom, setCustom] = useState(initial?.custom.join("\n") ?? "");
  const [replaceKey, setReplaceKey] = useState(false);
  const [region, setRegion] = useState(provider?.region ?? "eu");
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const cli = isCloudCliProvider(kind);
  const signIn = cli && authentication === "sign-in";
  const switchingToKey = !!provider?.signIn && !signIn;
  const keyChanges = provider
    ? cli && authentication === "sign-in"
      ? !provider.signIn
      : switchingToKey || replaceKey
    : !signIn;
  const models = [
    ...providerModelChoices(kind)
      .map((model) => model.id)
      .filter((model) => selected.includes(model)),
    ...customModels(custom),
  ];
  const accessChanges =
    !!provider &&
    (keyChanges ||
      (kind === "langdock" && region !== provider.region) ||
      enabled !== provider.enabled ||
      provider.models.some((model) => !models.includes(model)));
  function choose(next: CloudProviderKind) {
    if (name === providerLabels[kind] || !name.trim())
      setName(providerLabels[next]);
    setKind(next);
    setAuthentication("sign-in");
    setSelected(defaultProviderModels(next));
    setCustom("");
  }
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={provider ? "Edit AI provider" : "Add AI provider"}
      submitLabel={provider ? "Save provider" : "Add provider"}
      onSubmit={async (form) => {
        if (!models.length) throw new Error("Choose at least one model.");
        const configuration = {
          name: name.trim(),
          models,
          region: kind === "langdock" ? region : null,
          maxOutputTokens: Number(formText(form, "maxOutputTokens")),
          dailyTokenBudget: Number(formText(form, "dailyTokenBudget")),
          maxConcurrentRequests: Number(
            formText(form, "maxConcurrentRequests"),
          ),
        };
        const apiKey = signIn ? "" : formText(form, "apiKey");
        const result = await sender.current<{ id: string }>(
          provider ? `ai-providers/${provider.id}` : "ai-providers",
          provider
            ? {
                ...configuration,
                revision: provider.revision,
                enabled,
                ...(keyChanges ? { apiKey } : {}),
              }
            : { ...configuration, provider: kind, apiKey },
          provider ? "PATCH" : "POST",
        );
        onSaved(result.id, signIn);
      }}
    >
      {!provider && (
        <div
          className="cloud-provider-kinds"
          role="radiogroup"
          aria-label="Provider"
        >
          {providerChoices.map((choice) => (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={choice === kind}
              onClick={() => choose(choice)}
            >
              {providerLabels[choice]}
            </button>
          ))}
        </div>
      )}
      <Field label="Name" htmlFor="ai-provider-name">
        <Input
          id="ai-provider-name"
          required
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      {cli && (
        <div
          className="cloud-provider-authentication"
          role="radiogroup"
          aria-label="Authentication"
        >
          {(
            [
              ["sign-in", "Sign in"],
              ["api-key", keyLabels[kind]],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={authentication === value}
              onClick={() => setAuthentication(value)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {kind === "langdock" && (
        <Field label="Region" htmlFor="ai-provider-region">
          <Select
            id="ai-provider-region"
            value={region}
            onChange={(event) => setRegion(event.target.value as "eu" | "us")}
          >
            <option value="eu">EU</option>
            <option value="us">US</option>
          </Select>
        </Field>
      )}
      {!signIn && provider && !switchingToKey && (
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={replaceKey}
            onChange={(event) => setReplaceKey(event.target.checked)}
          />
          Replace {keyLabels[kind].toLowerCase()}
        </label>
      )}
      {!signIn && (!provider || switchingToKey || replaceKey) && (
        <Field label={keyLabels[kind]} htmlFor="ai-provider-key">
          <Input
            id="ai-provider-key"
            type="password"
            name="apiKey"
            autoComplete="new-password"
            required
            maxLength={8192}
          />
        </Field>
      )}
      <fieldset className="cloud-provider-model-field">
        <legend>Models</legend>
        <div className="cloud-provider-model-options">
          {providerModelChoices(kind).map((model) => (
            <label key={model.id}>
              <input
                type="checkbox"
                checked={selected.includes(model.id)}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, model.id]
                      : current.filter((entry) => entry !== model.id),
                  )
                }
              />
              <span>{model.label}</span>
              <code>{model.id}</code>
            </label>
          ))}
        </div>
        <Field
          label="Other models"
          htmlFor="ai-provider-models"
          hint="One model ID per line."
        >
          <Textarea
            id="ai-provider-models"
            rows={2}
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
          />
        </Field>
      </fieldset>
      <details className="cloud-provider-limits">
        <summary>Limits</summary>
        <div className="grid grid-cols-3 gap-4">
          <Field label="Output tokens" htmlFor="ai-output-tokens">
            <Input
              id="ai-output-tokens"
              name="maxOutputTokens"
              type="number"
              required
              min={64}
              max={65536}
              step={1}
              defaultValue={
                provider?.maxOutputTokens ??
                defaultProviderLimits.maxOutputTokens
              }
            />
          </Field>
          <Field label="Daily tokens" htmlFor="ai-daily-budget">
            <Input
              id="ai-daily-budget"
              name="dailyTokenBudget"
              type="number"
              required
              min={1000}
              max={100000000}
              step={1}
              defaultValue={
                provider?.dailyTokenBudget ??
                defaultProviderLimits.dailyTokenBudget
              }
            />
          </Field>
          <Field label="Parallel requests" htmlFor="ai-concurrency">
            <Input
              id="ai-concurrency"
              name="maxConcurrentRequests"
              type="number"
              required
              min={1}
              max={32}
              step={1}
              defaultValue={
                provider?.maxConcurrentRequests ??
                defaultProviderLimits.maxConcurrentRequests
              }
            />
          </Field>
        </div>
      </details>
      {provider && (
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enabled
        </label>
      )}
      {accessChanges && (
        <p role="status" className="text-muted-foreground">
          Active AI work using this provider will stop.
        </p>
      )}
    </FormDialog>
  );
}
