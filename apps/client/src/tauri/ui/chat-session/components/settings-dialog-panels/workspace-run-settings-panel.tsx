import { useEffect, useRef, useState, type JSX } from "react";
import {
  DEFAULT_USER_WORKSPACE_RUN_SETTINGS,
  WORKSPACE_RUN_SETTING_BOUNDS,
} from "../../../../../core/runtime-contract.generated.js";
import { Input } from "../../../components/ui/input";
import type { UserWorkspaceRunSettings } from "../../../runtime";
import { useSettingsNavigationGuard } from "./navigation-guard";
import {
  parseIntegerSettingInput,
  clampIntegerSetting,
} from "./number-settings";
import {
  SettingPanel,
  SettingsAutoSaveStatus,
  SettingsCard,
  SettingsStatus,
  rebaseDirtySettingsDraft,
  useDebouncedAutoSave,
} from "./shared";
import type { WorkspaceRunSettingsControls } from "./types";

export const normalizeWorkspaceRunSettingsDraft = (
  settings: UserWorkspaceRunSettings,
): UserWorkspaceRunSettings => {
  const healthCheckIntervalMs = clampIntegerSetting(
    settings.healthCheckIntervalMs,
    WORKSPACE_RUN_SETTING_BOUNDS.healthCheckIntervalMs.min,
    WORKSPACE_RUN_SETTING_BOUNDS.healthCheckIntervalMs.max,
    DEFAULT_USER_WORKSPACE_RUN_SETTINGS.healthCheckIntervalMs,
  );

  return {
    startupDelayMs: clampIntegerSetting(
      settings.startupDelayMs,
      WORKSPACE_RUN_SETTING_BOUNDS.startupDelayMs.min,
      WORKSPACE_RUN_SETTING_BOUNDS.startupDelayMs.max,
      DEFAULT_USER_WORKSPACE_RUN_SETTINGS.startupDelayMs,
    ),
    healthCheckIntervalMs,
    healthCheckTimeoutMs: Math.min(
      healthCheckIntervalMs,
      clampIntegerSetting(
        settings.healthCheckTimeoutMs,
        WORKSPACE_RUN_SETTING_BOUNDS.healthCheckTimeoutMs.min,
        WORKSPACE_RUN_SETTING_BOUNDS.healthCheckTimeoutMs.max,
        DEFAULT_USER_WORKSPACE_RUN_SETTINGS.healthCheckTimeoutMs,
      ),
    ),
    healthCheckFailureThreshold: clampIntegerSetting(
      settings.healthCheckFailureThreshold,
      WORKSPACE_RUN_SETTING_BOUNDS.healthCheckFailureThreshold.min,
      WORKSPACE_RUN_SETTING_BOUNDS.healthCheckFailureThreshold.max,
      DEFAULT_USER_WORKSPACE_RUN_SETTINGS.healthCheckFailureThreshold,
    ),
    sequentialReadinessTimeoutMs: clampIntegerSetting(
      settings.sequentialReadinessTimeoutMs,
      WORKSPACE_RUN_SETTING_BOUNDS.sequentialReadinessTimeoutMs.min,
      WORKSPACE_RUN_SETTING_BOUNDS.sequentialReadinessTimeoutMs.max,
      DEFAULT_USER_WORKSPACE_RUN_SETTINGS.sequentialReadinessTimeoutMs,
    ),
  };
};

export const hasWorkspaceRunSettingsDraftChanges = (
  left: UserWorkspaceRunSettings,
  right: UserWorkspaceRunSettings,
): boolean => {
  return (
    left.startupDelayMs !== right.startupDelayMs ||
    left.healthCheckIntervalMs !== right.healthCheckIntervalMs ||
    left.healthCheckTimeoutMs !== right.healthCheckTimeoutMs ||
    left.healthCheckFailureThreshold !== right.healthCheckFailureThreshold ||
    left.sequentialReadinessTimeoutMs !== right.sequentialReadinessTimeoutMs
  );
};

export interface WorkspaceRunSettingsPanelProps {
  setup: WorkspaceRunSettingsControls;
}

export const WorkspaceRunSettingsPanel = ({
  setup,
}: WorkspaceRunSettingsPanelProps): JSX.Element => {
  const [draft, setDraft] = useState<UserWorkspaceRunSettings>(setup.settings);
  const lastExternalSettingsRef = useRef(setup.settings);
  const suppressUnmountFlushRef = useRef(false);
  const normalizedDraft = normalizeWorkspaceRunSettingsDraft(draft);
  const dirty = hasWorkspaceRunSettingsDraftChanges(
    normalizedDraft,
    setup.settings,
  );

  useDebouncedAutoSave({
    dirty,
    saving: setup.saving,
    signature: JSON.stringify(normalizedDraft),
    onSave: async () => {
      await setup.onSave(normalizedDraft);
    },
    suppressUnmountFlushRef,
  });

  useSettingsNavigationGuard({
    dirty: dirty || setup.saving,
    title: "Unsaved run timeouts",
    description: setup.saving
      ? "Wait for the timeout settings to finish saving."
      : "Unsaved timeout changes will be discarded.",
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

  const updateInteger = (
    key: keyof UserWorkspaceRunSettings,
    value: string,
    bounds: { min: number; max: number },
  ): void => {
    setDraft((current) =>
      normalizeWorkspaceRunSettingsDraft({
        ...current,
        [key]: parseIntegerSettingInput(
          value,
          bounds.min,
          bounds.max,
          current[key],
        ),
      }),
    );
  };

  const inputClassName =
    "h-10 max-w-40 rounded-lg border-slate-800 bg-slate-950 text-slate-100 disabled:opacity-50";

  return (
    <SettingsCard title="Workspace Run">
      <div className="grid gap-1">
        <SettingPanel label="First health check delay (ms)">
          <Input
            aria-label="Startup delay in milliseconds"
            type="number"
            step="1"
            {...WORKSPACE_RUN_SETTING_BOUNDS.startupDelayMs}
            value={draft.startupDelayMs}
            disabled={setup.saving}
            onChange={(event) =>
              updateInteger(
                "startupDelayMs",
                event.target.value,
                WORKSPACE_RUN_SETTING_BOUNDS.startupDelayMs,
              )
            }
            className={inputClassName}
          />
        </SettingPanel>
        <SettingPanel label="Health check interval (ms)">
          <Input
            aria-label="Health check interval in milliseconds"
            type="number"
            step="1"
            {...WORKSPACE_RUN_SETTING_BOUNDS.healthCheckIntervalMs}
            value={draft.healthCheckIntervalMs}
            disabled={setup.saving}
            onChange={(event) =>
              updateInteger(
                "healthCheckIntervalMs",
                event.target.value,
                WORKSPACE_RUN_SETTING_BOUNDS.healthCheckIntervalMs,
              )
            }
            className={inputClassName}
          />
        </SettingPanel>
        <SettingPanel label="Health check timeout (ms)">
          <Input
            aria-label="Health check timeout in milliseconds"
            type="number"
            min={WORKSPACE_RUN_SETTING_BOUNDS.healthCheckTimeoutMs.min}
            max={Math.min(
              WORKSPACE_RUN_SETTING_BOUNDS.healthCheckTimeoutMs.max,
              draft.healthCheckIntervalMs,
            )}
            step="1"
            value={draft.healthCheckTimeoutMs}
            disabled={setup.saving}
            onChange={(event) =>
              updateInteger(
                "healthCheckTimeoutMs",
                event.target.value,
                WORKSPACE_RUN_SETTING_BOUNDS.healthCheckTimeoutMs,
              )
            }
            className={inputClassName}
          />
        </SettingPanel>
        <SettingPanel label="Health check failure threshold">
          <Input
            aria-label="Health check failure threshold"
            type="number"
            step="1"
            {...WORKSPACE_RUN_SETTING_BOUNDS.healthCheckFailureThreshold}
            value={draft.healthCheckFailureThreshold}
            disabled={setup.saving}
            onChange={(event) =>
              updateInteger(
                "healthCheckFailureThreshold",
                event.target.value,
                WORKSPACE_RUN_SETTING_BOUNDS.healthCheckFailureThreshold,
              )
            }
            className={inputClassName}
          />
        </SettingPanel>
        <SettingPanel label="Sequential readiness timeout (ms)">
          <Input
            aria-label="Sequential readiness timeout in milliseconds"
            type="number"
            step="1"
            {...WORKSPACE_RUN_SETTING_BOUNDS.sequentialReadinessTimeoutMs}
            value={draft.sequentialReadinessTimeoutMs}
            disabled={setup.saving}
            onChange={(event) =>
              updateInteger(
                "sequentialReadinessTimeoutMs",
                event.target.value,
                WORKSPACE_RUN_SETTING_BOUNDS.sequentialReadinessTimeoutMs,
              )
            }
            className={inputClassName}
          />
        </SettingPanel>
      </div>
      <SettingsAutoSaveStatus
        dirty={dirty}
        dirtyText="Run timeout changes not saved"
        cleanText="Run timeouts saved"
        saving={setup.saving}
        onSaveNow={async () => {
          await setup.onSave(normalizedDraft);
        }}
      />
      <SettingsStatus message={setup.message} />
    </SettingsCard>
  );
};
