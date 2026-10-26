"use client";
import { AuthFrame } from "./auth-frame";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cloudRequest } from "./api-client";

interface Preview {
  id: string;
  mode: "login" | "link";
  provider: string;
  identity: string;
  account: string;
  currentAccount: string | null;
}
export function SsoSignIn() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const active = useRef<AbortController | null>(null);
  const expectedId = useRef("");
  useEffect(() => {
    function load() {
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      const id = new URL(location.href).searchParams.get("id");
      expectedId.current = id ?? "";
      setPreview(null);
      setPending(false);
      setError("");
      if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
        setError(
          "Sign-in could not be completed. Start again from the sign-in page.",
        );
        return;
      }
      void cloudRequest<Preview>("auth/sso/preview", {
        method: "POST",
        body: { id },
        signal: controller.signal,
      })
        .then((result) => {
          if (!controller.signal.aborted) setPreview(result);
        })
        .catch((reason: Error) => {
          if (!controller.signal.aborted) setError(reason.message);
        });
    }
    load();
    window.addEventListener("popstate", load);
    window.addEventListener("pageshow", load);
    const cancel = () => active.current?.abort();
    window.addEventListener("pagehide", cancel);
    return () => {
      cancel();
      window.removeEventListener("popstate", load);
      window.removeEventListener("pageshow", load);
      window.removeEventListener("pagehide", cancel);
    };
  }, []);
  return (
    <AuthFrame>
      <h1>{preview?.mode === "link" ? "Link identity" : "Confirm sign-in"}</h1>
      {preview && (
        <>
          <dl className="cloud-properties">
            <div>
              <dt>{preview.provider}</dt>
              <dd className="break-all">{preview.identity}</dd>
            </div>
            <div>
              <dt>Account</dt>
              <dd className="break-all">{preview.account}</dd>
            </div>
          </dl>
          {preview.mode === "link" ? (
            <p>
              This identity will be able to sign in to this account. Existing
              sessions and app connections for this organization will end.
            </p>
          ) : preview.currentAccount &&
            preview.currentAccount !== preview.account ? (
            <p>
              Switch from {preview.currentAccount} to {preview.account}?
            </p>
          ) : null}
          <Button
            aria-disabled={pending}
            aria-busy={pending}
            onClick={() => {
              if (
                pending ||
                new URL(location.href).searchParams.get("id") !==
                  expectedId.current
              )
                return;
              const controller = new AbortController();
              active.current?.abort();
              active.current = controller;
              setPending(true);
              setError("");
              void cloudRequest<{ redirect: string }>("auth/sso/consume", {
                method: "POST",
                body: { id: preview.id },
                signal: controller.signal,
              })
                .then((result) => {
                  if (!controller.signal.aborted)
                    location.assign(result.redirect);
                })
                .catch((reason: Error) => {
                  if (!controller.signal.aborted) {
                    setError(reason.message);
                    setPending(false);
                  }
                });
            }}
          >
            {pending
              ? "Continuing…"
              : preview.mode === "link"
                ? "Link identity"
                : "Sign in"}
          </Button>
        </>
      )}
      {!preview && !error && <p role="status">Loading sign-in…</p>}
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      <Button variant="outline" asChild>
        <Link href="/cloud/login">Back to sign in</Link>
      </Button>
    </AuthFrame>
  );
}
