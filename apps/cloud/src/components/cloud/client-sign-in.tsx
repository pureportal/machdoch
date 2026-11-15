"use client";

import { Monitor } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { ClientSignInConsent } from "@/lib/client-sign-in-contract";
import { CloudRequestError, cloudRequest } from "./api-client";
import { AuthFrame } from "./auth-frame";

export function ClientSignInForm({
  consent,
}: {
  consent: ClientSignInConsent;
}) {
  const [shared, setShared] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [signIn, setSignIn] = useState(false);
  async function decide(approve: boolean) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const result = await cloudRequest<{ redirect: string }>(
        `client-sign-ins/${consent.id}`,
        { method: "POST", body: { approve, shared } },
      );
      location.assign(result.redirect);
    } catch (reason) {
      setSignIn(reason instanceof CloudRequestError && reason.status === 401);
      setError(
        reason instanceof Error
          ? reason.message
          : "Sign-in failed. Sign in again from the app.",
      );
      setPending(false);
    }
  }
  return (
    <AuthFrame>
      <form
        className="cloud-client-sign-in"
        onSubmit={(event) => {
          event.preventDefault();
          void decide(true);
        }}
      >
        <h1>Sign in to Machdoch</h1>
        <p className="cloud-client-sign-in-device">
          <Monitor size={18} aria-hidden="true" />
          <span>{consent.clientName}</span>
        </p>
        <p>
          {consent.organization} · {consent.account}
        </p>
        {consent.canShare && (
          <fieldset disabled={pending} className="cloud-consent-scopes">
            <legend>Use this client for</legend>
            <label>
              <input
                type="radio"
                name="owner"
                checked={!shared}
                onChange={() => setShared(false)}
              />
              Only me
            </label>
            <label>
              <input
                type="radio"
                name="owner"
                checked={shared}
                onChange={() => setShared(true)}
              />
              The organization
            </label>
            {shared && <p>Only admins can assign agent tasks until you allow others.</p>}
          </fieldset>
        )}
        {error && (
          <p role="alert" className="cloud-error">
            {error}
          </p>
        )}
        {signIn && (
          <Button asChild>
            <a href={`/cloud/login?authorize=${consent.id}`}>Sign in again</a>
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
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </div>
      </form>
    </AuthFrame>
  );
}
