"use client";

import { Laptop, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmButton } from "@/components/confirm-button";
import { api } from "@machdoch/product-ui/fleet-api";
import { formatTime } from "@/lib/format";

import { OwnerAccountCard, type OwnerAccount } from "./owner-account";
import { PageHeader } from "@/components/page-header";
import { AppearancePreferences } from "@/components/fleet-appearance";

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
  const [account, setAccount] = useState<OwnerAccount | null>(null);
  const [sessions, setSessions] = useState<OwnerSession[]>([]);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
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
    <section className="grid gap-6">
      <PageHeader title="Users" />
      <AppearancePreferences />
      {loadError ? (
        <div
          role="alert"
          className="flex min-w-0 flex-wrap items-center gap-3 text-sm text-destructive"
        >
          <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">{loadError}</p>
          <Button
            variant="outline"
            disabled={loading}
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
      {account ? (
        <>
          <OwnerAccountCard account={account} loading={loading} />
          <Card>
            <CardHeader>
              <CardTitle>Browser sessions</CardTitle>
            </CardHeader>
            <CardContent className="grid divide-y">
              {sessions.map((session) => (
                <div
                  key={session.sessionId}
                  className="flex min-w-0 items-center gap-3 py-4"
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
