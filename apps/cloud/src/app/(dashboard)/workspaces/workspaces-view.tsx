"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { cancelFleetTasks } from "@/lib/cancel-fleet-tasks";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { versionWarning } from "@/lib/product-version";
import { useFleetStatus } from "./use-fleet-status";
import { DeviceResources } from "./device-resources";

export function WorkspacesView(): React.ReactElement {
  const { status, loading, error, refresh } = useFleetStatus();
  const [query, setQuery] = useState("");
  const [stopping, setStopping] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const devices = (status?.devices ?? []).filter((device) =>
    [
      device.displayName,
      ...device.workspaces.map((workspace) => workspace.root),
      ...device.sessions.map((session) => session.title),
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const stopTasks = async (): Promise<void> => {
    setStopping(true);
    setCommandError(null);
    const targets = (status?.devices ?? []).flatMap((device) =>
      device.tasks
        .filter(
          (task) =>
            task.cancellable &&
            selected.has(`${device.instanceId}/${task.taskId}`),
        )
        .map((task) => ({ device, task })),
    );
    const results = await cancelFleetTasks(
      targets.map(({ device, task }) => ({
        instanceId: device.instanceId,
        displayName: device.displayName,
        taskId: task.taskId,
      })),
    );
    const failed: string[] = [];
    const remaining = new Set(selected);
    results.forEach((result) => {
      if (result.error === null) remaining.delete(result.key);
      else failed.push(result.error);
    });
    setSelected(remaining);
    if (failed.length) setCommandError(failed.join("\n"));
    setStopping(false);
    await refresh();
  };
  const selectedCount = (status?.devices ?? []).flatMap((device) =>
    device.tasks.filter(
      (task) =>
        task.cancellable && selected.has(`${device.instanceId}/${task.taskId}`),
    ),
  ).length;

  return (
    <section className="grid gap-6">
      <PageHeader title="Workspaces">
        {selectedCount > 0 ? (
          <Button
            variant="outline"
            disabled={stopping || loading || Boolean(error)}
            onClick={() => void stopTasks()}
          >
            Stop selected ({selectedCount})
          </Button>
        ) : null}
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => void refresh()}
        >
          <RefreshCw />
          Refresh
        </Button>
      </PageHeader>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
          {status ? " Showing the last known status." : ""}
        </p>
      ) : null}
      {commandError ? (
        <p
          role="alert"
          className="whitespace-pre-wrap text-sm text-destructive"
        >
          {commandError}
        </p>
      ) : null}
      <Input
        aria-label="Search devices, workspaces, and sessions"
        placeholder="Search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {!status ? (
        <p role="status">
          {loading ? "Loading workspaces…" : "Workspaces could not be loaded."}
        </p>
      ) : null}
      {status && !devices.length ? (
        <p role="status">No matching workspaces.</p>
      ) : null}
      {devices.map((device) => {
        const warning = versionWarning(
          device.versionStatus,
          status?.managerVersion,
        );
        return (
          <Card key={device.instanceId} className="grid gap-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-semibold">{device.displayName}</h2>
              {device.online ? (
                <Button asChild size="sm" variant="outline">
                  <a
                    href={`/instances/${encodeURIComponent(device.instanceId)}`}
                  >
                    Open device
                  </a>
                </Button>
              ) : (
                <span className="text-sm text-muted-foreground">Offline</span>
              )}
            </div>
            {warning ? (
              <p className="text-sm text-destructive">{warning}</p>
            ) : null}
            {device.error ? (
              <p role="status" className="text-sm text-destructive">
                {device.error}
              </p>
            ) : null}
            {device.telemetry ? (
              <DeviceResources telemetry={device.telemetry} />
            ) : null}
            <ul
              className="grid gap-2"
              aria-label={`${device.displayName} workspaces`}
            >
              {device.workspaces.map((workspace) => (
                <li
                  key={workspace.root}
                  className="min-w-0 text-sm [overflow-wrap:anywhere]"
                >
                  {workspace.root}
                </li>
              ))}
            </ul>
            <ul
              className="divide-y"
              aria-label={`${device.displayName} sessions`}
            >
              {device.sessions.map((session) => {
                const task = device.tasks.find(
                  (entry) => entry.taskId === session.runningTaskId,
                );
                const key = `${device.instanceId}/${task?.taskId}`;
                return (
                  <li key={session.id} className="flex items-center gap-3 py-3">
                    {task?.cancellable ? (
                      <input
                        type="checkbox"
                        aria-label={`Select ${session.title}`}
                        checked={selected.has(key)}
                        disabled={stopping || Boolean(error)}
                        onChange={(event) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(key);
                            else next.delete(key);
                            return next;
                          })
                        }
                      />
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <a
                        className="font-medium hover:underline"
                        href={`/instances/${encodeURIComponent(device.instanceId)}?session=${encodeURIComponent(session.id)}`}
                      >
                        {session.title}
                      </a>
                      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                        {session.provider} · {session.model}
                      </p>
                    </div>
                    <span className="text-xs">{session.status}</span>
                  </li>
                );
              })}
            </ul>
            {device.failures.length ? (
              <ul
                className="grid gap-2"
                aria-label={`${device.displayName} errors`}
              >
                {device.failures.map((failure) => (
                  <li
                    key={failure.id}
                    className="text-sm text-destructive [overflow-wrap:anywhere]"
                  >
                    {failure.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>
        );
      })}
    </section>
  );
}
