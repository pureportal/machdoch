import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { detectCommandPlatform } from "../../../commands/command-context";
import { findDefaultShortcutConflict } from "../../../commands/command-defaults";
import {
  DEFAULT_USER_DESKTOP_SETTINGS,
  DESKTOP_SETTING_BOUNDS,
} from "../../../../../core/runtime-contract.generated.js";
import { Input } from "../../../components/ui/input";
import { Button } from "../../../components/ui/button";
import { useOptionalRegisterCommands } from "../../../commands/command-context";
import {
  asPaletteCommands,
  type CommandDefinition,
  type CommandPageItem,
} from "../../../commands/command-types";
import type { UserDesktopSettings } from "../../../runtime";
import {
  ChoiceButtons,
  SettingPanel,
  SettingsAutoSaveStatus,
  SettingsCard,
  SettingsStatus,
  rebaseDirtySettingsDraft,
  useDebouncedAutoSave,
} from "./shared";
import { useSettingsNavigationGuard } from "./navigation-guard";
import type { DesktopSettingsControls, SettingsStatusMessage } from "./types";
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
    left.archivedSessionRetentionDays !== right.archivedSessionRetentionDays ||
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
  const [clearingCache, setClearingCache] = useState(false);
  const [cacheMessage, setCacheMessage] =
    useState<SettingsStatusMessage | null>(null);
  const lastExternalSettingsRef = useRef(setup.settings);
  const suppressUnmountFlushRef = useRef(false);
  const normalizedDraft = normalizeDesktopSettingsDraft(draft);
  const shortcutConflict = draft.quickVoiceEnabled
    ? findDefaultShortcutConflict(
        draft.quickVoiceShortcut.trim(),
        detectCommandPlatform(),
      )
    : null;
  const shortcutInvalid =
    draft.quickVoiceEnabled &&
    (draft.quickVoiceShortcut.trim().length === 0 || shortcutConflict !== null);
  const dirty =
    hasDesktopSettingsDraftChanges(normalizedDraft, setup.settings) ||
    draft.quickVoiceShortcut !== normalizedDraft.quickVoiceShortcut;
  const desktopAutostartMode = getDesktopAutostartMode(draft);
  const autoSaveSignature = JSON.stringify(normalizedDraft);
  const dataOperationBusy = clearingCache;

  useDebouncedAutoSave({
    dirty: dirty && !shortcutInvalid,
    saving: setup.saving,
    signature: autoSaveSignature,
    onSave: () => setup.onSave(normalizedDraft),
    suppressUnmountFlushRef,
  });

  useSettingsNavigationGuard({
    dirty: dirty || setup.saving || dataOperationBusy,
    title: dataOperationBusy
      ? "Desktop operation in progress"
      : "Unsaved desktop settings",
    description:
      setup.saving || dataOperationBusy
        ? "Wait for the current desktop operation to finish before leaving."
        : "Desktop changes that have not been saved will be discarded.",
    canDiscard: !setup.saving && !dataOperationBusy,
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

  const clearCache = (): void => {
    if (!isTauri() || clearingCache) return;
    setClearingCache(true);
    setCacheMessage(null);
    void invoke("clear_webview_cache")
      .then(() => {
        setCacheMessage({ tone: "success", text: "WebView cache cleared." });
      })
      .catch((error) => {
        console.error("Failed to clear the WebView cache", error);
        setCacheMessage({
          tone: "error",
          text: "Could not clear the WebView cache.",
        });
      })
      .finally(() => {
        setClearingCache(false);
      });
  };

  const desktopCommandStateRef = useRef({
    draft,
    normalizedDraft,
    desktopAutostartMode,
    dirty,
    shortcutInvalid,
    saving: setup.saving,
    clearingCache,
    save: setup.onSave,
    setDraft,
    clearCache,
  });
  desktopCommandStateRef.current = {
    draft,
    normalizedDraft,
    desktopAutostartMode,
    dirty,
    shortcutInvalid,
    saving: setup.saving,
    clearingCache,
    save: setup.onSave,
    setDraft,
    clearCache,
  };
  const desktopCommands = useMemo<readonly CommandDefinition[]>(() => {
    const scope = { kind: "overlay" as const, ownerId: "settings-dialog" };
    const state = () => desktopCommandStateRef.current;
    const numericKey = (index: number): CommandPageItem["numericKey"] =>
      index < 9 ? (`${index + 1}` as CommandPageItem["numericKey"]) : undefined;
    const toggleCommand = (
      id: string,
      title: string,
      field:
        | "autostartEnabled"
        | "alwaysRunAsAdministrator"
        | "assistantBubbleEnabled"
        | "assistantBubbleHideWhenFullscreen"
        | "quickVoiceEnabled",
      disabled = (): boolean => false,
    ): CommandDefinition => ({
      id,
      title,
      group: "Settings: Desktop",
      scope,
      availability: () =>
        state().saving || disabled()
          ? {
              state: "disabled",
              reason: "This desktop setting is unavailable.",
            }
          : { state: "enabled" },
      current: () => state().draft[field],
      execute: () =>
        state().setDraft((current) => ({
          ...current,
          [field]: !current[field],
        })),
    });
    return asPaletteCommands([
      {
        id: "settings.desktop.save",
        title: "Save desktop settings",
        group: "Settings: Desktop",
        scope,
        availability: () =>
          state().saving
            ? { state: "disabled", reason: "Desktop settings are saving." }
            : state().shortcutInvalid
              ? {
                  state: "disabled",
                  reason: "Fix the Quick Chat shortcut first.",
                }
              : state().dirty
                ? { state: "enabled" }
                : { state: "disabled", reason: "No desktop settings to save." },
        execute: () => void state().save(state().normalizedDraft),
      },
      toggleCommand(
        "settings.desktop.autostart.toggle",
        "Toggle launch on sign-in",
        "autostartEnabled",
      ),
      {
        id: "settings.desktop.autostart-mode.select",
        title: "Choose startup behavior",
        group: "Settings: Desktop",
        scope,
        availability: () =>
          state().saving || !state().draft.autostartEnabled
            ? { state: "disabled", reason: "Enable launch on sign-in first." }
            : { state: "enabled" },
        children: () => ({
          id: "settings.desktop.autostart-mode.select.page",
          title: "Choose startup behavior",
          searchPlaceholder: "Search startup behaviors",
          numericSelection: true,
          groups: [
            {
              id: "behaviors",
              items: (
                [
                  ["window", "Open window"],
                  ["minimized", "Start minimized"],
                  ["tray", "Start in tray"],
                ] as const
              ).map(([mode, title], index) => ({
                id: mode,
                title,
                current: state().desktopAutostartMode === mode,
                numericKey: numericKey(index),
                execute: () =>
                  state().setDraft((current) =>
                    applyDesktopAutostartMode(current, mode),
                  ),
              })),
            },
          ],
        }),
      },
      toggleCommand(
        "settings.desktop.administrator.toggle",
        "Toggle always run as administrator",
        "alwaysRunAsAdministrator",
      ),
      toggleCommand(
        "settings.desktop.bubble.toggle",
        "Toggle floating assistant bubble",
        "assistantBubbleEnabled",
      ),
      toggleCommand(
        "settings.desktop.bubble-fullscreen.toggle",
        "Toggle hiding the bubble in fullscreen apps",
        "assistantBubbleHideWhenFullscreen",
        () => !state().draft.assistantBubbleEnabled,
      ),
      toggleCommand(
        "settings.desktop.quick-chat.toggle",
        "Toggle Quick Chat",
        "quickVoiceEnabled",
      ),
      {
        id: "settings.desktop.cache.clear",
        title: "Clear WebView cache",
        group: "Settings: Desktop",
        scope,
        availability: () =>
          !isTauri()
            ? { state: "hidden" }
            : state().clearingCache
              ? { state: "disabled", reason: "WebView cache is being cleared." }
              : { state: "enabled" },
        execute: () => state().clearCache(),
      },
    ]);
  }, []);
  useOptionalRegisterCommands(desktopCommands);

  return (
    <div className="grid gap-5">
      {dirty || setup.saving || setup.message || cacheMessage ? (
        <div className="sticky top-0 z-10 rounded-xl border border-slate-800 bg-slate-950/95 px-4 pb-4 shadow-lg shadow-black/20">
          <SettingsAutoSaveStatus
            dirty={dirty}
            dirtyText={
              shortcutInvalid
                ? "Fix the shortcut before saving"
                : "Desktop changes will save automatically"
            }
            cleanText="Desktop settings are up to date"
            saving={setup.saving}
            onSaveNow={
              shortcutInvalid ? undefined : () => setup.onSave(normalizedDraft)
            }
          />
          <div className="mt-3 grid gap-2">
            <SettingsStatus message={setup.message} />
            <SettingsStatus message={cacheMessage} />
          </div>
        </div>
      ) : null}

      <SettingsCard
        title="Startup"
        description="Choose whether and how Machdoch starts with your computer."
      >
        <div className="grid gap-0">
          <SettingPanel label="Launch on sign-in">
            <ChoiceButtons
              label="Launch on sign-in"
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

          <SettingPanel
            label="Startup behavior"
            detail={
              draft.autostartEnabled
                ? "Choose what appears after sign-in."
                : "Available when launch on sign-in is enabled."
            }
          >
            <ChoiceButtons
              label="Startup behavior"
              value={desktopAutostartMode}
              options={[
                { value: "window", label: "Open window" },
                { value: "minimized", label: "Start minimized" },
                { value: "tray", label: "Start in tray" },
              ]}
              disabled={setup.saving || !draft.autostartEnabled}
              onChange={(mode) => {
                setDraft(applyDesktopAutostartMode(draft, mode));
              }}
            />
          </SettingPanel>

          <SettingPanel
            label="Always run as administrator"
            detail="Request elevated access when Machdoch starts."
          >
            <ChoiceButtons
              label="Always run as administrator"
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
        </div>
      </SettingsCard>

      <SettingsCard title="Assistant surfaces">
        <div className="grid gap-0">
          <SettingPanel label="Floating bubble">
            <ChoiceButtons
              label="Floating bubble"
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

          <SettingPanel
            label="Fullscreen apps"
            detail={
              draft.assistantBubbleEnabled
                ? undefined
                : "Available when the floating bubble is enabled."
            }
          >
            <ChoiceButtons
              label="Floating bubble in fullscreen apps"
              value={draft.assistantBubbleHideWhenFullscreen ? "hide" : "show"}
              options={[
                { value: "hide", label: "Hide bubble" },
                { value: "show", label: "Keep visible" },
              ]}
              disabled={setup.saving || !draft.assistantBubbleEnabled}
              onChange={(value) => {
                setDraft({
                  ...draft,
                  assistantBubbleHideWhenFullscreen: value === "hide",
                });
              }}
            />
          </SettingPanel>

          <SettingPanel
            label="Temporary hide"
            detail="Seconds before the bubble returns."
          >
            <Input
              aria-label="Temporary bubble hide duration in seconds"
              type="number"
              min={
                DESKTOP_SETTING_BOUNDS.assistantBubbleTemporarilyHideSeconds.min
              }
              max={
                DESKTOP_SETTING_BOUNDS.assistantBubbleTemporarilyHideSeconds.max
              }
              step="1"
              value={draft.assistantBubbleTemporarilyHideSeconds}
              disabled={setup.saving || !draft.assistantBubbleEnabled}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  assistantBubbleTemporarilyHideSeconds:
                    parseIntegerSettingInput(
                      event.target.value,
                      DESKTOP_SETTING_BOUNDS
                        .assistantBubbleTemporarilyHideSeconds.min,
                      DESKTOP_SETTING_BOUNDS
                        .assistantBubbleTemporarilyHideSeconds.max,
                      draft.assistantBubbleTemporarilyHideSeconds,
                    ),
                });
              }}
              className="h-10 max-w-28 rounded-lg border-slate-800 bg-slate-950 text-slate-100"
            />
          </SettingPanel>
        </div>
      </SettingsCard>

      <SettingsCard
        title="Sessions"
        description="Control context size and automatic session retention."
      >
        <div className="grid gap-0">
          <SettingPanel label="AI context cap">
            <Input
              aria-label="AI context message limit"
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
              aria-label="Inactive session archive delay in days"
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
            detail="Permanently delete archived sessions after this many days."
          >
            <Input
              aria-label="Archived session deletion delay in days"
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
        </div>
      </SettingsCard>

      <SettingsCard
        title="Quick Chat"
        description="Configure the global launcher and its voice-input behavior."
      >
        <div className="grid gap-0">
          <SettingPanel label="Quick Chat">
            <ChoiceButtons
              label="Quick Chat status"
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

          <SettingPanel
            label="Global shortcut"
            detail={
              draft.quickVoiceEnabled
                ? "Opens Quick Chat from anywhere."
                : "Available when Quick Chat is enabled."
            }
          >
            <div className="grid gap-1.5">
              <Input
                aria-label="Quick Chat global shortcut"
                aria-invalid={shortcutInvalid ? true : undefined}
                type="text"
                value={draft.quickVoiceShortcut}
                disabled={setup.saving || !draft.quickVoiceEnabled}
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
              {shortcutInvalid ? (
                <p role="alert" className="text-xs text-rose-300">
                  {shortcutConflict
                    ? "This shortcut is already used in Machdoch. Choose another shortcut."
                    : "Enter a shortcut before saving."}
                </p>
              ) : null}
            </div>
          </SettingPanel>

          <SettingPanel
            label="Silence timeout"
            detail="Seconds before speech input is submitted."
          >
            <Input
              aria-label="Quick Chat silence timeout in seconds"
              type="number"
              min={DESKTOP_SETTING_BOUNDS.quickVoiceSilenceSeconds.min}
              max={DESKTOP_SETTING_BOUNDS.quickVoiceSilenceSeconds.max}
              step="0.1"
              value={draft.quickVoiceSilenceSeconds}
              disabled={setup.saving || !draft.quickVoiceEnabled}
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

          <SettingPanel
            label="Quick Chat cap"
            detail="Maximum messages kept in Quick Chat context."
          >
            <Input
              aria-label="Quick Chat message limit"
              type="number"
              min={DESKTOP_SETTING_BOUNDS.quickVoiceMaxMessages.min}
              max={DESKTOP_SETTING_BOUNDS.quickVoiceMaxMessages.max}
              step="5"
              value={draft.quickVoiceMaxMessages}
              disabled={setup.saving || !draft.quickVoiceEnabled}
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
      </SettingsCard>

      {isTauri() ? (
        <SettingsCard
          title="Local data"
          description="Inspect or clear local runtime data without removing app settings."
        >
          <div className="grid gap-0">
            {isTauri() ? (
              <SettingPanel
                label="WebView cache"
                detail="Clear cached browser resources. Your machdoch sessions and settings are preserved."
              >
                <Button
                  type="button"
                  variant="outline"
                  disabled={clearingCache}
                  onClick={clearCache}
                >
                  {clearingCache ? "Clearing..." : "Clear cache"}
                </Button>
              </SettingPanel>
            ) : null}
          </div>
        </SettingsCard>
      ) : null}
    </div>
  );
};
