import {
  getModelCapabilityProfile,
  type ModelProviderMode,
  type ModelVoiceCapability,
} from "../../core/model-capabilities.js";

export type RuntimeProvider =
  | "openai"
  | "anthropic"
  | "google";

export type CatalogProviderId = RuntimeProvider | "xai" | "mistral";

export type CatalogModelStage = "stable" | "preview" | "open";

export interface CatalogModelCapabilities {
  imageInput: boolean;
  toolUse: boolean;
  reasoning: boolean;
  streaming: boolean;
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  voice: readonly ModelVoiceCapability[];
  providerModes: readonly ModelProviderMode[];
}

export interface CatalogModel {
  id: string;
  label: string;
  stage: CatalogModelStage;
  description: string;
  bestFor: string;
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

type CatalogModelInput = Omit<
  CatalogModel,
  "capabilities" | "capabilityHighlights"
> & {
  capabilities?: CatalogModelCapabilities;
};

const isRuntimeProvider = (
  provider: CatalogProviderId,
): provider is RuntimeProvider => {
  return provider === "openai" || provider === "anthropic" || provider === "google";
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

const getCatalogModelCapabilities = (
  provider: CatalogProviderId,
  modelId: string,
  fallbackCapabilities?: CatalogModelCapabilities,
): CatalogModelCapabilities | undefined => {
  if (!isRuntimeProvider(provider)) {
    return fallbackCapabilities;
  }

  const profile = getModelCapabilityProfile(provider, modelId);

  return profile
    ? {
        imageInput: profile.imageInput,
        toolUse: profile.toolUse,
        reasoning: profile.reasoning,
        streaming: profile.streaming,
        contextWindowTokens: profile.contextWindowTokens,
        maxOutputTokens: profile.maxOutputTokens,
        voice: profile.voice,
        providerModes: profile.providerModes,
      }
    : fallbackCapabilities;
};

const createCapabilityHighlights = (
  capabilities: CatalogModelCapabilities | undefined,
): string[] => {
  if (!capabilities) {
    return [];
  }

  return [
    capabilities.reasoning ? "Reasoning" : null,
    capabilities.imageInput ? "Vision" : null,
    capabilities.toolUse ? "Tools" : null,
    capabilities.streaming ? "Streaming" : null,
    capabilities.contextWindowTokens
      ? formatTokenWindow(capabilities.contextWindowTokens)
      : null,
    capabilities.voice.length > 0 ? "Voice" : null,
  ].flatMap((label) => (label ? [label] : []));
};

const createCatalogModel = (
  provider: CatalogProviderId,
  model: CatalogModelInput,
): CatalogModel => {
  const capabilities = getCatalogModelCapabilities(
    provider,
    model.id,
    model.capabilities,
  );

  return {
    ...model,
    capabilityHighlights: createCapabilityHighlights(capabilities),
    ...(capabilities ? { capabilities } : {}),
  };
};

export const FRONTIER_PROVIDER_CATALOG: CatalogProvider[] = [
  {
    id: "openai",
    label: "OpenAI",
    docsUrl: "https://developers.openai.com/api/docs/models/all",
    supportedInApp: true,
    note:
      "Official OpenAI docs recommend gpt-5.5 as the flagship frontier model, with GPT-5.4 mini and nano variants for lower latency and cost.",
    models: [
      createCatalogModel("openai", {
        id: "gpt-5.5",
        label: "GPT-5.5",
        stage: "stable",
        description: "Latest flagship frontier model for complex reasoning, coding, and agentic workflows.",
        bestFor: "Deep coding, planning, and high-stakes automation.",
      }),
      createCatalogModel("openai", {
        id: "gpt-5.4",
        label: "GPT-5.4",
        stage: "stable",
        description: "Flagship frontier model for complex reasoning, coding, and agentic workflows.",
        bestFor: "Deep coding, planning, and high-stakes automation.",
      }),
      createCatalogModel("openai", {
        id: "gpt-5.4-mini",
        label: "GPT-5.4 mini",
        stage: "stable",
        description: "Balanced GPT-5.4-tier model with lower latency and better price-performance.",
        bestFor: "Desktop copilots, subagents, and daily code tasks.",
      }),
      createCatalogModel("openai", {
        id: "gpt-5.4-nano",
        label: "GPT-5.4 nano",
        stage: "stable",
        description: "Smallest GPT-5.4 family model for high-volume structured work.",
        bestFor: "Classification, routing, summarization, and lightweight background jobs.",
      }),
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    docsUrl: "https://platform.claude.com/docs/en/about-claude/models/overview",
    supportedInApp: true,
    note:
      "Anthropic's official models overview highlights Claude Opus 4.6 as the most intelligent broadly available model, with Sonnet 4.6 as the best speed/intelligence blend.",
    models: [
      createCatalogModel("anthropic", {
        id: "claude-opus-4-6",
        label: "Claude Opus 4.6",
        stage: "stable",
        description: "Most intelligent broadly available Claude model for agents and coding.",
        bestFor: "Complex coding, deep reasoning, and long-context agent workflows.",
      }),
      createCatalogModel("anthropic", {
        id: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        stage: "stable",
        description: "Fast, balanced Claude model with excellent coding and reasoning performance.",
        bestFor: "Day-to-day coding, review, and product workflows.",
      }),
      createCatalogModel("anthropic", {
        id: "claude-haiku-4-5",
        label: "Claude Haiku 4.5",
        stage: "stable",
        description: "Fastest Claude tier with near-frontier intelligence.",
        bestFor: "Fast chat, classification, extraction, and lightweight automation.",
      }),
    ],
  },
  {
    id: "google",
    label: "Google",
    docsUrl: "https://ai.google.dev/gemini-api/docs/models",
    supportedInApp: true,
    note:
      "Google's Gemini API docs recommend explicit stable model names for production. Gemini 2.5 models are stable today, while Gemini 3.x options are still preview-stage.",
    models: [
      createCatalogModel("google", {
        id: "gemini-2.5-pro",
        label: "Gemini 2.5 Pro",
        stage: "stable",
        description: "Google's stable advanced reasoning model in the Gemini 2.5 family.",
        bestFor: "Complex multimodal reasoning and larger coding workflows.",
      }),
      createCatalogModel("google", {
        id: "gemini-2.5-flash",
        label: "Gemini 2.5 Flash",
        stage: "stable",
        description: "Best price-performance stable Gemini model for reasoning-heavy high-volume workloads.",
        bestFor: "Fast general-purpose chat, reasoning, and multimodal pipelines.",
      }),
      createCatalogModel("google", {
        id: "gemini-2.5-flash-lite",
        label: "Gemini 2.5 Flash-Lite",
        stage: "stable",
        description: "Fastest stable Gemini 2.5 workhorse for cost-sensitive throughput.",
        bestFor: "High-volume automation, routing, and short-form generation.",
      }),
      createCatalogModel("google", {
        id: "gemini-3.1-pro-preview",
        label: "Gemini 3.1 Pro",
        stage: "preview",
        description: "Latest preview Gemini 3.1 Pro model with advanced intelligence and agentic coding capabilities.",
        bestFor: "Exploring newest Google reasoning/coding capabilities before stable rollout.",
      }),
      createCatalogModel("google", {
        id: "gemini-3-flash-preview",
        label: "Gemini 3 Flash",
        stage: "preview",
        description: "Frontier-class preview Flash model aimed at lower-cost speed.",
        bestFor: "Fast experimentation with the latest Gemini 3 Flash behavior.",
      }),
    ],
  },
  {
    id: "xai",
    label: "xAI",
    docsUrl: "https://docs.x.ai/developers/models",
    supportedInApp: false,
    note:
      "xAI's current flagship docs page centers on Grok 4.20 and emphasizes tool-enabled, high-speed agentic workflows.",
    models: [
      createCatalogModel("xai", {
        id: "grok-4.20",
        label: "Grok 4.20",
        stage: "stable",
        description: "Newest xAI flagship model with reasoning, structured outputs, and tool support.",
        bestFor: "Agentic search, tool orchestration, and large-context analysis.",
        capabilities: {
          imageInput: true,
          toolUse: true,
          reasoning: true,
          streaming: true,
          contextWindowTokens: 256_000,
          maxOutputTokens: 32_768,
          voice: [],
          providerModes: [],
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
      "Mistral's 2026 model lineup spans generalist, reasoning, coding, and audio-specialist families, with several strong open models.",
    models: [
      createCatalogModel("mistral", {
        id: "mistral-large-3",
        label: "Mistral Large 3",
        stage: "open",
        description: "Open-weight state-of-the-art general-purpose multimodal model.",
        bestFor: "High-quality general reasoning with deployment flexibility.",
        capabilities: {
          imageInput: true,
          toolUse: true,
          reasoning: true,
          streaming: true,
          contextWindowTokens: 256_000,
          maxOutputTokens: 32_768,
          voice: [],
          providerModes: [],
        },
      }),
      createCatalogModel("mistral", {
        id: "mistral-medium-3.1",
        label: "Mistral Medium 3.1",
        stage: "stable",
        description: "Frontier-class multimodal generalist model.",
        bestFor: "Balanced premium reasoning and multimodal workflows.",
        capabilities: {
          imageInput: true,
          toolUse: true,
          reasoning: true,
          streaming: true,
          contextWindowTokens: 256_000,
          maxOutputTokens: 32_768,
          voice: [],
          providerModes: [],
        },
      }),
      createCatalogModel("mistral", {
        id: "mistral-small-4",
        label: "Mistral Small 4",
        stage: "open",
        description: "Efficient hybrid model unifying instruct, reasoning, and coding.",
        bestFor: "Fast local inference and lightweight coding assistants.",
        capabilities: {
          imageInput: false,
          toolUse: true,
          reasoning: true,
          streaming: true,
          contextWindowTokens: 128_000,
          maxOutputTokens: 32_768,
          voice: [],
          providerModes: [],
        },
      }),
      createCatalogModel("mistral", {
        id: "devstral-2",
        label: "Devstral 2",
        stage: "open",
        description: "Frontier code agents model for software engineering tasks.",
        bestFor: "Code agents and task-oriented engineering flows.",
        capabilities: {
          imageInput: false,
          toolUse: true,
          reasoning: true,
          streaming: true,
          contextWindowTokens: 256_000,
          maxOutputTokens: 32_768,
          voice: [],
          providerModes: [],
        },
      }),
    ],
  },
];

export const getProviderLabel = (provider: CatalogProviderId): string => {
  return PROVIDER_LABELS[provider];
};

export const getCatalogModelsForProvider = (
  provider: RuntimeProvider,
): CatalogModel[] => {
  return (
    FRONTIER_PROVIDER_CATALOG.find((entry) => entry.id === provider)?.models ?? []
  );
};

export const getDefaultModelForProvider = (
  provider: RuntimeProvider,
): string => {
  switch (provider) {
    case "anthropic":
      return "claude-sonnet-4-6";
    case "google":
      return "gemini-2.5-flash";
    case "openai":
    default:
      return "gpt-5.5";
  }
};

export const findCatalogProvider = (
  provider: CatalogProviderId,
): CatalogProvider | undefined => {
  return FRONTIER_PROVIDER_CATALOG.find((entry) => entry.id === provider);
};
