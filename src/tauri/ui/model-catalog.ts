import {
  getDefaultModelForProvider as getRegistryDefaultModelForProvider,
  getProviderCatalogMetadata,
  getProviderModelMetadata,
  PROVIDER_MODEL_MODES,
  type ConfiguredModelProvider,
  type ProviderModelCapabilityMetadata,
  type ProviderModelLifecycle,
  type ProviderModelMetadataSource,
  type ProviderModelMode,
  type ProviderModelUseCase,
  type ProviderModelVoiceCapability,
} from "../../core/provider-model-registry.js";

export type RuntimeProvider = ConfiguredModelProvider;

export type CatalogProviderId = RuntimeProvider | "xai" | "mistral";

export type CatalogModelStage = ProviderModelLifecycle;

export type CatalogModelUseCase = ProviderModelUseCase;

export interface CatalogModelCapabilities {
  imageInput: boolean;
  toolUse: boolean;
  reasoning: boolean;
  streaming: boolean;
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  voice: readonly ProviderModelVoiceCapability[];
  providerModes: readonly ProviderModelMode[];
  computerUse: boolean;
}

export interface CatalogModel {
  id: string;
  label: string;
  stage: CatalogModelStage;
  description: string;
  bestFor: string;
  recommendedFor: readonly CatalogModelUseCase[];
  source: ProviderModelMetadataSource;
  warnings: readonly string[];
  capabilities?: CatalogModelCapabilities;
  capabilityHighlights: readonly string[];
}

export interface CatalogProvider {
  id: CatalogProviderId;
  label: string;
  docsUrl: string;
  supportedInApp: boolean;
  note: string;
  models: CatalogModel[];
  warning?: string;
}

export interface RuntimeCatalogModelCapabilities {
  imageInput?: boolean;
  toolUse?: boolean;
  reasoning?: boolean;
  streaming?: boolean;
  contextWindowTokens?: number | null;
  maxOutputTokens?: number | null;
  voice?: boolean;
  computerUse?: boolean;
}

export interface RuntimeCatalogModel {
  id: string;
  label?: string;
  stage?: CatalogModelStage;
  description?: string;
  bestFor?: string;
  recommendedFor?: readonly CatalogModelUseCase[];
  capabilities?: RuntimeCatalogModelCapabilities;
  warnings?: readonly string[];
  source?: ProviderModelMetadataSource;
}

export interface RuntimeProviderModelCatalog {
  provider: RuntimeProvider;
  source: ProviderModelMetadataSource;
  available: boolean;
  error?: string;
  models: readonly RuntimeCatalogModel[];
}

export interface ProviderModelCatalogSnapshot {
  generatedAt: number;
  providers: readonly RuntimeProviderModelCatalog[];
}

export const SUPPORTED_PROVIDER_ORDER: RuntimeProvider[] = [
  "openai",
  "anthropic",
  "google",
];

export const PROVIDER_LABELS: Record<CatalogProviderId, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  xai: "xAI",
  mistral: "Mistral",
};

const USE_CASE_LABELS: Record<CatalogModelUseCase, string> = {
  coding: "Coding",
  fast: "Fast",
  cheap: "Cheap",
  vision: "Vision",
  voice: "Voice",
  "computer-use": "Computer use",
};

const formatTokenWindow = (tokens: number): string => {
  if (tokens >= 1_000_000) {
    return `${tokens / 1_000_000}M ctx`;
  }

  if (tokens >= 1_000) {
    return `${tokens / 1_000}K ctx`;
  }

  return `${tokens} ctx`;
};

const normalizeModelId = (model: string): string => model.trim().toLowerCase();

const formatModelLabel = (modelId: string): string => {
  return modelId
    .split("-")
    .filter(Boolean)
    .map((part) =>
      part.length <= 3
        ? part.toUpperCase()
        : `${part.charAt(0).toUpperCase()}${part.slice(1)}`,
    )
    .join(" ");
};

const isRuntimeProvider = (
  provider: CatalogProviderId,
): provider is RuntimeProvider => {
  return provider === "openai" || provider === "anthropic" || provider === "google";
};

const toCatalogCapabilities = (
  capabilities: ProviderModelCapabilityMetadata,
): CatalogModelCapabilities => ({
  imageInput: capabilities.imageInput,
  toolUse: capabilities.toolUse,
  reasoning: capabilities.reasoning,
  streaming: capabilities.streaming,
  contextWindowTokens: capabilities.contextWindowTokens,
  maxOutputTokens: capabilities.maxOutputTokens,
  voice: capabilities.voice,
  providerModes: capabilities.providerModes,
  computerUse: capabilities.computerUse,
});

const createConservativeCapabilities = (
  provider: RuntimeProvider,
  runtimeCapabilities?: RuntimeCatalogModelCapabilities,
): CatalogModelCapabilities => ({
  imageInput: runtimeCapabilities?.imageInput ?? false,
  toolUse: runtimeCapabilities?.toolUse ?? false,
  reasoning: runtimeCapabilities?.reasoning ?? false,
  streaming: runtimeCapabilities?.streaming ?? false,
  contextWindowTokens: runtimeCapabilities?.contextWindowTokens ?? null,
  maxOutputTokens: runtimeCapabilities?.maxOutputTokens ?? null,
  voice: runtimeCapabilities?.voice ? ["realtime-voice"] : [],
  providerModes: PROVIDER_MODEL_MODES[provider],
  computerUse: runtimeCapabilities?.computerUse ?? false,
});

const mergeRuntimeCapabilities = (
  provider: RuntimeProvider,
  fallback: CatalogModelCapabilities | undefined,
  runtimeCapabilities: RuntimeCatalogModelCapabilities | undefined,
): CatalogModelCapabilities | undefined => {
  if (!fallback && !runtimeCapabilities) {
    return undefined;
  }

  const base = fallback ?? createConservativeCapabilities(provider);

  return {
    ...base,
    imageInput: runtimeCapabilities?.imageInput ?? base.imageInput,
    toolUse: runtimeCapabilities?.toolUse ?? base.toolUse,
    reasoning: runtimeCapabilities?.reasoning ?? base.reasoning,
    streaming: runtimeCapabilities?.streaming ?? base.streaming,
    contextWindowTokens:
      runtimeCapabilities?.contextWindowTokens ?? base.contextWindowTokens,
    maxOutputTokens:
      runtimeCapabilities?.maxOutputTokens ?? base.maxOutputTokens,
    voice: runtimeCapabilities?.voice ? ["realtime-voice"] : base.voice,
    computerUse: runtimeCapabilities?.computerUse ?? base.computerUse,
  };
};

const createCapabilityHighlights = (
  model: Pick<CatalogModel, "capabilities" | "recommendedFor">,
): string[] => {
  const capabilities = model.capabilities;
  const recommendedLabels = model.recommendedFor.map(
    (useCase) => USE_CASE_LABELS[useCase],
  );

  if (!capabilities) {
    return recommendedLabels;
  }

  return [
    ...recommendedLabels,
    capabilities.reasoning ? "Reasoning" : null,
    capabilities.imageInput ? "Vision" : null,
    capabilities.toolUse ? "Tools" : null,
    capabilities.streaming ? "Streaming" : null,
    capabilities.contextWindowTokens
      ? formatTokenWindow(capabilities.contextWindowTokens)
      : null,
    capabilities.voice.length > 0 ? "Voice" : null,
    capabilities.computerUse ? "Computer use" : null,
  ]
    .flatMap((label) => (label ? [label] : []))
    .filter((label, index, labels) => labels.indexOf(label) === index);
};

const createCatalogModelFromMetadata = (
  metadata: ReturnType<typeof getProviderModelMetadata>[number],
): CatalogModel => {
  const capabilities = toCatalogCapabilities(metadata.capabilities);
  const model: Omit<CatalogModel, "capabilityHighlights"> = {
    id: metadata.id,
    label: metadata.label,
    stage: metadata.lifecycle,
    description: metadata.description,
    bestFor: metadata.bestFor,
    recommendedFor: metadata.recommendedFor,
    source: metadata.source,
    warnings: metadata.warnings,
    capabilities,
  };

  return {
    ...model,
    capabilityHighlights: createCapabilityHighlights(model),
  };
};

const deriveRuntimeRecommendedUseCases = (
  capabilities: CatalogModelCapabilities | undefined,
): CatalogModelUseCase[] => {
  if (!capabilities) {
    return [];
  }

  return [
    capabilities.reasoning || capabilities.toolUse ? "coding" : null,
    capabilities.imageInput ? "vision" : null,
    capabilities.voice.length > 0 ? "voice" : null,
    capabilities.computerUse ? "computer-use" : null,
  ].flatMap((useCase) => (useCase ? [useCase] : []));
};

const createCatalogModelFromRuntime = (
  provider: RuntimeProvider,
  runtimeModel: RuntimeCatalogModel,
  fallback?: CatalogModel,
): CatalogModel => {
  const id = normalizeModelId(runtimeModel.id);
  const capabilities = mergeRuntimeCapabilities(
    provider,
    fallback?.capabilities,
    runtimeModel.capabilities,
  );
  const recommendedFor =
    runtimeModel.recommendedFor ??
    fallback?.recommendedFor ??
    deriveRuntimeRecommendedUseCases(capabilities);
  const warningSet = new Set<string>([
    ...(fallback?.warnings ?? []),
    ...(runtimeModel.warnings ?? []),
  ]);

  if (!fallback) {
    warningSet.add(
      "Provider returned this model at runtime, but no curated capability profile is registered yet. Unsupported features stay disabled until metadata is added.",
    );
  }

  const model: Omit<CatalogModel, "capabilityHighlights"> = {
    id,
    label: runtimeModel.label ?? fallback?.label ?? formatModelLabel(id),
    stage: runtimeModel.stage ?? fallback?.stage ?? "stable",
    description:
      runtimeModel.description ??
      fallback?.description ??
      "Available through the provider model API.",
    bestFor:
      runtimeModel.bestFor ??
      fallback?.bestFor ??
      "Use after checking provider docs and a connection test.",
    recommendedFor,
    source: runtimeModel.source ?? "provider-api",
    warnings: [...warningSet],
    ...(capabilities ? { capabilities } : {}),
  };

  return {
    ...model,
    capabilityHighlights: createCapabilityHighlights(model),
  };
};

const orderCatalogModels = (
  provider: RuntimeProvider,
  models: CatalogModel[],
): CatalogModel[] => {
  const fallbackOrder = new Map(
    getProviderModelMetadata(provider).map((model, index) => [model.id, index]),
  );

  return [...models].sort((left, right) => {
    const leftLifecycleRank = left.stage === "deprecated" ? 3 : left.stage === "preview" ? 2 : 1;
    const rightLifecycleRank =
      right.stage === "deprecated" ? 3 : right.stage === "preview" ? 2 : 1;

    if (leftLifecycleRank !== rightLifecycleRank) {
      return leftLifecycleRank - rightLifecycleRank;
    }

    const leftRank = fallbackOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = fallbackOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER;

    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    return left.label.localeCompare(right.label);
  });
};

const getStaticCatalogModelsForProvider = (
  provider: RuntimeProvider,
): CatalogModel[] => {
  return getProviderModelMetadata(provider).map(createCatalogModelFromMetadata);
};

const mergeRuntimeProviderModels = (
  provider: RuntimeProvider,
  runtimeCatalog: RuntimeProviderModelCatalog | undefined,
): CatalogModel[] => {
  const staticModels = getStaticCatalogModelsForProvider(provider);

  if (!runtimeCatalog?.available || runtimeCatalog.models.length === 0) {
    return staticModels;
  }

  const staticById = new Map(staticModels.map((model) => [model.id, model]));
  const liveModels = runtimeCatalog.models.map((runtimeModel) =>
    createCatalogModelFromRuntime(
      provider,
      runtimeModel,
      staticById.get(normalizeModelId(runtimeModel.id)),
    ),
  );
  const liveModelIds = new Set(liveModels.map((model) => model.id));
  const missingStaticModels = staticModels
    .filter((model) => !liveModelIds.has(model.id))
    .map((model) => ({
      ...model,
      warnings: [
        ...model.warnings,
        "Not returned by the provider model list for this key. It may be unavailable for this account, project, or region.",
      ],
    }));

  return orderCatalogModels(provider, [...liveModels, ...missingStaticModels]);
};

const createRuntimeProviderCatalog = (
  provider: RuntimeProvider,
  snapshot?: ProviderModelCatalogSnapshot | null,
): CatalogProvider => {
  const metadata = getProviderCatalogMetadata(provider);
  const runtimeCatalog = snapshot?.providers.find(
    (entry) => entry.provider === provider,
  );
  const warning =
    runtimeCatalog && !runtimeCatalog.available ? runtimeCatalog.error : undefined;

  return {
    id: provider,
    label: PROVIDER_LABELS[provider],
    docsUrl: metadata?.docsUrl ?? "",
    supportedInApp: true,
    note: metadata?.note ?? "",
    models: mergeRuntimeProviderModels(provider, runtimeCatalog),
    ...(warning ? { warning } : {}),
  };
};

const createUnsupportedCatalogModel = (
  model: Omit<CatalogModel, "capabilityHighlights" | "source" | "warnings">,
): CatalogModel => ({
  ...model,
  source: "curated-fallback",
  warnings: ["This provider is cataloged for comparison but is not supported in the app runtime yet."],
  capabilityHighlights: createCapabilityHighlights(model),
});

const UNSUPPORTED_PROVIDER_CATALOG: CatalogProvider[] = [
  {
    id: "xai",
    label: "xAI",
    docsUrl: "https://docs.x.ai/developers/models",
    supportedInApp: false,
    note:
      "xAI models are listed for comparison only; app runtime adapters are not implemented yet.",
    models: [
      createUnsupportedCatalogModel({
        id: "grok-4.20",
        label: "Grok 4.20",
        stage: "stable",
        description:
          "xAI flagship model with reasoning, structured outputs, and tool support.",
        bestFor: "Agentic search, tool orchestration, and large-context analysis.",
        recommendedFor: ["coding", "fast", "vision"],
        capabilities: {
          imageInput: true,
          toolUse: true,
          reasoning: true,
          streaming: true,
          contextWindowTokens: 256_000,
          maxOutputTokens: 32_768,
          voice: [],
          providerModes: [],
          computerUse: false,
        },
      }),
    ],
  },
  {
    id: "mistral",
    label: "Mistral",
    docsUrl: "https://docs.mistral.ai/getting-started/models/",
    supportedInApp: false,
    note:
      "Mistral models are listed for comparison only; app runtime adapters are not implemented yet.",
    models: [
      createUnsupportedCatalogModel({
        id: "mistral-large-3",
        label: "Mistral Large 3",
        stage: "open",
        description: "Open-weight general-purpose multimodal model.",
        bestFor: "High-quality general reasoning with deployment flexibility.",
        recommendedFor: ["coding", "vision"],
        capabilities: {
          imageInput: true,
          toolUse: true,
          reasoning: true,
          streaming: true,
          contextWindowTokens: 256_000,
          maxOutputTokens: 32_768,
          voice: [],
          providerModes: [],
          computerUse: false,
        },
      }),
      createUnsupportedCatalogModel({
        id: "devstral-2",
        label: "Devstral 2",
        stage: "open",
        description: "Code agent model for software engineering tasks.",
        bestFor: "Code agents and task-oriented engineering flows.",
        recommendedFor: ["coding", "fast"],
        capabilities: {
          imageInput: false,
          toolUse: true,
          reasoning: true,
          streaming: true,
          contextWindowTokens: 256_000,
          maxOutputTokens: 32_768,
          voice: [],
          providerModes: [],
          computerUse: false,
        },
      }),
    ],
  },
];

export const createFrontierProviderCatalog = (
  snapshot?: ProviderModelCatalogSnapshot | null,
): CatalogProvider[] => [
  ...SUPPORTED_PROVIDER_ORDER.map((provider) =>
    createRuntimeProviderCatalog(provider, snapshot),
  ),
  ...UNSUPPORTED_PROVIDER_CATALOG,
];

export const FRONTIER_PROVIDER_CATALOG: CatalogProvider[] =
  createFrontierProviderCatalog();

export const getProviderLabel = (provider: CatalogProviderId): string => {
  return PROVIDER_LABELS[provider];
};

export const getCatalogModelsForProvider = (
  provider: RuntimeProvider,
  snapshot?: ProviderModelCatalogSnapshot | null,
): CatalogModel[] => {
  return createRuntimeProviderCatalog(provider, snapshot).models;
};

export const getDefaultModelForProvider = (
  provider: RuntimeProvider,
): string => {
  return getRegistryDefaultModelForProvider(provider);
};

export const getUseCaseLabel = (useCase: CatalogModelUseCase): string => {
  return USE_CASE_LABELS[useCase];
};

export const findCatalogProvider = (
  provider: CatalogProviderId,
  snapshot?: ProviderModelCatalogSnapshot | null,
): CatalogProvider | undefined => {
  if (isRuntimeProvider(provider)) {
    return createRuntimeProviderCatalog(provider, snapshot);
  }

  return UNSUPPORTED_PROVIDER_CATALOG.find((entry) => entry.id === provider);
};
