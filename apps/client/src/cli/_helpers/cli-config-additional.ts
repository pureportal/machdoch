import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getUserConfigPath, loadUserConfigFile } from "../../core/env.js";
import { loadWorkspaceConfigFile } from "../../core/config.js";
import { withCooperativeFileLock } from "../../core/_helpers/with-cooperative-file-lock.helper.js";
import { writeJsonAtomically } from "../../core/_helpers/write-file-atomically.helper.js";
import {
  DEFAULT_USER_AGENT_LIMITS_SETTINGS,
  DEFAULT_USER_DESKTOP_SETTINGS,
  REASONING_MODES,
  VALID_MODEL_PROVIDERS,
} from "../../core/runtime-contract.generated.js";
import { CliUsageError } from "./cli-error.js";
import type {
  CliConfigEntry,
  CliConfigSettingDefinition,
} from "./cli-config-commands.js";
import { DEFAULT_PROVIDER_ENROLLMENT_CONFIG } from "../../core/provider-enrollment/config.js";

interface AdditionalSetting extends CliConfigSettingDefinition {
  path: readonly string[];
  kind:
    | "boolean"
    | "nullable-boolean"
    | "integer"
    | "text"
    | "strings"
    | "enum";
  defaultValue: string | number | boolean;
  min?: number;
  max?: number;
}

const booleanSetting = (
  setting: string,
  label: string,
  category: string,
  scope: "user" | "workspace",
  path: readonly string[],
  defaultValue: boolean,
  nullable = false,
): AdditionalSetting => ({
  setting,
  label,
  category,
  scope,
  path,
  defaultValue,
  kind: nullable ? "nullable-boolean" : "boolean",
  description: label,
  acceptedValues: nullable ? "inherit|on|off" : "on|off",
  choices: nullable ? ["inherit", "on", "off"] : ["on", "off"],
});

export const ADDITIONAL_CONFIG_SETTINGS: readonly AdditionalSetting[] = [
  booleanSetting(
    "provider-sync.enabled",
    "Provider integration",
    "Provider integration",
    "user",
    ["providerEnrollment", "enabled"],
    DEFAULT_PROVIDER_ENROLLMENT_CONFIG.enabled,
  ),
  booleanSetting(
    "provider-sync.persistent",
    "Persistent sync",
    "Provider integration",
    "user",
    ["providerEnrollment", "persistentSync", "enabled"],
    DEFAULT_PROVIDER_ENROLLMENT_CONFIG.persistentSync.enabled,
  ),
  booleanSetting(
    "provider-sync.watch",
    "Watch for changes",
    "Provider integration",
    "user",
    ["providerEnrollment", "persistentSync", "watch"],
    DEFAULT_PROVIDER_ENROLLMENT_CONFIG.persistentSync.watch,
  ),
  booleanSetting(
    "provider-sync.autostart",
    "Sync at sign-in",
    "Provider integration",
    "user",
    ["providerEnrollment", "persistentSync", "daemonAtLogin"],
    DEFAULT_PROVIDER_ENROLLMENT_CONFIG.persistentSync.daemonAtLogin,
  ),
  {
    setting: "provider-sync.native-mcp",
    label: "Native MCP connections",
    category: "Provider integration",
    scope: "user",
    path: ["providerEnrollment", "mcp", "unmanagedNative"],
    kind: "enum",
    defaultValue: DEFAULT_PROVIDER_ENROLLMENT_CONFIG.mcp.unmanagedNative,
    choices: ["allow", "deny"],
    description: "Native provider MCP connections",
    acceptedValues: "allow|deny",
  },
  ...(["codex-cli", "claude-cli", "copilot-cli"] as const).map((provider) =>
    booleanSetting(
      `provider-sync.${provider}`,
      provider,
      "Provider integration",
      "user",
      ["providerEnrollment", "providers", provider, "enabled"],
      true,
    ),
  ),
  booleanSetting(
    "agent.adaptive",
    "Adaptive context & compute",
    "Session defaults",
    "user",
    ["desktop", "adaptiveControllerEnabled"],
    DEFAULT_USER_DESKTOP_SETTINGS.adaptiveControllerEnabled,
  ),
  booleanSetting(
    "agent-limits.automatic-retries",
    "Automatic retries",
    "Agent",
    "user",
    ["agentLimits", "automaticRetries"],
    DEFAULT_USER_AGENT_LIMITS_SETTINGS.automaticRetries,
  ),
  {
    setting: "agent-limits.retry-attempts",
    label: "Retry attempts",
    category: "Agent",
    scope: "user",
    path: ["agentLimits", "retryAttempts"],
    kind: "integer",
    defaultValue: DEFAULT_USER_AGENT_LIMITS_SETTINGS.retryAttempts,
    min: 0,
    max: 20,
    description: "Retries after a failed task",
    acceptedValues: "0..20",
  },
  booleanSetting(
    "memory.workspace-default",
    "Workspace memory",
    "Memory",
    "user",
    ["memory", "workspaceDefaultEnabled"],
    true,
  ),
  booleanSetting(
    "workspace.memory",
    "Workspace memory",
    "Workspace",
    "workspace",
    ["workspaceMemoryEnabled"],
    true,
    true,
  ),
  booleanSetting(
    "workspace.adaptive",
    "Adaptive context & compute",
    "Workspace",
    "workspace",
    ["adaptiveControllerEnabled"],
    true,
    true,
  ),
  booleanSetting(
    "workspace.reasoning-bank",
    "Reasoning bank",
    "Workspace",
    "workspace",
    ["reasoningBankEnabled"],
    true,
  ),
  booleanSetting(
    "workspace.infinite",
    "Unlimited agent turns",
    "Workspace",
    "workspace",
    ["agentLimits", "infinite"],
    false,
  ),
  ...(
    [
      [
        "executor-turns",
        "executorTurns",
        "Executor turns",
        1,
        1000,
        DEFAULT_USER_AGENT_LIMITS_SETTINGS.executorTurns,
      ],
      [
        "autopilot-iterations",
        "autopilotExecutorIterations",
        "Continuation cycles",
        1,
        100,
        DEFAULT_USER_AGENT_LIMITS_SETTINGS.autopilotExecutorIterations,
      ],
    ] as const
  ).map(
    ([name, key, label, min, max, defaultValue]): AdditionalSetting => ({
      setting: `workspace.${name}`,
      label,
      category: "Workspace",
      scope: "workspace",
      path: ["agentLimits", key],
      kind: "integer",
      defaultValue,
      min,
      max,
      description: label,
      acceptedValues: `${min}..${max}`,
    }),
  ),
  {
    setting: "internal-task.provider",
    label: "Internal task provider",
    category: "Agent",
    scope: "user",
    path: ["internalTaskModel", "provider"],
    kind: "enum",
    defaultValue: "inherit",
    choices: ["inherit", ...VALID_MODEL_PROVIDERS],
    description: "Provider for background AI tasks",
    acceptedValues: ["inherit", ...VALID_MODEL_PROVIDERS].join("|"),
  },
  {
    setting: "internal-task.model",
    label: "Internal task model",
    category: "Agent",
    scope: "user",
    path: ["internalTaskModel", "model"],
    kind: "text",
    defaultValue: "",
    description: "Model for background AI tasks",
    acceptedValues: "model id",
  },
  {
    setting: "internal-task.reasoning",
    label: "Internal task reasoning",
    category: "Agent",
    scope: "user",
    path: ["internalTaskModel", "reasoning"],
    kind: "enum",
    defaultValue: "default",
    choices: REASONING_MODES,
    description: "Reasoning for background AI tasks",
    acceptedValues: REASONING_MODES.join("|"),
  },
  {
    setting: "speech-to-text.key-terms",
    label: "Key terms",
    category: "Voice",
    scope: "user",
    path: ["speechToText", "keyTerms"],
    kind: "strings",
    defaultValue: "[]",
    description: "Words and names to recognize",
    acceptedValues: 'JSON string array, e.g. ["Machdoch"]',
  },
  {
    setting: "speech-to-text.context",
    label: "Speech context",
    category: "Voice",
    scope: "user",
    path: ["speechToText", "speechContext"],
    kind: "text",
    defaultValue: "",
    description: "Context for speech recognition",
    acceptedValues: "text",
    multiline: true,
  },
  booleanSetting(
    "speech-to-text.translate",
    "Translate speech to English",
    "Voice",
    "user",
    ["speechToText", "autoTranslateToEnglish"],
    false,
  ),
  booleanSetting(
    "speech-to-text.format",
    "Format speech",
    "Voice",
    "user",
    ["speechToText", "autoFormat"],
    false,
  ),
];

export const getObjectValue = (
  object: unknown,
  path: readonly string[],
): unknown =>
  path.reduce<unknown>(
    (value, key) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)[key]
        : undefined,
    object,
  );

export const updateObjectValue = (
  object: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): Record<string, unknown> => {
  const [key, ...rest] = path;
  if (!key) throw new Error("A setting path is required.");
  const result = { ...object };
  if (rest.length) {
    const child = result[key];
    result[key] = updateObjectValue(
      child !== null && typeof child === "object" && !Array.isArray(child)
        ? (child as Record<string, unknown>)
        : {},
      rest,
      value,
    );
  } else if (value === undefined) delete result[key];
  else result[key] = value;
  return result;
};

const parseValue = (definition: AdditionalSetting, text: string): unknown => {
  if (definition.kind === "nullable-boolean" && text === "inherit") return null;
  if (definition.kind === "enum" && text === "inherit") return undefined;
  if (definition.kind === "boolean" || definition.kind === "nullable-boolean") {
    if (["on", "true", "yes", "1"].includes(text)) return true;
    if (["off", "false", "no", "0"].includes(text)) return false;
  } else if (definition.kind === "integer") {
    const number = Number(text);
    if (
      text &&
      Number.isInteger(number) &&
      number >= definition.min! &&
      number <= definition.max!
    )
      return number;
  } else if (definition.kind === "text") return text;
  else if (definition.kind === "enum" && definition.choices?.includes(text))
    return text;
  else if (definition.kind === "strings") {
    try {
      const value: unknown = JSON.parse(text);
      if (
        Array.isArray(value) &&
        value.every((entry) => typeof entry === "string") &&
        value.length <= 256
      )
        return value;
    } catch {
      throw new CliUsageError(`Enter ${definition.acceptedValues}.`);
    }
  }
  throw new CliUsageError(`Enter ${definition.acceptedValues}.`);
};

export const loadAdditionalConfigEntries = async (
  workspaceRoot: string,
): Promise<CliConfigEntry[]> => {
  const [user, workspace] = await Promise.all([
    loadUserConfigFile(),
    loadWorkspaceConfigFile(workspaceRoot),
  ]);
  return ADDITIONAL_CONFIG_SETTINGS.map((definition) => {
    const saved = getObjectValue(
      definition.scope === "user" ? user.config : workspace.config,
      definition.path,
    );
    const value =
      saved === null ||
      (saved === undefined && definition.kind === "nullable-boolean")
        ? "inherit"
        : (saved ?? definition.defaultValue);
    return {
      ...definition,
      value: Array.isArray(value)
        ? JSON.stringify(value)
        : (value as string | number | boolean),
      source: saved === undefined ? "default" : "saved",
    };
  });
};

export const writeAdditionalConfigSetting = async (
  workspaceRoot: string,
  definition: AdditionalSetting,
  text?: string,
): Promise<string> => {
  const value =
    text === undefined ? undefined : parseValue(definition, text.trim());
  const path =
    definition.scope === "user"
      ? getUserConfigPath()
      : join(workspaceRoot, ".machdoch", "config.json");
  await withCooperativeFileLock(path, async () => {
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(await readFile(path, "utf8")) as Record<
        string,
        unknown
      >;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      config = {};
    }
    if (config === null || typeof config !== "object" || Array.isArray(config))
      throw new Error("Configuration must be a JSON object.");
    const updated = updateObjectValue(config, definition.path, value);
    if (definition.path[0] === "providerEnrollment")
      updated.providerEnrollment = {
        schemaVersion: 1,
        ...(updated.providerEnrollment as Record<string, unknown>),
      };
    await writeJsonAtomically(path, updated);
  });
  return path;
};
