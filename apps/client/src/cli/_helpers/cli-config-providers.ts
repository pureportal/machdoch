import {
  clearUserConfigValue,
  hasConfiguredValue,
  saveUserAgentCliPath,
  saveUserApiKey,
  saveUserSpeechToTextActiveProvider,
  saveUserSpeechToTextInputDevice,
  saveUserVoiceActiveProvider,
  saveUserWebSearchActiveProvider,
  saveUserWebSearchApiKey,
} from "../../core/env.js";
import {
  AGENT_CLI_PROVIDER_ENV_KEY_BY_PROVIDER,
  PROVIDER_ENV_KEY_BY_PROVIDER,
  USER_API_PROVIDERS,
  USER_WEB_SEARCH_PROVIDERS,
  VALID_SPEECH_TO_TEXT_PROVIDERS,
  WEB_SEARCH_ENV_KEY_BY_PROVIDER,
  isAgentCliProvider,
  isUserApiProvider,
  isUserWebSearchProvider,
  isVoiceAiProvider,
  isWebSearchProvider,
} from "../../core/runtime-contract.generated.js";
import type {
  AgentCliProvider,
  SpeechToTextProvider,
  UserApiProvider,
  UserWebSearchProvider,
  VoiceAiProvider,
  WebSearchProvider,
} from "../../core/runtime-contract.generated.js";
import type {
  CliConfigFamily,
  CliConfigSettingDefinition,
  CliConfigEntry,
  ConfigSetResult,
} from "./cli-config-types.js";
import type { ConfigSnapshot } from "./cli-config-snapshot.js";
import {
  fail,
  unsupportedConfigSetting,
  configSource,
} from "./cli-config-values.js";
const VOICE_PROVIDER_CHOICES = ["none", "openai", "google"] as const;

const WEB_SEARCH_PROVIDER_CHOICES = [
  "none",
  ...USER_WEB_SEARCH_PROVIDERS,
] as const;

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

export const PROVIDER_CONFIG_DEFINITIONS: readonly CliConfigSettingDefinition[] =
  [
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
  ];
export const VOICE_CONFIG_DEFINITIONS: readonly CliConfigSettingDefinition[] = [
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
    acceptedValues: VALID_SPEECH_TO_TEXT_PROVIDERS.join("|"),
    choices: VALID_SPEECH_TO_TEXT_PROVIDERS,
  },
  {
    setting: "speech-to-text.input-device",
    category: "Voice",
    scope: "user",
    description: "Preferred audio input device id, or none.",
    acceptedValues: "device id|none",
  },
];
const PROVIDERS_CONFIG_DEFINITIONS = [
  ...PROVIDER_CONFIG_DEFINITIONS,
  ...VOICE_CONFIG_DEFINITIONS,
];

const saveProvidersConfigSetting = async (
  _workspaceRoot: string,
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
    if (
      !VALID_SPEECH_TO_TEXT_PROVIDERS.includes(
        normalizedValue as SpeechToTextProvider,
      )
    ) {
      fail(
        `Expected speech-to-text.provider to be one of ${VALID_SPEECH_TO_TEXT_PROVIDERS.join(", ")}.`,
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
  return unsupportedConfigSetting(setting);
};

const resetSetting = async (
  _workspaceRoot: string,
  setting: string,
): Promise<ConfigSetResult> => {
  const normalizedSetting = setting.trim().toLowerCase();
  const parts = normalizedSetting.split(".");
  let path: readonly string[];
  if (parts[0] === "api") path = ["apiKeys", parts[1]!];
  else if (parts[0] === "agent-cli") path = ["agentCliPaths", parts[1]!];
  else if (parts[0] === "web-search" && parts[2] === "key")
    path = ["webSearch", "apiKeys", parts[1]!];
  else if (normalizedSetting === "web-search.provider")
    path = ["webSearch", "activeProvider"];
  else if (normalizedSetting === "voice.provider")
    path = ["voice", "activeProvider"];
  else if (normalizedSetting === "speech-to-text.provider")
    path = ["speechToText", "activeProvider"];
  else path = ["speechToText", "inputDeviceId"];
  return {
    setting: normalizedSetting,
    scope: "user",
    configPath: await clearUserConfigValue(path),
    status: "reset",
  };
};

const resolveEntry = (
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
  } else {
    switch (setting) {
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
      case "voice.provider":
        value = snapshot.userConfig.voice?.activeProvider ?? "none";
        source = configSource(snapshot.userConfig.voice?.activeProvider);
        break;
      case "speech-to-text.provider":
        value = snapshot.userConfig.speechToText?.activeProvider ?? "whisper";
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

export const providersConfigFamily: CliConfigFamily = {
  definitions: PROVIDERS_CONFIG_DEFINITIONS,
  save: saveProvidersConfigSetting,
  reset: resetSetting,
  resolve: resolveEntry,
};
