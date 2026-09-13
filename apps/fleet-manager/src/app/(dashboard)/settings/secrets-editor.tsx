"use client";

import { KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { jsonBody } from "@/lib/api";
import type { UpdateProfile } from "./profile-editor";
import type {
  SecretDescriptor,
  SettingsCatalog,
  SettingsProfile,
} from "./types";
import { settingsError } from "./use-settings-profiles";

export function SecretsEditor({
  profile,
  catalog,
  onUpdate,
}: {
  profile: SettingsProfile;
  catalog: SettingsCatalog;
  onUpdate: UpdateProfile;
}): React.ReactElement {
  return (
    <div className="grid min-w-0 gap-3">
      <h3 className="font-medium">API keys</h3>
      {catalog.secrets.map((descriptor) => (
        <SecretRow
          key={descriptor.id}
          descriptor={descriptor}
          profile={profile}
          onUpdate={onUpdate}
        />
      ))}
    </div>
  );
}

function SecretRow({
  descriptor,
  profile,
  onUpdate,
}: {
  descriptor: SecretDescriptor;
  profile: SettingsProfile;
  onUpdate: UpdateProfile;
}): React.ReactElement {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const saved = profile.secrets.find(
    (secret) => secret.secretId === descriptor.id,
  );
  const path = `/api/settings/profiles/${encodeURIComponent(profile.profileId)}/secrets/${encodeURIComponent(descriptor.id)}`;
  return (
    <form
      className="grid min-w-0 gap-3 rounded-lg border border-border p-3 xl:grid-cols-[160px_minmax(0,1fr)_auto] xl:items-center"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        setPending(true);
        setError("");
        void onUpdate(path, {
          method: "PUT",
          body: jsonBody({ expectedRevision: profile.revision, value }),
        })
          .then(() => setValue(""))
          .catch((reason: unknown) => setError(settingsError(reason)))
          .finally(() => setPending(false));
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <KeyRound className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="break-words text-sm font-medium">{descriptor.label}</p>
          {saved ? (
            <p className="font-mono text-xs text-muted-foreground">
              ••••{saved.lastFour}
            </p>
          ) : null}
        </div>
      </div>
      <Input
        type="password"
        autoComplete="new-password"
        value={value}
        required
        onChange={(event) => setValue(event.target.value)}
        placeholder={saved ? "Replace value" : "Value"}
        aria-label={`${descriptor.label} value`}
      />
      <div className="flex gap-1">
        <Button type="submit" size="sm" disabled={pending || !value.trim()}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {saved ? (
          <ConfirmButton
            trigger={
              <Button
                type="button"
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
            onConfirm={() =>
              onUpdate(path, {
                method: "DELETE",
                body: jsonBody({ expectedRevision: profile.revision }),
              })
            }
          />
        ) : null}
      </div>
      {error ? (
        <p
          role="alert"
          className="break-words text-sm text-destructive xl:col-span-3"
        >
          {error}
        </p>
      ) : null}
    </form>
  );
}
