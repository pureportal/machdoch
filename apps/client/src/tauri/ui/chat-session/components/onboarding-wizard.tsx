import { FolderOpen, Sparkles } from "lucide-react";
import { useMemo, useRef, type JSX } from "react";
import type { RunMode } from "../../../../core/runtime-contract.generated.js";
import type { ChatSessionRecord } from "../../chat-session.model";
import { Button } from "../../components/ui/button";
import { useOptionalRegisterCommands } from "../../commands/command-context";
import {
  asPaletteCommands,
  type CommandDefinition,
  type CommandPageItem,
} from "../../commands/command-types";
import { Dialog } from "../../components/ui/dialog";
import type { RuntimeProvider } from "../../model-catalog";
import {
  USER_API_KEY_PROVIDER_ORDER,
  type UserApiKeyProvider,
} from "../../runtime";
import {
  getWorkspaceLabel,
  RUN_MODE_META,
  RUN_MODE_ORDER,
  type SettingsSection,
} from "../_helpers/session-shell";
import { SettingsDialog, type SettingsControlsProps } from "./settings-dialog";
import { SessionModelPicker } from "./session-model-picker";
import {
  ChoiceButtons,
  SettingPanel,
  SettingsCard,
} from "./settings-dialog-panels/shared";

type OnboardingModeChoice = RunMode | "default";

export interface OnboardingWizardProps extends SettingsControlsProps {
  settingsSection: SettingsSection;
  onSettingsSectionChange: (section: SettingsSection) => void;
  activeSession: ChatSessionRecord;
  chooserProviders: RuntimeProvider[];
  hasAnyProvider: boolean;
  isUiControlAvailable: boolean;
  uiControlDescription: string;
  onSelectFolder: () => Promise<void>;
  onSessionModelSelection: (provider: RuntimeProvider, model: string) => void;
  onSessionModeSelection: (mode: RunMode | null) => void;
  onUiControlEnabledChange: (enabled: boolean) => void;
  onFinish: () => Promise<void> | void;
  onSkip: () => Promise<void> | void;
}

const getSettingsSavePending = ({
  providerSetup,
  workspaceSetup,
  webSearchSetup,
  mcpSetup,
  agentLimitsSetup,
  appearanceSetup,
  memorySetup,
  desktopSetup,
  workspaceRunSetup,
  voiceSetup,
}: SettingsControlsProps): boolean => {
  return (
    providerSetup.saving ||
    workspaceSetup.saving ||
    webSearchSetup.saving ||
    mcpSetup.saving ||
    agentLimitsSetup.saving ||
    appearanceSetup.saving ||
    memorySetup.saving ||
    desktopSetup.saving ||
    workspaceRunSetup.saving ||
    voiceSetup.speechToTextProviderSaving ||
    voiceSetup.speechInputDeviceSaving ||
    voiceSetup.aiProviderSaving
  );
};

export const OnboardingWizard = ({
  settingsSection,
  onSettingsSectionChange,
  activeSession,
  chooserProviders,
  hasAnyProvider,
  isUiControlAvailable,
  uiControlDescription,
  onSelectFolder,
  onSessionModelSelection,
  onSessionModeSelection,
  onUiControlEnabledChange,
  onFinish,
  onSkip,
  ...settingsControls
}: OnboardingWizardProps): JSX.Element => {
  const providerChoices = useMemo<RuntimeProvider[]>(() => {
    const availableProviders =
      chooserProviders.length > 0
        ? chooserProviders
        : (["openai", "anthropic", "google"] satisfies RuntimeProvider[]);

    return [...new Set([activeSession.provider, ...availableProviders])];
  }, [activeSession.provider, chooserProviders]);
  const workspaceLabel = activeSession.workspace
    ? getWorkspaceLabel(activeSession.workspace)
    : "Choose folder";
  const selectedSessionMode: OnboardingModeChoice =
    activeSession.mode ?? "default";
  const settingsSavePending = getSettingsSavePending(settingsControls);

  const selectSessionModel = (
    provider: RuntimeProvider,
    model: string,
  ): void => {
    if (USER_API_KEY_PROVIDER_ORDER.includes(provider as UserApiKeyProvider)) {
      settingsControls.providerSetup.onProviderChange(
        provider as UserApiKeyProvider,
      );
    }

    onSessionModelSelection(provider, model);
  };

  const onboardingCommandStateRef = useRef({
    activeSession,
    settingsSavePending,
    isUiControlAvailable,
    onSelectFolder,
    onSessionModeSelection,
    onUiControlEnabledChange,
  });
  onboardingCommandStateRef.current = {
    activeSession,
    settingsSavePending,
    isUiControlAvailable,
    onSelectFolder,
    onSessionModeSelection,
    onUiControlEnabledChange,
  };
  const onboardingCommands = useMemo<readonly CommandDefinition[]>(() => {
    const state = () => onboardingCommandStateRef.current;
    const scope = { kind: "overlay", ownerId: "settings-dialog" } as const;
    const numericKey = (index: number): CommandPageItem["numericKey"] =>
      index < 9 ? (`${index + 1}` as CommandPageItem["numericKey"]) : undefined;
    return asPaletteCommands([
      {
        id: "onboarding.workspace.select",
        title: "Choose first session workspace",
        group: "First session",
        scope,
        availability: () =>
          state().settingsSavePending
            ? { state: "disabled", reason: "Settings are being saved." }
            : { state: "enabled" },
        execute: () => void state().onSelectFolder(),
      },
      {
        id: "onboarding.session.mode.select",
        title: "Choose first session mode",
        group: "First session",
        scope,
        children: () => ({
          id: "onboarding.session.mode.select.page",
          title: "Choose first session mode",
          searchPlaceholder: "Search modes",
          numericSelection: true,
          groups: [
            {
              id: "modes",
              items: ([null, ...RUN_MODE_ORDER] as const).map(
                (mode, index) => ({
                  id: mode ?? "default",
                  title: mode ? RUN_MODE_META[mode].label : "Workspace default",
                  current:
                    mode === null
                      ? state().activeSession.mode == null
                      : state().activeSession.mode === mode,
                  numericKey: numericKey(index),
                  execute: () => state().onSessionModeSelection(mode),
                }),
              ),
            },
          ],
        }),
      },
      {
        id: "onboarding.desktop-control.select",
        title: "Choose first session desktop control",
        group: "First session",
        scope,
        children: () => ({
          id: "onboarding.desktop-control.select.page",
          title: "Choose first session desktop control",
          searchPlaceholder: "Search options",
          numericSelection: true,
          groups: [
            {
              id: "options",
              items: [
                {
                  id: "disabled",
                  title: "Ask first",
                  current: !state().activeSession.uiControlEnabled,
                  numericKey: "1",
                  execute: () => state().onUiControlEnabledChange(false),
                },
                {
                  id: "enabled",
                  title: "Allow",
                  current: state().activeSession.uiControlEnabled,
                  numericKey: "2",
                  availability: state().isUiControlAvailable
                    ? { state: "enabled" }
                    : {
                        state: "disabled",
                        reason: "Desktop control is unavailable.",
                      },
                  execute: () => state().onUiControlEnabledChange(true),
                },
              ],
            },
          ],
        }),
      },
    ]);
  }, []);
  useOptionalRegisterCommands(onboardingCommands);

  const preparePanel = (
    <SettingsCard
      title="First session"
      description="Choose a workspace and starting behavior."
    >
      <SettingPanel
        label="Workspace"
        detail={activeSession.workspace ?? "No folder selected."}
      >
        <Button
          type="button"
          variant="outline"
          aria-label={`Choose workspace. Current: ${
            activeSession.workspace ?? "none"
          }`}
          onClick={() => {
            void onSelectFolder();
          }}
          className="h-10 max-w-full justify-start rounded-lg border-slate-800 bg-slate-950 text-slate-100 hover:bg-slate-900"
        >
          <FolderOpen className="size-4 shrink-0 text-sky-300" />
          <span className="truncate">{workspaceLabel}</span>
        </Button>
      </SettingPanel>

      <SettingPanel
        label="Session model"
        detail={
          hasAnyProvider
            ? "Choose from connected providers."
            : "Add an API key in Providers."
        }
      >
        <SessionModelPicker
          chooserProviders={providerChoices}
          activeProvider={activeSession.provider}
          activeModel={activeSession.model}
          onSessionModelSelection={selectSessionModel}
          registerCommand={false}
        />
      </SettingPanel>

      <SettingPanel
        label="Session mode"
        detail={
          activeSession.mode === null || activeSession.mode === undefined
            ? `Workspace default: ${
                RUN_MODE_META[settingsControls.workspaceSetup.effectiveMode]
                  .label
              }`
            : undefined
        }
      >
        <ChoiceButtons
          label="First session mode"
          value={selectedSessionMode}
          options={[
            { value: "default", label: "Workspace default" },
            ...RUN_MODE_ORDER.map((mode) => ({
              value: mode,
              label: RUN_MODE_META[mode].label,
            })),
          ]}
          onChange={(mode) =>
            onSessionModeSelection(mode === "default" ? null : mode)
          }
        />
      </SettingPanel>

      <SettingPanel label="Desktop control" detail={uiControlDescription}>
        <ChoiceButtons
          label="Desktop control"
          value={activeSession.uiControlEnabled ? "enabled" : "disabled"}
          options={[
            { value: "disabled", label: "Ask first" },
            {
              value: "enabled",
              label: "Allow",
              disabled: !isUiControlAvailable,
              title: isUiControlAvailable
                ? undefined
                : "Desktop control is unavailable in this environment.",
            },
          ]}
          onChange={(value) => onUiControlEnabledChange(value === "enabled")}
        />
      </SettingPanel>
    </SettingsCard>
  );

  return (
    <Dialog
      open
      commandOverlayId="settings-dialog"
      commandOverlayAllowGlobalCommands={["app.palette.toggle"]}
    >
      <SettingsDialog
        {...settingsControls}
        settingsSection={settingsSection}
        onSettingsSectionChange={onSettingsSectionChange}
        onClose={onSkip}
        title="Prepare Machdoch"
        description="Configure Machdoch before the first session."
        closeLabel="Skip first-startup setup"
        closeText="Skip setup"
        closeDiscardLabel="Discard changes and skip setup"
        introSection={{
          label: "Start",
          description:
            "Choose the workspace and behavior for your first session.",
          keywords: ["first", "startup", "folder", "model", "mode", "control"],
          icon: Sparkles,
          content: preparePanel,
        }}
        primaryAction={{
          label: "Finish setup",
          pendingLabel: "Finishing…",
          discardLabel: "Discard changes and finish",
          disabled: settingsSavePending,
          onAction: onFinish,
        }}
      />
    </Dialog>
  );
};
