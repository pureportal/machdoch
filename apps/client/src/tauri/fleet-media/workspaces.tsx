import "./analytics.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  productCommandSchema,
  productSnapshotSchema,
  workspaceRequestSchema,
  instructionRequestSchema,
  ralphRequestSchema,
  type ProductCommand,
  type ProductSnapshot,
} from "@machdoch/fleet-protocol";
import {
  createFleetOperationTransport,
  useBrowserAppearance,
} from "@machdoch/product-ui";
import { api, jsonBody } from "@machdoch/product-ui/fleet-api";
import {
  createWorkspaceInstructionLifecycle,
  useInstructionManagement,
} from "@machdoch/client-ui/instructions";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { CommandProvider } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import { WorkspaceManager } from "../ui/workspace-management/workspace-manager";
import {
  configureRemoteWorkspacePlatform,
  getRemoteWorkspacePlatform,
} from "../ui/workspace-management/workspace-platform";
import type { WorkspaceManagementControls } from "../ui/workspace-management/types";
import { createWorkspaceRootKey } from "../ui/workspace-management/workspace-management-model";
import { configureRemoteInstructionPlatform } from "../ui/instruction-management/instruction-platform";
import { configureRemoteRalphPlatform } from "../ui/ralph/ralph-platform";
import { createRemoteTaskPlatform } from "../ui/remote-task-platform";
import {
  listInstructions,
  mutateInstructions,
  loadWorkspaceMemoryEntries,
  forgetWorkspaceMemoryEntry,
  type UserInternalTaskModelSettings,
  type UserMemorySettings,
} from "../ui/runtime";
import { useRemoteWorkspacePicker } from "./use-remote-workspace-picker";

const parameters = new URLSearchParams(window.location.search);
const instanceId = parameters.get("instance");
if (!instanceId) throw new Error("Select a connected instance.");
const basePath = `/api/instances/${encodeURIComponent(instanceId)}/product`;
const workspaceTransport = createFleetOperationTransport((request) =>
  api(`${basePath}/workspace`, {
    method: "POST",
    body: jsonBody(workspaceRequestSchema.parse(request)),
    keepalive:
      request.kind === "invoke" &&
      request.command === "stop_workspace_terminal",
  }),
);
configureRemoteWorkspacePlatform(
  workspaceTransport,
  async (workspaceRoot, configurationId, url) => {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol))
      throw new Error("Use an HTTP or HTTPS preview URL.");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
      window.open(parsed.href, "_blank", "noopener,noreferrer");
      return;
    }
    const popup = window.open("about:blank", "_blank");
    if (!popup) throw new Error("Allow pop-ups to open the preview.");
    popup.opener = null;
    try {
      const launch = await api<{ url: string }>(
        `/api/instances/${encodeURIComponent(instanceId)}/previews`,
        {
          method: "POST",
          body: jsonBody({
            target: {
              workspace: workspaceRoot,
              configurationId,
              port: Number(parsed.port),
            },
            path: parsed.pathname + parsed.search,
          }),
        },
      );
      popup.location.replace(new URL(launch.url, window.location.origin).href);
    } catch (error) {
      popup.close();
      throw error;
    }
  },
);
configureRemoteInstructionPlatform(
  createFleetOperationTransport((request) =>
    api(`${basePath}/instructions`, {
      method: "POST",
      body: jsonBody(instructionRequestSchema.parse(request)),
    }),
  ),
);
const taskTransport = createFleetOperationTransport((request) =>
  api(`${basePath}/ralph`, {
    method: "POST",
    body: jsonBody(ralphRequestSchema.parse(request)),
  }),
);
const libraryRuntime = {
  loadRegistry: listInstructions,
  mutate: mutateInstructions,
};
const selectWorkspace = (workspaceRoot: string | null): void => {
  const platform = getRemoteWorkspacePlatform();
  if (platform) platform.workspaceRoot = workspaceRoot;
};
window.addEventListener(
  "pagehide",
  () => void getRemoteWorkspacePlatform()?.dispose(),
  { once: true },
);

function FleetWorkspaces(): React.ReactElement {
  useBrowserAppearance();
  const [workspace, setWorkspace] = useState<string | null>(
    parameters.get("workspace"),
  );
  const [snapshot, setSnapshot] = useState<ProductSnapshot | null>(null);
  const [memorySettings, setMemorySettings] = useState<
    (UserMemorySettings & { workspaceDefaultEnabled: boolean }) | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const stateRef = useRef({ workspace, dirty });
  stateRef.current = { workspace, dirty };
  const setup = useInstructionManagement(workspace, {
    ...libraryRuntime,
    ...createWorkspaceInstructionLifecycle({
      stopTerminals: async (root) => {
        const { disposeWorkspaceTerminals } =
          await import("../ui/workspace-management/workspace-terminal-store");
        await disposeWorkspaceTerminals(root);
        await workspaceTransport.invoke("stop_all_workspace_terminals", {
          workspaceRoot: root,
        });
      },
      relinkWorkspace: (root, destinationWorkspace) =>
        mutateWorkspace({
          kind: "relink-workspace",
          workspace: root,
          destinationWorkspace,
        }),
    }),
  });
  const picker = useRemoteWorkspacePicker();
  const loadSnapshot = useCallback(async (): Promise<ProductSnapshot> => {
    const value = productSnapshotSchema.parse(
      await api(`${basePath}/snapshot`),
    );
    setSnapshot((current) =>
      current && current.eventId > value.eventId ? current : value,
    );
    return value;
  }, []);
  useEffect(() => {
    let disposed = false;
    const initialize = async (): Promise<void> => {
      const [value, settings, model] = await Promise.all([
        loadSnapshot(),
        workspaceTransport.invoke<UserMemorySettings>(
          "get_user_memory_settings",
        ),
        taskTransport.invoke<UserInternalTaskModelSettings>(
          "get_user_internal_task_model_settings",
        ),
      ]);
      if (disposed) return;
      if (typeof settings.workspaceDefaultEnabled !== "boolean")
        throw new Error(
          "Workspace memory settings could not be loaded. Refresh and try again.",
        );
      configureRemoteRalphPlatform(
        createRemoteTaskPlatform(value, taskTransport, model),
      );
      setMemorySettings({
        ...settings,
        workspaceDefaultEnabled: settings.workspaceDefaultEnabled,
      });
      const shell = value.shell;
      const activeRoot =
        shell?.sessions.find((session) => session.id === shell.activeSessionId)
          ?.workspace ??
        shell?.composer?.workspace ??
        shell?.workspaces[0]?.root ??
        null;
      setWorkspace((current) => current ?? activeRoot);
      setReady(true);
    };
    void initialize().catch((cause: unknown) => {
      if (!disposed)
        setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      disposed = true;
    };
  }, [loadSnapshot]);
  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async (): Promise<void> => {
      try {
        await loadSnapshot();
        if (!disposed) setError(null);
      } catch (cause) {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : String(cause));
      }
      if (!disposed) timer = setTimeout(() => void refresh(), 2000);
    };
    timer = setTimeout(() => void refresh(), 2000);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [loadSnapshot, ready]);
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
        value?.type !== "machdoch:workspace-tools-workspace" ||
        !(value.workspace === null || typeof value.workspace === "string")
      )
        return;
      if (
        stateRef.current.dirty &&
        !window.confirm("Discard your unsaved changes?")
      )
        return;
      setWorkspace(value.workspace);
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
  const mutateWorkspace = async (
    command: Extract<
      ProductCommand,
      { kind: "add-workspace" | "remove-workspace" | "relink-workspace" }
    >,
  ): Promise<void> => {
    setBusy(true);
    try {
      await api(`${basePath}/commands`, {
        method: "POST",
        body: jsonBody(
          productCommandSchema.parse({
            ...command,
            commandId: crypto.randomUUID(),
          }),
        ),
      });
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const value = await loadSnapshot();
        const roots =
          value.shell?.workspaces.map((entry) =>
            createWorkspaceRootKey(entry.root),
          ) ?? [];
        const applied =
          command.kind === "add-workspace"
            ? roots.includes(createWorkspaceRootKey(command.workspace))
            : command.kind === "remove-workspace"
              ? !roots.includes(createWorkspaceRootKey(command.workspace))
              : !roots.includes(createWorkspaceRootKey(command.workspace)) &&
                roots.includes(
                  createWorkspaceRootKey(command.destinationWorkspace),
                );
        if (applied) return;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      throw new Error(
        "The device has not applied the workspace change. Refresh and try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  const workspaceSetup: WorkspaceManagementControls | null = memorySettings
    ? {
        workspaceRoots:
          snapshot?.shell?.workspaces.map((entry) => entry.root) ?? [],
        memorySourceSessions:
          snapshot?.shell?.sessions.map((session) => ({
            id: session.id,
            title: session.title,
          })) ?? [],
        workspaceMemoryDefaultEnabled: memorySettings.workspaceDefaultEnabled,
        loading: busy,
        onAdd: (root) =>
          mutateWorkspace({ kind: "add-workspace", workspace: root }),
        onRemove: (root) =>
          mutateWorkspace({ kind: "remove-workspace", workspace: root }),
        onRelink: (root, destination) =>
          mutateWorkspace({
            kind: "relink-workspace",
            workspace: root,
            destinationWorkspace: destination,
          }),
        onLoadMemory: loadWorkspaceMemoryEntries,
        onForgetMemory: forgetWorkspaceMemoryEntry,
        onConfigurationChanged: async () => {
          await loadSnapshot();
        },
      }
    : null;
  return (
    <TooltipProvider delayDuration={300}>
      <CommandProvider activeView="workspaces" runtime="browser">
        {error ? (
          <div role="alert" className="p-4 text-sm text-rose-300">
            {error}
          </div>
        ) : null}
        {ready && workspaceSetup ? (
          <WorkspaceManager
            setup={setup}
            workspaceSetup={workspaceSetup}
            activeWorkspaceRoot={workspace}
            onDirtyChange={setDirty}
            onChooseDirectory={picker.chooseDirectory}
            onSelectedWorkspaceChange={selectWorkspace}
          />
        ) : !error ? (
          <div role="status" className="p-4">
            Loading workspaces…
          </div>
        ) : null}
        {picker.dialog}
      </CommandProvider>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<FleetWorkspaces />);
