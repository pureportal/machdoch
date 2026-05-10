import {
  ANTHROPIC_IMAGE_MEDIA_TYPES,
  findProviderModelMetadata,
  GOOGLE_IMAGE_MEDIA_TYPES,
  OPENAI_IMAGE_MEDIA_TYPES,
  PROVIDER_MODEL_METADATA,
  PROVIDER_MODEL_MODES,
  type ConfiguredModelProvider,
  type ProviderModelMode,
  type ProviderModelVoiceCapability,
} from "./provider-model-registry.js";
import type { AgentModelImageMediaType, ModelProvider } from "./types.js";

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

const IMAGE_EXTENSION_MEDIA_TYPES: Record<string, AgentModelImageMediaType> = {
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const PROVIDER_CAPABILITY_PROFILES: Record<
  ConfiguredModelProvider,
  ProviderCapabilityProfile
> = {
  anthropic: {
    provider: "anthropic",
    imageInputMediaTypes: ANTHROPIC_IMAGE_MEDIA_TYPES,
    providerModes: PROVIDER_MODEL_MODES.anthropic,
  },
  google: {
    provider: "google",
    imageInputMediaTypes: GOOGLE_IMAGE_MEDIA_TYPES,
    providerModes: PROVIDER_MODEL_MODES.google,
  },
  openai: {
    provider: "openai",
    imageInputMediaTypes: OPENAI_IMAGE_MEDIA_TYPES,
    providerModes: PROVIDER_MODEL_MODES.openai,
  },
};

export const MODEL_CAPABILITY_CATALOG = PROVIDER_MODEL_METADATA.map(
  (entry): ModelCapabilityProfile => ({
    provider: entry.provider,
    model: entry.id,
    imageInput: entry.capabilities.imageInput,
    toolUse: entry.capabilities.toolUse,
    reasoning: entry.capabilities.reasoning,
    streaming: entry.capabilities.streaming,
    contextWindowTokens: entry.capabilities.contextWindowTokens,
    maxOutputTokens: entry.capabilities.maxOutputTokens,
    supportedImageMediaTypes: entry.capabilities.supportedImageMediaTypes,
    voice: entry.capabilities.voice,
    providerModes: entry.capabilities.providerModes,
  }),
) satisfies readonly ModelCapabilityProfile[];

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
    return undefined;
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
): string[] => {
  const providerProfile = getProviderCapabilityProfile(provider);

  if (!providerProfile) {
    return [];
  }

  return Object.entries(IMAGE_EXTENSION_MEDIA_TYPES)
    .flatMap(([extension, mediaType]) =>
      providerProfile.imageInputMediaTypes.includes(mediaType) ? [extension] : [],
    )
    .sort();
};

export const providerSupportsImageInputMediaType = (
  provider: ModelProvider,
  mediaType: AgentModelImageMediaType,
): boolean => {
  return (
    getProviderCapabilityProfile(provider)?.imageInputMediaTypes.includes(
      mediaType,
    ) ?? false
  );
};

export const modelSupportsImageInput = (
  provider: ModelProvider,
  model: string,
): boolean => {
  return getModelCapabilityProfile(provider, model)?.imageInput ?? false;
};

export const modelSupportsToolUse = (
  provider: ModelProvider,
  model: string,
): boolean => {
  return getModelCapabilityProfile(provider, model)?.toolUse ?? false;
};

export const modelSupportsReasoning = (
  provider: ModelProvider,
  model: string,
): boolean => {
  return getModelCapabilityProfile(provider, model)?.reasoning ?? false;
};

export const modelSupportsStreaming = (
  provider: ModelProvider,
  model: string,
): boolean => {
  return getModelCapabilityProfile(provider, model)?.streaming ?? false;
};

export const modelSupportsVoice = (
  provider: ModelProvider,
  model: string,
): boolean => {
  return (getModelCapabilityProfile(provider, model)?.voice.length ?? 0) > 0;
};

export const getModelContextWindowTokens = (
  provider: ModelProvider,
  model: string,
): number | null => {
  return getModelCapabilityProfile(provider, model)?.contextWindowTokens ?? null;
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
