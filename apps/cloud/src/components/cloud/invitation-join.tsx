"use client";
import { AuthFrame } from "./auth-frame";

import Link from "next/link";
import type { InvitationPreview } from "@/lib/cloud-invitation-contract";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CloudRequestError, cloudRequest, formText } from "./api-client";
import { useAuthConfirmation } from "./use-auth-confirmation";

const ssoFailures = {
  failed: "The provider sign-in failed. Sign in again to continue.",
  expired: "The provider sign-in expired. Sign in again to continue.",
  identity_mismatch:
    "This identity does not match the invitation. Sign in with the invited identity.",
};
export function InvitationJoin() {
  const confirmation = useAuthConfirmation<InvitationPreview>(
    "invitations",
    "Open the original invitation link to continue.",
  );
  const { preview, loading, pending, error } = confirmation;
  const ready =
    preview &&
    (preview.completed ||
      preview.authentication === "password" ||
      !!preview.verifiedIdentity);
  const message =
    error?.message ??
    (preview?.ssoFailure ? ssoFailures[preview.ssoFailure] : null);
  return (
    <AuthFrame>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          const form = new FormData(event.currentTarget);
          void confirmation.run(async (value, signal) => {
            const result = await cloudRequest<{ redirect: string }>(
              "invitations/accept",
              {
                method: "POST",
                body: {
                  confirmationId: value.confirmationId,
                  sessionId: value.currentSessionId,
                  ...(!value.completed && !value.existingAccount
                    ? { name: formText(form, "name") }
                    : {}),
                  ...(!value.completed &&
                  value.authentication === "password" &&
                  !value.canUseSession
                    ? { password: formText(form, "password") }
                    : {}),
                },
                signal,
              },
            );
            if (!signal.aborted) location.replace(result.redirect);
          });
        }}
      >
        <h1 className="break-words">
          {preview ? `Join ${preview.organization}` : "Join organization"}
        </h1>
        {loading && <p role="status">Checking invitation…</p>}
        {preview && (
          <>
            <dl className="cloud-properties">
              <div>
                <dt>Account</dt>
                <dd className="break-all">{preview.email}</dd>
              </div>
              <div>
                <dt>Role</dt>
                <dd className="capitalize">{preview.role}</dd>
              </div>
            </dl>
            {preview.currentEmail && preview.currentEmail !== preview.email && (
              <p>
                Joining as {preview.email} will replace {preview.currentEmail}{" "}
                in this browser.
              </p>
            )}
            {ready && !preview.completed && !preview.existingAccount && (
              <Field label="Name" htmlFor="join-name">
                <Input
                  id="join-name"
                  name="name"
                  required
                  maxLength={120}
                  autoComplete="name"
                  disabled={pending}
                />
              </Field>
            )}
            {!preview.completed &&
              preview.authentication === "password" &&
              !preview.canUseSession && (
                <Field
                  label={
                    preview.existingAccount ? "Account password" : "Password"
                  }
                  htmlFor="join-password"
                >
                  <Input
                    id="join-password"
                    name="password"
                    type="password"
                    required
                    minLength={preview.existingAccount ? 1 : 12}
                    maxLength={1024}
                    autoComplete={
                      preview.existingAccount
                        ? "current-password"
                        : "new-password"
                    }
                    disabled={pending}
                  />
                </Field>
              )}
            {preview.verifiedIdentity && (
              <dl className="cloud-properties">
                <div>
                  <dt>{preview.provider}</dt>
                  <dd className="break-all">{preview.verifiedIdentity}</dd>
                </div>
              </dl>
            )}
            {ready ? (
              <Button type="submit" aria-disabled={pending} aria-busy={pending}>
                {pending
                  ? "Joining…"
                  : preview.completed
                    ? "Continue"
                    : "Join organization"}
              </Button>
            ) : (
              <Button
                type="button"
                aria-disabled={pending}
                aria-busy={pending}
                onClick={() =>
                  void confirmation.run(async (value, signal) => {
                    const result = await cloudRequest<{ url: string }>(
                      "invitations/sso",
                      {
                        method: "POST",
                        body: { confirmationId: value.confirmationId },
                        signal,
                      },
                    );
                    if (!signal.aborted) location.assign(result.url);
                  })
                }
              >
                {pending
                  ? "Opening provider…"
                  : `Sign in with ${preview.provider}`}
              </Button>
            )}
          </>
        )}
        {message && (
          <p role="alert" className="cloud-error">
            {message}
          </p>
        )}
        {error instanceof CloudRequestError &&
          (error.code === "account_changed" ||
            (!preview &&
              [
                "network_unavailable",
                "request_timeout",
                "invalid_response",
              ].includes(error.code))) && (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={confirmation.refresh}
            >
              {error.code === "account_changed"
                ? "Review invitation"
                : "Try again"}
            </Button>
          )}
        {!loading && (
          <Link className="underline" href="/cloud/login" prefetch={false}>
            Sign in
          </Link>
        )}
      </form>
    </AuthFrame>
  );
}
