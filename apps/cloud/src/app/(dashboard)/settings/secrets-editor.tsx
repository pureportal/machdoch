"use client";

import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { managedMcpServerSecretReferences } from "@machdoch/fleet-protocol/managed-settings";
import { ConfirmButton } from "@/components/confirm-button";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { jsonBody } from "@machdoch/product-ui/fleet-api";
import type { UpdateProfile } from "./profile-editor";
import { profilePolicy } from "./profile-drafts";
import type {
  ManagedSettingsDocument,
  SecretDescriptor,
  SettingsCatalog,
  SettingsProfile,
} from "./types";
import { settingsError } from "./use-settings-profiles";

type SaveDocument = (
  document: ManagedSettingsDocument,
  summary: string,
) => Promise<void>;

export function SecretsEditor({
  profile,
  catalog,
  onUpdate,
  onSave,
}: {
  profile: SettingsProfile;
  catalog: SettingsCatalog;
  onUpdate: UpdateProfile;
  onSave: SaveDocument;
}): React.ReactElement {
  const pattern = new RegExp(catalog.mcpSecretPattern, "u");
  const referenced = (profile.document.mcpServers ?? []).flatMap(
    managedMcpServerSecretReferences,
  );
  const mcpSecretIds = [
    ...new Set([
      ...profile.secrets
        .map((secret) => secret.secretId)
        .filter((id) => pattern.test(id)),
      ...referenced.filter((id) => pattern.test(id)),
    ]),
  ].sort();
  return (
    <div className="grid min-w-0 gap-6">
      <div className="grid min-w-0 gap-3">
        <div className="grid gap-1">
          <h3 className="font-medium">API keys</h3>
          <p className="text-sm text-muted-foreground">
            Default keys are used only on devices without their own key.
            Enforced keys replace device keys while the profile is assigned.
            Unlike the General tab, changing a key between default and enforced
            saves right away.
          </p>
        </div>
        {catalog.secrets.map((descriptor) => (
          <SecretRow
            key={descriptor.id}
            descriptor={descriptor}
            profile={profile}
            onUpdate={onUpdate}
            onSave={onSave}
          />
        ))}
      </div>
      <div className="grid min-w-0 gap-3">
        <div className="grid gap-1">
          <h3 className="font-medium">MCP secrets</h3>
          <p className="text-sm text-muted-foreground">
            Referenced from MCP server values as{" "}
            <code className="font-mono text-xs">{"{{secret:mcp_name}}"}</code>.
            Devices fill them in locally and never write them to disk.
          </p>
        </div>
        {mcpSecretIds.map((id) => (
          <SecretRow
            key={id}
            descriptor={{ id, label: id, category: "MCP" }}
            profile={profile}
            onUpdate={onUpdate}
            onSave={onSave}
            referenced={referenced.includes(id)}
            mcp
          />
        ))}
        <AddMcpSecret
          profile={profile}
          pattern={pattern}
          existing={mcpSecretIds}
          onUpdate={onUpdate}
        />
      </div>
    </div>
  );
}

function SecretRow({
  descriptor,
  profile,
  onUpdate,
  onSave,
  referenced = false,
  mcp = false,
}: {
  descriptor: SecretDescriptor;
  profile: SettingsProfile;
  onUpdate: UpdateProfile;
  onSave: SaveDocument;
  /** An MCP server of this profile uses the secret. */
  referenced?: boolean;
  /** MCP secrets have long ids and no device-side value of their own. */
  mcp?: boolean;
}): React.ReactElement {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const saved = profile.secrets.find(
    (secret) => secret.secretId === descriptor.id,
  );
  const policy = profilePolicy(profile);
  const policyKey = `secret:${descriptor.id}`;
  const enforced = policy.includes(policyKey);
  const path = `/api/settings/profiles/${encodeURIComponent(profile.profileId)}/secrets/${encodeURIComponent(descriptor.id)}`;
  return (
    <form
      className={`grid min-w-0 gap-3 rounded-lg border border-border p-3 xl:items-center ${mcp ? "xl:grid-cols-[280px_minmax(0,1fr)_auto]" : "xl:grid-cols-[160px_minmax(0,1fr)_auto]"}`}
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
          <p className="break-words font-mono text-sm font-medium [overflow-wrap:anywhere]">
            {descriptor.label}
          </p>
          {saved ? (
            <p className="font-mono text-xs text-muted-foreground">
              ••••{saved.lastFour}
            </p>
          ) : referenced ? (
            <p className="text-xs text-destructive">Referenced but not set</p>
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
            description={
              referenced
                ? "The secret will be removed from this profile. MCP servers that reference it stop working on devices until it is set again."
                : "The secret will be removed from this profile."
            }
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
      {saved ? (
        <label className="flex min-h-8 w-fit items-center gap-2 text-xs text-muted-foreground xl:col-span-3">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={enforced}
            disabled={pending}
            aria-label={`Enforce ${descriptor.label}`}
            onChange={(event) => {
              const checked = event.target.checked;
              const document = structuredClone(profile.document);
              document.policy = {
                enforced: checked
                  ? [...policy, policyKey]
                  : policy.filter((key) => key !== policyKey),
              };
              setPending(true);
              setError("");
              void onSave(
                document,
                checked
                  ? `Enforced ${descriptor.id} secret`
                  : `Made ${descriptor.id} secret a default`,
              )
                .catch((reason: unknown) => setError(settingsError(reason)))
                .finally(() => setPending(false));
            }}
          />
          <span aria-hidden="true">
            {pending
              ? "Saving…"
              : mcp
                ? enforced
                  ? "Enforced · wins over other assigned profiles"
                  : "Default · a higher profile's value takes precedence"
                : enforced
                  ? "Enforced · replaces device keys"
                  : "Default · a device key takes precedence"}
          </span>
        </label>
      ) : null}
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

function AddMcpSecret({
  profile,
  pattern,
  existing,
  onUpdate,
}: {
  profile: SettingsProfile;
  pattern: RegExp;
  existing: string[];
  onUpdate: UpdateProfile;
}): React.ReactElement {
  const [id, setId] = useState("mcp_");
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const normalized = id.trim();
  const duplicate = existing.includes(normalized);
  const malformed = normalized !== "mcp_" && !pattern.test(normalized);
  const valid = pattern.test(normalized) && !duplicate;
  return (
    <form
      className="grid min-w-0 gap-3 rounded-lg border border-dashed border-border p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending || !valid) return;
        setPending(true);
        setError("");
        void onUpdate(
          `/api/settings/profiles/${encodeURIComponent(profile.profileId)}/secrets/${encodeURIComponent(normalized)}`,
          {
            method: "PUT",
            body: jsonBody({ expectedRevision: profile.revision, value }),
          },
        )
          .then(() => {
            setId("mcp_");
            setValue("");
          })
          .catch((reason: unknown) => setError(settingsError(reason)))
          .finally(() => setPending(false));
      }}
    >
      <Field label="New MCP secret id" htmlFor="mcp-secret-id">
        <Input
          id="mcp-secret-id"
          value={id}
          onChange={(event) => setId(event.target.value)}
          className="font-mono"
          autoComplete="off"
          aria-invalid={malformed || undefined}
          aria-describedby="mcp-secret-id-hint"
        />
      </Field>
      <Field label="Secret value" htmlFor="mcp-secret-value">
        <Input
          id="mcp-secret-value"
          type="password"
          autoComplete="new-password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>
      <Button
        type="submit"
        size="sm"
        className="md:mb-0.5"
        disabled={pending || !valid || !value.trim()}
      >
        <Plus />
        {pending ? "Saving…" : "Add MCP secret"}
      </Button>
      <p
        id="mcp-secret-id-hint"
        className={`text-xs md:col-span-3 ${malformed ? "text-destructive" : "text-muted-foreground"}`}
      >
        Starts with mcp_ followed by up to 60 lowercase letters, digits, _ or -,
        for example mcp_github.
      </p>
      {duplicate ? (
        <p
          role="status"
          className="text-sm text-muted-foreground md:col-span-3"
        >
          <span className="font-mono">{normalized}</span> is already listed
          above. Set its value there.
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="break-words text-sm text-destructive md:col-span-3"
        >
          {error}
        </p>
      ) : null}
    </form>
  );
}
