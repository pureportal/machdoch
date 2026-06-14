import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, join } from "node:path";
import { normalizeOptionalString } from "../../common/_helpers/normalize-optional-string.js";
import {
  AGENT_CLI_PROVIDER_ENV_KEY_BY_PROVIDER,
  AGENT_CLI_PROVIDERS,
  isAgentCliProvider as isRuntimeAgentCliProvider,
  type AgentCliProvider,
  type ModelProvider,
} from "../runtime-contract.generated.js";

export type { AgentCliProvider };

export interface AgentCliProviderDefinition {
  provider: AgentCliProvider;
  label: string;
  envKey: string;
  commandCandidates: readonly string[];
  defaultPathCandidates: readonly string[];
}

export interface AgentCliBinaryResolution {
  provider: AgentCliProvider;
  available: boolean;
  executable?: string;
  source?: "configured-path" | "path";
  reason?: string;
}

const WINDOWS_EXECUTABLE_EXTENSIONS = [
  ".COM",
  ".EXE",
  ".BAT",
  ".CMD",
] as const;

const userHomeDirectory = homedir();
const userProfileDirectory = process.env.USERPROFILE ?? userHomeDirectory;
const windowsAppDataDirectory =
  process.env.APPDATA ?? join(userProfileDirectory, "AppData", "Roaming");
const windowsLocalAppDataDirectory =
  process.env.LOCALAPPDATA ?? join(userProfileDirectory, "AppData", "Local");

const createDefaultCommandPathCandidates = (
  command: string,
): readonly string[] => {
  if (process.platform === "win32") {
    return [
      join(userProfileDirectory, ".local", "bin", `${command}.exe`),
      join(windowsAppDataDirectory, "npm", `${command}.cmd`),
      join(windowsAppDataDirectory, "npm", `${command}.exe`),
      join(
        windowsLocalAppDataDirectory,
        "Microsoft",
        "WinGet",
        "Links",
        `${command}.exe`,
      ),
    ];
  }

  return [
    join(userHomeDirectory, ".local", "bin", command),
    join("/usr/local/bin", command),
    join("/opt/homebrew/bin", command),
    join("/usr/bin", command),
  ];
};

export const AGENT_CLI_PROVIDER_DEFINITIONS: Record<
  AgentCliProvider,
  AgentCliProviderDefinition
> = {
  "codex-cli": {
    provider: "codex-cli",
    label: "Codex CLI",
    envKey: AGENT_CLI_PROVIDER_ENV_KEY_BY_PROVIDER["codex-cli"],
    commandCandidates: ["codex"],
    defaultPathCandidates: createDefaultCommandPathCandidates("codex"),
  },
  "claude-cli": {
    provider: "claude-cli",
    label: "Claude CLI",
    envKey: AGENT_CLI_PROVIDER_ENV_KEY_BY_PROVIDER["claude-cli"],
    commandCandidates: ["claude"],
    defaultPathCandidates: createDefaultCommandPathCandidates("claude"),
  },
  "copilot-cli": {
    provider: "copilot-cli",
    label: "Copilot CLI",
    envKey: AGENT_CLI_PROVIDER_ENV_KEY_BY_PROVIDER["copilot-cli"],
    commandCandidates: ["copilot"],
    defaultPathCandidates: createDefaultCommandPathCandidates("copilot"),
  },
};

const hasPathSeparator = (value: string): boolean => {
  return value.includes("/") || value.includes("\\");
};

const isExistingFile = (path: string): boolean => {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
};

const getWindowsPathExtensions = (
  env: NodeJS.ProcessEnv,
): readonly string[] => {
  const rawPathExt = normalizeOptionalString(env.PATHEXT);

  if (!rawPathExt) {
    return WINDOWS_EXECUTABLE_EXTENSIONS;
  }

  const extensions = rawPathExt
    .split(";")
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0)
    .map((extension) =>
      extension.startsWith(".") ? extension : `.${extension}`,
    );

  return extensions.length > 0 ? extensions : WINDOWS_EXECUTABLE_EXTENSIONS;
};

const createCommandFileNames = (
  command: string,
  env: NodeJS.ProcessEnv,
): string[] => {
  if (process.platform !== "win32" || extname(command)) {
    return [command];
  }

  return [command, ...getWindowsPathExtensions(env).map((ext) => `${command}${ext}`)];
};

const resolveCommandOnPath = (
  command: string,
  env: NodeJS.ProcessEnv,
): string | undefined => {
  const pathValue = normalizeOptionalString(env.PATH);

  if (!pathValue) {
    return undefined;
  }

  const commandFileNames = createCommandFileNames(command, env);

  for (const pathEntry of pathValue.split(delimiter)) {
    const directory = normalizeOptionalString(pathEntry);

    if (!directory) {
      continue;
    }

    for (const fileName of commandFileNames) {
      const candidate = join(directory, fileName);

      if (isExistingFile(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
};

const resolveConfiguredBinaryPath = (
  configuredPath: string,
  env: NodeJS.ProcessEnv,
): string | undefined => {
  if (isExistingFile(configuredPath)) {
    return configuredPath;
  }

  if (!hasPathSeparator(configuredPath)) {
    return resolveCommandOnPath(configuredPath, env);
  }

  if (hasPathSeparator(configuredPath)) {
    const pathDirectory = dirname(configuredPath);
    const pathName = basename(configuredPath);

    for (const fileName of createCommandFileNames(pathName, env)) {
      const candidate = join(pathDirectory, fileName);

      if (isExistingFile(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
};

export const isAgentCliProvider = (
  provider: ModelProvider,
): provider is AgentCliProvider => {
  return isRuntimeAgentCliProvider(provider);
};

export const getAgentCliProviderLabel = (
  provider: AgentCliProvider,
): string => AGENT_CLI_PROVIDER_DEFINITIONS[provider].label;

export const resolveAgentCliProviderBinary = (
  provider: AgentCliProvider,
  values: Record<string, string | undefined> = process.env,
): AgentCliBinaryResolution => {
  const definition = AGENT_CLI_PROVIDER_DEFINITIONS[provider];
  const env = {
    ...process.env,
    ...values,
  };
  const configuredPath = normalizeOptionalString(values[definition.envKey]);

  if (configuredPath) {
    const executable = resolveConfiguredBinaryPath(configuredPath, env);

    if (executable) {
      return {
        provider,
        available: true,
        executable,
        source: "configured-path",
      };
    }

    return {
      provider,
      available: false,
      reason: `${definition.envKey} points to a file that does not exist: ${configuredPath}`,
    };
  }

  for (const command of definition.commandCandidates) {
    const executable = hasPathSeparator(command)
      ? resolveConfiguredBinaryPath(command, env)
      : resolveCommandOnPath(command, env);

    if (executable) {
      return {
        provider,
        available: true,
        executable,
        source: "path",
      };
    }
  }

  for (const candidate of definition.defaultPathCandidates) {
    const executable = resolveConfiguredBinaryPath(candidate, env);

    if (executable) {
      return {
        provider,
        available: true,
        executable,
        source: "path",
      };
    }
  }

  return {
    provider,
    available: false,
    reason: `${definition.label} was not found on PATH. Set ${definition.envKey} to the CLI binary path.`,
  };
};

export const getAgentCliProviders = (): readonly AgentCliProvider[] =>
  AGENT_CLI_PROVIDERS;
