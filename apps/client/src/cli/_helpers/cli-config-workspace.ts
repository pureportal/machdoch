import {
  clearWorkspaceConfigValue,
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
  REASONING_EXECUTION_MODES,
  REASONING_MODES,
  VALID_MODEL_PROVIDERS,
  isReasoningExecutionMode,
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
  parseConfigBoolean,
  unsupportedConfigSetting,
  configSource,
} from "./cli-config-values.js";
const BOOLEAN_CHOICES = ["on", "off"] as const;

const savedFirstSource = (persisted: unknown, envValue?: string): string =>
  persisted !== undefined ? "saved" : envValue ? "environment" : "default";

export const WORKSPACE_CONFIG_DEFINITIONS: readonly CliConfigSettingDefinition[] =
  [
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
  ];

const saveWorkspaceConfigSetting = async (
  workspaceRoot: string,
  setting: string,
  value: string,
): Promise<ConfigSetResult> => {
  const normalizedSetting = setting.trim().toLowerCase();
  const normalizedValue = value.trim();

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

const resetSetting = async (
  workspaceRoot: string,
  setting: string,
): Promise<ConfigSetResult> => {
  const normalizedSetting = setting.trim().toLowerCase();
  const paths: Readonly<Record<string, readonly string[]>> = {
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
  const configPath = await clearWorkspaceConfigValue(
    workspaceRoot,
    paths[normalizedSetting]!,
  );
  return {
    setting: normalizedSetting,
    scope: "workspace",
    configPath,
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
    default:
      return unsupportedConfigSetting(setting);
  }

  return { ...definition, value, source };
};

export const workspaceConfigFamily: CliConfigFamily = {
  definitions: WORKSPACE_CONFIG_DEFINITIONS,
  save: saveWorkspaceConfigSetting,
  reset: resetSetting,
  resolve: resolveEntry,
};
