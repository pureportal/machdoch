import "./analytics.js";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  InstructionManager,
  useInstructionManagement,
} from "@machdoch/client-ui/instructions";
import {
  instructionRequestSchema,
  productSnapshotSchema,
  ralphRequestSchema,
} from "@machdoch/fleet-protocol";
import {
  createFleetOperationTransport,
  useBrowserAppearance,
} from "@machdoch/product-ui";
import { api, jsonBody } from "@machdoch/product-ui/fleet-api";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { CommandProvider } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import { configureRemoteInstructionPlatform } from "../ui/instruction-management/instruction-platform";
import { instructionRuntime } from "../ui/instruction-management/instruction-runtime";
import { configureRemoteRalphPlatform } from "../ui/ralph/ralph-platform";
import {
  listInstructions,
  mutateInstructions,
  type UserInternalTaskModelSettings,
} from "../ui/runtime";
import { createRemoteTaskPlatform } from "../ui/remote-task-platform";

const parameters = new URLSearchParams(window.location.search);
const instanceId = parameters.get("instance");
if (!instanceId) throw new Error("Select a connected instance.");
const basePath = `/api/instances/${encodeURIComponent(instanceId)}/product`;
const controller = new AbortController();
const requestedWorkspace = parameters.get("workspace");
configureRemoteInstructionPlatform(
  createFleetOperationTransport((request) =>
    api(`${basePath}/instructions`, {
      method: "POST",
      body: jsonBody(instructionRequestSchema.parse(request)),
      signal: controller.signal,
    }),
  ),
);
const taskTransport = createFleetOperationTransport((request) =>
  api(`${basePath}/ralph`, {
    method: "POST",
    body: jsonBody(ralphRequestSchema.parse(request)),
    signal: controller.signal,
  }),
);
const libraryRuntime = {
  loadRegistry: listInstructions,
  mutate: mutateInstructions,
};
window.addEventListener("pagehide", () => controller.abort(), { once: true });

function FleetInstructions(): React.ReactElement {
  useBrowserAppearance();
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const setup = useInstructionManagement(workspace, libraryRuntime);
  useEffect(() => {
    let disposed = false;
    const load = async (): Promise<void> => {
      const snapshot = productSnapshotSchema.parse(
        await api(`${basePath}/snapshot`, { signal: controller.signal }),
      );
      const shell = snapshot.shell;
      const root =
        requestedWorkspace ??
        shell?.sessions.find((session) => session.id === shell.activeSessionId)
          ?.workspace ??
        shell?.composer?.workspace;
      const internalTaskModel =
        await taskTransport.invoke<UserInternalTaskModelSettings>(
          "get_user_internal_task_model_settings",
        );
      if (disposed) return;
      configureRemoteRalphPlatform(
        createRemoteTaskPlatform(snapshot, taskTransport, internalTaskModel),
      );
      setWorkspace(root ?? null);
      setReady(true);
    };
    void load().catch((cause: unknown) => {
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
        value?.type === "machdoch:instruction-workspace" &&
        (value.workspace === null || typeof value.workspace === "string")
      )
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
  return (
    <TooltipProvider delayDuration={300}>
      <CommandProvider activeView="instructions" runtime="browser">
        {error ? (
          <div role="alert" className="p-4 text-sm text-rose-300">
            {error}
          </div>
        ) : ready ? (
          <InstructionManager
            setup={setup}
            runtime={instructionRuntime}
            onDirtyChange={setDirty}
          />
        ) : (
          <div role="status" className="p-4">
            Loading instructions…
          </div>
        )}
      </CommandProvider>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<FleetInstructions />);
