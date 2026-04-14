import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderAvailability } from "./types.js";

const PLACEHOLDER_TOKENS = ["YOUR_", "CHANGE_ME", "PLACEHOLDER"];
const USER_CONFIG_FILE_NAME = "user-config.json";
const RUNTIME_ENV_KEYS = [
  "MACHDOCH_MODE",
  "MACHDOCH_MODEL",
  "MACHDOCH_OFFLINE",
  "MACHDOCH_PROFILE",
] as const;
const USER_API_PROVIDERS: ProviderAvailability["provider"][] = [
  "openai",
  "anthropic",
  "google",
];

interface UserConfigFile {
  apiKeys?: Partial<Record<ProviderAvailability["provider"], string>>;
}

/**
 * Trims a string and collapses empty input to `undefined`.
 */
const normalizeOptionalString = (
  value: string | undefined,
): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Returns whether a provider id is supported by the user API config file.
 */
const isUserApiProvider = (
  value: string,
): value is ProviderAvailability["provider"] => {
  return USER_API_PROVIDERS.includes(value as ProviderAvailability["provider"]);
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

/**
 * Loads the configured provider API keys from the user-scoped config file.
 */
export const loadUserApiKeys = async (): Promise<
  Partial<Record<ProviderAvailability["provider"], string>>
> => {
  const { config } = await loadUserConfigFile();
  const apiKeys = config.apiKeys ?? {};

  return Object.fromEntries(
    Object.entries(apiKeys)
      .filter(
        (entry): entry is [ProviderAvailability["provider"], string] =>
          isUserApiProvider(entry[0]) && typeof entry[1] === "string",
      )
      .map(([provider, value]) => [provider, value.trim()]),
  );
};

/**
 * Saves a provider API key into the user-scoped config file.
 */
export const saveUserApiKey = async (
  provider: ProviderAvailability["provider"],
  apiKey: string,
): Promise<string> => {
  const normalizedProvider = normalizeOptionalString(provider);
  const normalizedApiKey = normalizeOptionalString(apiKey);

  if (!normalizedProvider || !isUserApiProvider(normalizedProvider)) {
    throw new Error("Expected --provider to be one of openai, anthropic, or google.");
  }

  if (!normalizedApiKey) {
    throw new Error("Expected a non-empty API key.");
  }

  const { config, path } = await loadUserConfigFile();

  await mkdir(getUserConfigDirectory(), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        ...config,
        apiKeys: {
          ...(config.apiKeys ?? {}),
          [normalizedProvider]: normalizedApiKey,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return path;
};

/**
 * Returns provider availability derived from the user-scoped config file.
 */
export const getUserProviderAvailability = async (): Promise<
  ProviderAvailability[]
> => {
  const apiKeys = await loadUserApiKeys();

  return USER_API_PROVIDERS.map((provider) => ({
    provider,
    configured: hasConfiguredValue(apiKeys[provider]),
  }));
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

  return !PLACEHOLDER_TOKENS.some((token) => trimmed.includes(token));
};
