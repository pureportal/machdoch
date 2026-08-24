import { useEffect, useState, type JSX } from "react";
import {
  MAX_CONTEXT_WINDOW_TOKENS,
  MIN_CONTEXT_WINDOW_TOKENS,
} from "../../../../../core/runtime-contract.generated.js";
import { getModelContextWindowTokens } from "../../../../../core/model-capabilities.js";
import { supportsLongContextWindow } from "../../../../../core/context-windows.js";
import { getReasoningExecutionModesForProviderModel } from "../../../../../core/reasoning-execution-modes.js";
import { Input } from "../../../components/ui/input";
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

const getEffectiveContextNotice = ({
  defaultContextWindow,
  effectiveContextWindow,
}: WorkspaceSettingsControls): string | null => {
  if (effectiveContextWindow === defaultContextWindow) {
    return null;
  }

  const value =
    typeof effectiveContextWindow === "number"
      ? `${effectiveContextWindow.toLocaleString()} tokens`
      : effectiveContextWindow === "long"
        ? "Long"
        : "Default";

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
  const [contextTokenDraft, setContextTokenDraft] = useState("");

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

  useEffect(() => {
    setContextTokenDraft(
      typeof setup.defaultContextWindow === "number"
        ? String(setup.defaultContextWindow)
        : "",
    );
  }, [setup.defaultContextWindow]);

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
  const supportsLongContext =
    setup.reasoningProvider === "copilot-cli"
      ? typeof catalogModel?.capabilities?.longContextWindowTokens === "number"
      : setup.reasoningProvider !== null &&
        setup.reasoningProvider !== undefined &&
        supportsLongContextWindow(
          setup.reasoningProvider,
          setup.reasoningModel,
        );
  const supportsNumericContext = setup.reasoningProvider === "codex-cli";
  const maximumContextTokens =
    catalogModel?.capabilities?.longContextWindowTokens ??
    catalogModel?.capabilities?.contextWindowTokens ??
    (setup.reasoningProvider && setup.reasoningModel
      ? getModelContextWindowTokens(
          setup.reasoningProvider,
          setup.reasoningModel,
        )
      : null) ??
    MAX_CONTEXT_WINDOW_TOKENS;

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
      <SettingPanel label="Default mode" detail={getDefaultModeDetail(setup)}>
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

      <SettingPanel
        label="Reasoning effort"
        detail={getDefaultModeDetail(setup)}
      >
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

      {supportsLongContext ? (
        <SettingPanel label="Context window">
          <ChoiceButtons
            label="Default workspace context window"
            value={setup.defaultContextWindow === "long" ? "long" : "default"}
            options={[
              { value: "default", label: "Default" },
              {
                value: "long",
                label:
                  setup.reasoningProvider === "copilot-cli"
                    ? "Long (tiered pricing)"
                    : "Long",
              },
            ]}
            disabled={setup.saving || !setup.workspaceRoot}
            onChange={(contextWindow) => {
              void setup.onContextWindowChange(contextWindow);
            }}
          />
        </SettingPanel>
      ) : null}

      {supportsNumericContext ? (
        <SettingPanel label="Context window">
          <Input
            aria-label="Default workspace context window tokens"
            type="number"
            min={MIN_CONTEXT_WINDOW_TOKENS}
            max={maximumContextTokens}
            step="1"
            placeholder="Provider default"
            value={contextTokenDraft}
            disabled={setup.saving || !setup.workspaceRoot}
            onChange={(event) => {
              setContextTokenDraft(event.target.value);
            }}
            onBlur={() => {
              const tokens = Number(contextTokenDraft);

              if (!contextTokenDraft) {
                void setup.onContextWindowChange("default");
              } else if (
                Number.isInteger(tokens) &&
                tokens >= MIN_CONTEXT_WINDOW_TOKENS &&
                tokens <= maximumContextTokens
              ) {
                void setup.onContextWindowChange(tokens);
              } else {
                setContextTokenDraft(
                  typeof setup.defaultContextWindow === "number"
                    ? String(setup.defaultContextWindow)
                    : "",
                );
              }
            }}
            className="h-10 max-w-48 rounded-lg border-slate-800 bg-slate-950 text-slate-100 disabled:opacity-50"
          />
        </SettingPanel>
      ) : null}

      {effectiveContextNotice &&
      (supportsLongContext || supportsNumericContext) ? (
        <p
          role="note"
          className="border-b border-slate-800/75 py-4 text-sm leading-6 text-amber-200"
        >
          {effectiveContextNotice}
        </p>
      ) : null}

      <p
        role="status"
        aria-live="polite"
        className="border-t border-slate-800 pt-4 text-sm leading-6 text-slate-400"
      >
        {!setup.workspaceRoot
          ? "Select a workspace to change these defaults."
          : setup.saving
            ? "Saving workspace defaults…"
            : "Workspace defaults are up to date."}
      </p>

      <SettingsStatus message={setup.message} />
    </SettingsCard>
  );
};
