import { useEffect, useMemo, useState, type JSX } from "react";
import {
  getInternalTaskProviderModels,
  resolveInternalTaskModelSelection,
  type InternalTaskModelSelection,
} from "../../../internal-task-model";
import {
  getModelLabelForProvider,
  getProviderLabel,
} from "../../../model-catalog";
import {
  getReasoningModesForProvider,
  normalizeReasoningModeForProvider,
  REASONING_LABELS,
} from "../../../reasoning-options";
import {
  loadProviderModelCatalog,
  loadUserInternalTaskModelSettings,
  saveUserInternalTaskModelSettings,
  type RuntimeProviderAvailability,
  type UserInternalTaskModelSettings,
} from "../../../runtime";
import { SettingPanel, SettingsCard, SettingsStatus } from "./shared";
import type { SettingsStatusMessage } from "./types";

export const InternalTaskModelSettingsPanel = ({
  providerAvailability,
}: {
  providerAvailability: readonly RuntimeProviderAvailability[];
}): JSX.Element => {
  const [settings, setSettings] = useState<UserInternalTaskModelSettings>({
    reasoning: "default",
  });
  const [catalog, setCatalog] = useState<Awaited<
    ReturnType<typeof loadProviderModelCatalog>
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<SettingsStatusMessage | null>(null);
  const availabilitySignature = providerAvailability
    .map((entry) => `${entry.provider}:${entry.configured}`)
    .join("|");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMessage(null);

    void Promise.all([
      loadUserInternalTaskModelSettings(),
      loadProviderModelCatalog(),
    ])
      .then(([nextSettings, nextCatalog]) => {
        if (cancelled) {
          return;
        }

        setSettings(nextSettings);
        setCatalog(nextCatalog);
      })
      .catch((error) => {
        if (!cancelled) {
          setMessage({
            tone: "error",
            text:
              error instanceof Error
                ? error.message
                : "Internal task model settings could not be loaded.",
          });
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [availabilitySignature]);

  const providers = useMemo(
    () =>
      catalog
        ? getInternalTaskProviderModels(providerAvailability, catalog)
        : [],
    [catalog, providerAvailability],
  );
  const selection = catalog
    ? resolveInternalTaskModelSelection(settings, providerAvailability, catalog)
    : null;
  const selectedProvider = providers.find(
    (entry) => entry.provider === selection?.provider,
  );
  const providerOptions =
    selection && !selectedProvider
      ? [{ provider: selection.provider, models: [] }, ...providers]
      : providers;
  const modelOptions =
    selectedProvider?.models ??
    (selection
      ? [
          {
            id: selection.model,
            label: getModelLabelForProvider(
              selection.provider,
              selection.model,
              catalog,
            ),
          },
        ]
      : []);
  const selectedModel = selectedProvider?.models.find(
    (model) => model.id === selection?.model,
  );
  const reasoningOptions = selection
    ? getReasoningModesForProvider(
        selection.provider,
        selection.model,
        selectedModel?.capabilities,
      )
    : (["default"] as const);

  const saveSelection = async (
    nextSelection: InternalTaskModelSelection,
  ): Promise<void> => {
    const previousSettings = settings;
    setSettings(nextSelection);
    setSaving(true);
    setMessage(null);

    try {
      setSettings(await saveUserInternalTaskModelSettings(nextSelection));
    } catch (error) {
      setSettings(previousSettings);
      setMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "Internal task model settings could not be saved.",
      });
    } finally {
      setSaving(false);
    }
  };

  const disabled = loading || saving || providerOptions.length === 0;

  return (
    <SettingsCard title="Internal tasks">
      <SettingPanel label="Provider">
        <select
          aria-label="Internal task provider"
          value={selection?.provider ?? ""}
          disabled={disabled}
          onChange={(event) => {
            const provider = providers.find(
              (entry) => entry.provider === event.target.value,
            );
            const model = provider?.models[0];

            if (provider && model) {
              void saveSelection({
                provider: provider.provider,
                model: model.id,
                reasoning: normalizeReasoningModeForProvider(
                  settings.reasoning,
                  provider.provider,
                  model.id,
                  model.capabilities,
                ),
              });
            }
          }}
          className="h-10 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition-colors focus:border-sky-500/40 disabled:opacity-50"
        >
          {providerOptions.length === 0 ? (
            <option value="">{loading ? "Loading" : "None configured"}</option>
          ) : null}
          {providerOptions.map((entry) => (
            <option key={entry.provider} value={entry.provider}>
              {getProviderLabel(entry.provider)}
            </option>
          ))}
        </select>
      </SettingPanel>

      <SettingPanel label="Model">
        <select
          aria-label="Internal task model"
          value={selection?.model ?? ""}
          disabled={disabled || !selection}
          onChange={(event) => {
            if (selectedProvider) {
              const model = selectedProvider.models.find(
                (entry) => entry.id === event.target.value,
              );

              if (!model) {
                return;
              }

              void saveSelection({
                provider: selectedProvider.provider,
                model: model.id,
                reasoning: normalizeReasoningModeForProvider(
                  settings.reasoning,
                  selectedProvider.provider,
                  model.id,
                  model.capabilities,
                ),
              });
            }
          }}
          className="h-10 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition-colors focus:border-sky-500/40 disabled:opacity-50"
        >
          {modelOptions.length === 0 ? <option value="" /> : null}
          {modelOptions.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      </SettingPanel>

      <SettingPanel label="Reasoning">
        <select
          aria-label="Internal task reasoning"
          value={selection?.reasoning ?? "default"}
          disabled={disabled || !selection}
          onChange={(event) => {
            const reasoning = reasoningOptions.find(
              (mode) => mode === event.target.value,
            );

            if (selection && reasoning) {
              void saveSelection({
                ...selection,
                reasoning,
              });
            }
          }}
          className="h-10 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition-colors focus:border-sky-500/40 disabled:opacity-50"
        >
          {reasoningOptions.map((reasoning) => (
            <option key={reasoning} value={reasoning}>
              {REASONING_LABELS[reasoning]}
            </option>
          ))}
        </select>
      </SettingPanel>

      <SettingsStatus message={message} />
    </SettingsCard>
  );
};
