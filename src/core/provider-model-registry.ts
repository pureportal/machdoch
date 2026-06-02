import type { AgentModelImageMediaType, ModelProvider } from "./types.js";
import { DEFAULT_MODEL_BY_PROVIDER as CONTRACT_DEFAULT_MODEL_BY_PROVIDER } from "./runtime-contract.generated.js";

export type ConfiguredModelProvider = Exclude<ModelProvider, "unconfigured">;

export type ProviderModelMode =
  | "anthropic-messages"
  | "gemini-chat"
  | "gemini-function-calling-any"
  | "openai-responses";

export type ProviderModelVoiceCapability =
  | "realtime-voice"
  | "speech-to-text"
  | "text-to-speech";

export type ProviderModelUseCase =
  | "coding"
  | "fast"
  | "cheap"
  | "vision"
  | "voice"
  | "computer-use";

export type ProviderModelLifecycle =
  | "stable"
  | "preview"
  | "deprecated"
  | "open";

export type ProviderModelMetadataSource =
  | "provider-api"
  | "provider-probe"
  | "curated-fallback";

export interface ProviderModelCapabilityMetadata {
  imageInput: boolean;
  toolUse: boolean;
  reasoning: boolean;
  streaming: boolean;
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  supportedImageMediaTypes: readonly AgentModelImageMediaType[];
  voice: readonly ProviderModelVoiceCapability[];
  providerModes: readonly ProviderModelMode[];
  computerUse: boolean;
}

export interface ProviderModelMetadata {
  provider: ConfiguredModelProvider;
  id: string;
  label: string;
  lifecycle: ProviderModelLifecycle;
  releaseDate: string;
  description: string;
  recommendedFor: readonly ProviderModelUseCase[];
  capabilities: ProviderModelCapabilityMetadata;
  warnings: readonly string[];
  source: ProviderModelMetadataSource;
}

export interface ProviderCatalogMetadata {
  provider: ConfiguredModelProvider;
  docsUrl: string;
  note: string;
}

export const ANTHROPIC_IMAGE_MEDIA_TYPES = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const satisfies readonly AgentModelImageMediaType[];

export const GOOGLE_IMAGE_MEDIA_TYPES = [
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const satisfies readonly AgentModelImageMediaType[];

export const OPENAI_IMAGE_MEDIA_TYPES = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const satisfies readonly AgentModelImageMediaType[];

export const PROVIDER_MODEL_MODES: Record<
  ConfiguredModelProvider,
  readonly ProviderModelMode[]
> = {
  anthropic: ["anthropic-messages"],
  google: ["gemini-chat", "gemini-function-calling-any"],
  openai: ["openai-responses"],
};

const withoutImages = [] as const satisfies readonly AgentModelImageMediaType[];
const withoutVoice =
  [] as const satisfies readonly ProviderModelVoiceCapability[];

const createCapabilities = (
  provider: ConfiguredModelProvider,
  overrides: Partial<ProviderModelCapabilityMetadata>,
): ProviderModelCapabilityMetadata => ({
  imageInput: false,
  toolUse: true,
  reasoning: false,
  streaming: true,
  contextWindowTokens: null,
  maxOutputTokens: null,
  supportedImageMediaTypes: withoutImages,
  voice: withoutVoice,
  providerModes: PROVIDER_MODEL_MODES[provider],
  computerUse: false,
  ...overrides,
});

const createOpenAiCapabilities = (
  overrides: Partial<ProviderModelCapabilityMetadata>,
): ProviderModelCapabilityMetadata =>
  createCapabilities("openai", {
    imageInput: true,
    reasoning: true,
    supportedImageMediaTypes: OPENAI_IMAGE_MEDIA_TYPES,
    computerUse: true,
    ...overrides,
  });

const createAnthropicCapabilities = (
  overrides: Partial<ProviderModelCapabilityMetadata>,
): ProviderModelCapabilityMetadata =>
  createCapabilities("anthropic", {
    imageInput: true,
    reasoning: true,
    supportedImageMediaTypes: ANTHROPIC_IMAGE_MEDIA_TYPES,
    ...overrides,
  });

const createGoogleCapabilities = (
  overrides: Partial<ProviderModelCapabilityMetadata>,
): ProviderModelCapabilityMetadata =>
  createCapabilities("google", {
    imageInput: true,
    reasoning: true,
    supportedImageMediaTypes: GOOGLE_IMAGE_MEDIA_TYPES,
    ...overrides,
  });

export const DEFAULT_MODEL_BY_PROVIDER = CONTRACT_DEFAULT_MODEL_BY_PROVIDER;

export const PROVIDER_CATALOG_METADATA: readonly ProviderCatalogMetadata[] = [
  {
    provider: "openai",
    docsUrl: "https://developers.openai.com/api/docs/models",
    note:
      "OpenAI recommends GPT-5.5 for complex reasoning and coding, with GPT-5.4 mini/nano for lower latency and cost.",
  },
  {
    provider: "anthropic",
    docsUrl: "https://platform.claude.com/docs/en/about-claude/models/overview",
    note:
      "Anthropic recommends Opus 4.8 for the most complex work, Sonnet 4.6 for the best speed/intelligence blend, and Haiku 4.5 for fastest lower-cost work.",
  },
  {
    provider: "google",
    docsUrl: "https://ai.google.dev/gemini-api/docs/models",
    note:
      "Gemini model metadata is available through the Models API, including generation methods and token limits.",
  },
] as const;

export const PROVIDER_MODEL_METADATA = [
  {
    provider: "openai",
    id: "gpt-5.5",
    label: "GPT-5.5",
    lifecycle: "stable",
    releaseDate: "2026-05-01",
    description:
      "Latest flagship frontier model for complex reasoning, coding, and professional agent workflows.",
    recommendedFor: ["coding", "vision", "computer-use"],
    capabilities: createOpenAiCapabilities({
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 128_000,
    }),
    warnings: [],
    source: "curated-fallback",
  },
  {
    provider: "openai",
    id: "gpt-5.4",
    label: "GPT-5.4",
    lifecycle: "stable",
    releaseDate: "2026-03-05",
    description:
      "More affordable frontier model for coding and professional work.",
    recommendedFor: ["coding", "vision", "computer-use"],
    capabilities: createOpenAiCapabilities({
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 128_000,
    }),
    warnings: [],
    source: "curated-fallback",
  },
  {
    provider: "openai",
    id: "gpt-5.4-mini",
    label: "GPT-5.4 mini",
    lifecycle: "stable",
    releaseDate: "2026-03-17",
    description:
      "Strong mini model for coding, subagents, and lower-latency workflows.",
    recommendedFor: ["coding", "fast", "cheap", "vision", "computer-use"],
    capabilities: createOpenAiCapabilities({
      contextWindowTokens: 400_000,
      maxOutputTokens: 128_000,
    }),
    warnings: [],
    source: "curated-fallback",
  },
  {
    provider: "openai",
    id: "gpt-5.4-nano",
    label: "GPT-5.4 nano",
    lifecycle: "stable",
    releaseDate: "2026-03-17",
    description:
      "Smallest GPT-5.4 family model for high-volume structured work.",
    recommendedFor: ["fast", "cheap", "vision"],
    capabilities: createOpenAiCapabilities({
      contextWindowTokens: 400_000,
      maxOutputTokens: 128_000,
      computerUse: false,
    }),
    warnings: [],
    source: "curated-fallback",
  },
  {
    provider: "openai",
    id: "gpt-5",
    label: "GPT-5",
    lifecycle: "stable",
    releaseDate: "2025-08-07",
    description:
      "Previous-generation GPT-5 frontier model for reasoning, coding, and agent workflows.",
    recommendedFor: ["coding", "vision", "computer-use"],
    capabilities: createOpenAiCapabilities({
      contextWindowTokens: 400_000,
      maxOutputTokens: 128_000,
    }),
    warnings: [],
    source: "curated-fallback",
  },
  {
    provider: "anthropic",
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    lifecycle: "stable",
    releaseDate: "2026-05-28",
    description:
      "Most capable Claude model for complex reasoning and agentic coding.",
    recommendedFor: ["coding", "vision"],
    capabilities: createAnthropicCapabilities({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 128_000,
    }),
    warnings: [],
    source: "curated-fallback",
  },
  {
    provider: "anthropic",
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    lifecycle: "stable",
    releaseDate: "2026-02-17",
    description:
      "Fast, balanced Claude model with excellent coding and reasoning performance.",
    recommendedFor: ["coding", "fast", "vision"],
    capabilities: createAnthropicCapabilities({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 64_000,
    }),
    warnings: [],
    source: "curated-fallback",
  },
  {
    provider: "anthropic",
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    lifecycle: "stable",
    releaseDate: "2025-10-15",
    description: "Fastest Claude tier with near-frontier intelligence.",
    recommendedFor: ["fast", "cheap", "vision"],
    capabilities: createAnthropicCapabilities({
      contextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
    }),
    warnings: [],
    source: "curated-fallback",
  },
  {
    provider: "google",
    id: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    lifecycle: "stable",
    releaseDate: "2026-05-19",
    description:
      "Current Gemini Flash model for sustained frontier performance on agentic and coding tasks.",
    recommendedFor: ["coding", "fast", "vision"],
    capabilities: createGoogleCapabilities({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 65_536,
    }),
    warnings: [],
    source: "curated-fallback",
  },
  {
    provider: "google",
    id: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash-Lite",
    lifecycle: "stable",
    releaseDate: "2026-05-19",
    description:
      "Fast stable Gemini 3.1 model for high-volume multimodal tasks.",
    recommendedFor: ["fast", "cheap", "vision"],
    capabilities: createGoogleCapabilities({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 65_536,
    }),
    warnings: [],
    source: "curated-fallback",
  },
  {
    provider: "google",
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro",
    lifecycle: "preview",
    releaseDate: "2026-02-01",
    description:
      "Preview Gemini 3.1 Pro model with advanced intelligence and coding capabilities.",
    recommendedFor: ["coding", "vision"],
    capabilities: createGoogleCapabilities({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 65_536,
    }),
    warnings: ["Preview model: verify behavior and availability before production use."],
    source: "curated-fallback",
  },
  {
    provider: "google",
    id: "gemini-3-flash-preview",
    label: "Gemini 3 Flash",
    lifecycle: "preview",
    releaseDate: "2025-12-01",
    description:
      "Preview Flash model aimed at lower-cost speed on the newest Gemini generation.",
    recommendedFor: ["coding", "fast", "cheap", "vision", "computer-use"],
    capabilities: createGoogleCapabilities({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 65_536,
      computerUse: true,
    }),
    warnings: ["Preview model: verify behavior and availability before production use."],
    source: "curated-fallback",
  },
  {
    provider: "google",
    id: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite",
    lifecycle: "stable",
    releaseDate: "2025-07-22",
    description:
      "Fastest stable Gemini 2.5 workhorse for cost-sensitive throughput.",
    recommendedFor: ["fast", "cheap", "vision"],
    capabilities: createGoogleCapabilities({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 65_536,
    }),
    warnings: [],
    source: "curated-fallback",
  },
  {
    provider: "google",
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    lifecycle: "stable",
    releaseDate: "2025-06-17",
    description:
      "Google's advanced stable Gemini 2.5 model for reasoning and multimodal work.",
    recommendedFor: ["coding", "vision"],
    capabilities: createGoogleCapabilities({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 65_536,
    }),
    warnings: [],
    source: "curated-fallback",
  },
  {
    provider: "google",
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    lifecycle: "stable",
    releaseDate: "2025-06-17",
    description:
      "Stable Gemini 2.5 model for fast reasoning-heavy multimodal work.",
    recommendedFor: ["fast", "cheap", "vision"],
    capabilities: createGoogleCapabilities({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 65_536,
    }),
    warnings: [],
    source: "curated-fallback",
  },
] as const satisfies readonly ProviderModelMetadata[];

const normalizeModelId = (model: string): string => model.trim().toLowerCase();

export const getDefaultModelForProvider = (
  provider: ConfiguredModelProvider,
): string => DEFAULT_MODEL_BY_PROVIDER[provider];

export const getProviderCatalogMetadata = (
  provider: ConfiguredModelProvider,
): ProviderCatalogMetadata | undefined =>
  PROVIDER_CATALOG_METADATA.find((entry) => entry.provider === provider);

export const getProviderModelMetadata = (
  provider: ConfiguredModelProvider,
): ProviderModelMetadata[] =>
  PROVIDER_MODEL_METADATA.filter((entry) => entry.provider === provider);

export const findProviderModelMetadata = (
  provider: ConfiguredModelProvider,
  model: string,
): ProviderModelMetadata | undefined => {
  const normalizedModel = normalizeModelId(model);

  return PROVIDER_MODEL_METADATA.find(
    (entry) => entry.provider === provider && entry.id === normalizedModel,
  );
};
