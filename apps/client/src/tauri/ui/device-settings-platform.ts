import { invoke, isTauri } from "@tauri-apps/api/core";
import type { FleetOperationTransport } from "@machdoch/product-ui/fleet-operation-transport";
import type { FleetMediaTransport } from "@machdoch/media-studio/fleet-transport.js";

let remotePlatform: FleetOperationTransport | null = null;
let remoteFiles: Pick<
  FleetMediaTransport,
  "open" | "save" | "download" | "release" | "fileName"
> | null = null;

export function configureRemoteDeviceSettingsPlatform(
  platform: FleetOperationTransport,
  files?: Pick<
    FleetMediaTransport,
    "open" | "save" | "download" | "release" | "fileName"
  >,
): void {
  remotePlatform = platform;
  remoteFiles = files ?? null;
}

export function getRemoteDeviceSettingsPlatform(): FleetOperationTransport | null {
  return remotePlatform;
}

export function getRemoteDeviceSettingsFiles(): NonNullable<
  typeof remoteFiles
> {
  if (!remoteFiles)
    throw new Error("File transfer is not connected. Reopen settings.");
  return remoteFiles;
}

export function canUseDeviceSettings(): boolean {
  return remotePlatform !== null || isTauri();
}

export function invokeDeviceSettingsCommand<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return remotePlatform
    ? remotePlatform.invoke<T>(command, args)
    : invoke<T>(command, args);
}
