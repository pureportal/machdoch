import {
  Bot,
  Check,
  ChevronRight,
  FolderOpen,
  Globe2,
  KeyRound,
  Mic,
  Monitor,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import { DEFAULT_USER_DESKTOP_SETTINGS } from "../../../../core/runtime-contract.generated.js";
import type { RunMode } from "../../../../core/types.js";
import type { ChatSessionRecord } from "../../chat-session.model";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { cn } from "../../lib/utils";
import {
  getCatalogModelsForProvider,
  getDefaultModelForProvider,
  getProviderLabel,
  type ProviderModelCatalogSnapshot,
  type RuntimeProvider,
} from "../../model-catalog";
import {
  loadProviderModelCatalog,
  type RuntimeSnapshot,
  type UserApiKeyProvider,
  type UserDesktopSettings,
} from "../../runtime";
import {
  getWorkspaceLabel,
  RUN_MODE_META,
  RUN_MODE_ORDER,
} from "../_helpers/session-shell";
import type {
  DesktopSettingsControls,
  ProviderSetupControls,
  VoiceSettingsControls,
} from "./settings-dialog-panels/types";

type OnboardingStepId = "connect" | "workspace" | "permissions" | "voice";

interface OnboardingStep {
  id: OnboardingStepId;
  label: string;
  icon: typeof KeyRound;
}

const ONBOARDING_STEPS: OnboardingStep[] = [
  { id: "connect", label: "Connect", icon: KeyRound },
  { id: "workspace", label: "Workspace", icon: FolderOpen },
  { id: "permissions", label: "Control", icon: Monitor },
  { id: "voice", label: "Voice", icon: Mic },
];

export interface OnboardingWizardProps {
  activeSession: ChatSessionRecord;
  chooserProviders: RuntimeProvider[];
  hasAnyProvider: boolean;
  runtimeSnapshot: RuntimeSnapshot | null;
  isUiControlAvailable: boolean;
  uiControlDescription: string;
  providerSetup: ProviderSetupControls;
  desktopSetup: DesktopSettingsControls;
  voiceSetup: VoiceSettingsControls;
  onSelectFolder: () => Promise<void>;
  onSessionModelSelection: (provider: RuntimeProvider, model: string) => void;
  onSessionModeSelection: (mode: RunMode | null) => void;
  onUiControlEnabledChange: (enabled: boolean) => void;
  onSessionProfileSelection: (profile: string | null) => Promise<void>;
  onFinish: () => void;
  onSkip: () => void;
}

const isStepComplete = (
  step: OnboardingStepId,
  options: Pick<
    OnboardingWizardProps,
    "activeSession" | "hasAnyProvider" | "voiceSetup"
  >,
): boolean => {
  switch (step) {
    case "connect":
      return options.hasAnyProvider;
    case "workspace":
      return options.activeSession.workspace !== null;
    case "permissions":
      return true;
    case "voice":
      return (
        options.voiceSetup.speechInputDeviceId !== null ||
        options.voiceSetup.speechInputDevices.length > 0
      );
  }
};

const getStatusLabel = (complete: boolean): string => {
  return complete ? "Set" : "Default";
};

const getPrimaryModelChoices = (
  provider: RuntimeProvider,
  catalog: ProviderModelCatalogSnapshot | null,
) => {
  return getCatalogModelsForProvider(provider, catalog)
    .filter((model) => model.stage !== "deprecated")
    .slice(0, 4);
};

const normalizeShortcutDraft = (draft: UserDesktopSettings): UserDesktopSettings => {
  const quickVoiceShortcut = draft.quickVoiceShortcut.trim();

  return {
    ...draft,
    quickVoiceShortcut:
      quickVoiceShortcut || DEFAULT_USER_DESKTOP_SETTINGS.quickVoiceShortcut,
  };
};

export const OnboardingWizard = ({
  activeSession,
  chooserProviders,
  hasAnyProvider,
  runtimeSnapshot,
  isUiControlAvailable,
  uiControlDescription,
  providerSetup,
  desktopSetup,
  voiceSetup,
  onSelectFolder,
  onSessionModelSelection,
  onSessionModeSelection,
  onUiControlEnabledChange,
  onSessionProfileSelection,
  onFinish,
  onSkip,
}: OnboardingWizardProps): JSX.Element => {
  const [activeStep, setActiveStep] = useState<OnboardingStepId>("connect");
  const [providerModelCatalog, setProviderModelCatalog] =
    useState<ProviderModelCatalogSnapshot | null>(null);
  const [desktopDraft, setDesktopDraft] =
    useState<UserDesktopSettings>(desktopSetup.settings);
  const [savingShortcut, setSavingShortcut] = useState(false);

  useEffect(() => {
    setDesktopDraft(desktopSetup.settings);
  }, [desktopSetup.settings]);

  useEffect(() => {
    let cancelled = false;

    void loadProviderModelCatalog().then((catalog) => {
      if (!cancelled) {
        setProviderModelCatalog(catalog);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (
      activeStep !== "voice" ||
      !voiceSetup.speechInputDevicesSupported ||
      voiceSetup.speechInputDevicesRefreshing ||
      voiceSetup.speechInputDevices.length > 0
    ) {
      return;
    }

    void voiceSetup.onRefreshSpeechInputDevices();
  }, [activeStep, voiceSetup]);

  const providerChoices = chooserProviders.length > 0
    ? chooserProviders
    : (["openai", "anthropic", "google"] satisfies RuntimeProvider[]);
  const activeProvider = activeSession.provider;
  const modelChoices = useMemo(
    () => getPrimaryModelChoices(activeProvider, providerModelCatalog),
    [activeProvider, providerModelCatalog],
  );
  const workspaceLabel = activeSession.workspace
    ? getWorkspaceLabel(activeSession.workspace)
    : "No workspace";
  const activeProfile = activeSession.profile ?? "";
  const activeStepIndex = ONBOARDING_STEPS.findIndex(
    (step) => step.id === activeStep,
  );
  const canGoBack = activeStepIndex > 0;
  const canGoNext = activeStepIndex < ONBOARDING_STEPS.length - 1;

  const selectProvider = (provider: RuntimeProvider): void => {
    providerSetup.onProviderChange(provider as UserApiKeyProvider);
    onSessionModelSelection(provider, getDefaultModelForProvider(provider));
  };

  const saveShortcut = async (): Promise<void> => {
    setSavingShortcut(true);

    try {
      await desktopSetup.onSave(normalizeShortcutDraft(desktopDraft));
    } finally {
      setSavingShortcut(false);
    }
  };

  const renderConnectStep = (): JSX.Element => (
    <div className="grid gap-5">
      <div className="grid gap-2">
        <p className="text-sm font-semibold text-white">Choose a model home</p>
        <div className="flex flex-wrap gap-2">
          {providerChoices.map((provider) => (
            <button
              key={provider}
              type="button"
              aria-pressed={activeProvider === provider}
              onClick={() => selectProvider(provider)}
              className={cn(
                "flex h-9 items-center gap-2 rounded-full border px-3 text-xs font-semibold transition",
                activeProvider === provider
                  ? "border-sky-400/40 bg-sky-400/10 text-sky-100"
                  : "border-slate-800 bg-slate-900/70 text-slate-400 hover:border-slate-700 hover:text-slate-100",
              )}
            >
              {activeProvider === provider ? <Check className="h-3.5 w-3.5" /> : null}
              {getProviderLabel(provider)}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-2">
        <label
          htmlFor="onboarding-provider-key"
          className="text-sm font-semibold text-white"
        >
          API key
        </label>
        <div className="flex gap-2">
          <Input
            id="onboarding-provider-key"
            type="password"
            value={providerSetup.keyValue}
            placeholder={hasAnyProvider ? "Already configured" : "Paste key"}
            autoComplete="off"
            onChange={(event) => providerSetup.onKeyChange(event.target.value)}
            className="h-10 rounded-xl border-slate-800 bg-slate-950 text-slate-100"
          />
          <Button
            type="button"
            variant="outline"
            disabled={providerSetup.saving || !providerSetup.keyValue.trim()}
            onClick={() => {
              void providerSetup.onSave();
            }}
            className="h-10 rounded-xl border-slate-800 bg-slate-900 text-slate-100 hover:bg-slate-800"
          >
            Save
          </Button>
        </div>
        {providerSetup.message ? (
          <p
            className={cn(
              "text-xs",
              providerSetup.message.tone === "success"
                ? "text-emerald-300"
                : "text-rose-300",
            )}
          >
            {providerSetup.message.text}
          </p>
        ) : null}
      </div>
    </div>
  );

  const renderWorkspaceStep = (): JSX.Element => (
    <div className="grid gap-5">
      <div className="grid gap-2">
        <p className="text-sm font-semibold text-white">Workspace</p>
        <button
          type="button"
          onClick={() => {
            void onSelectFolder();
          }}
          className="flex items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3 text-left transition hover:border-sky-500/40 hover:bg-slate-900"
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-slate-100">
              {workspaceLabel}
            </span>
            <span className="block truncate text-xs text-slate-500">
              {activeSession.workspace ?? "Use current defaults until selected"}
            </span>
          </span>
          <FolderOpen className="h-4 w-4 shrink-0 text-sky-300" />
        </button>
      </div>

      <div className="grid gap-2">
        <p className="text-sm font-semibold text-white">Default model</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {modelChoices.map((model) => (
            <button
              key={model.id}
              type="button"
              aria-pressed={activeSession.model === model.id}
              title={model.bestFor}
              onClick={() => onSessionModelSelection(activeProvider, model.id)}
              className={cn(
                "min-h-20 rounded-2xl border px-3 py-3 text-left transition",
                activeSession.model === model.id
                  ? "border-sky-400/40 bg-sky-400/10 text-sky-100"
                  : "border-slate-800 bg-slate-950 text-slate-300 hover:border-slate-700 hover:bg-slate-900",
              )}
            >
              <span className="flex items-center gap-2 text-sm font-semibold">
                <Bot className="h-4 w-4 text-sky-300" />
                {model.label}
              </span>
              <span className="mt-1 line-clamp-2 block text-xs leading-5 text-slate-500">
                {model.bestFor}
              </span>
            </button>
          ))}
        </div>
      </div>

      {runtimeSnapshot?.availableProfiles.length ? (
        <div className="grid gap-2">
          <p className="text-sm font-semibold text-white">Workspace profile</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              aria-pressed={activeProfile === ""}
              onClick={() => {
                void onSessionProfileSelection(null);
              }}
              className={cn(
                "h-8 rounded-full border px-3 text-xs font-semibold",
                activeProfile === ""
                  ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
                  : "border-slate-800 bg-slate-900 text-slate-400",
              )}
            >
              Auto
            </button>
            {runtimeSnapshot.availableProfiles.map((profile) => (
              <button
                key={profile.name}
                type="button"
                aria-pressed={activeProfile === profile.name}
                onClick={() => {
                  void onSessionProfileSelection(profile.name);
                }}
                className={cn(
                  "h-8 rounded-full border px-3 text-xs font-semibold",
                  activeProfile === profile.name
                    ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
                    : "border-slate-800 bg-slate-900 text-slate-400",
                )}
              >
                {profile.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );

  const renderPermissionsStep = (): JSX.Element => (
    <div className="grid gap-5">
      <div className="grid gap-2">
        <p className="text-sm font-semibold text-white">Task mode</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {RUN_MODE_ORDER.map((mode) => {
            const meta = RUN_MODE_META[mode];
            const selected = activeSession.mode === mode;

            return (
              <button
                key={mode}
                type="button"
                aria-pressed={selected}
                onClick={() => onSessionModeSelection(mode)}
                className={cn(
                  "rounded-2xl border px-3 py-3 text-left transition",
                  selected
                    ? meta.selectedClassName
                    : "border-slate-800 bg-slate-950 text-slate-300 hover:border-slate-700 hover:bg-slate-900",
                )}
              >
                <span className="text-sm font-semibold">{meta.label}</span>
                <span className="mt-1 line-clamp-2 block text-xs leading-5 text-slate-500">
                  {meta.description}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-2">
        <p className="text-sm font-semibold text-white">Desktop control</p>
        <button
          type="button"
          disabled={!isUiControlAvailable}
          aria-pressed={activeSession.uiControlEnabled}
          onClick={() => onUiControlEnabledChange(!activeSession.uiControlEnabled)}
          className={cn(
            "rounded-2xl border px-4 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50",
            activeSession.uiControlEnabled
              ? "border-violet-400/30 bg-violet-400/10 text-violet-100"
              : "border-slate-800 bg-slate-950 text-slate-300 hover:border-slate-700 hover:bg-slate-900",
          )}
        >
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Monitor className="h-4 w-4" />
            {activeSession.uiControlEnabled ? "Allowed" : "Ask before desktop actions"}
          </span>
          <span className="mt-1 line-clamp-2 block text-xs leading-5 text-slate-500">
            {uiControlDescription}
          </span>
        </button>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3">
        <span className="flex items-center gap-2 text-sm font-semibold text-slate-100">
          <Globe2 className="h-4 w-4 text-sky-300" />
          Browser profile: fresh per task
        </span>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          Browser sessions start isolated. Ask for a visible session when login or inspection matters.
        </p>
      </div>
    </div>
  );

  const renderVoiceStep = (): JSX.Element => (
    <div className="grid gap-5">
      <div className="grid gap-2">
        <p className="text-sm font-semibold text-white">Voice input</p>
        <div className="flex gap-2">
          <select
            value={voiceSetup.speechInputDeviceId ?? ""}
            disabled={
              !voiceSetup.speechInputDevicesSupported ||
              voiceSetup.speechInputDeviceSaving
            }
            onChange={(event) => {
              void voiceSetup.onSpeechInputDeviceChange(
                event.target.value || null,
              );
            }}
            className="h-10 min-w-0 flex-1 rounded-xl border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-sky-500/50"
          >
            <option value="">System default microphone</option>
            {voiceSetup.speechInputDevices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="outline"
            disabled={voiceSetup.speechInputDevicesRefreshing}
            onClick={() => {
              void voiceSetup.onRefreshSpeechInputDevices();
            }}
            className="h-10 rounded-xl border-slate-800 bg-slate-900 text-slate-100 hover:bg-slate-800"
          >
            Refresh
          </Button>
        </div>
        {voiceSetup.speechInputDeviceMessage ? (
          <p className="text-xs text-rose-300">
            {voiceSetup.speechInputDeviceMessage.text}
          </p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <p className="text-sm font-semibold text-white">Quick Voice shortcut</p>
        <div className="flex gap-2">
          <Input
            value={desktopDraft.quickVoiceShortcut}
            onChange={(event) => {
              setDesktopDraft({
                ...desktopDraft,
                quickVoiceShortcut: event.target.value,
              });
            }}
            placeholder={DEFAULT_USER_DESKTOP_SETTINGS.quickVoiceShortcut}
            className="h-10 rounded-xl border-slate-800 bg-slate-950 text-slate-100"
          />
          <Button
            type="button"
            variant="outline"
            disabled={desktopSetup.saving || savingShortcut}
            onClick={() => {
              void saveShortcut();
            }}
            className="h-10 rounded-xl border-slate-800 bg-slate-900 text-slate-100 hover:bg-slate-800"
          >
            Save
          </Button>
        </div>
      </div>

      <button
        type="button"
        aria-pressed={desktopDraft.quickVoiceEnabled}
        onClick={() => {
          const nextDraft = {
            ...desktopDraft,
            quickVoiceEnabled: !desktopDraft.quickVoiceEnabled,
          };

          setDesktopDraft(nextDraft);
          void desktopSetup.onSave(normalizeShortcutDraft(nextDraft));
        }}
        className={cn(
          "rounded-2xl border px-4 py-3 text-left transition",
          desktopDraft.quickVoiceEnabled
            ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
            : "border-slate-800 bg-slate-950 text-slate-300 hover:border-slate-700 hover:bg-slate-900",
        )}
      >
        <span className="text-sm font-semibold">
          Quick Voice {desktopDraft.quickVoiceEnabled ? "enabled" : "disabled"}
        </span>
        <span className="mt-1 block text-xs leading-5 text-slate-500">
          Shortcut submits spoken prompts without opening the full window.
        </span>
      </button>
    </div>
  );

  const renderStep = (): JSX.Element => {
    switch (activeStep) {
      case "connect":
        return renderConnectStep();
      case "workspace":
        return renderWorkspaceStep();
      case "permissions":
        return renderPermissionsStep();
      case "voice":
        return renderVoiceStep();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      className="absolute inset-0 z-[70] flex items-center justify-center bg-slate-950/92 px-4 py-6 backdrop-blur-xl"
    >
      <div className="grid h-full max-h-[760px] w-full max-w-5xl overflow-hidden rounded-3xl border border-slate-800 bg-slate-950 shadow-2xl shadow-sky-950/40 md:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="border-b border-slate-800 bg-slate-950/90 p-5 md:border-b-0 md:border-r">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl border border-sky-500/20 bg-sky-500/10 text-sky-200">
              <Sparkles className="h-5 w-5" />
            </span>
            <div>
              <h2 id="onboarding-title" className="text-base font-semibold text-white">
                Start clean
              </h2>
              <p className="text-xs text-slate-500">Defaults are ready.</p>
            </div>
          </div>

          <div className="mt-6 grid gap-2">
            {ONBOARDING_STEPS.map((step) => {
              const Icon = step.icon;
              const active = activeStep === step.id;
              const complete = isStepComplete(step.id, {
                activeSession,
                hasAnyProvider,
                voiceSetup,
              });

              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => setActiveStep(step.id)}
                  className={cn(
                    "flex items-center justify-between gap-3 rounded-2xl border px-3 py-3 text-left transition",
                    active
                      ? "border-sky-500/30 bg-sky-500/10 text-sky-100"
                      : "border-transparent text-slate-400 hover:border-slate-800 hover:bg-slate-900/70 hover:text-slate-100",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="truncate text-sm font-semibold">
                      {step.label}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                      complete
                        ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-200"
                        : "border-slate-800 bg-slate-900 text-slate-500",
                    )}
                  >
                    {getStatusLabel(complete)}
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="flex min-h-0 flex-col">
          <header className="flex items-center justify-between gap-3 border-b border-slate-800 px-6 py-5">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-300">
                Introduction
              </p>
              <p className="mt-1 text-2xl font-semibold tracking-tight text-white">
                {ONBOARDING_STEPS.find((step) => step.id === activeStep)?.label}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              onClick={onSkip}
              className="rounded-full text-slate-400 hover:bg-slate-900 hover:text-slate-100"
            >
              Use defaults
            </Button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
            {renderStep()}
          </div>

          <footer className="flex items-center justify-between gap-3 border-t border-slate-800 px-6 py-4">
            <Button
              type="button"
              variant="ghost"
              disabled={!canGoBack}
              onClick={() => {
                setActiveStep(ONBOARDING_STEPS[activeStepIndex - 1]?.id ?? "connect");
              }}
              className="rounded-full text-slate-400 hover:bg-slate-900 hover:text-slate-100"
            >
              Back
            </Button>
            {canGoNext ? (
              <Button
                type="button"
                onClick={() => {
                  setActiveStep(
                    ONBOARDING_STEPS[activeStepIndex + 1]?.id ?? "voice",
                  );
                }}
                className="rounded-full bg-sky-500 px-5 text-slate-950 hover:bg-sky-400"
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                type="button"
                onClick={onFinish}
                className="rounded-full bg-emerald-400 px-5 text-slate-950 hover:bg-emerald-300"
              >
                Finish
                <Check className="h-4 w-4" />
              </Button>
            )}
          </footer>
        </section>
      </div>
    </div>
  );
};
