"use client";
import { AuthFrame } from "./auth-frame";
import Link from "next/link";
import type { MagicLinkPreview } from "@/lib/cloud-email-contract";
import { Button } from "@/components/ui/button";
import { cloudRequest } from "./api-client";
import { useAuthConfirmation } from "./use-auth-confirmation";

export function MagicSignIn() {
  const confirmation = useAuthConfirmation<MagicLinkPreview>(
    "auth/magic",
    "Open the sign-in link from your email.",
  );
  const { preview, loading, pending, error } = confirmation;
  return (
    <AuthFrame>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void confirmation.run(async (value, signal) => {
            const result = await cloudRequest<{ redirect: string }>(
              "auth/magic/consume",
              {
                method: "POST",
                body: { confirmationId: value.confirmationId },
                signal,
              },
            );
            if (!signal.aborted) location.replace(result.redirect);
          });
        }}
      >
        <h1>{preview?.currentEmail ? "Switch account" : "Sign in"}</h1>
        {loading && <p role="status">Checking sign-in link…</p>}
        {preview && (
          <>
            <p className="break-words font-medium">{preview.email}</p>
            <p className="break-words text-muted-foreground">
              {preview.organization}
            </p>
            {preview.currentEmail && (
              <p className="break-words">
                You are signed in as {preview.currentEmail}.
              </p>
            )}
            <Button type="submit" aria-disabled={pending} aria-busy={pending}>
              {pending
                ? "Signing in…"
                : preview.currentEmail
                  ? "Switch account"
                  : "Sign in"}
            </Button>
          </>
        )}
        {error && (
          <p role="alert" className="cloud-error">
            {error.message}
          </p>
        )}
        {!loading && (
          <Link className="underline" href="/cloud/login" prefetch={false}>
            Back to sign in
          </Link>
        )}
      </form>
    </AuthFrame>
  );
}
