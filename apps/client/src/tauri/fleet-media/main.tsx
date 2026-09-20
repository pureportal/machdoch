import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  productSnapshotSchema,
  type ProductSnapshot,
} from "@machdoch/fleet-protocol";
import { createFleetMediaTransport } from "@machdoch/media-studio/fleet-transport.js";
import { configureRemoteMediaPlatform } from "@machdoch/media-studio/tauri/ui/media/media-platform.js";
import { MediaStudio } from "@machdoch/media-studio/tauri/ui/media/media-studio.js";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { CommandProvider } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import { api, jsonBody } from "@machdoch/product-ui/fleet-api";
import "../ui/styles.css";
import "./styles.css";

const instanceId = new URLSearchParams(window.location.search).get("instance");
if (!instanceId) throw new Error("Select a connected instance.");
const basePath = `/api/instances/${encodeURIComponent(instanceId)}/product`;
configureRemoteMediaPlatform(
  createFleetMediaTransport(instanceId, (request) =>
    api(`${basePath}/media`, { method: "POST", body: jsonBody(request) }),
  ),
);

function FleetMediaStudio(): React.ReactElement {
  const [snapshot, setSnapshot] = useState<ProductSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async (): Promise<void> => {
      try {
        const result = productSnapshotSchema.parse(
          await api(`${basePath}/snapshot`, { signal: controller.signal }),
        );
        if (!controller.signal.aborted) {
          setSnapshot(result);
          setError(null);
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void refresh(), 5_000);
      }
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  const shell = snapshot?.shell;
  return (
    <TooltipProvider delayDuration={300}>
      <CommandProvider activeView="media" runtime="browser">
        {error ? (
          <div role="alert" className="px-4 py-2 text-sm text-rose-300">
            {error}
          </div>
        ) : null}
        {shell ? (
          <MediaStudio
            providerStatuses={(shell.runtime?.providerStatuses ?? []).map(
              (provider) => ({
                provider: provider.provider,
                configured: provider.available,
              }),
            )}
            workspaceRoot={
              shell.sessions.find(
                (session) => session.id === shell.activeSessionId,
              )?.workspace ??
              shell.composer?.workspace ??
              null
            }
            onOpenProviderSettings={() => {
              window.top!.location.href = "/settings";
            }}
          />
        ) : (
          <div role="status" className="p-4">
            Loading Media Studio…
          </div>
        )}
      </CommandProvider>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<FleetMediaStudio />);
