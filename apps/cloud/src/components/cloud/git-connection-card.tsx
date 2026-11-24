"use client";

import { DropdownMenu } from "radix-ui";
import { useRef, useState } from "react";
import { ChevronDown, Lock, Trash2 } from "lucide-react";
import type { GitConnection } from "@/lib/cloud-git-contract";
import {
  defaultGitApiUrls,
  gitProviderLabels,
  type GitProvider,
} from "@/lib/git-providers";
import { ConfirmButton } from "@/components/confirm-button";
import { CopyField } from "@/components/copy-field";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { cloudRequest, createCommandSender } from "./api-client";
import { GitRepositoryPicker } from "./git-repository-picker";
import { RelativeTime } from "./relative-time";

const webhookEvents: Record<GitProvider, string> = {
  github:
    "push, pull request, pull request review, review comment, issue comment, check run and check suite events",
  gitlab:
    "push, tag push, merge request, comment and pipeline events, and use the secret as its secret token",
};

export function GitConnectionCard({
  connection,
  teams,
  addingRepository,
  onAddingRepositoryChange,
  onReconnect,
  onChanged,
}: {
  connection: GitConnection;
  teams: { id: string; name: string }[];
  addingRepository: boolean;
  onAddingRepositoryChange: (open: boolean) => void;
  onReconnect: () => void;
  onChanged: () => Promise<void>;
}) {
  const label = gitProviderLabels[connection.provider];
  const [pending, setPending] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState("");
  const sender = useRef(createCommandSender());
  const withoutWebhook = connection.repositories.filter(
    (repository) => !repository.webhook,
  );
  const perform = (action: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    setError("");
    void action()
      .then(onChanged)
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setPending(false));
  };
  const heading = `git-connection-${connection.id}`;
  return (
    <article className="cloud-git-connection" aria-labelledby={heading}>
      <header>
        <div className="min-w-0">
          <h3 id={heading}>{connection.account}</h3>
          <p>
            {connection.enabledBy ?? "Former member"} ·{" "}
            <RelativeTime value={connection.connectedAt} />
            {connection.apiUrl !== defaultGitApiUrls[connection.provider] &&
              ` · ${connection.apiUrl}`}
            {connection.lastDeliveryAt ? (
              <>
                {" · Webhook "}
                <RelativeTime value={connection.lastDeliveryAt} />
              </>
            ) : (
              connection.repositories.length > 0 && " · No webhook deliveries"
            )}
          </p>
        </div>
        <label className="cloud-git-code-access">
          Code access
          <button
            type="button"
            role="switch"
            className="cloud-automation-switch"
            aria-checked={connection.codeAccess}
            aria-label="Code access"
            disabled={pending}
            onClick={() =>
              perform(() =>
                sender.current(
                  `git/${connection.provider}`,
                  {
                    connectionId: connection.id,
                    revision: connection.revision,
                    apiUrl: connection.apiUrl,
                    automate: connection.automate,
                    codeAccess: !connection.codeAccess,
                    oauthClientId: connection.oauthClientId,
                  },
                  "PUT",
                ),
              )
            }
          />
        </label>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="cloud-git-status"
              data-state-kind={connection.lastError ? "error" : "connected"}
            >
              {connection.lastError ? "Error" : "Connected"}
              <ChevronDown aria-hidden="true" />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="cloud-menu cloud-menu-list"
              align="end"
              sideOffset={4}
            >
              <DropdownMenu.Item
                className="cloud-menu-item"
                onSelect={onReconnect}
              >
                Reconnect
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="cloud-menu-item"
                disabled={pending}
                onSelect={() =>
                  perform(() =>
                    cloudRequest(`git/connections/${connection.id}/sync`, {
                      method: "POST",
                      body: {},
                    }),
                  )
                }
              >
                Sync now
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="cloud-menu-item"
                data-destructive=""
                onSelect={() => setDisconnecting(true)}
              >
                Disconnect
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </header>
      {connection.lastError && (
        <p role="alert" className="cloud-error">
          {connection.lastError}
        </p>
      )}
      <ConfirmButton
        open={disconnecting}
        onOpenChange={setDisconnecting}
        title={`Disconnect ${connection.account}`}
        description={`Its pull requests are unlinked from issues and the webhooks machdoch created are removed from ${label}.`}
        actionLabel="Disconnect"
        onConfirm={async () => {
          await cloudRequest(`git/connections/${connection.id}`, {
            method: "DELETE",
            body: { revision: connection.revision },
          });
          await onChanged();
        }}
      />
      <section aria-labelledby={`${heading}-repositories`}>
        <header className="flex items-center justify-between gap-2">
          <h4 id={`${heading}-repositories`} className="text-sm font-medium">
            Repositories
          </h4>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onAddingRepositoryChange(true)}
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
                {repository.syncedAt && (
                  <RelativeTime value={repository.syncedAt} />
                )}
                <Select
                  className="cloud-git-repository-team"
                  aria-label={`Team for ${repository.fullName}`}
                  value={repository.teamId ?? ""}
                  disabled={pending}
                  onChange={(event) =>
                    perform(() =>
                      cloudRequest(`git/repositories/${repository.id}/team`, {
                        method: "PUT",
                        body: { teamId: event.target.value || null },
                      }),
                    )
                  }
                >
                  <option value="">No team</option>
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </Select>
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
            {webhookEvents[connection.provider]}.
          </p>
          <CopyField label="Payload URL" value={connection.webhookUrl} />
          <CopyField
            label="Secret"
            value={connection.webhookSecret}
            monospace
          />
        </details>
      )}
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      <GitRepositoryPicker
        connection={connection}
        open={addingRepository}
        onOpenChange={onAddingRepositoryChange}
        onAdded={onChanged}
      />
    </article>
  );
}
