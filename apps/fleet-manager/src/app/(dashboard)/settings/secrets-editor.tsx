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
  return (
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

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Secret update failed.";
}
