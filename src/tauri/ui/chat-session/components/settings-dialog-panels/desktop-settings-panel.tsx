import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type JSX } from "react";
import {
  DEFAULT_USER_DESKTOP_SETTINGS,
  DESKTOP_SETTING_BOUNDS,
} from "../../../../../core/runtime-contract.generated.js";
import { Input } from "../../../components/ui/input";
import { Button } from "../../../components/ui/button";
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
import type {
  DesktopSettingsControls,
  SettingsStatusMessage,
} from "./types";
import {
  clampDecimalSetting,
  clampIntegerSetting,
  parseDecimalSettingInput,
  parseIntegerSettingInput,
} from "./number-settings";

interface MachdochCodexSessionUsage {
  files: number;
  bytes: number;
}

interface MachdochCodexSessionCleanupResult {
  deletedFiles: number;
  deletedBytes: number;
  failedFiles: number;
  remainingFiles: number;
  remainingBytes: number;
}

const formatStorageBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
};

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
  const [clearingCache, setClearingCache] = useState(false);
  const [cacheMessage, setCacheMessage] =
    useState<SettingsStatusMessage | null>(null);
  const [codexUsage, setCodexUsage] =
    useState<MachdochCodexSessionUsage | null>(null);
  const [checkingCodexUsage, setCheckingCodexUsage] = useState(false);
  const [clearingCodexSessions, setClearingCodexSessions] = useState(false);
  const [confirmingCodexClear, setConfirmingCodexClear] = useState(false);
  const [codexSessionMessage, setCodexSessionMessage] =
    useState<SettingsStatusMessage | null>(null);
  const lastExternalSettingsRef = useRef(setup.settings);
  const suppressUnmountFlushRef = useRef(false);
  const normalizedDraft = normalizeDesktopSettingsDraft(draft);
  const shortcutInvalid =
    draft.quickVoiceEnabled && draft.quickVoiceShortcut.trim().length === 0;
  const dirty =
    hasDesktopSettingsDraftChanges(normalizedDraft, setup.settings) ||
    draft.quickVoiceShortcut !== normalizedDraft.quickVoiceShortcut;
  const desktopAutostartMode = getDesktopAutostartMode(draft);
  const autoSaveSignature = JSON.stringify(normalizedDraft);
  const dataOperationBusy = clearingCache || clearingCodexSessions;

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
      rebaseDirtySettingsDraft(
        currentDraft,
        previousSettings,
        setup.settings,
      ),
    );
  }, [setup.settings]);

  return (
    <div className="grid gap-5">
      {dirty || setup.saving || setup.message || cacheMessage || codexSessionMessage ? (
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
            <SettingsStatus message={codexSessionMessage} />
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
            min={DESKTOP_SETTING_BOUNDS.assistantBubbleTemporarilyHideSeconds.min}
            max={DESKTOP_SETTING_BOUNDS.assistantBubbleTemporarilyHideSeconds.max}
            step="1"
            value={draft.assistantBubbleTemporarilyHideSeconds}
            disabled={setup.saving || !draft.assistantBubbleEnabled}
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
                Enter a shortcut before saving.
              </p>
            ) : null}
          </div>
        </SettingPanel>

        <SettingPanel label="Silence timeout" detail="Seconds before speech input is submitted.">
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

        <SettingPanel label="Quick Chat cap" detail="Maximum messages kept in Quick Chat context.">
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
            label="Codex session data"
            detail="Inspect or remove only Codex session files created by Machdoch. Other Codex tasks are not touched. New Machdoch Codex runs are ephemeral."
          >
            <div className="flex flex-wrap items-center justify-end gap-2">
              {codexUsage ? (
                <span className="text-xs text-slate-400">
                  {codexUsage.files} file{codexUsage.files === 1 ? "" : "s"} ·{" "}
                  {formatStorageBytes(codexUsage.bytes)}
                </span>
              ) : null}
              <Button
                type="button"
                variant="outline"
                disabled={checkingCodexUsage || clearingCodexSessions}
                onClick={() => {
                  setCheckingCodexUsage(true);
                  setCodexSessionMessage(null);
                  void invoke<MachdochCodexSessionUsage>(
                    "get_machdoch_codex_session_usage",
                  )
                    .then((usage) => {
                      setCodexUsage(usage);
                      setCodexSessionMessage({
                        tone: "success",
                        text:
                          usage.files === 0
                            ? "No persisted Machdoch Codex sessions found."
                            : `Found ${usage.files} Machdoch Codex session file${usage.files === 1 ? "" : "s"}.`,
                      });
                    })
                    .catch((error) => {
                      console.error("Failed to inspect Codex session data", error);
                      setCodexSessionMessage({
                        tone: "error",
                        text: "Could not inspect Codex session data.",
                      });
                    })
                    .finally(() => {
                      setCheckingCodexUsage(false);
                    });
                }}
              >
                {checkingCodexUsage ? "Checking..." : "Check usage"}
              </Button>
              {codexUsage && codexUsage.files > 0 && !confirmingCodexClear ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={checkingCodexUsage || clearingCodexSessions}
                  onClick={() => setConfirmingCodexClear(true)}
                >
                  Clear Machdoch data
                </Button>
              ) : null}
              {codexUsage && codexUsage.files > 0 && confirmingCodexClear ? (
                <div className="flex flex-wrap items-center justify-end gap-2 rounded-lg border border-rose-500/20 bg-rose-500/10 p-2">
                  <span className="text-xs text-rose-200">
                    This permanently deletes {codexUsage.files} Machdoch session {codexUsage.files === 1 ? "file" : "files"}.
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={clearingCodexSessions}
                    onClick={() => setConfirmingCodexClear(false)}
                    className="text-slate-300 hover:bg-slate-800"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={clearingCodexSessions}
                    onClick={() => {
                    setClearingCodexSessions(true);
                    setCodexSessionMessage(null);
                    void invoke<MachdochCodexSessionCleanupResult>(
                      "clear_machdoch_codex_sessions",
                    )
                      .then((result) => {
                        setCodexUsage({
                          files: result.remainingFiles,
                          bytes: result.remainingBytes,
                        });
                        setCodexSessionMessage({
                          tone: result.failedFiles > 0 ? "error" : "success",
                          text: `Removed ${result.deletedFiles} file${result.deletedFiles === 1 ? "" : "s"} (${formatStorageBytes(result.deletedBytes)})${result.failedFiles > 0 ? `; ${result.failedFiles} could not be removed.` : "."}`,
                        });
                      })
                      .catch((error) => {
                        console.error("Failed to clear Codex session data", error);
                        setCodexSessionMessage({
                          tone: "error",
                          text: "Could not clear Codex session data.",
                        });
                      })
                      .finally(() => {
                        setClearingCodexSessions(false);
                        setConfirmingCodexClear(false);
                      });
                  }}
                >
                    {clearingCodexSessions ? "Deleting…" : "Delete files"}
                  </Button>
                </div>
              ) : null}
            </div>
          </SettingPanel>
        ) : null}

        {isTauri() ? (
          <SettingPanel
            label="WebView cache"
            detail="Clear cached browser resources. Your machdoch sessions and settings are preserved."
          >
            <Button
              type="button"
              variant="outline"
              disabled={clearingCache}
              onClick={() => {
                setClearingCache(true);
                setCacheMessage(null);
                void invoke("clear_webview_cache")
                  .then(() => {
                    setCacheMessage({
                      tone: "success",
                      text: "WebView cache cleared.",
                    });
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
              }}
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
