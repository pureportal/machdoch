"use client";

import { pollWhileVisible } from "@machdoch/product-ui/view-visibility";
import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import type {
  GitAdministration,
  GitConnection,
} from "@/lib/cloud-git-contract";
import {
  defaultGitApiUrls,
  gitProviderLabels,
  gitProviders,
  gitTokenUrl,
  type GitProvider,
} from "@/lib/git-providers";
import { CopyField } from "@/components/copy-field";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  CloudRequestError,
  cloudRequest,
  createCommandSender,
  formText,
} from "./api-client";
import { GitConnectionCard } from "./git-connection-card";
import { GitReviewSettingsSection } from "./git-review-settings";
import { CliSignInDialog, useCliLogin } from "./provider-sign-in";
import { GitStatusRules } from "./git-status-rules";

const tokenHints: Record<GitProvider, string> = {
  github:
    "A classic token needs the repo and admin:repo_hook scopes; a fine-grained token needs Contents, Commit statuses and Webhooks write and Pull requests, Issues and Checks read.",
  gitlab:
    "The token needs the api scope; maintainer access lets Machdoch add webhooks.",
};

function ProviderSection({
  provider,
  connections,
  credentialStorageAvailable,
  teams,
  loading,
  onChanged,
}: {
  provider: GitProvider;
  connections: GitConnection[];
  credentialStorageAvailable: boolean;
  teams: { id: string; name: string }[];
  loading: boolean;
  onChanged: () => Promise<void>;
}) {
  const label = gitProviderLabels[provider];
  const [editing, setEditing] = useState<GitConnection | null | undefined>(
    undefined,
  );
  const [apiUrl, setApiUrl] = useState(defaultGitApiUrls[provider]);
  useEffect(() => {
    if (editing !== undefined)
      setApiUrl(editing?.apiUrl ?? defaultGitApiUrls[provider]);
  }, [editing, provider]);
  const tokenUrl = gitTokenUrl(provider, apiUrl);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const deviceSignIn = provider === "github";
  const signIn = useCliLogin(signingIn ? "git/github/sign-in" : null);
  const sender = useRef(createCommandSender());
  const heading = `${provider}-heading`;
  return (
    <section className="cloud-settings-section" aria-labelledby={heading}>
      <header>
        <h2 id={heading}>{label}</h2>
        <div className="flex flex-wrap gap-2">
          {deviceSignIn && (
            <Button
              disabled={loading || !credentialStorageAvailable}
              onClick={() => {
                setSigningIn(true);
                if (signIn.login?.state !== "waiting") void signIn.start();
              }}
            >
              Sign in with {label}
            </Button>
          )}
          <Button
            variant={deviceSignIn ? "ghost" : "outline"}
            disabled={loading || !credentialStorageAvailable}
            aria-busy={loading}
            onClick={() => {
              sender.current = createCommandSender();
              setEditing(null);
            }}
          >
            {loading
              ? "Loading…"
              : deviceSignIn
                ? "Use a token"
                : `Connect ${label}`}
          </Button>
        </div>
      </header>
      {signingIn && (
        <CliSignInDialog
          providerName={label}
          state={signIn}
          onClose={() => {
            setSigningIn(false);
            if (signIn.login?.state === "signed-in") void onChanged();
          }}
        />
      )}
      {!loading && !credentialStorageAvailable && (
        <p>Configure credential storage before connecting {label}.</p>
      )}
      {connections.map((connection) => (
        <GitConnectionCard
          key={connection.id}
          connection={connection}
          teams={teams}
          addingRepository={addingTo === connection.id}
          onAddingRepositoryChange={(open) =>
            setAddingTo(open ? connection.id : null)
          }
          onReconnect={() => {
            sender.current = createCommandSender();
            setEditing(connection);
          }}
          onChanged={onChanged}
        />
      ))}
      <FormDialog
        title={editing ? `Reconnect ${editing.account}` : `Connect ${label}`}
        submitLabel="Save connection"
        open={editing !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(undefined);
            sender.current = createCommandSender();
          }
        }}
        onSubmit={async (form) => {
          if (editing === undefined) return;
          const token = formText(form, "token");
          const oauthClientSecret = formText(form, "oauthClientSecret");
          try {
            const saved = await sender.current<{ id: string }>(
              `git/${provider}`,
              {
                ...(editing ? { connectionId: editing.id } : {}),
                revision: editing?.revision ?? 0,
                apiUrl: formText(form, "apiUrl"),
                ...(token ? { token } : {}),
                automate: form.get("automate") === "on",
                codeAccess: form.get("codeAccess") === "on",
                oauthClientId: formText(form, "oauthClientId") || null,
                ...(oauthClientSecret ? { oauthClientSecret } : {}),
              },
              "PUT",
            );
            if (!editing) setAddingTo(saved.id);
          } catch (reason) {
            if (
              reason instanceof CloudRequestError &&
              reason.code === "revision_conflict"
            ) {
              await onChanged();
              throw new Error(
                "The connection changed. Close and reopen it to review the latest version.",
              );
            }
            throw reason;
          }
          await onChanged();
        }}
      >
        <Field
          label="Access token"
          htmlFor={`${provider}-token`}
          hint={
            editing
              ? `Leave blank to keep ${editing.tokenPrefix}… for this address.`
              : tokenHints[provider]
          }
        >
          <Input
            id={`${provider}-token`}
            name="token"
            type="password"
            required={!editing}
            minLength={20}
            maxLength={400}
            autoComplete="off"
            spellCheck={false}
          />
          {tokenUrl && (
            <a
              className="cloud-git-token-link"
              href={tokenUrl}
              target="_blank"
              rel="noreferrer"
            >
              Create a token on {label}
              <ExternalLink size={12} aria-hidden="true" />
            </a>
          )}
        </Field>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="automate"
            defaultChecked={editing?.automate ?? true}
          />
          Update issue status from pull requests
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="codeAccess"
            defaultChecked={editing?.codeAccess ?? true}
          />
          Code access
        </label>
        <details
          className="cloud-git-oauth"
          open={Boolean(
            editing && editing.apiUrl !== defaultGitApiUrls[provider],
          )}
        >
          <summary>Self-hosted {label}</summary>
          <Field label="API address" htmlFor={`${provider}-api-url`}>
            <Input
              id={`${provider}-api-url`}
              name="apiUrl"
              type="url"
              required
              maxLength={300}
              value={apiUrl}
              onChange={(event) => setApiUrl(event.target.value)}
            />
          </Field>
        </details>
        <details
          className="cloud-git-oauth"
          open={Boolean(editing?.oauthClientId)}
        >
          <summary>Member sign-in</summary>
          <CopyField
            label="Callback URL"
            value={
              editing?.oauthCallbackUrl ??
              `${typeof location === "undefined" ? "" : location.origin}/api/v1/integrations/${provider}/oauth/callback`
            }
          />
          <Field
            label="OAuth app client ID"
            htmlFor={`${provider}-oauth-client`}
          >
            <Input
              id={`${provider}-oauth-client`}
              name="oauthClientId"
              maxLength={200}
              autoComplete="off"
              spellCheck={false}
              defaultValue={editing?.oauthClientId ?? ""}
            />
          </Field>
          <Field
            label="OAuth app secret"
            htmlFor={`${provider}-oauth-secret`}
            hint={
              editing?.oauthClientId
                ? "Leave blank to keep the current secret."
                : undefined
            }
          >
            <Input
              id={`${provider}-oauth-secret`}
              name="oauthClientSecret"
              type="password"
              maxLength={500}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        </details>
      </FormDialog>
    </section>
  );
}

export function GitSettings() {
  const [data, setData] = useState<GitAdministration | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => {
    const value = await cloudRequest<GitAdministration>("git", { signal });
    if (!signal?.aborted) setData(value);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () =>
      load(controller.signal).catch((reason: Error) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    const stop = pollWhileVisible(() => refresh(), 15_000);
    return () => {
      controller.abort();
      stop();
    };
  }, [load]);
  const automated = data?.connections.some((connection) => connection.automate);
  return (
    <>
      {gitProviders.map((provider) => (
        <ProviderSection
          key={provider}
          provider={provider}
          connections={
            data?.connections.filter(
              (connection) => connection.provider === provider,
            ) ?? []
          }
          credentialStorageAvailable={data?.credentialStorageAvailable ?? false}
          teams={data?.automations.map((entry) => entry.team) ?? []}
          loading={!data && !error}
          onChanged={() => load()}
        />
      ))}
      {data && data.connections.length > 0 && (
        <GitReviewSettingsSection
          settings={data.settings}
          onChanged={() => load()}
        />
      )}
      {data && automated && (
        <GitStatusRules
          automations={data.automations}
          onChanged={() => load()}
        />
      )}
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
    </>
  );
}
