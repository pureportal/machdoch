"use client";
import { AuthFrame } from "./auth-frame";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  cloudOAuthScopeLabels,
  type CloudConsent,
  type CloudOAuthScope,
} from "@/lib/cloud-oauth-contract";
import { CloudRequestError, cloudRequest } from "./api-client";

export function CloudAuthorizationForm({ consent }: { consent: CloudConsent }) {
  const [scopes, setScopes] = useState<CloudOAuthScope[]>(["cloud:read"]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [signIn, setSignIn] = useState(false);
  async function decide(approve: boolean) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const result = await cloudRequest<{ redirect: string }>(
        `authorizations/${consent.id}`,
        { method: "POST", body: { approve, scopes } },
      );
      location.assign(result.redirect);
    } catch (reason) {
      setSignIn(reason instanceof CloudRequestError && reason.status === 401);
      setError(
        reason instanceof Error
          ? reason.message
          : "Connection failed. Reconnect from the app.",
      );
      setPending(false);
    }
  }
  return (
    <AuthFrame>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void decide(true);
        }}
      >
        <h1>Connect {consent.clientName}</h1>
        <p>
          {consent.organization} · {consent.account}
        </p>
        <fieldset disabled={pending} className="cloud-consent-scopes">
          <legend>Allow access</legend>
          {consent.scopes.map((scope) => (
            <label key={scope}>
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                disabled={scope === "cloud:read"}
                onChange={(event) =>
                  setScopes(
                    event.target.checked
                      ? [...scopes, scope]
                      : scopes.filter((item) => item !== scope),
                  )
                }
              />
              {cloudOAuthScopeLabels[scope]}
            </label>
          ))}
        </fieldset>
        {scopes.includes("cloud:execute") && (
          <p>AI tasks can consume your organization’s provider budget.</p>
        )}
        {error && (
          <p role="alert" className="cloud-error">
            {error}
          </p>
        )}
        {signIn && (
          <Button asChild>
            <a href={`/cloud/login?authorize=${consent.id}`}>Sign in</a>
          </Button>
        )}
        <div className="cloud-editor-actions">
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => void decide(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? "Connecting…" : "Connect"}
          </Button>
        </div>
      </form>
    </AuthFrame>
  );
}
