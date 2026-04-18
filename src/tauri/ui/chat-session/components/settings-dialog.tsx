import { ArrowUpRight } from "lucide-react";
import type { JSX } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Separator } from "../../components/ui/separator";
import { cn } from "../../lib/utils";
import { getProviderLabel } from "../../model-catalog";
import {
  USER_API_KEY_PROVIDER_ORDER,
  type UserDesktopSettings,
  USER_SPEECH_TO_TEXT_PROVIDER_ORDER,
  USER_VOICE_AI_PROVIDER_ORDER,
  USER_WEB_SEARCH_PROVIDER_ORDER,
  type SpeechToTextProvider,
  type SpeechToTextProviderAvailability,
  type UserApiKeyProvider,
  type UserMemorySettings,
  type UserVoiceAiProvider,
  type VoiceAiProvider,
  type VoiceProviderAvailability,
  type UserWebSearchApiKeyProvider,
  type WebSearchProvider,
} from "../../runtime";
import type { ChatSessionVoiceOption } from "../_helpers/use-chat-session-voice";
import {
  SETTINGS_SECTIONS,
  getWebSearchProviderLabel,
  type SettingsSection,
} from "../_helpers/session-shell.ts";

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
  onSave: () => Promise<void> | void;
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
  onSave: () => Promise<void> | void;
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

export interface VoiceSettingsControls {
  supported: boolean;
  systemVoicesSupported: boolean;
  autoSpeakResponses: boolean;
  availabilityDescription: string;
  speechToTextAvailabilityDescription: string;
  speechToTextProvider: SpeechToTextProvider;
  speechToTextProviderAvailability: SpeechToTextProviderAvailability[];
  speechToTextProviderSaving: boolean;
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
  onAiProviderChange: (provider: VoiceAiProvider) => Promise<void> | void;
  onAutoSpeakResponsesChange: (enabled: boolean) => void;
  onPreferredVoiceChange: (voiceURI: string | null) => void;
  onRateChange: (rate: number) => void;
}

const getSpeechToTextProviderLabel = (
  provider: SpeechToTextProvider,
): string => {
  return provider === "none" ? "Disabled" : getProviderLabel(provider);
};

const getVoiceAiProviderLabel = (provider: VoiceAiProvider): string => {
  return provider === "none" ? "System voices only" : getProviderLabel(provider);
};

const getVoiceProviderAvailabilityTone = (
  configured: boolean,
): string => {
  return configured ? "text-emerald-300" : "text-slate-400";
};

export interface SettingsDialogProps {
  settingsSection: SettingsSection;
  onSettingsSectionChange: (section: SettingsSection) => void;
  providerSetup: ProviderSetupControls;
  webSearchSetup: WebSearchSetupControls;
  memorySetup: MemorySettingsControls;
  desktopSetup: DesktopSettingsControls;
  voiceSetup: VoiceSettingsControls;
}

const getDesktopAutostartMode = (
  settings: UserDesktopSettings,
): "window" | "minimized" | "tray" => {
  if (settings.autostartToTray) {
    return "tray";
  }

  if (settings.autostartMinimized) {
    return "minimized";
  }

  return "window";
};

const applyDesktopAutostartMode = (
  settings: UserDesktopSettings,
  mode: "window" | "minimized" | "tray",
): UserDesktopSettings => {
  return {
    ...settings,
    autostartMinimized: mode === "minimized",
    autostartToTray: mode === "tray",
  };
};

export const SettingsDialog = ({
  settingsSection,
  onSettingsSectionChange,
  providerSetup,
  webSearchSetup,
  memorySetup,
  desktopSetup,
  voiceSetup,
}: SettingsDialogProps): JSX.Element => {
  const desktopAutostartMode = getDesktopAutostartMode(desktopSetup.settings);

  return (
    <DialogContent className="max-h-[85vh] max-w-2xl overflow-hidden rounded-3xl border-slate-800 bg-slate-950/96 p-0 text-slate-100 shadow-2xl">
      <div className="flex max-h-[85vh] flex-col overflow-hidden">
        <DialogHeader className="border-b border-slate-800 px-6 py-5 text-left">
          <DialogTitle className="text-xl font-semibold text-white">
            Settings
          </DialogTitle>
          <DialogDescription className="text-sm leading-6 text-slate-400">
            Provider API keys, web search connectors, voice playback, memory controls, and desktop startup behavior.
          </DialogDescription>
        </DialogHeader>

        <div className="border-b border-slate-800 px-6 py-4">
          <div className="flex flex-wrap gap-2">
            {SETTINGS_SECTIONS.map((section) => (
              <Button
                key={section.id}
                type="button"
                variant="outline"
                onClick={() => onSettingsSectionChange(section.id)}
                className={cn(
                  "h-9 rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                  settingsSection === section.id &&
                    "border-sky-500/30 bg-sky-500/10 text-sky-100",
                )}
              >
                {section.label}
              </Button>
            ))}
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1" type="always">
          <div className="grid gap-6 px-6 py-6 pr-8">
            {settingsSection === "providers" ? (
              <div className="grid gap-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
                <div className="grid gap-1">
                  <p className="text-sm font-semibold text-slate-100">
                    Model providers
                  </p>
                  <p className="text-sm leading-6 text-slate-400">
                    Save the API keys the desktop shell can reuse for model
                    access.
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  {USER_API_KEY_PROVIDER_ORDER.map((provider) => (
                    <Button
                      key={provider}
                      type="button"
                      variant="outline"
                      onClick={() => providerSetup.onProviderChange(provider)}
                      className={cn(
                        "h-9 rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                        providerSetup.provider === provider &&
                          "border-sky-500/30 bg-sky-500/10 text-sky-100",
                      )}
                    >
                      {getProviderLabel(provider)}
                    </Button>
                  ))}
                </div>

                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                  <Input
                    type="text"
                    value={providerSetup.keyValue}
                    onChange={(event) => {
                      providerSetup.onKeyChange(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void providerSetup.onSave();
                      }
                    }}
                    placeholder={`Paste your ${getProviderLabel(providerSetup.provider)} API key`}
                    autoComplete="off"
                    spellCheck={false}
                    className="h-11 rounded-2xl border-slate-800 bg-slate-950 text-slate-100 placeholder:text-slate-500"
                  />
                  <div className="flex items-center gap-2 md:justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Open ${getProviderLabel(providerSetup.provider)} API key settings`}
                      title={`Open ${getProviderLabel(providerSetup.provider)} API key settings`}
                      onClick={() => {
                        void providerSetup.onOpenProviderPortal(
                          providerSetup.provider,
                        );
                      }}
                      className="h-11 w-11 rounded-2xl border border-slate-800 bg-slate-950 text-slate-400 hover:bg-slate-900 hover:text-slate-100"
                    >
                      <ArrowUpRight className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      onClick={() => {
                        void providerSetup.onSave();
                      }}
                      disabled={
                        !providerSetup.keyValue.trim() || providerSetup.saving
                      }
                      className="h-11 rounded-2xl bg-sky-600 px-5 text-white hover:bg-sky-500 disabled:opacity-50"
                    >
                      {providerSetup.saving ? "Saving…" : "Save key"}
                    </Button>
                  </div>
                </div>

                {providerSetup.message ? (
                  <p
                    className={cn(
                      "text-xs leading-6",
                      providerSetup.message.tone === "error"
                        ? "text-rose-300"
                        : "text-emerald-300",
                    )}
                  >
                    {providerSetup.message.text}
                  </p>
                ) : null}
              </div>
            ) : null}

            {settingsSection === "web-search" ? (
              <div className="grid gap-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
                <div className="grid gap-1">
                  <p className="text-sm font-semibold text-slate-100">
                    Web search
                  </p>
                  <p className="text-sm leading-6 text-slate-400">
                    Choose one active provider at a time. The executor hides web
                    search until the active provider has a configured key.
                  </p>
                </div>

                <div className="grid gap-2">
                  <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
                    Active web search provider
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {(["none", ...USER_WEB_SEARCH_PROVIDER_ORDER] as const).map(
                      (provider) => (
                        <Button
                          key={provider}
                          type="button"
                          variant="outline"
                          onClick={() => {
                            void webSearchSetup.onActiveProviderChange(
                              provider,
                            );
                          }}
                          disabled={webSearchSetup.saving}
                          className={cn(
                            "h-9 rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                            webSearchSetup.activeProvider === provider &&
                              "border-sky-500/30 bg-sky-500/10 text-sky-100",
                          )}
                        >
                          {getWebSearchProviderLabel(provider)}
                        </Button>
                      ),
                    )}
                  </div>
                </div>

                <Separator className="bg-slate-800" />

                <div className="grid gap-2">
                  <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
                    API keys
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {USER_WEB_SEARCH_PROVIDER_ORDER.map((provider) => (
                      <Button
                        key={provider}
                        type="button"
                        variant="outline"
                        onClick={() =>
                          webSearchSetup.onProviderChange(provider)
                        }
                        className={cn(
                          "h-9 rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                          webSearchSetup.provider === provider &&
                            "border-sky-500/30 bg-sky-500/10 text-sky-100",
                        )}
                      >
                        {getWebSearchProviderLabel(provider)}
                      </Button>
                    ))}
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                  <Input
                    type="text"
                    value={webSearchSetup.keyValue}
                    onChange={(event) => {
                      webSearchSetup.onKeyChange(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void webSearchSetup.onSave();
                      }
                    }}
                    placeholder={`Paste your ${getWebSearchProviderLabel(webSearchSetup.provider)} API key`}
                    autoComplete="off"
                    spellCheck={false}
                    className="h-11 rounded-2xl border-slate-800 bg-slate-950 text-slate-100 placeholder:text-slate-500"
                  />
                  <Button
                    type="button"
                    onClick={() => {
                      void webSearchSetup.onSave();
                    }}
                    disabled={
                      !webSearchSetup.keyValue.trim() || webSearchSetup.saving
                    }
                    className="h-11 rounded-2xl bg-sky-600 px-5 text-white hover:bg-sky-500 disabled:opacity-50"
                  >
                    {webSearchSetup.saving ? "Saving…" : "Save key"}
                  </Button>
                </div>

                {webSearchSetup.message ? (
                  <p
                    className={cn(
                      "text-xs leading-6",
                      webSearchSetup.message.tone === "error"
                        ? "text-rose-300"
                        : "text-emerald-300",
                    )}
                  >
                    {webSearchSetup.message.text}
                  </p>
                ) : null}
              </div>
            ) : null}

            {settingsSection === "memory" ? (
              <div className="grid gap-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
                <div className="grid gap-1">
                  <p className="text-sm font-semibold text-slate-100">
                    Global memory
                  </p>
                  <p className="text-sm leading-6 text-slate-400">
                    Cross-session facts the assistant can reuse later. Keep this
                    off if you want every session to start fresh.
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={memorySetup.saving}
                    onClick={() => {
                      void memorySetup.onGlobalEnabledChange(true);
                    }}
                    className={cn(
                      "h-9 rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                      memorySetup.settings.globalEnabled &&
                        "border-sky-500/30 bg-sky-500/10 text-sky-100",
                    )}
                  >
                    Enabled
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={memorySetup.saving}
                    onClick={() => {
                      void memorySetup.onGlobalEnabledChange(false);
                    }}
                    className={cn(
                      "h-9 rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                      !memorySetup.settings.globalEnabled &&
                        "border-slate-600 bg-slate-900 text-slate-100",
                    )}
                  >
                    Disabled
                  </Button>
                  <Badge className="border-slate-700 bg-slate-950 text-slate-300">
                    {memorySetup.settings.entries.length} saved fact
                    {memorySetup.settings.entries.length === 1 ? "" : "s"}
                  </Badge>
                </div>

                {memorySetup.settings.entries.length === 0 ? (
                  <p className="text-sm leading-6 text-slate-500">
                    No global memories have been saved yet.
                  </p>
                ) : (
                  <div className="grid gap-2">
                    {memorySetup.settings.entries.map((entry) => (
                      <div
                        key={entry.id}
                        className="rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm leading-6 text-slate-300"
                      >
                        {entry.content}
                      </div>
                    ))}
                  </div>
                )}

                {memorySetup.message ? (
                  <p
                    className={cn(
                      "text-xs leading-6",
                      memorySetup.message.tone === "error"
                        ? "text-rose-300"
                        : "text-emerald-300",
                    )}
                  >
                    {memorySetup.message.text}
                  </p>
                ) : null}
              </div>
            ) : null}

            {settingsSection === "desktop" ? (
              <div className="grid gap-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
                <div className="grid gap-1">
                  <p className="text-sm font-semibold text-slate-100">
                    Desktop startup
                  </p>
                  <p className="text-sm leading-6 text-slate-400">
                    Use the native tray to show, hide, or quit machdoch. When login launch is set to tray, the window stays out of the taskbar until you restore it.
                  </p>
                </div>

                <div className="grid gap-2">
                  <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
                    Launch on sign-in
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={desktopSetup.saving}
                      onClick={() => {
                        void desktopSetup.onSave({
                          ...desktopSetup.settings,
                          autostartEnabled: true,
                        });
                      }}
                      className={cn(
                        "h-9 rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                        desktopSetup.settings.autostartEnabled &&
                          "border-sky-500/30 bg-sky-500/10 text-sky-100",
                      )}
                    >
                      Enabled
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={desktopSetup.saving}
                      onClick={() => {
                        void desktopSetup.onSave({
                          ...desktopSetup.settings,
                          autostartEnabled: false,
                        });
                      }}
                      className={cn(
                        "h-9 rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                        !desktopSetup.settings.autostartEnabled &&
                          "border-slate-600 bg-slate-900 text-slate-100",
                      )}
                    >
                      Disabled
                    </Button>
                  </div>
                </div>

                <Separator className="bg-slate-800" />

                <div className="grid gap-2">
                  <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
                    Autostart launch mode
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {([
                      ["window", "Open window"],
                      ["minimized", "Start minimized"],
                      ["tray", "Start in tray"],
                    ] as const).map(([mode, label]) => (
                      <Button
                        key={mode}
                        type="button"
                        variant="outline"
                        disabled={desktopSetup.saving}
                        onClick={() => {
                          void desktopSetup.onSave(
                            applyDesktopAutostartMode(
                              desktopSetup.settings,
                              mode,
                            ),
                          );
                        }}
                        className={cn(
                          "h-9 rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                          desktopAutostartMode === mode &&
                            "border-sky-500/30 bg-sky-500/10 text-sky-100",
                        )}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                  <p className="text-sm leading-6 text-slate-400">
                    Tray launch wins over minimized. The tray menu provides Show, Hide to tray, and Quit actions while the app is running.
                  </p>
                </div>

                {desktopSetup.message ? (
                  <p
                    className={cn(
                      "text-xs leading-6",
                      desktopSetup.message.tone === "error"
                        ? "text-rose-300"
                        : "text-emerald-300",
                    )}
                  >
                    {desktopSetup.message.text}
                  </p>
                ) : null}
              </div>
            ) : null}

            {settingsSection === "voice" ? (
              <div className="grid gap-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
                <div className="grid gap-1">
                  <p className="text-sm font-semibold text-slate-100">
                    Speak to text
                  </p>
                  <p className="text-sm leading-6 text-slate-400">
                    Push-to-talk recordings are transcribed into plain text and
                    inserted into the current draft, so the final chat bubble
                    stays text-only.
                  </p>
                </div>

                <div className="grid gap-2">
                  <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
                    Active speech-to-text provider
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {([
                      "none",
                      ...USER_SPEECH_TO_TEXT_PROVIDER_ORDER,
                    ] as const).map((provider) => (
                      <Button
                        key={provider}
                        type="button"
                        variant="outline"
                        aria-label={`Speak to text provider ${getSpeechToTextProviderLabel(provider)}`}
                        disabled={voiceSetup.speechToTextProviderSaving}
                        onClick={() => {
                          void voiceSetup.onSpeechToTextProviderChange(provider);
                        }}
                        className={cn(
                          "h-9 rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                          voiceSetup.speechToTextProvider === provider &&
                            "border-sky-500/30 bg-sky-500/10 text-sky-100",
                        )}
                      >
                        {getSpeechToTextProviderLabel(provider)}
                      </Button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {voiceSetup.speechToTextProviderAvailability.map((provider) => (
                    <Badge
                      key={provider.provider}
                      className={cn(
                        "border-slate-700 bg-slate-950",
                        getVoiceProviderAvailabilityTone(provider.configured),
                      )}
                    >
                      {getProviderLabel(provider.provider)} {provider.configured ? "configured" : "missing key"}
                    </Badge>
                  ))}
                </div>

                {voiceSetup.speechToTextProviderMessage ? (
                  <p
                    className={cn(
                      "text-xs leading-6",
                      voiceSetup.speechToTextProviderMessage.tone === "error"
                        ? "text-rose-300"
                        : "text-emerald-300",
                    )}
                  >
                    {voiceSetup.speechToTextProviderMessage.text}
                  </p>
                ) : null}

                <p className="text-sm leading-6 text-slate-400">
                  {voiceSetup.speechToTextAvailabilityDescription}
                </p>

                <Separator className="bg-slate-800" />

                <div className="grid gap-1">
                  <p className="text-sm font-semibold text-slate-100">
                    Voice replies
                  </p>
                  <p className="text-sm leading-6 text-slate-400">
                    Use AI-generated speech when a provider is selected. If no
                    AI voice is available, machdoch falls back to the current
                    WebView’s system voices when supported.
                  </p>
                </div>

                <div className="grid gap-2">
                  <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
                    AI voice provider
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {(["none", ...USER_VOICE_AI_PROVIDER_ORDER] as const).map(
                      (provider) => (
                        <Button
                          key={provider}
                          type="button"
                          variant="outline"
                          disabled={voiceSetup.aiProviderSaving}
                          onClick={() => {
                            void voiceSetup.onAiProviderChange(provider);
                          }}
                          className={cn(
                            "h-9 rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                            voiceSetup.aiProvider === provider &&
                              "border-sky-500/30 bg-sky-500/10 text-sky-100",
                          )}
                        >
                          {getVoiceAiProviderLabel(provider)}
                        </Button>
                      ),
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {voiceSetup.aiProviderAvailability.map((provider) => (
                    <Badge
                      key={provider.provider}
                      className={cn(
                        "border-slate-700 bg-slate-950",
                        getVoiceProviderAvailabilityTone(provider.configured),
                      )}
                    >
                      {getProviderLabel(provider.provider as UserVoiceAiProvider)} {provider.configured ? "configured" : "missing key"}
                    </Badge>
                  ))}
                </div>

                {voiceSetup.aiProviderMessage ? (
                  <p
                    className={cn(
                      "text-xs leading-6",
                      voiceSetup.aiProviderMessage.tone === "error"
                        ? "text-rose-300"
                        : "text-emerald-300",
                    )}
                  >
                    {voiceSetup.aiProviderMessage.text}
                  </p>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      voiceSetup.onAutoSpeakResponsesChange(true);
                    }}
                    className={cn(
                      "h-9 rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                      voiceSetup.autoSpeakResponses &&
                        "border-sky-500/30 bg-sky-500/10 text-sky-100",
                    )}
                  >
                    Auto-read new replies
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      voiceSetup.onAutoSpeakResponsesChange(false);
                    }}
                    className={cn(
                      "h-9 rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                      !voiceSetup.autoSpeakResponses &&
                        "border-slate-600 bg-slate-900 text-slate-100",
                    )}
                  >
                    Manual only
                  </Button>
                  <Badge className="border-slate-700 bg-slate-950 text-slate-300">
                    {voiceSetup.supported ? "Ready" : "Unavailable"}
                  </Badge>
                </div>

                <p className="text-sm leading-6 text-slate-400">
                  {voiceSetup.availabilityDescription}
                </p>

                {voiceSetup.systemVoicesSupported ? (
                  <>
                    <Separator className="bg-slate-800" />

                    <div className="grid gap-2">
                      <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
                        System voice fallback
                      </p>
                      <select
                        value={voiceSetup.preferredVoiceURI ?? ""}
                        onChange={(event) => {
                          const nextValue = event.target.value.trim();

                          voiceSetup.onPreferredVoiceChange(
                            nextValue.length > 0 ? nextValue : null,
                          );
                        }}
                        className="h-11 w-full rounded-2xl border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition-colors focus:border-sky-500/40"
                      >
                        <option value="">System default</option>
                        {voiceSetup.voiceOptions.map((voice) => (
                          <option key={voice.voiceURI} value={voice.voiceURI}>
                            {voice.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="grid gap-2">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
                          System speech rate
                        </p>
                        <span className="text-xs text-slate-400">
                          {voiceSetup.rate.toFixed(2)}×
                        </span>
                      </div>
                      <input
                        type="range"
                        min="0.8"
                        max="1.4"
                        step="0.05"
                        value={voiceSetup.rate}
                        onChange={(event) => {
                          voiceSetup.onRateChange(
                            Number(event.target.value),
                          );
                        }}
                        className="w-full accent-sky-400"
                      />
                      <div className="flex items-center justify-between text-[11px] text-slate-500">
                        <span>Slower</span>
                        <span>Faster</span>
                      </div>
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </div>
    </DialogContent>
  );
};
