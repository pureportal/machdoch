import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Check,
  ChevronDown,
  LoaderCircle,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import { RalphFlowEditor } from "./ralph-flow-editor";
import {
  createInitialShellState,
  normalizeShellState,
  rememberRecentWorkspace,
  type ShellPersistedState,
} from "../chat-session.model";
import { getWorkspaceLabel } from "../chat-session/_helpers/session-shell";
import { WorkspacePicker } from "../chat-session/components/workspace-picker";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Input } from "../components/ui/input";
import {
  DEFAULT_RALPH_SETTINGS,
  broadcastShellStateChanged,
  loadRalphSettings,
  loadShellState,
  saveRalphSettings,
  saveShellState,
  subscribeToShellStateChanged,
  type RalphSettings,
} from "../lib/shell-store";
import { cn } from "../lib/utils";
import {
  getCatalogModelsForProvider,
  getDefaultModelForProvider,
  getProviderLabel,
  RUNNABLE_PROVIDER_ORDER,
  type CatalogModel,
  type ProviderModelCatalogSnapshot,
  type RuntimeProvider,
} from "../model-catalog";
import {
  loadGlobalProviderAvailability,
  loadProviderModelCatalog,
  type ReasoningMode,
  type RuntimeProviderAvailability,
} from "../runtime";
import {
  getReasoningModesForProvider,
  normalizeReasoningModeForProvider,
  REASONING_LABELS,
} from "../reasoning-options";

interface RuntimeModelPickerProps {
  label: string;
  provider: RuntimeProvider;
  model: string;
  catalog: ProviderModelCatalogSnapshot | null;
  providers: readonly RuntimeProvider[];
  onChange: (provider: RuntimeProvider, model: string) => void;
}

const isRalphRunnableProvider = (
  provider: RuntimeProvider,
): boolean => {
  return RUNNABLE_PROVIDER_ORDER.includes(provider);
};

const getPreferredModelForProvider = (
  provider: RuntimeProvider,
  catalog: ProviderModelCatalogSnapshot | null,
): string => {
  const models = getCatalogModelsForProvider(provider, catalog);
  const defaultModel = getDefaultModelForProvider(provider);

  return models.some((model) => model.id === defaultModel)
    ? defaultModel
    : models[0]?.id ?? defaultModel;
};

const getModelLabel = (models: CatalogModel[], model: string): string => {
  return models.find((entry) => entry.id === model)?.label ?? model;
};

const loadSharedShellState = async (): Promise<ShellPersistedState> => {
  return normalizeShellState(await loadShellState(createInitialShellState()));
};

const RuntimeModelPicker = ({
  label,
  provider,
  model,
  catalog,
  providers,
  onChange,
}: RuntimeModelPickerProps): JSX.Element => {
  const models = useMemo(
    () => getCatalogModelsForProvider(provider, catalog),
    [catalog, provider],
  );
  const modelLabel = getModelLabel(models, model);

  return (
    <div className="grid min-w-0 grid-cols-[7rem_minmax(0,1fr)] gap-2">
      <label className="grid min-w-0 gap-1">
        <span className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-slate-500">
          {label}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className="h-9 min-w-0 justify-between rounded-lg border-slate-700 bg-slate-950 px-3 text-sm font-medium text-slate-100 shadow-none hover:border-slate-600 hover:bg-slate-900"
            >
              <span className="truncate">{getProviderLabel(provider)}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            sideOffset={5}
            className="z-[90] min-w-[var(--radix-dropdown-menu-trigger-width)] rounded-md border border-slate-700 bg-slate-950 p-1 text-slate-100 shadow-xl shadow-black/30"
          >
            {providers.map((nextProvider) => {
              const active = nextProvider === provider;

              return (
                <DropdownMenuItem
                  key={nextProvider}
                  onSelect={() => {
                    onChange(
                      nextProvider,
                      getPreferredModelForProvider(nextProvider, catalog),
                    );
                  }}
                  className={cn(
                    "flex min-w-0 cursor-pointer items-center justify-between gap-3 rounded px-2 py-1.5 text-xs font-medium outline-none focus:bg-sky-500/15 focus:text-sky-100",
                    active ? "bg-sky-500/10 text-sky-100" : "text-slate-300",
                  )}
                >
                  <span className="min-w-0 truncate">
                    {getProviderLabel(nextProvider)}
                  </span>
                  {active ? (
                    <Check className="h-3.5 w-3.5 shrink-0 text-sky-300" />
                  ) : null}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </label>

      <label className="grid min-w-0 gap-1">
        <span className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-slate-500">
          Model
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className="h-9 min-w-0 justify-between rounded-lg border-slate-700 bg-slate-950 px-3 text-sm font-medium text-slate-100 shadow-none hover:border-slate-600 hover:bg-slate-900"
            >
              <span className="truncate">{modelLabel}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            sideOffset={5}
            className="z-[90] min-w-[var(--radix-dropdown-menu-trigger-width)] rounded-md border border-slate-700 bg-slate-950 p-1 text-slate-100 shadow-xl shadow-black/30"
          >
            {models.map((entry) => {
              const active = entry.id === model;

              return (
                <DropdownMenuItem
                  key={entry.id}
                  onSelect={() => onChange(provider, entry.id)}
                  className={cn(
                    "flex min-w-0 cursor-pointer items-center justify-between gap-3 rounded px-2 py-1.5 text-xs font-medium outline-none focus:bg-sky-500/15 focus:text-sky-100",
                    active ? "bg-sky-500/10 text-sky-100" : "text-slate-300",
                  )}
                >
                  <span className="min-w-0 truncate">{entry.label}</span>
                  {active ? (
                    <Check className="h-3.5 w-3.5 shrink-0 text-sky-300" />
                  ) : null}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </label>
    </div>
  );
};

export const getConnectedRalphProviderChoices = (
  providerAvailability: readonly RuntimeProviderAvailability[],
  catalog: ProviderModelCatalogSnapshot | null = null,
): RuntimeProvider[] => {
  const providerConfigured = new Map(
    providerAvailability.map((entry) => [entry.provider, entry.configured]),
  );
  const catalogAvailable = new Map(
    (catalog?.providers ?? []).map((entry) => [entry.provider, entry.available]),
  );

  return RUNNABLE_PROVIDER_ORDER.filter(
    (provider) =>
      (providerConfigured.get(provider) ?? false) ||
      (catalogAvailable.get(provider) ?? false),
  );
};

export const getRalphProviderChoices = (
  providerAvailability: readonly RuntimeProviderAvailability[],
  catalog: ProviderModelCatalogSnapshot | null = null,
): RuntimeProvider[] => {
  const connectedProviders =
    getConnectedRalphProviderChoices(providerAvailability, catalog);

  return connectedProviders.length > 0
    ? connectedProviders
    : [...RUNNABLE_PROVIDER_ORDER];
};

const getPendingRalphProviderChoices = (
  settings: RalphSettings,
): RuntimeProvider[] => {
  const providers = [
    settings.generationProvider,
    settings.runProvider,
  ].filter(isRalphRunnableProvider);

  return providers.length > 0
    ? Array.from(new Set(providers))
    : [...RUNNABLE_PROVIDER_ORDER];
};

const normalizeRalphProviderModel = (
  provider: RuntimeProvider,
  model: string,
  providers: readonly RuntimeProvider[] = RUNNABLE_PROVIDER_ORDER,
): { provider: RuntimeProvider; model: string } => {
  if (providers.includes(provider)) {
    return { provider, model };
  }

  const fallbackProvider = providers[0] ?? RUNNABLE_PROVIDER_ORDER[0] ?? "openai";

  return {
    provider: fallbackProvider,
    model: getDefaultModelForProvider(fallbackProvider),
  };
};

export const normalizeRalphRuntimeSettings = (
  settings: RalphSettings,
  providers: readonly RuntimeProvider[] = RUNNABLE_PROVIDER_ORDER,
): RalphSettings => {
  const generation = normalizeRalphProviderModel(
    settings.generationProvider,
    settings.generationModel,
    providers,
  );
  const run = normalizeRalphProviderModel(
    settings.runProvider,
    settings.runModel,
    providers,
  );

  return {
    ...settings,
    generationProvider: generation.provider,
    generationModel: generation.model,
    ...(generation.provider === settings.generationProvider
      ? {}
      : { generationReasoning: undefined }),
    runProvider: run.provider,
    runModel: run.model,
    ...(run.provider === settings.runProvider ? {} : { runReasoning: undefined }),
  };
};

const hasRalphRuntimeSelectionChanged = (
  current: RalphSettings,
  next: RalphSettings,
): boolean => {
  return (
    current.generationProvider !== next.generationProvider ||
    current.generationModel !== next.generationModel ||
    current.generationReasoning !== next.generationReasoning ||
    current.runProvider !== next.runProvider ||
    current.runModel !== next.runModel ||
    current.runReasoning !== next.runReasoning
  );
};

export interface RalphAppProps {
  isActive: boolean;
  providerStatuses?: readonly RuntimeProviderAvailability[];
}

export const RalphApp = ({
  isActive,
  providerStatuses,
}: RalphAppProps): JSX.Element => {
  const [settings, setSettings] = useState<RalphSettings>(
    DEFAULT_RALPH_SETTINGS,
  );
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [providerAvailability, setProviderAvailability] = useState<
    RuntimeProviderAvailability[] | null
  >(null);
  const [catalog, setCatalog] = useState<ProviderModelCatalogSnapshot | null>(
    null,
  );
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>([]);
  const [shellStateLoaded, setShellStateLoaded] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const generationReasoning = settings.generationReasoning
    ? normalizeReasoningModeForProvider(
        settings.generationReasoning,
        settings.generationProvider,
        settings.generationModel,
      )
    : undefined;
  const runReasoning = settings.runReasoning
    ? normalizeReasoningModeForProvider(
        settings.runReasoning,
        settings.runProvider,
        settings.runModel,
      )
    : undefined;
  const generationReasoningOptions = getReasoningModesForProvider(
    settings.generationProvider,
    settings.generationModel,
  );
  const runReasoningOptions = getReasoningModesForProvider(
    settings.runProvider,
    settings.runModel,
  );
  const displayedRecentWorkspaces = useMemo(
    () => rememberRecentWorkspace(recentWorkspaces, settings.workspaceRoot),
    [recentWorkspaces, settings.workspaceRoot],
  );
  const effectiveProviderAvailability =
    providerStatuses && providerStatuses.length > 0
      ? providerStatuses
      : providerAvailability;
  const providerChoices = useMemo(
    () =>
      effectiveProviderAvailability
        ? getRalphProviderChoices(effectiveProviderAvailability, catalog)
        : getPendingRalphProviderChoices(settings),
    [catalog, effectiveProviderAvailability, settings],
  );

  useEffect(() => {
    let cancelled = false;

    void loadRalphSettings()
      .then((loadedSettings) => {
        if (!cancelled) {
          const normalizedSettings =
            normalizeRalphRuntimeSettings(loadedSettings);

          setSettings(normalizedSettings);
          if (
            normalizedSettings.generationProvider !==
              loadedSettings.generationProvider ||
            normalizedSettings.runProvider !== loadedSettings.runProvider
          ) {
            void saveRalphSettings(normalizedSettings);
          }
          setSettingsLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSettingsLoaded(true);
        }
      });

    void loadProviderModelCatalog()
      .then((loadedCatalog) => {
        if (!cancelled) {
          setCatalog(loadedCatalog);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCatalog(null);
        }
      });

    void loadGlobalProviderAvailability()
      .then((loadedProviderAvailability) => {
        if (!cancelled) {
          setProviderAvailability(loadedProviderAvailability);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("Failed to load Ralph provider availability", error);
          setProviderAvailability([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!settingsLoaded || effectiveProviderAvailability === null) {
      return;
    }

    const normalizedSettings = normalizeRalphRuntimeSettings(
      settings,
      providerChoices,
    );

    if (!hasRalphRuntimeSelectionChanged(settings, normalizedSettings)) {
      return;
    }

    setSettings(normalizedSettings);
    void saveRalphSettings(normalizedSettings);
  }, [effectiveProviderAvailability, providerChoices, settings, settingsLoaded]);

  useEffect(() => {
    if (
      isRalphRunnableProvider(settings.generationProvider) &&
      isRalphRunnableProvider(settings.runProvider)
    ) {
      return;
    }

    const normalizedSettings = normalizeRalphRuntimeSettings(settings);
    setSettings(normalizedSettings);
    void saveRalphSettings(normalizedSettings);
  }, [settings]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    const refreshRecentWorkspaces = async (): Promise<void> => {
      try {
        const shellState = await loadSharedShellState();

        if (!cancelled) {
          setRecentWorkspaces(shellState.recentWorkspaces);
          setShellStateLoaded(true);
        }
      } catch (error) {
        console.error("Failed to load Ralph workspace history", error);
        if (!cancelled) {
          setShellStateLoaded(true);
        }
      }
    };

    void refreshRecentWorkspaces();
    void subscribeToShellStateChanged(() => {
      void refreshRecentWorkspaces();
    }).then((dispose) => {
      if (cancelled) {
        dispose();
        return;
      }

      unsubscribe = dispose;
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const updateSettings = (patch: Partial<RalphSettings>): void => {
    setSettings((current) => {
      const next = {
        ...current,
        ...patch,
        version: 1,
      } satisfies RalphSettings;

      void saveRalphSettings(next);
      return next;
    });
  };

  const persistRecentWorkspace = async (workspace: string): Promise<void> => {
    const shellState = await loadSharedShellState();
    const nextShellState = {
      ...shellState,
      recentWorkspaces: rememberRecentWorkspace(
        shellState.recentWorkspaces,
        workspace,
      ),
    } satisfies ShellPersistedState;

    await saveShellState(nextShellState);
    await broadcastShellStateChanged();
  };

  const applyWorkspaceSelection = (workspace: string): void => {
    const normalizedWorkspace = workspace.trim();

    if (!normalizedWorkspace) {
      return;
    }

    updateSettings({ workspaceRoot: normalizedWorkspace });
    setRecentWorkspaces((current) =>
      rememberRecentWorkspace(current, normalizedWorkspace),
    );
    void persistRecentWorkspace(normalizedWorkspace).catch((error) => {
      console.error("Failed to save Ralph workspace history", error);
    });
  };

  const chooseWorkspace = async (): Promise<void> => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "Choose Ralph workspace",
    });

    if (typeof selected === "string" && selected.trim()) {
      applyWorkspaceSelection(selected);
    }
  };

  return (
    <section className="grid min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-slate-950">
      <header className="grid gap-2 border-b border-slate-800 bg-slate-950/95 px-5 py-2">
        <div className="grid gap-2 xl:grid-cols-[minmax(16rem,1fr)_minmax(24rem,1.25fr)_minmax(24rem,1.25fr)_auto]">
          <div className="grid min-w-0 gap-1">
            <span className="flex min-w-0 items-center gap-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-slate-500">
              <span className="truncate">Workspace</span>
              {!settingsLoaded || !shellStateLoaded ? (
                <LoaderCircle className="h-3 w-3 shrink-0 animate-spin text-sky-300" />
              ) : null}
            </span>
            <WorkspacePicker
              currentWorkspace={settings.workspaceRoot}
              workspaceLabel={
                settings.workspaceRoot
                  ? getWorkspaceLabel(settings.workspaceRoot)
                  : "Choose workspace"
              }
              recentWorkspaces={displayedRecentWorkspaces}
              hasActiveWorkspace={Boolean(settings.workspaceRoot)}
              buttonAriaLabel="Ralph workspace"
              onSelectWorkspace={applyWorkspaceSelection}
              onChooseNewWorkspace={chooseWorkspace}
              buttonClassName="h-9 w-full justify-start rounded-lg border-slate-700 bg-slate-950 px-3 text-sm font-medium text-slate-100 shadow-none hover:border-slate-600 hover:bg-slate-900"
            />
          </div>

          <RuntimeModelPicker
            label="Generate"
            provider={settings.generationProvider}
            model={settings.generationModel}
            catalog={catalog}
            providers={providerChoices}
            onChange={(provider, model) =>
              updateSettings({
                generationProvider: provider,
                generationModel: model,
                ...(settings.generationReasoning
                  ? {
                      generationReasoning: normalizeReasoningModeForProvider(
                        settings.generationReasoning,
                        provider,
                        model,
                      ),
                    }
                  : {}),
              })
            }
          />

          <RuntimeModelPicker
            label="Run"
            provider={settings.runProvider}
            model={settings.runModel}
            catalog={catalog}
            providers={providerChoices}
            onChange={(provider, model) =>
              updateSettings({
                runProvider: provider,
                runModel: model,
                ...(settings.runReasoning
                  ? {
                      runReasoning: normalizeReasoningModeForProvider(
                        settings.runReasoning,
                        provider,
                        model,
                      ),
                    }
                  : {}),
              })
            }
          />

          <Button
            type="button"
            variant="ghost"
            onClick={() => setShowAdvanced((current) => !current)}
            className="h-9 self-end rounded-lg px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-white"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            More
          </Button>
        </div>

        {showAdvanced ? (
          <div className="grid gap-2 border-t border-slate-800 pt-3 md:grid-cols-3 xl:grid-cols-5">
            <label className="grid gap-1 text-sm text-slate-200">
              <span className="font-medium">Generation profile</span>
              <Input
                value={settings.generationProfile ?? ""}
                aria-label="Ralph generation profile"
                placeholder="Default"
                onChange={(event) =>
                  updateSettings({
                    generationProfile: event.target.value.trim() || undefined,
                  })
                }
                className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
              />
            </label>
            <label className="grid gap-1 text-sm text-slate-200">
              <span className="font-medium">Generation reasoning</span>
              <select
                value={generationReasoning ?? "default"}
                aria-label="Ralph generation reasoning"
                onChange={(event) =>
                  updateSettings({
                    generationReasoning: event.target.value as ReasoningMode,
                  })
                }
                className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-slate-500"
              >
                {generationReasoningOptions.map((reasoning) => (
                  <option key={reasoning} value={reasoning}>
                    {REASONING_LABELS[reasoning]}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm text-slate-200">
              <span className="font-medium">Run profile</span>
              <Input
                value={settings.runProfile ?? ""}
                aria-label="Ralph run profile"
                placeholder="Default"
                onChange={(event) =>
                  updateSettings({
                    runProfile: event.target.value.trim() || undefined,
                  })
                }
                className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
              />
            </label>
            <label className="grid gap-1 text-sm text-slate-200">
              <span className="font-medium">Run reasoning</span>
              <select
                value={runReasoning ?? "default"}
                aria-label="Ralph run reasoning"
                onChange={(event) =>
                  updateSettings({
                    runReasoning: event.target.value as ReasoningMode,
                  })
                }
                className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-slate-500"
              >
                {runReasoningOptions.map((reasoning) => (
                  <option key={reasoning} value={reasoning}>
                    {REASONING_LABELS[reasoning]}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm text-slate-200">
              <span className="font-medium">Max transitions</span>
              <Input
                type="number"
                min={1}
                value={settings.defaultMaxTransitions ?? ""}
                aria-label="Ralph max transitions"
                placeholder="Unlimited"
                onChange={(event) =>
                  updateSettings({
                    defaultMaxTransitions: event.target.value
                      ? Number.parseInt(event.target.value, 10)
                      : undefined,
                  })
                }
                className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
              />
            </label>
          </div>
        ) : null}
      </header>

      <div className="relative min-h-0 min-w-0 overflow-hidden">
        <RalphFlowEditor
          workspaceRoot={settings.workspaceRoot}
          isActive={isActive}
          runMode="machdoch"
          generationProvider={settings.generationProvider}
          generationModel={settings.generationModel}
          generationProfile={settings.generationProfile}
          generationReasoning={generationReasoning}
          runProvider={settings.runProvider}
          runModel={settings.runModel}
          runProfile={settings.runProfile}
          runReasoning={runReasoning}
          defaultMaxTransitions={settings.defaultMaxTransitions}
          providerOptions={providerChoices}
        />
      </div>
    </section>
  );
};
