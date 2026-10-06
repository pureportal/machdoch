import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getUserConfigPath } from "../../core/env.js";
import {
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

interface DesktopBridgeDescriptor {
  version: 1;
  pid: number;
  port: number;
  token: string;
}

const readDescriptor = async (): Promise<
  DesktopBridgeDescriptor | undefined
> => {
  let raw: string;
  try {
    raw = await readFile(
      join(dirname(getUserConfigPath()), "cli-settings-bridge.json"),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const descriptor: DesktopBridgeDescriptor = JSON.parse(raw);
  if (
    descriptor.version !== 1 ||
    !Number.isInteger(descriptor.pid) ||
    !Number.isInteger(descriptor.port) ||
    descriptor.port < 1 ||
    descriptor.port > 65535 ||
    !/^[0-9a-f]{64}$/u.test(descriptor.token)
  )
    throw new Error(
      "Desktop settings connection is invalid. Restart the desktop app.",
    );
  try {
    process.kill(descriptor.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
    throw error;
  }
  return descriptor;
};

export const requestDesktopSettings = async (
  action: "snapshot" | "set" | "action" | "transfer",
  setting = "",
  value?: unknown,
): Promise<unknown> => {
  const descriptor = await readDescriptor();
  if (!descriptor)
    throw new CliUsageError("Open the desktop app to edit this setting.");
  return await new Promise<unknown>((resolve, reject) => {
    const socket = createConnection({
      host: "127.0.0.1",
      port: descriptor.port,
    });
    let data = "";
    let settled = false;
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(action === "snapshot" ? 2_000 : 120_000, () =>
      finish(
        new Error(
          "Desktop settings timed out. Restart the desktop app and try again.",
        ),
      ),
    );
    socket.once("error", () =>
      finish(
        new Error(
          "Desktop settings are unavailable. Restart the desktop app and try again.",
        ),
      ),
    );
    socket.once("connect", () =>
      socket.write(
        JSON.stringify({
          token: descriptor.token,
          action,
          setting,
          ...(value === undefined ? {} : { value }),
        }) + "\n",
      ),
    );
    socket.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > 1_000_000) {
        finish(new Error("Desktop settings response is too large."));
        return;
      }
      if (!data.includes("\n")) return;
      try {
        const response = JSON.parse(data.slice(0, data.indexOf("\n"))) as {
          ok: boolean;
          data?: unknown;
          error?: string;
        };
        finish(
          response.ok
            ? undefined
            : new Error(response.error ?? "Desktop settings failed."),
          response.data,
        );
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("end", () =>
      finish(new Error("Desktop settings connection ended before responding.")),
    );
  });
};

export const loadDesktopConfigEntries = async (): Promise<CliConfigEntry[]> => {
  let snapshot: unknown;
  let unavailable: string | undefined;
  try {
    const descriptor = await readDescriptor();
    if (descriptor) snapshot = await requestDesktopSettings("snapshot");
    else unavailable = "Open the desktop app to edit this setting.";
  } catch (error) {
    unavailable = error instanceof Error ? error.message : String(error);
  }
  return DESKTOP_CONFIG_DEFINITIONS.map((definition) => {
    const provider = getObjectValue(snapshot, [
      "defaults",
      "newChat",
      "provider",
    ]);
    const raw = getObjectValue(
      snapshot,
      definition.setting === "defaults.model"
        ? ["defaults", "newChat", "models", String(provider)]
        : definition.path,
    );
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
  await requestDesktopSettings("set", definition.nativeSetting, value);
  return {
    setting: definition.setting,
    scope: "user",
    configPath: "desktop",
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
