"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  AuthenticatorSetup,
  RecoveryCodes,
} from "@/lib/cloud-two-factor-contract";
import { cloudRequest, formText } from "./api-client";
import { AuthFrame } from "./auth-frame";
import { AuthenticatorQr } from "./authenticator-qr";
import { RecoveryCodeList } from "./recovery-code-list";
import { TwoFactorCodeField } from "./two-factor-code-field";
import { restartStaleSignIn, selectForRetry } from "./two-factor-response";
import { TwoFactorSignOut } from "./two-factor-sign-out";

export function TwoFactorEnrollment({
  destination,
  signIn,
}: {
  destination: string;
  signIn: string;
}) {
  const [setup, setSetup] = useState<AuthenticatorSetup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    void cloudRequest<AuthenticatorSetup>("auth/two-factor/setup", {
      method: "POST",
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setSetup(result);
      })
      .catch((reason: Error) => {
        if (controller.signal.aborted || restartStaleSignIn(reason, signIn))
          return;
        setError(reason.message);
      });
    return () => controller.abort();
  }, [signIn]);
  useEffect(() => {
    if (error && !pending) selectForRetry(input.current);
  }, [error, pending]);
  if (codes)
    return (
      <AuthFrame>
        <h1>Recovery codes</h1>
        <p>
          Each code signs you in once if you lose your authenticator app. They
          are shown only now.
        </p>
        <RecoveryCodeList codes={codes} />
        <Button onClick={() => location.assign(destination)}>Continue</Button>
      </AuthFrame>
    );
  return (
    <AuthFrame>
      <h1>Set up two-factor authentication</h1>
      <p>
        Scan the QR code with an authenticator app, then enter the 6-digit code
        it shows.
      </p>
      {setup ? (
        <AuthenticatorQr setup={setup} />
      ) : (
        !error && <p role="status">Loading…</p>
      )}
      {setup && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) return;
            const form = new FormData(event.currentTarget);
            setPending(true);
            setError("");
            void cloudRequest<RecoveryCodes>("auth/two-factor/setup/confirm", {
              method: "POST",
              body: {
                code: formText(form, "code"),
                remember: form.get("remember") === "on",
              },
            })
              .then((result) => setCodes(result.recoveryCodes))
              .catch((reason: Error) => {
                if (restartStaleSignIn(reason, signIn)) return;
                setError(reason.message);
                setPending(false);
              });
          }}
        >
          <TwoFactorCodeField
            id="code"
            label="Authentication code"
            disabled={pending}
            inputRef={input}
          />
          <label className="flex items-center gap-2">
            <input type="checkbox" name="remember" disabled={pending} />
            Remember me
          </label>
          <Button type="submit" aria-disabled={pending} aria-busy={pending}>
            {pending ? "Verifying…" : "Continue"}
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      <TwoFactorSignOut disabled={pending} />
    </AuthFrame>
  );
}
