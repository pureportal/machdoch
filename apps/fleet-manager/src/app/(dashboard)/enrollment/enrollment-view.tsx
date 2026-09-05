"use client";

import { Check, Copy, KeyRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { formatTime } from "@/lib/format";

interface EnrollmentGrant {
  grantId: string;
  enrollmentKey: string;
  managerUrl: string;
  managerId: string;
  expiresAt: number;
}

interface AvailableGrant {
  grantId: string;
  createdAt: number;
  expiresAt: number;
}

export function EnrollmentView(): React.ReactElement {
  const [grant, setGrant] = useState<EnrollmentGrant | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [grants, setGrants] = useState<AvailableGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const inventoryRequest = useRef(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reload = useCallback(async (): Promise<void> => {
    const signal = controllerRef.current?.signal;
    if (!signal || signal.aborted) return;
    const requestId = ++inventoryRequest.current;
    setLoading(true);
    try {
      const result = await api<{ grants: AvailableGrant[] }>(
        "/api/enrollment-keys",
        { signal },
      );
      if (signal.aborted || requestId !== inventoryRequest.current) return;
      setGrants(result.grants);
      setGrant((current) =>
        current &&
        result.grants.some((item) => item.grantId === current.grantId)
          ? current
          : null,
      );
    } catch (reason) {
      if (!signal.aborted && requestId === inventoryRequest.current) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Keys could not be loaded.",
        );
      }
    } finally {
      if (!signal.aborted && requestId === inventoryRequest.current)
        setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    void reload();
    const visible = (): void => {
      if (document.visibilityState === "visible") void reload();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      if (copyTimer.current) clearTimeout(copyTimer.current);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [reload]);
  useEffect(() => {
    if (!grant) return;
    const timeout = setTimeout(
      () => {
        setGrant(null);
        void reload();
      },
      Math.min(2_147_483_647, Math.max(0, grant.expiresAt * 1000 - Date.now())),
    );
    return () => clearTimeout(timeout);
  }, [grant, reload]);
  return (
    <section className="grid max-w-3xl gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Enrollment</h1>
      <Card>
        <CardHeader>
          <CardTitle>Enrollment key</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5">
          {grant ? (
            <>
              <div className="grid gap-2">
                <label htmlFor="manager-url" className="text-sm font-medium">
                  Fleet Manager URL
                </label>
                <Input id="manager-url" value={grant.managerUrl} readOnly />
              </div>
              <div className="grid gap-2">
                <label htmlFor="enrollment-key" className="text-sm font-medium">
                  Enrollment key
                </label>
                <div className="flex gap-2">
                  <Input
                    id="enrollment-key"
                    value={grant.enrollmentKey}
                    readOnly
                    className="font-mono"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Copy enrollment key"
                    onClick={() => {
                      setError("");
                      void Promise.resolve()
                        .then(() =>
                          navigator.clipboard.writeText(grant.enrollmentKey),
                        )
                        .then(() => {
                          if (controllerRef.current?.signal.aborted) return;
                          setCopied(true);
                          if (copyTimer.current)
                            clearTimeout(copyTimer.current);
                          copyTimer.current = setTimeout(
                            () => setCopied(false),
                            1500,
                          );
                        })
                        .catch(() =>
                          setError("Enrollment key could not be copied."),
                        );
                    }}
                  >
                    {copied ? <Check /> : <Copy />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Expires {formatTime(grant.expiresAt)}.
                </p>
              </div>
            </>
          ) : (
            <div className="grid min-h-36 place-items-center text-center">
              <span className="grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">
                <KeyRound />
              </span>
            </div>
          )}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button
            className="w-fit"
            disabled={pending || revoking !== null}
            onClick={() => {
              const signal = controllerRef.current?.signal;
              inventoryRequest.current += 1;
              setPending(true);
              setError("");
              setCopied(false);
              void api<EnrollmentGrant>("/api/enrollment-keys", {
                method: "POST",
                signal,
              })
                .then((created) => {
                  if (!signal?.aborted) setGrant(created);
                })
                .catch((reason: unknown) => {
                  if (signal?.aborted) return;
                  setError(
                    reason instanceof Error
                      ? reason.message
                      : "Key creation failed.",
                  );
                })
                .finally(() => {
                  if (!signal?.aborted) {
                    setPending(false);
                    void reload();
                  }
                });
            }}
          >
            {pending
              ? "Creating…"
              : grant
                ? "Create another key"
                : "Create enrollment key"}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>Unused enrollment keys</CardTitle>
          <Button
            variant="outline"
            disabled={loading || pending || revoking !== null}
            onClick={() => {
              setError("");
              void reload();
            }}
          >
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            Revoke a key to prevent it from enrolling another instance. Existing
            instances keep their access. Key values are shown only when created.
          </p>
          {grants.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {loading ? "Loading keys…" : "No unused keys."}
            </p>
          ) : (
            grants.map((item) => (
              <div
                key={item.grantId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
              >
                <div className="min-w-0 text-sm">
                  <p className="break-all font-mono text-xs">{item.grantId}</p>
                  <p className="text-muted-foreground">
                    Created {formatTime(item.createdAt)} · Expires{" "}
                    {formatTime(item.expiresAt)}
                  </p>
                </div>
                <Button
                  variant="outline"
                  disabled={revoking !== null || pending}
                  onClick={() => {
                    const signal = controllerRef.current?.signal;
                    inventoryRequest.current += 1;
                    setRevoking(item.grantId);
                    setError("");
                    void api(
                      `/api/enrollment-keys/${encodeURIComponent(item.grantId)}`,
                      { method: "DELETE", signal },
                    )
                      .then(() => {
                        if (signal?.aborted) return;
                        setGrants((current) =>
                          current.filter((key) => key.grantId !== item.grantId),
                        );
                        setGrant((current) =>
                          current?.grantId === item.grantId ? null : current,
                        );
                      })
                      .catch((reason: unknown) => {
                        if (!signal?.aborted)
                          setError(
                            reason instanceof Error
                              ? reason.message
                              : "Key revocation failed.",
                          );
                      })
                      .finally(() => {
                        if (!signal?.aborted) {
                          setRevoking(null);
                          void reload();
                        }
                      });
                  }}
                >
                  {revoking === item.grantId ? "Revoking…" : "Revoke"}
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </section>
  );
}
