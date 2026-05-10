import { useEffect, useState, type JSX } from "react";
import {
  DEFAULT_USER_DESKTOP_SETTINGS,
  DESKTOP_SETTING_BOUNDS,
} from "../../../../../core/runtime-contract.generated.js";
import { Input } from "../../../components/ui/input";
import type { UserDesktopSettings } from "../../../runtime";
import {
  ChoiceButtons,
  SettingPanel,
  SettingsCard,
  SettingsSaveBar,
  SettingsStatus,
} from "./shared";
import type { DesktopSettingsControls } from "./types";
import {
  clampDecimalSetting,
  clampIntegerSetting,
  parseDecimalSettingInput,
  parseIntegerSettingInput,
} from "./number-settings";

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

export const normalizeDesktopSettingsDraft = (
  settings: UserDesktopSettings,
): UserDesktopSettings => {
  const quickVoiceShortcut = settings.quickVoiceShortcut.trim();

  return {
    ...settings,
    assistantBubbleTemporarilyHideSeconds: clampIntegerSetting(
      settings.assistantBubbleTemporarilyHideSeconds,
      DESKTOP_SETTING_BOUNDS.assistantBubbleTemporarilyHideSeconds.min,
      DESKTOP_SETTING_BOUNDS.assistantBubbleTemporarilyHideSeconds.max,
      DEFAULT_USER_DESKTOP_SETTINGS.assistantBubbleTemporarilyHideSeconds,
    ),
    aiContextMaxMessages: clampIntegerSetting(
      settings.aiContextMaxMessages,
      DESKTOP_SETTING_BOUNDS.aiContextMaxMessages.min,
      DESKTOP_SETTING_BOUNDS.aiContextMaxMessages.max,
      DEFAULT_USER_DESKTOP_SETTINGS.aiContextMaxMessages,
    ),
    inactiveSessionArchiveDays: clampIntegerSetting(
      settings.inactiveSessionArchiveDays,
      DESKTOP_SETTING_BOUNDS.inactiveSessionArchiveDays.min,
      DESKTOP_SETTING_BOUNDS.inactiveSessionArchiveDays.max,
      DEFAULT_USER_DESKTOP_SETTINGS.inactiveSessionArchiveDays,
    ),
    archivedSessionRetentionDays: clampIntegerSetting(
      settings.archivedSessionRetentionDays,
      DESKTOP_SETTING_BOUNDS.archivedSessionRetentionDays.min,
      DESKTOP_SETTING_BOUNDS.archivedSessionRetentionDays.max,
      DEFAULT_USER_DESKTOP_SETTINGS.archivedSessionRetentionDays,
    ),
    quickVoiceShortcut:
      quickVoiceShortcut || DEFAULT_USER_DESKTOP_SETTINGS.quickVoiceShortcut,
    quickVoiceSilenceSeconds: clampDecimalSetting(
      settings.quickVoiceSilenceSeconds,
      DESKTOP_SETTING_BOUNDS.quickVoiceSilenceSeconds.min,
      DESKTOP_SETTING_BOUNDS.quickVoiceSilenceSeconds.max,
      DEFAULT_USER_DESKTOP_SETTINGS.quickVoiceSilenceSeconds,
      1,
    ),
    quickVoiceMaxMessages: clampIntegerSetting(
      settings.quickVoiceMaxMessages,
      DESKTOP_SETTING_BOUNDS.quickVoiceMaxMessages.min,
      DESKTOP_SETTING_BOUNDS.quickVoiceMaxMessages.max,
      DEFAULT_USER_DESKTOP_SETTINGS.quickVoiceMaxMessages,
    ),
  };
};

export const hasDesktopSettingsDraftChanges = (
  left: UserDesktopSettings,
  right: UserDesktopSettings,
): boolean => {
  return (
    left.autostartEnabled !== right.autostartEnabled ||
    left.autostartMinimized !== right.autostartMinimized ||
    left.autostartToTray !== right.autostartToTray ||
    left.alwaysRunAsAdministrator !== right.alwaysRunAsAdministrator ||
    left.assistantBubbleEnabled !== right.assistantBubbleEnabled ||
    left.assistantBubbleHideWhenFullscreen !==
      right.assistantBubbleHideWhenFullscreen ||
    left.assistantBubbleTemporarilyHideSeconds !==
      right.assistantBubbleTemporarilyHideSeconds ||
    left.aiContextMaxMessages !== right.aiContextMaxMessages ||
    left.inactiveSessionArchiveDays !== right.inactiveSessionArchiveDays ||
    left.archivedSessionRetentionDays !==
      right.archivedSessionRetentionDays ||
    left.quickVoiceEnabled !== right.quickVoiceEnabled ||
    left.quickVoiceShortcut !== right.quickVoiceShortcut ||
    left.quickVoiceSilenceSeconds !== right.quickVoiceSilenceSeconds ||
    left.quickVoiceMaxMessages !== right.quickVoiceMaxMessages
  );
};

export interface DesktopSettingsPanelProps {
  setup: DesktopSettingsControls;
}

export const DesktopSettingsPanel = ({
  setup,
}: DesktopSettingsPanelProps): JSX.Element => {
  const [draft, setDraft] = useState<UserDesktopSettings>(setup.settings);
  const normalizedDraft = normalizeDesktopSettingsDraft(draft);
  const dirty = hasDesktopSettingsDraftChanges(normalizedDraft, setup.settings);
  const desktopAutostartMode = getDesktopAutostartMode(draft);

  useEffect(() => {
    setDraft(setup.settings);
  }, [setup.settings]);

  return (
    <SettingsCard
      title="Desktop assistant"
      description="Desktop behavior changes are staged until saved."
    >
      <div className="grid gap-0">
        <SettingPanel label="Launch on sign-in">
          <ChoiceButtons
            value={draft.autostartEnabled ? "enabled" : "disabled"}
            options={[
              { value: "enabled", label: "Enabled" },
              { value: "disabled", label: "Disabled" },
            ]}
            disabled={setup.saving}
            onChange={(value) => {
              setDraft({
                ...draft,
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
            disabled={setup.saving}
            onChange={(mode) => {
              setDraft(applyDesktopAutostartMode(draft, mode));
            }}
          />
        </SettingPanel>

        <SettingPanel label="Always run as administrator">
          <ChoiceButtons
            value={draft.alwaysRunAsAdministrator ? "enabled" : "disabled"}
            options={[
              { value: "enabled", label: "Enabled" },
              { value: "disabled", label: "Disabled" },
            ]}
            disabled={setup.saving}
            onChange={(value) => {
              setDraft({
                ...draft,
                alwaysRunAsAdministrator: value === "enabled",
              });
            }}
          />
        </SettingPanel>

        <SettingPanel label="Floating bubble">
          <ChoiceButtons
            value={draft.assistantBubbleEnabled ? "enabled" : "disabled"}
            options={[
              { value: "enabled", label: "Enabled" },
              { value: "disabled", label: "Disabled" },
            ]}
            disabled={setup.saving}
            onChange={(value) => {
              setDraft({
                ...draft,
                assistantBubbleEnabled: value === "enabled",
              });
            }}
          />
        </SettingPanel>

        <SettingPanel label="Fullscreen apps">
          <ChoiceButtons
            value={draft.assistantBubbleHideWhenFullscreen ? "hide" : "show"}
            options={[
              { value: "hide", label: "Hide bubble" },
              { value: "show", label: "Keep visible" },
            ]}
            disabled={setup.saving}
            onChange={(value) => {
              setDraft({
                ...draft,
                assistantBubbleHideWhenFullscreen: value === "hide",
              });
            }}
          />
        </SettingPanel>

        <SettingPanel label="Hide duration">
          <Input
            type="number"
            min={DESKTOP_SETTING_BOUNDS.assistantBubbleTemporarilyHideSeconds.min}
            max={DESKTOP_SETTING_BOUNDS.assistantBubbleTemporarilyHideSeconds.max}
            step="1"
            value={draft.assistantBubbleTemporarilyHideSeconds}
            onChange={(event) => {
              setDraft({
                ...draft,
                assistantBubbleTemporarilyHideSeconds: parseIntegerSettingInput(
                  event.target.value,
                  DESKTOP_SETTING_BOUNDS.assistantBubbleTemporarilyHideSeconds.min,
                  DESKTOP_SETTING_BOUNDS.assistantBubbleTemporarilyHideSeconds.max,
                  draft.assistantBubbleTemporarilyHideSeconds,
                ),
              });
            }}
            className="h-10 max-w-28 rounded-lg border-slate-800 bg-slate-950 text-slate-100"
          />
        </SettingPanel>

        <SettingPanel label="AI context cap">
          <Input
            type="number"
            min={DESKTOP_SETTING_BOUNDS.aiContextMaxMessages.min}
            max={DESKTOP_SETTING_BOUNDS.aiContextMaxMessages.max}
            step="1"
            value={draft.aiContextMaxMessages}
            onChange={(event) => {
              setDraft({
                ...draft,
                aiContextMaxMessages: parseIntegerSettingInput(
                  event.target.value,
                  DESKTOP_SETTING_BOUNDS.aiContextMaxMessages.min,
                  DESKTOP_SETTING_BOUNDS.aiContextMaxMessages.max,
                  draft.aiContextMaxMessages,
                ),
              });
            }}
            className="h-10 max-w-28 rounded-lg border-slate-800 bg-slate-950 text-slate-100"
          />
        </SettingPanel>

        <SettingPanel
          label="Inactive archive"
          detail="Move open sessions to the archive after this many inactive days."
        >
          <Input
            type="number"
            min={DESKTOP_SETTING_BOUNDS.inactiveSessionArchiveDays.min}
            max={DESKTOP_SETTING_BOUNDS.inactiveSessionArchiveDays.max}
            step="1"
            value={draft.inactiveSessionArchiveDays}
            onChange={(event) => {
              setDraft({
                ...draft,
                inactiveSessionArchiveDays: parseIntegerSettingInput(
                  event.target.value,
                  DESKTOP_SETTING_BOUNDS.inactiveSessionArchiveDays.min,
                  DESKTOP_SETTING_BOUNDS.inactiveSessionArchiveDays.max,
                  draft.inactiveSessionArchiveDays,
                ),
              });
            }}
            className="h-10 max-w-28 rounded-lg border-slate-800 bg-slate-950 text-slate-100"
          />
        </SettingPanel>

        <SettingPanel
          label="Archived cleanup"
          detail="Delete archived sessions after this many days."
        >
          <Input
            type="number"
            min={DESKTOP_SETTING_BOUNDS.archivedSessionRetentionDays.min}
            max={DESKTOP_SETTING_BOUNDS.archivedSessionRetentionDays.max}
            step="1"
            value={draft.archivedSessionRetentionDays}
            onChange={(event) => {
              setDraft({
                ...draft,
                archivedSessionRetentionDays: parseIntegerSettingInput(
                  event.target.value,
                  DESKTOP_SETTING_BOUNDS.archivedSessionRetentionDays.min,
                  DESKTOP_SETTING_BOUNDS.archivedSessionRetentionDays.max,
                  draft.archivedSessionRetentionDays,
                ),
              });
            }}
            className="h-10 max-w-28 rounded-lg border-slate-800 bg-slate-950 text-slate-100"
          />
        </SettingPanel>

        <SettingPanel label="Quick Voice">
          <ChoiceButtons
            value={draft.quickVoiceEnabled ? "enabled" : "disabled"}
            options={[
              { value: "enabled", label: "Enabled" },
              { value: "disabled", label: "Disabled" },
            ]}
            disabled={setup.saving}
            onChange={(value) => {
              setDraft({
                ...draft,
                quickVoiceEnabled: value === "enabled",
              });
            }}
          />
        </SettingPanel>

        <SettingPanel label="Global shortcut">
          <Input
            type="text"
            value={draft.quickVoiceShortcut}
            onChange={(event) => {
              setDraft({
                ...draft,
                quickVoiceShortcut: event.target.value,
              });
            }}
            placeholder={DEFAULT_USER_DESKTOP_SETTINGS.quickVoiceShortcut}
            autoComplete="off"
            spellCheck={false}
            className="h-10 rounded-lg border-slate-800 bg-slate-950 text-slate-100"
          />
        </SettingPanel>

        <SettingPanel label="Silence timeout">
          <Input
            type="number"
            min={DESKTOP_SETTING_BOUNDS.quickVoiceSilenceSeconds.min}
            max={DESKTOP_SETTING_BOUNDS.quickVoiceSilenceSeconds.max}
            step="0.1"
            value={draft.quickVoiceSilenceSeconds}
            onChange={(event) => {
              setDraft({
                ...draft,
                quickVoiceSilenceSeconds: parseDecimalSettingInput(
                  event.target.value,
                  DESKTOP_SETTING_BOUNDS.quickVoiceSilenceSeconds.min,
                  DESKTOP_SETTING_BOUNDS.quickVoiceSilenceSeconds.max,
                  draft.quickVoiceSilenceSeconds,
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
            min={DESKTOP_SETTING_BOUNDS.quickVoiceMaxMessages.min}
            max={DESKTOP_SETTING_BOUNDS.quickVoiceMaxMessages.max}
            step="5"
            value={draft.quickVoiceMaxMessages}
            onChange={(event) => {
              setDraft({
                ...draft,
                quickVoiceMaxMessages: parseIntegerSettingInput(
                  event.target.value,
                  DESKTOP_SETTING_BOUNDS.quickVoiceMaxMessages.min,
                  DESKTOP_SETTING_BOUNDS.quickVoiceMaxMessages.max,
                  draft.quickVoiceMaxMessages,
                ),
              });
            }}
            className="h-10 max-w-28 rounded-lg border-slate-800 bg-slate-950 text-slate-100"
          />
        </SettingPanel>
      </div>

      <SettingsSaveBar
        dirty={dirty}
        dirtyText="Unsaved desktop changes"
        cleanText="Desktop settings are up to date"
        saveLabel="Save desktop settings"
        savingLabel="Saving..."
        saving={setup.saving}
        onSave={() => {
          void setup.onSave(normalizedDraft);
        }}
      />

      <SettingsStatus message={setup.message} />
    </SettingsCard>
  );
};
