import type { AgentModelImageMediaType } from "./types.js";
import type { ModelProvider } from "./runtime-contract.generated.js";
import { DEFAULT_MODEL_BY_PROVIDER as CONTRACT_DEFAULT_MODEL_BY_PROVIDER } from "./runtime-contract.generated.js";
import { normalizeModelId } from "../helpers/normalize-model-id.helper.js";

export type ConfiguredModelProvider = Exclude<ModelProvider, "unconfigured">;

export type ProviderModelMode =
  | "anthropic-messages"
  | "external-agent-cli"
  | "gemini-chat"
  | "gemini-function-calling-any"
  | "openai-chat-completions"
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

export const LANGDOCK_IMAGE_MEDIA_TYPES = [
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const satisfies readonly AgentModelImageMediaType[];

export const PROVIDER_MODEL_MODES: Record<
  ConfiguredModelProvider,
  readonly ProviderModelMode[]
> = {
  anthropic: ["anthropic-messages"],
  "claude-cli": ["external-agent-cli"],
  "codex-cli": ["external-agent-cli"],
  "copilot-cli": ["external-agent-cli"],
  google: ["gemini-chat", "gemini-function-calling-any"],
  langdock: [
    "anthropic-messages",
    "gemini-chat",
    "gemini-function-calling-any",
    "openai-chat-completions",
  ],
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

const createLangdockCapabilities = (
  overrides: Partial<ProviderModelCapabilityMetadata>,
): ProviderModelCapabilityMetadata =>
  createCapabilities("langdock", {
    imageInput: true,
    reasoning: true,
    supportedImageMediaTypes: LANGDOCK_IMAGE_MEDIA_TYPES,
    ...overrides,
  });

const createCodexCliCapabilities = (
  overrides: Partial<ProviderModelCapabilityMetadata>,
): ProviderModelCapabilityMetadata =>
  createCapabilities("codex-cli", {
    imageInput: true,
    reasoning: true,
    supportedImageMediaTypes: OPENAI_IMAGE_MEDIA_TYPES,
    ...overrides,
  });

const createClaudeCliCapabilities = (
  overrides: Partial<ProviderModelCapabilityMetadata>,
): ProviderModelCapabilityMetadata =>
  createCapabilities("claude-cli", {
    reasoning: true,
    ...overrides,
  });

const createCopilotCliCapabilities = (
  overrides: Partial<ProviderModelCapabilityMetadata>,
): ProviderModelCapabilityMetadata =>
  createCapabilities("copilot-cli", {
    reasoning: true,
    ...overrides,
  });

export const DEFAULT_MODEL_BY_PROVIDER = CONTRACT_DEFAULT_MODEL_BY_PROVIDER;

export const PROVIDER_CATALOG_METADATA: readonly ProviderCatalogMetadata[] = [
  {
    provider: "openai",
    docsUrl: "https://developers.openai.com/api/docs/models",
    note:
      "OpenAI model availability is discovered through the Models API and filtered to current GPT text-generation families.",
  },
  {
    provider: "anthropic",
    docsUrl: "https://platform.claude.com/docs/en/about-claude/models/overview",
    note:
      "Anthropic model availability is discovered through the Models API and filtered to current Claude text-generation families.",
  },
  {
    provider: "google",
    docsUrl: "https://ai.google.dev/gemini-api/docs/models",
    note:
      "Gemini model metadata is available through the Models API, including generation methods and token limits.",
  },
  {
    provider: "langdock",
    docsUrl: "https://docs.langdock.com/en/developer/overview/api-introduction",
    note:
      "Langdock exposes provider-specific completion APIs; Machdoch routes GPT and OpenAI-compatible chat models through OpenAI Chat Completions, Claude models through Anthropic Messages, and Gemini models through Google generateContent.",
  },
  {
    provider: "codex-cli",
    docsUrl: "https://developers.openai.com/codex/models",
    note:
      "Codex CLI runs through `codex exec`; supported GPT models can be discovered from `codex debug models`.",
  },
  {
    provider: "claude-cli",
    docsUrl: "https://code.claude.com/docs/en/cli-reference",
    note:
      "Claude CLI runs through `claude -p` in non-interactive mode; model selection is delegated with `--model`.",
  },
  {
    provider: "copilot-cli",
    docsUrl:
      "https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference",
    note:
      "Copilot CLI runs through `copilot -p` in non-interactive mode; model selection is delegated with `--model`, including `--model=auto` when Auto is selected.",
  },
] as const;

export const PROVIDER_MODEL_METADATA = [
  {
    provider: "openai",
    id: "gpt-5.6",
    label: "GPT-5.6 (Sol)",
    lifecycle: "stable",
    releaseDate: "2026-07-09",
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
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    lifecycle: "stable",
    releaseDate: "2026-07-09",
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
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    lifecycle: "stable",
    releaseDate: "2026-07-09",
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
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    lifecycle: "stable",
    releaseDate: "2026-07-09",
    recommendedFor: ["coding", "fast", "cheap", "vision", "computer-use"],
    capabilities: createOpenAiCapabilities({
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 128_000,
    }),
    warnings: [],
    source: "curated-fallback",
  },
  {
    provider: "openai",
    id: "gpt-5.5",
    label: "GPT-5.5",
    lifecycle: "stable",
    releaseDate: "2026-05-01",
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
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    lifecycle: "stable",
    releaseDate: "2026-06-01",
    recommendedFor: ["coding", "fast", "vision"],
    capabilities: createAnthropicCapabilities({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 128_000,
    }),
    warnings: [],
    source: "curated-fallback",
  },
  {
    provider: "anthropic",
    id: "claude-fable-5",
    label: "Claude Fable 5",
    lifecycle: "stable",
    releaseDate: "2026-06-01",
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
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    lifecycle: "stable",
    releaseDate: "2026-05-28",
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
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    lifecycle: "stable",
    releaseDate: "2025-10-15",
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
    recommendedFor: ["fast", "cheap", "vision"],
    capabilities: createGoogleCapabilities({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 65_536,
    }),
    warnings: [],
    source: "curated-fallback",
  },
  {
    provider: "langdock",
    id: "gpt-5.5",
    label: "GPT-5.5",
    lifecycle: "stable",
    releaseDate: "2026-05-01",
    recommendedFor: ["coding", "vision"],
    capabilities: createLangdockCapabilities({
      contextWindowTokens: null,
      maxOutputTokens: null,
    }),
    warnings: [
      "Langdock model availability is tied to the API key account; use live model discovery to confirm this key can access the model.",
    ],
    source: "curated-fallback",
  },
  {
    provider: "langdock",
    id: "gpt-5.4",
    label: "GPT-5.4",
    lifecycle: "stable",
    releaseDate: "2026-03-05",
    recommendedFor: ["coding", "vision"],
    capabilities: createLangdockCapabilities({
      contextWindowTokens: null,
      maxOutputTokens: null,
    }),
    warnings: [
      "Langdock model availability is tied to the API key account; use live model discovery to confirm this key can access the model.",
    ],
    source: "curated-fallback",
  },
  {
    provider: "langdock",
    id: "gpt-5.4-mini",
    label: "GPT-5.4 mini",
    lifecycle: "stable",
    releaseDate: "2026-03-17",
    recommendedFor: ["coding", "fast", "cheap", "vision"],
    capabilities: createLangdockCapabilities({
      contextWindowTokens: null,
      maxOutputTokens: null,
    }),
    warnings: [
      "Langdock model availability is tied to the API key account; use live model discovery to confirm this key can access the model.",
    ],
    source: "curated-fallback",
  },
  {
    provider: "langdock",
    id: "gpt-5.2-pro",
    label: "GPT-5.2 Pro",
    lifecycle: "stable",
    releaseDate: "2025-08-07",
    recommendedFor: ["coding", "vision"],
    capabilities: createLangdockCapabilities({
      contextWindowTokens: null,
      maxOutputTokens: null,
    }),
    warnings: [
      "Langdock model availability is tied to the API key account; use live model discovery to confirm this key can access the model.",
    ],
    source: "curated-fallback",
  },
  {
    provider: "codex-cli",
    id: "gpt-5.6",
    label: "GPT-5.6 (Sol)",
    lifecycle: "stable",
    releaseDate: "2026-07-09",
    recommendedFor: ["coding", "vision", "computer-use"],
    capabilities: createCodexCliCapabilities({
      computerUse: true,
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 128_000,
    }),
    warnings: [
      "Runs through the locally installed Codex CLI; availability depends on Codex authentication and CLI configuration.",
    ],
    source: "curated-fallback",
  },
  {
    provider: "codex-cli",
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    lifecycle: "stable",
    releaseDate: "2026-07-09",
    recommendedFor: ["coding", "vision", "computer-use"],
    capabilities: createCodexCliCapabilities({
      computerUse: true,
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 128_000,
    }),
    warnings: [
      "Runs through the locally installed Codex CLI; availability depends on Codex authentication and CLI configuration.",
    ],
    source: "curated-fallback",
  },
  {
    provider: "codex-cli",
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    lifecycle: "stable",
    releaseDate: "2026-07-09",
    recommendedFor: ["coding", "vision", "computer-use"],
    capabilities: createCodexCliCapabilities({
      computerUse: true,
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 128_000,
    }),
    warnings: [
      "Runs through the locally installed Codex CLI; availability depends on Codex authentication and CLI configuration.",
    ],
    source: "curated-fallback",
  },
  {
    provider: "codex-cli",
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    lifecycle: "stable",
    releaseDate: "2026-07-09",
    recommendedFor: ["coding", "fast", "cheap", "vision", "computer-use"],
    capabilities: createCodexCliCapabilities({
      computerUse: true,
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 128_000,
    }),
    warnings: [
      "Runs through the locally installed Codex CLI; availability depends on Codex authentication and CLI configuration.",
    ],
    source: "curated-fallback",
  },
  {
    provider: "codex-cli",
    id: "gpt-5.5",
    label: "GPT-5.5",
    lifecycle: "stable",
    releaseDate: "2026-05-01",
    recommendedFor: ["coding", "vision"],
    capabilities: createCodexCliCapabilities({
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 128_000,
    }),
    warnings: [
      "Runs through the locally installed Codex CLI; availability depends on Codex authentication and CLI configuration.",
    ],
    source: "curated-fallback",
  },
  {
    provider: "codex-cli",
    id: "gpt-5.4",
    label: "GPT-5.4",
    lifecycle: "stable",
    releaseDate: "2026-03-05",
    recommendedFor: ["coding", "vision"],
    capabilities: createCodexCliCapabilities({
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 128_000,
    }),
    warnings: [
      "Runs through the locally installed Codex CLI; availability depends on Codex authentication and CLI configuration.",
    ],
    source: "curated-fallback",
  },
  {
    provider: "codex-cli",
    id: "gpt-5.4-mini",
    label: "GPT-5.4 mini",
    lifecycle: "stable",
    releaseDate: "2026-03-17",
    recommendedFor: ["coding", "fast", "cheap", "vision"],
    capabilities: createCodexCliCapabilities({
      contextWindowTokens: 400_000,
      maxOutputTokens: 128_000,
    }),
    warnings: [
      "Runs through the locally installed Codex CLI; availability depends on Codex authentication and CLI configuration.",
    ],
    source: "curated-fallback",
  },
  {
    provider: "codex-cli",
    id: "gpt-5.3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    lifecycle: "preview",
    releaseDate: "2026-01-01",
    recommendedFor: ["coding", "fast"],
    capabilities: createCodexCliCapabilities({
      imageInput: false,
      supportedImageMediaTypes: withoutImages,
      computerUse: false,
      contextWindowTokens: null,
      maxOutputTokens: null,
    }),
    warnings: [
      "Research preview model for ChatGPT Pro users; verify local Codex CLI availability before selecting it.",
    ],
    source: "curated-fallback",
  },
  {
    provider: "claude-cli",
    id: "sonnet",
    label: "Sonnet",
    lifecycle: "stable",
    releaseDate: "2026-01-01",
    recommendedFor: ["coding", "fast"],
    capabilities: createClaudeCliCapabilities({
      contextWindowTokens: null,
      maxOutputTokens: null,
    }),
    warnings: [
      "Runs through the locally installed Claude CLI; availability depends on Claude authentication and CLI configuration.",
    ],
    source: "curated-fallback",
  },
  {
    provider: "claude-cli",
    id: "opus",
    label: "Opus",
    lifecycle: "stable",
    releaseDate: "2026-01-01",
    recommendedFor: ["coding"],
    capabilities: createClaudeCliCapabilities({
      contextWindowTokens: null,
      maxOutputTokens: null,
    }),
    warnings: [
      "Runs through the locally installed Claude CLI; availability depends on Claude authentication and CLI configuration.",
    ],
    source: "curated-fallback",
  },
  {
    provider: "claude-cli",
    id: "haiku",
    label: "Haiku",
    lifecycle: "stable",
    releaseDate: "2026-01-01",
    recommendedFor: ["fast", "cheap"],
    capabilities: createClaudeCliCapabilities({
      contextWindowTokens: null,
      maxOutputTokens: null,
    }),
    warnings: [
      "Runs through the locally installed Claude CLI; availability depends on Claude authentication and CLI configuration.",
    ],
    source: "curated-fallback",
  },
  {
    provider: "claude-cli",
    id: "fable",
    label: "Fable",
    lifecycle: "stable",
    releaseDate: "2026-01-01",
    recommendedFor: ["coding"],
    capabilities: createClaudeCliCapabilities({
      contextWindowTokens: null,
      maxOutputTokens: null,
    }),
    warnings: [
      "Runs through the locally installed Claude CLI; availability depends on Claude authentication and CLI configuration.",
    ],
    source: "curated-fallback",
  },
  {
    provider: "copilot-cli",
    id: "auto",
    label: "Auto",
    lifecycle: "stable",
    releaseDate: "2026-01-01",
    recommendedFor: ["coding"],
    capabilities: createCopilotCliCapabilities({
      contextWindowTokens: null,
      maxOutputTokens: null,
    }),
    warnings: [
      "Runs through the locally installed Copilot CLI; availability depends on GitHub Copilot authentication and CLI configuration.",
    ],
    source: "curated-fallback",
  },
  {
    provider: "copilot-cli",
    id: "claude-sonnet-4.6",
    label: "Claude Sonnet 4.6",
    lifecycle: "stable",
    releaseDate: "2026-02-17",
    recommendedFor: ["coding", "fast"],
    capabilities: createCopilotCliCapabilities({
      contextWindowTokens: null,
      maxOutputTokens: null,
    }),
    warnings: [
      "Runs through the locally installed Copilot CLI; model availability depends on GitHub Copilot plan and organization policy.",
    ],
    source: "curated-fallback",
  },
  {
    provider: "copilot-cli",
    id: "gpt-5.4",
    label: "GPT-5.4",
    lifecycle: "stable",
    releaseDate: "2026-03-05",
    recommendedFor: ["coding"],
    capabilities: createCopilotCliCapabilities({
      contextWindowTokens: null,
      maxOutputTokens: null,
    }),
    warnings: [
      "Runs through the locally installed Copilot CLI; model availability depends on GitHub Copilot plan and organization policy.",
    ],
    source: "curated-fallback",
  },
  {
    provider: "copilot-cli",
    id: "claude-haiku-4.5",
    label: "Claude Haiku 4.5",
    lifecycle: "stable",
    releaseDate: "2025-10-15",
    recommendedFor: ["fast", "cheap"],
    capabilities: createCopilotCliCapabilities({
      contextWindowTokens: null,
      maxOutputTokens: null,
    }),
    warnings: [
      "Runs through the locally installed Copilot CLI; model availability depends on GitHub Copilot plan and organization policy.",
    ],
    source: "curated-fallback",
  },
  {
    provider: "copilot-cli",
    id: "gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    lifecycle: "stable",
    releaseDate: "2026-01-01",
    recommendedFor: ["coding"],
    capabilities: createCopilotCliCapabilities({
      contextWindowTokens: null,
      maxOutputTokens: null,
    }),
    warnings: [
      "Runs through the locally installed Copilot CLI; model availability depends on GitHub Copilot plan and organization policy.",
    ],
    source: "curated-fallback",
  },
  {
    provider: "copilot-cli",
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro",
    lifecycle: "preview",
    releaseDate: "2026-02-01",
    recommendedFor: ["coding"],
    capabilities: createCopilotCliCapabilities({
      contextWindowTokens: null,
      maxOutputTokens: null,
    }),
    warnings: [
      "Runs through the locally installed Copilot CLI; model availability depends on GitHub Copilot plan and organization policy.",
    ],
    source: "curated-fallback",
  },
  {
    provider: "copilot-cli",
    id: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    lifecycle: "stable",
    releaseDate: "2026-05-19",
    recommendedFor: ["coding", "fast"],
    capabilities: createCopilotCliCapabilities({
      contextWindowTokens: null,
      maxOutputTokens: null,
    }),
    warnings: [
      "Runs through the locally installed Copilot CLI; model availability depends on GitHub Copilot plan and organization policy.",
    ],
    source: "curated-fallback",
  },
] as const satisfies readonly ProviderModelMetadata[];

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
