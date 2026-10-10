import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./analytics.js";
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
import { useBrowserAppearance } from "@machdoch/product-ui";
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
  useBrowserAppearance();
  const [snapshot, setSnapshot] = useState<ProductSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openSection, setOpenSection] = useState<"library" | "generate" | null>(
    null,
  );
  const [draftPrompt, setDraftPrompt] = useState<string | null>(null);
  const receivedRequest = useRef<string | null>(null);
  useEffect(() => {
    const receive = (event: MessageEvent): void => {
      if (
        event.origin !== window.location.origin ||
        event.source !== window.parent
      )
        return;
      const data = event.data as {
        type?: unknown;
        id?: unknown;
        section?: unknown;
        prompt?: unknown;
      } | null;
      if (
        data?.type !== "machdoch:media-compose" ||
        typeof data.id !== "string" ||
        data.id.length > 128 ||
        !data.id ||
        (data.section !== "library" && data.section !== "generate") ||
        (data.prompt !== undefined &&
          (typeof data.prompt !== "string" || data.prompt.length > 8_000))
      )
        return;
      if (receivedRequest.current !== data.id) {
        receivedRequest.current = data.id;
        setOpenSection(data.section);
        setDraftPrompt(typeof data.prompt === "string" ? data.prompt : null);
      }
      window.parent.postMessage(
        { type: "machdoch:media-compose-received", id: data.id },
        window.location.origin,
      );
    };
    window.addEventListener("message", receive);
    window.parent.postMessage(
      { type: "machdoch:media-ready" },
      window.location.origin,
    );
    return () => window.removeEventListener("message", receive);
  }, []);
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
            openSection={openSection}
            onOpenSectionHandled={() => setOpenSection(null)}
            draftPrompt={draftPrompt}
            onDraftPromptHandled={() => setDraftPrompt(null)}
            onOpenPoseChat={(map) => {
              window.parent.postMessage(
                { type: "machdoch:pose-chat", map },
                window.location.origin,
              );
            }}
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
              window.parent.postMessage(
                { type: "machdoch:open-settings" },
                window.location.origin,
              );
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
