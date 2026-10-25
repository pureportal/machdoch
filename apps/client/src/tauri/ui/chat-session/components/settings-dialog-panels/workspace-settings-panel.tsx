import { useEffect, useState, type JSX } from "react";
import {
  CONTEXT_WINDOW_LABELS,
  contextWindowSchema,
} from "@machdoch/fleet-protocol/context-window";
import { getReasoningExecutionModesForProviderModel } from "@machdoch/model-runtime/reasoning-execution-modes";
import {
  getCatalogModelForProvider,
  type ProviderModelCatalogSnapshot,
} from "../../../model-catalog";
import { loadProviderModelCatalog } from "../../../runtime";
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
import { useSettingsNavigationGuard } from "./navigation-guard";
import type { WorkspaceSettingsControls } from "./types";

export interface WorkspaceSettingsPanelProps {
  setup: WorkspaceSettingsControls;
}

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

const getEffectiveContextNotice = ({
  defaultContextWindow,
  effectiveContextWindow,
}: WorkspaceSettingsControls): string | null => {
  if (effectiveContextWindow === defaultContextWindow) {
    return null;
  }

  const value = CONTEXT_WINDOW_LABELS[effectiveContextWindow];

  return `Effective context window is currently ${value} because an environment override is active.`;
};

const getEffectiveReasoningExecutionModeNotice = ({
  defaultReasoningExecutionMode,
  effectiveReasoningExecutionMode,
}: WorkspaceSettingsControls): string | null =>
  effectiveReasoningExecutionMode === defaultReasoningExecutionMode
    ? null
    : `Effective reasoning mode is currently ${effectiveReasoningExecutionMode === "pro" ? "Pro" : "Standard"} because an environment override is active.`;

export const WorkspaceSettingsPanel = ({
  setup,
}: WorkspaceSettingsPanelProps): JSX.Element => {
  const [providerModelCatalog, setProviderModelCatalog] =
    useState<ProviderModelCatalogSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;

    void loadProviderModelCatalog().then((catalog) => {
      if (!cancelled) {
        setProviderModelCatalog(catalog);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const catalogModel =
    setup.reasoningProvider && setup.reasoningModel
      ? getCatalogModelForProvider(
          setup.reasoningProvider,
          setup.reasoningModel,
          providerModelCatalog,
        )
      : undefined;
  const effectiveModeNotice = getEffectiveModeNotice(setup);
  const effectiveReasoningNotice = getEffectiveReasoningNotice(setup);
  const effectiveContextNotice = getEffectiveContextNotice(setup);
  const effectiveReasoningExecutionModeNotice =
    getEffectiveReasoningExecutionModeNotice(setup);
  const workspaceReasoningOptions = getReasoningModesForProvider(
    setup.reasoningProvider ?? null,
    setup.reasoningModel,
    catalogModel?.capabilities,
  );
  const defaultReasoning = normalizeReasoningModeForProvider(
    setup.defaultReasoning,
    setup.reasoningProvider ?? null,
    setup.reasoningModel,
    catalogModel?.capabilities,
  );
  const reasoningExecutionModes = getReasoningExecutionModesForProviderModel(
    setup.reasoningProvider ?? null,
    setup.reasoningModel,
  );
  useSettingsNavigationGuard({
    dirty: setup.saving,
    title: "Saving workspace defaults",
    description:
      "Wait for the workspace defaults to finish saving before leaving this section.",
    canDiscard: false,
    onDiscard: () => undefined,
  });

  return (
    <SettingsCard
      title="Workspace defaults"
      description="Defaults apply when a session uses Workspace default."
    >
      <SettingPanel label="Workspace memory">
        <ChoiceButtons
          label="Workspace memory override"
          value={
            setup.workspaceMemoryOverride === null ||
            setup.workspaceMemoryOverride === undefined
              ? "default"
              : setup.workspaceMemoryOverride
                ? "enabled"
                : "disabled"
          }
          options={[
            {
              value: "default",
              label: `Default (${setup.workspaceMemoryDefaultEnabled !== false ? "Enabled" : "Disabled"})`,
            },
            { value: "enabled", label: "Enabled" },
            { value: "disabled", label: "Disabled" },
          ]}
          disabled={setup.saving || !setup.workspaceRoot}
          onChange={(value) => {
            void setup.onWorkspaceMemoryOverrideChange?.(
              value === "default" ? null : value === "enabled",
            );
          }}
        />
      </SettingPanel>

      <SettingPanel label="Adaptive context & compute">
        <ChoiceButtons
          label="Adaptive context & compute override"
          value={
            setup.adaptiveControllerOverride === null ||
            setup.adaptiveControllerOverride === undefined
              ? "default"
              : setup.adaptiveControllerOverride
                ? "enabled"
                : "disabled"
          }
          options={[
            { value: "default", label: "Default" },
            { value: "enabled", label: "Enabled" },
            { value: "disabled", label: "Disabled" },
          ]}
          disabled={setup.saving || !setup.workspaceRoot}
          onChange={(value) => {
            void setup.onAdaptiveControllerOverrideChange?.(
              value === "default" ? null : value === "enabled",
            );
          }}
        />
      </SettingPanel>

      {setup.onReasoningBankEnabledChange ? (
        <SettingPanel label="ReasoningBank">
          <ChoiceButtons
            label="ReasoningBank status"
            value={
              setup.reasoningBankEnabled === false ? "disabled" : "enabled"
            }
            options={[
              { value: "enabled", label: "Enabled" },
              { value: "disabled", label: "Disabled" },
            ]}
            disabled={setup.saving || !setup.workspaceRoot}
            onChange={(value) => {
              void setup.onReasoningBankEnabledChange?.(value === "enabled");
            }}
          />
        </SettingPanel>
      ) : null}

      {setup.onAutoGitignoreChange ? (
        <SettingPanel label="Automatic .gitignore rules">
          <ChoiceButtons
            label="Automatic .gitignore rules"
            value={setup.autoGitignore === false ? "disabled" : "enabled"}
            options={[
              { value: "enabled", label: "Enabled" },
              { value: "disabled", label: "Disabled" },
            ]}
            disabled={setup.saving || !setup.workspaceRoot}
            onChange={(value) => {
              void setup.onAutoGitignoreChange?.(value === "enabled");
            }}
          />
        </SettingPanel>
      ) : null}

      <SettingPanel label="Default mode">
        <ChoiceButtons
          label="Default workspace mode"
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
        <p
          role="note"
          className="border-b border-slate-800/75 py-4 text-sm leading-6 text-amber-200"
        >
          {effectiveModeNotice}
        </p>
      ) : null}

      <SettingPanel label="Reasoning effort">
        <ChoiceButtons
          label="Default workspace reasoning mode"
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
        <p
          role="note"
          className="border-b border-slate-800/75 py-4 text-sm leading-6 text-amber-200"
        >
          {effectiveReasoningNotice}
        </p>
      ) : null}

      {reasoningExecutionModes.length > 1 ? (
        <SettingPanel label="Reasoning mode">
          <ChoiceButtons
            label="Default workspace reasoning mode"
            value={setup.defaultReasoningExecutionMode}
            options={reasoningExecutionModes.map((reasoningMode) => ({
              value: reasoningMode,
              label: reasoningMode === "pro" ? "Pro" : "Standard",
            }))}
            disabled={setup.saving || !setup.workspaceRoot}
            onChange={(reasoningMode) => {
              void setup.onReasoningExecutionModeChange(reasoningMode);
            }}
          />
        </SettingPanel>
      ) : null}

      {effectiveReasoningExecutionModeNotice ? (
        <p
          role="note"
          className="border-b border-slate-800/75 py-4 text-sm leading-6 text-amber-200"
        >
          {effectiveReasoningExecutionModeNotice}
        </p>
      ) : null}

      <SettingPanel label="Context size">
        <ChoiceButtons
          label="Default workspace context size"
          value={setup.defaultContextWindow}
          options={contextWindowSchema.options.map((value) => ({
            value,
            label: CONTEXT_WINDOW_LABELS[value],
          }))}
          disabled={setup.saving || !setup.workspaceRoot}
          onChange={(value) => void setup.onContextWindowChange(value)}
        />
      </SettingPanel>

      {effectiveContextNotice ? (
        <p
          role="note"
          className="border-b border-slate-800/75 py-4 text-sm leading-6 text-amber-200"
        >
          {effectiveContextNotice}
        </p>
      ) : null}

      {!setup.workspaceRoot || setup.saving ? (
        <p
          role="status"
          aria-live="polite"
          className="border-t border-slate-800 pt-4 text-sm leading-6 text-slate-400"
        >
          {!setup.workspaceRoot
            ? "Select a workspace to change these defaults."
            : "Saving workspace defaults…"}
        </p>
      ) : null}

      <SettingsStatus message={setup.message} />
    </SettingsCard>
  );
};
