"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { CircleCheck, ExternalLink, LoaderCircle } from "lucide-react";
import type { CloudCliLogin } from "@machdoch/fleet-protocol/cloud-providers";
import { CopyField } from "@/components/copy-field";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cloudRequest } from "./api-client";

const pollMs = 2000;

export function useCliLogin(providerId: string | null) {
  const [login, setLogin] = useState<CloudCliLogin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const path = `ai-providers/${providerId}/login`;
  const run = useCallback(async (request: Promise<CloudCliLogin>) => {
    const sequence = ++latest.current;
    try {
      const next = await request;
      if (sequence !== latest.current) return;
      setLogin(next);
      setError(null);
    } catch (reason) {
      if (sequence === latest.current) setError((reason as Error).message);
    }
  }, []);
  const refresh = useCallback(
    () => (providerId ? run(cloudRequest<CloudCliLogin>(path)) : undefined),
    [providerId, path, run],
  );
  useEffect(() => {
    setLogin(null);
    void refresh();
  }, [refresh]);
  return {
    login,
    error,
    refresh,
    start: () =>
      run(cloudRequest<CloudCliLogin>(path, { method: "POST", body: {} })),
    submit: (code: string) =>
      run(
        cloudRequest<CloudCliLogin>(`${path}/code`, {
          method: "POST",
          body: { code },
        }),
      ),
    cancel: () =>
      run(
        cloudRequest<CloudCliLogin>(`${path}/cancel`, {
          method: "POST",
          body: {},
        }),
      ),
  };
}

export function CliLoginStatus({ login }: { login: CloudCliLogin | null }) {
  if (!login) return <span className="cloud-provider-status">Checking…</span>;
  return (
    <span className="cloud-provider-status" data-state={login.state}>
      {login.state === "signed-in"
        ? `Signed in${login.account ? ` · ${login.account}` : ""}`
        : login.state === "waiting"
          ? "Waiting for sign-in"
          : "Not signed in"}
    </span>
  );
}

export function CliSignInDialog({
  providerName,
  state,
  onClose,
}: {
  providerName: string;
  state: ReturnType<typeof useCliLogin>;
  onClose: () => void;
}) {
  const { login, error, refresh, start, submit } = state;
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const waiting = login?.state === "waiting";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [waiting, refresh]);
  async function act(operation: Promise<void>) {
    setBusy(true);
    await operation;
    setBusy(false);
  }
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void act(submit(code.trim())).then(() => setCode(""));
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg" aria-describedby={undefined}>
        <DialogTitle>Sign in to {providerName}</DialogTitle>
        <div className="cloud-sign-in">
          {login?.state === "signed-in" ? (
            <p className="cloud-sign-in-done" role="status">
              <CircleCheck size={18} aria-hidden="true" />
              Signed in{login.account ? ` as ${login.account}` : ""}
            </p>
          ) : waiting ? (
            <>
              {login.url ? (
                <Button asChild>
                  <a href={login.url} target="_blank" rel="noreferrer">
                    <ExternalLink />
                    Open sign-in page
                  </a>
                </Button>
              ) : (
                <p className="cloud-sign-in-pending" role="status">
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                  Starting sign-in…
                </p>
              )}
              {login.code && (
                <CopyField label="Code" value={login.code} monospace />
              )}
              {login.acceptsCode && (
                <form className="cloud-sign-in-code" onSubmit={onSubmit}>
                  <Field
                    label="Code"
                    htmlFor="cli-sign-in-code"
                    hint="Paste the code shown after you sign in."
                  >
                    <Input
                      id="cli-sign-in-code"
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={4096}
                    />
                  </Field>
                  <Button type="submit" disabled={busy || !code.trim()}>
                    Continue
                  </Button>
                </form>
              )}
              {login.url && (
                <p className="cloud-sign-in-pending" role="status">
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                  Waiting for sign-in…
                </p>
              )}
            </>
          ) : (
            login?.message && (
              <p className="cloud-error" role="alert">
                {login.message}
              </p>
            )
          )}
          {error && (
            <p className="cloud-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          {login?.state === "signed-in" ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            !waiting && (
              <Button
                disabled={busy || !login}
                onClick={() => void act(start())}
              >
                {login?.state === "failed" ? "Try again" : "Start sign-in"}
              </Button>
            )
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
