"use client";

import { LoadingState } from "@machdoch/product-ui";
import { useState } from "react";
import { FolderTree, Plus, RefreshCw, Search, X } from "lucide-react";
import { cancelFleetTasks } from "@/lib/cancel-fleet-tasks";
import {
  canOpenSessions,
  type FleetSessionTarget,
} from "@/lib/fleet-session-routing";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { DeviceWorkspaces } from "./device-workspaces";
import { NewSessionDialog } from "./new-session-dialog";
import { useFleetStatus } from "./use-fleet-status";
import { useOpenFleetSession } from "./use-open-fleet-session";
import { overviewDevices } from "./workspace-overview";

export function WorkspacesView(): React.ReactElement {
  const { status, loading, error, refresh } = useFleetStatus();
  const openSession = useOpenFleetSession();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [starting, setStarting] = useState<FleetSessionTarget | null>(null);
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const [commandError, setCommandError] = useState<string | null>(null);
  const allDevices = status?.devices ?? [];
  const launchable = allDevices.filter(canOpenSessions);
  const devices = overviewDevices(allDevices, query);

  const startSession = async (target: FleetSessionTarget): Promise<void> => {
    setStarting(target);
    setCommandError(null);
    try {
      await openSession([target]);
    } catch (reason) {
      setCommandError((reason as Error).message);
    } finally {
      setStarting(null);
    }
  };

  const stopTask = async (instanceId: string, taskId: string) => {
    const device = allDevices.find((entry) => entry.instanceId === instanceId);
    if (!device) return;
    setStopping((current) => new Set(current).add(taskId));
    setCommandError(null);
    const [result] = await cancelFleetTasks([
      { instanceId, displayName: device.displayName, taskId },
    ]);
    if (result?.error) setCommandError(result.error);
    setStopping((current) => {
      const next = new Set(current);
      next.delete(taskId);
      return next;
    });
    await refresh();
  };

  return (
    <section className="grid gap-5">
      <PageHeader title="Workspaces">
        <Button
          variant="outline"
          size="icon"
          disabled={loading}
          onClick={() => void refresh()}
          aria-label="Refresh"
          title="Refresh"
        >
          <RefreshCw className={cn(loading && "motion-safe:animate-spin")} />
        </Button>
        {launchable.length ? (
          <Button onClick={() => setCreating(true)}>
            <Plus />
            New session
          </Button>
        ) : null}
      </PageHeader>
      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm"
        >
          <p className="min-w-0 flex-1 text-destructive">
            {error}
            {status ? " Showing the last known status." : ""}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => void refresh()}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {commandError ? (
        <p
          role="alert"
          className="whitespace-pre-wrap rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {commandError}
        </p>
      ) : null}
      {allDevices.length ? (
        <div className="relative max-w-md">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label="Search workspaces and sessions"
            placeholder="Search workspaces and sessions"
            className="pl-9 pr-9"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-0 top-1/2 -translate-y-1/2"
              aria-label="Clear search"
              onClick={() => setQuery("")}
            >
              <X />
            </Button>
          ) : null}
        </div>
      ) : null}
      {!status && loading ? (
        <LoadingState label="Loading workspaces…" />
      ) : !status ? (
        <p
          role="status"
          className="grid min-h-60 place-items-center rounded-xl border text-sm text-muted-foreground"
        >
          Workspaces could not be loaded.
        </p>
      ) : !allDevices.length ? (
        <div className="grid min-h-60 content-center justify-items-center gap-3 rounded-xl border text-center">
          <span className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary">
            <FolderTree className="size-5" aria-hidden="true" />
          </span>
          <p className="text-sm font-medium">No devices connected</p>
          <Button asChild variant="outline" size="sm">
            <a href="/instances">Add a device</a>
          </Button>
        </div>
      ) : !devices.length ? (
        <p
          role="status"
          className="rounded-xl border px-4 py-10 text-center text-sm text-muted-foreground"
        >
          No matching workspaces or sessions.
        </p>
      ) : (
        devices.map((overview) => (
          <DeviceWorkspaces
            key={overview.device.instanceId}
            overview={overview}
            managerVersion={status.managerVersion}
            filtered={Boolean(query.trim())}
            startingWorkspace={
              starting?.instanceId === overview.device.instanceId
                ? starting.workspace
                : null
            }
            startDisabled={starting !== null}
            stoppingTasks={stopping}
            onStartSession={(workspace) =>
              void startSession({
                instanceId: overview.device.instanceId,
                workspace,
              })
            }
            onStopTask={(taskId) =>
              void stopTask(overview.device.instanceId, taskId)
            }
          />
        ))
      )}
      <NewSessionDialog
        open={creating}
        onOpenChange={setCreating}
        devices={launchable}
        onStart={openSession}
      />
    </section>
  );
}
