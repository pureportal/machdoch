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
