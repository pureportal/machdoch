import { useEffect, useRef, useState, type JSX } from "react";
import {
  DEFAULT_USER_WORKSPACE_RUN_SETTINGS,
  WORKSPACE_RUN_SETTING_BOUNDS,
} from "../../../../../core/runtime-contract.generated.js";
import { SettingsNumberInput } from "./settings-number-input";
import type { UserWorkspaceRunSettings } from "../../../runtime";
import { useSettingsNavigationGuard } from "./navigation-guard";
import { clampIntegerSetting } from "./number-settings";
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

  const fields = [
    {
      key: "startupDelayMs",
      label: "First health check delay (ms)",
      inputLabel: "Startup delay in milliseconds",
    },
    {
      key: "healthCheckIntervalMs",
      label: "Health check interval (ms)",
      inputLabel: "Health check interval in milliseconds",
    },
    {
      key: "healthCheckTimeoutMs",
      label: "Health check timeout (ms)",
      inputLabel: "Health check timeout in milliseconds",
    },
    {
      key: "healthCheckFailureThreshold",
      label: "Health check failure threshold",
      inputLabel: "Health check failure threshold",
    },
    {
      key: "sequentialReadinessTimeoutMs",
      label: "Sequential readiness timeout (ms)",
      inputLabel: "Sequential readiness timeout in milliseconds",
    },
  ] as const;

  return (
    <SettingsCard title="Workspace Run">
      {fields.map(({ key, label, inputLabel }) => (
        <SettingPanel key={key} label={label}>
          <SettingsNumberInput
            aria-label={inputLabel}
            {...WORKSPACE_RUN_SETTING_BOUNDS[key]}
            max={
              key === "healthCheckTimeoutMs"
                ? Math.min(
                    WORKSPACE_RUN_SETTING_BOUNDS[key].max,
                    draft.healthCheckIntervalMs,
                  )
                : WORKSPACE_RUN_SETTING_BOUNDS[key].max
            }
            value={draft[key]}
            disabled={setup.saving}
            onValueChange={(value) =>
              setDraft((current) =>
                normalizeWorkspaceRunSettingsDraft({
                  ...current,
                  [key]: value,
                }),
              )
            }
            className="h-10 max-w-40 rounded-lg border-slate-800 bg-slate-950 text-slate-100 disabled:opacity-50"
          />
        </SettingPanel>
      ))}
      <SettingsAutoSaveStatus
        dirty={dirty}
        dirtyText="Run timeout changes not saved"
        cleanText="Run timeouts saved"
        saving={setup.saving}
        onSaveNow={async () => {
          await setup.onSave(normalizedDraft);
        }}
      />
      <SettingsStatus
        message={setup.message?.tone === "success" ? null : setup.message}
      />
    </SettingsCard>
  );
};
