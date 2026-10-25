"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  cloudApiProviders,
  type CloudAiProvider,
  type CloudProviderSettings,
} from "@machdoch/fleet-protocol/cloud-providers";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createCommandSender, formText } from "./api-client";
import { ProviderUsage } from "./provider-usage";

const providerNames = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  langdock: "Langdock",
};

export function AiProviderSettings({
  settings,
}: {
  settings: CloudProviderSettings;
}) {
  const router = useRouter();
  const sender = useRef(createCommandSender());
  const [editing, setEditing] = useState<CloudAiProvider | "new" | null>(null);
  const [kind, setKind] = useState<CloudAiProvider["provider"]>("openai");
  const [replaceKey, setReplaceKey] = useState(false);
  const [grantChanged, setGrantChanged] = useState(false);
  const provider = editing && editing !== "new" ? editing : null;
  function open(value: CloudAiProvider | "new") {
    sender.current = createCommandSender();
    setKind(value === "new" ? "openai" : value.provider);
    setReplaceKey(false);
    setGrantChanged(false);
    setEditing(value);
  }
  return (
    <>
      <header className="cloud-page-header">
        <h1>AI providers</h1>
        <Button
          disabled={!settings.credentialStorageAvailable}
          onClick={() => open("new")}
        >
          Add provider
        </Button>
      </header>
      {!settings.credentialStorageAvailable && (
        <p role="status" className="cloud-error">
          Credential storage is not configured. Contact your administrator.
        </p>
      )}
      {!settings.providers.length ? (
        <div className="cloud-empty">No AI providers configured.</div>
      ) : (
        <div className="cloud-grid">
          {settings.providers.map((entry) => (
            <section className="cloud-card" key={entry.id}>
              <div className="flex items-center justify-between gap-3">
                <h2>{entry.name}</h2>
                {!entry.enabled && <span>Disabled</span>}
              </div>
              <p>
                {providerNames[entry.provider]}
                {entry.region ? ` · ${entry.region.toUpperCase()}` : ""}
              </p>
              <ul className="cloud-provider-models">
                {entry.models.map((model) => (
                  <li key={model}>{model}</li>
                ))}
              </ul>
              <Button
                variant="outline"
                disabled={!settings.credentialStorageAvailable}
                onClick={() => open(entry)}
              >
                Edit provider
              </Button>
              <ProviderUsage providerId={entry.id} />
            </section>
          ))}
        </div>
      )}
      <FormDialog
        open={editing !== null}
        onOpenChange={(value) => {
          if (!value) setEditing(null);
        }}
        title={provider ? "Edit AI provider" : "Add AI provider"}
        submitLabel="Save provider"
        onSubmit={async (form) => {
          const configuration = {
            name: formText(form, "name"),
            models: formText(form, "models")
              .split("\n")
              .map((value) => value.trim())
              .filter(Boolean),
            region: kind === "langdock" ? formText(form, "region") : null,
            maxOutputTokens: Number(formText(form, "maxOutputTokens")),
            dailyTokenBudget: Number(formText(form, "dailyTokenBudget")),
            maxConcurrentRequests: Number(
              formText(form, "maxConcurrentRequests"),
            ),
          };
          const apiKey = formText(form, "apiKey");
          await sender.current(
            provider ? `ai-providers/${provider.id}` : "ai-providers",
            provider
              ? {
                  ...configuration,
                  revision: provider.revision,
                  enabled: formText(form, "enabled") === "true",
                  ...(replaceKey ? { apiKey } : {}),
                }
              : { ...configuration, provider: kind, apiKey },
            provider ? "PATCH" : "POST",
          );
          router.refresh();
        }}
      >
        <div
          className="contents"
          onChange={(event) => {
            if (!provider) return;
            const form = event.currentTarget.closest("form");
            if (!form) return;
            const data = new FormData(form);
            const models = formText(data, "models")
              .split("\n")
              .map((model) => model.trim())
              .filter(Boolean);
            setGrantChanged(
              data.get("replaceKey") === "true" ||
                (kind === "langdock" ? formText(data, "region") : null) !==
                  provider.region ||
                (formText(data, "enabled") === "true") !== provider.enabled ||
                provider.models.some((model) => !models.includes(model)),
            );
          }}
        >
          <Field label="Name" htmlFor="ai-provider-name">
            <Input
              id="ai-provider-name"
              name="name"
              required
              maxLength={120}
              defaultValue={provider?.name}
            />
          </Field>
          {!provider && (
            <Field label="Provider" htmlFor="ai-provider-kind">
              <Select
                id="ai-provider-kind"
                value={kind}
                onChange={(event) =>
                  setKind(event.target.value as CloudAiProvider["provider"])
                }
              >
                {cloudApiProviders.map((value) => (
                  <option key={value} value={value}>
                    {providerNames[value]}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {kind === "langdock" && (
            <Field label="Region" htmlFor="ai-provider-region">
              <Select
                id="ai-provider-region"
                name="region"
                defaultValue={provider?.region ?? "eu"}
              >
                <option value="eu">EU</option>
                <option value="us">US</option>
              </Select>
            </Field>
          )}
          {provider && (
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                name="replaceKey"
                value="true"
                checked={replaceKey}
                onChange={(event) => setReplaceKey(event.target.checked)}
              />
              Replace API key
            </label>
          )}
          {(!provider || replaceKey) && (
            <Field label="API key" htmlFor="ai-provider-key">
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
          <Field
            label="Models"
            htmlFor="ai-provider-models"
            hint="Enter one model identifier per line."
          >
            <Textarea
              id="ai-provider-models"
              name="models"
              required
              defaultValue={provider?.models.join("\n")}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Output token limit" htmlFor="ai-output-tokens">
              <Input
                id="ai-output-tokens"
                name="maxOutputTokens"
                type="number"
                required
                min={64}
                max={65536}
                step={1}
                defaultValue={provider?.maxOutputTokens ?? 4096}
              />
            </Field>
            <Field label="Daily token budget" htmlFor="ai-daily-budget">
              <Input
                id="ai-daily-budget"
                name="dailyTokenBudget"
                type="number"
                required
                min={1000}
                max={100000000}
                step={1}
                defaultValue={provider?.dailyTokenBudget ?? 200000}
              />
            </Field>
          </div>
          <Field label="Concurrent requests" htmlFor="ai-concurrency">
            <Input
              id="ai-concurrency"
              name="maxConcurrentRequests"
              type="number"
              required
              min={1}
              max={32}
              step={1}
              defaultValue={provider?.maxConcurrentRequests ?? 4}
            />
          </Field>
          {provider && (
            <Field label="Status" htmlFor="ai-provider-enabled">
              <Select
                id="ai-provider-enabled"
                name="enabled"
                defaultValue={String(provider.enabled)}
              >
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </Select>
            </Field>
          )}
          {grantChanged && (
            <p role="status" className="text-muted-foreground">
              Active AI work using this provider will stop.
            </p>
          )}
        </div>
      </FormDialog>
    </>
  );
}
