"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Lock, Trash2 } from "lucide-react";
import type {
  GitHubAdministration,
  GitHubAvailableRepository,
  GitHubConnection,
} from "@/lib/cloud-github-contract";
import { ConfirmButton } from "@/components/confirm-button";
import { CopyField } from "@/components/copy-field";
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
import { GitHubAutomationSettings } from "./github-automation-settings";
import { RelativeTime } from "./relative-time";

const defaultApiUrl = "https://api.github.com";

function RepositoryPicker({
  connection,
  open,
  onOpenChange,
  onAdded,
}: {
  connection: GitHubConnection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => Promise<void>;
}) {
  const [available, setAvailable] = useState<
    GitHubAvailableRepository[] | null
  >(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setAvailable(null);
    setError("");
    cloudRequest<{ repositories: GitHubAvailableRepository[] }>(
      "github/repositories/available",
      { signal: abort.signal },
    )
      .then((result) => {
        if (!abort.signal.aborted) setAvailable(result.repositories);
      })
      .catch((reason: Error) => {
        if (!abort.signal.aborted) setError(reason.message);
      });
    return () => abort.abort();
  }, [open]);
  const added = new Set(
    connection.repositories.map((repository) =>
      repository.fullName.toLowerCase(),
    ),
  );
  const options =
    available?.filter(
      (repository) => !added.has(repository.fullName.toLowerCase()),
    ) ?? [];
  return (
    <FormDialog
      title="Add repository"
      submitLabel="Add repository"
      open={open}
      onOpenChange={onOpenChange}
      submitDisabled={!options.length}
      onSubmit={async (form) => {
        await cloudRequest("github/repositories", {
          method: "POST",
          body: { fullName: formText(form, "fullName") },
        });
        await onAdded();
      }}
    >
      {error ? (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      ) : available && !options.length ? (
        <p>No other repository is available to this token.</p>
      ) : (
        <Field label="Repository" htmlFor="github-repository">
          <Select
            id="github-repository"
            name="fullName"
            required
            disabled={!available}
          >
            {available ? (
              options.map((repository) => (
                <option key={repository.fullName} value={repository.fullName}>
                  {repository.fullName}
                </option>
              ))
            ) : (
              <option>Loading…</option>
            )}
          </Select>
        </Field>
      )}
    </FormDialog>
  );
}

export function GitHubSettings() {
  const [data, setData] = useState<GitHubAdministration | null>(null);
  const [editing, setEditing] = useState<GitHubConnection | null | undefined>(
    undefined,
  );
  const [adding, setAdding] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const sender = useRef(createCommandSender());
  const load = useCallback(async (signal?: AbortSignal) => {
    const value = await cloudRequest<GitHubAdministration>("github", {
      signal,
    });
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
  const connection = data?.connection;
  const withoutWebhook =
    connection?.repositories.filter((repository) => !repository.webhook) ?? [];
  return (
    <section
      className="cloud-settings-section"
      aria-labelledby="github-heading"
    >
      <header>
        <h2 id="github-heading">GitHub</h2>
        <Button
          variant="outline"
          disabled={!data?.credentialStorageAvailable}
          aria-busy={!data && !error}
          onClick={() => {
            sender.current = createCommandSender();
            setEditing(connection ?? null);
          }}
        >
          {!data && !error
            ? "Loading…"
            : connection
              ? "Edit connection"
              : "Connect GitHub"}
        </Button>
      </header>
      {data && !data.credentialStorageAvailable && (
        <p>Configure credential storage before connecting GitHub.</p>
      )}
      {connection && (
        <>
          <dl className="cloud-mimorii-status">
            <div>
              <dt>Account</dt>
              <dd>{connection.account}</dd>
            </div>
            {connection.apiUrl !== defaultApiUrl && (
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
          <section aria-labelledby="github-repositories-heading">
            <header className="flex items-center justify-between gap-2">
              <h3
                id="github-repositories-heading"
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
                          `github/repositories/${repository.id}/remove`,
                          { method: "POST", body: {} },
                        );
                        await load();
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
          {connection.automate && (
            <GitHubAutomationSettings
              automations={data.automations}
              onChanged={() => load()}
            />
          )}
          {withoutWebhook.length > 0 && (
            <details className="cloud-github-webhook">
              <summary>Webhook</summary>
              <p>
                Add this webhook to{" "}
                {withoutWebhook.map((entry) => entry.fullName).join(", ")} with
                pull request, pull request review, check run and check suite
                events.
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
                void cloudRequest("github/sync", { method: "POST", body: {} })
                  .catch((reason: Error) => setError(reason.message))
                  .finally(() => setSyncing(false));
              }}
            >
              {syncing ? "Requesting…" : "Sync now"}
            </Button>
            <ConfirmButton
              trigger={<Button variant="ghost">Disconnect</Button>}
              title="Disconnect GitHub"
              description="Pull requests are unlinked from issues and the webhooks machdoch created are removed from GitHub."
              actionLabel="Disconnect"
              onConfirm={async () => {
                await cloudRequest("github", {
                  method: "DELETE",
                  body: { revision: connection.revision },
                });
                await load();
              }}
            />
          </div>
          <RepositoryPicker
            connection={connection}
            open={adding}
            onOpenChange={setAdding}
            onAdded={() => load()}
          />
        </>
      )}
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      <FormDialog
        title={connection ? "Edit GitHub connection" : "Connect GitHub"}
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
          try {
            await sender.current(
              "github",
              {
                revision: editing?.revision ?? 0,
                apiUrl: formText(form, "apiUrl"),
                ...(token ? { token } : {}),
                automate: form.get("automate") === "on",
              },
              "PUT",
            );
          } catch (reason) {
            if (
              reason instanceof CloudRequestError &&
              reason.code === "revision_conflict"
            ) {
              await load();
              throw new Error(
                "The connection changed. Close and reopen it to review the latest version.",
              );
            }
            throw reason;
          }
          setError("");
          await load();
        }}
      >
        <Field label="API address" htmlFor="github-api-url">
          <Input
            id="github-api-url"
            name="apiUrl"
            type="url"
            required
            maxLength={300}
            defaultValue={editing?.apiUrl ?? defaultApiUrl}
          />
        </Field>
        <Field
          label="Access token"
          htmlFor="github-token"
          hint={
            editing
              ? `Leave blank to keep ${editing.tokenPrefix}… for this address.`
              : "Grant Pull requests and Checks read, Contents write for merging, and Webhooks write for instant updates."
          }
        >
          <Input
            id="github-token"
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
      </FormDialog>
    </section>
  );
}
