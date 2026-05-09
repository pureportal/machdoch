import { useEffect, useState, type JSX } from "react";
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

const DEFAULT_QUICK_VOICE_SHORTCUT = "CommandOrControl+Alt+V";

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
            min="2"
            max="30"
            step="1"
            value={draft.assistantBubbleTemporarilyHideSeconds}
            onChange={(event) => {
              setDraft({
                ...draft,
                assistantBubbleTemporarilyHideSeconds: parseIntegerSettingInput(
                  event.target.value,
                  2,
                  30,
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
            min="1"
            max="200"
            step="1"
            value={draft.aiContextMaxMessages}
            onChange={(event) => {
              setDraft({
                ...draft,
                aiContextMaxMessages: parseIntegerSettingInput(
                  event.target.value,
                  1,
                  200,
                  draft.aiContextMaxMessages,
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
            placeholder={DEFAULT_QUICK_VOICE_SHORTCUT}
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
            value={draft.quickVoiceSilenceSeconds}
            onChange={(event) => {
              setDraft({
                ...draft,
                quickVoiceSilenceSeconds: parseDecimalSettingInput(
                  event.target.value,
                  0.8,
                  8,
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
            min="10"
            max="200"
            step="5"
            value={draft.quickVoiceMaxMessages}
            onChange={(event) => {
              setDraft({
                ...draft,
                quickVoiceMaxMessages: parseIntegerSettingInput(
                  event.target.value,
                  10,
                  200,
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
