import {
  getCatalogModelsForProvider,
  SUPPORTED_PROVIDER_ORDER,
  type CatalogModel,
  type ProviderModelCatalogSnapshot,
  type RuntimeProvider,
} from "./model-catalog";
import {
  loadGlobalProviderAvailability,
  loadProviderModelCatalog,
  loadUserInternalTaskModelSettings,
  runDesktopTask,
  runRalphGenerationInterview,
  runTaskInterview,
  saveUserInternalTaskModelSettings,
  type RalphGenerationInterviewInput,
  type RuntimeProviderAvailability,
  type TaskInterviewInput,
  type UserInternalTaskModelSettings,
} from "./runtime";

export interface InternalTaskModelSelection {
  provider: RuntimeProvider;
  model: string;
}

export interface InternalTaskProviderModels {
  provider: RuntimeProvider;
  models: CatalogModel[];
}

const INTERNAL_TASK_PROVIDERS = new Set<RuntimeProvider>([
  "openai",
  "anthropic",
  "google",
  "langdock",
]);

export type InternalDesktopTaskContext = Omit<
  Parameters<typeof runDesktopTask>[2],
  "provider" | "model"
>;

export type InternalTaskInterviewInput = Omit<
  TaskInterviewInput,
  "provider" | "model"
>;

export type InternalRalphGenerationInterviewInput = Omit<
  RalphGenerationInterviewInput,
  "provider" | "model"
>;

export const getInternalTaskProviderModels = (
  providerAvailability: readonly RuntimeProviderAvailability[],
  catalog: ProviderModelCatalogSnapshot,
): InternalTaskProviderModels[] => {
  const configuredProviders = new Set(
    providerAvailability
      .filter((entry) => entry.configured)
      .map((entry) => entry.provider),
  );

  return SUPPORTED_PROVIDER_ORDER.flatMap((provider) => {
    if (
      !INTERNAL_TASK_PROVIDERS.has(provider) ||
      !configuredProviders.has(provider)
    ) {
      return [];
    }

    const models = getCatalogModelsForProvider(provider, catalog);
    return models.length > 0 ? [{ provider, models }] : [];
  });
};

export const resolveInternalTaskModelSelection = (
  settings: UserInternalTaskModelSettings,
  providerAvailability: readonly RuntimeProviderAvailability[],
  catalog: ProviderModelCatalogSnapshot,
): InternalTaskModelSelection | null => {
  const providers = getInternalTaskProviderModels(
    providerAvailability,
    catalog,
  );
  const savedProvider = settings.provider
    ? providers.find((entry) => entry.provider === settings.provider)
    : undefined;
  const savedProviderConfigured = settings.provider
    ? providerAvailability.some(
        (entry) =>
          entry.provider === settings.provider && entry.configured,
      )
    : false;
  const savedProviderCatalog = settings.provider
    ? catalog.providers.find(
        (entry) => entry.provider === settings.provider,
      )
    : undefined;
  const savedModel = settings.model?.trim();

  if (savedProvider && savedModel) {
    const model = savedProvider.models.find(
      (entry) => entry.id === savedModel,
    );

    if (model) {
      return { provider: savedProvider.provider, model: model.id };
    }
  }

  if (
    settings.provider &&
    INTERNAL_TASK_PROVIDERS.has(settings.provider) &&
    savedProviderConfigured &&
    savedProviderCatalog?.available === false &&
    savedModel
  ) {
    return { provider: settings.provider, model: savedModel };
  }

  const provider = savedProvider ?? providers[0];
  const model = provider?.models[0];

  return provider && model
    ? { provider: provider.provider, model: model.id }
    : null;
};

export const loadInternalTaskModelSelection = async (): Promise<
  InternalTaskModelSelection | null
> => {
  const [settings, providerAvailability, catalog] = await Promise.all([
    loadUserInternalTaskModelSettings(),
    loadGlobalProviderAvailability(),
    loadProviderModelCatalog(),
  ]);

  const selection = resolveInternalTaskModelSelection(
    settings,
    providerAvailability,
    catalog,
  );

  if (
    selection &&
    (settings.provider !== selection.provider ||
      settings.model?.trim() !== selection.model)
  ) {
    await saveUserInternalTaskModelSettings(selection);
  }

  return selection;
};

const requireInternalTaskModelSelection = async (): Promise<
  InternalTaskModelSelection
> => {
  const selection = await loadInternalTaskModelSelection();

  if (!selection) {
    throw new Error(
      "Choose an internal task model in Settings > Providers before running this AI task.",
    );
  }

  return selection;
};

export const runInternalDesktopTask = async (
  workspaceRoot: string | null | undefined,
  task: string,
  context: InternalDesktopTaskContext = {},
) => {
  const selection = await requireInternalTaskModelSelection();

  return runDesktopTask(workspaceRoot, task, {
    ...context,
    ...selection,
  });
};

export const runInternalTaskInterview = async (
  workspaceRoot: string | null | undefined,
  input: InternalTaskInterviewInput,
) => {
  const selection = await requireInternalTaskModelSelection();

  return runTaskInterview(workspaceRoot, {
    ...input,
    ...selection,
  });
};

export const runInternalRalphGenerationInterview = async (
  workspaceRoot: string | null | undefined,
  input: InternalRalphGenerationInterviewInput,
) => {
  const selection = await requireInternalTaskModelSelection();

  return runRalphGenerationInterview(workspaceRoot, {
    ...input,
    ...selection,
  });
};
