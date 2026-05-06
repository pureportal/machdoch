import {
  ArrowUpRight,
  Brain,
  Eye,
  EyeOff,
  KeyRound,
  Monitor,
  RefreshCw,
  Search,
  Volume2,
  type LucideIcon,
} from "lucide-react";
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
  type VoiceAiProvider,
  type VoiceProviderAvailability,
  type UserWebSearchApiKeyProvider,
  type WebSearchProvider,
} from "../../runtime";
import type { ChatSessionVoiceOption } from "../_helpers/use-chat-session-voice";
import type { SpeechInputDeviceOption } from "../_helpers/speech-audio";
import {
  SETTINGS_SECTIONS,
  getWebSearchProviderLabel,
  type SettingsSection,
} from "../_helpers/session-shell.ts";

const SETTINGS_SECTION_ICONS: Record<SettingsSection, LucideIcon> = {
  providers: KeyRound,
  "web-search": Search,
  voice: Volume2,
  memory: Brain,
  desktop: Monitor,
};

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

const getSpeechToTextProviderLabel = (
  provider: SpeechToTextProvider,
): string => {
  return provider === "none" ? "Disabled" : getProviderLabel(provider);
};

const getVoiceAiProviderLabel = (provider: VoiceAiProvider): string => {
  return provider === "none" ? "System voices only" : getProviderLabel(provider);
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
        "grid content-start",
        className,
      )}
    >
      <div className="grid gap-1 border-b border-slate-800/80 pb-4">
        <h3 className="text-base font-semibold text-slate-100">{title}</h3>
        {description ? (
          <p className="text-sm leading-6 text-slate-400">{description}</p>
        ) : null}
      </div>
      <div className="grid gap-0">{children}</div>
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
      data-setting-panel
      className={cn(
        "grid gap-3 border-b border-slate-800/75 py-4 last:border-b-0 md:grid-cols-[12rem_minmax(0,1fr)] md:items-center",
        className,
      )}
    >
      <div className="grid gap-1">
        <p className="text-sm font-medium text-slate-300">
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
  disabled?: boolean;
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
    <div className="inline-flex max-w-full flex-nowrap overflow-x-auto rounded-md border border-slate-800 bg-slate-950/90 p-0.5 [scrollbar-width:thin]">
      {options.map((option) => {
        const selected = value === option.value;

        return (
          <Button
            key={option.value}
            type="button"
            variant="outline"
            aria-label={option.ariaLabel}
            aria-pressed={selected}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "h-8 shrink-0 rounded-[5px] border-transparent bg-transparent px-3 text-xs text-slate-300 shadow-none hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100 disabled:opacity-40",
              selected &&
                "border-sky-500/30 bg-sky-500/15 text-sky-100 hover:bg-sky-500/20",
            )}
          >
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}

const SettingsStatus = ({
  message,
}: {
  message: SettingsStatusMessage | null;
}): JSX.Element | null => {
  if (!message) {
    return null;
  }

  return (
    <p
      className={cn(
        "rounded-lg border px-3 py-2 text-sm leading-5",
        message.tone === "error"
          ? "border-rose-500/20 bg-rose-500/10 text-rose-200"
          : "border-emerald-500/20 bg-emerald-500/10 text-emerald-200",
      )}
    >
      {message.text}
    </p>
  );
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

const DEFAULT_QUICK_VOICE_SHORTCUT = "CommandOrControl+Alt+V";

const clampFiniteNumber = (
  value: number,
  min: number,
  max: number,
  fallback: number,
): number => {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
};

const clampIntegerSetting = (
  value: number,
  min: number,
  max: number,
  fallback: number,
): number => {
  return Math.round(clampFiniteNumber(value, min, max, fallback));
};

const clampDecimalSetting = (
  value: number,
  min: number,
  max: number,
  fallback: number,
  decimals: number,
): number => {
  const clampedValue = clampFiniteNumber(value, min, max, fallback);

  return Number(clampedValue.toFixed(decimals));
};

const parseIntegerSettingInput = (
  value: string,
  min: number,
  max: number,
  fallback: number,
): number => {
  return clampIntegerSetting(Number(value), min, max, fallback);
};

const parseDecimalSettingInput = (
  value: string,
  min: number,
  max: number,
  fallback: number,
  decimals: number,
): number => {
  return clampDecimalSetting(Number(value), min, max, fallback, decimals);
};

const normalizeDesktopSettingsDraft = (
  settings: UserDesktopSettings,
): UserDesktopSettings => {
  const quickVoiceShortcut = settings.quickVoiceShortcut.trim();

  return {
    ...settings,
    assistantBubbleTemporarilyHideSeconds: clampIntegerSetting(
      settings.assistantBubbleTemporarilyHideSeconds,
      2,
      30,
      6,
    ),
    aiContextMaxMessages: clampIntegerSetting(
      settings.aiContextMaxMessages,
      1,
      200,
      60,
    ),
    quickVoiceShortcut: quickVoiceShortcut || DEFAULT_QUICK_VOICE_SHORTCUT,
    quickVoiceSilenceSeconds: clampDecimalSetting(
      settings.quickVoiceSilenceSeconds,
      0.8,
      8,
      1.8,
      1,
    ),
    quickVoiceMaxMessages: clampIntegerSetting(
      settings.quickVoiceMaxMessages,
      10,
      200,
      50,
    ),
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
    left.aiContextMaxMessages !== right.aiContextMaxMessages ||
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
  const [providerKeyVisible, setProviderKeyVisible] = useState(false);
  const [webSearchKeyVisible, setWebSearchKeyVisible] = useState(false);

  useEffect(() => {
    setDesktopDraft(desktopSetup.settings);
  }, [desktopSetup.settings]);

  useEffect(() => {
    setProviderKeyVisible(false);
  }, [providerSetup.provider]);

  useEffect(() => {
    setWebSearchKeyVisible(false);
  }, [webSearchSetup.provider]);

  const desktopAutostartMode = getDesktopAutostartMode(desktopDraft);
  const desktopDraftDirty = hasDesktopSettingsDraftChanges(
    desktopDraft,
    desktopSetup.settings,
  );
  const selectedProviderLabel = getProviderLabel(providerSetup.provider);
  const selectedWebSearchProviderLabel = getWebSearchProviderLabel(
    webSearchSetup.provider,
  );
  const speechToTextProviderConfigured = new Map(
    voiceSetup.speechToTextProviderAvailability.map((provider) => [
      provider.provider,
      provider.configured,
    ]),
  );
  const aiVoiceProviderConfigured = new Map(
    voiceSetup.aiProviderAvailability.map((provider) => [
      provider.provider,
      provider.configured,
    ]),
  );
  const selectedSpeechInputDeviceMissing =
    voiceSetup.speechInputDeviceId !== null &&
    !voiceSetup.speechInputDevices.some(
      (device) => device.deviceId === voiceSetup.speechInputDeviceId,
    );

  return (
    <DialogContent className="max-h-[min(720px,calc(100vh-28px))] w-[min(980px,calc(100vw-28px))] max-w-none gap-0 overflow-hidden rounded-xl border-slate-800 bg-slate-950 p-0 text-slate-100 shadow-2xl sm:max-w-none">
      <div className="flex max-h-[min(720px,calc(100vh-28px))] min-h-[420px] flex-col overflow-hidden">
        <DialogHeader className="border-b border-slate-800/80 px-5 py-4 pr-12 text-left">
          <DialogTitle className="text-xl font-semibold text-white">
            Settings
          </DialogTitle>
          <DialogDescription className="sr-only">
            Configure providers, web search, voice, memory, and desktop behavior.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 overflow-hidden md:grid-cols-[12rem_minmax(0,1fr)]">
          <nav className="border-b border-slate-800/80 bg-slate-950/80 px-3 py-3 md:border-r md:border-b-0">
            <div className="flex gap-1 overflow-x-auto md:grid md:overflow-visible">
              {SETTINGS_SECTIONS.map((section) => {
                const SectionIcon = SETTINGS_SECTION_ICONS[section.id];

                return (
                  <Button
                    key={section.id}
                    type="button"
                    variant="ghost"
                    onClick={() => onSettingsSectionChange(section.id)}
                    className={cn(
                      "h-9 shrink-0 justify-start rounded-lg border border-transparent bg-transparent px-3 text-sm text-slate-400 hover:border-slate-800 hover:bg-slate-900/70 hover:text-slate-100 md:w-full",
                      settingsSection === section.id &&
                        "border-sky-500/25 bg-sky-500/10 text-sky-100",
                    )}
                  >
                    <SectionIcon className="h-4 w-4" />
                    <span>{section.label}</span>
                  </Button>
                );
              })}
            </div>
          </nav>

          <ScrollArea
            className="min-h-0 flex-1 [&_[data-slot=scroll-area-scrollbar]]:w-3 [&_[data-slot=scroll-area-scrollbar]]:border-l [&_[data-slot=scroll-area-scrollbar]]:border-l-slate-800 [&_[data-slot=scroll-area-scrollbar]]:bg-slate-950/80 [&_[data-slot=scroll-area-thumb]]:bg-slate-600/80 [&_[data-slot=scroll-area-thumb]]:hover:bg-slate-500"
            type="always"
          >
            <div className="grid content-start gap-5 px-6 py-5 pr-10">
              {settingsSection === "providers" ? (
                <SettingsCard title="Model provider keys">
                  <SettingPanel label="Provider">
                    <ChoiceButtons
                      value={providerSetup.provider}
                      options={USER_API_KEY_PROVIDER_ORDER.map((provider) => ({
                        value: provider,
                        label: getProviderLabel(provider),
                      }))}
                      onChange={providerSetup.onProviderChange}
                    />
                  </SettingPanel>

                  <SettingPanel label={`${selectedProviderLabel} API key`}>
                    <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                      <Input
                        type={providerKeyVisible ? "text" : "password"}
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
                        placeholder={`Paste your ${selectedProviderLabel} API key`}
                        autoComplete="off"
                        spellCheck={false}
                        className="h-10 rounded-lg border-slate-800 bg-slate-950 text-slate-100 placeholder:text-slate-500"
                      />
                      <div className="flex items-center gap-2 md:justify-end">
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          aria-label={`${providerKeyVisible ? "Hide" : "Show"} ${selectedProviderLabel} API key`}
                          title={`${providerKeyVisible ? "Hide" : "Show"} ${selectedProviderLabel} API key`}
                          onClick={() =>
                            setProviderKeyVisible((visible) => !visible)
                          }
                          disabled={!providerSetup.keyValue.trim()}
                          className="h-10 w-10 rounded-lg border-slate-800 bg-slate-950 text-slate-300 hover:bg-slate-900 hover:text-slate-100 disabled:opacity-40"
                        >
                          {providerKeyVisible ? (
                            <EyeOff className="h-4 w-4" />
                          ) : (
                            <Eye className="h-4 w-4" />
                          )}
                        </Button>
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
                          className="h-10 w-10 rounded-lg border border-slate-800 bg-slate-950 text-slate-400 hover:bg-slate-900 hover:text-slate-100"
                        >
                          <ArrowUpRight className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          onClick={() => {
                            void providerSetup.onSave();
                          }}
                          disabled={
                            !providerSetup.keyValue.trim() ||
                            providerSetup.saving
                          }
                          className="h-10 rounded-lg bg-sky-600 px-4 text-sm text-white hover:bg-sky-500 disabled:opacity-40"
                        >
                          {providerSetup.saving ? "Saving..." : "Save key"}
                        </Button>
                      </div>
                    </div>
                  </SettingPanel>

                  <SettingsStatus message={providerSetup.message} />
                </SettingsCard>
            ) : null}

            {settingsSection === "web-search" ? (
              <SettingsCard title="Web search">
                <SettingPanel label="Active web search provider">
                  <ChoiceButtons
                    value={webSearchSetup.activeProvider}
                    options={(
                      ["none", ...USER_WEB_SEARCH_PROVIDER_ORDER] as const
                    ).map((provider) => ({
                      value: provider,
                      label: getWebSearchProviderLabel(provider),
                    }))}
                    disabled={webSearchSetup.saving}
                    onChange={(provider) => {
                      void webSearchSetup.onActiveProviderChange(provider);
                    }}
                  />
                </SettingPanel>

                <SettingPanel label="API keys">
                  <ChoiceButtons
                    value={webSearchSetup.provider}
                    options={USER_WEB_SEARCH_PROVIDER_ORDER.map((provider) => ({
                      value: provider,
                      label: getWebSearchProviderLabel(provider),
                    }))}
                    onChange={webSearchSetup.onProviderChange}
                  />
                </SettingPanel>

                <SettingPanel label={`${selectedWebSearchProviderLabel} API key`}>
                  <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                    <Input
                      type={webSearchKeyVisible ? "text" : "password"}
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
                      placeholder={`Paste your ${selectedWebSearchProviderLabel} API key`}
                      autoComplete="off"
                      spellCheck={false}
                      className="h-10 rounded-lg border-slate-800 bg-slate-950 text-slate-100 placeholder:text-slate-500"
                    />
                    <div className="flex items-center gap-2 md:justify-end">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label={`${webSearchKeyVisible ? "Hide" : "Show"} ${selectedWebSearchProviderLabel} API key`}
                        title={`${webSearchKeyVisible ? "Hide" : "Show"} ${selectedWebSearchProviderLabel} API key`}
                        onClick={() =>
                          setWebSearchKeyVisible((visible) => !visible)
                        }
                        disabled={!webSearchSetup.keyValue.trim()}
                        className="h-10 w-10 rounded-lg border-slate-800 bg-slate-950 text-slate-300 hover:bg-slate-900 hover:text-slate-100 disabled:opacity-40"
                      >
                        {webSearchKeyVisible ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </Button>
                      <Button
                        type="button"
                        onClick={() => {
                          void webSearchSetup.onSave();
                        }}
                        disabled={
                          !webSearchSetup.keyValue.trim() ||
                          webSearchSetup.saving
                        }
                        className="h-10 rounded-lg bg-sky-600 px-4 text-sm text-white hover:bg-sky-500 disabled:opacity-40"
                      >
                        {webSearchSetup.saving ? "Saving..." : "Save key"}
                      </Button>
                    </div>
                  </div>
                </SettingPanel>

                <SettingsStatus message={webSearchSetup.message} />
              </SettingsCard>
            ) : null}

            {settingsSection === "memory" ? (
              <SettingsCard title="Global memory">
                <SettingPanel label="Status">
                  <div className="flex flex-wrap items-center gap-2">
                    <ChoiceButtons
                      value={
                        memorySetup.settings.globalEnabled
                          ? "enabled"
                          : "disabled"
                      }
                      options={[
                        { value: "enabled", label: "Enabled" },
                        { value: "disabled", label: "Disabled" },
                      ]}
                      disabled={memorySetup.saving}
                      onChange={(value) => {
                        void memorySetup.onGlobalEnabledChange(
                          value === "enabled",
                        );
                      }}
                    />
                    <Badge className="h-8 rounded-md border-slate-700 bg-slate-950 px-3 text-slate-300">
                      {memorySetup.settings.entries.length} saved fact
                      {memorySetup.settings.entries.length === 1 ? "" : "s"}
                    </Badge>
                  </div>
                </SettingPanel>

                {memorySetup.settings.entries.length > 0 ? (
                  <div className="grid gap-2">
                    {memorySetup.settings.entries.map((entry) => (
                      <div
                        key={entry.id}
                        className="rounded-lg border border-slate-800 bg-slate-950 px-4 py-3 text-sm leading-6 text-slate-300"
                      >
                        {entry.content}
                      </div>
                    ))}
                  </div>
                ) : null}

                <SettingsStatus message={memorySetup.message} />
              </SettingsCard>
            ) : null}

            {settingsSection === "desktop" ? (
              <SettingsCard title="Desktop assistant">
                <div className="grid gap-0">
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
                          assistantBubbleTemporarilyHideSeconds: parseIntegerSettingInput(
                            event.target.value,
                            2,
                            30,
                            desktopDraft.assistantBubbleTemporarilyHideSeconds,
                          ),
                        });
                      }}
                      className="h-10 max-w-28 rounded-lg border-slate-800 bg-slate-950 text-slate-100"
                    />
                  </SettingPanel>

                  <SettingPanel label="AI context cap">
                    <Input
                      type="number"
                      min="1"
                      max="200"
                      step="1"
                      value={desktopDraft.aiContextMaxMessages}
                      onChange={(event) => {
                        setDesktopDraft({
                          ...desktopDraft,
                          aiContextMaxMessages: parseIntegerSettingInput(
                            event.target.value,
                            1,
                            200,
                            desktopDraft.aiContextMaxMessages,
                          ),
                        });
                      }}
                      className="h-10 max-w-28 rounded-lg border-slate-800 bg-slate-950 text-slate-100"
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
                      className="h-10 rounded-lg border-slate-800 bg-slate-950 text-slate-100"
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
                          quickVoiceSilenceSeconds: parseDecimalSettingInput(
                            event.target.value,
                            0.8,
                            8,
                            desktopDraft.quickVoiceSilenceSeconds,
                            1,
                          ),
                        });
                      }}
                      className="h-10 max-w-28 rounded-lg border-slate-800 bg-slate-950 text-slate-100"
                    />
                  </SettingPanel>

                  <SettingPanel label="Quick Chat cap">
                    <Input
                      type="number"
                      min="10"
                      max="200"
                      step="5"
                      value={desktopDraft.quickVoiceMaxMessages}
                      onChange={(event) => {
                        setDesktopDraft({
                          ...desktopDraft,
                          quickVoiceMaxMessages: parseIntegerSettingInput(
                            event.target.value,
                            10,
                            200,
                            desktopDraft.quickVoiceMaxMessages,
                          ),
                        });
                      }}
                      className="h-10 max-w-28 rounded-lg border-slate-800 bg-slate-950 text-slate-100"
                    />
                  </SettingPanel>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4">
                  <p className="text-sm leading-6 text-slate-400">
                    {desktopDraftDirty ? "Unsaved desktop changes" : "Desktop settings are up to date"}
                  </p>
                  <Button
                    type="button"
                    onClick={() => {
                      void desktopSetup.onSave(
                        normalizeDesktopSettingsDraft(desktopDraft),
                      );
                    }}
                    disabled={desktopSetup.saving || !desktopDraftDirty}
                    className="h-10 rounded-lg bg-sky-600 px-4 text-sm text-white hover:bg-sky-500 disabled:opacity-40"
                  >
                    {desktopSetup.saving ? "Saving..." : "Save desktop settings"}
                  </Button>
                </div>

                <SettingsStatus message={desktopSetup.message} />
              </SettingsCard>
            ) : null}

            {settingsSection === "voice" ? (
              <SettingsCard title="Voice">
                <div className="grid gap-0">
                  <SettingPanel label="Speak to text">
                    <ChoiceButtons
                      value={voiceSetup.speechToTextProvider}
                      options={([
                        "none",
                        ...USER_SPEECH_TO_TEXT_PROVIDER_ORDER,
                      ] as const).map((provider) => ({
                        value: provider,
                        label: getSpeechToTextProviderLabel(provider),
                        ariaLabel: `Speak to text provider ${getSpeechToTextProviderLabel(provider)}`,
                        disabled:
                          provider !== "none" &&
                          !speechToTextProviderConfigured.get(provider),
                      }))}
                      disabled={voiceSetup.speechToTextProviderSaving}
                      onChange={(provider) => {
                        void voiceSetup.onSpeechToTextProviderChange(provider);
                      }}
                    />
                  </SettingPanel>

                  <SettingPanel label="Input device">
                    <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                      <select
                        aria-label="Voice input device"
                        value={voiceSetup.speechInputDeviceId ?? ""}
                        disabled={
                          !voiceSetup.speechInputDevicesSupported ||
                          voiceSetup.speechInputDeviceSaving
                        }
                        onChange={(event) => {
                          const nextValue = event.target.value.trim();

                          void voiceSetup.onSpeechInputDeviceChange(
                            nextValue.length > 0 ? nextValue : null,
                          );
                        }}
                        className="h-10 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition-colors focus:border-sky-500/40 disabled:opacity-50"
                      >
                        <option value="">System default</option>
                        {selectedSpeechInputDeviceMissing ? (
                          <option value={voiceSetup.speechInputDeviceId ?? ""}>
                            Selected microphone unavailable
                          </option>
                        ) : null}
                        {voiceSetup.speechInputDevices.map((device) => (
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
                        title="Refresh microphone devices"
                        onClick={() => {
                          void voiceSetup.onRefreshSpeechInputDevices();
                        }}
                        disabled={
                          !voiceSetup.speechInputDevicesSupported ||
                          voiceSetup.speechInputDevicesRefreshing
                        }
                        className="h-10 w-10 rounded-lg border-slate-800 bg-slate-950 text-slate-300 hover:bg-slate-900 hover:text-slate-100 disabled:opacity-40"
                      >
                        <RefreshCw
                          className={cn(
                            "h-4 w-4",
                            voiceSetup.speechInputDevicesRefreshing &&
                              "animate-spin",
                          )}
                        />
                      </Button>
                    </div>
                  </SettingPanel>

                  <SettingPanel label="Voice provider">
                    <ChoiceButtons
                      value={voiceSetup.aiProvider}
                      options={(["none", ...USER_VOICE_AI_PROVIDER_ORDER] as const).map(
                        (provider) => ({
                          value: provider,
                          label: getVoiceAiProviderLabel(provider),
                          disabled:
                            provider !== "none" &&
                            !aiVoiceProviderConfigured.get(provider),
                        }),
                      )}
                      disabled={voiceSetup.aiProviderSaving}
                      onChange={(provider) => {
                        void voiceSetup.onAiProviderChange(provider);
                      }}
                    />
                  </SettingPanel>

                  <SettingPanel label="Replies">
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
                          className="h-10 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition-colors focus:border-sky-500/40"
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
                            {voiceSetup.rate.toFixed(2)}x
                          </span>
                        </div>
                      </SettingPanel>
                    </>
                  ) : null}
                </div>

                <SettingsStatus message={voiceSetup.speechToTextProviderMessage} />
                <SettingsStatus message={voiceSetup.speechInputDeviceMessage} />
                <SettingsStatus message={voiceSetup.aiProviderMessage} />
              </SettingsCard>
            ) : null}
          </div>
        </ScrollArea>
      </div>
      </div>
    </DialogContent>
  );
};
