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
}

export interface RuntimeCatalogModel {
  id: string;
  label?: string;
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

const MAX_MODELS_PER_PROVIDER = Number.MAX_SAFE_INTEGER;
const MAX_CODEX_CLI_MODELS = Number.MAX_SAFE_INTEGER;
const MAX_LANGDOCK_MODELS = Number.MAX_SAFE_INTEGER;

const OPENAI_RUNTIME_MODEL_PATTERN =
  /^gpt-(\d+)(?:\.\d+)?(?:-(?:mini|nano))?(?:-preview)?$/u;

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

const LANGDOCK_EXCLUDED_MODEL_ID_PARTS = [
  "audio",
  "dall",
  "embed",
  "embedding",
  "imagen",
  "image",
  "moderation",
  "realtime",
  "rerank",
  "search",
  "sora",
  "transcribe",
  "tts",
  "veo",
  "whisper",
] as const;

const REVIEW_MODEL_PATTERNS: Record<RuntimeProvider, readonly RegExp[]> = {
  openai: [/(?:^|-)mini$/u, /(?:^|-)nano$/u],
  anthropic: [/haiku/u],
  google: [/flash-lite/u, /flash/u],
  langdock: [/(?:^|-)mini$/u, /(?:^|-)nano$/u, /flash-lite/u, /flash/u, /haiku/u],
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

const isModernOpenAiRuntimeModel = (modelId: string): boolean => {
  const normalized = normalizeModelId(modelId);
  const match = normalized.match(OPENAI_RUNTIME_MODEL_PATTERN);

  if (
    !match ||
    looksLikeDatedSnapshot(normalized) ||
    OPENAI_EXCLUDED_MODEL_ID_PARTS.some((part) => normalized.includes(part))
  ) {
    return false;
  }

  return Number.parseInt(match[1] ?? "0", 10) >= 5;
};

const isModernAnthropicRuntimeModel = (modelId: string): boolean => {
  const normalized = normalizeModelId(modelId);

  return (
    /^claude-(?:fable|sonnet)-5(?:-\d{8})?$/u.test(normalized) ||
    /^claude-(?:opus|sonnet|haiku)-4-\d+(?:-\d{8})?$/u.test(normalized) ||
    /^claude-(?:5|4-\d+)-(?:fable|opus|sonnet|haiku)(?:-\d{8})?$/u.test(
      normalized,
    )
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

  return (
    /^gemini-\d+(?:\.\d+)?-(?:pro|flash|flash-lite)(?:-(?:preview|latest)(?:-\d{2}-\d{4})?)?$/u.test(
      normalized,
    ) || /^gemini-(?:pro|flash|flash-lite)-latest$/u.test(normalized)
  );
};

const isModernLangdockRuntimeModel = (modelId: string): boolean => {
  const normalized = normalizeModelId(modelId);

  if (
    normalized.length === 0 ||
    looksLikeDatedSnapshot(normalized) ||
    LANGDOCK_EXCLUDED_MODEL_ID_PARTS.some((part) => normalized.includes(part))
  ) {
    return false;
  }

  return ![
    /^gpt-[34](?:[.-]|$)/u,
    /^claude-(?:[123]|(?:opus|sonnet|haiku)-[123])(?:-|$)/u,
    /^gemini-(?:1|2(?:\.0|\.1)?)(?:-|$)/u,
  ].some((pattern) => pattern.test(normalized));
};

const isNumericModelVersion = (version: string): boolean => {
  return version
    .split(".")
    .every(
      (part) =>
        part.length > 0 &&
        part.split("").every((character) => /\d/u.test(character)),
    );
};

const isModernCodexCliRuntimeModel = (modelId: string): boolean => {
  const normalized = normalizeModelId(modelId);

  if (
    normalized === "auto" ||
    normalized === "gpt-5.2" ||
    normalized === "gpt-5.3-codex" ||
    looksLikeDatedSnapshot(normalized)
  ) {
    return false;
  }

  const suffix = normalized.startsWith("gpt-")
    ? normalized.slice("gpt-".length)
    : null;

  if (!suffix) {
    return false;
  }

  const [version, ...suffixParts] = suffix.split("-");

  if (!version || !isNumericModelVersion(version)) {
    return false;
  }

  const majorVersion = Number.parseInt(version.split(".")[0] ?? "0", 10);

  if (majorVersion < 5) {
    return false;
  }

  if (suffixParts.length === 0) {
    return true;
  }

  if (suffixParts.length === 1) {
    return ["mini", "nano", "preview"].includes(suffixParts[0] ?? "");
  }

  if (
    suffixParts.length === 2 &&
    ["mini", "nano"].includes(suffixParts[0] ?? "") &&
    suffixParts[1] === "preview"
  ) {
    return true;
  }

  return suffixParts[0] === "codex";
};

const isModernRuntimeModel = (
  provider: RuntimeProvider,
  model: RuntimeCatalogModel,
): boolean => {
  if (model.stage?.trim().toLowerCase().includes("deprecated")) {
    return false;
  }

  switch (provider) {
    case "openai":
      return isModernOpenAiRuntimeModel(model.id);
    case "anthropic":
      return isModernAnthropicRuntimeModel(model.id);
    case "google":
      return isModernGoogleRuntimeModel(model.id);
    case "langdock":
      return isModernLangdockRuntimeModel(model.id);
    case "codex-cli":
      return isModernCodexCliRuntimeModel(model.id);
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
  };
};

const getModelLimitForProvider = (provider: RuntimeProvider): number => {
  if (provider === "codex-cli") {
    return MAX_CODEX_CLI_MODELS;
  }

  if (provider === "langdock") {
    return MAX_LANGDOCK_MODELS;
  }

  return MAX_MODELS_PER_PROVIDER;
};

const getStaticCatalogModelsForProvider = (
  provider: RuntimeProvider,
): CatalogModel[] => {
  return getProviderModelMetadata(provider)
    .map((model) => ({
      id: model.id,
      label: model.label,
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
