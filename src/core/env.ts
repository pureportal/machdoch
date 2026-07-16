import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeOptionalString } from "../helpers/normalize-optional-string.helper.js";
import { withCooperativeFileLock } from "./_helpers/with-cooperative-file-lock.helper.js";
import { writeJsonAtomically } from "./_helpers/write-file-atomically.helper.js";
import {
  MAX_GLOBAL_MEMORY_ENTRIES,
  normalizeConversationMemoryEntries,
  rememberConversationMemoryEntry,
} from "./memory.js";
import {
  DEFAULT_MAX_AUTOPILOT_EXECUTOR_ITERATIONS,
  DEFAULT_MAX_EXECUTOR_TURNS,
} from "./_helpers/agent-runtime-types.js";
import {
  AGENT_CLI_PROVIDER_ENV_KEY_BY_PROVIDER,
  DEFAULT_USER_REVIEW_MODEL_SETTINGS,
  PROVIDER_ENV_KEY_BY_PROVIDER,
  RUNTIME_ENV_KEYS,
  USER_API_PROVIDERS as SCHEMA_USER_API_PROVIDERS,
  USER_WEB_SEARCH_PROVIDERS,
  WEB_SEARCH_ENV_KEY_BY_PROVIDER,
  isConfiguredModelProvider,
  isUserApiProvider as isSchemaUserApiProvider,
  isRuntimeContractValue,
  isUserWebSearchProvider as isSchemaUserWebSearchProvider,
  isVoiceAiProvider,
  isWebSearchProvider as isSchemaWebSearchProvider,
  USER_REVIEW_MODEL_MODES,
} from "./runtime-contract.generated.js";
import type {
  ConfiguredModelProvider,
  SpeechToTextProvider,
  AgentCliProvider,
  UserAgentLimitsSettings as SharedUserAgentLimitsSettings,
  UserAgentCliPaths as SharedUserAgentCliPaths,
  UserConfigFile as SharedUserConfigFile,
  UserDesktopSettings,
  UserApiProvider,
  UserReviewModelSettings as SharedUserReviewModelSettings,
  UserReviewModelMode,
  VoiceAiProvider,
} from "./runtime-contract.generated.js";
import type { ConversationMemoryEntry } from "./types.js";
import type {
  ProviderAvailability,
  RuntimeAgentLimitOverrides,
  WebSearchProvider,
  WebSearchProviderAvailability,
} from "./runtime-contract.generated.js";

const PLACEHOLDER_TOKENS = ["YOUR_", "CHANGE_ME", "PLACEHOLDER"];
const KNOWN_SAMPLE_SECRET_VALUES = new Set([
  "sk-user-config",
  "sk-live",
  "pplx-live",
  "tvly-live",
  "tavily-live",
  "serper-live",
]);
const USER_CONFIG_FILE_NAME = "user-config.json";
const WORKSPACE_ENV_FILE_NAME = ".env";
export type UserWebSearchProvider = Exclude<WebSearchProvider, "none">;
export type UserAgentCliPaths = SharedUserAgentCliPaths;
const USER_API_PROVIDERS = SCHEMA_USER_API_PROVIDERS;
const USER_API_PROVIDER_DESCRIPTION = USER_API_PROVIDERS.join(", ");
const TRUSTED_AGENT_CLI_ENV_KEYS = new Set<string>(
  Object.values(AGENT_CLI_PROVIDER_ENV_KEY_BY_PROVIDER),
);

export type UserAgentLimitsSettings = SharedUserAgentLimitsSettings;
export type UserReviewModelSettings = SharedUserReviewModelSettings;
type UserConfigFile = SharedUserConfigFile;

const stripWrappingQuotes = (value: string): string => {
  const trimmed = value.trim();

  if (trimmed.length >= 2) {
    const wrappedInSingleQuotes =
      trimmed.startsWith("'") && trimmed.endsWith("'");
    const wrappedInDoubleQuotes =
      trimmed.startsWith('"') && trimmed.endsWith('"');

    if (wrappedInSingleQuotes || wrappedInDoubleQuotes) {
      return trimmed.slice(1, -1);
    }
  }

  return trimmed;
};

const parseDotEnvFile = async (
  filePath: string,
): Promise<Record<string, string>> => {
  const raw = await readFile(filePath, "utf8");
  const values: Record<string, string> = {};

  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalizeOptionalString(trimmed.slice(0, separatorIndex));
    const value = normalizeOptionalString(
      stripWrappingQuotes(trimmed.slice(separatorIndex + 1)),
    );

    if (!key || !value) {
      continue;
    }

    values[key] = value;
  }

  return values;
};

/**
 * Returns whether a provider id is supported by the user API config file.
 */
const isUserApiProvider = (value: string): value is UserApiProvider => {
  return isSchemaUserApiProvider(value);
};

const isAgentCliProvider = (value: string): value is AgentCliProvider => {
  return Object.prototype.hasOwnProperty.call(
    AGENT_CLI_PROVIDER_ENV_KEY_BY_PROVIDER,
    value,
  );
};

const isExistingFile = (path: string): boolean => {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
};

const isWebSearchProvider = (value: string): value is WebSearchProvider => {
  return isSchemaWebSearchProvider(value);
};

const isUserWebSearchProvider = (
  value: string,
): value is UserWebSearchProvider => {
  return isSchemaUserWebSearchProvider(value);
};

const normalizePositiveIntegerSetting = (
  value: unknown,
  fallback: number,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.max(1, Math.trunc(value));
};

const normalizeUserAgentLimitsSettings = (
  settings: RuntimeAgentLimitOverrides | undefined,
): UserAgentLimitsSettings => {
  return {
    infinite: settings?.infinite === true,
    executorTurns: normalizePositiveIntegerSetting(
      settings?.executorTurns,
      DEFAULT_MAX_EXECUTOR_TURNS,
    ),
    autopilotExecutorIterations: normalizePositiveIntegerSetting(
      settings?.autopilotExecutorIterations,
      DEFAULT_MAX_AUTOPILOT_EXECUTOR_ITERATIONS,
    ),
  };
};

const isUserReviewModelMode = (
  value: string | undefined,
): value is UserReviewModelMode => {
  return isRuntimeContractValue(USER_REVIEW_MODEL_MODES, value);
};

const normalizeUserReviewModelSettings = (
  settings: Partial<UserReviewModelSettings> | undefined,
): UserReviewModelSettings => {
  const mode = isUserReviewModelMode(settings?.mode)
    ? settings.mode
    : DEFAULT_USER_REVIEW_MODEL_SETTINGS.mode;
  const provider = normalizeOptionalString(settings?.provider);
  const model = normalizeOptionalString(settings?.model);

  if (
    mode !== "dedicated" ||
    !provider ||
    !isConfiguredModelProvider(provider) ||
    !model
  ) {
    return { mode: "base" };
  }

  return {
    mode: "dedicated",
    provider: provider as ConfiguredModelProvider,
    model,
  };
};

/**
 * Returns the cross-platform directory used for user-scoped Machdoch config.
 */
const getUserConfigDirectory = (): string => {
  const overrideDirectory = normalizeOptionalString(
    process.env.MACHDOCH_USER_CONFIG_DIR,
  );

  if (overrideDirectory) {
    return overrideDirectory;
  }

  if (process.platform === "win32") {
    return join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "machdoch",
    );
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "machdoch");
  }

  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "machdoch",
  );
};

/**
 * Returns the absolute path of the user-scoped Machdoch config file.
 */
export const getUserConfigPath = (): string => {
  return join(getUserConfigDirectory(), USER_CONFIG_FILE_NAME);
};

/**
 * Loads runtime-only environment overrides from the current process.
 */
export const loadProcessEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};

  for (const key of RUNTIME_ENV_KEYS) {
    const value = normalizeOptionalString(process.env[key]);

    if (value) {
      env[key] = value;
    }
  }

  return env;
};

/**
 * Loads the effective workspace environment by combining user-scoped provider
 * keys, workspace `.env` values, and current-process overrides.
 */
export const loadWorkspaceEnv = async (
  workspaceRoot: string,
): Promise<Record<string, string>> => {
  const env: Record<string, string> = {};
  const userApiKeys = await loadUserApiKeys();
  const userAgentCliPaths = await loadUserAgentCliPaths();
  const userWebSearchApiKeys = await loadUserWebSearchApiKeys();

  for (const [provider, key] of Object.entries(userApiKeys)) {
    if (
      isUserApiProvider(provider) &&
      typeof key === "string" &&
      key.trim().length > 0
    ) {
      env[PROVIDER_ENV_KEY_BY_PROVIDER[provider]] = key.trim();
    }
  }

  for (const [provider, binaryPath] of Object.entries(userAgentCliPaths)) {
    if (
      isAgentCliProvider(provider) &&
      typeof binaryPath === "string" &&
      binaryPath.trim().length > 0
    ) {
      env[AGENT_CLI_PROVIDER_ENV_KEY_BY_PROVIDER[provider]] =
        binaryPath.trim();
    }
  }

  for (const [provider, key] of Object.entries(userWebSearchApiKeys)) {
    if (
      isUserWebSearchProvider(provider) &&
      typeof key === "string" &&
      key.trim().length > 0
    ) {
      env[WEB_SEARCH_ENV_KEY_BY_PROVIDER[provider]] = key.trim();
    }
  }

  const workspaceEnvPath = join(workspaceRoot, WORKSPACE_ENV_FILE_NAME);

  if (existsSync(workspaceEnvPath)) {
    const workspaceEnv = await parseDotEnvFile(workspaceEnvPath);

    for (const [key, value] of Object.entries(workspaceEnv)) {
      if (!TRUSTED_AGENT_CLI_ENV_KEYS.has(key)) {
        env[key] = value;
      }
    }
  }

  for (const key of [
    ...Object.keys(env),
    ...RUNTIME_ENV_KEYS,
    ...Object.values(PROVIDER_ENV_KEY_BY_PROVIDER),
    ...Object.values(WEB_SEARCH_ENV_KEY_BY_PROVIDER),
  ]) {
    const value = normalizeOptionalString(process.env[key]);

    if (value) {
      env[key] = value;
    }
  }

  return env;
};

/**
 * Reads the user-scoped Machdoch config file when present.
 */
const loadUserConfigFile = async (): Promise<{
  config: UserConfigFile;
  path: string;
}> => {
  const configPath = getUserConfigPath();

  if (!existsSync(configPath)) {
    return {
      config: {},
      path: configPath,
    };
  }

  const raw = await readFile(configPath, "utf8");

  return {
    config: JSON.parse(raw) as UserConfigFile,
    path: configPath,
  };
};

const updateUserConfigFile = async (
  update: (config: UserConfigFile) => UserConfigFile,
): Promise<string> => {
  const path = getUserConfigPath();

  await withCooperativeFileLock(path, async () => {
    const { config } = await loadUserConfigFile();
    await writeJsonAtomically(path, update(config));
  });

  return path;
};

/**
 * Loads the configured provider API keys from the user-scoped config file.
 */
export const loadUserApiKeys = async (): Promise<
  Partial<Record<UserApiProvider, string>>
> => {
  const { config } = await loadUserConfigFile();
  const apiKeys = config.apiKeys ?? {};

  return Object.fromEntries(
    Object.entries(apiKeys)
      .filter(
        (entry): entry is [UserApiProvider, string] =>
          isUserApiProvider(entry[0]) &&
          typeof entry[1] === "string" &&
          hasConfiguredValue(entry[1]),
      )
      .map(([provider, value]) => [provider, value.trim()]),
  );
};

export const loadUserAgentCliPaths = async (): Promise<UserAgentCliPaths> => {
  const { config } = await loadUserConfigFile();
  const paths = config.agentCliPaths ?? {};

  return Object.fromEntries(
    Object.entries(paths)
      .filter(
        (entry): entry is [AgentCliProvider, string] =>
          isAgentCliProvider(entry[0]) &&
          typeof entry[1] === "string" &&
          entry[1].trim().length > 0,
      )
      .map(([provider, value]) => [provider, value.trim()]),
  );
};

/**
 * Loads the configured web-search API keys from the user-scoped config file.
 */
export const loadUserWebSearchApiKeys = async (): Promise<
  Partial<Record<UserWebSearchProvider, string>>
> => {
  const { config } = await loadUserConfigFile();
  const apiKeys = config.webSearch?.apiKeys ?? {};

  return Object.fromEntries(
    Object.entries(apiKeys)
      .filter(
        (entry): entry is [UserWebSearchProvider, string] =>
          isUserWebSearchProvider(entry[0]) &&
          typeof entry[1] === "string" &&
          hasConfiguredValue(entry[1]),
      )
      .map(([provider, value]) => [provider, value.trim()]),
  );
};

/**
 * Saves a provider API key into the user-scoped config file.
 */
export const saveUserApiKey = async (
  provider: UserApiProvider,
  apiKey: string,
): Promise<string> => {
  const normalizedProvider = normalizeOptionalString(provider);
  const normalizedApiKey = normalizeOptionalString(apiKey);

  if (!normalizedProvider || !isUserApiProvider(normalizedProvider)) {
    throw new Error(
      `Expected --provider to be one of ${USER_API_PROVIDER_DESCRIPTION}.`,
    );
  }

  if (!normalizedApiKey) {
    throw new Error("Expected a non-empty API key.");
  }

  return updateUserConfigFile((config) => ({
    ...config,
    apiKeys: {
      ...(config.apiKeys ?? {}),
      [normalizedProvider]: normalizedApiKey,
    },
  }));
};

export const saveUserAgentCliPath = async (
  provider: AgentCliProvider,
  binaryPath: string,
): Promise<string> => {
  const normalizedProvider = normalizeOptionalString(provider);
  const normalizedBinaryPath = normalizeOptionalString(binaryPath);

  if (!normalizedProvider || !isAgentCliProvider(normalizedProvider)) {
    throw new Error(
      "Expected provider to be one of codex-cli, claude-cli, or copilot-cli.",
    );
  }

  if (!normalizedBinaryPath) {
    throw new Error("Expected a non-empty CLI binary path.");
  }

  if (!isExistingFile(normalizedBinaryPath)) {
    throw new Error(
      `Expected ${normalizedBinaryPath} to point to an existing CLI binary file.`,
    );
  }

  return updateUserConfigFile((config) => ({
    ...config,
    agentCliPaths: {
      ...(config.agentCliPaths ?? {}),
      [normalizedProvider]: normalizedBinaryPath,
    },
  }));
};

/**
 * Saves a web-search provider API key into the user-scoped config file.
 */
export const saveUserWebSearchApiKey = async (
  provider: UserWebSearchProvider,
  apiKey: string,
): Promise<string> => {
  const normalizedProvider = normalizeOptionalString(provider);
  const normalizedApiKey = normalizeOptionalString(apiKey);

  if (!normalizedProvider || !isUserWebSearchProvider(normalizedProvider)) {
    throw new Error(
      "Expected provider to be one of perplexity, tavily, or serper.",
    );
  }

  if (!normalizedApiKey) {
    throw new Error("Expected a non-empty API key.");
  }

  return updateUserConfigFile((config) => ({
    ...config,
    webSearch: {
      ...(config.webSearch ?? {}),
      apiKeys: {
        ...(config.webSearch?.apiKeys ?? {}),
        [normalizedProvider]: normalizedApiKey,
      },
    },
  }));
};

/**
 * Persists the active web-search provider into the user-scoped config file.
 */
export const saveUserWebSearchActiveProvider = async (
  provider: WebSearchProvider,
): Promise<string> => {
  if (!isWebSearchProvider(provider)) {
    throw new Error(
      "Expected the active web search provider to be one of none, perplexity, tavily, or serper.",
    );
  }

  return updateUserConfigFile((config) => ({
    ...config,
    webSearch: {
      ...(config.webSearch ?? {}),
      activeProvider: provider,
    },
  }));
};

export const saveUserVoiceActiveProvider = async (
  provider: VoiceAiProvider,
): Promise<string> => {
  if (!isVoiceAiProvider(provider)) {
    throw new Error("Expected voice.provider to be one of none, openai, or google.");
  }

  return updateUserConfigFile((config) => ({
    ...config,
    voice: {
      ...(config.voice ?? {}),
      activeProvider: provider,
    },
  }));
};

export const saveUserSpeechToTextActiveProvider = async (
  provider: SpeechToTextProvider,
): Promise<string> => {
  if (!isVoiceAiProvider(provider)) {
    throw new Error(
      "Expected speech-to-text.provider to be one of none, openai, or google.",
    );
  }

  return updateUserConfigFile((config) => ({
    ...config,
    speechToText: {
      ...(config.speechToText ?? {}),
      activeProvider: provider,
    },
  }));
};

export const saveUserSpeechToTextInputDevice = async (
  inputDeviceId: string | null,
): Promise<string> => {
  const normalizedInputDeviceId = normalizeOptionalString(inputDeviceId) ?? null;

  return updateUserConfigFile((config) => {
    const speechToText = {
      ...(config.speechToText ?? {}),
    };

    if (normalizedInputDeviceId) {
      speechToText.inputDeviceId = normalizedInputDeviceId;
    } else {
      delete speechToText.inputDeviceId;
    }

    return {
      ...config,
      speechToText,
    };
  });
};

export const saveUserDesktopSettingsPatch = async (
  settings: Partial<UserDesktopSettings>,
): Promise<string> => {
  return updateUserConfigFile((config) => ({
    ...config,
    desktop: {
      ...(config.desktop ?? {}),
      ...settings,
    },
  }));
};

/**
 * Returns provider availability derived from the user-scoped config file.
 */
export const getUserProviderAvailability = async (): Promise<
  ProviderAvailability[]
> => {
  const apiKeys = await loadUserApiKeys();
  const availability: ProviderAvailability[] = [];

  for (const provider of USER_API_PROVIDERS) {
    if (!isConfiguredModelProvider(provider)) {
      continue;
    }

    availability.push({
      provider,
      configured: hasConfiguredValue(apiKeys[provider]),
    });
  }

  return availability;
};

/**
 * Returns web-search provider availability derived from the user-scoped config file.
 */
export const getUserWebSearchProviderAvailability = async (): Promise<
  WebSearchProviderAvailability[]
> => {
  const apiKeys = await loadUserWebSearchApiKeys();

  return USER_WEB_SEARCH_PROVIDERS.map((provider) => ({
    provider,
    configured: hasConfiguredValue(apiKeys[provider]),
  }));
};

/**
 * Loads the saved user-scoped web-search settings.
 */
export const loadUserWebSearchSettings = async (): Promise<{
  activeProvider: WebSearchProvider;
  apiKeys: Partial<Record<UserWebSearchProvider, string>>;
  providerAvailability: WebSearchProviderAvailability[];
}> => {
  const { config } = await loadUserConfigFile();
  const activeProvider = isWebSearchProvider(
    config.webSearch?.activeProvider ?? "none",
  )
    ? (config.webSearch?.activeProvider ?? "none")
    : "none";
  const apiKeys = await loadUserWebSearchApiKeys();

  return {
    activeProvider,
    apiKeys,
    providerAvailability: await getUserWebSearchProviderAvailability(),
  };
};

/**
 * Loads saved user-scoped agent loop limit settings.
 */
export const loadUserAgentLimitsSettings =
  async (): Promise<UserAgentLimitsSettings> => {
    const { config } = await loadUserConfigFile();

    return normalizeUserAgentLimitsSettings(config.agentLimits);
  };

/**
 * Persists user-scoped agent loop limit settings.
 */
export const saveUserAgentLimitsSettings = async (
  settings: UserAgentLimitsSettings,
): Promise<string> => {
  const normalizedSettings = normalizeUserAgentLimitsSettings(settings);

  return updateUserConfigFile((config) => ({
    ...config,
    agentLimits: normalizedSettings,
  }));
};

/**
 * Loads the saved model selection for short validator and memory-manager passes.
 */
export const loadUserReviewModelSettings =
  async (): Promise<UserReviewModelSettings> => {
    const { config } = await loadUserConfigFile();

    return normalizeUserReviewModelSettings(config.reviewModel);
  };

/**
 * Persists the model selection for short validator and memory-manager passes.
 */
export const saveUserReviewModelSettings = async (
  settings: UserReviewModelSettings,
): Promise<string> => {
  const normalizedSettings = normalizeUserReviewModelSettings(settings);

  return updateUserConfigFile((config) => ({
    ...config,
    reviewModel: normalizedSettings,
  }));
};

/**
 * Loads the saved cross-session global memory settings.
 */
export const loadUserMemorySettings = async (): Promise<{
  globalEnabled: boolean;
  entries: ConversationMemoryEntry[];
}> => {
  const { config } = await loadUserConfigFile();

  return {
    globalEnabled: config.memory?.globalEnabled === true,
    entries: normalizeConversationMemoryEntries(
      config.memory?.entries,
      "global",
    ),
  };
};

/**
 * Persists whether cross-session global memory is enabled.
 */
export const saveUserGlobalMemoryEnabled = async (
  enabled: boolean,
): Promise<string> => {
  return updateUserConfigFile((config) => ({
    ...config,
    memory: {
      ...(config.memory ?? {}),
      globalEnabled: enabled,
      entries: normalizeConversationMemoryEntries(
        config.memory?.entries,
        "global",
      ),
    },
  }));
};

/**
 * Appends or refreshes a durable cross-session memory entry.
 */
export const rememberUserGlobalMemory = async (
  content: string,
): Promise<ConversationMemoryEntry> => {
  let rememberedEntry: ConversationMemoryEntry | undefined;

  await updateUserConfigFile((config) => {
    const normalizedEntries = normalizeConversationMemoryEntries(
      config.memory?.entries,
      "global",
    );
    const remembered = rememberConversationMemoryEntry(
      normalizedEntries,
      "global",
      content,
      MAX_GLOBAL_MEMORY_ENTRIES,
    );
    rememberedEntry = remembered.entry;

    return {
      ...config,
      memory: {
        ...(config.memory ?? {}),
        globalEnabled: config.memory?.globalEnabled === true,
        entries: remembered.entries,
      },
    };
  });

  if (!rememberedEntry) {
    throw new Error("The memory entry could not be persisted.");
  }

  return rememberedEntry;
};

/**
 * Returns whether a configuration value looks usable instead of empty or a
 * placeholder token.
 */
export const hasConfiguredValue = (value: string | undefined): boolean => {
  if (!value) {
    return false;
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return false;
  }

  if (KNOWN_SAMPLE_SECRET_VALUES.has(trimmed)) {
    return false;
  }

  return !PLACEHOLDER_TOKENS.some((token) => trimmed.includes(token));
};
