"use client";

import { ExternalLink, Monitor, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ConfirmButton } from "@/components/confirm-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
  const [instances, setInstances] = useState<FleetInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const payload = await api<{ instances: FleetInstance[] }>(
        "/api/instances",
      );
      setInstances(payload.instances);
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Instances could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(interval);
  }, [load]);

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
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!loading && instances.length === 0 ? (
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
          {instances.map((instance) => (
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
