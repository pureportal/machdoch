import {
  requestDesktopSettings,
  readDesktopSettingsDescriptor,
} from "./cli-desktop-settings-bridge.js";
import {
  CHAT_DEFAULT_SHELL_KEYS,
  loadChatDefaultState,
  saveChatPreference,
} from "../../core/chat-defaults.js";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_MODEL_PROVIDER,
  REASONING_MODES,
  VALID_MODEL_PROVIDERS,
} from "../../core/runtime-contract.generated.js";
import { CliUsageError } from "./cli-error.js";
import { getObjectValue } from "./cli-config-additional.js";
import type {
  CliConfigFamily,
  ConfigSetResult,
  CliConfigEntry,
  CliConfigSettingDefinition,
} from "./cli-config-types.js";

interface DesktopConfigDefinition extends CliConfigSettingDefinition {
  nativeSetting: string;
  path: readonly string[];
  type: "boolean" | "string" | "number";
  defaultValue: string | number | boolean;
  nullable?: boolean;
  consequence?: string;
}

const definition = (
  setting: string,
  label: string,
  category: string,
  nativeSetting: string,
  path: readonly string[],
  type: DesktopConfigDefinition["type"],
  defaultValue: DesktopConfigDefinition["defaultValue"],
  choices?: readonly string[],
): DesktopConfigDefinition => ({
  setting,
  label,
  category,
  nativeSetting,
  path,
  type,
  defaultValue,
  scope: "user",
  description: label,
  acceptedValues: choices?.join("|") ?? type,
  ...(choices ? { choices } : {}),
});

export const DESKTOP_CONFIG_DEFINITIONS: readonly DesktopConfigDefinition[] = [
  definition(
    "appearance.theme",
    "Theme",
    "Appearance",
    "appearance.theme",
    ["appearance", "theme"],
    "string",
    "dark",
    ["dark", "light"],
  ),
  definition(
    "appearance.density",
    "Density",
    "Appearance",
    "appearance.density",
    ["appearance", "density"],
    "string",
    "comfortable",
    ["comfortable", "compact"],
  ),
  definition(
    "appearance.accent",
    "Accent",
    "Appearance",
    "appearance.accent",
    ["appearance", "accent"],
    "string",
    "sky",
    ["sky", "emerald", "violet", "amber"],
  ),
  definition(
    "defaults.provider",
    "Provider",
    "New chat defaults",
    "defaults.provider",
    ["defaults", "newChat", "provider"],
    "string",
    "openai",
    VALID_MODEL_PROVIDERS,
  ),
  definition(
    "defaults.model",
    "Model",
    "New chat defaults",
    "defaults.model",
    [],
    "string",
    "",
  ),
  {
    ...definition(
      "defaults.mode",
      "Mode",
      "New chat defaults",
      "defaults.mode",
      ["defaults", "newChat", "mode"],
      "string",
      "inherit",
      ["inherit", "ask", "machdoch"],
    ),
    nullable: true,
  },
  {
    ...definition(
      "defaults.reasoning",
      "Reasoning",
      "New chat defaults",
      "defaults.reasoning",
      ["defaults", "newChat", "reasoning"],
      "string",
      "inherit",
      ["inherit", ...REASONING_MODES],
    ),
    nullable: true,
  },
  ...(
    [
      ["session-memory", "Session memory", "sessionMemoryEnabled", true],
      ["workspace-memory", "Workspace memory", "useWorkspaceMemory", true],
      ["global-memory", "Global memory", "useGlobalMemory", true],
      ["ui-control", "Desktop control", "uiControlEnabled", false],
    ] as const
  ).map(([name, label, key, enabled]) =>
    definition(
      `defaults.${name}`,
      label,
      "New chat defaults",
      `defaults.${key}`,
      ["defaults", "newChat", key],
      "boolean",
      enabled,
      ["on", "off"],
    ),
  ),
  definition(
    "spoken-reply.enabled",
    "Speak responses",
    "Voice",
    "spoken-reply.autoSpeakResponses",
    ["defaults", "voice", "autoSpeakResponses"],
    "boolean",
    false,
    ["on", "off"],
  ),
  definition(
    "spoken-reply.rate",
    "Speech rate",
    "Voice",
    "spoken-reply.rate",
    ["defaults", "voice", "rate"],
    "number",
    1,
  ),
  definition(
    "desktop.autostart-enabled",
    "Start at sign-in",
    "Desktop",
    "desktop.autostartEnabled",
    ["desktop", "autostartEnabled"],
    "boolean",
    false,
    ["on", "off"],
  ),
  definition(
    "desktop.running-message-action",
    "Messages while running",
    "New chat defaults",
    "desktop.running-message-action",
    ["defaults", "runningTaskMessageAction"],
    "string",
    "queue",
    ["steer", "stop-and-send", "queue"],
  ),
  {
    ...definition(
      "assets.folder",
      "Asset folder",
      "Asset storage",
      "assets.folder",
      ["assets", "folder"],
      "string",
      "",
    ),
    consequence: "Move all Media Studio assets to this folder?",
  },
  {
    ...definition(
      "civitai.key",
      "Civitai API key",
      "Providers",
      "civitai.key",
      ["civitai"],
      "string",
      "",
    ),
    secret: true,
  },
];

const isChatPreference = (setting: string): boolean =>
  setting.startsWith("defaults.") || setting.startsWith("spoken-reply.");

const chatPreferencePath = (
  setting: string,
  state: Record<string, unknown>,
): readonly string[] => {
  if (setting.startsWith("spoken-reply."))
    return ["voice", setting.slice("spoken-reply.".length)];
  const key = setting.slice(
    "defaults.".length,
  ) as keyof typeof CHAT_DEFAULT_SHELL_KEYS;
  return key === "model"
    ? [
        CHAT_DEFAULT_SHELL_KEYS.model,
        String(state.lastSelectedProvider ?? DEFAULT_MODEL_PROVIDER),
      ]
    : [CHAT_DEFAULT_SHELL_KEYS[key]];
};

export const loadDesktopConfigEntries = async (): Promise<CliConfigEntry[]> => {
  const chatState = await loadChatDefaultState();
  let snapshot: unknown;
  let unavailable: string | undefined;
  try {
    const descriptor = await readDesktopSettingsDescriptor();
    if (descriptor) snapshot = await requestDesktopSettings("snapshot");
    else unavailable = "Open the desktop app to edit this setting.";
  } catch (error) {
    unavailable = error instanceof Error ? error.message : String(error);
  }
  return DESKTOP_CONFIG_DEFINITIONS.map((definition) => {
    if (isChatPreference(definition.nativeSetting)) {
      const raw = getObjectValue(
        chatState,
        chatPreferencePath(definition.nativeSetting, chatState),
      );
      const provider = String(
        chatState.lastSelectedProvider ?? DEFAULT_MODEL_PROVIDER,
      ) as keyof typeof DEFAULT_MODEL_BY_PROVIDER;
      return {
        ...definition,
        value: (raw ??
          (definition.setting === "defaults.model"
            ? DEFAULT_MODEL_BY_PROVIDER[provider]
            : definition.defaultValue)) as string | number | boolean,
        source: raw === undefined ? "default" : "saved",
      };
    }
    const raw = getObjectValue(snapshot, definition.path);
    const value = !snapshot
      ? "unavailable"
      : definition.secret
        ? raw
          ? "configured"
          : "not configured"
        : raw === null
          ? "inherit"
          : (raw ?? definition.defaultValue);
    return {
      ...definition,
      value: value as string | number | boolean,
      source: snapshot ? "desktop" : "unavailable",
      ...(unavailable ? { unavailable } : {}),
    };
  });
};

const writeDesktopConfigSetting = async (
  definition: DesktopConfigDefinition,
  text?: string,
): Promise<ConfigSetResult> => {
  const raw = text ?? String(definition.defaultValue);
  let value: unknown = raw;
  if (definition.nullable && raw === "inherit") value = null;
  else if (definition.type === "boolean") {
    if (["on", "true", "yes", "1"].includes(raw)) value = true;
    else if (["off", "false", "no", "0"].includes(raw)) value = false;
    else throw new CliUsageError("Enter on or off.");
  } else if (definition.type === "number") {
    value = Number(raw);
    if (!raw || !Number.isFinite(value))
      throw new CliUsageError("Enter a number.");
  } else if (definition.choices && !definition.choices.includes(raw))
    throw new CliUsageError(`Choose ${definition.choices.join(", ")}.`);
  if (definition.setting === "defaults.model" && text !== undefined) {
    value = raw.trim();
    if (
      typeof value !== "string" ||
      !value ||
      [...value].length > 512 ||
      /\p{Cc}/u.test(value)
    )
      throw new CliUsageError(
        "Enter a model id of up to 512 characters without control characters.",
      );
  }
  if (
    definition.setting === "spoken-reply.rate" &&
    (Number(value) < 0.8 || Number(value) > 1.4)
  )
    throw new CliUsageError("Enter a speech rate from 0.8 to 1.4.");
  let configPath = "desktop";
  if (
    isChatPreference(definition.nativeSetting) &&
    !(await readDesktopSettingsDescriptor())
  )
    configPath = await saveChatPreference(definition.nativeSetting, value);
  else {
    if (definition.setting === "defaults.model" && text === undefined) {
      const state = await loadChatDefaultState();
      const provider = String(
        state.lastSelectedProvider ?? DEFAULT_MODEL_PROVIDER,
      ) as keyof typeof DEFAULT_MODEL_BY_PROVIDER;
      value = DEFAULT_MODEL_BY_PROVIDER[provider];
    }
    await requestDesktopSettings("set", definition.nativeSetting, value);
  }
  return {
    setting: definition.setting,
    scope: "user",
    configPath,
    status: text === undefined ? "reset" : "configured",
    ...(text !== undefined && !definition.secret ? { value: text } : {}),
  };
};

export const desktopConfigFamily: CliConfigFamily = {
  definitions: DESKTOP_CONFIG_DEFINITIONS,
  save: async (_workspaceRoot, setting, value) =>
    await writeDesktopConfigSetting(
      DESKTOP_CONFIG_DEFINITIONS.find(
        (definition) => definition.setting === setting.trim().toLowerCase(),
      )!,
      value,
    ),
  reset: async (_workspaceRoot, setting) =>
    await writeDesktopConfigSetting(
      DESKTOP_CONFIG_DEFINITIONS.find(
        (definition) => definition.setting === setting.trim().toLowerCase(),
      )!,
    ),
};
