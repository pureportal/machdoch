import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeOptionalString } from "../helpers/normalize-optional-string.helper.js";
import {
  assertContextWindowSupportedForProviderModel,
  parseContextWindow,
} from "./context-windows.js";
import { getModelContextWindowTokens } from "./model-capabilities.js";
import { assertReasoningExecutionModeSupportedForProviderModel } from "./reasoning-execution-modes.js";
import { assertReasoningModeSupportedForProviderModel } from "./reasoning-modes.js";
import { withCooperativeFileLock } from "./_helpers/with-cooperative-file-lock.helper.js";
import { writeJsonAtomically } from "./_helpers/write-file-atomically.helper.js";
import { withoutObjectPath } from "./_helpers/without-object-path.helper.js";
import {
  getUserConfigPath,
  hasConfiguredValue,
  loadUserAgentLimitsSettings,
  loadUserInternalTaskModelSettings,
  loadUserReviewModelSettings,
  loadUserWebSearchSettings,
  loadRuntimeEnvironment,
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
  isReasoningExecutionMode,
  isReasoningMode as isRuntimeSchemaReasoningMode,
  USER_API_PROVIDERS,
  VALID_MODEL_PROVIDERS,
  VALID_WEB_SEARCH_PROVIDERS,
  isConfiguredModelProvider,
  isRunMode as isRuntimeSchemaRunMode,
} from "./runtime-contract.generated.js";
import type {
  ModelProvider,
  ProviderAvailability,
  ReasoningExecutionMode,
  ReasoningMode,
  ContextWindow,
  RuntimeAgentLimitOverrides,
  RunMode,
  RuntimeConfig,
  RuntimeInternalTaskModelConfig,
  UserInternalTaskModelSettings,
  WebSearchProvider,
  WebSearchProviderAvailability,
  WorkspaceConfigFile,
} from "./runtime-contract.generated.js";

const WORKSPACE_CONFIG_DIRECTORY = ".machdoch";
const WORKSPACE_CONFIG_FILE_NAME = "config.json";
const WORKSPACE_PROVIDER_DESCRIPTION = VALID_MODEL_PROVIDERS.join(", ");

/**
 * Returns whether a string matches one of the supported runtime modes.
 */
const isRunMode = (value: string | undefined): value is RunMode => {
  return isRuntimeSchemaRunMode(value);
};

const isReasoningMode = (value: string | undefined): value is ReasoningMode => {
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
export const loadWorkspaceConfigFile = async (
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

  await withCooperativeFileLock(configPath, async () => {
    const existingConfig = existsSync(configPath)
      ? (JSON.parse(await readFile(configPath, "utf8")) as WorkspaceConfigFile)
      : {};

    await writeJsonAtomically(configPath, {
      ...existingConfig,
      ...update,
      ...(update.compatibility
        ? {
            compatibility: {
              ...existingConfig.compatibility,
              ...update.compatibility,
            },
          }
        : {}),
    });
  });

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

  await loadRuntimeConfig(workspaceRoot, undefined, normalizedModel);

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
      `Expected workspace.provider to be one of ${WORKSPACE_PROVIDER_DESCRIPTION}.`,
    );
  }

  await loadRuntimeConfig(
    workspaceRoot,
    undefined,
    undefined,
    normalizedProvider,
  );

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
      "Expected workspace.reasoning to be one of default, none, minimal, low, medium, high, xhigh, max, or ultra.",
    );
  }

  await loadRuntimeConfig(
    workspaceRoot,
    undefined,
    undefined,
    undefined,
    undefined,
    normalizedReasoning,
  );

  return saveWorkspaceConfigFile(workspaceRoot, {
    reasoning: normalizedReasoning,
  });
};

export const saveWorkspaceReasoningExecutionMode = async (
  workspaceRoot: string,
  reasoningMode: string,
): Promise<string> => {
  const normalizedReasoningMode = normalizeOptionalString(reasoningMode);

  if (
    !normalizedReasoningMode ||
    !isReasoningExecutionMode(normalizedReasoningMode)
  ) {
    throw new Error(
      "Expected workspace.reasoning-mode to be one of standard or pro.",
    );
  }

  await loadRuntimeConfig(
    workspaceRoot,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    normalizedReasoningMode,
  );

  return saveWorkspaceConfigFile(workspaceRoot, {
    reasoningMode: normalizedReasoningMode,
  });
};

export const saveWorkspaceContextWindow = async (
  workspaceRoot: string,
  contextWindow: string | number,
): Promise<string> => {
  const parsedContextWindow = parseContextWindow(contextWindow);

  if (parsedContextWindow === undefined) {
    throw new Error(
      "Expected workspace.context-window to be default, long, or a positive token count up to 10000000.",
    );
  }

  const runtime = await loadRuntimeConfig(
    workspaceRoot,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    parsedContextWindow,
  );

  if (
    runtime.provider === "unconfigured" &&
    parsedContextWindow !== "default"
  ) {
    throw new Error(
      "Configure a model provider before selecting a non-default context window.",
    );
  }

  return saveWorkspaceConfigFile(workspaceRoot, {
    contextWindow: parsedContextWindow,
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

export const clearWorkspaceConfigValue = async (
  workspaceRoot: string,
  path: readonly string[],
): Promise<string> => {
  const configDirectory = join(workspaceRoot, WORKSPACE_CONFIG_DIRECTORY);
  const configPath = join(configDirectory, WORKSPACE_CONFIG_FILE_NAME);

  await withCooperativeFileLock(configPath, async () => {
    const existingConfig = existsSync(configPath)
      ? (JSON.parse(await readFile(configPath, "utf8")) as WorkspaceConfigFile)
      : {};
    await writeJsonAtomically(
      configPath,
      withoutObjectPath(existingConfig, path),
    );
  });

  return configPath;
};

export const saveWorkspaceGithubCustomizations = async (
  workspaceRoot: string,
  enabled: boolean,
): Promise<string> => {
  return saveWorkspaceConfigFile(workspaceRoot, {
    compatibility: {
      discoverGithubCustomizations: enabled,
    },
  });
};

/**
 * Builds provider availability flags from the loaded environment values.
 */
const getProviderAvailability = (
  env: Record<string, string>,
): ProviderAvailability[] => {
  const apiProviderAvailability: ProviderAvailability[] = [];

  for (const provider of USER_API_PROVIDERS) {
    if (!isConfiguredModelProvider(provider)) {
      continue;
    }

    apiProviderAvailability.push({
      provider,
      configured: hasConfiguredValue(
        env[PROVIDER_ENV_KEY_BY_PROVIDER[provider]],
      ),
    });
  }

  return [
    ...apiProviderAvailability,
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

const resolveInternalTaskModel = (
  settings: UserInternalTaskModelSettings,
  availability: ProviderAvailability[],
): RuntimeInternalTaskModelConfig => {
  const savedProvider = settings.provider;
  const provider =
    savedProvider &&
    availability.some(
      (entry) => entry.provider === savedProvider && entry.configured,
    )
      ? savedProvider
      : (availability.find((entry) => entry.configured)?.provider ??
        "unconfigured");
  const savedModel = normalizeOptionalString(settings.model);

  return {
    provider,
    model:
      provider === savedProvider && savedModel
        ? savedModel
        : getDefaultModelForRuntimeProvider(provider),
  };
};

/**
 * Loads the effective runtime configuration for a workspace, including
 * environment variables, workspace config, and provider availability.
 */
export const loadRuntimeConfig = async (
  workspaceRoot: string,
  overrideMode?: RunMode,
  overrideModel?: string,
  overrideProvider?: Exclude<ModelProvider, "unconfigured">,
  overrideAgentLimits?: RuntimeAgentLimitOverrides,
  overrideReasoning?: ReasoningMode,
  overrideContextWindow?: ContextWindow,
  overrideReasoningExecutionMode?: ReasoningExecutionMode,
): Promise<RuntimeConfig> => {
  const env = await loadRuntimeEnvironment();
  const userWebSearchSettings = await loadUserWebSearchSettings();
  const userAgentLimitsSettings = await loadUserAgentLimitsSettings();
  const userReviewModelSettings = await loadUserReviewModelSettings();
  const userInternalTaskModelSettings =
    await loadUserInternalTaskModelSettings();
  const { config, path } = await loadWorkspaceConfigFile(workspaceRoot);
  const providerAvailability = getProviderAvailability(env);
  const webSearchProviderAvailability = getWebSearchProviderAvailability(env);
  const modeFromEnv = isRunMode(env.MACHDOCH_MODE)
    ? env.MACHDOCH_MODE
    : undefined;
  const configuredMode = isRunMode(config.defaultMode)
    ? config.defaultMode
    : undefined;
  const mode = overrideMode ?? modeFromEnv ?? configuredMode ?? "machdoch";
  const rawReasoningFromEnv = normalizeOptionalString(env.MACHDOCH_REASONING);
  const reasoningFromEnv = isReasoningMode(rawReasoningFromEnv)
    ? rawReasoningFromEnv
    : undefined;

  if (rawReasoningFromEnv && reasoningFromEnv === undefined) {
    throw new Error(
      "MACHDOCH_REASONING must be default, none, minimal, low, medium, high, xhigh, max, or ultra.",
    );
  }

  const configuredReasoning = isReasoningMode(config.reasoning)
    ? config.reasoning
    : undefined;

  if (
    overrideReasoning === undefined &&
    config.reasoning !== undefined &&
    configuredReasoning === undefined
  ) {
    throw new Error(
      "workspace.reasoning must be default, none, minimal, low, medium, high, xhigh, max, or ultra.",
    );
  }
  const reasoning =
    overrideReasoning ?? reasoningFromEnv ?? configuredReasoning ?? "default";
  const rawReasoningModeFromEnv = normalizeOptionalString(
    env.MACHDOCH_REASONING_MODE,
  );
  const reasoningModeFromEnv = isReasoningExecutionMode(rawReasoningModeFromEnv)
    ? rawReasoningModeFromEnv
    : undefined;

  if (rawReasoningModeFromEnv && reasoningModeFromEnv === undefined) {
    throw new Error("MACHDOCH_REASONING_MODE must be standard or pro.");
  }

  const configuredReasoningMode = isReasoningExecutionMode(config.reasoningMode)
    ? config.reasoningMode
    : undefined;

  if (
    overrideReasoningExecutionMode === undefined &&
    config.reasoningMode !== undefined &&
    configuredReasoningMode === undefined
  ) {
    throw new Error("workspace.reasoningMode must be standard or pro.");
  }

  const reasoningMode =
    overrideReasoningExecutionMode ??
    reasoningModeFromEnv ??
    configuredReasoningMode ??
    "standard";
  const rawContextWindowFromEnv = normalizeOptionalString(
    env.MACHDOCH_CONTEXT_WINDOW,
  );
  const contextWindowFromEnv = parseContextWindow(rawContextWindowFromEnv);

  if (rawContextWindowFromEnv && contextWindowFromEnv === undefined) {
    throw new Error(
      "MACHDOCH_CONTEXT_WINDOW must be default, long, or a positive token count up to 10000000.",
    );
  }

  const configuredContextWindow = parseContextWindow(config.contextWindow);

  if (
    overrideContextWindow === undefined &&
    config.contextWindow !== undefined &&
    configuredContextWindow === undefined
  ) {
    throw new Error(
      "workspace.contextWindow must be default, long, or a positive token count up to 10000000.",
    );
  }

  const contextWindow: ContextWindow =
    overrideContextWindow ??
    contextWindowFromEnv ??
    configuredContextWindow ??
    "default";
  const provider = resolveProvider(
    overrideProvider ?? config.provider,
    providerAvailability,
  );
  const model =
    normalizeOptionalString(overrideModel) ??
    normalizeOptionalString(env.MACHDOCH_MODEL) ??
    config.model ??
    getDefaultModelForRuntimeProvider(provider);

  if (provider !== "unconfigured") {
    assertReasoningModeSupportedForProviderModel(reasoning, provider, model);
    assertReasoningExecutionModeSupportedForProviderModel(
      reasoningMode,
      provider,
      model,
    );
    assertContextWindowSupportedForProviderModel(
      contextWindow,
      provider,
      model,
      getModelContextWindowTokens(provider, model),
    );
  }

  const offline =
    env.MACHDOCH_OFFLINE === "true" ? true : (config.offline ?? false);
  const agentLimits = normalizeAgentLimitOverrides(
    overrideAgentLimits ?? parseAgentLimitsFromEnv(env) ?? config.agentLimits,
    normalizeAgentLimitOverrides(userAgentLimitsSettings),
  );

  return {
    workspaceRoot,
    ...(path ? { workspaceConfigPath: path } : {}),
    userConfigPath: getUserConfigPath(),
    mode,
    provider,
    model,
    reasoning,
    reasoningMode,
    contextWindow,
    offline,
    agentLimits,
    compatibility: {
      discoverGithubCustomizations:
        config.compatibility?.discoverGithubCustomizations ?? false,
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
    internalTaskModel: resolveInternalTaskModel(
      userInternalTaskModelSettings,
      providerAvailability,
    ),
  };
};
