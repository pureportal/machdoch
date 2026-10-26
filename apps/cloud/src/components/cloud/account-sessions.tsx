"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CloudSessionInfo,
  SessionAccount,
  SessionRevocation,
  SessionRevocationResult,
} from "@/lib/cloud-session-contract";
import { Button } from "@/components/ui/button";
import { FormDialog } from "@/components/form-dialog";
import {
  CloudRequestError,
  cloudRequest,
  createCommandSender,
} from "./api-client";

const methods = {
  password: "Password",
  magic_link: "Email link",
  oidc: "Single sign-on",
};
function sessionLabel(session: CloudSessionInfo): string {
  return (
    [session.browser, session.platform].filter(Boolean).join(" · ") ||
    "Browser session"
  );
}

export function AccountSessions({ account }: { account: SessionAccount }) {
  const [sessions, setSessions] = useState<CloudSessionInfo[] | null>(null);
  const [error, setError] = useState("");
  const [signedOut, setSignedOut] = useState(false);
  const [loading, setLoading] = useState(false);
  const [revoking, setRevoking] = useState<SessionRevocation | null>(null);
  const controller = useRef<AbortController | null>(null);
  const sender = useRef(createCommandSender());
  const refreshButton = useRef<HTMLButtonElement>(null);
  const refresh = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setLoading(true);
    setSignedOut(false);
    setError("");
    try {
      const result = await cloudRequest<CloudSessionInfo[]>(
        `account/sessions?${new URLSearchParams(account)}`,
        { signal: current.signal },
      );
      if (!current.signal.aborted) setSessions(result);
    } catch (reason) {
      if (!current.signal.aborted) {
        setError((reason as Error).message);
        setSignedOut(
          reason instanceof CloudRequestError && reason.status === 401,
        );
      }
    } finally {
      if (!current.signal.aborted) setLoading(false);
    }
  }, [account]);
  useEffect(() => {
    void refresh();
    const visible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.current?.abort();
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  const target =
    revoking?.scope === "session"
      ? sessions?.find((session) => session.id === revoking.id)
      : undefined;
  function select(input: SessionRevocation) {
    sender.current = createCommandSender();
    setRevoking(input);
  }
  return (
    <section
      className="cloud-settings-section"
      aria-labelledby="sessions-heading"
    >
      <header>
        <h2 id="sessions-heading">Organization sessions</h2>
        <Button
          ref={refreshButton}
          variant="outline"
          aria-disabled={loading}
          aria-busy={loading}
          onClick={() => {
            if (!loading) void refresh();
          }}
        >
          Refresh sessions
        </Button>
      </header>
      {!sessions && loading && <p role="status">Loading sessions…</p>}
      <ul className="grid gap-3">
        {sessions?.map((session) => (
          <li
            key={session.id}
            data-session-id={session.id}
            className="grid min-w-0 gap-3 rounded-xl border border-border p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <strong>{sessionLabel(session)}</strong>
                {session.current && (
                  <span className="ml-2 text-sm text-muted-foreground">
                    This session
                  </span>
                )}
              </div>
              <Button
                variant="outline"
                onClick={() =>
                  select({ scope: "session", id: session.id, account })
                }
                aria-label={`Sign out ${session.current ? "this session" : sessionLabel(session)}`}
              >
                Sign out
              </Button>
            </div>
            <dl className="cloud-properties">
              <div>
                <dt>Signed in</dt>
                <dd>
                  <time dateTime={session.createdAt}>
                    {new Date(session.createdAt).toLocaleString()}
                  </time>
                </dd>
              </div>
              <div>
                <dt>Last active</dt>
                <dd>
                  <time dateTime={session.lastActiveAt}>
                    {new Date(session.lastActiveAt).toLocaleString()}
                  </time>
                </dd>
              </div>
              <div>
                <dt>Sign-in method</dt>
                <dd>{session.provider ?? methods[session.method]}</dd>
              </div>
              {session.address && (
                <div>
                  <dt>Sign-in address</dt>
                  <dd className="break-all">{session.address}</dd>
                </div>
              )}
            </dl>
          </li>
        ))}
      </ul>
      {sessions && sessions.some((session) => !session.current) && (
        <Button
          variant="outline"
          onClick={() => select({ scope: "other_sessions", account })}
        >
          Sign out other sessions
        </Button>
      )}
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      {signedOut && (
        <Button asChild variant="outline">
          <Link href="/cloud/login">Sign in</Link>
        </Button>
      )}
      <Link
        className="text-sm underline underline-offset-4"
        href="/cloud/connections"
      >
        Connected apps
      </Link>
      <FormDialog
        open={!!revoking}
        focusWhenOpenerRemoved={refreshButton}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={
          revoking?.scope === "other_sessions"
            ? "Sign out other sessions"
            : "Sign out session"
        }
        submitLabel="Sign out"
        onSubmit={async () => {
          if (!revoking) return;
          let result: SessionRevocationResult;
          try {
            result = await sender.current<SessionRevocationResult>(
              "account/sessions/revoke",
              revoking,
            );
          } catch (reason) {
            if (!(reason instanceof CloudRequestError) || reason.status !== 401)
              throw reason;
            await cloudRequest("auth/logout", { method: "POST" });
            location.assign("/cloud/login");
            return;
          }
          if (result.signedOut) {
            location.assign("/cloud/login");
            return;
          }
          await refresh();
        }}
      >
        <p>
          {revoking?.scope === "other_sessions"
            ? "Your other browser sessions in this organization will end."
            : target?.current
              ? "You will be signed out of this organization in this browser."
              : "This browser session in this organization will end."}
        </p>
        {target && (
          <p>
            {sessionLabel(target)} ·{" "}
            {new Date(target.createdAt).toLocaleString()}
          </p>
        )}
      </FormDialog>
    </section>
  );
}
