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
  capabilities?: RuntimeModelCapabilities;
}

export interface RuntimeModelCapabilities {
  imageInput?: boolean | null;
  toolUse?: boolean | null;
  reasoning?: boolean | null;
  streaming?: boolean | null;
  contextWindowTokens?: number | null;
  longContextWindowTokens?: number | null;
  maxOutputTokens?: number | null;
  reasoningModes?: readonly string[] | null;
  defaultReasoningMode?: string | null;
  supportedImageMediaTypes?: readonly string[] | null;
  voice?: boolean | null;
  computerUse?: boolean | null;
}

export interface RuntimeCatalogModel {
  id: string;
  label?: string;
  stage?: string;
  releaseDate?: string;
  capabilities?: RuntimeModelCapabilities;
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
  "langdock",
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
  langdock: "Langdock",
  "codex-cli": "Codex CLI",
  "claude-cli": "Claude CLI",
  "copilot-cli": "Copilot CLI",
};

const REVIEW_MODEL_PATTERNS: Record<RuntimeProvider, readonly RegExp[]> = {
  openai: [/(?:^|-)mini$/u, /(?:^|-)nano$/u],
  anthropic: [/haiku/u],
  google: [/flash-lite/u, /flash/u],
  langdock: [
    /(?:^|-)mini$/u,
    /(?:^|-)nano$/u,
    /flash-lite/u,
    /flash/u,
    /haiku/u,
  ],
  "codex-cli": [/(?:^|-)mini$/u, /(?:^|-)nano$/u],
  "claude-cli": [/haiku/u, /sonnet/u],
  "copilot-cli": [/auto/u],
};

const normalizeModelId = (model: string): string => model.trim().toLowerCase();

const TITLE_CASE_MODEL_PARTS = new Set(["sol", "terra", "luna"]);

const formatModelLabel = (modelId: string): string => {
  return modelId
    .split("-")
    .filter(Boolean)
    .map((part) => {
      const normalizedPart = part.toLowerCase();

      if (TITLE_CASE_MODEL_PARTS.has(normalizedPart)) {
        return `${normalizedPart.charAt(0).toUpperCase()}${normalizedPart.slice(1)}`;
      }

      return part.length <= 3
        ? part.toUpperCase()
        : `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
};

const parseReleaseTime = (date: string | undefined): number | null => {
  if (!date) {
    return null;
  }

  const time = Date.parse(date);

  return Number.isFinite(time) ? time : null;
};

const parseVersionRank = (version: string): number | null => {
  const parts = version.split(".");

  if (
    parts.length === 0 ||
    parts.some(
      (part) =>
        part.length === 0 ||
        !part.split("").every((character) => /\d/u.test(character)),
    )
  ) {
    return null;
  }

  return parts.reduce(
    (rank, part, index) =>
      rank + Number.parseInt(part, 10) / Math.max(1, 100 ** index),
    0,
  );
};

const getModelVersionRank = (modelId: string): number | null => {
  const normalized = normalizeModelId(modelId);

  const openAiMatch = normalized.match(/^gpt-(\d+(?:\.\d+)?)/u);

  if (openAiMatch) {
    return parseVersionRank(openAiMatch[1] ?? "");
  }

  const googleMatch = normalized.match(/^gemini-(\d+(?:\.\d+)?)/u);

  if (googleMatch) {
    return parseVersionRank(googleMatch[1] ?? "");
  }

  const anthropicCanonicalMatch = normalized.match(
    /^claude-(?:fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/u,
  );

  if (anthropicCanonicalMatch) {
    return (
      Number.parseInt(anthropicCanonicalMatch[1] ?? "0", 10) +
      Number.parseInt(anthropicCanonicalMatch[2] ?? "0", 10) / 100
    );
  }

  const anthropicAlternateMatch = normalized.match(
    /^claude-(\d+)(?:-(\d+))?-(?:fable|opus|sonnet|haiku)/u,
  );

  if (anthropicAlternateMatch) {
    return (
      Number.parseInt(anthropicAlternateMatch[1] ?? "0", 10) +
      Number.parseInt(anthropicAlternateMatch[2] ?? "0", 10) / 100
    );
  }

  return null;
};

const getReleaseTime = (model: RuntimeCatalogModel): number | null =>
  parseReleaseTime(model.releaseDate);

const toCatalogModel = (model: RuntimeCatalogModel): CatalogModel => {
  const id = normalizeModelId(model.id);

  return {
    id,
    label: model.label?.trim() || formatModelLabel(id),
    ...(model.capabilities ? { capabilities: model.capabilities } : {}),
  };
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

    if (
      !id ||
      normalizedModel.stage?.trim().toLowerCase().includes("deprecated") ||
      byId.has(id)
    ) {
      continue;
    }

    byId.set(id, normalizedModel);
  }

  return [...byId.values()]
    .sort((left, right) => {
      if (left.id === "auto" || right.id === "auto") {
        if (left.id === right.id) {
          return 0;
        }

        return left.id === "auto" ? -1 : 1;
      }

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

      const leftVersionRank = getModelVersionRank(left.id);
      const rightVersionRank = getModelVersionRank(right.id);

      if (leftVersionRank !== null || rightVersionRank !== null) {
        if (leftVersionRank === null) {
          return 1;
        }

        if (rightVersionRank === null) {
          return -1;
        }

        if (leftVersionRank !== rightVersionRank) {
          return rightVersionRank - leftVersionRank;
        }
      }

      const leftRank = staticOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = staticOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER;

      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }

      return left.id.localeCompare(right.id);
    })
    .map(toCatalogModel);
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

  if (!runtimeCatalog?.available) {
    return [];
  }

  return getRuntimeCatalogModelsForProvider(provider, runtimeCatalog);
};

export const getCatalogModelForProvider = (
  provider: RuntimeProvider,
  modelId: string,
  snapshot?: ProviderModelCatalogSnapshot | null,
): CatalogModel | undefined => {
  const normalizedModelId = normalizeModelId(modelId);

  return getCatalogModelsForProvider(provider, snapshot).find(
    (model) => model.id === normalizedModelId,
  );
};

export const getModelLabelForProvider = (
  provider: RuntimeProvider,
  modelId: string,
  snapshot?: ProviderModelCatalogSnapshot | null,
): string => {
  const normalizedModelId = normalizeModelId(modelId);
  const liveModel = getCatalogModelForProvider(
    provider,
    normalizedModelId,
    snapshot,
  );
  const configuredModel = getProviderModelMetadata(provider).find(
    (model) => model.id === normalizedModelId,
  );

  return (
    liveModel?.label ??
    configuredModel?.label ??
    formatModelLabel(normalizedModelId)
  );
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

  return (
    reviewModel?.id ?? models[0]?.id ?? getDefaultModelForProvider(provider)
  );
};
