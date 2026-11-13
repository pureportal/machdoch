import { McpAppsSettings } from "@machdoch/client-ui/mcp-apps/settings";
import "./analytics.js";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  deviceSettingsRequestSchema,
  productSnapshotSchema,
  workspaceRequestSchema,
} from "@machdoch/fleet-protocol";
import {
  createFleetOperationTransport,
  LoadingState,
  useBrowserAppearance,
} from "@machdoch/product-ui";
import { api, jsonBody } from "@machdoch/product-ui/fleet-api";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { CommandProvider } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import { configureRemoteDeviceSettingsPlatform } from "../ui/device-settings-platform";
import {
  configureRemoteWorkspacePlatform,
  getRemoteWorkspacePlatform,
  invokeWorkspaceTools,
} from "../ui/workspace-management/workspace-platform";
import { McpManager } from "../ui/mcp-management/mcp-manager";

const parameters = new URLSearchParams(window.location.search);
const instanceId = parameters.get("instance");
if (!instanceId) throw new Error("Select a connected instance.");
const basePath = `/api/instances/${encodeURIComponent(instanceId)}/product`;
const controller = new AbortController();
configureRemoteDeviceSettingsPlatform(
  createFleetOperationTransport((request) =>
    api(`${basePath}/deviceSettings`, {
      method: "POST",
      body: jsonBody(deviceSettingsRequestSchema.parse(request)),
      signal: controller.signal,
    }),
  ),
);
configureRemoteWorkspacePlatform(
  createFleetOperationTransport((request) =>
    api(`${basePath}/workspace`, {
      method: "POST",
      body: jsonBody(workspaceRequestSchema.parse(request)),
      signal: controller.signal,
    }),
  ),
  async () => {
    throw new Error("Open previews from Workspaces.");
  },
);
window.addEventListener(
  "pagehide",
  () => {
    controller.abort();
    void getRemoteWorkspacePlatform()?.dispose();
  },
  { once: true },
);

const selectWorkspace = (workspaceRoot: string | null): void => {
  const platform = getRemoteWorkspacePlatform();
  if (platform) platform.workspaceRoot = workspaceRoot;
};

function FleetMcp(): React.ReactElement {
  useBrowserAppearance();
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [libraryMode, setLibraryMode] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let disposed = false;
    void api(`${basePath}/snapshot`, { signal: controller.signal })
      .then((value) => {
        const shell = productSnapshotSchema.parse(value).shell;
        if (disposed) return;
        const root =
          shell?.sessions.find(
            (session) => session.id === shell.activeSessionId,
          )?.workspace ??
          shell?.composer?.workspace ??
          null;
        selectWorkspace(root);
        setWorkspace(root);
        setLibraryMode(shell?.workspaceToolsMode === "library");
        setReady(true);
      })
      .catch((cause: unknown) => {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    const receiveWorkspace = (event: MessageEvent): void => {
      if (
        event.source !== window.parent ||
        event.origin !== window.location.origin
      )
        return;
      const value = event.data as {
        type?: unknown;
        workspace?: unknown;
      } | null;
      if (
        value?.type === "machdoch:mcp-workspace" &&
        (value.workspace === null || typeof value.workspace === "string")
      ) {
        selectWorkspace(value.workspace);
        setWorkspace(value.workspace);
      }
    };
    window.addEventListener("message", receiveWorkspace);
    return () => window.removeEventListener("message", receiveWorkspace);
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  return (
    <TooltipProvider delayDuration={300}>
      <CommandProvider activeView="mcp" runtime="browser">
        {error ? (
          <div role="alert" className="p-4 text-sm text-rose-300">
            {error}
          </div>
        ) : ready && libraryMode ? (
          <div className="p-4">
            <McpAppsSettings
              invoke={(workspaceRoot, input) =>
                invokeWorkspaceTools("run_mcp_app_command", {
                  workspaceRoot,
                  input,
                })
              }
            />
          </div>
        ) : ready ? (
          <McpManager workspaceRoot={workspace} onDirtyChange={setDirty} />
        ) : (
          <LoadingState label="Loading MCP servers…" />
        )}
      </CommandProvider>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<FleetMcp />);
