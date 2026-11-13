"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Lock, Trash2 } from "lucide-react";
import type {
  GitAdministration,
  GitConnection,
} from "@/lib/cloud-git-contract";
import {
  defaultGitApiUrls,
  gitProviderLabels,
  gitProviders,
  type GitProvider,
} from "@/lib/git-providers";
import { ConfirmButton } from "@/components/confirm-button";
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
import { GitRepositoryPicker } from "./git-repository-picker";
import { GitStatusRules } from "./git-status-rules";
import { RelativeTime } from "./relative-time";

const tokenHints: Record<GitProvider, string> = {
  github:
    "Grant Pull requests, Issues and Checks read, Contents write for merging, and Webhooks write for instant updates.",
  gitlab:
    "Use a token with the api scope. Maintainer access lets machdoch add webhooks.",
};

const webhookEvents: Record<GitProvider, string> = {
  github:
    "push, pull request, pull request review, review comment, issue comment, check run and check suite events",
  gitlab:
    "push, tag push, merge request, comment and pipeline events, and use the secret as its secret token",
};

function ProviderSection({
  provider,
  connection,
  credentialStorageAvailable,
  loading,
  onChanged,
}: {
  provider: GitProvider;
  connection: GitConnection | undefined;
  credentialStorageAvailable: boolean;
  loading: boolean;
  onChanged: () => Promise<void>;
}) {
  const label = gitProviderLabels[provider];
  const [editing, setEditing] = useState<GitConnection | null | undefined>(
    undefined,
  );
  const [adding, setAdding] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const sender = useRef(createCommandSender());
  const withoutWebhook =
    connection?.repositories.filter((repository) => !repository.webhook) ?? [];
  const heading = `${provider}-heading`;
  return (
    <section className="cloud-settings-section" aria-labelledby={heading}>
      <header>
        <h2 id={heading}>{label}</h2>
        <Button
          variant="outline"
          disabled={loading || !credentialStorageAvailable}
          aria-busy={loading}
          onClick={() => {
            sender.current = createCommandSender();
            setEditing(connection ?? null);
          }}
        >
          {loading
            ? "Loading…"
            : connection
              ? "Edit connection"
              : `Connect ${label}`}
        </Button>
      </header>
      {!loading && !credentialStorageAvailable && (
        <p>Configure credential storage before connecting {label}.</p>
      )}
      {connection && (
        <>
          <dl className="cloud-mimorii-status">
            <div>
              <dt>Account</dt>
              <dd>{connection.account}</dd>
            </div>
            {connection.apiUrl !== defaultGitApiUrls[provider] && (
              <div>
                <dt>API address</dt>
                <dd>{connection.apiUrl}</dd>
              </div>
            )}
            <div>
              <dt>Issue status</dt>
              <dd>
                {connection.automate ? "Follows pull requests" : "Manual"}
              </dd>
            </div>
            <div>
              <dt>Last sync</dt>
              <dd>
                {connection.syncedAt ? (
                  <RelativeTime value={connection.syncedAt} />
                ) : (
                  "Not yet"
                )}
              </dd>
            </div>
          </dl>
          {connection.lastError && (
            <p role="alert" className="cloud-error">
              {connection.lastError}
            </p>
          )}
          <section aria-labelledby={`${provider}-repositories-heading`}>
            <header className="flex items-center justify-between gap-2">
              <h3
                id={`${provider}-repositories-heading`}
                className="text-sm font-medium"
              >
                Repositories
              </h3>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAdding(true)}
              >
                Add repository
              </Button>
            </header>
            {connection.repositories.length > 0 && (
              <ul className="cloud-github-repositories">
                {connection.repositories.map((repository) => (
                  <li key={repository.id}>
                    {repository.private && (
                      <Lock size={13} aria-label="Private" role="img" />
                    )}
                    <span>{repository.fullName}</span>
                    <ConfirmButton
                      trigger={
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove ${repository.fullName}`}
                        >
                          <Trash2 />
                        </Button>
                      }
                      title={`Remove ${repository.fullName}`}
                      description="Its pull requests are unlinked from issues."
                      actionLabel="Remove"
                      onConfirm={async () => {
                        await cloudRequest(
                          `git/repositories/${repository.id}/remove`,
                          { method: "POST", body: {} },
                        );
                        await onChanged();
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
          {withoutWebhook.length > 0 && (
            <details className="cloud-github-webhook">
              <summary>Webhook</summary>
              <p>
                Add this webhook to{" "}
                {withoutWebhook.map((entry) => entry.fullName).join(", ")} with{" "}
                {webhookEvents[provider]}.
              </p>
              <CopyField label="Payload URL" value={connection.webhookUrl} />
              <CopyField
                label="Secret"
                value={connection.webhookSecret}
                monospace
              />
            </details>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              aria-disabled={syncing}
              aria-busy={syncing}
              onClick={() => {
                if (syncing) return;
                setSyncing(true);
                setError("");
                void cloudRequest(`git/${provider}/sync`, {
                  method: "POST",
                  body: {},
                })
                  .catch((reason: Error) => setError(reason.message))
                  .finally(() => setSyncing(false));
              }}
            >
              {syncing ? "Requesting…" : "Sync now"}
            </Button>
            <ConfirmButton
              trigger={<Button variant="ghost">Disconnect</Button>}
              title={`Disconnect ${label}`}
              description={`Pull requests are unlinked from issues and the webhooks machdoch created are removed from ${label}.`}
              actionLabel="Disconnect"
              onConfirm={async () => {
                await cloudRequest(`git/${provider}`, {
                  method: "DELETE",
                  body: { revision: connection.revision },
                });
                await onChanged();
              }}
            />
          </div>
          <GitRepositoryPicker
            connection={connection}
            open={adding}
            onOpenChange={setAdding}
            onAdded={onChanged}
          />
        </>
      )}
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      <FormDialog
        title={connection ? `Edit ${label} connection` : `Connect ${label}`}
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
            await sender.current(
              `git/${provider}`,
              {
                revision: editing?.revision ?? 0,
                apiUrl: formText(form, "apiUrl"),
                ...(token ? { token } : {}),
                automate: form.get("automate") === "on",
                oauthClientId: formText(form, "oauthClientId") || null,
                ...(oauthClientSecret ? { oauthClientSecret } : {}),
              },
              "PUT",
            );
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
          setError("");
          await onChanged();
        }}
      >
        <Field label="API address" htmlFor={`${provider}-api-url`}>
          <Input
            id={`${provider}-api-url`}
            name="apiUrl"
            type="url"
            required
            maxLength={300}
            defaultValue={editing?.apiUrl ?? defaultGitApiUrls[provider]}
          />
        </Field>
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
        </Field>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="automate"
            defaultChecked={editing?.automate ?? true}
          />
          Update issue status from pull requests
        </label>
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
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 15_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load]);
  const automated = gitProviders.some(
    (provider) => data?.connections[provider]?.automate,
  );
  return (
    <>
      {gitProviders.map((provider) => (
        <ProviderSection
          key={provider}
          provider={provider}
          connection={data?.connections[provider]}
          credentialStorageAvailable={data?.credentialStorageAvailable ?? false}
          loading={!data && !error}
          onChanged={() => load()}
        />
      ))}
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
