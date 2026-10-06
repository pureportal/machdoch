import { setFleetConnectionEnabled } from "../../core/fleet-connection.js";
import {
  clearUserConfigValue,
  loadUserAgentLimitsSettings,
  saveUserAgentLimitsSettings,
  saveUserAnswerLanguage,
  saveUserGlobalMemoryEnabled,
  saveUserReviewModelSettings,
} from "../../core/env.js";
import { resolveRuntimeAgentLimits } from "../../core/_helpers/agent-runtime-types.js";
import {
  AGENT_LIMIT_BOUNDS,
  DEFAULT_ANSWER_LANGUAGE,
  VALID_MODEL_PROVIDERS,
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
  parseConfigNumber,
  unsupportedConfigSetting,
  configSource,
} from "./cli-config-values.js";
const BOOLEAN_CHOICES = ["on", "off"] as const;

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

export const ANSWER_LANGUAGE_CONFIG_DEFINITIONS: readonly CliConfigSettingDefinition[] =
  [
    {
      setting: "answer-language",
      category: "Agent",
      scope: "user",
      description: "Language of the final AI answer.",
      acceptedValues: "language",
    },
  ];
export const AGENT_PREFERENCE_CONFIG_DEFINITIONS: readonly CliConfigSettingDefinition[] =
  [
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
  ];
const AGENT_CONFIG_DEFINITIONS = [
  ...ANSWER_LANGUAGE_CONFIG_DEFINITIONS,
  ...AGENT_PREFERENCE_CONFIG_DEFINITIONS,
];

const saveAgentConfigSetting = async (
  _workspaceRoot: string,
  setting: string,
  value: string,
): Promise<ConfigSetResult> => {
  const normalizedSetting = setting.trim().toLowerCase();
  const normalizedValue = value.trim();

  if (normalizedSetting === "answer-language") {
    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserAnswerLanguage(normalizedValue),
      status: "configured",
      value: normalizedValue,
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
  return unsupportedConfigSetting(setting);
};

const resetSetting = async (
  _workspaceRoot: string,
  setting: string,
): Promise<ConfigSetResult> => {
  const normalizedSetting = setting.trim().toLowerCase();
  if (normalizedSetting === "fleet.enabled")
    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await setFleetConnectionEnabled(false),
      status: "reset",
      value: false,
    };
  if (normalizedSetting === "answer-language")
    return {
      setting: normalizedSetting,
      scope: "user",
      configPath: await saveUserAnswerLanguage(""),
      status: "reset",
      value: "",
    };
  const paths: Readonly<Record<string, readonly string[]>> = {
    "memory.global": ["memory", "globalEnabled"],
    "review-model": ["reviewModel"],
    "agent-limits.infinite": ["agentLimits", "infinite"],
    "agent-limits.executor-turns": ["agentLimits", "executorTurns"],
    "agent-limits.autopilot-iterations": [
      "agentLimits",
      "autopilotExecutorIterations",
    ],
  };
  return {
    setting: normalizedSetting,
    scope: "user",
    configPath: await clearUserConfigValue(paths[normalizedSetting]!),
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
  if (setting === "fleet.enabled") {
    value = snapshot.fleet.enabled;
    source = snapshot.fleet.configured ? "saved" : "default";
  } else {
    switch (setting) {
      case "answer-language":
        value = snapshot.runtime.answerLanguage ?? DEFAULT_ANSWER_LANGUAGE;
        source = configSource(snapshot.userConfig.answerLanguage);
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
      default:
        return unsupportedConfigSetting(setting);
    }
  }
  return { ...definition, value, source };
};

export const agentConfigFamily: CliConfigFamily = {
  definitions: AGENT_CONFIG_DEFINITIONS,
  save: saveAgentConfigSetting,
  reset: resetSetting,
  resolve: resolveEntry,
};
