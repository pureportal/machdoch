"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { GitAccount, GitAccounts } from "@/lib/cloud-git-contract";
import {
  defaultGitApiUrls,
  gitProviderLabels,
  gitProviders,
  type GitProvider,
} from "@/lib/git-providers";
import { ConfirmButton } from "@/components/confirm-button";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cloudRequest, formText } from "./api-client";
import { useToast } from "./toast";
import { RelativeTime } from "./relative-time";

function AccountSection({
  provider,
  account,
  apiUrl,
  oauth,
  available,
  onChanged,
}: {
  provider: GitProvider;
  account: GitAccount | undefined;
  apiUrl: string | undefined;
  oauth: boolean;
  available: boolean;
  onChanged: () => Promise<void>;
}) {
  const label = gitProviderLabels[provider];
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const heading = `${provider}-account-heading`;
  const mismatched = account && apiUrl && account.apiUrl !== apiUrl;
  return (
    <section className="cloud-settings-section" aria-labelledby={heading}>
      <header>
        <h2 id={heading}>{label}</h2>
        <div className="flex flex-wrap gap-2">
          {oauth && (
            <Button
              variant={account ? "outline" : "default"}
              disabled={!available || signingIn}
              aria-busy={signingIn}
              onClick={() => {
                setSigningIn(true);
                void cloudRequest<{ url: string }>(
                  `git/accounts/${provider}/authorize`,
                  { method: "POST", body: {} },
                )
                  .then((result) => location.assign(result.url))
                  .catch((reason: Error) => {
                    toast(reason.message, "error");
                    setSigningIn(false);
                  });
              }}
            >
              {account ? "Sign in again" : `Sign in with ${label}`}
            </Button>
          )}
          <Button
            variant={oauth ? "ghost" : "outline"}
            disabled={!available}
            onClick={() => setEditing(true)}
          >
            {oauth
              ? "Use a token"
              : account
                ? "Replace token"
                : `Connect ${label}`}
          </Button>
        </div>
      </header>
      {account && (
        <>
          <dl className="cloud-mimorii-status">
            <div>
              <dt>Account</dt>
              <dd>{account.login}</dd>
            </div>
            {account.apiUrl !== defaultGitApiUrls[provider] && (
              <div>
                <dt>API address</dt>
                <dd>{account.apiUrl}</dd>
              </div>
            )}
            <div>
              <dt>Last used</dt>
              <dd>
                {account.lastUsedAt ? (
                  <RelativeTime value={account.lastUsedAt} />
                ) : (
                  "Not yet"
                )}
              </dd>
            </div>
          </dl>
          {mismatched && (
            <p role="alert" className="cloud-error">
              Your organization uses {apiUrl}. Connect an account there to act
              as yourself.
            </p>
          )}
          {account.lastError && (
            <p role="alert" className="cloud-error">
              {account.lastError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <ConfirmButton
              trigger={<Button variant="ghost">Disconnect</Button>}
              title={`Disconnect ${label}`}
              description="Actions you start use the organization connection. Automations you own that act as you stop working."
              actionLabel="Disconnect"
              onConfirm={async () => {
                await cloudRequest(`git/accounts/${provider}`, {
                  method: "DELETE",
                  body: { revision: account.revision },
                });
                await onChanged();
              }}
            />
          </div>
        </>
      )}
      <FormDialog
        title={`Connect ${label}`}
        submitLabel="Connect"
        open={editing}
        onOpenChange={setEditing}
        onSubmit={async (form) => {
          await cloudRequest(`git/accounts/${provider}`, {
            method: "PUT",
            body: {
              revision: account?.revision ?? 0,
              apiUrl: formText(form, "apiUrl"),
              token: formText(form, "token"),
            },
          });
          await onChanged();
        }}
      >
        <Field label="API address" htmlFor={`${provider}-account-api-url`}>
          <Input
            id={`${provider}-account-api-url`}
            name="apiUrl"
            type="url"
            required
            maxLength={300}
            defaultValue={
              apiUrl ?? account?.apiUrl ?? defaultGitApiUrls[provider]
            }
          />
        </Field>
        <Field
          label="Personal access token"
          htmlFor={`${provider}-account-token`}
        >
          <Input
            id={`${provider}-account-token`}
            name="token"
            type="password"
            required
            minLength={20}
            maxLength={400}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      </FormDialog>
    </section>
  );
}

const signInErrors: Record<string, string> = {
  denied: "Sign-in was canceled.",
  expired: "The sign-in expired. Try again.",
  taken: "That account is already connected by another member.",
  failed: "Sign-in failed. Try again.",
};

export function GitAccountSettings() {
  const signInError = signInErrors[useSearchParams().get("gitError") ?? ""];
  const [data, setData] = useState<GitAccounts | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => {
    const value = await cloudRequest<GitAccounts>("git/accounts", { signal });
    if (!signal?.aborted) setData(value);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch((reason: Error) => {
      if (!controller.signal.aborted) setError(reason.message);
    });
    return () => controller.abort();
  }, [load]);
  if (error)
    return (
      <p role="alert" className="cloud-error">
        {error}
      </p>
    );
  if (!data) return null;
  const providers = gitProviders.filter(
    (provider) => data.connections[provider] || data.accounts[provider],
  );
  if (!providers.length) return <p>Your organization has no Git connection.</p>;
  return (
    <>
      {signInError && (
        <p role="alert" className="cloud-error">
          {signInError}
        </p>
      )}
      {providers.map((provider) => (
        <AccountSection
          key={provider}
          provider={provider}
          account={data.accounts[provider]}
          apiUrl={data.connections[provider]?.apiUrl}
          oauth={data.connections[provider]?.oauth ?? false}
          available={data.credentialStorageAvailable}
          onChanged={() => load()}
        />
      ))}
    </>
  );
}
