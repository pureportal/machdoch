import {
  ANTHROPIC_IMAGE_MEDIA_TYPES,
  findProviderModelMetadata,
  GOOGLE_IMAGE_MEDIA_TYPES,
  OPENAI_IMAGE_MEDIA_TYPES,
  PROVIDER_MODEL_MODES,
  type ConfiguredModelProvider,
  type ProviderModelMode,
  type ProviderModelVoiceCapability,
} from "./provider-model-registry.js";
import type { AgentModelImageMediaType } from "./types.js";
import type { ModelProvider } from "./runtime-contract.generated.js";

export type ModelProviderMode = ProviderModelMode;

export type ModelVoiceCapability = ProviderModelVoiceCapability;

export interface ModelCapabilityProfile {
  provider: ConfiguredModelProvider;
  model: string;
  imageInput: boolean;
  toolUse: boolean;
  reasoning: boolean;
  streaming: boolean;
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  supportedImageMediaTypes: readonly AgentModelImageMediaType[];
  voice: readonly ModelVoiceCapability[];
  providerModes: readonly ModelProviderMode[];
}

export interface ProviderCapabilityProfile {
  provider: ConfiguredModelProvider;
  imageInputMediaTypes: readonly AgentModelImageMediaType[];
  providerModes: readonly ModelProviderMode[];
}

export interface DiscoveredModelCapabilities {
  imageInput?: boolean | null;
  toolUse?: boolean | null;
  reasoning?: boolean | null;
  streaming?: boolean | null;
  contextWindowTokens?: number | null;
  longContextWindowTokens?: number | null;
  maxOutputTokens?: number | null;
  reasoningModes?: readonly string[] | null;
  supportedImageMediaTypes?: readonly string[] | null;
  voice?: boolean | null;
}

const discoveredCapabilitiesByProviderModel = new Map<
  string,
  DiscoveredModelCapabilities
>();

const discoveredCapabilityKey = (
  provider: ConfiguredModelProvider,
  model: string,
): string => `${provider}:${model.trim().toLowerCase()}`;

export const replaceDiscoveredModelCapabilities = (
  provider: ConfiguredModelProvider,
  models: readonly {
    id: string;
    capabilities?: DiscoveredModelCapabilities;
  }[],
): void => {
  const prefix = `${provider}:`;

  for (const key of discoveredCapabilitiesByProviderModel.keys()) {
    if (key.startsWith(prefix)) {
      discoveredCapabilitiesByProviderModel.delete(key);
    }
  }

  for (const model of models) {
    if (model.capabilities) {
      discoveredCapabilitiesByProviderModel.set(
        discoveredCapabilityKey(provider, model.id),
        model.capabilities,
      );
    }
  }
};

const getDiscoveredModelCapabilities = (
  provider: ModelProvider,
  model: string,
): DiscoveredModelCapabilities | undefined =>
  provider === "unconfigured"
    ? undefined
    : discoveredCapabilitiesByProviderModel.get(
        discoveredCapabilityKey(provider, model),
      );

export const getDiscoveredReasoningModes = (
  provider: ConfiguredModelProvider,
  model: string,
): readonly string[] | null | undefined =>
  getDiscoveredModelCapabilities(provider, model)?.reasoningModes;

export const getDiscoveredLongContextWindowTokens = (
  provider: ConfiguredModelProvider,
  model: string,
): number | null | undefined =>
  getDiscoveredModelCapabilities(provider, model)?.longContextWindowTokens;

const IMAGE_EXTENSION_MEDIA_TYPES: Record<string, AgentModelImageMediaType> = {
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const IMAGE_MEDIA_TYPES = new Set<AgentModelImageMediaType>(
  Object.values(IMAGE_EXTENSION_MEDIA_TYPES),
);

const WITHOUT_IMAGE_MEDIA_TYPES =
  [] as const satisfies readonly AgentModelImageMediaType[];

const DOCUMENTED_OPENAI_MODEL_PATTERN =
  /^gpt-(?:5\.6(?:-(?:sol|terra|luna))?|5\.5(?:-pro)?|5\.4(?:-(?:pro|mini|nano))?|5\.2(?:-pro)?|5\.1|5(?:-(?:pro|mini|nano))?)(?:-\d{4}-\d{2}-\d{2})?$/u;

const PROVIDER_CAPABILITY_PROFILES: Record<
  ConfiguredModelProvider,
  ProviderCapabilityProfile
> = {
  anthropic: {
    provider: "anthropic",
    imageInputMediaTypes: ANTHROPIC_IMAGE_MEDIA_TYPES,
    providerModes: PROVIDER_MODEL_MODES.anthropic,
  },
  "claude-cli": {
    provider: "claude-cli",
    imageInputMediaTypes: WITHOUT_IMAGE_MEDIA_TYPES,
    providerModes: PROVIDER_MODEL_MODES["claude-cli"],
  },
  "codex-cli": {
    provider: "codex-cli",
    imageInputMediaTypes: OPENAI_IMAGE_MEDIA_TYPES,
    providerModes: PROVIDER_MODEL_MODES["codex-cli"],
  },
  "copilot-cli": {
    provider: "copilot-cli",
    imageInputMediaTypes: WITHOUT_IMAGE_MEDIA_TYPES,
    providerModes: PROVIDER_MODEL_MODES["copilot-cli"],
  },
  google: {
    provider: "google",
    imageInputMediaTypes: GOOGLE_IMAGE_MEDIA_TYPES,
    providerModes: PROVIDER_MODEL_MODES.google,
  },
  langdock: {
    provider: "langdock",
    imageInputMediaTypes: [
      ...OPENAI_IMAGE_MEDIA_TYPES,
      ...GOOGLE_IMAGE_MEDIA_TYPES,
    ],
    providerModes: PROVIDER_MODEL_MODES.langdock,
  },
  openai: {
    provider: "openai",
    imageInputMediaTypes: OPENAI_IMAGE_MEDIA_TYPES,
    providerModes: PROVIDER_MODEL_MODES.openai,
  },
};

const getExtension = (path: string): string | undefined => {
  const fileName = path.trim().replace(/\\/gu, "/").split("/").at(-1) ?? "";
  const lastDotIndex = fileName.lastIndexOf(".");

  if (lastDotIndex < 0 || lastDotIndex === fileName.length - 1) {
    return undefined;
  }

  return fileName.slice(lastDotIndex + 1).toLowerCase();
};

const normalizeModel = (model: string): string => {
  return model.trim().toLowerCase();
};

const getDocumentedOpenAiModelProfile = (
  model: string,
): ModelCapabilityProfile | undefined => {
  if (!DOCUMENTED_OPENAI_MODEL_PATTERN.test(model)) {
    return undefined;
  }

  const hasLargeContext =
    /^gpt-5\.[56](?:-|$)/u.test(model) ||
    /^gpt-5\.4(?:-pro)?(?:-|$)/u.test(model);
  const isOriginalGpt5Pro = /^gpt-5-pro(?:-|$)/u.test(model);

  return {
    provider: "openai",
    model,
    imageInput: true,
    toolUse: true,
    reasoning: true,
    streaming: true,
    contextWindowTokens: hasLargeContext ? 1_050_000 : 400_000,
    maxOutputTokens: isOriginalGpt5Pro ? 272_000 : 128_000,
    supportedImageMediaTypes: OPENAI_IMAGE_MEDIA_TYPES,
    voice: [],
    providerModes: PROVIDER_MODEL_MODES.openai,
  };
};

const getDocumentedLangdockOpenAiModelProfile = (
  model: string,
): ModelCapabilityProfile | undefined => {
  const openAiProfile = getDocumentedOpenAiModelProfile(model);

  return openAiProfile
    ? {
        ...openAiProfile,
        provider: "langdock",
        providerModes: PROVIDER_MODEL_MODES.langdock,
      }
    : undefined;
};

export const getProviderCapabilityProfile = (
  provider: ModelProvider,
): ProviderCapabilityProfile | undefined => {
  return provider !== "unconfigured"
    ? PROVIDER_CAPABILITY_PROFILES[provider]
    : undefined;
};

export const getModelCapabilityProfile = (
  provider: ModelProvider,
  model: string,
): ModelCapabilityProfile | undefined => {
  if (provider === "unconfigured") {
    return undefined;
  }

  const normalizedModel = normalizeModel(model);
  const metadata = findProviderModelMetadata(provider, normalizedModel);

  if (!metadata) {
    if (provider === "openai") {
      return getDocumentedOpenAiModelProfile(normalizedModel);
    }

    return provider === "langdock"
      ? getDocumentedLangdockOpenAiModelProfile(normalizedModel)
      : undefined;
  }

  return {
    provider,
    model: normalizedModel,
    imageInput: metadata.capabilities.imageInput,
    toolUse: metadata.capabilities.toolUse,
    reasoning: metadata.capabilities.reasoning,
    streaming: metadata.capabilities.streaming,
    contextWindowTokens: metadata.capabilities.contextWindowTokens,
    maxOutputTokens: metadata.capabilities.maxOutputTokens,
    supportedImageMediaTypes: metadata.capabilities.supportedImageMediaTypes,
    voice: metadata.capabilities.voice,
    providerModes: metadata.capabilities.providerModes,
  };
};

export const getImageInputMediaTypeForPath = (
  path: string,
): AgentModelImageMediaType | undefined => {
  const extension = getExtension(path);

  return extension ? IMAGE_EXTENSION_MEDIA_TYPES[extension] : undefined;
};

export const getSupportedImageInputExtensions = (
  provider: ModelProvider,
  model?: string,
): string[] => {
  const supportedMediaTypes = getSupportedImageMediaTypes(provider, model);

  if (supportedMediaTypes.length === 0) {
    return [];
  }

  return Object.entries(IMAGE_EXTENSION_MEDIA_TYPES)
    .flatMap(([extension, mediaType]) =>
      supportedMediaTypes.includes(mediaType) ? [extension] : [],
    )
    .sort();
};

const getSupportedImageMediaTypes = (
  provider: ModelProvider,
  model?: string,
): readonly AgentModelImageMediaType[] => {
  const discovered = model
    ? getDiscoveredModelCapabilities(provider, model)?.supportedImageMediaTypes
    : undefined;

  if (discovered) {
    return discovered
      .map((mediaType) => mediaType.trim().toLowerCase())
      .filter((mediaType): mediaType is AgentModelImageMediaType =>
        IMAGE_MEDIA_TYPES.has(mediaType as AgentModelImageMediaType),
      )
      .filter(
        (mediaType, index, entries) => entries.indexOf(mediaType) === index,
      );
  }

  if (model) {
    const modelProfile = getModelCapabilityProfile(provider, model);

    if (modelProfile) {
      return modelProfile.supportedImageMediaTypes;
    }
  }

  return getProviderCapabilityProfile(provider)?.imageInputMediaTypes ?? [];
};

export const providerSupportsImageInputMediaType = (
  provider: ModelProvider,
  mediaType: AgentModelImageMediaType,
  model?: string,
): boolean => {
  return getSupportedImageMediaTypes(provider, model).includes(mediaType);
};

export const modelSupportsImageInput = (
  provider: ModelProvider,
  model: string,
): boolean => {
  const discovered = getDiscoveredModelCapabilities(
    provider,
    model,
  )?.imageInput;

  if (typeof discovered === "boolean") {
    return discovered;
  }

  return getModelCapabilityProfile(provider, model)?.imageInput ?? false;
};

export const modelSupportsToolUse = (
  provider: ModelProvider,
  model: string,
): boolean => {
  const discovered = getDiscoveredModelCapabilities(provider, model)?.toolUse;

  if (typeof discovered === "boolean") {
    return discovered;
  }

  return getModelCapabilityProfile(provider, model)?.toolUse ?? false;
};

export const modelSupportsReasoning = (
  provider: ModelProvider,
  model: string,
): boolean => {
  const discovered = getDiscoveredModelCapabilities(provider, model)?.reasoning;

  if (typeof discovered === "boolean") {
    return discovered;
  }

  return getModelCapabilityProfile(provider, model)?.reasoning ?? false;
};

export const modelSupportsStreaming = (
  provider: ModelProvider,
  model: string,
): boolean => {
  const discovered = getDiscoveredModelCapabilities(provider, model)?.streaming;

  if (typeof discovered === "boolean") {
    return discovered;
  }

  return getModelCapabilityProfile(provider, model)?.streaming ?? false;
};

export const modelSupportsVoice = (
  provider: ModelProvider,
  model: string,
): boolean => {
  const discovered = getDiscoveredModelCapabilities(provider, model)?.voice;

  if (typeof discovered === "boolean") {
    return discovered;
  }

  return (getModelCapabilityProfile(provider, model)?.voice.length ?? 0) > 0;
};

export const getModelContextWindowTokens = (
  provider: ModelProvider,
  model: string,
): number | null => {
  const discoveredCapabilities = getDiscoveredModelCapabilities(
    provider,
    model,
  );
  const discovered =
    provider === "codex-cli"
      ? (discoveredCapabilities?.longContextWindowTokens ??
        discoveredCapabilities?.contextWindowTokens)
      : discoveredCapabilities?.contextWindowTokens;

  if (typeof discovered === "number") {
    return discovered;
  }

  return (
    getModelCapabilityProfile(provider, model)?.contextWindowTokens ?? null
  );
};

export const createImageInputUnsupportedModelMessage = (
  provider: ModelProvider,
  model: string,
): string => {
  if (provider === "unconfigured") {
    return "Image attachments require a configured model provider with image input support.";
  }

  return `Model \`${model}\` on provider \`${provider}\` does not support reading image attachments with the registered capability metadata. Select a vision-capable model from the provider catalog or remove the attached images.`;
};
