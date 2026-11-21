import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./analytics.js";
import {
  productSnapshotSchema,
  type ProductSnapshot,
} from "@machdoch/fleet-protocol";
import {
  createFleetMediaTransport,
  type MediaDownloadProgress,
} from "@machdoch/media-studio/fleet-transport.js";
import { configureRemoteMediaPlatform } from "@machdoch/media-studio/tauri/ui/media/media-platform.js";
import { MediaStudio } from "@machdoch/media-studio/tauri/ui/media/media-studio.js";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { CommandProvider } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import { api, jsonBody } from "@machdoch/product-ui/fleet-api";
import { LoadingState, useBrowserAppearance } from "@machdoch/product-ui";
import { pollWhileVisible } from "@machdoch/product-ui/view-visibility";
import "../ui/styles.css";
import "./styles.css";

const instanceId = new URLSearchParams(window.location.search).get("instance");
if (!instanceId) throw new Error("Select a connected instance.");
const basePath = `/api/instances/${encodeURIComponent(instanceId)}/product`;
const downloadListeners = new Set<
  (progress: MediaDownloadProgress | null) => void
>();
configureRemoteMediaPlatform(
  createFleetMediaTransport(
    instanceId,
    (request) =>
      api(`${basePath}/media`, { method: "POST", body: jsonBody(request) }),
    (progress) => {
      for (const listener of downloadListeners) listener(progress);
    },
  ),
);

function DownloadProgress(): React.ReactElement | null {
  const [progress, setProgress] = useState<MediaDownloadProgress | null>(null);
  useEffect(() => {
    downloadListeners.add(setProgress);
    return () => {
      downloadListeners.delete(setProgress);
    };
  }, []);
  if (!progress) return null;
  const percent =
    progress.total > 0
      ? Math.floor((progress.received / progress.total) * 100)
      : 0;
  return (
    <div className="fixed right-4 bottom-4 z-50 grid w-72 max-w-[calc(100vw-2rem)] gap-2 rounded-xl border border-slate-800 bg-slate-950/95 p-3 text-xs text-slate-200 shadow-xl"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate" title={progress.name}>
          {progress.name}
        </span>
        <span className="tabular-nums text-slate-400">{percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={`Downloading ${progress.name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1 overflow-hidden rounded-full bg-slate-800"
      >
        <div
          className="h-full rounded-full bg-sky-500 transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

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
    const stop = pollWhileVisible(async () => {
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
      }
    }, 5_000);
    return () => {
      controller.abort();
      stop();
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
          <LoadingState label="Loading Media Studio…" />
        )}
        <DownloadProgress />
      </CommandProvider>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<FleetMediaStudio />);
