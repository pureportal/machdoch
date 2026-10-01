import { useEffect, useRef, useState, type JSX } from "react";
import {
  DEFAULT_USER_DESKTOP_SETTINGS,
  DESKTOP_SETTING_BOUNDS,
} from "../../../../../core/runtime-contract.generated.js";
import type { UserDesktopSettings } from "../../../runtime";
import { useSettingsNavigationGuard } from "./navigation-guard";
import { clampIntegerSetting } from "./number-settings";
import { SettingsNumberInput } from "./settings-number-input";
import { SettingsToggle } from "./settings-toggle";
import {
  rebaseDirtySettingsDraft,
  SettingPanel,
  SettingsAutoSaveStatus,
  SettingsCard,
  SettingsStatus,
  useDebouncedAutoSave,
} from "./shared";
import type { DesktopSettingsControls } from "./types";

export const SessionDefaultsSettingsPanel = ({
  setup,
}: {
  setup: DesktopSettingsControls;
}): JSX.Element => {
  const [draft, setDraft] = useState<UserDesktopSettings>(setup.settings);
  const lastExternalSettingsRef = useRef(setup.settings);
  const suppressUnmountFlushRef = useRef(false);
  const sessionDefaults = {
    adaptiveControllerEnabled: draft.adaptiveControllerEnabled,
    aiContextMaxMessages: clampIntegerSetting(
      draft.aiContextMaxMessages,
      DESKTOP_SETTING_BOUNDS.aiContextMaxMessages.min,
      DESKTOP_SETTING_BOUNDS.aiContextMaxMessages.max,
      DEFAULT_USER_DESKTOP_SETTINGS.aiContextMaxMessages,
    ),
    chatIdleTimeoutMinutes: clampIntegerSetting(
      draft.chatIdleTimeoutMinutes,
      DESKTOP_SETTING_BOUNDS.chatIdleTimeoutMinutes.min,
      DESKTOP_SETTING_BOUNDS.chatIdleTimeoutMinutes.max,
      DEFAULT_USER_DESKTOP_SETTINGS.chatIdleTimeoutMinutes,
    ),
  };
  const dirty =
    sessionDefaults.adaptiveControllerEnabled !==
      setup.settings.adaptiveControllerEnabled ||
    sessionDefaults.aiContextMaxMessages !==
      setup.settings.aiContextMaxMessages ||
    sessionDefaults.chatIdleTimeoutMinutes !==
      setup.settings.chatIdleTimeoutMinutes;
  const save = (): Promise<void> | void =>
    setup.onSave({ ...setup.settings, ...sessionDefaults });

  useDebouncedAutoSave({
    dirty,
    saving: setup.saving,
    signature: JSON.stringify(sessionDefaults),
    onSave: save,
    suppressUnmountFlushRef,
  });

  useSettingsNavigationGuard({
    dirty: dirty || setup.saving,
    title: "Unsaved session defaults",
    description: setup.saving
      ? "Wait for session defaults to finish saving before leaving."
      : "Session defaults that have not been saved will be discarded.",
    canDiscard: !setup.saving,
    onDiscard: () => {
      suppressUnmountFlushRef.current = true;
      setDraft(setup.settings);
    },
  });

  useEffect(() => {
    const previousSettings = lastExternalSettingsRef.current;
    lastExternalSettingsRef.current = setup.settings;
    setDraft((currentDraft) =>
      rebaseDirtySettingsDraft(currentDraft, previousSettings, setup.settings),
    );
  }, [setup.settings]);

  return (
    <div className="grid gap-5">
      {dirty ||
      setup.saving ||
      (setup.message && setup.message.tone !== "success") ? (
        <div className="sticky top-0 z-10 rounded-xl border border-slate-800 bg-slate-950/95 px-4 pb-4 shadow-lg shadow-black/20">
          <SettingsAutoSaveStatus
            dirty={dirty}
            dirtyText="Session defaults will save automatically"
            cleanText="Session defaults are up to date"
            saving={setup.saving}
            onSaveNow={save}
          />
          <SettingsStatus
            message={setup.message?.tone === "success" ? null : setup.message}
          />
        </div>
      ) : null}

      <SettingsCard title="Context">
        <SettingPanel label="Adaptive context & compute">
          <SettingsToggle
            label="Adaptive context & compute"
            checked={draft.adaptiveControllerEnabled}
            disabled={setup.saving}
            onCheckedChange={(checked) =>
              setDraft({ ...draft, adaptiveControllerEnabled: checked })
            }
          />
        </SettingPanel>
        <SettingPanel label="AI context cap">
          <SettingsNumberInput
            aria-label="AI context message limit"
            min={DESKTOP_SETTING_BOUNDS.aiContextMaxMessages.min}
            max={DESKTOP_SETTING_BOUNDS.aiContextMaxMessages.max}
            step="1"
            value={draft.aiContextMaxMessages}
            disabled={setup.saving}
            onValueChange={(value) =>
              setDraft({ ...draft, aiContextMaxMessages: value })
            }
            className="h-10 max-w-28 rounded-lg border-slate-800 bg-slate-950 text-slate-100"
          />
        </SettingPanel>
      </SettingsCard>

      <SettingsCard title="Chat timeout">
        <SettingPanel label="Default inactivity timeout (minutes)">
          <SettingsNumberInput
            aria-label="Default inactivity timeout (minutes)"
            min={DESKTOP_SETTING_BOUNDS.chatIdleTimeoutMinutes.min}
            max={DESKTOP_SETTING_BOUNDS.chatIdleTimeoutMinutes.max}
            step="1"
            value={draft.chatIdleTimeoutMinutes}
            disabled={setup.saving}
            onValueChange={(value) =>
              setDraft({ ...draft, chatIdleTimeoutMinutes: value })
            }
            className="h-10 max-w-28 rounded-lg border-slate-800 bg-slate-950 text-slate-100"
          />
        </SettingPanel>
      </SettingsCard>
    </div>
  );
};
