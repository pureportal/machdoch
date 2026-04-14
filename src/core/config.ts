import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getUserProviderAvailability, loadProcessEnv } from "./env.js";
import type {
  ModelProvider,
  ProviderAvailability,
  RunMode,
  RuntimeConfig,
  RuntimeProfileSummary,
  ToolName,
  WorkspaceConfigFile,
  WorkspaceProfileConfig,
} from "./types.js";

const VALID_MODES: RunMode[] = ["safe", "ask", "auto"];
const VALID_TOOLS: ToolName[] = [
  "filesystem",
  "shell",
  "network",
  "browser",
  "git",
  "packages",
];

const DEFAULT_TOOLS: ToolName[] = ["filesystem", "shell"];
const DEFAULT_MODEL = "gpt-5.4-mini";

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
 * Returns whether a string matches one of the supported runtime modes.
 */
const isRunMode = (value: string | undefined): value is RunMode => {
  return value !== undefined && VALID_MODES.includes(value as RunMode);
};

/**
 * Normalizes configured tool names and falls back to the default tool set.
 */
const normalizeTools = (tools: unknown): ToolName[] => {
  if (!Array.isArray(tools)) {
    return DEFAULT_TOOLS;
  }

  const normalized = tools.filter(
    (tool): tool is ToolName =>
      typeof tool === "string" && VALID_TOOLS.includes(tool as ToolName),
  );

  return normalized.length > 0 ? normalized : DEFAULT_TOOLS;
};

/**
 * Reads `.machdoch/config.json` when present and returns its parsed contents.
 */
const loadWorkspaceConfigFile = async (
  workspaceRoot: string,
): Promise<{ config: WorkspaceConfigFile; path?: string }> => {
  const configPath = join(workspaceRoot, ".machdoch", "config.json");

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

  return {
    ...config,
    ...(profile.mode ? { defaultMode: profile.mode } : {}),
    ...(profile.enabledTools ? { enabledTools: profile.enabledTools } : {}),
    ...(profile.provider ? { provider: profile.provider } : {}),
    ...(profile.model ? { model: profile.model } : {}),
    ...(typeof profile.offline === "boolean"
      ? { offline: profile.offline }
      : {}),
    ...(Object.keys(compatibility).length > 0 ? { compatibility } : {}),
  };
};

/**
 * Builds provider availability flags from the loaded environment values.
 */
/**
 * Chooses the effective provider, preferring an explicit config override.
 */
const resolveProvider = (
  configuredProvider: WorkspaceConfigFile["provider"],
  availability: ProviderAvailability[],
): ModelProvider => {
  if (configuredProvider) {
    return configuredProvider;
  }

  const configuredEntry = availability.find((entry) => entry.configured);
  if (!configuredEntry) {
    if (process.env.NODE_ENV !== "test") {
      console.warn(
        "No provider API keys are configured in the Machdoch user config file. " +
          "Use the desktop provider setup or `machdoch --set-api --provider <name> --key <value>`.",
      );
    }
  }
  return configuredEntry?.provider ?? "unconfigured";
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
): Promise<RuntimeConfig> => {
  const env = loadProcessEnv();
  const { config, path } = await loadWorkspaceConfigFile(workspaceRoot);
  const availableProfiles = getAvailableProfiles(config.profiles);
  const { activeProfile, profile } = resolveProfile(
    config,
    env,
    overrideProfile,
  );
  const effectiveConfig = mergeProfileIntoConfig(config, profile);
  const providerAvailability = await getUserProviderAvailability();
  const modeFromEnv = isRunMode(env.MACHDOCH_MODE)
    ? env.MACHDOCH_MODE
    : undefined;
  const mode =
    overrideMode ?? modeFromEnv ?? effectiveConfig.defaultMode ?? "ask";
  const provider = resolveProvider(
    effectiveConfig.provider,
    providerAvailability,
  );
  const model =
    normalizeOptionalString(overrideModel) ??
    effectiveConfig.model ??
    env.MACHDOCH_MODEL ??
    DEFAULT_MODEL;
  const offline =
    env.MACHDOCH_OFFLINE === "true" ? true : (effectiveConfig.offline ?? false);

  return {
    workspaceRoot,
    ...(path ? { workspaceConfigPath: path } : {}),
    ...(activeProfile ? { activeProfile } : {}),
    availableProfiles,
    mode,
    enabledTools: normalizeTools(effectiveConfig.enabledTools),
    provider,
    model,
    offline,
    compatibility: {
      discoverGithubCustomizations:
        effectiveConfig.compatibility?.discoverGithubCustomizations ?? false,
    },
    providerAvailability,
  };
};

/**
 * Persists the workspace default model to `.machdoch/config.json`.
 */
export const saveWorkspaceDefaultModel = async (
  workspaceRoot: string,
  model: string,
): Promise<string> => {
  const normalizedModel = normalizeOptionalString(model);

  if (!normalizedModel) {
    throw new Error("Expected a non-empty model name.");
  }

  const configDirectory = join(workspaceRoot, ".machdoch");
  const configPath = join(configDirectory, "config.json");
  const { config } = await loadWorkspaceConfigFile(workspaceRoot);

  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        ...config,
        model: normalizedModel,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return configPath;
};
