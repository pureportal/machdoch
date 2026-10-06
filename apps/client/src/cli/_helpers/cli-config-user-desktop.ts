import {
  clearUserConfigValue,
  saveUserDesktopSettingsPatch,
} from "../../core/env.js";
import {
  DEFAULT_USER_DESKTOP_SETTINGS,
  DESKTOP_SETTING_BOUNDS,
} from "../../core/runtime-contract.generated.js";
import type { UserDesktopSettings } from "../../core/runtime-contract.generated.js";
import type {
  CliConfigFamily,
  CliConfigSettingDefinition,
  CliConfigEntry,
  ConfigSetResult,
} from "./cli-config-types.js";
import type { ConfigSnapshot } from "./cli-config-snapshot.js";
import {
  fail,
  parseConfigBoolean,
  parseConfigNumber,
  unsupportedConfigSetting,
  configSource,
} from "./cli-config-values.js";
const BOOLEAN_CHOICES = ["on", "off"] as const;

type DesktopSettingValueType = "boolean" | "integer" | "number" | "string";

interface DesktopConfigSetting {
  key: keyof UserDesktopSettings;
  type: DesktopSettingValueType;
  description: string;
  min?: number;
  max?: number;
}

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
  "ai-context-max-messages": {
    key: "aiContextMaxMessages",
    type: "integer",
    description: "Maximum recent messages included in desktop AI context.",
    ...DESKTOP_SETTING_BOUNDS.aiContextMaxMessages,
  },
  "chat-idle-timeout-minutes": {
    key: "chatIdleTimeoutMinutes",
    type: "integer",
    description: "Minutes without progress before a desktop chat stops.",
    ...DESKTOP_SETTING_BOUNDS.chatIdleTimeoutMinutes,
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

const desktopAcceptedValues = (setting: DesktopConfigSetting): string => {
  if (setting.type === "boolean") {
    return "on|off";
  }

  if (setting.min !== undefined && setting.max !== undefined) {
    return `${setting.min}..${setting.max}`;
  }

  return setting.type === "string" ? "text" : "number";
};

const isDesktopConfigSetting = (
  setting: string,
): setting is keyof typeof DESKTOP_CONFIG_SETTINGS =>
  setting in DESKTOP_CONFIG_SETTINGS;

const parseDesktopSettingValue = (
  setting: string,
  value: string,
): {
  patch: Partial<UserDesktopSettings>;
  value: string | number | boolean;
} => {
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

export const USER_DESKTOP_CONFIG_DEFINITIONS: readonly CliConfigSettingDefinition[] =
  [
    ...Object.entries(DESKTOP_CONFIG_SETTINGS).map(
      ([setting, definition]): CliConfigSettingDefinition => ({
        setting: `desktop.${setting}`,
        category: ["aiContextMaxMessages", "chatIdleTimeoutMinutes"].includes(
          definition.key,
        )
          ? "Session defaults"
          : "Desktop",
        scope: "user",
        description: definition.description,
        acceptedValues: desktopAcceptedValues(definition),
        ...(definition.type === "boolean" ? { choices: BOOLEAN_CHOICES } : {}),
      }),
    ),
  ];

const saveUserDesktopConfigSetting = async (
  _workspaceRoot: string,
  setting: string,
  value: string,
): Promise<ConfigSetResult> => {
  const normalizedSetting = setting.trim().toLowerCase();
  const normalizedValue = value.trim();
  const parts = normalizedSetting.split(".");
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
  return unsupportedConfigSetting(setting);
};

const resetSetting = async (
  _workspaceRoot: string,
  setting: string,
): Promise<ConfigSetResult> => {
  const normalizedSetting = setting.trim().toLowerCase();
  const name = normalizedSetting.slice("desktop.".length);
  const definition =
    DESKTOP_CONFIG_SETTINGS[name as keyof typeof DESKTOP_CONFIG_SETTINGS];
  return {
    setting: normalizedSetting,
    scope: "user",
    configPath: await clearUserConfigValue(["desktop", definition.key]),
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
  if (setting.startsWith("desktop.")) {
    const name = setting.slice("desktop.".length);
    const desktop =
      DESKTOP_CONFIG_SETTINGS[name as keyof typeof DESKTOP_CONFIG_SETTINGS];
    value =
      snapshot.userConfig.desktop?.[desktop.key] ??
      DEFAULT_USER_DESKTOP_SETTINGS[desktop.key];
    source = configSource(snapshot.userConfig.desktop?.[desktop.key]);
  } else {
    return unsupportedConfigSetting(setting);
  }

  return { ...definition, value, source };
};

export const userDesktopConfigFamily: CliConfigFamily = {
  definitions: USER_DESKTOP_CONFIG_DEFINITIONS,
  save: saveUserDesktopConfigSetting,
  reset: resetSetting,
  resolve: resolveEntry,
};
