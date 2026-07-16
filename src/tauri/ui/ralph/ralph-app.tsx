import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Check,
  ChevronDown,
  LoaderCircle,
  Play,
  SlidersHorizontal,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { RalphFlowEditor } from "./ralph-flow-editor";
import {
  createInitialShellState,
  normalizeShellState,
  rememberRecentWorkspace,
  removeRecentWorkspace,
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
  subscribeToShellStateChanged,
  updateShellStateAtomically,
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
  icon: LucideIcon;
  label: string;
  provider: RuntimeProvider;
  model: string;
  catalog: ProviderModelCatalogSnapshot | null;
  providers: readonly RuntimeProvider[];
  onChange: (provider: RuntimeProvider, model: string) => void;
  dense?: boolean;
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
  icon: Icon,
  label,
  provider,
  model,
  catalog,
  providers,
  onChange,
  dense = false,
}: RuntimeModelPickerProps): JSX.Element => {
  const models = useMemo(
    () => getCatalogModelsForProvider(provider, catalog),
    [catalog, provider],
  );
  const modelLabel = getModelLabel(models, model);

  if (dense) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            aria-label={`${label} provider and model: ${getProviderLabel(provider)}, ${modelLabel}`}
            className="h-8 w-full min-w-0 justify-between overflow-hidden rounded-lg border-slate-700 bg-slate-950 px-3 text-xs font-medium text-slate-100 shadow-none hover:border-slate-600 hover:bg-slate-900"
          >
            <span className="flex min-w-0 items-center overflow-hidden whitespace-nowrap">
              <Icon
                aria-hidden="true"
                className="mr-1.5 h-3.5 w-3.5 shrink-0 text-slate-500"
              />
              <span className="min-w-0 truncate">
                {getProviderLabel(provider)}
                <span className="px-1.5 text-slate-600">/</span>
                {modelLabel}
              </span>
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={5}
          className="z-[90] w-72 rounded-md border border-slate-700 bg-slate-950 p-1 text-slate-100 shadow-xl shadow-black/30"
        >
          <div className="px-2 pb-1 pt-1.5 text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-slate-500">
            Provider
          </div>
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

          <div className="mt-1 border-t border-slate-800 px-2 pb-1 pt-2 text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-slate-500">
            Model
          </div>
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
    );
  }

  return (
    <div
      className={cn(
        "grid min-w-0 gap-2",
        dense
          ? "grid-cols-[minmax(6rem,0.65fr)_minmax(10rem,1.35fr)]"
          : "grid-cols-[7rem_minmax(0,1fr)]",
      )}
    >
      <label className="grid min-w-0 gap-1">
        <span className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-slate-500">
          {label}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className={cn(
                "min-w-0 justify-between rounded-lg border-slate-700 bg-slate-950 px-3 font-medium text-slate-100 shadow-none hover:border-slate-600 hover:bg-slate-900",
                dense ? "h-8 text-xs" : "h-9 text-sm",
              )}
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
              className={cn(
                "min-w-0 justify-between rounded-lg border-slate-700 bg-slate-950 px-3 font-medium text-slate-100 shadow-none hover:border-slate-600 hover:bg-slate-900",
                dense ? "h-8 text-xs" : "h-9 text-sm",
              )}
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
): { provider: RuntimeProvider; model: string } => {
  return {
    provider,
    model: model.trim() ? model : getDefaultModelForProvider(provider),
  };
};

export const normalizeRalphRuntimeSettings = (
  settings: RalphSettings,
): RalphSettings => {
  const generation = normalizeRalphProviderModel(
    settings.generationProvider,
    settings.generationModel,
  );
  const run = normalizeRalphProviderModel(
    settings.runProvider,
    settings.runModel,
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

export const mergeLoadedRalphSettings = (
  loaded: RalphSettings,
  current: RalphSettings,
  dirtyFields: ReadonlySet<keyof RalphSettings>,
): RalphSettings => {
  const merged = { ...loaded } as RalphSettings;
  const mutableMerged = merged as unknown as Record<string, unknown>;
  const currentRecord = current as unknown as Record<string, unknown>;

  for (const field of dirtyFields) {
    mutableMerged[field] = currentRecord[field];
  }

  return merged;
};

export interface RalphAppProps {
  isActive: boolean;
  providerStatuses?: readonly RuntimeProviderAvailability[];
  onOpenMediaRun?: (runId: string) => void;
}

export const RalphApp = ({
  isActive,
  providerStatuses,
  onOpenMediaRun,
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
  const [editorDirty, setEditorDirty] = useState(false);
  const settingsRef = useRef(settings);
  const settingsEditRevisionRef = useRef(0);
  const dirtySettingsFieldsRef = useRef(new Set<keyof RalphSettings>());
  const settingsSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const recentWorkspacesRequestRef = useRef(0);

  settingsRef.current = settings;

  const persistSettings = (next: RalphSettings): void => {
    settingsSaveChainRef.current = settingsSaveChainRef.current
      .catch(() => undefined)
      .then(() => saveRalphSettings(next))
      .catch((error: unknown) => {
        console.error("Failed to persist Ralph settings", error);
      });
  };

  const updateSettings = (patch: Partial<RalphSettings>): void => {
    const normalized = normalizeRalphRuntimeSettings({
      ...settingsRef.current,
      ...patch,
      version: 1,
    });

    settingsEditRevisionRef.current += 1;
    for (const field of Object.keys(patch) as Array<keyof RalphSettings>) {
      dirtySettingsFieldsRef.current.add(field);
    }
    settingsRef.current = normalized;
    setSettings(normalized);
    persistSettings(normalized);
  };
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
    const editRevisionAtStart = settingsEditRevisionRef.current;

    void loadRalphSettings()
      .then((loadedSettings) => {
        if (!cancelled) {
          const dirtyFields = dirtySettingsFieldsRef.current;
          const mergedSettings =
            settingsEditRevisionRef.current === editRevisionAtStart
              ? loadedSettings
              : mergeLoadedRalphSettings(
                  loadedSettings,
                  settingsRef.current,
                  dirtyFields,
                );
          const normalizedSettings = normalizeRalphRuntimeSettings(mergedSettings);

          settingsRef.current = normalizedSettings;
          setSettings(normalizedSettings);
          if (
            normalizedSettings.generationProvider !== loadedSettings.generationProvider ||
            normalizedSettings.generationModel !== loadedSettings.generationModel ||
            normalizedSettings.runProvider !== loadedSettings.runProvider ||
            normalizedSettings.runModel !== loadedSettings.runModel ||
            settingsEditRevisionRef.current !== editRevisionAtStart
          ) {
            persistSettings(normalizedSettings);
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
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    const refreshRecentWorkspaces = async (): Promise<void> => {
      const requestId = recentWorkspacesRequestRef.current + 1;
      recentWorkspacesRequestRef.current = requestId;
      try {
        const shellState = await loadSharedShellState();

        if (!cancelled && requestId === recentWorkspacesRequestRef.current) {
          setRecentWorkspaces(shellState.recentWorkspaces);
          setShellStateLoaded(true);
        }
      } catch (error) {
        console.error("Failed to load Ralph workspace history", error);
        if (!cancelled && requestId === recentWorkspacesRequestRef.current) {
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
      recentWorkspacesRequestRef.current += 1;
      unsubscribe?.();
    };
  }, []);

  const persistRecentWorkspace = async (workspace: string): Promise<void> => {
    await updateShellStateAtomically(createInitialShellState(), (current) => {
      const shellState = normalizeShellState(current);

      return {
        ...shellState,
        recentWorkspaces: rememberRecentWorkspace(
          shellState.recentWorkspaces,
          workspace,
        ),
      } satisfies ShellPersistedState;
    });
    await broadcastShellStateChanged();
  };

  const persistRecentWorkspaceRemoval = async (
    workspace: string,
  ): Promise<void> => {
    await updateShellStateAtomically(createInitialShellState(), (current) => {
      const shellState = normalizeShellState(current);

      return {
        ...shellState,
        recentWorkspaces: removeRecentWorkspace(
          shellState.recentWorkspaces,
          workspace,
        ),
      } satisfies ShellPersistedState;
    });
    await broadcastShellStateChanged();
  };

  const applyWorkspaceSelection = (workspace: string): void => {
    const normalizedWorkspace = workspace.trim();

    if (!normalizedWorkspace || normalizedWorkspace === settingsRef.current.workspaceRoot) {
      return;
    }

    if (
      editorDirty &&
      !window.confirm(
        "The selected Ralph flow has unsaved changes. Discard them and switch workspaces?",
      )
    ) {
      return;
    }

    updateSettings({ workspaceRoot: normalizedWorkspace });
    setEditorDirty(false);
    setRecentWorkspaces((current) =>
      rememberRecentWorkspace(current, normalizedWorkspace),
    );
    void persistRecentWorkspace(normalizedWorkspace).catch((error) => {
      console.error("Failed to save Ralph workspace history", error);
    });
  };

  const removeWorkspaceFromHistory = (workspace: string): void => {
    setRecentWorkspaces((current) => removeRecentWorkspace(current, workspace));
    void persistRecentWorkspaceRemoval(workspace).catch((error) => {
      console.error("Failed to remove Ralph workspace history entry", error);
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
      <header className="grid gap-2 border-b border-slate-800 bg-slate-950/95 px-3 py-2 shadow-[0_10px_30px_rgba(2,6,23,0.18)]">
        <div className="grid min-w-0 grid-cols-[minmax(13rem,1fr)_minmax(0,max-content)_minmax(0,max-content)_auto] items-end gap-2">
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
              recentWorkspaces={recentWorkspaces}
              hasActiveWorkspace={Boolean(settings.workspaceRoot)}
              workspaceLocked={false}
              allowNotSet={false}
              buttonAriaLabel="Ralph workspace"
              onSelectWorkspace={(workspace) => {
                if (workspace) {
                  applyWorkspaceSelection(workspace);
                }
              }}
              onRemoveWorkspace={removeWorkspaceFromHistory}
              onChooseNewWorkspace={chooseWorkspace}
              buttonClassName="h-8 w-full justify-start rounded-lg border-slate-700 bg-slate-950 px-3 text-xs font-medium text-slate-100 shadow-none hover:border-slate-600 hover:bg-slate-900"
            />
          </div>

          <RuntimeModelPicker
            dense
            icon={Sparkles}
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
            dense
            icon={Play}
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
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced((current) => !current)}
            className={cn(
              "h-8 shrink-0 rounded-lg px-3 text-xs hover:bg-slate-900 hover:text-white",
              showAdvanced ? "bg-slate-900 text-white" : "text-slate-300",
            )}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Settings
          </Button>
        </div>

        {showAdvanced ? (
          <div className="grid gap-2 border-t border-slate-800 pt-3 md:grid-cols-2 xl:grid-cols-3">
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
          key={settings.workspaceRoot ?? "no-workspace"}
          workspaceRoot={settings.workspaceRoot}
          isActive={isActive}
          onDirtyChange={setEditorDirty}
          flowLibraryMode={settings.flowLibraryMode}
          onFlowLibraryModeChange={(flowLibraryMode) =>
            updateSettings({ flowLibraryMode })
          }
          runMode="machdoch"
          generationProvider={settings.generationProvider}
          generationModel={settings.generationModel}
          generationReasoning={generationReasoning}
          runProvider={settings.runProvider}
          runModel={settings.runModel}
          runReasoning={runReasoning}
          defaultMaxTransitions={settings.defaultMaxTransitions}
          providerOptions={providerChoices}
          generationPromptHistory={settings.generationPromptHistory}
          onGenerationPromptHistoryChange={(generationPromptHistory) =>
            updateSettings({ generationPromptHistory })
          }
          onOpenMediaRun={onOpenMediaRun}
        />
      </div>
    </section>
  );
};
