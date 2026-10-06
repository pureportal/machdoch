import {
  clearUserConfigValue,
  loadUserWorkspaceRunSettings,
  saveUserWorkspaceRunSettings,
} from "../../core/env.js";
import { WORKSPACE_RUN_SETTING_BOUNDS } from "../../core/runtime-contract.generated.js";
import type { UserWorkspaceRunSettings } from "../../core/runtime-contract.generated.js";
import type {
  CliConfigFamily,
  CliConfigSettingDefinition,
  CliConfigEntry,
  ConfigSetResult,
} from "./cli-config-types.js";
import type { ConfigSnapshot } from "./cli-config-snapshot.js";
import {
  fail,
  parseConfigNumber,
  unsupportedConfigSetting,
  configSource,
} from "./cli-config-values.js";
interface WorkspaceRunConfigSetting {
  key: keyof UserWorkspaceRunSettings;
  description: string;
  min: number;
  max: number;
}

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

const isWorkspaceRunConfigSetting = (
  setting: string,
): setting is keyof typeof WORKSPACE_RUN_CONFIG_SETTINGS =>
  setting in WORKSPACE_RUN_CONFIG_SETTINGS;

export const WORKSPACE_RUN_CONFIG_DEFINITIONS: readonly CliConfigSettingDefinition[] =
  [
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

const saveWorkspaceRunConfigSetting = async (
  _workspaceRoot: string,
  setting: string,
  value: string,
): Promise<ConfigSetResult> => {
  const normalizedSetting = setting.trim().toLowerCase();
  const normalizedValue = value.trim();
  const parts = normalizedSetting.split(".");
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
  return unsupportedConfigSetting(setting);
};

const resetSetting = async (
  _workspaceRoot: string,
  setting: string,
): Promise<ConfigSetResult> => {
  const normalizedSetting = setting.trim().toLowerCase();
  const name = normalizedSetting.slice("workspace-run.".length);
  if (!isWorkspaceRunConfigSetting(name))
    return unsupportedConfigSetting(setting);
  return {
    setting: normalizedSetting,
    scope: "user",
    configPath: await clearUserConfigValue([
      "workspaceRun",
      WORKSPACE_RUN_CONFIG_SETTINGS[name].key,
    ]),
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
  if (setting.startsWith("workspace-run.")) {
    const name = setting.slice("workspace-run.".length);
    const workspaceRun =
      WORKSPACE_RUN_CONFIG_SETTINGS[
        name as keyof typeof WORKSPACE_RUN_CONFIG_SETTINGS
      ];
    value = snapshot.workspaceRun[workspaceRun.key];
    source = configSource(snapshot.userConfig.workspaceRun?.[workspaceRun.key]);
  } else {
    return unsupportedConfigSetting(setting);
  }

  return { ...definition, value, source };
};

export const workspaceRunConfigFamily: CliConfigFamily = {
  definitions: WORKSPACE_RUN_CONFIG_DEFINITIONS,
  save: saveWorkspaceRunConfigSetting,
  reset: resetSetting,
  resolve: resolveEntry,
};
