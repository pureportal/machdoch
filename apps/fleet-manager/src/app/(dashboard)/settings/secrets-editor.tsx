"use client";

import { KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, jsonBody } from "@/lib/api";
import type {
  SecretDescriptor,
  SettingsCatalog,
  SettingsProfile,
} from "./types";

export function SecretsEditor({
  profile,
  catalog,
  onProfile,
  onError,
}: {
  profile: SettingsProfile;
  catalog: SettingsCatalog;
  onProfile: (profile: SettingsProfile) => Promise<void>;
  onError: (message: string) => void;
}): React.ReactElement {
  const customSecrets = profile.secrets.filter((secret) =>
    secret.secretId.startsWith("custom."),
  );
  return (
    <div className="grid gap-7">
      <div className="grid gap-3">
        <h3 className="font-medium">API keys</h3>
        {catalog.secrets.map((descriptor) => (
          <SecretRow
            key={descriptor.id}
            descriptor={descriptor}
            profile={profile}
            onProfile={onProfile}
            onError={onError}
          />
        ))}
      </div>
      <div className="grid gap-3">
        <h3 className="font-medium">Custom secrets</h3>
        {customSecrets.map((secret) => (
          <SecretRow
            key={secret.secretId}
            descriptor={{
              id: secret.secretId,
              label: secret.secretId.slice(7),
              category: "Custom",
            }}
            profile={profile}
            onProfile={onProfile}
            onError={onError}
          />
        ))}
        <CustomSecretForm
          profile={profile}
          onProfile={onProfile}
          onError={onError}
        />
      </div>
    </div>
  );
}

function SecretRow({
  descriptor,
  profile,
  onProfile,
  onError,
}: {
  descriptor: SecretDescriptor;
  profile: SettingsProfile;
  onProfile: (profile: SettingsProfile) => Promise<void>;
  onError: (message: string) => void;
}): React.ReactElement {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const saved = profile.secrets.find(
    (secret) => secret.secretId === descriptor.id,
  );
  const save = async (): Promise<void> => {
    if (!value.trim()) {
      onError("Enter a value to save.");
      return;
    }
    setPending(true);
    try {
      const payload = await api<{ profile: SettingsProfile }>(
        `/api/settings/profiles/${encodeURIComponent(profile.profileId)}/secrets/${encodeURIComponent(descriptor.id)}`,
        {
          method: "PUT",
          body: jsonBody({ expectedRevision: profile.revision, value }),
        },
      );
      setValue("");
      await onProfile(payload.profile);
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-[180px_1fr_auto] sm:items-center">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-muted-foreground" />
        <div>
          <p className="text-sm font-medium">{descriptor.label}</p>
          {saved ? (
            <p className="font-mono text-xs text-muted-foreground">
              ••••{saved.lastFour}
            </p>
          ) : null}
        </div>
      </div>
      <Input
        type="password"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={saved ? "Replace value" : "Value"}
        aria-label={`${descriptor.label} value`}
      />
      <div className="flex gap-1">
        <Button size="sm" disabled={pending} onClick={() => void save()}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {saved ? (
          <ConfirmButton
            trigger={
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove ${descriptor.label}`}
              >
                <Trash2 />
              </Button>
            }
            title={`Remove ${descriptor.label}?`}
            description="The secret will be removed from this profile."
            actionLabel="Remove secret"
            onConfirm={async () => {
              const payload = await api<{ profile: SettingsProfile }>(
                `/api/settings/profiles/${encodeURIComponent(profile.profileId)}/secrets/${encodeURIComponent(descriptor.id)}`,
                {
                  method: "DELETE",
                  body: jsonBody({ expectedRevision: profile.revision }),
                },
              );
              await onProfile(payload.profile);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function CustomSecretForm({
  profile,
  onProfile,
  onError,
}: {
  profile: SettingsProfile;
  onProfile: (profile: SettingsProfile) => Promise<void>;
  onError: (message: string) => void;
}): React.ReactElement {
  const [pending, setPending] = useState(false);
  return (
    <form
      className="grid gap-3 rounded-lg border border-dashed border-border p-3 sm:grid-cols-[180px_1fr_auto]"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        const secretId = String(data.get("secretId"));
        setPending(true);
        void api<{ profile: SettingsProfile }>(
          `/api/settings/profiles/${encodeURIComponent(profile.profileId)}/secrets/${encodeURIComponent(secretId)}`,
          {
            method: "PUT",
            body: jsonBody({
              expectedRevision: profile.revision,
              value: data.get("value"),
            }),
          },
        )
          .then(async ({ profile: nextProfile }) => {
            form.reset();
            await onProfile(nextProfile);
          })
          .catch((reason: unknown) => onError(errorMessage(reason)))
          .finally(() => setPending(false));
      }}
    >
      <Input
        name="secretId"
        placeholder="custom.identifier"
        pattern="custom\.[a-z0-9][a-z0-9._-]{0,71}"
        required
        aria-label="Custom secret identifier"
      />
      <Input
        name="value"
        type="password"
        placeholder="Value"
        required
        aria-label="Custom secret value"
      />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Add secret"}
      </Button>
    </form>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Secret update failed.";
}
