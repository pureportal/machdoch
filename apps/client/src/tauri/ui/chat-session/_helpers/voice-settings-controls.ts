import type { DeviceVoicePreferences } from "@machdoch/fleet-protocol/device-settings";
import type { ChatSessionRuntimeController } from "./use-chat-session-runtime";
import type { ChatSessionVoiceController } from "./use-chat-session-voice";
import type { ChatSessionSpeechInputController } from "./use-chat-session-speech-input";
import type { SpeechInputDevicesController } from "./use-speech-input-devices";
import type { VoiceSettingsControls } from "../components/settings-dialog-panels/types";

export function createDeviceVoicePreferences(
  voice: ChatSessionVoiceController,
  speechInput: ChatSessionSpeechInputController,
  speechInputDevices: SpeechInputDevicesController,
): DeviceVoicePreferences {
  return {
    supported: voice.supported,
    systemVoicesSupported: voice.systemVoicesSupported,
    autoSpeakResponses: voice.autoSpeakResponses,
    availabilityDescription: voice.availabilityDescription,
    speechToTextAvailabilityDescription: speechInput.availabilityDescription,
    preferredVoiceURI: voice.preferredVoiceURI,
    rate: voice.rate,
    voiceOptions: voice.voiceOptions,
    speechInputDevicesSupported: speechInputDevices.supported,
    speechInputDevicesRefreshing: speechInputDevices.refreshing,
    speechInputDevices: speechInputDevices.devices,
    speechInputDeviceError: speechInputDevices.errorText,
  };
}

type VoiceActions = Pick<
  VoiceSettingsControls,
  | "onAutoSpeakResponsesChange"
  | "onPreferredVoiceChange"
  | "onRateChange"
  | "onRefreshSpeechInputDevices"
>;

export function createRuntimeVoiceSettingsControls(
  runtime: ChatSessionRuntimeController,
  preferences: DeviceVoicePreferences,
  actions: VoiceActions,
): VoiceSettingsControls {
  return {
    ...preferences,
    speechToTextProvider: runtime.userSpeechToTextSettings.activeProvider,
    speechToTextProviderAvailability:
      runtime.userSpeechToTextSettings.providerAvailability,
    speechKeyTerms: runtime.userSpeechToTextSettings.keyTerms,
    speechContext: runtime.userSpeechToTextSettings.speechContext,
    speechAutoTranslateToEnglish:
      runtime.userSpeechToTextSettings.autoTranslateToEnglish,
    speechAutoFormat: runtime.userSpeechToTextSettings.autoFormat,
    speechToTextProviderSaving: runtime.speechToTextSetupSaving,
    speechInputDeviceId: runtime.userSpeechToTextSettings.inputDeviceId,
    speechInputDeviceSaving: runtime.speechInputDeviceSaving,
    speechInputDeviceMessage: preferences.speechInputDeviceError
      ? { tone: "error", text: preferences.speechInputDeviceError }
      : null,
    speechToTextProviderMessage: runtime.speechToTextSetupMessage,
    aiProvider: runtime.userVoiceSettings.activeProvider,
    aiProviderAvailability: runtime.userVoiceSettings.providerAvailability,
    aiProviderSaving: runtime.voiceSetupSaving,
    aiProviderMessage: runtime.voiceSetupMessage,
    onSpeechToTextProviderChange: runtime.handleSpeechToTextActiveProviderSave,
    onSpeechInputDeviceChange: runtime.handleSpeechToTextInputDeviceSave,
    onSpeechKeyTermsSave: runtime.handleSpeechToTextKeyTermsSave,
    onSpeechContextSave: runtime.handleSpeechToTextContextSave,
    onAiProviderChange: runtime.handleVoiceActiveProviderSave,
    ...actions,
  };
}
