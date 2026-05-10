import type {
  SpeechToTextProvider,
  SpeechToTextProviderAvailability,
  UserAgentLimitsSettings,
  UserApiKeyProvider,
  UserDesktopSettings,
  UserMemorySettings,
  UserWebSearchApiKeyProvider,
  VoiceAiProvider,
  VoiceProviderAvailability,
  WebSearchProvider,
} from "../../../runtime";
import type { AppearanceSettings } from "../../../lib/shell-store";
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

export interface DesktopSettingsControls {
  settings: UserDesktopSettings;
  saving: boolean;
  message: SettingsStatusMessage | null;
  onSave: (settings: UserDesktopSettings) => Promise<void> | void;
}

export interface AgentLimitsSettingsControls {
  settings: UserAgentLimitsSettings;
  saving: boolean;
  message: SettingsStatusMessage | null;
  onSave: (settings: UserAgentLimitsSettings) => Promise<void> | void;
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
