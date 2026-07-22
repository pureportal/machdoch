import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const SETTINGS_TRANSFER_EVENT =
  "machdoch://settings-transfer-state" as const;
export const SETTINGS_IMPORTED_EVENT = "machdoch://settings-imported" as const;

export type SettingsCategoryId =
  | "credentials.api-keys"
  | "preferences.agent-provider"
  | "preferences.desktop-appearance"
  | "preferences.chat-voice"
  | "memory.global"
  | "customizations.instructions-global"
  | "customizations.prompts-global"
  | "context-packs.global"
  | "mcp.global"
  | "ralph.preferences-global"
  | "ralph.flows-global";

export type SettingsTransferMode = "send" | "receive";
export type SettingsTransferPhase =
  | "idle"
  | "inspecting"
  | "advertising"
  | "discovering"
  | "connecting"
  | "pairing"
  | "review"
  | "transferring"
  | "validating"
  | "committing"
  | "rollingBack"
  | "completed"
  | "cancelled"
  | "failed";

export type CategoryAvailability =
  | "available"
  | "empty"
  | "unavailable"
  | "unsupported";

export type CategoryEffect =
  | "replace"
  | "clear"
  | "preserveNotSelected"
  | "preserveNotOffered"
  | "preserveUnavailable"
  | "preserveIncompatible";

export interface SettingsTransferCategory {
  id: SettingsCategoryId;
  label: string;
  description: string;
  warning: string | null;
  defaultSelected: boolean;
  sensitive: boolean;
  selected: boolean;
  availability: CategoryAvailability;
  effect: CategoryEffect | null;
  itemCount: number;
  byteCount: number;
  transferredBytes: number;
  transferTotalBytes: number;
  currentItemCount: number | null;
  reason: string | null;
}

export interface SettingsTransferNetworkInterface {
  id: string;
  name: string;
  addresses: string[];
  selected: boolean;
  recommended: boolean;
  reason: string | null;
}

export interface DiscoveredTransferSession {
  id: string;
  label: string;
  protocolVersion: number;
  expiresAt: number;
}

export interface SettingsTransferStatus {
  mode: SettingsTransferMode | null;
  phase: SettingsTransferPhase;
  sessionLabel: string | null;
  peerName: string | null;
  peerCategories: SettingsCategoryId[];
  effectiveCategories: SettingsCategoryId[];
  pairingCode: string | null;
  createdAt: number | null;
  expiresAt: number | null;
  categories: SettingsTransferCategory[];
  networkInterfaces: SettingsTransferNetworkInterface[];
  discoveredSessions: DiscoveredTransferSession[];
  manualCode: string | null;
  qrSvg: string | null;
  transferredBytes: number;
  totalBytes: number;
  message: string | null;
  errorCode: string | null;
  completedLocally: boolean;
}

export interface SettingsImportEvent {
  categories: SettingsCategoryId[];
  updatedAt: number;
}

export interface StartSettingsTransferRequest {
  categories: SettingsCategoryId[];
  displayName: string;
  interfaceIds: string[];
}

export interface ExportEncryptedSettingsFileRequest {
  categories: SettingsCategoryId[];
  destinationPath: string;
  passphrase: string;
}

export interface EncryptedSettingsFileExportResult {
  categories: SettingsCategoryId[];
  itemCount: number;
  fileBytes: number;
}

export interface InspectEncryptedSettingsFileRequest {
  operationId: string;
  categories: SettingsCategoryId[];
  sourcePath: string;
  passphrase: string;
}

export interface EncryptedSettingsFileImportReview {
  token: string | null;
  fileCreatedAt: number;
  reviewExpiresAt: number | null;
  effectiveCategories: SettingsCategoryId[];
  categories: SettingsTransferCategory[];
}

export interface EncryptedSettingsFileImportResult {
  categories: SettingsCategoryId[];
  recoveryCleanupPending: boolean;
}

export const isActiveTransferPhase = (phase: SettingsTransferPhase): boolean =>
  !["idle", "completed", "cancelled", "failed"].includes(phase);

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
): Promise<() => void> =>
  listen<SettingsTransferStatus>(SETTINGS_TRANSFER_EVENT, (event) => {
    onChange(event.payload);
  });

export const subscribeToSettingsImport = async (
  onImport: (event: SettingsImportEvent) => void,
): Promise<() => void> =>
  listen<SettingsImportEvent>(SETTINGS_IMPORTED_EVENT, (event) => {
    onImport(event.payload);
  });
