import { REASONING_MODES } from "../../../../core/runtime-contract.generated.js";
import type { ReasoningMode } from "../../../../core/runtime-contract.generated.js";
import { normalizeOptionalString } from "../../../../helpers/normalize-optional-string.helper.js";
import {
  getDefaultModelForProvider,
  SUPPORTED_PROVIDER_ORDER,
  type RuntimeProvider,
} from "../../model-catalog";

export interface OnboardingState {
  version: 1;
  completedAt?: number;
  skippedAt?: number;
}

export type MainAppId = "chat" | "ralph" | "media" | "marketplace";
export type RunningTaskMessageAction = "steer" | "stop-and-send" | "queue";

export interface AppShellState {
  version: 1;
  activeApp: MainAppId;
  lastViewedAt: Record<MainAppId, number>;
}

export interface McpMarketplaceRegistrySourceState {
  id: string;
  title: string;
  baseUrl: string;
  enabled: boolean;
}

export interface McpMarketplaceState {
  version: 1;
  registries: McpMarketplaceRegistrySourceState[];
}

export interface RalphSettings {
  version: 1;
  workspaceRoot: string | null;
  flowLibraryMode: RalphFlowLibraryMode;
  generationProvider: RuntimeProvider;
  generationModel: string;
  generationReasoning?: ReasoningMode;
  generationPromptHistory?: string[];
  runProvider: RuntimeProvider;
  runModel: string;
  runReasoning?: ReasoningMode;
  defaultMaxTransitions?: number;
}

export type RalphFlowLibraryMode = "workspace" | "user" | "all";

export type AppearanceTheme = "dark" | "light";
export type AppearanceDensity = "comfortable" | "compact";
export type AppearanceAccent = "sky" | "emerald" | "violet" | "amber";
export type QuickChatBubbleStyle = "classic" | "glass" | "pulse" | "orbit";

export interface AppearanceSettings {
  version: 1;
  theme: AppearanceTheme;
  density: AppearanceDensity;
  accent: AppearanceAccent;
  quickChatBubbleStyle: QuickChatBubbleStyle;
}

export const DEFAULT_APPEARANCE_SETTINGS = {
  version: 1,
  theme: "dark",
  density: "comfortable",
  accent: "sky",
  quickChatBubbleStyle: "classic",
} as const satisfies AppearanceSettings;

const DEFAULT_RALPH_PROVIDER = SUPPORTED_PROVIDER_ORDER[0] ?? "openai";

export const DEFAULT_APP_SHELL_STATE = {
  version: 1,
  activeApp: "chat",
  lastViewedAt: {
    chat: 0,
    ralph: 0,
    media: 0,
    marketplace: 0,
  },
} as const satisfies AppShellState;

export const DEFAULT_RUNNING_TASK_MESSAGE_ACTION =
  "queue" as const satisfies RunningTaskMessageAction;

export const DEFAULT_MCP_MARKETPLACE_STATE = {
  version: 1,
  registries: [],
} as const satisfies McpMarketplaceState;

export const DEFAULT_RALPH_SETTINGS = {
  version: 1,
  workspaceRoot: null,
  flowLibraryMode: "workspace",
  generationProvider: DEFAULT_RALPH_PROVIDER,
  generationModel: getDefaultModelForProvider(DEFAULT_RALPH_PROVIDER),
  runProvider: DEFAULT_RALPH_PROVIDER,
  runModel: getDefaultModelForProvider(DEFAULT_RALPH_PROVIDER),
} as const satisfies RalphSettings;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const isRuntimeProvider = (value: unknown): value is RuntimeProvider => {
  return SUPPORTED_PROVIDER_ORDER.includes(value as RuntimeProvider);
};

const isReasoningMode = (value: unknown): value is ReasoningMode => {
  return REASONING_MODES.includes(value as ReasoningMode);
};

const isOneOf = <T extends string>(
  value: unknown,
  allowedValues: readonly T[],
): value is T => {
  return (
    typeof value === "string" &&
    allowedValues.includes(value as T)
  );
};

const normalizeOneOf = <T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  fallback: T,
): T => {
  return isOneOf(value, allowedValues) ? value : fallback;
};

const normalizeArrayItems = <T>(
  value: unknown,
  normalizeItem: (entry: unknown) => T | undefined,
): T[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const normalized = normalizeItem(entry);
    return normalized === undefined ? [] : [normalized];
  });
};

const normalizeWorkspaceRoot = (value: unknown): string | null => {
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const normalizeStringHistory = (value: unknown, limit: number): string[] => {
  return normalizeArrayItems(value, (entry) => {
    if (typeof entry !== "string") {
      return undefined;
    }

    return entry.trim() || undefined;
  }).slice(-limit);
};

const normalizeMainAppId = (value: unknown): MainAppId => {
  return normalizeOneOf(
    value,
    ["chat", "ralph", "media", "marketplace"],
    "chat",
  );
};

export const normalizeRunningTaskMessageAction = (
  value: unknown,
): RunningTaskMessageAction => {
  return normalizeOneOf(
    value,
    ["steer", "stop-and-send", "queue"],
    DEFAULT_RUNNING_TASK_MESSAGE_ACTION,
  );
};

export const normalizeAppShellState = (value: unknown): AppShellState => {
  if (!isRecord(value)) {
    return DEFAULT_APP_SHELL_STATE;
  }

  const lastViewedAt = isRecord(value.lastViewedAt) ? value.lastViewedAt : {};

  return {
    version: 1,
    activeApp: normalizeMainAppId(value.activeApp),
    lastViewedAt: {
      chat:
        typeof lastViewedAt.chat === "number"
          ? lastViewedAt.chat
          : DEFAULT_APP_SHELL_STATE.lastViewedAt.chat,
      ralph:
        typeof lastViewedAt.ralph === "number"
          ? lastViewedAt.ralph
          : DEFAULT_APP_SHELL_STATE.lastViewedAt.ralph,
      media:
        typeof lastViewedAt.media === "number"
          ? lastViewedAt.media
          : DEFAULT_APP_SHELL_STATE.lastViewedAt.media,
      marketplace:
        typeof lastViewedAt.marketplace === "number"
          ? lastViewedAt.marketplace
          : DEFAULT_APP_SHELL_STATE.lastViewedAt.marketplace,
    },
  };
};

const normalizeMarketplaceRegistrySource = (
  value: unknown,
): McpMarketplaceRegistrySourceState | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = normalizeOptionalString(value.id);
  const title = normalizeOptionalString(value.title);
  const baseUrl = normalizeOptionalString(value.baseUrl);

  if (!id || !title || !baseUrl) {
    return undefined;
  }

  return {
    id,
    title,
    baseUrl,
    enabled: value.enabled !== false,
  };
};

export const normalizeMcpMarketplaceState = (
  value: unknown,
): McpMarketplaceState => {
  if (!isRecord(value)) {
    return DEFAULT_MCP_MARKETPLACE_STATE;
  }

  return {
    version: 1,
    registries: normalizeArrayItems(
      value.registries,
      normalizeMarketplaceRegistrySource,
    ),
  };
};

const normalizeRalphProvider = (value: unknown): RuntimeProvider => {
  return isRuntimeProvider(value) ? value : DEFAULT_RALPH_PROVIDER;
};

const normalizeRalphModel = (
  value: unknown,
  provider: RuntimeProvider,
): string => {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : getDefaultModelForProvider(provider);
};

const normalizeRalphFlowLibraryMode = (
  value: unknown,
): RalphFlowLibraryMode => {
  return normalizeOneOf(
    value,
    ["workspace", "user", "all"],
    DEFAULT_RALPH_SETTINGS.flowLibraryMode,
  );
};

export const normalizeRalphSettings = (value: unknown): RalphSettings => {
  if (!isRecord(value)) {
    return DEFAULT_RALPH_SETTINGS;
  }

  const generationProvider = normalizeRalphProvider(value.generationProvider);
  const runProvider = normalizeRalphProvider(value.runProvider);
  const defaultMaxTransitions =
    typeof value.defaultMaxTransitions === "number" &&
    Number.isFinite(value.defaultMaxTransitions) &&
    value.defaultMaxTransitions > 0
      ? Math.floor(value.defaultMaxTransitions)
      : undefined;

  return {
    version: 1,
    workspaceRoot: normalizeWorkspaceRoot(value.workspaceRoot),
    flowLibraryMode: normalizeRalphFlowLibraryMode(value.flowLibraryMode),
    generationProvider,
    generationModel: normalizeRalphModel(
      value.generationModel,
      generationProvider,
    ),
    ...(isReasoningMode(value.generationReasoning)
      ? { generationReasoning: value.generationReasoning }
      : {}),
    generationPromptHistory: normalizeStringHistory(
      value.generationPromptHistory,
      40,
    ),
    runProvider,
    runModel: normalizeRalphModel(value.runModel, runProvider),
    ...(isReasoningMode(value.runReasoning)
      ? { runReasoning: value.runReasoning }
      : {}),
    ...(defaultMaxTransitions ? { defaultMaxTransitions } : {}),
  };
};

export const normalizeAppearanceSettings = (
  value: unknown,
): AppearanceSettings => {
  if (!isRecord(value)) {
    return DEFAULT_APPEARANCE_SETTINGS;
  }

  return {
    version: 1,
    theme: normalizeOneOf(
      value.theme,
      ["dark", "light"],
      DEFAULT_APPEARANCE_SETTINGS.theme,
    ),
    density: normalizeOneOf(
      value.density,
      ["comfortable", "compact"],
      DEFAULT_APPEARANCE_SETTINGS.density,
    ),
    accent: normalizeOneOf(
      value.accent,
      ["sky", "emerald", "violet", "amber"],
      DEFAULT_APPEARANCE_SETTINGS.accent,
    ),
    quickChatBubbleStyle: normalizeOneOf(
      value.quickChatBubbleStyle,
      ["classic", "glass", "pulse", "orbit"],
      DEFAULT_APPEARANCE_SETTINGS.quickChatBubbleStyle,
    ),
  };
};
