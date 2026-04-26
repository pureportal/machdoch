import { ArrowUpRight } from "lucide-react";
import { useEffect, useState, type JSX, type ReactNode } from "react";
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

interface SettingsCardProps {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}

const SettingsCard = ({
  title,
  description,
  children,
  className,
}: SettingsCardProps): JSX.Element => {
  return (
    <section
      className={cn(
        "grid min-h-full content-start gap-4 rounded-3xl border border-slate-800 bg-slate-900/45 p-5",
        className,
      )}
    >
      <div className="grid gap-1">
        <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
        {description ? (
          <p className="text-sm leading-6 text-slate-400">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
};

interface SettingPanelProps {
  label: string;
  detail?: string;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

const SettingPanel = ({
  label,
  detail,
  children,
  className,
  contentClassName,
}: SettingPanelProps): JSX.Element => {
  return (
    <div
      className={cn(
        "grid gap-3 rounded-2xl border border-slate-800 bg-slate-950/55 p-4 md:grid-cols-[minmax(9rem,0.8fr)_minmax(0,1.2fr)] md:items-center",
        className,
      )}
    >
      <div className="grid gap-1">
        <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
          {label}
        </p>
        {detail ? (
          <p className="text-sm leading-5 text-slate-400">{detail}</p>
        ) : null}
      </div>
      <div className={cn("min-w-0", contentClassName)}>{children}</div>
    </div>
  );
};

interface ChoiceOption<TValue extends string> {
  value: TValue;
  label: string;
  ariaLabel?: string;
}

interface ChoiceButtonsProps<TValue extends string> {
  value: TValue;
  options: ReadonlyArray<ChoiceOption<TValue>>;
  disabled?: boolean;
  onChange: (value: TValue) => void;
}

function ChoiceButtons<TValue extends string>({
  value,
  options,
  disabled = false,
  onChange,
}: ChoiceButtonsProps<TValue>): JSX.Element {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => {
        const selected = value === option.value;

        return (
          <Button
            key={option.value}
            type="button"
            variant="outline"
            aria-label={option.ariaLabel}
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "h-9 rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100",
              selected && "border-sky-500/30 bg-sky-500/10 text-sky-100",
            )}
          >
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}

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

const hasDesktopSettingsDraftChanges = (
  left: UserDesktopSettings,
  right: UserDesktopSettings,
): boolean => {
  return (
    left.autostartEnabled !== right.autostartEnabled ||
    left.autostartMinimized !== right.autostartMinimized ||
    left.autostartToTray !== right.autostartToTray ||
    left.assistantBubbleEnabled !== right.assistantBubbleEnabled ||
    left.assistantBubbleHideWhenFullscreen !==
      right.assistantBubbleHideWhenFullscreen ||
    left.assistantBubbleTemporarilyHideSeconds !==
      right.assistantBubbleTemporarilyHideSeconds ||
    left.quickVoiceEnabled !== right.quickVoiceEnabled ||
    left.quickVoiceShortcut !== right.quickVoiceShortcut ||
    left.quickVoiceSilenceSeconds !== right.quickVoiceSilenceSeconds ||
    left.quickVoiceMaxMessages !== right.quickVoiceMaxMessages
  );
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
  const [desktopDraft, setDesktopDraft] = useState<UserDesktopSettings>(
    desktopSetup.settings,
  );

  useEffect(() => {
    setDesktopDraft(desktopSetup.settings);
  }, [desktopSetup.settings]);

  const desktopAutostartMode = getDesktopAutostartMode(desktopDraft);
  const desktopDraftDirty = hasDesktopSettingsDraftChanges(
    desktopDraft,
    desktopSetup.settings,
  );

  return (
    <DialogContent className="h-[min(760px,calc(100vh-32px))] w-[min(1080px,calc(100vw-32px))] max-w-none gap-0 overflow-hidden rounded-3xl border-slate-800 bg-slate-950/96 p-0 text-slate-100 shadow-2xl sm:max-w-none">
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <DialogHeader className="border-b border-slate-800 px-6 py-4 text-left">
          <DialogTitle className="text-xl font-semibold text-white">
            Settings
          </DialogTitle>
          <DialogDescription className="sr-only">
            Configure providers, web search, voice, memory, and desktop behavior.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 overflow-hidden md:grid-cols-[11rem_minmax(0,1fr)]">
          <nav className="border-b border-slate-800 px-4 py-3 md:border-r md:border-b-0 md:px-3 md:py-4">
            <div className="flex gap-2 overflow-x-auto md:grid md:overflow-visible">
              {SETTINGS_SECTIONS.map((section) => (
                <Button
                  key={section.id}
                  type="button"
                  variant="outline"
                  onClick={() => onSettingsSectionChange(section.id)}
                  className={cn(
                    "h-9 shrink-0 justify-start rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100 md:w-full",
                    settingsSection === section.id &&
                      "border-sky-500/30 bg-sky-500/10 text-sky-100",
                  )}
                >
                  {section.label}
                </Button>
              ))}
            </div>
          </nav>

          <ScrollArea className="h-full min-h-0" type="always">
            <div className="grid min-h-full gap-4 px-5 py-5 pr-7">
              {settingsSection === "providers" ? (
                <SettingsCard title="Model provider keys">
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
              </SettingsCard>
            ) : null}

            {settingsSection === "web-search" ? (
              <SettingsCard title="Web search">

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
              </SettingsCard>
            ) : null}

            {settingsSection === "memory" ? (
              <SettingsCard title="Global memory">

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

                {memorySetup.settings.entries.length > 0 ? (
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
                ) : null}

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
              </SettingsCard>
            ) : null}

            {settingsSection === "desktop" ? (
              <SettingsCard title="Desktop assistant">
                <div className="grid gap-3 xl:grid-cols-2">
                  <SettingPanel label="Launch on sign-in">
                    <ChoiceButtons
                      value={desktopDraft.autostartEnabled ? "enabled" : "disabled"}
                      options={[
                        { value: "enabled", label: "Enabled" },
                        { value: "disabled", label: "Disabled" },
                      ]}
                      disabled={desktopSetup.saving}
                      onChange={(value) => {
                        setDesktopDraft({
                          ...desktopDraft,
                          autostartEnabled: value === "enabled",
                        });
                      }}
                    />
                  </SettingPanel>

                  <SettingPanel label="Startup behavior">
                    <ChoiceButtons
                      value={desktopAutostartMode}
                      options={[
                        { value: "window", label: "Open window" },
                        { value: "minimized", label: "Start minimized" },
                        { value: "tray", label: "Start in tray" },
                      ]}
                      disabled={desktopSetup.saving}
                      onChange={(mode) => {
                        setDesktopDraft(
                          applyDesktopAutostartMode(desktopDraft, mode),
                        );
                      }}
                    />
                  </SettingPanel>

                  <SettingPanel label="Floating bubble">
                    <ChoiceButtons
                      value={desktopDraft.assistantBubbleEnabled ? "enabled" : "disabled"}
                      options={[
                        { value: "enabled", label: "Enabled" },
                        { value: "disabled", label: "Disabled" },
                      ]}
                      disabled={desktopSetup.saving}
                      onChange={(value) => {
                        setDesktopDraft({
                          ...desktopDraft,
                          assistantBubbleEnabled: value === "enabled",
                        });
                      }}
                    />
                  </SettingPanel>

                  <SettingPanel label="Fullscreen apps">
                    <ChoiceButtons
                      value={desktopDraft.assistantBubbleHideWhenFullscreen ? "hide" : "show"}
                      options={[
                        { value: "hide", label: "Hide bubble" },
                        { value: "show", label: "Keep visible" },
                      ]}
                      disabled={desktopSetup.saving}
                      onChange={(value) => {
                        setDesktopDraft({
                          ...desktopDraft,
                          assistantBubbleHideWhenFullscreen: value === "hide",
                        });
                      }}
                    />
                  </SettingPanel>

                  <SettingPanel label="Hide duration">
                    <Input
                      type="number"
                      min="2"
                      max="30"
                      step="1"
                      value={desktopDraft.assistantBubbleTemporarilyHideSeconds}
                      onChange={(event) => {
                        setDesktopDraft({
                          ...desktopDraft,
                          assistantBubbleTemporarilyHideSeconds: Number(
                            event.target.value,
                          ),
                        });
                      }}
                      className="h-10 max-w-28 rounded-2xl border-slate-800 bg-slate-950 text-slate-100"
                    />
                  </SettingPanel>

                  <SettingPanel label="Quick Voice">
                    <ChoiceButtons
                      value={desktopDraft.quickVoiceEnabled ? "enabled" : "disabled"}
                      options={[
                        { value: "enabled", label: "Enabled" },
                        { value: "disabled", label: "Disabled" },
                      ]}
                      disabled={desktopSetup.saving}
                      onChange={(value) => {
                        setDesktopDraft({
                          ...desktopDraft,
                          quickVoiceEnabled: value === "enabled",
                        });
                      }}
                    />
                  </SettingPanel>

                  <SettingPanel label="Global shortcut">
                    <Input
                      type="text"
                      value={desktopDraft.quickVoiceShortcut}
                      onChange={(event) => {
                        setDesktopDraft({
                          ...desktopDraft,
                          quickVoiceShortcut: event.target.value,
                        });
                      }}
                      placeholder="CommandOrControl+Alt+V"
                      autoComplete="off"
                      spellCheck={false}
                      className="h-10 rounded-2xl border-slate-800 bg-slate-950 text-slate-100"
                    />
                  </SettingPanel>

                  <SettingPanel label="Silence timeout">
                    <Input
                      type="number"
                      min="0.8"
                      max="8"
                      step="0.1"
                      value={desktopDraft.quickVoiceSilenceSeconds}
                      onChange={(event) => {
                        setDesktopDraft({
                          ...desktopDraft,
                          quickVoiceSilenceSeconds: Number(
                            event.target.value,
                          ),
                        });
                      }}
                      className="h-10 max-w-28 rounded-2xl border-slate-800 bg-slate-950 text-slate-100"
                    />
                  </SettingPanel>

                  <SettingPanel label="Quick Tasks cap">
                    <Input
                      type="number"
                      min="10"
                      max="200"
                      step="5"
                      value={desktopDraft.quickVoiceMaxMessages}
                      onChange={(event) => {
                        setDesktopDraft({
                          ...desktopDraft,
                          quickVoiceMaxMessages: Number(event.target.value),
                        });
                      }}
                      className="h-10 max-w-28 rounded-2xl border-slate-800 bg-slate-950 text-slate-100"
                    />
                  </SettingPanel>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                  <p className="text-sm leading-6 text-slate-400">
                    {desktopDraftDirty ? "Unsaved desktop changes" : "Desktop settings are up to date"}
                  </p>
                  <Button
                    type="button"
                    onClick={() => {
                      void desktopSetup.onSave(desktopDraft);
                    }}
                    disabled={desktopSetup.saving || !desktopDraftDirty}
                    className="h-11 rounded-2xl bg-sky-600 px-5 text-white hover:bg-sky-500 disabled:opacity-50"
                  >
                    {desktopSetup.saving ? "Saving…" : "Save desktop settings"}
                  </Button>
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
              </SettingsCard>
            ) : null}

            {settingsSection === "voice" ? (
              <SettingsCard title="Voice">
                <div className="grid gap-3 xl:grid-cols-2">
                  <SettingPanel label="Speak to text" className="xl:col-span-2">
                    <ChoiceButtons
                      value={voiceSetup.speechToTextProvider}
                      options={([
                        "none",
                        ...USER_SPEECH_TO_TEXT_PROVIDER_ORDER,
                      ] as const).map((provider) => ({
                        value: provider,
                        label: getSpeechToTextProviderLabel(provider),
                        ariaLabel: `Speak to text provider ${getSpeechToTextProviderLabel(provider)}`,
                      }))}
                      disabled={voiceSetup.speechToTextProviderSaving}
                      onChange={(provider) => {
                        void voiceSetup.onSpeechToTextProviderChange(provider);
                      }}
                    />
                  </SettingPanel>

                  <SettingPanel label="Speech keys" className="xl:col-span-2">
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
                  </SettingPanel>

                  <SettingPanel label="Voice provider" className="xl:col-span-2">
                    <ChoiceButtons
                      value={voiceSetup.aiProvider}
                      options={(["none", ...USER_VOICE_AI_PROVIDER_ORDER] as const).map(
                        (provider) => ({
                          value: provider,
                          label: getVoiceAiProviderLabel(provider),
                        }),
                      )}
                      disabled={voiceSetup.aiProviderSaving}
                      onChange={(provider) => {
                        void voiceSetup.onAiProviderChange(provider);
                      }}
                    />
                  </SettingPanel>

                  <SettingPanel label="Voice keys" className="xl:col-span-2">
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
                  </SettingPanel>

                  <SettingPanel label="Replies">
                    <div className="flex flex-wrap items-center gap-2">
                      <ChoiceButtons
                        value={voiceSetup.autoSpeakResponses ? "auto" : "manual"}
                        options={[
                          { value: "auto", label: "Auto-read new replies" },
                          { value: "manual", label: "Manual only" },
                        ]}
                        onChange={(value) => {
                          voiceSetup.onAutoSpeakResponsesChange(value === "auto");
                        }}
                      />
                      <Badge className="border-slate-700 bg-slate-950 text-slate-300">
                        {voiceSetup.supported ? "Ready" : "Unavailable"}
                      </Badge>
                    </div>
                  </SettingPanel>

                  {voiceSetup.systemVoicesSupported ? (
                    <>
                      <SettingPanel label="System voice">
                        <select
                          value={voiceSetup.preferredVoiceURI ?? ""}
                          onChange={(event) => {
                            const nextValue = event.target.value.trim();

                            voiceSetup.onPreferredVoiceChange(
                              nextValue.length > 0 ? nextValue : null,
                            );
                          }}
                          className="h-10 w-full rounded-2xl border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition-colors focus:border-sky-500/40"
                        >
                          <option value="">System default</option>
                          {voiceSetup.voiceOptions.map((voice) => (
                            <option key={voice.voiceURI} value={voice.voiceURI}>
                              {voice.label}
                            </option>
                          ))}
                        </select>
                      </SettingPanel>

                      <SettingPanel label="Speech rate">
                        <div className="flex items-center gap-3">
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
                            className="min-w-0 flex-1 accent-sky-400"
                          />
                          <span className="w-12 text-right text-xs text-slate-400">
                            {voiceSetup.rate.toFixed(2)}×
                          </span>
                        </div>
                      </SettingPanel>
                    </>
                  ) : null}
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
              </SettingsCard>
            ) : null}
          </div>
        </ScrollArea>
      </div>
      </div>
    </DialogContent>
  );
};
