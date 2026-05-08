import type { AgentModelImageMediaType, ModelProvider } from "./types.js";

type ConfiguredModelProvider = Exclude<ModelProvider, "unconfigured">;

export type ModelProviderMode =
  | "anthropic-messages"
  | "gemini-chat"
  | "gemini-function-calling-any"
  | "openai-responses";

export type ModelVoiceCapability =
  | "realtime-voice"
  | "speech-to-text"
  | "text-to-speech";

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

type ModelCapabilityBase = Omit<ModelCapabilityProfile, "provider" | "model">;

interface ModelCapabilityRule {
  provider: ConfiguredModelProvider;
  pattern: RegExp;
  capabilities: ModelCapabilityBase;
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

const ANTHROPIC_IMAGE_MEDIA_TYPES = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const satisfies readonly AgentModelImageMediaType[];
const GOOGLE_IMAGE_MEDIA_TYPES = [
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const satisfies readonly AgentModelImageMediaType[];
const OPENAI_IMAGE_MEDIA_TYPES = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const satisfies readonly AgentModelImageMediaType[];

const PROVIDER_CAPABILITY_PROFILES: Record<
  ConfiguredModelProvider,
  ProviderCapabilityProfile
> = {
  anthropic: {
    provider: "anthropic",
    imageInputMediaTypes: ANTHROPIC_IMAGE_MEDIA_TYPES,
    providerModes: ["anthropic-messages"],
  },
  google: {
    provider: "google",
    imageInputMediaTypes: GOOGLE_IMAGE_MEDIA_TYPES,
    providerModes: ["gemini-chat", "gemini-function-calling-any"],
  },
  openai: {
    provider: "openai",
    imageInputMediaTypes: OPENAI_IMAGE_MEDIA_TYPES,
    providerModes: ["openai-responses"],
  },
};

const withoutImages = [] as const satisfies readonly AgentModelImageMediaType[];
const withoutVoice = [] as const satisfies readonly ModelVoiceCapability[];

const createCapabilityBase = (
  provider: ConfiguredModelProvider,
  overrides: Partial<ModelCapabilityBase>,
): ModelCapabilityBase => ({
  imageInput: false,
  toolUse: true,
  reasoning: false,
  streaming: true,
  contextWindowTokens: null,
  maxOutputTokens: null,
  supportedImageMediaTypes: withoutImages,
  voice: withoutVoice,
  providerModes: PROVIDER_CAPABILITY_PROFILES[provider].providerModes,
  ...overrides,
});

const createProfile = (
  provider: ConfiguredModelProvider,
  model: string,
  overrides: Partial<ModelCapabilityBase>,
): ModelCapabilityProfile => ({
  provider,
  model,
  ...createCapabilityBase(provider, overrides),
});

export const MODEL_CAPABILITY_CATALOG = [
  createProfile("openai", "gpt-5.5", {
    imageInput: true,
    reasoning: true,
    contextWindowTokens: 400_000,
    maxOutputTokens: 128_000,
    supportedImageMediaTypes: OPENAI_IMAGE_MEDIA_TYPES,
  }),
  createProfile("openai", "gpt-5.4", {
    imageInput: true,
    reasoning: true,
    contextWindowTokens: 400_000,
    maxOutputTokens: 128_000,
    supportedImageMediaTypes: OPENAI_IMAGE_MEDIA_TYPES,
  }),
  createProfile("openai", "gpt-5.4-mini", {
    imageInput: true,
    reasoning: true,
    contextWindowTokens: 400_000,
    maxOutputTokens: 128_000,
    supportedImageMediaTypes: OPENAI_IMAGE_MEDIA_TYPES,
  }),
  createProfile("openai", "gpt-5.4-nano", {
    imageInput: true,
    reasoning: true,
    contextWindowTokens: 400_000,
    maxOutputTokens: 128_000,
    supportedImageMediaTypes: OPENAI_IMAGE_MEDIA_TYPES,
  }),
  createProfile("anthropic", "claude-opus-4-6", {
    imageInput: true,
    reasoning: true,
    contextWindowTokens: 200_000,
    maxOutputTokens: 64_000,
    supportedImageMediaTypes: ANTHROPIC_IMAGE_MEDIA_TYPES,
  }),
  createProfile("anthropic", "claude-sonnet-4-6", {
    imageInput: true,
    reasoning: true,
    contextWindowTokens: 200_000,
    maxOutputTokens: 64_000,
    supportedImageMediaTypes: ANTHROPIC_IMAGE_MEDIA_TYPES,
  }),
  createProfile("anthropic", "claude-haiku-4-5", {
    imageInput: true,
    reasoning: true,
    contextWindowTokens: 200_000,
    maxOutputTokens: 64_000,
    supportedImageMediaTypes: ANTHROPIC_IMAGE_MEDIA_TYPES,
  }),
  createProfile("google", "gemini-2.5-pro", {
    imageInput: true,
    reasoning: true,
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 65_536,
    supportedImageMediaTypes: GOOGLE_IMAGE_MEDIA_TYPES,
  }),
  createProfile("google", "gemini-2.5-flash", {
    imageInput: true,
    reasoning: true,
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 65_536,
    supportedImageMediaTypes: GOOGLE_IMAGE_MEDIA_TYPES,
  }),
  createProfile("google", "gemini-2.5-flash-lite", {
    imageInput: true,
    reasoning: true,
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 65_536,
    supportedImageMediaTypes: GOOGLE_IMAGE_MEDIA_TYPES,
  }),
  createProfile("google", "gemini-3.1-pro-preview", {
    imageInput: true,
    reasoning: true,
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 65_536,
    supportedImageMediaTypes: GOOGLE_IMAGE_MEDIA_TYPES,
  }),
  createProfile("google", "gemini-3-flash-preview", {
    imageInput: true,
    reasoning: true,
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 65_536,
    supportedImageMediaTypes: GOOGLE_IMAGE_MEDIA_TYPES,
  }),
] as const satisfies readonly ModelCapabilityProfile[];

const MODEL_CAPABILITY_RULES = [
  {
    provider: "openai",
    pattern:
      /^gpt-5(?:\.\d+)?(?:-(?:mini|nano|pro))?(?:-\d{4}-\d{2}-\d{2})?$/u,
    capabilities: createCapabilityBase("openai", {
      imageInput: true,
      reasoning: true,
      contextWindowTokens: 400_000,
      maxOutputTokens: 128_000,
      supportedImageMediaTypes: OPENAI_IMAGE_MEDIA_TYPES,
    }),
  },
  {
    provider: "openai",
    pattern:
      /^gpt-4(?:\.1|o)(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/u,
    capabilities: createCapabilityBase("openai", {
      imageInput: true,
      reasoning: true,
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 32_768,
      supportedImageMediaTypes: OPENAI_IMAGE_MEDIA_TYPES,
    }),
  },
  {
    provider: "openai",
    pattern: /^o[34](?:-(?:mini))?(?:-\d{4}-\d{2}-\d{2})?$/u,
    capabilities: createCapabilityBase("openai", {
      imageInput: true,
      reasoning: true,
      contextWindowTokens: 200_000,
      maxOutputTokens: 100_000,
      supportedImageMediaTypes: OPENAI_IMAGE_MEDIA_TYPES,
    }),
  },
  {
    provider: "openai",
    pattern: /^(?:gpt-4o-(?:mini-)?audio|gpt-4o-realtime)/u,
    capabilities: createCapabilityBase("openai", {
      imageInput: true,
      reasoning: true,
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
      supportedImageMediaTypes: OPENAI_IMAGE_MEDIA_TYPES,
      voice: ["realtime-voice", "speech-to-text", "text-to-speech"],
    }),
  },
  {
    provider: "openai",
    pattern: /^computer-use-preview$/u,
    capabilities: createCapabilityBase("openai", {
      imageInput: true,
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
      supportedImageMediaTypes: OPENAI_IMAGE_MEDIA_TYPES,
      providerModes: ["openai-responses"],
    }),
  },
  {
    provider: "anthropic",
    pattern:
      /^claude-(?:opus|sonnet|haiku)-4(?:-[\w-]+)?(?:-\d{8})?$/u,
    capabilities: createCapabilityBase("anthropic", {
      imageInput: true,
      reasoning: true,
      contextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
      supportedImageMediaTypes: ANTHROPIC_IMAGE_MEDIA_TYPES,
    }),
  },
  {
    provider: "anthropic",
    pattern: /^claude-3(?:-[\w-]+)?(?:-\d{8})?$/u,
    capabilities: createCapabilityBase("anthropic", {
      imageInput: true,
      contextWindowTokens: 200_000,
      maxOutputTokens: 8_192,
      supportedImageMediaTypes: ANTHROPIC_IMAGE_MEDIA_TYPES,
    }),
  },
  {
    provider: "google",
    pattern: /^gemini-(?!.*(?:embedding|imagen|veo|tts|audio)).+$/u,
    capabilities: createCapabilityBase("google", {
      imageInput: true,
      reasoning: true,
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 65_536,
      supportedImageMediaTypes: GOOGLE_IMAGE_MEDIA_TYPES,
    }),
  },
] as const satisfies readonly ModelCapabilityRule[];

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
  const exactProfile = MODEL_CAPABILITY_CATALOG.find(
    (profile) =>
      profile.provider === provider && profile.model === normalizedModel,
  );

  if (exactProfile) {
    return exactProfile;
  }

  const rule = MODEL_CAPABILITY_RULES.find(
    (candidate) =>
      candidate.provider === provider && candidate.pattern.test(normalizedModel),
  );

  return rule
    ? {
        provider,
        model: normalizedModel,
        ...rule.capabilities,
      }
    : undefined;
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

  return `Model \`${model}\` on provider \`${provider}\` does not support reading image attachments. Select a vision-capable model or remove the attached images.`;
};
