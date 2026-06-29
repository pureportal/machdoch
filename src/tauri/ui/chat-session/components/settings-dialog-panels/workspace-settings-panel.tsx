import type { JSX } from "react";
import { RUN_MODE_META } from "../../_helpers/session-shell";
import {
  getReasoningModesForProvider,
  normalizeReasoningModeForProvider,
  REASONING_LABELS,
} from "../../../reasoning-options";
import {
  ChoiceButtons,
  SettingPanel,
  SettingsCard,
  SettingsStatus,
} from "./shared";
import type { WorkspaceSettingsControls } from "./types";

export interface WorkspaceSettingsPanelProps {
  setup: WorkspaceSettingsControls;
}

const getDefaultModeDetail = ({
  workspaceRoot,
  workspaceLabel,
}: WorkspaceSettingsControls): string => {
  if (!workspaceRoot) {
    return "Select a workspace before writing .machdoch/config.json.";
  }

  return `Saves to ${workspaceLabel} workspace config.`;
};

const getEffectiveModeNotice = ({
  defaultMode,
  effectiveMode,
}: WorkspaceSettingsControls): string | null => {
  if (effectiveMode === defaultMode) {
    return null;
  }

  const effectiveLabel = RUN_MODE_META[effectiveMode].label;

  return `Effective mode is currently ${effectiveLabel} because an environment override is active.`;
};

const getEffectiveReasoningNotice = ({
  defaultReasoning,
  effectiveReasoning,
  reasoningProvider,
  reasoningModel,
}: WorkspaceSettingsControls): string | null => {
  const displayDefaultReasoning = normalizeReasoningModeForProvider(
    defaultReasoning,
    reasoningProvider ?? null,
    reasoningModel,
  );
  const displayEffectiveReasoning = normalizeReasoningModeForProvider(
    effectiveReasoning,
    reasoningProvider ?? null,
    reasoningModel,
  );

  if (displayEffectiveReasoning === displayDefaultReasoning) {
    return null;
  }

  const effectiveLabel = REASONING_LABELS[displayEffectiveReasoning];

  return `Effective reasoning is currently ${effectiveLabel} because an environment override is active.`;
};

export const WorkspaceSettingsPanel = ({
  setup,
}: WorkspaceSettingsPanelProps): JSX.Element => {
  const effectiveModeNotice = getEffectiveModeNotice(setup);
  const effectiveReasoningNotice = getEffectiveReasoningNotice(setup);
  const workspaceReasoningOptions = getReasoningModesForProvider(
    setup.reasoningProvider ?? null,
    setup.reasoningModel,
  );
  const defaultReasoning = normalizeReasoningModeForProvider(
    setup.defaultReasoning,
    setup.reasoningProvider ?? null,
    setup.reasoningModel,
  );

  return (
    <SettingsCard
      title="Workspace defaults"
      description="Defaults apply when a session uses Workspace default."
    >
      <SettingPanel label="Default mode" detail={getDefaultModeDetail(setup)}>
        <ChoiceButtons
          value={setup.defaultMode}
          options={[
            { value: "ask", label: "Ask" },
            { value: "machdoch", label: "Machdoch" },
          ]}
          disabled={setup.saving || !setup.workspaceRoot}
          onChange={(mode) => {
            void setup.onDefaultModeChange(mode);
          }}
        />
      </SettingPanel>

      {effectiveModeNotice ? (
        <p className="border-b border-slate-800/75 py-4 text-sm leading-6 text-slate-400">
          {effectiveModeNotice}
        </p>
      ) : null}

      <SettingPanel
        label="Reasoning mode"
        detail={getDefaultModeDetail(setup)}
      >
        <ChoiceButtons
          value={defaultReasoning}
          options={workspaceReasoningOptions.map((reasoning) => ({
            value: reasoning,
            label: REASONING_LABELS[reasoning],
          }))}
          disabled={setup.saving || !setup.workspaceRoot}
          onChange={(reasoning) => {
            void setup.onReasoningModeChange(reasoning);
          }}
        />
      </SettingPanel>

      {effectiveReasoningNotice ? (
        <p className="border-b border-slate-800/75 py-4 text-sm leading-6 text-slate-400">
          {effectiveReasoningNotice}
        </p>
      ) : null}

      <p className="border-t border-slate-800 pt-4 text-sm leading-6 text-slate-400">
        {setup.saving
          ? "Saving workspace defaults..."
          : "Workspace defaults are up to date"}
      </p>

      <SettingsStatus message={setup.message} />
    </SettingsCard>
  );
};
