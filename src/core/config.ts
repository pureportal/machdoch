import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeOptionalString } from "../common/_helpers/normalize-optional-string.js";
import {
  getUserConfigPath,
  hasConfiguredValue,
  loadUserAgentLimitsSettings,
  loadUserReviewModelSettings,
  loadUserWebSearchSettings,
  loadWorkspaceEnv,
} from "./env.js";
import {
  getAgentCliProviders,
  resolveAgentCliProviderBinary,
} from "./_helpers/agent-cli-providers.js";
import { normalizeAgentLimitOverrides } from "./_helpers/agent-runtime-types.js";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_MODEL_PROVIDER,
  PROVIDER_ENV_KEY_BY_PROVIDER,
  isReasoningMode as isRuntimeSchemaReasoningMode,
  USER_API_PROVIDERS,
  VALID_WEB_SEARCH_PROVIDERS,
  isConfiguredModelProvider,
  isRunMode as isRuntimeSchemaRunMode,
} from "./runtime-contract.generated.js";
import type {
  ModelProvider,
  ProviderAvailability,
  ReasoningMode,
  RuntimeAgentLimitOverrides,
  RunMode,
  RuntimeConfig,
  RuntimeProfileSummary,
  WebSearchProvider,
  WebSearchProviderAvailability,
  WorkspaceConfigFile,
  WorkspaceProfileConfig,
} from "./runtime-contract.generated.js";

const WORKSPACE_CONFIG_DIRECTORY = ".machdoch";
const WORKSPACE_CONFIG_FILE_NAME = "config.json";

/**
 * Returns whether a string matches one of the supported runtime modes.
 */
const isRunMode = (value: string | undefined): value is RunMode => {
  return isRuntimeSchemaRunMode(value);
};

const isReasoningMode = (
  value: string | undefined,
): value is ReasoningMode => {
  return isRuntimeSchemaReasoningMode(value);
};

const isModelProvider = (
  value: string | undefined,
): value is Exclude<ModelProvider, "unconfigured"> => {
  return isConfiguredModelProvider(value);
};

/**
 * Reads `.machdoch/config.json` when present and returns its parsed contents.
 */
const loadWorkspaceConfigFile = async (
  workspaceRoot: string,
): Promise<{ config: WorkspaceConfigFile; path?: string }> => {
  const configPath = join(
    workspaceRoot,
    WORKSPACE_CONFIG_DIRECTORY,
    WORKSPACE_CONFIG_FILE_NAME,
  );

  if (!existsSync(configPath)) {
    return { config: {} };
  }

  const raw = await readFile(configPath, "utf8");
  const config = JSON.parse(raw) as WorkspaceConfigFile;

  return {
    config,
    path: configPath,
  };
};

const saveWorkspaceConfigFile = async (
  workspaceRoot: string,
  update: Partial<WorkspaceConfigFile>,
): Promise<string> => {
  const configDirectory = join(workspaceRoot, WORKSPACE_CONFIG_DIRECTORY);
  const configPath = join(configDirectory, WORKSPACE_CONFIG_FILE_NAME);
  const existingConfig = existsSync(configPath)
    ? (JSON.parse(await readFile(configPath, "utf8")) as WorkspaceConfigFile)
    : {};

  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        ...existingConfig,
        ...update,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return configPath;
};

/**
 * Persists the workspace default model into `.machdoch/config.json`, creating
 * the config file when needed.
 */
export const saveWorkspaceDefaultModel = async (
  workspaceRoot: string,
  model: string,
): Promise<string> => {
  const normalizedModel = normalizeOptionalString(model);

  if (!normalizedModel) {
    throw new Error("Expected --default-model to be followed by a model name.");
  }

  return saveWorkspaceConfigFile(workspaceRoot, {
    model: normalizedModel,
  });
};

export const saveWorkspaceRuntimeProvider = async (
  workspaceRoot: string,
  provider: string,
): Promise<string> => {
  const normalizedProvider = normalizeOptionalString(provider);

  if (!normalizedProvider || !isConfiguredModelProvider(normalizedProvider)) {
    throw new Error(
      "Expected workspace.provider to be one of openai, anthropic, google, codex-cli, claude-cli, or copilot-cli.",
    );
  }

  return saveWorkspaceConfigFile(workspaceRoot, {
    provider: normalizedProvider,
  });
};

export const saveWorkspaceDefaultMode = async (
  workspaceRoot: string,
  mode: string,
): Promise<string> => {
  const normalizedMode = normalizeOptionalString(mode);

  if (!normalizedMode || !isRunMode(normalizedMode)) {
    throw new Error("Expected workspace.mode to be one of ask or machdoch.");
  }

  return saveWorkspaceConfigFile(workspaceRoot, {
    defaultMode: normalizedMode,
  });
};

export const saveWorkspaceReasoningMode = async (
  workspaceRoot: string,
  reasoning: string,
): Promise<string> => {
  const normalizedReasoning = normalizeOptionalString(reasoning);

  if (!normalizedReasoning || !isReasoningMode(normalizedReasoning)) {
    throw new Error(
      "Expected workspace.reasoning to be one of default, none, minimal, low, medium, high, xhigh, or max.",
    );
  }

  return saveWorkspaceConfigFile(workspaceRoot, {
    reasoning: normalizedReasoning,
  });
};

export const saveWorkspaceOffline = async (
  workspaceRoot: string,
  offline: boolean,
): Promise<string> => {
  return saveWorkspaceConfigFile(workspaceRoot, {
    offline,
  });
};

/**
 * Converts raw profile config entries into sorted profile summaries.
 */
const getAvailableProfiles = (
  profiles: WorkspaceConfigFile["profiles"],
): RuntimeProfileSummary[] => {
  return Object.entries(profiles ?? {})
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
    .map(([name, profile]) => ({
      name,
      ...(profile.description ? { description: profile.description } : {}),
    }));
};

/**
 * Resolves the active profile from CLI overrides, environment, or defaults.
 */
const resolveProfile = (
  config: WorkspaceConfigFile,
  env: Record<string, string>,
  overrideProfile?: string,
): { activeProfile?: string; profile?: WorkspaceProfileConfig } => {
  const requestedProfile =
    normalizeOptionalString(overrideProfile) ??
    normalizeOptionalString(env.MACHDOCH_PROFILE) ??
    normalizeOptionalString(config.defaultProfile);

  if (!requestedProfile) {
    return {};
  }

  const profile = config.profiles?.[requestedProfile];

  if (!profile) {
    throw new Error(
      `Profile \`${requestedProfile}\` was not found in .machdoch/config.json.`,
    );
  }

  return {
    activeProfile: requestedProfile,
    profile,
  };
};

/**
 * Applies a selected profile's overrides onto the base workspace config.
 */
const mergeProfileIntoConfig = (
  config: WorkspaceConfigFile,
  profile?: WorkspaceProfileConfig,
): WorkspaceConfigFile => {
  if (!profile) {
    return config;
  }

  const compatibility = {
    ...(config.compatibility ?? {}),
    ...(profile.compatibility ?? {}),
  };
  const agentLimits = {
    ...(config.agentLimits ?? {}),
    ...(profile.agentLimits ?? {}),
  };

  return {
    ...config,
    ...(profile.mode ? { defaultMode: profile.mode } : {}),
    ...(profile.provider ? { provider: profile.provider } : {}),
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.reasoning ? { reasoning: profile.reasoning } : {}),
    ...(typeof profile.offline === "boolean"
      ? { offline: profile.offline }
      : {}),
    ...(Object.keys(agentLimits).length > 0 ? { agentLimits } : {}),
    ...(Object.keys(compatibility).length > 0 ? { compatibility } : {}),
  };
};

/**
 * Builds provider availability flags from the loaded environment values.
 */
const getProviderAvailability = (
  env: Record<string, string>,
): ProviderAvailability[] => {
  return [
    ...USER_API_PROVIDERS.map((provider) => ({
      provider,
      configured: hasConfiguredValue(
        env[PROVIDER_ENV_KEY_BY_PROVIDER[provider]],
      ),
    })),
    ...getAgentCliProviders().map((provider) => ({
      provider,
      configured: resolveAgentCliProviderBinary(provider, env).available,
    })),
  ];
};

const getWebSearchProviderAvailability = (
  env: Record<string, string>,
): WebSearchProviderAvailability[] => {
  return [
    {
      provider: "perplexity",
      configured: hasConfiguredValue(env.PERPLEXITY_API_KEY),
    },
    {
      provider: "tavily",
      configured: hasConfiguredValue(env.TAVILY_API_KEY),
    },
    {
      provider: "serper",
      configured: hasConfiguredValue(env.SERPER_API_KEY),
    },
  ];
};

/**
 * Chooses the effective provider, preferring an explicit config override.
 */
const resolveProvider = (
  configuredProvider: WorkspaceConfigFile["provider"],
  availability: ProviderAvailability[],
): ModelProvider => {
  if (isModelProvider(configuredProvider)) {
    return configuredProvider;
  }

  const configuredEntry = availability.find((entry) => entry.configured);

  return configuredEntry?.provider ?? "unconfigured";
};

const resolveWebSearchActiveProvider = (
  configuredProvider: WebSearchProvider,
  env: Record<string, string>,
): WebSearchProvider => {
  const envOverride = normalizeOptionalString(env.MACHDOCH_WEB_SEARCH_PROVIDER);

  if (
    envOverride &&
    VALID_WEB_SEARCH_PROVIDERS.includes(envOverride as WebSearchProvider)
  ) {
    return envOverride as WebSearchProvider;
  }

  return configuredProvider;
};

const parsePositiveIntegerEnv = (
  value: string | undefined,
): number | undefined => {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return Math.max(1, Math.trunc(parsed));
};

const parseAgentLimitsFromEnv = (
  env: Record<string, string>,
): RuntimeAgentLimitOverrides | undefined => {
  const infinite =
    env.MACHDOCH_INFINITE === "true" || env.MACHDOCH_INFINITE === "1";
  const executorTurns = parsePositiveIntegerEnv(env.MACHDOCH_EXECUTOR_TURNS);
  const autopilotExecutorIterations = parsePositiveIntegerEnv(
    env.MACHDOCH_AUTOPILOT_ITERATIONS,
  );
  const limits: RuntimeAgentLimitOverrides = {
    ...(infinite ? { infinite } : {}),
    ...(executorTurns !== undefined ? { executorTurns } : {}),
    ...(autopilotExecutorIterations !== undefined
      ? { autopilotExecutorIterations }
      : {}),
  };

  return Object.keys(limits).length > 0 ? limits : undefined;
};

const getDefaultModelForRuntimeProvider = (provider: ModelProvider): string => {
  return DEFAULT_MODEL_BY_PROVIDER[
    provider === "unconfigured" ? DEFAULT_MODEL_PROVIDER : provider
  ];
};

/**
 * Loads the effective runtime configuration for a workspace, including
 * environment variables, workspace config, profile overrides, and provider
 * availability.
 */
export const loadRuntimeConfig = async (
  workspaceRoot: string,
  overrideMode?: RunMode,
  overrideProfile?: string,
  overrideModel?: string,
  overrideProvider?: Exclude<ModelProvider, "unconfigured">,
  overrideAgentLimits?: RuntimeAgentLimitOverrides,
  overrideReasoning?: ReasoningMode,
): Promise<RuntimeConfig> => {
  const env = await loadWorkspaceEnv(workspaceRoot);
  const userWebSearchSettings = await loadUserWebSearchSettings();
  const userAgentLimitsSettings = await loadUserAgentLimitsSettings();
  const userReviewModelSettings = await loadUserReviewModelSettings();
  const { config, path } = await loadWorkspaceConfigFile(workspaceRoot);
  const availableProfiles = getAvailableProfiles(config.profiles);
  const { activeProfile, profile } = resolveProfile(
    config,
    env,
    overrideProfile,
  );
  const effectiveConfig = mergeProfileIntoConfig(config, profile);
  const providerAvailability = getProviderAvailability(env);
  const webSearchProviderAvailability = getWebSearchProviderAvailability(env);
  const modeFromEnv = isRunMode(env.MACHDOCH_MODE)
    ? env.MACHDOCH_MODE
    : undefined;
  const configuredMode = isRunMode(effectiveConfig.defaultMode)
    ? effectiveConfig.defaultMode
    : undefined;
  const mode =
    overrideMode ?? modeFromEnv ?? configuredMode ?? "machdoch";
  const reasoningFromEnv = isReasoningMode(env.MACHDOCH_REASONING)
    ? env.MACHDOCH_REASONING
    : undefined;
  const configuredReasoning = isReasoningMode(effectiveConfig.reasoning)
    ? effectiveConfig.reasoning
    : undefined;
  const reasoning =
    overrideReasoning ?? reasoningFromEnv ?? configuredReasoning ?? "default";
  const provider = resolveProvider(
    overrideProvider ?? effectiveConfig.provider,
    providerAvailability,
  );
  const model =
    normalizeOptionalString(overrideModel) ??
    effectiveConfig.model ??
    env.MACHDOCH_MODEL ??
    getDefaultModelForRuntimeProvider(provider);
  const offline =
    env.MACHDOCH_OFFLINE === "true" ? true : (effectiveConfig.offline ?? false);
  const agentLimits = normalizeAgentLimitOverrides(
    overrideAgentLimits ??
      parseAgentLimitsFromEnv(env) ??
      effectiveConfig.agentLimits,
    normalizeAgentLimitOverrides(userAgentLimitsSettings),
  );

  return {
    workspaceRoot,
    ...(path ? { workspaceConfigPath: path } : {}),
    userConfigPath: getUserConfigPath(),
    ...(activeProfile ? { activeProfile } : {}),
    availableProfiles,
    mode,
    provider,
    model,
    reasoning,
    offline,
    agentLimits,
    compatibility: {
      discoverGithubCustomizations:
        effectiveConfig.compatibility?.discoverGithubCustomizations ?? false,
    },
    providerAvailability,
    webSearch: {
      activeProvider: resolveWebSearchActiveProvider(
        userWebSearchSettings.activeProvider,
        env,
      ),
      providerAvailability: webSearchProviderAvailability,
    },
    reviewModel: userReviewModelSettings,
  };
};
