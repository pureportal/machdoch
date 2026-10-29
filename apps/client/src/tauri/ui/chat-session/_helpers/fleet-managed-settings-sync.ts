import type { FleetManagedSettingsDocument } from "@machdoch/fleet-protocol";
import {
  canUseTauriStore,
  getCurrentShellWindowLabel,
} from "@machdoch/media-studio/tauri/ui/lib/_helpers/shell-store-storage.helper.js";

const SYNC_REQUEST_EVENT = "machdoch:fleet-managed-settings-sync-request";

export function requestFleetManagedSettingsSync(): void {
  window.dispatchEvent(new Event(SYNC_REQUEST_EVENT));
}

export function subscribeToFleetManagedSettingsSyncRequests(
  listener: () => void,
): () => void {
  window.addEventListener(SYNC_REQUEST_EVENT, listener);
  return () => window.removeEventListener(SYNC_REQUEST_EVENT, listener);
}

/** Device-settings actions served by the main window's managed settings sync. */
export interface FleetDeviceSettingsHandler {
  /** Uploads the device baseline now; false when the cloud predates snapshots. */
  uploadSnapshot: () => Promise<boolean>;
  /** The device's own settings, excluding anything delivered by the cloud. */
  exportLocalSettings: () => Promise<FleetManagedSettingsDocument>;
}

let deviceSettingsHandler: FleetDeviceSettingsHandler | null = null;

export function registerFleetDeviceSettingsHandler(
  handler: FleetDeviceSettingsHandler,
): () => void {
  deviceSettingsHandler = handler;
  return () => {
    if (deviceSettingsHandler === handler) deviceSettingsHandler = null;
  };
}

const requireHandler = (): FleetDeviceSettingsHandler => {
  if (deviceSettingsHandler) return deviceSettingsHandler;
  // Only the main window synchronizes managed settings.
  throw new Error(
    canUseTauriStore() && getCurrentShellWindowLabel() !== "main"
      ? "Device settings are managed in the main machdoch window."
      : "Device settings are still loading. Try again shortly.",
  );
};

export const uploadFleetDeviceSettings = (): Promise<boolean> =>
  requireHandler().uploadSnapshot();

export const exportFleetDeviceSettings =
  (): Promise<FleetManagedSettingsDocument> =>
    requireHandler().exportLocalSettings();
