"use client";

import { ExternalLink, Monitor, Plus, RefreshCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmButton } from "@/components/confirm-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";
import { formatRelativeTime, formatTime } from "@/lib/format";

interface FleetInstance {
  instanceId: string;
  displayName: string;
  productVersion: string;
  protocolVersion: number;
  enrolledAt: number;
  lastSeenAt: number | null;
  status: "online" | "offline" | "revoked";
}

export function InstancesView(): React.ReactElement {
  const [instances, setInstances] = useState<FleetInstance[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("active");
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const payload = await api<{ instances: FleetInstance[] }>(
        "/api/instances",
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setInstances(payload.instances);
      setError("");
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(
        reason instanceof Error
          ? reason.message
          : "Instances could not be loaded.",
      );
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        request.current = null;
      }
    }
  }, []);
  useEffect(() => {
    void load();
    const interval = window.setInterval(() => {
      if (!request.current && document.visibilityState === "visible")
        void load();
    }, 10_000);
    return () => {
      window.clearInterval(interval);
      request.current?.abort();
    };
  }, [load]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredInstances = (instances ?? []).filter(
    (instance) =>
      (status === "active"
        ? instance.status !== "revoked"
        : instance.status === status) &&
      `${instance.displayName} ${instance.instanceId}`
        .toLocaleLowerCase()
        .includes(normalizedQuery),
  );

  return (
    <section className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Instances</h1>
        <Button asChild>
          <Link href="/enrollment">
            <Plus />
            Enroll instance
          </Link>
        </Button>
      </div>
      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 text-sm text-destructive"
        >
          <p className="min-w-0 flex-1">{error}</p>
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => void load()}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {instances && instances.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label="Search instances"
            placeholder="Search instances"
            className="min-w-40 flex-1"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Select
            aria-label="Instance status"
            className="w-auto"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="active">Active</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
            <option value="revoked">Revoked</option>
          </Select>
          <Button
            variant="outline"
            size="icon"
            aria-label="Refresh instances"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw />
          </Button>
        </div>
      ) : null}
      {instances === null && loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading instances…
        </p>
      ) : null}
      {!error && instances?.length === 0 ? (
        <Card className="grid min-h-52 place-items-center p-8 text-center">
          <div className="grid justify-items-center gap-4">
            <span className="grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">
              <Monitor />
            </span>
            <p className="text-sm text-muted-foreground">
              No instances enrolled.
            </p>
            <Button asChild variant="outline">
              <Link href="/enrollment">Enroll instance</Link>
            </Button>
          </div>
        </Card>
      ) : (
        <div className="grid gap-3">
          {filteredInstances.map((instance) => (
            <Card
              key={instance.instanceId}
              className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center"
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
                <Monitor className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="min-w-0 [overflow-wrap:anywhere] font-medium">
                    {instance.displayName}
                  </h2>
                  <Badge variant={instance.status}>{instance.status}</Badge>
                </div>
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                  {instance.instanceId}
                </p>
                <p
                  className="mt-1 text-xs text-muted-foreground"
                  title={formatTime(instance.lastSeenAt)}
                >
                  v{instance.productVersion} · Last seen{" "}
                  {formatRelativeTime(instance.lastSeenAt)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {instance.status === "online" ? (
                  <Button asChild variant="outline" size="sm">
                    <a
                      href={`/instances/${encodeURIComponent(instance.instanceId)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink />
                      Open
                    </a>
                  </Button>
                ) : null}
                {instance.status !== "revoked" ? (
                  <RevokeInstance instance={instance} onRevoked={load} />
                ) : null}
              </div>
            </Card>
          ))}
        </div>
      )}
      {!error &&
      instances &&
      instances.length > 0 &&
      filteredInstances.length === 0 ? (
        <p
          role="status"
          className="py-8 text-center text-sm text-muted-foreground"
        >
          {normalizedQuery
            ? "No matching instances."
            : `No ${status} instances.`}
        </p>
      ) : null}
    </section>
  );
}

function RevokeInstance({
  instance,
  onRevoked,
}: {
  instance: FleetInstance;
  onRevoked: () => Promise<void>;
}): React.ReactElement {
  return (
    <ConfirmButton
      trigger={
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Revoke ${instance.displayName}`}
        >
          <Trash2 />
        </Button>
      }
      title={`Revoke ${instance.displayName}?`}
      description="The instance will lose Fleet Manager access."
      actionLabel="Revoke instance"
      onConfirm={async () => {
        await api(`/api/instances/${encodeURIComponent(instance.instanceId)}`, {
          method: "DELETE",
        });
        await onRevoked();
      }}
    />
  );
}
