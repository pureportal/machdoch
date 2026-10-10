import "./analytics.js";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  SchedulerPanel,
  type SchedulerRuntime,
} from "@machdoch/client-ui/scheduler";
import {
  productSnapshotSchema,
  schedulerRequestSchema,
} from "@machdoch/fleet-protocol";
import {
  createFleetOperationTransport,
  useBrowserAppearance,
} from "@machdoch/product-ui";
import { api, jsonBody } from "@machdoch/product-ui/fleet-api";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { CommandProvider } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import { schedulerRuntime } from "../ui/scheduler/scheduler-runtime";
import { configureRemoteSchedulerPlatform } from "../ui/scheduler/scheduler-platform";

const instanceId = new URLSearchParams(window.location.search).get("instance");
if (!instanceId) throw new Error("Select a connected instance.");
const basePath = `/api/instances/${encodeURIComponent(instanceId)}/product`;
const requestedWorkspace = new URLSearchParams(window.location.search).get(
  "workspace",
);
const controller = new AbortController();
const commandScope = { kind: "view" as const, ownerId: "scheduler" };
configureRemoteSchedulerPlatform(
  createFleetOperationTransport((request) =>
    api(`${basePath}/scheduler`, {
      method: "POST",
      body: jsonBody(schedulerRequestSchema.parse(request)),
      signal: controller.signal,
    }),
  ),
);
window.addEventListener("pagehide", () => controller.abort(), { once: true });

function FleetScheduler(): React.ReactElement {
  useBrowserAppearance();
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runtime = useMemo<SchedulerRuntime>(() => {
    const {
      subscribeToSettingsImport: _subscribeToSettingsImport,
      ...operations
    } = schedulerRuntime;
    return operations;
  }, []);
  useEffect(() => {
    let disposed = false;
    api(`${basePath}/snapshot`, { signal: controller.signal })
      .then((value) => {
        if (disposed) return;
        const snapshot = productSnapshotSchema.parse(value);
        const shell = snapshot.shell;
        const root =
          requestedWorkspace ??
          shell?.composer?.workspace ??
          shell?.scheduler?.workspaceRoot ??
          shell?.sessions.find(
            (session) => session.id === shell.activeSessionId,
          )?.workspace;
        if (!root)
          throw new Error("Select a workspace before managing scheduled jobs.");
        setWorkspace(root);
      })
      .catch((cause: unknown) => {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      disposed = true;
    };
  }, []);
  return (
    <TooltipProvider delayDuration={300}>
      <CommandProvider activeView="scheduler" runtime="browser">
        {error ? (
          <div role="alert" className="p-4 text-sm text-rose-300">
            {error}
          </div>
        ) : workspace ? (
          <SchedulerPanel
            workspaceRoot={workspace}
            runtime={runtime}
            commandScope={commandScope}
          />
        ) : (
          <div role="status" className="p-4">
            Loading Scheduler…
          </div>
        )}
      </CommandProvider>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<FleetScheduler />);
