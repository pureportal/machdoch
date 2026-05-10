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
  description: string;
  bestFor: string;
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
      "Anthropic recommends Opus for the most complex work, Sonnet for the best speed/intelligence blend, and Haiku for fastest lower-cost work.",
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
    description:
      "Latest flagship frontier model for complex reasoning, coding, and professional agent workflows.",
    bestFor: "Deep coding, planning, and high-value automation.",
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
    description:
      "More affordable frontier model for coding and professional work.",
    bestFor: "Coding, planning, and broad agent tasks with better price-performance.",
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
    description:
      "Strong mini model for coding, subagents, and lower-latency workflows.",
    bestFor: "Desktop copilots, subagents, and everyday coding tasks.",
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
    description:
      "Smallest GPT-5.4 family model for high-volume structured work.",
    bestFor: "Classification, routing, summarization, and background jobs.",
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
    provider: "anthropic",
    id: "claude-opus-4-7",
    label: "Claude Opus 4.7",
    lifecycle: "stable",
    description:
      "Most capable Claude model for complex reasoning and agentic coding.",
    bestFor: "Hard coding tasks, deep analysis, and long-context agent workflows.",
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
    description:
      "Fast, balanced Claude model with excellent coding and reasoning performance.",
    bestFor: "Day-to-day coding, review, and product workflows.",
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
    description: "Fastest Claude tier with near-frontier intelligence.",
    bestFor: "Fast chat, extraction, classification, and lightweight automation.",
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
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    lifecycle: "stable",
    description:
      "Google's advanced stable Gemini model for reasoning and multimodal work.",
    bestFor: "Complex multimodal reasoning and larger coding workflows.",
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
    description:
      "Best price-performance Gemini model for fast reasoning-heavy work.",
    bestFor: "Fast general-purpose chat, reasoning, and multimodal pipelines.",
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
    id: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite",
    lifecycle: "stable",
    description:
      "Fastest stable Gemini 2.5 workhorse for cost-sensitive throughput.",
    bestFor: "High-volume automation, routing, and short-form generation.",
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
    description:
      "Preview Gemini 3.1 Pro model with advanced intelligence and coding capabilities.",
    bestFor: "Exploring latest Google reasoning/coding behavior before stable rollout.",
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
    description:
      "Preview Flash model aimed at lower-cost speed on the newest Gemini generation.",
    bestFor: "Fast experimentation with latest Gemini Flash behavior.",
    recommendedFor: ["fast", "cheap", "vision"],
    capabilities: createGoogleCapabilities({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 65_536,
    }),
    warnings: ["Preview model: verify behavior and availability before production use."],
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
