import { RefreshCw } from "lucide-react";
import { useEffect, useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { getProviderLabel } from "../../../model-catalog";
import {
  USER_SPEECH_TO_TEXT_PROVIDER_ORDER,
  USER_VOICE_AI_PROVIDER_ORDER,
  type SpeechToTextProvider,
  type VoiceAiProvider,
} from "../../../runtime";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import {
  ChoiceButtons,
  SettingPanel,
  SettingsCard,
  SettingsProviderChoice,
  SettingsStatus,
} from "./shared";
import { useSettingsNavigationGuard } from "./navigation-guard";
import type { VoiceSettingsControls } from "./types";

const getSpeechToTextProviderLabel = (
  provider: SpeechToTextProvider,
): string => {
  return provider === "none"
    ? "Disabled"
    : provider === "whisper"
      ? "Whisper (local)"
      : getProviderLabel(provider);
};

const getVoiceAiProviderLabel = (provider: VoiceAiProvider): string => {
  return provider === "none"
    ? "System voices only"
    : getProviderLabel(provider);
};

export interface VoiceSettingsPanelProps {
  setup: VoiceSettingsControls;
}

export const VoiceSettingsPanel = ({
  setup,
}: VoiceSettingsPanelProps): JSX.Element => {
  const savedKeyTerms = setup.speechKeyTerms.join("\n");
  const [keyTermsDraft, setKeyTermsDraft] = useState(savedKeyTerms);
  const [speechContextDraft, setSpeechContextDraft] = useState(
    setup.speechContext,
  );

  useEffect(() => {
    setKeyTermsDraft(savedKeyTerms);
  }, [savedKeyTerms]);
  useEffect(() => {
    setSpeechContextDraft(setup.speechContext);
  }, [setup.speechContext]);

  const persistenceBusy =
    setup.speechToTextProviderSaving ||
    setup.speechInputDeviceSaving ||
    setup.aiProviderSaving;
  const keyTermsChanged = keyTermsDraft.trim() !== savedKeyTerms.trim();
  const speechContextChanged =
    speechContextDraft.trim() !== setup.speechContext.trim();

  useSettingsNavigationGuard({
    dirty: persistenceBusy || keyTermsChanged || speechContextChanged,
    title: persistenceBusy
      ? "Saving speech settings"
      : "Unsaved speech settings",
    description: persistenceBusy
      ? "Wait for the speech setting to finish saving before leaving this section."
      : "Discard your unsaved speech input changes?",
    canDiscard: !persistenceBusy,
    onDiscard: () => {
      setKeyTermsDraft(savedKeyTerms);
      setSpeechContextDraft(setup.speechContext);
    },
  });

  const speechToTextProviderConfigured = new Map(
    setup.speechToTextProviderAvailability.map((provider) => [
      provider.provider,
      provider.configured,
    ]),
  );
  const aiVoiceProviderConfigured = new Map(
    setup.aiProviderAvailability.map((provider) => [
      provider.provider,
      provider.configured,
    ]),
  );
  const selectedSpeechInputDeviceMissing =
    setup.speechInputDeviceId !== null &&
    !setup.speechInputDevices.some(
      (device) => device.deviceId === setup.speechInputDeviceId,
    );
  const selectedSystemVoiceMissing =
    setup.preferredVoiceURI !== null &&
    !setup.voiceOptions.some(
      (voice) => voice.voiceURI === setup.preferredVoiceURI,
    );
  const voiceOutputAvailable = setup.supported;

  return (
    <>
      <SettingsCard title="Microphone">
        <div className="grid gap-0">
          <SettingsProviderChoice
            label="Speech input"
            detail={
              setup.speechToTextProviderAvailability.some(
                (provider) => provider.configured,
              )
                ? undefined
                : "Add a provider API key in Providers to use speech input."
            }
            value={setup.speechToTextProvider}
            options={(
              ["none", ...USER_SPEECH_TO_TEXT_PROVIDER_ORDER] as const
            ).map((provider) => ({
              value: provider,
              label: getSpeechToTextProviderLabel(provider),
              ariaLabel: `Speak to text provider ${getSpeechToTextProviderLabel(provider)}`,
              disabled:
                provider !== "none" &&
                !speechToTextProviderConfigured.get(provider),
              title:
                provider !== "none" &&
                !speechToTextProviderConfigured.get(provider)
                  ? "Add this provider's API key before selecting it."
                  : undefined,
            }))}
            disabled={setup.speechToTextProviderSaving}
            onChange={setup.onSpeechToTextProviderChange}
          />

          <SettingPanel
            label="Key terms"
            detail="One per line; up to 100 terms, 80 characters each."
          >
            <div className="grid gap-2">
              <textarea
                aria-label="Speech key terms"
                value={keyTermsDraft}
                maxLength={8100}
                rows={4}
                onChange={(event) => setKeyTermsDraft(event.target.value)}
                className="w-full resize-y rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition-colors focus:border-sky-500/40"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="justify-self-end"
                disabled={persistenceBusy || !keyTermsChanged}
                onClick={() => {
                  void setup.onSpeechKeyTermsSave(
                    keyTermsDraft
                      .split(/\r?\n/)
                      .map((term) => term.trim())
                      .filter(Boolean),
                  );
                }}
              >
                Save terms
              </Button>
            </div>
          </SettingPanel>

          {setup.speechToTextProvider === "openai" ? (
            <SettingPanel
              label="Context"
              detail="Used by OpenAI to recognize speech."
            >
              <div className="grid gap-2">
                <textarea
                  aria-label="Speech context"
                  value={speechContextDraft}
                  maxLength={2000}
                  rows={4}
                  onChange={(event) =>
                    setSpeechContextDraft(event.target.value)
                  }
                  className="w-full resize-y rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition-colors focus:border-sky-500/40"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="justify-self-end"
                  disabled={persistenceBusy || !speechContextChanged}
                  onClick={() => {
                    void setup.onSpeechContextSave(speechContextDraft.trim());
                  }}
                >
                  Save context
                </Button>
              </div>
            </SettingPanel>
          ) : null}

          <SettingPanel
            label="Input device"
            detail={
              setup.speechInputDevicesSupported
                ? undefined
                : "Microphone selection is unavailable on this device."
            }
          >
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
              <select
                aria-label="Voice input device"
                value={setup.speechInputDeviceId ?? ""}
                disabled={
                  !setup.speechInputDevicesSupported ||
                  setup.speechInputDeviceSaving
                }
                onChange={(event) => {
                  const nextValue = event.target.value.trim();

                  void setup.onSpeechInputDeviceChange(
                    nextValue.length > 0 ? nextValue : null,
                  );
                }}
                className="h-10 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition-colors focus:border-sky-500/40 disabled:opacity-50"
              >
                <option value="">System default</option>
                {selectedSpeechInputDeviceMissing ? (
                  <option value={setup.speechInputDeviceId ?? ""}>
                    Selected microphone unavailable
                  </option>
                ) : null}
                {setup.speechInputDevices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Refresh microphone devices"
                tooltip="Refresh microphone devices"
                onClick={() => {
                  void setup.onRefreshSpeechInputDevices();
                }}
                disabled={
                  !setup.speechInputDevicesSupported ||
                  setup.speechInputDevicesRefreshing
                }
                className="h-10 w-10 rounded-lg border-slate-800 bg-slate-950 text-slate-300 hover:bg-slate-900 hover:text-slate-100 disabled:opacity-40"
              >
                <RefreshCw
                  className={cn(
                    "h-4 w-4",
                    setup.speechInputDevicesRefreshing && "animate-spin",
                  )}
                />
              </Button>
            </div>
          </SettingPanel>
        </div>
        <SettingsStatus message={setup.speechToTextProviderMessage} />
        <SettingsStatus message={setup.speechInputDeviceMessage} />
      </SettingsCard>
      <SettingsCard title="Speech output">
        <div className="grid gap-0">
          <SettingsProviderChoice
            label="Voice provider"
            detail={
              voiceOutputAvailable ? undefined : setup.availabilityDescription
            }
            value={setup.aiProvider}
            options={(["none", ...USER_VOICE_AI_PROVIDER_ORDER] as const).map(
              (provider) => ({
                value: provider,
                label: getVoiceAiProviderLabel(provider),
                disabled:
                  provider !== "none" &&
                  !aiVoiceProviderConfigured.get(provider),
                title:
                  provider !== "none" &&
                  !aiVoiceProviderConfigured.get(provider)
                    ? "Add this provider's API key before selecting it."
                    : undefined,
              }),
            )}
            disabled={setup.aiProviderSaving}
            onChange={setup.onAiProviderChange}
          />

          <SettingPanel
            label="Spoken replies"
            detail={
              voiceOutputAvailable
                ? undefined
                : "No configured speech output is currently available."
            }
          >
            <ChoiceButtons
              label="Spoken reply behavior"
              value={setup.autoSpeakResponses ? "auto" : "manual"}
              options={[
                { value: "auto", label: "Auto-read new replies" },
                { value: "manual", label: "Manual only" },
              ]}
              disabled={!voiceOutputAvailable}
              onChange={(value) => {
                setup.onAutoSpeakResponsesChange(value === "auto");
              }}
            />
          </SettingPanel>

          {setup.systemVoicesSupported ? (
            <>
              <SettingPanel label="System voice">
                <select
                  aria-label="System voice"
                  value={setup.preferredVoiceURI ?? ""}
                  onChange={(event) => {
                    const nextValue = event.target.value.trim();

                    setup.onPreferredVoiceChange(
                      nextValue.length > 0 ? nextValue : null,
                    );
                  }}
                  className="h-10 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition-colors focus:border-sky-500/40"
                >
                  <option value="">System default</option>
                  {selectedSystemVoiceMissing ? (
                    <option value={setup.preferredVoiceURI ?? ""}>
                      Selected voice unavailable
                    </option>
                  ) : null}
                  {setup.voiceOptions.map((voice) => (
                    <option key={voice.voiceURI} value={voice.voiceURI}>
                      {voice.label}
                    </option>
                  ))}
                </select>
              </SettingPanel>

              <SettingPanel label="Speech rate">
                <div className="flex items-center gap-3">
                  <input
                    aria-label="Speech rate"
                    type="range"
                    min="0.8"
                    max="1.4"
                    step="0.05"
                    value={setup.rate}
                    onChange={(event) => {
                      setup.onRateChange(Number(event.target.value));
                    }}
                    className="min-w-0 flex-1 accent-sky-400"
                  />
                  <span className="w-12 text-right text-xs text-slate-400">
                    {setup.rate.toFixed(2)}x
                  </span>
                </div>
              </SettingPanel>
            </>
          ) : null}
        </div>

        <SettingsStatus message={setup.aiProviderMessage} />
      </SettingsCard>
    </>
  );
};
