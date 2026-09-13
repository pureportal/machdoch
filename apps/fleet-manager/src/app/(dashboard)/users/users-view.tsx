"use client";

import { Laptop, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmButton } from "@/components/confirm-button";
import { Field } from "@/components/field";
import { Input } from "@/components/ui/input";
import { api, jsonBody } from "@/lib/api";
import { formatTime } from "@/lib/format";

interface OwnerAccount {
  username: string;
  createdAt: number;
  updatedAt: number;
}

interface OwnerSession {
  sessionId: string;
  clientLabel: string;
  createdAt: number;
  lastSeenAt: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  current: boolean;
}

export function UsersView(): React.ReactElement {
  const router = useRouter();
  const [account, setAccount] = useState<OwnerAccount | null>(null);
  const [sessions, setSessions] = useState<OwnerSession[]>([]);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const loadController = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    try {
      const [accountPayload, sessionsPayload] = await Promise.all([
        api<{ account: OwnerAccount }>("/api/auth/account", {
          signal: controller.signal,
        }),
        api<{ sessions: OwnerSession[] }>("/api/auth/sessions", {
          signal: controller.signal,
        }),
      ]);
      if (controller.signal.aborted) return;
      setAccount(accountPayload.account);
      setSessions(sessionsPayload.sessions);
      setLoadError("");
    } catch (reason) {
      if (controller.signal.aborted) return;
      setLoadError(
        reason instanceof Error
          ? reason.message
          : "Account could not be loaded.",
      );
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    return () => loadController.current?.abort();
  }, [load]);
  return (
    <section className="grid max-w-4xl gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
      {loadError ? (
        <div
          role="alert"
          className="flex min-w-0 flex-wrap items-center gap-3 text-sm text-destructive"
        >
          <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">{loadError}</p>
          <Button
            variant="outline"
            disabled={loading || pending}
            onClick={() => void load()}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {loading && !account ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading account…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {account ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Owner</CardTitle>
            </CardHeader>
            <CardContent>
              <form
                className="grid max-w-lg gap-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (pending || loading) return;
                  setPending(true);
                  setError("");
                  const form = new FormData(event.currentTarget);
                  void api<{ ok: true }>("/api/auth/account", {
                    method: "PUT",
                    body: jsonBody({
                      username: form.get("username"),
                      currentPassword: form.get("currentPassword"),
                      newPassword: form.get("newPassword"),
                    }),
                  })
                    .then(() => {
                      router.replace("/login");
                      router.refresh();
                    })
                    .catch((reason: unknown) =>
                      setError(
                        reason instanceof Error
                          ? reason.message
                          : "Account update failed.",
                      ),
                    )
                    .finally(() => setPending(false));
                }}
              >
                <Field label="Username" htmlFor="owner-username">
                  <Input
                    key={account.username}
                    id="owner-username"
                    name="username"
                    defaultValue={account.username}
                    maxLength={64}
                    required
                    autoComplete="username"
                    disabled={pending || loading}
                  />
                </Field>
                <Field label="Current password" htmlFor="current-password">
                  <Input
                    id="current-password"
                    name="currentPassword"
                    type="password"
                    autoComplete="current-password"
                    maxLength={1024}
                    required
                    disabled={pending || loading}
                  />
                </Field>
                <Field
                  label="New password"
                  htmlFor="new-password"
                  hint="Use at least 12 characters."
                >
                  <Input
                    id="new-password"
                    name="newPassword"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={1024}
                    required
                    disabled={pending || loading}
                  />
                </Field>
                <p className="text-xs text-muted-foreground">
                  Updating the owner signs out all browsers.
                </p>
                <Button
                  type="submit"
                  className="w-fit"
                  disabled={pending || loading}
                >
                  {pending ? "Saving…" : "Update owner"}
                </Button>
              </form>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Browser sessions</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              {sessions.map((session) => (
                <div
                  key={session.sessionId}
                  className="flex min-w-0 items-center gap-3 rounded-lg border border-border px-4 py-3"
                >
                  <Laptop className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="min-w-0 truncate text-sm font-medium">
                        {session.clientLabel}
                      </p>
                      {session.current ? (
                        <Badge variant="online">Current</Badge>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Last active {formatTime(session.lastSeenAt)}
                    </p>
                  </div>
                  <RevokeSession session={session} onRevoked={load} />
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      ) : null}
    </section>
  );
}

function RevokeSession({
  session,
  onRevoked,
}: {
  session: OwnerSession;
  onRevoked: () => Promise<void>;
}): React.ReactElement {
  const router = useRouter();
  return (
    <ConfirmButton
      trigger={
        <Button variant="ghost" size="icon" aria-label="Revoke browser session">
          <Trash2 />
        </Button>
      }
      title="Revoke browser session?"
      description="This browser will be signed out."
      actionLabel="Revoke session"
      onConfirm={async () => {
        await api(
          `/api/auth/sessions/${encodeURIComponent(session.sessionId)}`,
          { method: "DELETE" },
        );
        if (session.current) {
          router.replace("/login");
          router.refresh();
        } else {
          await onRevoked();
        }
      }}
    />
  );
}
