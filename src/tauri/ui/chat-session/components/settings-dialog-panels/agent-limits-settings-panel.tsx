import { useEffect, useRef, useState, type JSX } from "react";
import {
  AGENT_LIMIT_BOUNDS,
  DEFAULT_USER_AGENT_LIMITS_SETTINGS,
} from "../../../../../core/runtime-contract.generated.js";
import { Input } from "../../../components/ui/input";
import {
  getCatalogModelsForProvider,
  getDefaultReviewModelForProvider,
  getProviderLabel,
  SUPPORTED_PROVIDER_ORDER,
  type ProviderModelCatalogSnapshot,
  type RuntimeProvider,
} from "../../../model-catalog";
import {
  loadProviderModelCatalog,
  type UserAgentLimitsSettings,
  type UserReviewModelSettings,
} from "../../../runtime";
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
import type { AgentLimitsSettingsControls } from "./types";
import { clampIntegerSetting, parseIntegerSettingInput } from "./number-settings";

export interface AgentLimitsSettingsPanelProps {
  setup: AgentLimitsSettingsControls;
}

const DEFAULT_REVIEW_MODEL_PROVIDER: RuntimeProvider = "openai";

const isRuntimeProvider = (provider: string | undefined): provider is RuntimeProvider => {
  return SUPPORTED_PROVIDER_ORDER.includes(provider as RuntimeProvider);
};

export const normalizeReviewModelDraft = (
  settings: UserReviewModelSettings,
  catalog: ProviderModelCatalogSnapshot | null = null,
): UserReviewModelSettings => {
  if (settings.mode !== "dedicated") {
    return { mode: "base" };
  }

  const provider = isRuntimeProvider(settings.provider)
    ? settings.provider
    : DEFAULT_REVIEW_MODEL_PROVIDER;
  const model =
    settings.model?.trim() || getDefaultReviewModelForProvider(provider, catalog);

  return {
    mode: "dedicated",
    provider,
    model,
  };
};

export const hasReviewModelDraftChanges = (
  left: UserReviewModelSettings,
  right: UserReviewModelSettings,
): boolean => {
  return (
    left.mode !== right.mode ||
    left.provider !== right.provider ||
    left.model !== right.model
  );
};

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
  const [reviewDraft, setReviewDraft] = useState<UserReviewModelSettings>(
    setup.reviewModelSettings,
  );
  const lastExternalSettingsRef = useRef(setup.settings);
  const lastExternalReviewSettingsRef = useRef(setup.reviewModelSettings);
  const suppressUnmountFlushRef = useRef(false);
  const [providerModelCatalog, setProviderModelCatalog] =
    useState<ProviderModelCatalogSnapshot | null>(null);
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);
  const normalizedDraft = normalizeAgentLimitsDraft(draft);
  const dirty = hasAgentLimitsDraftChanges(normalizedDraft, setup.settings);
  const normalizedReviewDraft = normalizeReviewModelDraft(
    reviewDraft,
    providerModelCatalog,
  );
  const normalizedSavedReviewSettings = normalizeReviewModelDraft(
    setup.reviewModelSettings,
    providerModelCatalog,
  );
  const reviewDirty = hasReviewModelDraftChanges(
    normalizedReviewDraft,
    normalizedSavedReviewSettings,
  );
  const reviewProvider =
    normalizedReviewDraft.mode === "dedicated" &&
    isRuntimeProvider(normalizedReviewDraft.provider)
      ? normalizedReviewDraft.provider
      : DEFAULT_REVIEW_MODEL_PROVIDER;
  const reviewModel =
    normalizedReviewDraft.mode === "dedicated"
      ? normalizedReviewDraft.model
      : getDefaultReviewModelForProvider(reviewProvider, providerModelCatalog);
  const reviewProviderModels = getCatalogModelsForProvider(
    reviewProvider,
    providerModelCatalog,
  );
  const reviewModelInCatalog = reviewProviderModels.some(
    (model) => model.id === reviewModel,
  );
  const reviewProviderConfigured =
    setup.providerAvailability.find(
      (provider) => provider.provider === reviewProvider,
    )?.configured ?? false;
  const reviewDraftValid =
    normalizedReviewDraft.mode === "base" || reviewProviderConfigured;
  const settingsDirty = dirty || reviewDirty;
  const dirtyText =
    dirty && reviewDirty
      ? "Unsaved agent execution changes"
      : dirty
        ? "Unsaved agent limit changes"
        : "Unsaved review model changes";
  const autoSaveSignature = JSON.stringify({
    agentLimits: normalizedDraft,
    reviewModel: normalizedReviewDraft,
  });
  const saveDirtySettings = async (): Promise<void> => {
    if (dirty) {
      const limitsSaved = await setup.onSave(normalizedDraft);

      if (limitsSaved === false) {
        return;
      }
    }

    if (reviewDirty && reviewDraftValid) {
      await setup.onReviewModelSave(normalizedReviewDraft);
    }
  };

  useDebouncedAutoSave({
    dirty: dirty || (reviewDirty && reviewDraftValid),
    saving: setup.saving,
    signature: autoSaveSignature,
    onSave: saveDirtySettings,
    suppressUnmountFlushRef,
  });

  useSettingsNavigationGuard({
    dirty: settingsDirty,
    title: "Unsaved agent settings",
    description: setup.saving
      ? "Wait for the current agent settings save to finish before leaving."
      : "Execution and review-model changes that have not been saved will be discarded.",
    canDiscard: !setup.saving,
    onDiscard: () => {
      suppressUnmountFlushRef.current = true;
      setDraft(setup.settings);
      setReviewDraft(setup.reviewModelSettings);
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

  useEffect(() => {
    const previousSettings = lastExternalReviewSettingsRef.current;
    lastExternalReviewSettingsRef.current = setup.reviewModelSettings;
    setReviewDraft((currentDraft) =>
      rebaseDirtySettingsDraft(
        currentDraft,
        previousSettings,
        setup.reviewModelSettings,
      ),
    );
  }, [setup.reviewModelSettings]);

  useEffect(() => {
    let cancelled = false;

    void loadProviderModelCatalog()
      .then((catalog) => {
        if (!cancelled) {
          setProviderModelCatalog(catalog);
          setModelCatalogError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("Failed to load provider model catalog", error);
          setModelCatalogError(
            "The current model catalog could not be loaded. Saved model values remain available.",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SettingsCard title="Agent execution">
      <div className="grid gap-0">
        <SettingPanel
          label="Limit mode"
          detail="The inactivity safety timeout still applies."
        >
          <ChoiceButtons
            label="Agent limit mode"
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
            aria-label="Executor turn limit"
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
          label="Machdoch continuations"
          detail="Executor cycles allowed after review feedback."
        >
          <Input
            aria-label="Machdoch continuation limit"
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

        <SettingPanel
          label="Review model"
          detail="Applies to validator and memory passes."
        >
          <ChoiceButtons
            label="Review model mode"
            value={normalizedReviewDraft.mode}
            options={[
              { value: "base", label: "Base" },
              { value: "dedicated", label: "Dedicated" },
            ]}
            disabled={setup.saving}
            onChange={(value) => {
              if (value === "base") {
                setReviewDraft({ mode: "base" });
                return;
              }

              setReviewDraft(
                normalizeReviewModelDraft(
                  {
                    mode: "dedicated",
                    provider: reviewProvider,
                    model: reviewModel,
                  },
                  providerModelCatalog,
                ),
              );
            }}
          />
        </SettingPanel>

        {normalizedReviewDraft.mode === "dedicated" ? (
          <>
            <SettingPanel
              label="Review provider"
              detail={
                reviewProviderConfigured
                  ? "API key is configured."
                  : "Provider key is not configured yet."
              }
            >
              <ChoiceButtons
                label="Review provider"
                value={reviewProvider}
                options={SUPPORTED_PROVIDER_ORDER.map((provider) => ({
                  value: provider,
                  label: getProviderLabel(provider),
                  disabled:
                    !setup.providerAvailability.some(
                      (availability) =>
                        availability.provider === provider &&
                        availability.configured,
                    ) && provider !== reviewProvider,
                  title: setup.providerAvailability.some(
                    (availability) =>
                      availability.provider === provider &&
                      availability.configured,
                  )
                    ? undefined
                    : "Add this provider's API key before selecting it.",
                }))}
                disabled={setup.saving}
                onChange={(value) => {
                  if (!isRuntimeProvider(value)) {
                    return;
                  }

                  setReviewDraft({
                    mode: "dedicated",
                    provider: value,
                    model: getDefaultReviewModelForProvider(
                      value,
                      providerModelCatalog,
                    ),
                  });
                }}
              />
            </SettingPanel>

            <SettingPanel
              label="Review LLM"
              detail="Choose a lower-cost model that still supports tool calls."
            >
              <select
                aria-label="Review LLM"
                value={reviewModel}
                disabled={setup.saving || !reviewProviderConfigured}
                onChange={(event) => {
                  setReviewDraft({
                    mode: "dedicated",
                    provider: reviewProvider,
                    model: event.target.value,
                  });
                }}
                className="h-10 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition-colors focus:border-sky-500/40 disabled:opacity-50"
              >
                {!reviewModelInCatalog ? (
                  <option value={reviewModel}>{reviewModel}</option>
                ) : null}
                {reviewProviderModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </SettingPanel>
          </>
        ) : null}
      </div>

      <SettingsAutoSaveStatus
        dirty={settingsDirty}
        dirtyText={dirtyText}
        cleanText="Agent execution settings are up to date"
        saving={setup.saving}
        onSaveNow={reviewDraftValid ? saveDirtySettings : undefined}
      />

      <SettingsStatus
        message={
          modelCatalogError
            ? { tone: "error", text: modelCatalogError }
            : normalizedReviewDraft.mode === "dedicated" &&
                !reviewProviderConfigured
              ? {
                  tone: "error",
                  text: `${getProviderLabel(reviewProvider)} needs an API key before it can run review passes.`,
                }
              : null
        }
      />
      <SettingsStatus message={setup.message} />
    </SettingsCard>
  );
};
