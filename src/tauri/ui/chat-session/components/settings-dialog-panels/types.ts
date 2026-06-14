import type {
  McpConfigDocument,
  McpConfigScope,
  McpPresetSummary,
  SpeechToTextProvider,
  SpeechToTextProviderAvailability,
  RuntimeProviderAvailability,
  InstructionMutationInput,
  UserAgentLimitsSettings,
  UserApiKeyProvider,
  UserDesktopSettings,
  UserMemorySettings,
  UserReviewModelSettings,
  ReasoningMode,
  UserWebSearchApiKeyProvider,
  VoiceAiProvider,
  VoiceProviderAvailability,
  WebSearchProvider,
} from "../../../runtime";
import type {
  CustomizationDiagnostic,
  DiscoveredInstruction,
  RunMode,
} from "../../../../../core/types.js";
import type { AppearanceSettings } from "../../../lib/shell-store";
import type { RuntimeProvider } from "../../../model-catalog";
import type { SpeechInputDeviceOption } from "../../_helpers/speech-audio";
import type { ChatSessionVoiceOption } from "../../_helpers/use-chat-session-voice";

export interface SettingsStatusMessage {
  tone: "success" | "error";
  text: string;
}

export interface ProviderSetupControls {
  provider: UserApiKeyProvider;
  keyValue: string;
  saving: boolean;
  message: SettingsStatusMessage | null;
  onProviderChange: (provider: UserApiKeyProvider) => void;
  onOpenProviderPortal: (provider: UserApiKeyProvider) => Promise<void> | void;
  onKeyChange: (value: string) => void;
  onSave: (keyValue?: string) => Promise<boolean> | boolean;
}

export interface WebSearchSetupControls {
  activeProvider: WebSearchProvider;
  provider: UserWebSearchApiKeyProvider;
  keyValue: string;
  saving: boolean;
  message: SettingsStatusMessage | null;
  onActiveProviderChange: (provider: WebSearchProvider) => Promise<void> | void;
  onProviderChange: (provider: UserWebSearchApiKeyProvider) => void;
  onKeyChange: (value: string) => void;
  onSave: (keyValue?: string) => Promise<boolean> | boolean;
}

export interface MemorySettingsControls {
  settings: UserMemorySettings;
  saving: boolean;
  message: SettingsStatusMessage | null;
  onGlobalEnabledChange: (enabled: boolean) => Promise<void> | void;
}

export interface WorkspaceSettingsControls {
  workspaceRoot: string | null;
  workspaceLabel: string;
  defaultMode: RunMode;
  effectiveMode: RunMode;
  defaultReasoning: ReasoningMode;
  effectiveReasoning: ReasoningMode;
  reasoningProvider?: RuntimeProvider;
  reasoningModel?: string;
  activeProfile?: string;
  saving: boolean;
  message: SettingsStatusMessage | null;
  onDefaultModeChange: (mode: RunMode) => Promise<void> | void;
  onReasoningModeChange: (reasoning: ReasoningMode) => Promise<void> | void;
}

export interface McpSettingsControls {
  scope: McpConfigScope;
  document: McpConfigDocument;
  draft: string;
  presets: readonly McpPresetSummary[];
  workspaceAvailable: boolean;
  loading: boolean;
  saving: boolean;
  discoveryServerId: string;
  discoveryBusy: boolean;
  discoveryOutput: string | null;
  oauthServerId: string;
  oauthCallback: string;
  oauthBusy: boolean;
  message: SettingsStatusMessage | null;
  onScopeChange: (scope: McpConfigScope) => void;
  onDraftChange: (value: string) => void;
  onSave: () => Promise<void> | void;
  onPresetInsert: (presetId: string) => void;
  onDiscoveryServerIdChange: (serverId: string) => void;
  onDiscoverServer: (serverId?: string) => Promise<void> | void;
  onRefreshDiscoveryCache: (serverId?: string) => Promise<void> | void;
  onListDiscoveryCache: () => Promise<void> | void;
  onOAuthServerIdChange: (serverId: string) => void;
  onOAuthCallbackChange: (value: string) => void;
  onStartOAuth: (serverId?: string) => Promise<void> | void;
  onFinishOAuth: (
    serverId?: string,
    authorizationResponse?: string,
  ) => Promise<void> | void;
}

export interface InstructionSettingsControls {
  workspaceRoot: string | null;
  instructions: DiscoveredInstruction[];
  diagnostics: CustomizationDiagnostic[];
  loading: boolean;
  saving: boolean;
  message: SettingsStatusMessage | null;
  onRefresh: () => Promise<void> | void;
  onManualSave: (input: InstructionMutationInput) => Promise<void> | void;
  onGenerate: (input: InstructionMutationInput) => Promise<void> | void;
}

export interface DesktopSettingsControls {
  settings: UserDesktopSettings;
  saving: boolean;
  message: SettingsStatusMessage | null;
  onSave: (settings: UserDesktopSettings) => Promise<void> | void;
}

export interface AgentLimitsSettingsControls {
  settings: UserAgentLimitsSettings;
  reviewModelSettings: UserReviewModelSettings;
  providerAvailability: RuntimeProviderAvailability[];
  saving: boolean;
  message: SettingsStatusMessage | null;
  onSave: (settings: UserAgentLimitsSettings) => Promise<void> | void;
  onReviewModelSave: (settings: UserReviewModelSettings) => Promise<void> | void;
}

export interface AppearanceSettingsControls {
  settings: AppearanceSettings;
  saving: boolean;
  onSave: (settings: AppearanceSettings) => Promise<void> | void;
}

export interface VoiceSettingsControls {
  supported: boolean;
  systemVoicesSupported: boolean;
  autoSpeakResponses: boolean;
  availabilityDescription: string;
  speechToTextAvailabilityDescription: string;
  speechToTextProvider: SpeechToTextProvider;
  speechToTextProviderAvailability: SpeechToTextProviderAvailability[];
  speechToTextProviderSaving: boolean;
  speechInputDeviceId: string | null;
  speechInputDevicesSupported: boolean;
  speechInputDevicesRefreshing: boolean;
  speechInputDeviceSaving: boolean;
  speechInputDevices: SpeechInputDeviceOption[];
  speechInputDeviceMessage: SettingsStatusMessage | null;
  speechToTextProviderMessage: SettingsStatusMessage | null;
  aiProvider: VoiceAiProvider;
  aiProviderAvailability: VoiceProviderAvailability[];
  aiProviderSaving: boolean;
  aiProviderMessage: SettingsStatusMessage | null;
  preferredVoiceURI: string | null;
  rate: number;
  voiceOptions: ChatSessionVoiceOption[];
  onSpeechToTextProviderChange: (
    provider: SpeechToTextProvider,
  ) => Promise<void> | void;
  onSpeechInputDeviceChange: (
    inputDeviceId: string | null,
  ) => Promise<void> | void;
  onRefreshSpeechInputDevices: () => Promise<void> | void;
  onAiProviderChange: (provider: VoiceAiProvider) => Promise<void> | void;
  onAutoSpeakResponsesChange: (enabled: boolean) => void;
  onPreferredVoiceChange: (voiceURI: string | null) => void;
  onRateChange: (rate: number) => void;
}
