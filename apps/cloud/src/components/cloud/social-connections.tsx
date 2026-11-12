"use client";

import { Plug, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmButton } from "@/components/confirm-button";
import { CopyField } from "@/components/copy-field";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import {
  channelKindLabels,
  type SocialAccount,
  type SocialApp,
} from "@/lib/cloud-release-contract";
import { cloudRequest } from "./api-client";
import { ChannelMark, ReleaseSections } from "./release-display";
import { RelativeTime } from "./relative-time";
import { useToast } from "./toast";

function AppCard({
  app,
  accounts,
  onChanged,
}: {
  app: SocialApp;
  accounts: SocialAccount[];
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(!app.configured);
  const [clientId, setClientId] = useState(app.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [pages, setPages] = useState(app.organizationPages);
  const [saving, setSaving] = useState(false);
  const label = channelKindLabels[app.network];
  return (
    <section className="cloud-release-panel" aria-label={label}>
      <div className="cloud-social-heading">
        <ChannelMark kind={app.network} />
        <h3>{label}</h3>
        <span className="cloud-automation-spacer" />
        {app.configured && !editing && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            Change app
          </Button>
        )}
        {app.configured && (
          <Button asChild size="sm">
            <a href={`/api/v1/social/${app.network}/connect`}>
              <Plug />
              Connect account
            </a>
          </Button>
        )}
      </div>
      {editing && (
        <div className="cloud-automation-fields">
          <CopyField label="Redirect URL" value={app.redirectUri} monospace />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Client ID" htmlFor={`${app.network}-client`}>
              <Input
                id={`${app.network}-client`}
                value={clientId}
                maxLength={200}
                onChange={(event) => setClientId(event.target.value)}
              />
            </Field>
            <Field label="Client secret" htmlFor={`${app.network}-secret`}>
              <Input
                id={`${app.network}-secret`}
                type="password"
                value={clientSecret}
                maxLength={500}
                autoComplete="off"
                onChange={(event) => setClientSecret(event.target.value)}
              />
            </Field>
          </div>
          {app.network === "linkedin" && (
            <Label className="cloud-automation-check">
              <input
                type="checkbox"
                checked={pages}
                onChange={(event) => setPages(event.target.checked)}
              />
              Post to company pages (requires the Community Management API)
            </Label>
          )}
          <div className="cloud-release-actions">
            {app.configured && (
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
            <Button
              disabled={saving || !clientId.trim() || !clientSecret.trim()}
              onClick={async () => {
                setSaving(true);
                try {
                  await cloudRequest(`social/apps/${app.network}`, {
                    method: "PUT",
                    body: { clientId, clientSecret, organizationPages: pages },
                  });
                  setClientSecret("");
                  setEditing(false);
                  await onChanged();
                  toast(`${label} app saved`);
                } catch (reason) {
                  toast(
                    reason instanceof Error ? reason.message : "Try again.",
                    "error",
                  );
                } finally {
                  setSaving(false);
                }
              }}
            >
              Save app
            </Button>
          </div>
        </div>
      )}
      {accounts.length > 0 && (
        <ul className="cloud-channel-list">
          {accounts.map((account) => (
            <li key={account.id}>
              <div>
                <strong>{account.name}</strong>
                <span>
                  Connected by {account.connectedBy}{" "}
                  <RelativeTime value={account.createdAt} />
                  {account.expiresAt && (
                    <>
                      {" "}
                      · Expires{" "}
                      {new Date(account.expiresAt).toLocaleDateString(
                        undefined,
                        { dateStyle: "medium" },
                      )}
                    </>
                  )}
                </span>
                {account.error && (
                  <span className="cloud-release-error">{account.error}</span>
                )}
              </div>
              <span className="cloud-automation-spacer" />
              <ConfirmButton
                trigger={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Disconnect ${account.name}`}
                  >
                    <Unplug />
                  </Button>
                }
                title={`Disconnect ${account.name}?`}
                description="Channels can no longer post with this account."
                actionLabel="Disconnect"
                onConfirm={async () => {
                  await cloudRequest(`social/accounts/${account.id}`, {
                    method: "DELETE",
                  });
                  await onChanged();
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function SocialConnections({
  workspace,
  initialApps,
  initialAccounts,
  connected,
  error,
}: {
  workspace: CloudWorkspace;
  initialApps: SocialApp[];
  initialAccounts: SocialAccount[];
  connected: string | null;
  error: string | null;
}) {
  const toast = useToast();
  const [apps, setApps] = useState(initialApps);
  const [accounts, setAccounts] = useState(initialAccounts);
  useEffect(() => {
    if (connected)
      toast(
        `${channelKindLabels[connected as SocialApp["network"]] ?? "Account"} connected`,
      );
    if (error) toast(error, "error");
    if (connected || error)
      window.history.replaceState(null, "", "/cloud/releases/connections");
  }, [connected, error, toast]);
  async function refresh() {
    const [nextApps, nextAccounts] = await Promise.all([
      cloudRequest<SocialApp[]>("social/apps"),
      cloudRequest<SocialAccount[]>("social/accounts"),
    ]);
    setApps(nextApps);
    setAccounts(nextAccounts);
  }
  return (
    <>
      <header className="cloud-page-header">
        <h1>Connections</h1>
      </header>
      <ReleaseSections
        admin={["owner", "admin"].includes(workspace.actor.role)}
      />
      <div className="cloud-social-grid">
        {apps.map((app) => (
          <AppCard
            key={app.network}
            app={app}
            accounts={accounts.filter(
              (account) => account.network === app.network,
            )}
            onChanged={refresh}
          />
        ))}
      </div>
    </>
  );
}
