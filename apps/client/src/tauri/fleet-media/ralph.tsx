import "./analytics.js";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  productSnapshotSchema,
  ralphRequestSchema,
  type ProductSnapshot,
} from "@machdoch/fleet-protocol";
import {
  createFleetOperationTransport,
  useBrowserAppearance,
} from "@machdoch/product-ui";
import { createFleetMediaTransport } from "@machdoch/media-studio/fleet-transport.js";
import { configureRemoteMediaPlatform } from "@machdoch/media-studio/tauri/ui/media/media-platform.js";
import { api, jsonBody } from "@machdoch/product-ui/fleet-api";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { CommandProvider } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import { RalphApp } from "../ui/ralph/ralph-app";
import {
  configureRemoteRalphPlatform,
  type RemoteRalphPlatform,
} from "../ui/ralph/ralph-platform";
import { configureRalphSettingsStorage } from "../ui/lib/shell-store";
import { isConfiguredModelProvider } from "../../core/runtime-contract.generated.js";
import { createRemoteTaskPlatform } from "../ui/remote-task-platform";
import type { UserInternalTaskModelSettings } from "../ui/runtime";

const instanceId = new URLSearchParams(window.location.search).get("instance");
if (!instanceId) throw new Error("Select a connected instance.");
const basePath = `/api/instances/${encodeURIComponent(instanceId)}/product`;

function FleetRalph(): React.ReactElement {
  useBrowserAppearance();
  const [snapshot, setSnapshot] = useState<ProductSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const platform = useRef<RemoteRalphPlatform | null>(null);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () =>
      api(`${basePath}/snapshot`, { signal: controller.signal })
        .then(async (value) => {
          if (cancelled) return;
          const result = productSnapshotSchema.parse(value);
          const composer = result.shell?.composer;
          if (!result.shell?.ralph?.editorAvailable)
            throw new Error("Update this device to edit RALPH flows.");
          if (!composer || !isConfiguredModelProvider(composer.provider))
            throw new Error(
              "Choose a model on the device before opening RALPH.",
            );
          const transport =
            platform.current ??
            createFleetOperationTransport((request) =>
              api(`${basePath}/ralph`, {
                method: "POST",
                body: jsonBody(ralphRequestSchema.parse(request)),
                signal: controller.signal,
              }),
            );
          const internalTaskModel =
            await transport.invoke<UserInternalTaskModelSettings>(
              "get_user_internal_task_model_settings",
            );
          if (cancelled) return;
          if (!platform.current)
            configureRemoteMediaPlatform(
              createFleetMediaTransport(instanceId!, (request) =>
                api(`${basePath}/media`, {
                  method: "POST",
                  body: jsonBody(request),
                  signal: controller.signal,
                }),
              ),
            );
          const updated = createRemoteTaskPlatform(
            result,
            transport,
            internalTaskModel,
          );
          if (platform.current) Object.assign(platform.current, updated);
          else {
            platform.current = updated;
            configureRemoteRalphPlatform(updated);
            configureRalphSettingsStorage(instanceId!);
          }
          setSnapshot(result);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (!cancelled)
            setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          if (!cancelled) timer = setTimeout(() => void refresh(), 5_000);
        });
    void refresh();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  const shell = snapshot?.shell;
  const composer = shell?.composer;
  return (
    <TooltipProvider delayDuration={300}>
      <CommandProvider activeView="ralph" runtime="browser">
        {error ? (
          <div role="alert" className="px-4 py-2 text-sm text-rose-300">
            {error}
          </div>
        ) : null}
        {shell && composer && isConfiguredModelProvider(composer.provider) ? (
          <RalphApp
            isActive
            providerStatuses={platform.current?.providers}
            modelCatalog={platform.current?.catalog}
            initialSettings={{
              workspaceRoot:
                shell.ralph?.workspaceRoot ?? composer.workspace ?? null,
              generationProvider: composer.provider,
              generationModel: composer.model,
              generationReasoning: composer.reasoning,
              runProvider: composer.provider,
              runModel: composer.model,
              runReasoning: composer.reasoning,
            }}
            workspaceRoots={[
              ...new Set(
                [
                  shell.ralph?.workspaceRoot,
                  ...shell.sessions.map((session) => session.workspace),
                  ...shell.workspaces.map((workspace) => workspace.root),
                  ...(shell.projectLibrary?.projects
                    .filter((project) => project.status === "ready")
                    .map((project) => project.workspace) ?? []),
                ].filter((workspace): workspace is string =>
                  Boolean(workspace),
                ),
              ),
            ]}
          />
        ) : !error ? (
          <div role="status" className="p-4">
            Loading RALPH…
          </div>
        ) : null}
      </CommandProvider>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<FleetRalph />);
