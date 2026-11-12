"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { TwoFactorVerification } from "@/lib/cloud-two-factor-contract";
import { cloudRequest, formText } from "./api-client";
import { AuthFrame } from "./auth-frame";
import { TwoFactorCodeField } from "./two-factor-code-field";
import {
  isTwoFactorLock,
  restartStaleSignIn,
  selectForRetry,
} from "./two-factor-response";
import { TwoFactorSignOut } from "./two-factor-sign-out";

export function TwoFactorChallenge({
  destination,
  signIn,
}: {
  destination: string;
  signIn: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (error && !pending) selectForRetry(input.current);
  }, [error, pending]);
  if (remaining !== null)
    return (
      <AuthFrame>
        <h1>Recovery code used</h1>
        <p role="status">
          {remaining === 1
            ? "1 recovery code left."
            : `${remaining} recovery codes left.`}
        </p>
        <Button onClick={() => location.assign(destination)}>Continue</Button>
        <Button asChild variant="outline">
          <Link href="/cloud/account?tab=security">Manage two-factor</Link>
        </Button>
      </AuthFrame>
    );
  return (
    <AuthFrame>
      <h1>Two-factor authentication</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (pending) return;
          const form = new FormData(event.currentTarget);
          setPending(true);
          setError("");
          void cloudRequest<TwoFactorVerification>("auth/two-factor/verify", {
            method: "POST",
            body: {
              code: formText(form, "code"),
              remember: form.get("remember") === "on",
            },
          })
            .then((result) => {
              if (result.remainingRecoveryCodes === null)
                location.assign(destination);
              else {
                setRemaining(result.remainingRecoveryCodes);
                setPending(false);
              }
            })
            .catch((reason: Error) => {
              if (restartStaleSignIn(reason, signIn)) return;
              setError(reason.message);
              setPending(false);
              if (isTwoFactorLock(reason)) setRecovery(true);
            });
        }}
      >
        <TwoFactorCodeField
          key={recovery ? "recovery" : "authenticator"}
          id="code"
          label={recovery ? "Recovery code" : "Authentication code"}
          recovery={recovery}
          disabled={pending}
          autoFocus
          inputRef={input}
        />
        <label className="flex items-center gap-2">
          <input type="checkbox" name="remember" disabled={pending} />
          Remember me
        </label>
        <Button type="submit" aria-disabled={pending} aria-busy={pending}>
          {pending ? "Verifying…" : "Verify"}
        </Button>
      </form>
      <Button
        type="button"
        variant="outline"
        disabled={pending}
        onClick={() => {
          setRecovery(!recovery);
          setError("");
        }}
      >
        {recovery ? "Use authenticator app" : "Use a recovery code"}
      </Button>
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      <TwoFactorSignOut disabled={pending} />
    </AuthFrame>
  );
}
