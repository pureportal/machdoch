import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const SETTINGS_TRANSFER_EVENT =
  "machdoch://settings-transfer-state" as const;
export const SETTINGS_IMPORTED_EVENT = "machdoch://settings-imported" as const;

import type {
  SettingsTransferStatus,
  SettingsImportEvent,
  StartSettingsTransferRequest,
  ExportEncryptedSettingsFileRequest,
  EncryptedSettingsFileExportResult,
  InspectEncryptedSettingsFileRequest,
  EncryptedSettingsFileImportReview,
  EncryptedSettingsFileImportResult,
} from "../../shared/settings-transfer.js";
export type {
  SettingsCategoryId,
  SettingsTransferMode,
  SettingsTransferPhase,
  CategoryAvailability,
  CategoryEffect,
  SettingsTransferCategory,
  SettingsTransferNetworkInterface,
  DiscoveredTransferSession,
  SettingsTransferStatus,
  SettingsImportEvent,
  StartSettingsTransferRequest,
  ExportEncryptedSettingsFileRequest,
  EncryptedSettingsFileExportResult,
  InspectEncryptedSettingsFileRequest,
  EncryptedSettingsFileImportReview,
  EncryptedSettingsFileImportResult,
} from "../../shared/settings-transfer.js";
export { isActiveTransferPhase } from "../../shared/settings-transfer.js";

export const getSettingsTransferCatalog =
  async (): Promise<SettingsTransferStatus> =>
    invoke<SettingsTransferStatus>("get_settings_transfer_catalog");

export const startSettingsTransfer = async (
  request: StartSettingsTransferRequest,
): Promise<SettingsTransferStatus> =>
  invoke<SettingsTransferStatus>("start_settings_transfer", { request });

export const startSettingsReceive = async (
  request: StartSettingsTransferRequest,
): Promise<SettingsTransferStatus> =>
  invoke<SettingsTransferStatus>("start_settings_receive", { request });

export const connectDiscoveredSettingsTransfer = async (
  discoveredId: string,
): Promise<void> =>
  invoke("connect_settings_transfer", {
    request: { discoveredId, manualCode: null },
  });

export const connectManualSettingsTransfer = async (
  manualCode: string,
): Promise<void> =>
  invoke("connect_settings_transfer", {
    request: { discoveredId: null, manualCode },
  });

export const confirmSettingsTransferPairing = async (): Promise<void> =>
  invoke("confirm_settings_transfer_pairing");

export const approveSettingsTransfer = async (): Promise<void> =>
  invoke("approve_settings_transfer");

export const stopSettingsTransfer = async (): Promise<SettingsTransferStatus> =>
  invoke<SettingsTransferStatus>("stop_settings_transfer");

export const exportEncryptedSettingsFile = async (
  request: ExportEncryptedSettingsFileRequest,
): Promise<EncryptedSettingsFileExportResult> =>
  invoke<EncryptedSettingsFileExportResult>("export_encrypted_settings_file", {
    request,
  });

export const inspectEncryptedSettingsFile = async (
  request: InspectEncryptedSettingsFileRequest,
): Promise<EncryptedSettingsFileImportReview> =>
  invoke<EncryptedSettingsFileImportReview>("inspect_encrypted_settings_file", {
    request,
  });

export const commitEncryptedSettingsFileImport = async (
  token: string,
): Promise<EncryptedSettingsFileImportResult> =>
  invoke<EncryptedSettingsFileImportResult>(
    "commit_encrypted_settings_file_import",
    { request: { token } },
  );

export const cancelEncryptedSettingsFileImport = async (
  operationId: string,
): Promise<boolean> =>
  invoke<boolean>("cancel_encrypted_settings_file_import", {
    request: { operationId },
  });

export const subscribeToSettingsTransfer = async (
  onChange: (status: SettingsTransferStatus) => void,
): Promise<() => void> => {
  if (!canSubscribeToTauriEvents()) return () => undefined;
  return listen<SettingsTransferStatus>(SETTINGS_TRANSFER_EVENT, (event) => {
    onChange(event.payload);
  });
};

export const subscribeToSettingsImport = async (
  onImport: (event: SettingsImportEvent) => void,
): Promise<() => void> => {
  if (!canSubscribeToTauriEvents()) return () => undefined;
  return listen<SettingsImportEvent>(SETTINGS_IMPORTED_EVENT, (event) => {
    onImport(event.payload);
  });
};

const canSubscribeToTauriEvents = (): boolean => {
  if (typeof window === "undefined" || !isTauri()) return false;
  const internals = (
    window as Window & {
      __TAURI_INTERNALS__?: { transformCallback?: unknown };
    }
  ).__TAURI_INTERNALS__;
  return typeof internals?.transformCallback === "function";
};
