export type SettingsCategoryId =
  | "credentials.api-keys"
  | "preferences.agent-provider"
  | "preferences.desktop-appearance"
  | "preferences.chat-voice"
  | "memory.global"
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
