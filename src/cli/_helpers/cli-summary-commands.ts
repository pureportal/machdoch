import {
  loadRuntimeConfig,
  saveWorkspaceDefaultModel,
  saveWorkspaceDefaultMode,
  saveWorkspaceOffline,
  saveWorkspaceReasoningMode,
  saveWorkspaceRuntimeProvider,
} from "../../core/config.js";
import { discoverCustomizations } from "../../core/customizations.js";
import {
  loadUserAgentLimitsSettings,
  loadUserMemorySettings,
  saveUserAgentCliPath,
  saveUserApiKey,
  saveUserAgentLimitsSettings,
  saveUserDesktopSettingsPatch,
  saveUserGlobalMemoryEnabled,
  saveUserSpeechToTextActiveProvider,
  saveUserSpeechToTextInputDevice,
  saveUserVoiceActiveProvider,
  saveUserWebSearchActiveProvider,
  saveUserWebSearchApiKey,
} from "../../core/env.js";
import {
  DESKTOP_SETTING_BOUNDS,
  isAgentCliProvider,
  isUserApiProvider,
  isUserWebSearchProvider,
  isVoiceAiProvider,
  isWebSearchProvider,
} from "../../core/runtime-contract.generated.js";
import type {
  AgentCliProvider,
  SpeechToTextProvider,
  UserDesktopSettings,
  UserWebSearchProvider,
  VoiceAiProvider,
  WebSearchProvider,
} from "../../core/runtime-contract.generated.js";
import { getToolRegistry } from "../../core/tools.js";
import { createToolDefinitions } from "../../core/_helpers/agent-tools.js";
import { resolveRuntimeAgentLimits } from "../../core/_helpers/agent-runtime-types.js";
import type { ToolName } from "../../core/runtime-contract.generated.js";
import type { ParsedCliArgs } from "./cli-args.js";
import { writeStdoutLine } from "./cli-io.js";
import {
  createDiscoveryOptions,
  createUserConfigSummaryLines,
  formatProfileLine,
} from "./cli-output.js";

interface ConfigSetResult {
  setting: string;
  scope: "user" | "workspace";
  configPath: string;
  status: string;
  value?: string | number | boolean;
}

type DesktopSettingValueType = "boolean" | "integer" | "number" | "string";

interface DesktopConfigSetting {
  key: keyof UserDesktopSettings;
  type: DesktopSettingValueType;
  min?: number;
  max?: number;
}

const DESKTOP_CONFIG_SETTINGS = {
  "autostart-enabled": {
    key: "autostartEnabled",
    type: "boolean",
  },
  "autostart-minimized": {
    key: "autostartMinimized",
    type: "boolean",
  },
  "autostart-to-tray": {
    key: "autostartToTray",
    type: "boolean",
  },
  "always-run-as-administrator": {
    key: "alwaysRunAsAdministrator",
    type: "boolean",
  },
  "assistant-bubble-enabled": {
    key: "assistantBubbleEnabled",
    type: "boolean",
  },
  "assistant-bubble-hide-when-fullscreen": {
    key: "assistantBubbleHideWhenFullscreen",
    type: "boolean",
  },
  "assistant-bubble-temporarily-hide-seconds": {
    key: "assistantBubbleTemporarilyHideSeconds",
    type: "number",
    ...DESKTOP_SETTING_BOUNDS.assistantBubbleTemporarilyHideSeconds,
  },
  "ai-context-max-messages": {
    key: "aiContextMaxMessages",
    type: "integer",
    ...DESKTOP_SETTING_BOUNDS.aiContextMaxMessages,
  },
  "inactive-session-archive-days": {
    key: "inactiveSessionArchiveDays",
    type: "integer",
    ...DESKTOP_SETTING_BOUNDS.inactiveSessionArchiveDays,
  },
  "archived-session-retention-days": {
    key: "archivedSessionRetentionDays",
    type: "integer",
    ...DESKTOP_SETTING_BOUNDS.archivedSessionRetentionDays,
  },
  "quick-voice-enabled": {
    key: "quickVoiceEnabled",
    type: "boolean",
  },
  "quick-voice-shortcut": {
    key: "quickVoiceShortcut",
    type: "string",
  },
  "quick-voice-silence-seconds": {
    key: "quickVoiceSilenceSeconds",
    type: "number",
    ...DESKTOP_SETTING_BOUNDS.quickVoiceSilenceSeconds,
  },
  "quick-voice-max-messages": {
    key: "quickVoiceMaxMessages",
    type: "integer",
    ...DESKTOP_SETTING_BOUNDS.quickVoiceMaxMessages,
  },
} as const satisfies Record<string, DesktopConfigSetting>;

const isDesktopConfigSetting = (
  setting: string,
): setting is keyof typeof DESKTOP_CONFIG_SETTINGS => {
  return setting in DESKTOP_CONFIG_SETTINGS;
};

const SUPPORTED_CONFIG_SET_SETTINGS = [
  "api.<openai|anthropic|google>.key",
  "agent-cli.<codex-cli|claude-cli|copilot-cli>.path",
  "web-search.provider",
  "web-search.<perplexity|tavily|serper>.key",
  "voice.provider",
  "speech-to-text.provider",
  "speech-to-text.input-device",
  "desktop.<desktop-setting>",
  "memory.global",
  "agent-limits.infinite",
  "agent-limits.executor-turns",
  "agent-limits.autopilot-iterations",
  "workspace.model",
  "workspace.provider",
  "workspace.mode",
  "workspace.reasoning",
  "workspace.offline",
] as const;

const fail = (message: string): never => {
  throw new Error(message);
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

const parseConfigPositiveInteger = (
  setting: string,
  value: string,
): number => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    return fail(`Expected ${setting} to be followed by a positive integer.`);
  }

  return parsed;
};

const parseConfigNumber = (
  setting: string,
  value: string,
  options: {
    integer: boolean;
    min?: number;
    max?: number;
  },
): number => {
  const parsed = Number(value);

  if (
    !Number.isFinite(parsed) ||
    (options.integer && !Number.isInteger(parsed)) ||
    (options.min !== undefined && parsed < options.min) ||
    (options.max !== undefined && parsed > options.max)
  ) {
    const range =
      options.min !== undefined && options.max !== undefined
        ? ` between ${options.min} and ${options.max}`
        : "";
    const kind = options.integer ? "an integer" : "a number";

    return fail(`Expected ${setting} to be ${kind}${range}.`);
  }

  return parsed;
};

const unsupportedConfigSetting = (setting: string): never => {
  return fail(
    `Unsupported config setting \`${setting}\`. Supported settings: ${SUPPORTED_CONFIG_SET_SETTINGS.join(", ")}.`,
  );
};

const unsupportedDesktopConfigSetting = (setting: string): never => {
  return fail(
    `Unsupported desktop setting \`desktop.${setting}\`. Supported desktop settings: ${Object.keys(
      DESKTOP_CONFIG_SETTINGS,
    )
      .map((desktopSetting) => `desktop.${desktopSetting}`)
      .join(", ")}.`,
  );
};

const parseDesktopSettingValue = (
  setting: string,
  value: string,
): {
  patch: Partial<UserDesktopSettings>;
  value: string | number | boolean;
} => {
  if (!isDesktopConfigSetting(setting)) {
    return unsupportedDesktopConfigSetting(setting);
  }

  const desktopSetting = DESKTOP_CONFIG_SETTINGS[setting];
  let parsedValue: string | number | boolean;

  switch (desktopSetting.type) {
    case "boolean": {
      parsedValue = parseConfigBoolean(`desktop.${setting}`, value);
      break;
    }
    case "integer":
    case "number": {
      parsedValue = parseConfigNumber(`desktop.${setting}`, value, {
        integer: desktopSetting.type === "integer",
        ...(desktopSetting.min !== undefined ? { min: desktopSetting.min } : {}),
        ...(desktopSetting.max !== undefined ? { max: desktopSetting.max } : {}),
      });
      break;
    }
    case "string": {
      const normalizedValue = value.trim();

      if (!normalizedValue) {
        return fail(`Expected desktop.${setting} to be non-empty.`);
      }

      parsedValue = normalizedValue;
      break;
    }
    default: {
      return fail(`Unsupported desktop.${setting} value type.`);
    }
  }

  return {
    patch: {
      [desktopSetting.key]: parsedValue,
    },
    value: parsedValue,
  };
};

const saveConfigSetting = async (
  workspaceRoot: string,
  setting: string,
  value: string,
): Promise<ConfigSetResult> => {
  const normalizedSetting = setting.trim().toLowerCase();
  const parts = normalizedSetting.split(".");

  if (
    parts.length === 3 &&
    parts[0] === "api" &&
    parts[2] === "key"
  ) {
    const provider = parts[1];

    if (!isUserApiProvider(provider)) {
      return unsupportedConfigSetting(setting);
    }

    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserApiKey(provider, value),
      status: "configured",
    };
  }

  if (
    parts.length === 3 &&
    parts[0] === "agent-cli" &&
    parts[2] === "path"
  ) {
    const provider = parts[1];

    if (!isAgentCliProvider(provider)) {
      return unsupportedConfigSetting(setting);
    }

    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserAgentCliPath(
        provider as AgentCliProvider,
        value,
      ),
      status: "configured",
      value,
    };
  }

  if (normalizedSetting === "web-search.provider") {
    if (!isWebSearchProvider(value)) {
      fail(
        "Expected web-search.provider to be one of none, perplexity, tavily, or serper.",
      );
    }

    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserWebSearchActiveProvider(
        value as WebSearchProvider,
      ),
      status: "configured",
      value,
    };
  }

  if (
    parts.length === 3 &&
    parts[0] === "web-search" &&
    parts[2] === "key"
  ) {
    const provider = parts[1];

    if (!isUserWebSearchProvider(provider)) {
      return unsupportedConfigSetting(setting);
    }

    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserWebSearchApiKey(
        provider as UserWebSearchProvider,
        value,
      ),
      status: "configured",
    };
  }

  if (normalizedSetting === "voice.provider") {
    if (!isVoiceAiProvider(value)) {
      fail("Expected voice.provider to be one of none, openai, or google.");
    }

    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserVoiceActiveProvider(value as VoiceAiProvider),
      status: "configured",
      value,
    };
  }

  if (normalizedSetting === "speech-to-text.provider") {
    if (!isVoiceAiProvider(value)) {
      fail(
        "Expected speech-to-text.provider to be one of none, openai, or google.",
      );
    }

    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserSpeechToTextActiveProvider(
        value as SpeechToTextProvider,
      ),
      status: "configured",
      value,
    };
  }

  if (normalizedSetting === "speech-to-text.input-device") {
    const normalizedValue = value.trim();
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
    const parsed = parseDesktopSettingValue(parts[1] ?? "", value);

    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserDesktopSettingsPatch(parsed.patch),
      status: "configured",
      value: parsed.value,
    };
  }

  if (normalizedSetting === "memory.global") {
    const enabled = parseConfigBoolean(normalizedSetting, value);

    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserGlobalMemoryEnabled(enabled),
      status: "configured",
      value: enabled,
    };
  }

  if (normalizedSetting === "agent-limits.infinite") {
    const infinite = parseConfigBoolean(normalizedSetting, value);
    const currentSettings = await loadUserAgentLimitsSettings();

    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserAgentLimitsSettings({
        ...currentSettings,
        infinite,
      }),
      status: "configured",
      value: infinite,
    };
  }

  if (normalizedSetting === "agent-limits.executor-turns") {
    const executorTurns = parseConfigPositiveInteger(normalizedSetting, value);
    const currentSettings = await loadUserAgentLimitsSettings();

    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserAgentLimitsSettings({
        ...currentSettings,
        infinite: false,
        executorTurns,
      }),
      status: "configured",
      value: executorTurns,
    };
  }

  if (normalizedSetting === "agent-limits.autopilot-iterations") {
    const autopilotExecutorIterations = parseConfigPositiveInteger(
      normalizedSetting,
      value,
    );
    const currentSettings = await loadUserAgentLimitsSettings();

    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserAgentLimitsSettings({
        ...currentSettings,
        infinite: false,
        autopilotExecutorIterations,
      }),
      status: "configured",
      value: autopilotExecutorIterations,
    };
  }

  if (normalizedSetting === "workspace.model") {
    return {
      setting: normalizedSetting,
      scope: "workspace",
      configPath: await saveWorkspaceDefaultModel(workspaceRoot, value),
      status: "configured",
      value,
    };
  }

  if (normalizedSetting === "workspace.provider") {
    return {
      setting: normalizedSetting,
      scope: "workspace",
      configPath: await saveWorkspaceRuntimeProvider(workspaceRoot, value),
      status: "configured",
      value,
    };
  }

  if (normalizedSetting === "workspace.mode") {
    return {
      setting: normalizedSetting,
      scope: "workspace",
      configPath: await saveWorkspaceDefaultMode(workspaceRoot, value),
      status: "configured",
      value,
    };
  }

  if (normalizedSetting === "workspace.reasoning") {
    return {
      setting: normalizedSetting,
      scope: "workspace",
      configPath: await saveWorkspaceReasoningMode(workspaceRoot, value),
      status: "configured",
      value,
    };
  }

  if (normalizedSetting === "workspace.offline") {
    const offline = parseConfigBoolean(normalizedSetting, value);

    return {
      setting: normalizedSetting,
      scope: "workspace",
      configPath: await saveWorkspaceOffline(workspaceRoot, offline),
      status: "configured",
      value: offline,
    };
  }

  return unsupportedConfigSetting(setting);
};

export const printConfigSummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const config = await loadRuntimeConfig(
    args.workspaceRoot,
    args.mode,
    args.profile,
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

  const activeWebSearchConfigured =
    config.webSearch.activeProvider !== "none" &&
    config.webSearch.providerAvailability.some(
      (entry) =>
        entry.provider === config.webSearch.activeProvider && entry.configured,
    );

  writeStdoutLine(`workspace: ${config.workspaceRoot}`);
  writeStdoutLine(
    `workspace config: ${config.workspaceConfigPath ?? "not present"}`,
  );
  for (const line of createUserConfigSummaryLines(config.userConfigPath)) {
    writeStdoutLine(line);
  }
  writeStdoutLine(`profile: ${config.activeProfile ?? "none"}`);
  writeStdoutLine(`mode: ${config.mode}`);
  writeStdoutLine(`provider: ${config.provider}`);
  writeStdoutLine(`model: ${config.model}`);
  writeStdoutLine(`reasoning: ${config.reasoning}`);
  writeStdoutLine(`offline: ${config.offline ? "true" : "false"}`);
  writeStdoutLine(`executor turns: ${formatLimit(agentLimits.executorTurns)}`);
  writeStdoutLine(
    `machdoch continuations: ${formatLimit(agentLimits.autopilotExecutorIterations)}`,
  );
  writeStdoutLine(`web search provider: ${config.webSearch.activeProvider}`);
  writeStdoutLine(
    `web search status: ${activeWebSearchConfigured ? "available" : "hidden"}`,
  );
  writeStdoutLine(
    `global memory: ${memorySettings.globalEnabled ? "enabled" : "disabled"} (${memorySettings.entries.length} saved fact${memorySettings.entries.length === 1 ? "" : "s"})`,
  );
  if (config.availableProfiles.length > 0) {
    writeStdoutLine("profiles:");
    for (const profile of config.availableProfiles) {
      writeStdoutLine(formatProfileLine(profile, config.activeProfile));
    }
  }
  writeStdoutLine("provider availability:");

  for (const entry of config.providerAvailability) {
    writeStdoutLine(
      `  - ${entry.provider}: ${entry.configured ? "configured" : "not configured"}`,
    );
  }
};

export const printCustomizationSummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const config = await loadRuntimeConfig(
    args.workspaceRoot,
    args.mode,
    args.profile,
    args.model,
    args.runtimeProvider,
    args.agentLimits,
    args.reasoning,
  );
  const customizations = await discoverCustomizations(
    args.workspaceRoot,
    createDiscoveryOptions(config.compatibility.discoverGithubCustomizations),
  );

  if (args.json) {
    writeStdoutLine(JSON.stringify(customizations, null, 2));
    return;
  }

  writeStdoutLine(`workspace: ${customizations.workspaceRoot}`);
  writeStdoutLine(`profile: ${config.activeProfile ?? "none"}`);
  writeStdoutLine(
    `github compatibility: ${config.compatibility.discoverGithubCustomizations ? "enabled" : "disabled"}`,
  );
  writeStdoutLine(`instructions: ${customizations.instructions.length}`);
  for (const entry of customizations.instructions) {
    writeStdoutLine(`  - [${entry.kind}] ${entry.path}`);
  }
  writeStdoutLine(`prompts: ${customizations.prompts.length}`);
  for (const entry of customizations.prompts) {
    writeStdoutLine(`  - ${entry.name} (${entry.path})`);
  }
  writeStdoutLine(`skills: ${customizations.skills.length}`);
  for (const entry of customizations.skills) {
    writeStdoutLine(`  - ${entry.name} (${entry.path})`);
  }
};

export const printToolSummary = async (args: ParsedCliArgs): Promise<void> => {
  const config = await loadRuntimeConfig(
    args.workspaceRoot,
    args.mode,
    args.profile,
    args.model,
    args.runtimeProvider,
    args.agentLimits,
    args.reasoning,
  );
  const agentTools = createToolDefinitions(config, {
    sessionEnabled: false,
    sessionEntries: [],
    globalEnabled: false,
    globalEntries: [],
  });
  const agentToolsByBackingTool = new Map(
    getToolRegistry().map((tool) => [
      tool.name,
      agentTools
        .filter((agentTool) => agentTool.backingTool === tool.name)
        .sort((left, right) => left.spec.name.localeCompare(right.spec.name)),
    ] satisfies [ToolName, typeof agentTools]),
  );

  if (args.json) {
    writeStdoutLine(
      JSON.stringify(
        {
          workspaceRoot: config.workspaceRoot,
          mode: config.mode,
          modeSurface:
            config.mode === "ask"
              ? "read-only function calls"
              : "all function calls",
          tools: getToolRegistry(),
          agentTools: agentTools.map((agentTool) => ({
            name: agentTool.spec.name,
            backingTool: agentTool.backingTool,
            riskLevel: agentTool.riskLevel,
            effect: agentTool.effect,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  writeStdoutLine(`workspace: ${config.workspaceRoot}`);
  writeStdoutLine(`profile: ${config.activeProfile ?? "none"}`);
  writeStdoutLine(`mode: ${config.mode}`);
  writeStdoutLine(
    `function-call surface: ${
      config.mode === "ask" ? "read-only calls only" : "all calls"
    }`,
  );
  writeStdoutLine(`registered tools: ${getToolRegistry().length}`);
  writeStdoutLine(`agent tools: ${agentTools.length}`);

  for (const tool of getToolRegistry()) {
    writeStdoutLine(`- ${tool.name} [${tool.riskLevel}]`);
    writeStdoutLine(`  ${tool.description}`);

    const backingAgentTools = agentToolsByBackingTool.get(tool.name);

    if (backingAgentTools && backingAgentTools.length > 0) {
      writeStdoutLine("  agent tools:");

      for (const agentTool of backingAgentTools) {
        writeStdoutLine(
          `    - ${agentTool.spec.name} [${agentTool.riskLevel}]`,
        );
      }
    }
  }
};

export const printProfileSummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const config = await loadRuntimeConfig(
    args.workspaceRoot,
    args.mode,
    args.profile,
    args.model,
    args.runtimeProvider,
    args.agentLimits,
    args.reasoning,
  );

  if (args.json) {
    writeStdoutLine(
      JSON.stringify(
        {
          workspaceRoot: config.workspaceRoot,
          activeProfile: config.activeProfile ?? null,
          availableProfiles: config.availableProfiles,
        },
        null,
        2,
      ),
    );
    return;
  }

  writeStdoutLine(`workspace: ${config.workspaceRoot}`);
  writeStdoutLine(`active profile: ${config.activeProfile ?? "none"}`);

  if (config.availableProfiles.length === 0) {
    writeStdoutLine("profiles: none configured");
    return;
  }

  writeStdoutLine("profiles:");
  for (const profile of config.availableProfiles) {
    writeStdoutLine(formatProfileLine(profile, config.activeProfile));
  }
};

export const printDefaultModelSummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const model = args.defaultModel ?? fail("No default model was provided.");
  const configPath = await saveWorkspaceDefaultModel(args.workspaceRoot, model);

  if (args.json) {
    writeStdoutLine(
      JSON.stringify(
        {
          workspaceRoot: args.workspaceRoot,
          configPath,
          model,
        },
        null,
        2,
      ),
    );
    return;
  }

  writeStdoutLine(`workspace: ${args.workspaceRoot}`);
  writeStdoutLine(`updated config: ${configPath}`);
  writeStdoutLine(`default model: ${model}`);
};

export const printSetApiSummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const provider = args.provider ?? fail("No provider was provided.");
  const key = args.key ?? fail("No API key was provided.");
  const configPath = await saveUserApiKey(provider, key);

  if (args.json) {
    writeStdoutLine(
      JSON.stringify(
        {
          provider,
          configured: true,
          configPath,
        },
        null,
        2,
      ),
    );
    return;
  }

  writeStdoutLine(`provider: ${provider}`);
  writeStdoutLine(`updated user config: ${configPath}`);
  writeStdoutLine("status: configured");
};

export const printSetConfigSummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const setting = args.configSetting ?? fail("No config setting was provided.");
  const value = args.configValue ?? fail("No config value was provided.");
  const result = await saveConfigSetting(args.workspaceRoot, setting, value);

  if (args.json) {
    writeStdoutLine(JSON.stringify(result, null, 2));
    return;
  }

  writeStdoutLine(`setting: ${result.setting}`);
  writeStdoutLine(`updated ${result.scope} config: ${result.configPath}`);

  if (result.value !== undefined) {
    writeStdoutLine(`value: ${String(result.value)}`);
  }

  writeStdoutLine(`status: ${result.status}`);
};

export const printSetGlobalMemorySummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const enabled =
    args.setGlobalMemoryEnabled ??
    fail("No global-memory setting was provided.");
  const configPath = await saveUserGlobalMemoryEnabled(enabled);

  if (args.json) {
    writeStdoutLine(
      JSON.stringify(
        {
          globalMemoryEnabled: enabled,
          configPath,
        },
        null,
        2,
      ),
    );
    return;
  }

  writeStdoutLine(`updated user config: ${configPath}`);
  writeStdoutLine(`global memory: ${enabled ? "enabled" : "disabled"}`);
};
