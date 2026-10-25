"use client";
import { useEffect, useRef, useState } from "react";
import type {
  OidcMetadata,
  OidcProvider,
  SsoAdministration,
} from "@/lib/cloud-sso-contract";
import { oidcAlgorithms } from "@/lib/cloud-sso-contract";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  CloudRequestError,
  cloudRequest,
  createCommandSender,
  formText,
} from "./api-client";
export function SsoProviderEditor({
  provider,
  onClose,
  onSaved,
  onReload,
}: {
  provider: OidcProvider | null;
  onClose: () => void;
  onSaved: () => void;
  onReload: (provider: OidcProvider) => void;
}) {
  const [issuer, setIssuer] = useState(provider?.metadata.issuer ?? "");
  const [metadata, setMetadata] = useState<OidcMetadata | null>(
    provider?.metadata ?? null,
  );
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [latest, setLatest] = useState<OidcProvider | null>(null);
  const check = useRef<AbortController | null>(null);
  const sender = useRef(createCommandSender());
  const id = useRef(provider?.id ?? crypto.randomUUID());
  useEffect(() => () => check.current?.abort(), []);
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={provider ? "Edit sign-in provider" : "Add sign-in provider"}
      submitLabel="Save provider"
      onSubmit={async (form) => {
        if (checking || !metadata || metadata.issuer !== issuer)
          throw new Error("Load the provider endpoints before saving.");
        try {
          await sender.current(
            `sso-providers/${id.current}`,
            {
              revision: provider?.revision ?? 0,
              name: formText(form, "name"),
              metadata,
              clientId: formText(form, "clientId"),
              authentication: formText(form, "authentication"),
              algorithm: formText(form, "algorithm"),
              secret: formText(form, "secret") || undefined,
              displaySource: formText(form, "displaySource"),
              displayClaim: formText(form, "displayClaim"),
              requiredAcr: formText(form, "requiredAcr") || null,
              maxAge:
                formText(form, "maxAge") === ""
                  ? null
                  : Number(formText(form, "maxAge")),
              enabled: form.get("enabled") === "on",
            },
            "PATCH",
          );
        } catch (reason) {
          if (
            reason instanceof CloudRequestError &&
            reason.code === "revision_conflict"
          ) {
            const current =
              await cloudRequest<SsoAdministration>("sso-providers");
            setLatest(
              current.providers.find((value) => value.id === id.current) ??
                null,
            );
          }
          throw reason;
        }
        onSaved();
      }}
    >
      {latest && (
        <div className="grid gap-2">
          <p>
            This provider changed. Loading the latest settings discards this
            draft.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => onReload(latest)}
          >
            Load latest settings
          </Button>
        </div>
      )}
      <Field label="Name" htmlFor="sso-name">
        <Input
          id="sso-name"
          name="name"
          defaultValue={provider?.name}
          required
          maxLength={80}
        />
      </Field>
      <Field label="Issuer" htmlFor="sso-issuer">
        <Input
          id="sso-issuer"
          type="url"
          value={issuer}
          readOnly={!!provider}
          onChange={(event) => {
            check.current?.abort();
            setChecking(false);
            setIssuer(event.target.value);
            setMetadata(null);
          }}
          required
          maxLength={2048}
        />
      </Field>
      <Button
        type="button"
        variant="outline"
        aria-disabled={checking}
        onClick={() => {
          if (checking) return;
          const controller = new AbortController();
          check.current = controller;
          setChecking(true);
          setError("");
          void cloudRequest<OidcMetadata>("sso-providers/discover", {
            method: "POST",
            body: { issuer },
            signal: controller.signal,
          })
            .then((result) => {
              if (!controller.signal.aborted) setMetadata(result);
            })
            .catch((reason: Error) => {
              if (!controller.signal.aborted) setError(reason.message);
            })
            .finally(() => {
              if (!controller.signal.aborted) setChecking(false);
            });
        }}
      >
        {checking ? "Loading endpoints…" : "Load provider endpoints"}
      </Button>
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      {metadata && (
        <dl className="cloud-properties">
          {[
            ["Authorization", metadata.authorization_endpoint],
            ["Token", metadata.token_endpoint],
            ["Signing keys", metadata.jwks_uri],
            ["User info", metadata.userinfo_endpoint],
          ]
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd className="break-all">{value}</dd>
              </div>
            ))}
        </dl>
      )}
      {metadata && (
        <p>
          Saving trusts these endpoints with authentication requests and the
          client credential.
        </p>
      )}
      <Field label="Client ID" htmlFor="sso-client">
        <Input
          id="sso-client"
          name="clientId"
          defaultValue={provider?.clientId}
          readOnly={!!provider}
          required
          maxLength={512}
        />
      </Field>
      <Field
        label="Client secret"
        htmlFor="sso-secret"
        hint={
          provider
            ? "Leave blank to keep the credential when its endpoint and authentication method are unchanged."
            : undefined
        }
      >
        <Input
          id="sso-secret"
          name="secret"
          type="password"
          autoComplete="new-password"
          required={!provider}
          maxLength={8192}
        />
      </Field>
      <Field label="Client authentication" htmlFor="sso-auth">
        <Select
          id="sso-auth"
          name="authentication"
          defaultValue={provider?.authentication ?? "client_secret_basic"}
        >
          <option value="client_secret_basic">Client secret · Basic</option>
          <option value="client_secret_post">Client secret · POST</option>
        </Select>
      </Field>
      <Field label="ID token algorithm" htmlFor="sso-alg">
        <Select
          id="sso-alg"
          name="algorithm"
          defaultValue={provider?.algorithm ?? "RS256"}
        >
          {oidcAlgorithms.map((algorithm) => (
            <option key={algorithm} value={algorithm}>
              {algorithm}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Identity display source" htmlFor="sso-source">
        <Select
          id="sso-source"
          name="displaySource"
          defaultValue={provider?.displaySource ?? "id_token"}
        >
          <option value="id_token">ID token</option>
          <option value="userinfo">UserInfo</option>
        </Select>
      </Field>
      <Field label="Identity display claim" htmlFor="sso-claim">
        <Input
          id="sso-claim"
          name="displayClaim"
          defaultValue={provider?.displayClaim ?? "sub"}
          required
          maxLength={80}
          pattern="[A-Za-z][A-Za-z0-9_]*"
        />
      </Field>
      <details>
        <summary>Authentication requirements</summary>
        <div className="grid gap-4 pt-4">
          <Field label="Required ACR" htmlFor="sso-acr">
            <Input
              id="sso-acr"
              name="requiredAcr"
              defaultValue={provider?.requiredAcr ?? ""}
              maxLength={256}
            />
          </Field>
          <Field label="Maximum authentication age (seconds)" htmlFor="sso-age">
            <Input
              id="sso-age"
              name="maxAge"
              type="number"
              min={0}
              max={43200}
              defaultValue={provider?.maxAge ?? ""}
            />
          </Field>
        </div>
      </details>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={provider?.enabled ?? true}
        />
        Enabled
      </label>
      {provider && (
        <p>
          Saving ends sessions and app connections authenticated through this
          provider.
        </p>
      )}
    </FormDialog>
  );
}
