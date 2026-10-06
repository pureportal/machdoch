import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  deviceSettingsRequestSchema,
  productSnapshotSchema,
  workspaceRequestSchema,
  type ProductSnapshot,
} from "@machdoch/fleet-protocol";
import {
  createFleetOperationTransport,
  useBrowserAppearance,
} from "@machdoch/product-ui";
import { api, jsonBody } from "@machdoch/product-ui/fleet-api";
import { createFleetMediaTransport } from "@machdoch/media-studio/fleet-transport.js";
import { configureRemoteMediaPlatform } from "@machdoch/media-studio/tauri/ui/media/media-platform.js";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { Dialog } from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";
import { CommandProvider } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import { configureRemoteDeviceSettingsPlatform } from "../ui/device-settings-platform";
import {
  configureRemoteWorkspacePlatform,
  getRemoteWorkspacePlatform,
} from "../ui/workspace-management/workspace-platform";
import { useChatSessionRuntime } from "../ui/chat-session/_helpers/use-chat-session-runtime";
import { createRuntimeSettingsControls } from "../ui/chat-session/_helpers/runtime-settings-controls";
import { createRuntimeVoiceSettingsControls } from "../ui/chat-session/_helpers/voice-settings-controls";
import { SettingsDialog } from "../ui/chat-session/components/settings-dialog";
import { isConfiguredModelProvider } from "../../core/runtime-contract.generated.js";
import type { SettingsSection } from "../ui/chat-session/_helpers/session-shell";
import { useRemoteVoiceSettings } from "./use-remote-voice-settings";
import { useRemoteAppearance } from "./use-remote-appearance";

const parameters = new URLSearchParams(window.location.search);
const instanceId = parameters.get("instance");
if (!instanceId) throw new Error("Select a connected instance.");
const basePath = `/api/instances/${encodeURIComponent(instanceId)}/product`;
const controller = new AbortController();
const media = createFleetMediaTransport(instanceId, (request) =>
  api(`${basePath}/media`, {
    method: "POST",
    body: jsonBody(request),
    signal: controller.signal,
  }),
);
configureRemoteMediaPlatform(media);
configureRemoteDeviceSettingsPlatform(
  createFleetOperationTransport((request) =>
    api(`${basePath}/deviceSettings`, {
      method: "POST",
      body: jsonBody(deviceSettingsRequestSchema.parse(request)),
      signal: controller.signal,
    }),
  ),
  media,
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

function DeviceSettings({
  snapshot,
}: {
  snapshot: ProductSnapshot;
}): React.ReactElement {
  const appearance = useRemoteAppearance();
  const voice = useRemoteVoiceSettings();
  const [section, setSection] = useState<SettingsSection>("providers");
  const session = snapshot.shell?.sessions.find(
    (candidate) => candidate.id === snapshot.shell?.activeSessionId,
  );
  const workspaceRoot =
    session?.workspace ?? snapshot.shell?.composer?.workspace ?? null;
  const selectedProvider = snapshot.shell?.composer?.provider;
  const runtime = useChatSessionRuntime({
    catalogOpen: true,
    activeSessionProvider:
      selectedProvider && isConfiguredModelProvider(selectedProvider)
        ? selectedProvider
        : "openai",
    activeSessionWorkspace: workspaceRoot,
  });
  const platform = getRemoteWorkspacePlatform();
  if (platform) platform.workspaceRoot = workspaceRoot;
  return (
    <>
      {(!voice.preferences || !appearance.settings) &&
      (voice.error || appearance.error) ? (
        <div role="alert" className="p-4 text-sm text-rose-300">
          {voice.error ?? appearance.error}
        </div>
      ) : null}
      {voice.preferences && appearance.settings ? (
        <Dialog open>
          <SettingsDialog
            {...createRuntimeSettingsControls(
              runtime,
              workspaceRoot,
              snapshot.shell?.sessions.map((candidate) => ({
                id: candidate.id,
                title: candidate.title,
              })) ?? [],
            )}
            error={voice.error ?? appearance.error}
            settingsSection={section}
            onSettingsSectionChange={setSection}
            onClose={() => {
              if (window.parent === window) {
                window.location.assign(
                  `/instances/${encodeURIComponent(instanceId!)}`,
                );
                return;
              }
              window.parent.postMessage(
                { type: "machdoch:close-settings" },
                window.location.origin,
              );
            }}
            appearanceSetup={{
              settings: appearance.settings,
              saving: appearance.saving,
              onSave: appearance.save,
            }}
            voiceSetup={createRuntimeVoiceSettingsControls(
              runtime,
              voice.preferences,
              {
                onAutoSpeakResponsesChange: (autoSpeakResponses) =>
                  voice.save({ autoSpeakResponses }),
                onPreferredVoiceChange: (preferredVoiceURI) =>
                  voice.save({ preferredVoiceURI }),
                onRateChange: (rate) => voice.save({ rate }),
                onRefreshSpeechInputDevices: voice.refreshDevices,
              },
            )}
          />
        </Dialog>
      ) : (
        <div role="status" className="p-4">
          Loading settings…
        </div>
      )}
    </>
  );
}

function FleetSettings(): React.ReactElement {
  useBrowserAppearance();
  const [snapshot, setSnapshot] = useState<ProductSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api(`${basePath}/snapshot`, { signal: controller.signal })
      .then((value) => {
        const snapshot = productSnapshotSchema.parse(value);
        if (!snapshot.shell)
          throw new Error(
            "The device settings are not ready. Reopen settings after the client connects.",
          );
        setSnapshot(snapshot);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, []);
  return (
    <TooltipProvider delayDuration={300}>
      <CommandProvider activeView="settings" runtime="browser">
        {error ? (
          <div role="alert" className="p-4 text-sm text-rose-300">
            {error}
          </div>
        ) : snapshot ? (
          <DeviceSettings snapshot={snapshot} />
        ) : (
          <div role="status" className="p-4">
            Loading settings…
          </div>
        )}
      </CommandProvider>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<FleetSettings />);
