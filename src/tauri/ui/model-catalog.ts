import {
  getDefaultModelForProvider as getRegistryDefaultModelForProvider,
  getProviderModelMetadata,
  type ConfiguredModelProvider,
} from "../../core/provider-model-registry.js";

export type RuntimeProvider = ConfiguredModelProvider;

export type CatalogProviderId = RuntimeProvider;

export interface CatalogModel {
  id: string;
  label: string;
  description?: string;
}

export interface RuntimeCatalogModel {
  id: string;
  label?: string;
  description?: string;
  stage?: string;
  releaseDate?: string;
}

export interface RuntimeProviderModelCatalog {
  provider: RuntimeProvider;
  source?: string;
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
  "codex-cli",
  "claude-cli",
  "copilot-cli",
];

export const RUNNABLE_PROVIDER_ORDER: RuntimeProvider[] = [
  ...SUPPORTED_PROVIDER_ORDER,
];

export const PROVIDER_LABELS: Record<RuntimeProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  "codex-cli": "Codex CLI",
  "claude-cli": "Claude CLI",
  "copilot-cli": "Copilot CLI",
};

const MAX_MODELS_PER_PROVIDER = 8;
const MAX_CODEX_CLI_MODELS = 12;

const OPENAI_RUNTIME_MODEL_PATTERN =
  /^gpt-\d+(?:\.\d+)?(?:-(?:mini|nano))?$/u;

const OPENAI_EXCLUDED_MODEL_ID_PARTS = [
  "audio",
  "chatgpt",
  "codex",
  "computer-use",
  "dall",
  "embedding",
  "image",
  "moderation",
  "realtime",
  "search",
  "sora",
  "transcribe",
  "tts",
  "whisper",
] as const;

const GOOGLE_EXCLUDED_MODEL_ID_PARTS = [
  "aqa",
  "audio",
  "banana",
  "customtools",
  "embedding",
  "gemma",
  "imagen",
  "image",
  "learnlm",
  "live",
  "lyria",
  "tts",
  "veo",
] as const;

const REVIEW_MODEL_PATTERNS: Record<RuntimeProvider, readonly RegExp[]> = {
  openai: [/(?:^|-)mini$/u, /(?:^|-)nano$/u],
  anthropic: [/haiku/u],
  google: [/flash-lite/u, /flash/u],
  "codex-cli": [/(?:^|-)mini$/u, /(?:^|-)nano$/u],
  "claude-cli": [/haiku/u, /sonnet/u],
  "copilot-cli": [/auto/u],
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

const looksLikeDatedSnapshot = (modelId: string): boolean => {
  const dateTail = modelId.match(/(?:^|-)(\d{4})-(\d{2})-(\d{2})$/u);

  if (dateTail) {
    return true;
  }

  return /(?:^|-)\d{8}$/u.test(modelId);
};

const inferReleaseDateFromModelId = (modelId: string): string | undefined => {
  const hyphenatedDate = modelId.match(/(?:^|-)(\d{4})-(\d{2})-(\d{2})$/u);

  if (hyphenatedDate) {
    return `${hyphenatedDate[1]}-${hyphenatedDate[2]}-${hyphenatedDate[3]}`;
  }

  const compactDate = modelId.match(/(?:^|-)(\d{4})(\d{2})(\d{2})$/u);

  if (compactDate) {
    return `${compactDate[1]}-${compactDate[2]}-${compactDate[3]}`;
  }

  return undefined;
};

const parseReleaseTime = (date: string | undefined): number | null => {
  if (!date) {
    return null;
  }

  const time = Date.parse(date);

  return Number.isFinite(time) ? time : null;
};

const getReleaseTime = (model: RuntimeCatalogModel): number | null => {
  return (
    parseReleaseTime(model.releaseDate) ??
    parseReleaseTime(inferReleaseDateFromModelId(model.id))
  );
};

const isModernOpenAiRuntimeModel = (modelId: string): boolean => {
  const normalized = normalizeModelId(modelId);

  if (
    looksLikeDatedSnapshot(normalized) ||
    OPENAI_EXCLUDED_MODEL_ID_PARTS.some((part) => normalized.includes(part))
  ) {
    return false;
  }

  return OPENAI_RUNTIME_MODEL_PATTERN.test(normalized);
};

const isModernAnthropicRuntimeModel = (modelId: string): boolean => {
  const normalized = normalizeModelId(modelId);

  return (
    /^claude-(?:opus|sonnet|haiku)-4-\d+(?:-\d{8})?$/u.test(normalized) ||
    /^claude-4-\d+-(?:opus|sonnet|haiku)(?:-\d{8})?$/u.test(normalized)
  );
};

const isModernGoogleRuntimeModel = (modelId: string): boolean => {
  const normalized = normalizeModelId(modelId);

  if (
    !normalized.startsWith("gemini-") ||
    looksLikeDatedSnapshot(normalized) ||
    GOOGLE_EXCLUDED_MODEL_ID_PARTS.some((part) => normalized.includes(part))
  ) {
    return false;
  }

  return /^gemini-\d+(?:\.\d+)?-(?:pro|flash|flash-lite)(?:-preview)?$/u.test(
    normalized,
  );
};

const isModernRuntimeModel = (
  provider: RuntimeProvider,
  model: RuntimeCatalogModel,
): boolean => {
  if (model.stage === "deprecated") {
    return false;
  }

  switch (provider) {
    case "openai":
      return isModernOpenAiRuntimeModel(model.id);
    case "anthropic":
      return isModernAnthropicRuntimeModel(model.id);
    case "google":
      return isModernGoogleRuntimeModel(model.id);
    case "codex-cli":
    case "claude-cli":
    case "copilot-cli":
      return true;
  }
};

const toCatalogModel = (model: RuntimeCatalogModel): CatalogModel => {
  const id = normalizeModelId(model.id);

  return {
    id,
    label: model.label?.trim() || formatModelLabel(id),
    ...(model.description?.trim() ? { description: model.description.trim() } : {}),
  };
};

const getModelLimitForProvider = (provider: RuntimeProvider): number => {
  return provider === "codex-cli"
    ? MAX_CODEX_CLI_MODELS
    : MAX_MODELS_PER_PROVIDER;
};

const mergeCatalogModels = (
  models: readonly CatalogModel[],
  fallbackModels: readonly CatalogModel[],
  limit: number,
): CatalogModel[] => {
  const byId = new Map<string, CatalogModel>();

  for (const model of [...models, ...fallbackModels]) {
    if (!byId.has(model.id)) {
      byId.set(model.id, model);
    }
  }

  return [...byId.values()].slice(0, limit);
};

const getStaticCatalogModelsForProvider = (
  provider: RuntimeProvider,
): CatalogModel[] => {
  return getProviderModelMetadata(provider)
    .map((model) => ({
      id: model.id,
      label: model.label,
      description: model.description,
    }))
    .slice(0, getModelLimitForProvider(provider));
};

const getRuntimeCatalogModelsForProvider = (
  provider: RuntimeProvider,
  runtimeCatalog: RuntimeProviderModelCatalog,
): CatalogModel[] => {
  const staticOrder = new Map(
    getProviderModelMetadata(provider).map((model, index) => [model.id, index]),
  );
  const byId = new Map<string, RuntimeCatalogModel>();

  for (const model of runtimeCatalog.models) {
    const id = normalizeModelId(model.id);
    const normalizedModel = { ...model, id };

    if (!id || !isModernRuntimeModel(provider, normalizedModel) || byId.has(id)) {
      continue;
    }

    byId.set(id, normalizedModel);
  }

  return [...byId.values()]
    .sort((left, right) => {
      const leftReleaseTime = getReleaseTime(left);
      const rightReleaseTime = getReleaseTime(right);

      if (leftReleaseTime !== null || rightReleaseTime !== null) {
        if (leftReleaseTime === null) {
          return 1;
        }

        if (rightReleaseTime === null) {
          return -1;
        }

        if (leftReleaseTime !== rightReleaseTime) {
          return rightReleaseTime - leftReleaseTime;
        }
      }

      const leftRank = staticOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = staticOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER;

      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }

      return left.id.localeCompare(right.id);
    })
    .map(toCatalogModel)
    .slice(0, getModelLimitForProvider(provider));
};

export const getProviderLabel = (provider: RuntimeProvider): string => {
  return PROVIDER_LABELS[provider];
};

export const getCatalogModelsForProvider = (
  provider: RuntimeProvider,
  snapshot?: ProviderModelCatalogSnapshot | null,
): CatalogModel[] => {
  const runtimeCatalog = snapshot?.providers.find(
    (entry) => entry.provider === provider,
  );
  const staticModels = getStaticCatalogModelsForProvider(provider);

  if (runtimeCatalog?.available && runtimeCatalog.models.length > 0) {
    const liveModels = getRuntimeCatalogModelsForProvider(
      provider,
      runtimeCatalog,
    );

    if (liveModels.length > 0) {
      if (provider === "codex-cli") {
        return mergeCatalogModels(
          liveModels,
          staticModels,
          getModelLimitForProvider(provider),
        );
      }

      return liveModels;
    }
  }

  return staticModels;
};

export const getDefaultModelForProvider = (
  provider: RuntimeProvider,
): string => {
  return getRegistryDefaultModelForProvider(provider);
};

export const getDefaultReviewModelForProvider = (
  provider: RuntimeProvider,
  snapshot?: ProviderModelCatalogSnapshot | null,
): string => {
  const models = getCatalogModelsForProvider(provider, snapshot);
  const reviewModel = models.find((model) =>
    REVIEW_MODEL_PATTERNS[provider].some((pattern) => pattern.test(model.id)),
  );

  return reviewModel?.id ?? models[0]?.id ?? getDefaultModelForProvider(provider);
};
