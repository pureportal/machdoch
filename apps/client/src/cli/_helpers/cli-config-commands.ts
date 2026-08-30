import process from "node:process";
import {
  clearWorkspaceConfigValue,
  loadRuntimeConfig,
  loadWorkspaceConfigFile,
  saveWorkspaceDefaultMode,
  saveWorkspaceDefaultModel,
  saveWorkspaceContextWindow,
  saveWorkspaceGithubCustomizations,
  saveWorkspaceOffline,
  saveWorkspaceReasoningExecutionMode,
  saveWorkspaceReasoningMode,
  saveWorkspaceRuntimeProvider,
} from "../../core/config.js";
import { parseContextWindow } from "../../core/context-windows.js";
import {
  loadFleetConnectionStatus,
  setFleetConnectionEnabled,
} from "../../core/fleet-connection.js";
import {
  clearUserConfigValue,
  hasConfiguredValue,
  loadUserAgentCliPaths,
  loadUserAgentLimitsSettings,
  loadUserConfigFile,
  loadUserMemorySettings,
  loadUserReviewModelSettings,
  loadUserWorkspaceRunSettings,
  loadRuntimeEnvironment,
  saveUserAgentCliPath,
  saveUserAgentLimitsSettings,
  saveUserApiKey,
  saveUserDesktopSettingsPatch,
  saveUserGlobalMemoryEnabled,
  saveUserReviewModelSettings,
  saveUserSpeechToTextActiveProvider,
  saveUserSpeechToTextInputDevice,
  saveUserVoiceActiveProvider,
  saveUserWebSearchActiveProvider,
  saveUserWebSearchApiKey,
  saveUserWorkspaceRunSettings,
} from "../../core/env.js";
import { resolveRuntimeAgentLimits } from "../../core/_helpers/agent-runtime-types.js";
import {
  AGENT_CLI_PROVIDER_ENV_KEY_BY_PROVIDER,
  AGENT_LIMIT_BOUNDS,
  DEFAULT_USER_DESKTOP_SETTINGS,
  DESKTOP_SETTING_BOUNDS,
  PROVIDER_ENV_KEY_BY_PROVIDER,
  REASONING_EXECUTION_MODES,
  REASONING_MODES,
  USER_API_PROVIDERS,
  USER_WEB_SEARCH_PROVIDERS,
  VALID_MODEL_PROVIDERS,
  WEB_SEARCH_ENV_KEY_BY_PROVIDER,
  WORKSPACE_RUN_SETTING_BOUNDS,
  isAgentCliProvider,
  isReasoningExecutionMode,
  isUserApiProvider,
  isUserWebSearchProvider,
  isVoiceAiProvider,
  isWebSearchProvider,
} from "../../core/runtime-contract.generated.js";
import type {
  AgentCliProvider,
  SpeechToTextProvider,
  UserApiProvider,
  UserConfigFile,
  UserDesktopSettings,
  UserWorkspaceRunSettings,
  UserWebSearchProvider,
  VoiceAiProvider,
  WebSearchProvider,
  WorkspaceConfigFile,
} from "../../core/runtime-contract.generated.js";
import type { ParsedCliArgs } from "./cli-args.js";
import { CliUsageError } from "./cli-error.js";
import { writeStdoutLine } from "./cli-io.js";
import { createUserConfigSummaryLines } from "./cli-output.js";
import { createCliStyle, formatKeyValueRows } from "./cli-terminal.js";

export type CliConfigScope = "user" | "workspace";

export interface CliConfigSettingDefinition {
  setting: string;
  category: string;
  scope: CliConfigScope;
  description: string;
  acceptedValues: string;
  choices?: readonly string[];
  secret?: boolean;
}

export interface CliConfigEntry extends CliConfigSettingDefinition {
  value: string | number | boolean;
  source: string;
}

interface ConfigSetResult {
  setting: string;
  scope: CliConfigScope;
  configPath: string;
  status: string;
  value?: string | number | boolean;
}

type DesktopSettingValueType = "boolean" | "integer" | "number" | "string";

interface DesktopConfigSetting {
  key: keyof UserDesktopSettings;
  type: DesktopSettingValueType;
  description: string;
  min?: number;
  max?: number;
}

interface WorkspaceRunConfigSetting {
  key: keyof UserWorkspaceRunSettings;
  description: string;
  min: number;
  max: number;
}

const BOOLEAN_CHOICES = ["on", "off"] as const;
const VOICE_PROVIDER_CHOICES = ["none", "openai", "google"] as const;
const WEB_SEARCH_PROVIDER_CHOICES = [
  "none",
  ...USER_WEB_SEARCH_PROVIDERS,
] as const;

const DESKTOP_CONFIG_SETTINGS = {
  "autostart-minimized": {
    key: "autostartMinimized",
    type: "boolean",
    description: "Start the desktop window minimized after sign-in.",
  },
  "autostart-to-tray": {
    key: "autostartToTray",
    type: "boolean",
    description: "Start the desktop app in the tray after sign-in.",
  },
  "always-run-as-administrator": {
    key: "alwaysRunAsAdministrator",
    type: "boolean",
    description: "Request elevation for packaged desktop launches on Windows.",
  },
  "assistant-bubble-enabled": {
    key: "assistantBubbleEnabled",
    type: "boolean",
    description: "Show the desktop assistant bubble while Machdoch is running.",
  },
  "assistant-bubble-hide-when-fullscreen": {
    key: "assistantBubbleHideWhenFullscreen",
    type: "boolean",
    description: "Hide the assistant bubble while another app is fullscreen.",
  },
  "assistant-bubble-temporarily-hide-seconds": {
    key: "assistantBubbleTemporarilyHideSeconds",
    type: "number",
    description: "Seconds to temporarily hide the assistant bubble.",
    ...DESKTOP_SETTING_BOUNDS.assistantBubbleTemporarilyHideSeconds,
  },
  "ai-context-max-messages": {
    key: "aiContextMaxMessages",
    type: "integer",
    description: "Maximum recent messages included in desktop AI context.",
    ...DESKTOP_SETTING_BOUNDS.aiContextMaxMessages,
  },
  "inactive-session-archive-days": {
    key: "inactiveSessionArchiveDays",
    type: "integer",
    description: "Days before an inactive desktop session is archived.",
    ...DESKTOP_SETTING_BOUNDS.inactiveSessionArchiveDays,
  },
  "archived-session-retention-days": {
    key: "archivedSessionRetentionDays",
    type: "integer",
    description: "Days an archived desktop session is retained.",
    ...DESKTOP_SETTING_BOUNDS.archivedSessionRetentionDays,
  },
  "quick-voice-enabled": {
    key: "quickVoiceEnabled",
    type: "boolean",
    description: "Enable Quick Voice in the desktop app.",
  },
  "quick-voice-shortcut": {
    key: "quickVoiceShortcut",
    type: "string",
    description: "Global shortcut used to open Quick Voice.",
  },
  "quick-voice-silence-seconds": {
    key: "quickVoiceSilenceSeconds",
    type: "number",
    description: "Silence duration that completes a Quick Voice recording.",
    ...DESKTOP_SETTING_BOUNDS.quickVoiceSilenceSeconds,
  },
  "quick-voice-max-messages": {
    key: "quickVoiceMaxMessages",
    type: "integer",
    description: "Maximum messages retained by Quick Voice.",
    ...DESKTOP_SETTING_BOUNDS.quickVoiceMaxMessages,
  },
} as const satisfies Record<string, DesktopConfigSetting>;

const WORKSPACE_RUN_CONFIG_SETTINGS = {
  "startup-delay-ms": {
    key: "startupDelayMs",
    description: "Delay before the first health check.",
    ...WORKSPACE_RUN_SETTING_BOUNDS.startupDelayMs,
  },
  "health-check-interval-ms": {
    key: "healthCheckIntervalMs",
    description: "Time between health checks.",
    ...WORKSPACE_RUN_SETTING_BOUNDS.healthCheckIntervalMs,
  },
  "health-check-timeout-ms": {
    key: "healthCheckTimeoutMs",
    description: "Maximum duration of each health check.",
    ...WORKSPACE_RUN_SETTING_BOUNDS.healthCheckTimeoutMs,
  },
  "health-check-failure-threshold": {
    key: "healthCheckFailureThreshold",
    description: "Failed health checks before a run becomes unhealthy.",
    ...WORKSPACE_RUN_SETTING_BOUNDS.healthCheckFailureThreshold,
  },
  "sequential-readiness-timeout-ms": {
    key: "sequentialReadinessTimeoutMs",
    description: "Maximum readiness wait for each sequential run.",
    ...WORKSPACE_RUN_SETTING_BOUNDS.sequentialReadinessTimeoutMs,
  },
} as const satisfies Record<string, WorkspaceRunConfigSetting>;

const desktopAcceptedValues = (setting: DesktopConfigSetting): string => {
  if (setting.type === "boolean") {
    return "on|off";
  }

  if (setting.min !== undefined && setting.max !== undefined) {
    return `${setting.min}..${setting.max}`;
  }

  return setting.type === "string" ? "text" : "number";
};

const createConfigSettingDefinitions = (): CliConfigSettingDefinition[] => [
  {
    setting: "workspace.mode",
    category: "Workspace",
    scope: "workspace",
    description: "Default execution mode for this workspace.",
    acceptedValues: "ask|machdoch",
    choices: ["ask", "machdoch"],
  },
  {
    setting: "workspace.provider",
    category: "Workspace",
    scope: "workspace",
    description: "Default model provider for this workspace.",
    acceptedValues: VALID_MODEL_PROVIDERS.join("|"),
    choices: VALID_MODEL_PROVIDERS,
  },
  {
    setting: "workspace.model",
    category: "Workspace",
    scope: "workspace",
    description: "Default provider model id for this workspace.",
    acceptedValues: "model id",
  },
  {
    setting: "workspace.reasoning",
    category: "Workspace",
    scope: "workspace",
    description: "Default reasoning effort for this workspace.",
    acceptedValues: REASONING_MODES.join("|"),
    choices: REASONING_MODES,
  },
  {
    setting: "workspace.reasoning-mode",
    category: "Workspace",
    scope: "workspace",
    description: "OpenAI GPT-5.6 reasoning execution mode.",
    acceptedValues: REASONING_EXECUTION_MODES.join("|"),
    choices: REASONING_EXECUTION_MODES,
  },
  {
    setting: "workspace.context-window",
    category: "Workspace",
    scope: "workspace",
    description: "Context window requested from the selected provider model.",
    acceptedValues: "default|long|token count",
  },
  {
    setting: "workspace.offline",
    category: "Workspace",
    scope: "workspace",
    description:
      "Disable network-backed runtime capabilities in this workspace.",
    acceptedValues: "on|off",
    choices: BOOLEAN_CHOICES,
  },
  {
    setting: "workspace.github-customizations",
    category: "Workspace",
    scope: "workspace",
    description: "Discover compatible prompts and skills under .github.",
    acceptedValues: "on|off",
    choices: BOOLEAN_CHOICES,
  },
  ...USER_API_PROVIDERS.map(
    (provider): CliConfigSettingDefinition => ({
      setting: `api.${provider}.key`,
      category: "Providers",
      scope: "user",
      description: `API key used for the ${provider} provider.`,
      acceptedValues: "API key",
      secret: true,
    }),
  ),
  ...(["codex-cli", "claude-cli", "copilot-cli"] as const).map(
    (provider): CliConfigSettingDefinition => ({
      setting: `agent-cli.${provider}.path`,
      category: "Providers",
      scope: "user",
      description: `Explicit path to the ${provider} executable.`,
      acceptedValues: "existing file path",
    }),
  ),
  {
    setting: "web-search.provider",
    category: "Web search",
    scope: "user",
    description: "Provider used by new web-search tasks.",
    acceptedValues: WEB_SEARCH_PROVIDER_CHOICES.join("|"),
    choices: WEB_SEARCH_PROVIDER_CHOICES,
  },
  ...USER_WEB_SEARCH_PROVIDERS.map(
    (provider): CliConfigSettingDefinition => ({
      setting: `web-search.${provider}.key`,
      category: "Web search",
      scope: "user",
      description: `API key used for ${provider} web search.`,
      acceptedValues: "API key",
      secret: true,
    }),
  ),
  {
    setting: "agent-limits.infinite",
    category: "Agent",
    scope: "user",
    description: "Disable executor and continuation limits.",
    acceptedValues: "on|off",
    choices: BOOLEAN_CHOICES,
  },
  {
    setting: "agent-limits.executor-turns",
    category: "Agent",
    scope: "user",
    description: "Maximum model/tool turns in one executor cycle.",
    acceptedValues: `${AGENT_LIMIT_BOUNDS.executorTurns.min}..${AGENT_LIMIT_BOUNDS.executorTurns.max}`,
  },
  {
    setting: "agent-limits.autopilot-iterations",
    category: "Agent",
    scope: "user",
    description: "Maximum Machdoch continuation cycles.",
    acceptedValues: `${AGENT_LIMIT_BOUNDS.autopilotExecutorIterations.min}..${AGENT_LIMIT_BOUNDS.autopilotExecutorIterations.max}`,
  },
  {
    setting: "review-model",
    category: "Agent",
    scope: "user",
    description: "Model used for validator passes.",
    acceptedValues: "base|<provider>:<model>",
  },
  {
    setting: "memory.global",
    category: "Memory",
    scope: "user",
    description: "Enable durable cross-session memory by default.",
    acceptedValues: "on|off",
    choices: BOOLEAN_CHOICES,
  },
  {
    setting: "fleet.enabled",
    category: "Fleet",
    scope: "user",
    description: "Enable the enrolled Fleet host gateway.",
    acceptedValues: "on|off",
    choices: BOOLEAN_CHOICES,
  },
  {
    setting: "voice.provider",
    category: "Voice",
    scope: "user",
    description: "AI voice provider used by the desktop app.",
    acceptedValues: VOICE_PROVIDER_CHOICES.join("|"),
    choices: VOICE_PROVIDER_CHOICES,
  },
  {
    setting: "speech-to-text.provider",
    category: "Voice",
    scope: "user",
    description: "Speech-to-text provider used by the desktop app.",
    acceptedValues: VOICE_PROVIDER_CHOICES.join("|"),
    choices: VOICE_PROVIDER_CHOICES,
  },
  {
    setting: "speech-to-text.input-device",
    category: "Voice",
    scope: "user",
    description: "Preferred audio input device id, or none.",
    acceptedValues: "device id|none",
  },
  ...Object.entries(DESKTOP_CONFIG_SETTINGS).map(
    ([setting, definition]): CliConfigSettingDefinition => ({
      setting: `desktop.${setting}`,
      category: "Desktop",
      scope: "user",
      description: definition.description,
      acceptedValues: desktopAcceptedValues(definition),
      ...(definition.type === "boolean" ? { choices: BOOLEAN_CHOICES } : {}),
    }),
  ),
  ...Object.entries(WORKSPACE_RUN_CONFIG_SETTINGS).map(
    ([setting, definition]): CliConfigSettingDefinition => ({
      setting: `workspace-run.${setting}`,
      category: "Workspace Run",
      scope: "user",
      description: definition.description,
      acceptedValues: `${definition.min}..${definition.max}`,
    }),
  ),
];

export const CLI_CONFIG_SETTING_DEFINITIONS = createConfigSettingDefinitions();

const fail = (message: string): never => {
  throw new CliUsageError(message);
};

const parseConfigBoolean = (setting: string, value: string): boolean => {
  const normalizedValue = value.trim().toLowerCase();

  if (["on", "true", "1", "yes"].includes(normalizedValue)) {
    return true;
  }

  if (["off", "false", "0", "no"].includes(normalizedValue)) {
    return false;
  }

  return fail(`Expected ${setting} to be followed by on or off.`);
};

const parseConfigNumber = (
  setting: string,
  value: string,
  options: { integer: boolean; min?: number; max?: number },
): number => {
  const parsed = Number(value);
  const valid =
    Number.isFinite(parsed) &&
    (!options.integer || Number.isInteger(parsed)) &&
    (options.min === undefined || parsed >= options.min) &&
    (options.max === undefined || parsed <= options.max);

  if (!valid) {
    const range =
      options.min !== undefined && options.max !== undefined
        ? ` between ${options.min} and ${options.max}`
        : "";
    return fail(
      `Expected ${setting} to be ${options.integer ? "an integer" : "a number"}${range}.`,
    );
  }

  return parsed;
};

const isDesktopConfigSetting = (
  setting: string,
): setting is keyof typeof DESKTOP_CONFIG_SETTINGS =>
  setting in DESKTOP_CONFIG_SETTINGS;

const isWorkspaceRunConfigSetting = (
  setting: string,
): setting is keyof typeof WORKSPACE_RUN_CONFIG_SETTINGS =>
  setting in WORKSPACE_RUN_CONFIG_SETTINGS;

const parseDesktopSettingValue = (
  setting: string,
  value: string,
): {
  patch: Partial<UserDesktopSettings>;
  value: string | number | boolean;
} => {
  if (setting === "autostart-enabled") {
    return fail(
      "desktop.autostart-enabled must be changed in the desktop app because it updates the operating system's sign-in registration.",
    );
  }

  if (!isDesktopConfigSetting(setting)) {
    return fail(
      `Unsupported desktop setting \`desktop.${setting}\`. Run \`machdoch config list\` to see configurable settings.`,
    );
  }

  const desktopSetting = DESKTOP_CONFIG_SETTINGS[setting];
  let parsedValue: string | number | boolean;

  switch (desktopSetting.type) {
    case "boolean":
      parsedValue = parseConfigBoolean(`desktop.${setting}`, value);
      break;
    case "integer":
    case "number":
      parsedValue = parseConfigNumber(`desktop.${setting}`, value, {
        integer: desktopSetting.type === "integer",
        ...(desktopSetting.min !== undefined
          ? { min: desktopSetting.min }
          : {}),
        ...(desktopSetting.max !== undefined
          ? { max: desktopSetting.max }
          : {}),
      });
      break;
    case "string":
      parsedValue =
        value.trim() || fail(`Expected desktop.${setting} to be non-empty.`);
      break;
  }

  return {
    patch: { [desktopSetting.key]: parsedValue },
    value: parsedValue,
  };
};

const unsupportedConfigSetting = (setting: string): never =>
  fail(
    `Unsupported config setting \`${setting}\`. Run \`machdoch config list\` to see configurable settings.`,
  );

export const saveConfigSetting = async (
  workspaceRoot: string,
  setting: string,
  value: string,
): Promise<ConfigSetResult> => {
  const normalizedSetting = setting.trim().toLowerCase();
  const normalizedValue = value.trim();
  const parts = normalizedSetting.split(".");

  if (parts.length === 3 && parts[0] === "api" && parts[2] === "key") {
    const provider = parts[1] ?? "";
    if (!isUserApiProvider(provider)) return unsupportedConfigSetting(setting);
    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserApiKey(provider, normalizedValue),
      status: "configured",
    };
  }

  if (normalizedSetting === "fleet.enabled") {
    const enabled = parseConfigBoolean(normalizedSetting, normalizedValue);
    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await setFleetConnectionEnabled(enabled),
      status: "configured",
      value: enabled,
    };
  }

  if (parts.length === 3 && parts[0] === "agent-cli" && parts[2] === "path") {
    const provider = parts[1] ?? "";
    if (!isAgentCliProvider(provider)) return unsupportedConfigSetting(setting);
    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserAgentCliPath(provider, normalizedValue),
      status: "configured",
      value: normalizedValue,
    };
  }

  if (normalizedSetting === "web-search.provider") {
    if (!isWebSearchProvider(normalizedValue)) {
      fail(
        "Expected web-search.provider to be one of none, perplexity, tavily, or serper.",
      );
    }
    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserWebSearchActiveProvider(
        normalizedValue as WebSearchProvider,
      ),
      status: "configured",
      value: normalizedValue,
    };
  }

  if (parts.length === 3 && parts[0] === "web-search" && parts[2] === "key") {
    const provider = parts[1] ?? "";
    if (!isUserWebSearchProvider(provider)) {
      return unsupportedConfigSetting(setting);
    }
    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserWebSearchApiKey(provider, normalizedValue),
      status: "configured",
    };
  }

  if (normalizedSetting === "voice.provider") {
    if (!isVoiceAiProvider(normalizedValue)) {
      fail("Expected voice.provider to be one of none, openai, or google.");
    }
    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserVoiceActiveProvider(
        normalizedValue as VoiceAiProvider,
      ),
      status: "configured",
      value: normalizedValue,
    };
  }

  if (normalizedSetting === "speech-to-text.provider") {
    if (!isVoiceAiProvider(normalizedValue)) {
      fail(
        "Expected speech-to-text.provider to be one of none, openai, or google.",
      );
    }
    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserSpeechToTextActiveProvider(
        normalizedValue as SpeechToTextProvider,
      ),
      status: "configured",
      value: normalizedValue,
    };
  }

  if (normalizedSetting === "speech-to-text.input-device") {
    const inputDeviceId =
      normalizedValue.toLowerCase() === "none" ? null : normalizedValue;
    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserSpeechToTextInputDevice(inputDeviceId),
      status: "configured",
      value: inputDeviceId ?? "none",
    };
  }

  if (parts.length === 2 && parts[0] === "desktop") {
    const parsed = parseDesktopSettingValue(parts[1] ?? "", normalizedValue);
    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserDesktopSettingsPatch(parsed.patch),
      status: "configured",
      value: parsed.value,
    };
  }

  if (parts.length === 2 && parts[0] === "workspace-run") {
    const name = parts[1] ?? "";
    if (!isWorkspaceRunConfigSetting(name)) {
      return unsupportedConfigSetting(setting);
    }
    const definition = WORKSPACE_RUN_CONFIG_SETTINGS[name];
    const parsedValue = parseConfigNumber(normalizedSetting, normalizedValue, {
      integer: true,
      min: definition.min,
      max: definition.max,
    });
    const current = await loadUserWorkspaceRunSettings();
    if (
      definition.key === "healthCheckTimeoutMs" &&
      parsedValue > current.healthCheckIntervalMs
    ) {
      return fail(
        `Expected ${normalizedSetting} to be at most ${current.healthCheckIntervalMs}.`,
      );
    }
    const next = { ...current, [definition.key]: parsedValue };
    if (
      definition.key === "healthCheckIntervalMs" &&
      next.healthCheckTimeoutMs > parsedValue
    ) {
      next.healthCheckTimeoutMs = parsedValue;
    }
    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserWorkspaceRunSettings(next),
      status: "configured",
      value: parsedValue,
    };
  }

  if (normalizedSetting === "memory.global") {
    const enabled = parseConfigBoolean(normalizedSetting, normalizedValue);
    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserGlobalMemoryEnabled(enabled),
      status: "configured",
      value: enabled,
    };
  }

  if (normalizedSetting === "agent-limits.infinite") {
    const infinite = parseConfigBoolean(normalizedSetting, normalizedValue);
    const current = await loadUserAgentLimitsSettings();
    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserAgentLimitsSettings({ ...current, infinite }),
      status: "configured",
      value: infinite,
    };
  }

  if (normalizedSetting === "agent-limits.executor-turns") {
    const executorTurns = parseConfigNumber(
      normalizedSetting,
      normalizedValue,
      {
        integer: true,
        ...AGENT_LIMIT_BOUNDS.executorTurns,
      },
    );
    const current = await loadUserAgentLimitsSettings();
    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserAgentLimitsSettings({
        ...current,
        infinite: false,
        executorTurns,
      }),
      status: "configured",
      value: executorTurns,
    };
  }

  if (normalizedSetting === "agent-limits.autopilot-iterations") {
    const autopilotExecutorIterations = parseConfigNumber(
      normalizedSetting,
      normalizedValue,
      {
        integer: true,
        ...AGENT_LIMIT_BOUNDS.autopilotExecutorIterations,
      },
    );
    const current = await loadUserAgentLimitsSettings();
    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserAgentLimitsSettings({
        ...current,
        infinite: false,
        autopilotExecutorIterations,
      }),
      status: "configured",
      value: autopilotExecutorIterations,
    };
  }

  if (normalizedSetting === "review-model") {
    if (normalizedValue.toLowerCase() === "base") {
      return {
        setting: normalizedSetting,
        scope: "user",
        configPath: await saveUserReviewModelSettings({ mode: "base" }),
        status: "configured",
        value: "base",
      };
    }

    const separator = normalizedValue.indexOf(":");
    const provider = normalizedValue.slice(0, separator);
    const model = normalizedValue.slice(separator + 1).trim();
    if (
      separator <= 0 ||
      !VALID_MODEL_PROVIDERS.includes(
        provider as (typeof VALID_MODEL_PROVIDERS)[number],
      ) ||
      !model
    ) {
      fail(
        "Expected review-model to be base or <provider>:<model>, for example openai:gpt-5.5-mini.",
      );
    }
    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserReviewModelSettings({
        mode: "dedicated",
        provider: provider as (typeof VALID_MODEL_PROVIDERS)[number],
        model,
      }),
      status: "configured",
      value: `${provider}:${model}`,
    };
  }

  if (normalizedSetting === "workspace.model") {
    return {
      setting: normalizedSetting,
      scope: "workspace",
      configPath: await saveWorkspaceDefaultModel(
        workspaceRoot,
        normalizedValue,
      ),
      status: "configured",
      value: normalizedValue,
    };
  }

  if (normalizedSetting === "workspace.provider") {
    return {
      setting: normalizedSetting,
      scope: "workspace",
      configPath: await saveWorkspaceRuntimeProvider(
        workspaceRoot,
        normalizedValue,
      ),
      status: "configured",
      value: normalizedValue,
    };
  }

  if (normalizedSetting === "workspace.mode") {
    return {
      setting: normalizedSetting,
      scope: "workspace",
      configPath: await saveWorkspaceDefaultMode(
        workspaceRoot,
        normalizedValue,
      ),
      status: "configured",
      value: normalizedValue,
    };
  }

  if (normalizedSetting === "workspace.reasoning") {
    return {
      setting: normalizedSetting,
      scope: "workspace",
      configPath: await saveWorkspaceReasoningMode(
        workspaceRoot,
        normalizedValue,
      ),
      status: "configured",
      value: normalizedValue,
    };
  }

  if (normalizedSetting === "workspace.reasoning-mode") {
    if (!isReasoningExecutionMode(normalizedValue)) {
      fail("Expected workspace.reasoning-mode to be standard or pro.");
    }

    return {
      setting: normalizedSetting,
      scope: "workspace",
      configPath: await saveWorkspaceReasoningExecutionMode(
        workspaceRoot,
        normalizedValue,
      ),
      status: "configured",
      value: normalizedValue,
    };
  }

  if (normalizedSetting === "workspace.context-window") {
    const contextWindow =
      parseContextWindow(normalizedValue) ??
      fail(
        "Expected workspace.context-window to be default, long, or a positive token count up to 10000000.",
      );

    return {
      setting: normalizedSetting,
      scope: "workspace",
      configPath: await saveWorkspaceContextWindow(
        workspaceRoot,
        contextWindow,
      ),
      status: "configured",
      value: contextWindow,
    };
  }

  if (normalizedSetting === "workspace.offline") {
    const offline = parseConfigBoolean(normalizedSetting, normalizedValue);
    return {
      setting: normalizedSetting,
      scope: "workspace",
      configPath: await saveWorkspaceOffline(workspaceRoot, offline),
      status: "configured",
      value: offline,
    };
  }

  if (normalizedSetting === "workspace.github-customizations") {
    const enabled = parseConfigBoolean(normalizedSetting, normalizedValue);
    return {
      setting: normalizedSetting,
      scope: "workspace",
      configPath: await saveWorkspaceGithubCustomizations(
        workspaceRoot,
        enabled,
      ),
      status: "configured",
      value: enabled,
    };
  }

  return unsupportedConfigSetting(setting);
};

export const clearConfigSetting = async (
  workspaceRoot: string,
  setting: string,
): Promise<ConfigSetResult> => {
  const normalizedSetting = setting.trim().toLowerCase();
  if (
    !CLI_CONFIG_SETTING_DEFINITIONS.some(
      (definition) => definition.setting === normalizedSetting,
    )
  ) {
    return unsupportedConfigSetting(setting);
  }

  const parts = normalizedSetting.split(".");
  if (normalizedSetting === "fleet.enabled") {
    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await setFleetConnectionEnabled(false),
      status: "reset",
      value: false,
    };
  }
  let scope: CliConfigScope;
  let configPath: string;

  if (parts[0] === "workspace") {
    scope = "workspace";
    const workspacePaths: Readonly<Record<string, readonly string[]>> = {
      "workspace.mode": ["defaultMode"],
      "workspace.provider": ["provider"],
      "workspace.model": ["model"],
      "workspace.reasoning": ["reasoning"],
      "workspace.reasoning-mode": ["reasoningMode"],
      "workspace.context-window": ["contextWindow"],
      "workspace.offline": ["offline"],
      "workspace.github-customizations": [
        "compatibility",
        "discoverGithubCustomizations",
      ],
    };
    configPath = await clearWorkspaceConfigValue(
      workspaceRoot,
      workspacePaths[normalizedSetting] ?? [],
    );
  } else {
    scope = "user";
    let path: readonly string[];

    if (parts[0] === "api") {
      path = ["apiKeys", parts[1] ?? ""];
    } else if (parts[0] === "agent-cli") {
      path = ["agentCliPaths", parts[1] ?? ""];
    } else if (parts[0] === "web-search" && parts[2] === "key") {
      path = ["webSearch", "apiKeys", parts[1] ?? ""];
    } else if (normalizedSetting === "web-search.provider") {
      path = ["webSearch", "activeProvider"];
    } else if (normalizedSetting === "voice.provider") {
      path = ["voice", "activeProvider"];
    } else if (normalizedSetting === "speech-to-text.provider") {
      path = ["speechToText", "activeProvider"];
    } else if (normalizedSetting === "speech-to-text.input-device") {
      path = ["speechToText", "inputDeviceId"];
    } else if (normalizedSetting === "memory.global") {
      path = ["memory", "globalEnabled"];
    } else if (normalizedSetting === "review-model") {
      path = ["reviewModel"];
    } else if (normalizedSetting.startsWith("agent-limits.")) {
      const agentLimitPaths: Readonly<Record<string, string>> = {
        "agent-limits.infinite": "infinite",
        "agent-limits.executor-turns": "executorTurns",
        "agent-limits.autopilot-iterations": "autopilotExecutorIterations",
      };
      path = ["agentLimits", agentLimitPaths[normalizedSetting] ?? ""];
    } else if (normalizedSetting.startsWith("workspace-run.")) {
      const name = normalizedSetting.slice("workspace-run.".length);
      if (!isWorkspaceRunConfigSetting(name)) {
        return unsupportedConfigSetting(setting);
      }
      path = ["workspaceRun", WORKSPACE_RUN_CONFIG_SETTINGS[name].key];
    } else if (normalizedSetting.startsWith("desktop.")) {
      const desktopName = normalizedSetting.slice("desktop.".length);
      const desktopSetting =
        DESKTOP_CONFIG_SETTINGS[
          desktopName as keyof typeof DESKTOP_CONFIG_SETTINGS
        ];
      path = ["desktop", desktopSetting.key];
    } else {
      return unsupportedConfigSetting(setting);
    }

    configPath = await clearUserConfigValue(path);
  }

  return {
    setting: normalizedSetting,
    scope,
    configPath,
    status: "reset",
  };
};

interface ConfigSnapshot {
  runtime: Awaited<ReturnType<typeof loadRuntimeConfig>>;
  workspaceConfig: WorkspaceConfigFile;
  userConfig: UserConfigFile;
  env: Record<string, string>;
  memory: Awaited<ReturnType<typeof loadUserMemorySettings>>;
  reviewModel: Awaited<ReturnType<typeof loadUserReviewModelSettings>>;
  agentCliPaths: Awaited<ReturnType<typeof loadUserAgentCliPaths>>;
  workspaceRun: Awaited<ReturnType<typeof loadUserWorkspaceRunSettings>>;
  fleet: Awaited<ReturnType<typeof loadFleetConnectionStatus>>;
}

const loadConfigSnapshot = async (
  workspaceRoot: string,
): Promise<ConfigSnapshot> => {
  const [
    runtime,
    workspace,
    user,
    env,
    memory,
    reviewModel,
    agentCliPaths,
    workspaceRun,
    fleet,
  ] = await Promise.all([
    loadRuntimeConfig(workspaceRoot),
    loadWorkspaceConfigFile(workspaceRoot),
    loadUserConfigFile(),
    loadRuntimeEnvironment(),
    loadUserMemorySettings(),
    loadUserReviewModelSettings(),
    loadUserAgentCliPaths(),
    loadUserWorkspaceRunSettings(),
    loadFleetConnectionStatus(),
  ]);

  return {
    runtime,
    workspaceConfig: workspace.config,
    userConfig: user.config,
    env,
    memory,
    reviewModel,
    agentCliPaths,
    workspaceRun,
    fleet,
  };
};

const configSource = (
  persisted: unknown,
  envValue?: string,
  fallback = "default",
): string =>
  envValue ? "environment" : persisted !== undefined ? "saved" : fallback;

const savedFirstSource = (persisted: unknown, envValue?: string): string =>
  persisted !== undefined ? "saved" : envValue ? "environment" : "default";

const isPositiveLimit = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const parseAgentLimitEnvironment = (
  env: Record<string, string>,
): {
  infinite?: boolean;
  executorTurns?: number;
  autopilotExecutorIterations?: number;
} => {
  const parseLimit = (value: string | undefined): number | undefined => {
    const parsed = Number(value);
    return value && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  const executorTurns = parseLimit(env.MACHDOCH_EXECUTOR_TURNS);
  const autopilotExecutorIterations = parseLimit(
    env.MACHDOCH_AUTOPILOT_ITERATIONS,
  );

  return {
    ...(env.MACHDOCH_INFINITE === "true" || env.MACHDOCH_INFINITE === "1"
      ? { infinite: true }
      : {}),
    ...(executorTurns !== undefined ? { executorTurns } : {}),
    ...(autopilotExecutorIterations !== undefined
      ? { autopilotExecutorIterations }
      : {}),
  };
};

const resolveAgentLimitSource = (
  setting: "infinite" | "executorTurns" | "autopilotExecutorIterations",
  snapshot: ConfigSnapshot,
): string => {
  const environment = parseAgentLimitEnvironment(snapshot.env);
  const hasEnvironmentOverride = Object.keys(environment).length > 0;
  const workspace = snapshot.workspaceConfig.agentLimits;
  const user = snapshot.userConfig.agentLimits;
  const selected = hasEnvironmentOverride ? environment : (workspace ?? user);
  const selectedSource = hasEnvironmentOverride
    ? "environment"
    : workspace !== undefined
      ? "workspace config"
      : user !== undefined
        ? "user config"
        : "default";

  if (!selected) return "default";
  if (setting === "infinite" || selected.infinite === true) {
    return selectedSource;
  }
  if (isPositiveLimit(selected[setting])) return selectedSource;
  if (selected === user) return "default";
  if (user?.infinite === true) return "default";
  return isPositiveLimit(user?.[setting]) ? "user config" : "default";
};

const secretStatus = (
  savedValue: string | undefined,
  envValue: string | undefined,
): { value: string; source: string } => {
  if (
    hasConfiguredValue(envValue) &&
    (!hasConfiguredValue(savedValue) || envValue?.trim() !== savedValue?.trim())
  ) {
    return { value: "configured", source: "environment" };
  }
  if (hasConfiguredValue(savedValue)) {
    return { value: "configured", source: "user config" };
  }
  if (hasConfiguredValue(envValue)) {
    return { value: "configured", source: "environment" };
  }
  return { value: "not configured", source: "default" };
};

const resolveConfigEntry = (
  definition: CliConfigSettingDefinition,
  snapshot: ConfigSnapshot,
): CliConfigEntry => {
  const { setting } = definition;
  let value: string | number | boolean;
  let source = "default";

  if (setting.startsWith("api.")) {
    const provider = setting.split(".")[1] as UserApiProvider;
    ({ value, source } = secretStatus(
      snapshot.userConfig.apiKeys?.[provider],
      snapshot.env[PROVIDER_ENV_KEY_BY_PROVIDER[provider]],
    ));
  } else if (setting.startsWith("agent-cli.")) {
    const provider = setting.split(".")[1] as AgentCliProvider;
    const savedPath = snapshot.agentCliPaths[provider];
    const envPath =
      snapshot.env[AGENT_CLI_PROVIDER_ENV_KEY_BY_PROVIDER[provider]];
    const available = snapshot.runtime.providerAvailability.some(
      (entry) => entry.provider === provider && entry.configured,
    );
    value = envPath ?? savedPath ?? (available ? "auto-detected" : "not found");
    source =
      envPath && envPath !== savedPath
        ? "environment"
        : savedPath
          ? "user config"
          : envPath
            ? "environment"
            : available
              ? "PATH"
              : "default";
  } else if (setting.startsWith("web-search.") && setting.endsWith(".key")) {
    const provider = setting.split(".")[1] as UserWebSearchProvider;
    ({ value, source } = secretStatus(
      snapshot.userConfig.webSearch?.apiKeys?.[provider],
      snapshot.env[WEB_SEARCH_ENV_KEY_BY_PROVIDER[provider]],
    ));
  } else if (setting.startsWith("desktop.")) {
    const name = setting.slice("desktop.".length);
    const desktop =
      DESKTOP_CONFIG_SETTINGS[name as keyof typeof DESKTOP_CONFIG_SETTINGS];
    value =
      snapshot.userConfig.desktop?.[desktop.key] ??
      DEFAULT_USER_DESKTOP_SETTINGS[desktop.key];
    source = configSource(snapshot.userConfig.desktop?.[desktop.key]);
  } else if (setting.startsWith("workspace-run.")) {
    const name = setting.slice("workspace-run.".length);
    const workspaceRun =
      WORKSPACE_RUN_CONFIG_SETTINGS[
        name as keyof typeof WORKSPACE_RUN_CONFIG_SETTINGS
      ];
    value = snapshot.workspaceRun[workspaceRun.key];
    source = configSource(snapshot.userConfig.workspaceRun?.[workspaceRun.key]);
  } else if (setting === "fleet.enabled") {
    value = snapshot.fleet.enabled;
    source = snapshot.fleet.configured ? "saved" : "default";
  } else {
    switch (setting) {
      case "workspace.mode":
        value = snapshot.runtime.mode;
        source = configSource(
          snapshot.workspaceConfig.defaultMode === "ask" ||
            snapshot.workspaceConfig.defaultMode === "machdoch"
            ? snapshot.workspaceConfig.defaultMode
            : undefined,
          snapshot.env.MACHDOCH_MODE === "ask" ||
            snapshot.env.MACHDOCH_MODE === "machdoch"
            ? snapshot.env.MACHDOCH_MODE
            : undefined,
        );
        break;
      case "workspace.provider":
        value = snapshot.runtime.provider;
        source = VALID_MODEL_PROVIDERS.includes(
          snapshot.workspaceConfig
            .provider as (typeof VALID_MODEL_PROVIDERS)[number],
        )
          ? "saved"
          : "auto-detected";
        break;
      case "workspace.model":
        value = snapshot.runtime.model;
        source = savedFirstSource(
          snapshot.workspaceConfig.model,
          snapshot.env.MACHDOCH_MODEL,
        );
        break;
      case "workspace.reasoning":
        value = snapshot.runtime.reasoning;
        source = configSource(
          REASONING_MODES.includes(
            snapshot.workspaceConfig
              .reasoning as (typeof REASONING_MODES)[number],
          )
            ? snapshot.workspaceConfig.reasoning
            : undefined,
          REASONING_MODES.includes(
            snapshot.env.MACHDOCH_REASONING as (typeof REASONING_MODES)[number],
          )
            ? snapshot.env.MACHDOCH_REASONING
            : undefined,
        );
        break;
      case "workspace.reasoning-mode":
        value = snapshot.runtime.reasoningMode ?? "standard";
        source = configSource(
          snapshot.workspaceConfig.reasoningMode,
          snapshot.env.MACHDOCH_REASONING_MODE,
        );
        break;
      case "workspace.context-window":
        value = snapshot.runtime.contextWindow ?? "default";
        source = configSource(
          snapshot.workspaceConfig.contextWindow,
          snapshot.env.MACHDOCH_CONTEXT_WINDOW,
        );
        break;
      case "workspace.offline":
        value = snapshot.runtime.offline;
        source = configSource(
          snapshot.workspaceConfig.offline,
          snapshot.env.MACHDOCH_OFFLINE === "true"
            ? snapshot.env.MACHDOCH_OFFLINE
            : undefined,
        );
        break;
      case "workspace.github-customizations":
        value =
          snapshot.runtime.compatibility.discoverGithubCustomizations ?? false;
        source = configSource(
          snapshot.workspaceConfig.compatibility?.discoverGithubCustomizations,
        );
        break;
      case "web-search.provider":
        value = snapshot.runtime.webSearch.activeProvider;
        source = configSource(
          isWebSearchProvider(snapshot.userConfig.webSearch?.activeProvider)
            ? snapshot.userConfig.webSearch.activeProvider
            : undefined,
          isWebSearchProvider(snapshot.env.MACHDOCH_WEB_SEARCH_PROVIDER)
            ? snapshot.env.MACHDOCH_WEB_SEARCH_PROVIDER
            : undefined,
        );
        break;
      case "agent-limits.infinite": {
        const limits = resolveRuntimeAgentLimits(snapshot.runtime);
        value =
          limits.executorTurns === null &&
          limits.autopilotExecutorIterations === null;
        source = resolveAgentLimitSource("infinite", snapshot);
        break;
      }
      case "agent-limits.executor-turns":
        value =
          resolveRuntimeAgentLimits(snapshot.runtime).executorTurns ??
          "infinite";
        source = resolveAgentLimitSource("executorTurns", snapshot);
        break;
      case "agent-limits.autopilot-iterations":
        value =
          resolveRuntimeAgentLimits(snapshot.runtime)
            .autopilotExecutorIterations ?? "infinite";
        source = resolveAgentLimitSource(
          "autopilotExecutorIterations",
          snapshot,
        );
        break;
      case "review-model":
        value =
          snapshot.reviewModel.mode === "dedicated"
            ? `${snapshot.reviewModel.provider}:${snapshot.reviewModel.model}`
            : "base";
        source = snapshot.userConfig.reviewModel ? "user config" : "default";
        break;
      case "memory.global":
        value = snapshot.memory.globalEnabled;
        source = configSource(snapshot.userConfig.memory?.globalEnabled);
        break;
      case "voice.provider":
        value = snapshot.userConfig.voice?.activeProvider ?? "none";
        source = configSource(snapshot.userConfig.voice?.activeProvider);
        break;
      case "speech-to-text.provider":
        value = snapshot.userConfig.speechToText?.activeProvider ?? "none";
        source = configSource(snapshot.userConfig.speechToText?.activeProvider);
        break;
      case "speech-to-text.input-device":
        value = snapshot.userConfig.speechToText?.inputDeviceId ?? "none";
        source = configSource(snapshot.userConfig.speechToText?.inputDeviceId);
        break;
      default:
        return unsupportedConfigSetting(setting);
    }
  }

  return { ...definition, value, source };
};

export const loadCliConfigEntries = async (
  workspaceRoot: string,
): Promise<CliConfigEntry[]> => {
  const snapshot = await loadConfigSnapshot(workspaceRoot);
  return CLI_CONFIG_SETTING_DEFINITIONS.map((definition) =>
    resolveConfigEntry(definition, snapshot),
  );
};

const printConfigList = async (args: ParsedCliArgs): Promise<void> => {
  const entries = await loadCliConfigEntries(args.workspaceRoot);
  const runtime = await loadRuntimeConfig(args.workspaceRoot);

  if (args.json) {
    writeStdoutLine(
      JSON.stringify(
        {
          workspaceRoot: args.workspaceRoot,
          workspaceConfigPath: runtime.workspaceConfigPath ?? null,
          userConfigPath: runtime.userConfigPath ?? null,
          settings: entries,
        },
        null,
        2,
      ),
    );
    return;
  }

  const style = createCliStyle();
  writeStdoutLine(style.heading("Machdoch configuration settings"));
  writeStdoutLine(style.muted(`Workspace: ${args.workspaceRoot}`));

  for (const category of Array.from(
    new Set(entries.map((entry) => entry.category)),
  )) {
    writeStdoutLine();
    writeStdoutLine(style.label(category));
    const rows = entries
      .filter((entry) => entry.category === category)
      .map(
        (entry) =>
          [
            entry.setting,
            `${String(entry.value)} ${style.muted(`(${entry.source})`)}`,
          ] as const,
      );
    for (const line of formatKeyValueRows(rows)) writeStdoutLine(line);
  }

  writeStdoutLine();
  writeStdoutLine(
    style.muted(
      "Use `machdoch config get <setting>` for details or `machdoch config edit` for the interactive editor.",
    ),
  );
};

const printConfigEntry = async (args: ParsedCliArgs): Promise<void> => {
  const requested =
    args.config?.setting?.trim().toLowerCase() ??
    fail("Expected `machdoch config get <setting>`.");
  const entry = (await loadCliConfigEntries(args.workspaceRoot)).find(
    (candidate) => candidate.setting === requested,
  );
  if (!entry) return unsupportedConfigSetting(requested);

  if (args.json) {
    writeStdoutLine(JSON.stringify(entry, null, 2));
    return;
  }

  const style = createCliStyle();
  writeStdoutLine(style.heading(entry.setting));
  for (const line of formatKeyValueRows([
    ["Value", String(entry.value)],
    ["Source", entry.source],
    ["Scope", entry.scope],
    ["Accepted", entry.acceptedValues],
  ])) {
    writeStdoutLine(line);
  }
  writeStdoutLine();
  writeStdoutLine(entry.description);
};

export const printConfigSummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const config = await loadRuntimeConfig(
    args.workspaceRoot,
    args.mode,
    args.model,
    args.runtimeProvider,
    args.agentLimits,
    args.reasoning,
  );
  const memorySettings = await loadUserMemorySettings();
  const agentLimits = resolveRuntimeAgentLimits(config);
  const formatLimit = (limit: number | null): string =>
    limit === null ? "infinite" : String(limit);

  if (args.json) {
    writeStdoutLine(JSON.stringify(config, null, 2));
    return;
  }

  const style = createCliStyle();
  const activeWebSearchConfigured =
    config.webSearch.activeProvider !== "none" &&
    config.webSearch.providerAvailability.some(
      (entry) =>
        entry.provider === config.webSearch.activeProvider && entry.configured,
    );

  writeStdoutLine(style.heading("Machdoch configuration"));
  for (const line of formatKeyValueRows([
    ["Workspace", config.workspaceRoot],
    ["Workspace config", config.workspaceConfigPath ?? "not present"],
    ["User config", config.userConfigPath ?? "unknown"],
  ])) {
    writeStdoutLine(line);
  }
  for (const line of createUserConfigSummaryLines(config.userConfigPath).slice(
    1,
  )) {
    writeStdoutLine(style.warning(line));
  }

  writeStdoutLine();
  writeStdoutLine(style.label("Runtime"));
  for (const line of formatKeyValueRows([
    ["Mode", config.mode],
    ["Provider", config.provider],
    ["Model", config.model],
    ["Reasoning", config.reasoning],
    ["Reasoning mode", config.reasoningMode ?? "standard"],
    ["Context window", String(config.contextWindow ?? "default")],
    ["Offline", String(config.offline)],
    ["Executor turns", formatLimit(agentLimits.executorTurns)],
    [
      "Machdoch continuations",
      formatLimit(agentLimits.autopilotExecutorIterations),
    ],
    [
      "Review model",
      config.reviewModel.mode === "dedicated"
        ? `${config.reviewModel.provider}:${config.reviewModel.model}`
        : "base model",
    ],
  ])) {
    writeStdoutLine(line);
  }

  writeStdoutLine();
  writeStdoutLine(style.label("Capabilities"));
  for (const line of formatKeyValueRows([
    ["Web search provider", config.webSearch.activeProvider],
    [
      "Web search status",
      activeWebSearchConfigured ? "available" : "not available",
    ],
    [
      "Global memory",
      `${memorySettings.globalEnabled ? "enabled" : "disabled"} (${memorySettings.entries.length} saved fact${memorySettings.entries.length === 1 ? "" : "s"})`,
    ],
    [
      "GitHub customizations",
      config.compatibility.discoverGithubCustomizations
        ? "enabled"
        : "disabled",
    ],
  ])) {
    writeStdoutLine(line);
  }

  writeStdoutLine();
  writeStdoutLine(style.label("Provider availability"));
  for (const line of formatKeyValueRows(
    config.providerAvailability.map((entry) => [
      entry.provider,
      entry.configured ? "configured" : "not configured",
    ]),
  )) {
    writeStdoutLine(line);
  }

  writeStdoutLine();
  writeStdoutLine(
    style.muted(
      "Run `machdoch config list` to inspect every setting or `machdoch config edit` to configure interactively.",
    ),
  );
};

export const printSetConfigSummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const setting =
    args.config?.setting ?? fail("No config setting was provided.");
  const value = args.config?.value ?? fail("No config value was provided.");
  const result = await saveConfigSetting(args.workspaceRoot, setting, value);

  if (args.json) {
    writeStdoutLine(JSON.stringify(result, null, 2));
    return;
  }

  const style = createCliStyle();
  writeStdoutLine(style.success("Configuration updated"));
  for (const line of formatKeyValueRows([
    ["Setting", result.setting],
    ...(result.value !== undefined
      ? [["Value", String(result.value)] as const]
      : []),
    ["Scope", result.scope],
    ["Config file", result.configPath],
  ])) {
    writeStdoutLine(line);
  }
};

const printUnsetConfigSummary = async (args: ParsedCliArgs): Promise<void> => {
  const setting =
    args.config?.setting ?? fail("No config setting was provided.");
  const result = await clearConfigSetting(args.workspaceRoot, setting);

  if (args.json) {
    writeStdoutLine(JSON.stringify(result, null, 2));
    return;
  }

  const style = createCliStyle();
  writeStdoutLine(style.success("Configuration reset"));
  for (const line of formatKeyValueRows([
    ["Setting", result.setting],
    ["Scope", result.scope],
    ["Config file", result.configPath],
  ])) {
    writeStdoutLine(line);
  }
  writeStdoutLine(
    style.muted("The effective default or environment value now applies."),
  );
};

export const runConfigCommand = async (args: ParsedCliArgs): Promise<void> => {
  switch (args.config?.action ?? "show") {
    case "show":
      await printConfigSummary(args);
      return;
    case "list":
      await printConfigList(args);
      return;
    case "get":
      await printConfigEntry(args);
      return;
    case "set":
      await printSetConfigSummary(args);
      return;
    case "unset":
      await printUnsetConfigSummary(args);
      return;
    case "edit": {
      if (args.json) {
        fail("Interactive configuration does not support --json.");
      }
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        fail(
          "Interactive configuration requires a terminal. Use `machdoch config list` and `machdoch config set <setting> <value>` in scripts.",
        );
      }
      const { runInteractiveConfig } =
        await import("./cli-config-interactive.js");
      await runInteractiveConfig(args.workspaceRoot);
      return;
    }
  }
};
