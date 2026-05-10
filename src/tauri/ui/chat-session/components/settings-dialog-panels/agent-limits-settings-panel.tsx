import { useEffect, useState, type JSX } from "react";
import {
  AGENT_LIMIT_BOUNDS,
  DEFAULT_USER_AGENT_LIMITS_SETTINGS,
} from "../../../../../core/runtime-contract.generated.js";
import { Input } from "../../../components/ui/input";
import type { UserAgentLimitsSettings } from "../../../runtime";
import {
  ChoiceButtons,
  SettingPanel,
  SettingsCard,
  SettingsSaveBar,
  SettingsStatus,
} from "./shared";
import type { AgentLimitsSettingsControls } from "./types";
import { clampIntegerSetting, parseIntegerSettingInput } from "./number-settings";

export interface AgentLimitsSettingsPanelProps {
  setup: AgentLimitsSettingsControls;
}

export const normalizeAgentLimitsDraft = (
  settings: UserAgentLimitsSettings,
): UserAgentLimitsSettings => {
  return {
    infinite: settings.infinite,
    executorTurns: clampIntegerSetting(
      settings.executorTurns,
      AGENT_LIMIT_BOUNDS.executorTurns.min,
      AGENT_LIMIT_BOUNDS.executorTurns.max,
      DEFAULT_USER_AGENT_LIMITS_SETTINGS.executorTurns,
    ),
    autopilotExecutorIterations: clampIntegerSetting(
      settings.autopilotExecutorIterations,
      AGENT_LIMIT_BOUNDS.autopilotExecutorIterations.min,
      AGENT_LIMIT_BOUNDS.autopilotExecutorIterations.max,
      DEFAULT_USER_AGENT_LIMITS_SETTINGS.autopilotExecutorIterations,
    ),
  };
};

export const hasAgentLimitsDraftChanges = (
  left: UserAgentLimitsSettings,
  right: UserAgentLimitsSettings,
): boolean => {
  return (
    left.infinite !== right.infinite ||
    left.executorTurns !== right.executorTurns ||
    left.autopilotExecutorIterations !== right.autopilotExecutorIterations
  );
};

export const AgentLimitsSettingsPanel = ({
  setup,
}: AgentLimitsSettingsPanelProps): JSX.Element => {
  const [draft, setDraft] = useState<UserAgentLimitsSettings>(setup.settings);
  const normalizedDraft = normalizeAgentLimitsDraft(draft);
  const dirty = hasAgentLimitsDraftChanges(normalizedDraft, setup.settings);

  useEffect(() => {
    setDraft(setup.settings);
  }, [setup.settings]);

  return (
    <SettingsCard
      title="Agent loop limits"
      description="Numeric settings are validated and normalized before saving."
    >
      <div className="grid gap-0">
        <SettingPanel
          label="Limit mode"
          detail="The wall-clock safety timeout still applies."
        >
          <ChoiceButtons
            value={draft.infinite ? "infinite" : "finite"}
            options={[
              { value: "finite", label: "Finite" },
              { value: "infinite", label: "Infinite" },
            ]}
            disabled={setup.saving}
            onChange={(value) => {
              setDraft({
                ...draft,
                infinite: value === "infinite",
              });
            }}
          />
        </SettingPanel>

        <SettingPanel
          label="Executor turns"
          detail="Model/tool turns inside one executor cycle."
        >
          <Input
            type="number"
            min={AGENT_LIMIT_BOUNDS.executorTurns.min}
            max={AGENT_LIMIT_BOUNDS.executorTurns.max}
            step="1"
            value={draft.executorTurns}
            disabled={setup.saving || draft.infinite}
            onChange={(event) => {
              setDraft({
                ...draft,
                executorTurns: parseIntegerSettingInput(
                  event.target.value,
                  AGENT_LIMIT_BOUNDS.executorTurns.min,
                  AGENT_LIMIT_BOUNDS.executorTurns.max,
                  draft.executorTurns,
                ),
              });
            }}
            className="h-10 max-w-32 rounded-lg border-slate-800 bg-slate-950 text-slate-100 disabled:opacity-50"
          />
        </SettingPanel>

        <SettingPanel
          label="Autopilot iterations"
          detail="Executor cycles allowed after monitor feedback."
        >
          <Input
            type="number"
            min={AGENT_LIMIT_BOUNDS.autopilotExecutorIterations.min}
            max={AGENT_LIMIT_BOUNDS.autopilotExecutorIterations.max}
            step="1"
            value={draft.autopilotExecutorIterations}
            disabled={setup.saving || draft.infinite}
            onChange={(event) => {
              setDraft({
                ...draft,
                autopilotExecutorIterations: parseIntegerSettingInput(
                  event.target.value,
                  AGENT_LIMIT_BOUNDS.autopilotExecutorIterations.min,
                  AGENT_LIMIT_BOUNDS.autopilotExecutorIterations.max,
                  draft.autopilotExecutorIterations,
                ),
              });
            }}
            className="h-10 max-w-32 rounded-lg border-slate-800 bg-slate-950 text-slate-100 disabled:opacity-50"
          />
        </SettingPanel>
      </div>

      <SettingsSaveBar
        dirty={dirty}
        dirtyText="Unsaved agent limit changes"
        cleanText="Agent loop limits are up to date"
        saveLabel="Save agent limits"
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
