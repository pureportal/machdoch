import { getReasoningModesForProviderModel } from "./reasoning-modes.js";
import { getModelContextWindowTokens } from "./model-capabilities.js";
import { loadWorkspaceConfigFile } from "./config.js";
import { loadUserConfigFile } from "./env.js";
import { DEFAULT_USER_DESKTOP_SETTINGS } from "./runtime-contract.generated.js";
import type { RuntimeConfig } from "./runtime-contract.generated.js";
import type { TaskConversationContext } from "./types.js";

export type AdaptiveControllerLevel = "simple" | "standard" | "deep";

export interface AdaptiveExecutionPlan {
  level: AdaptiveControllerLevel;
  historyMessages: number;
  historyCharacters: number;
  memoryEntries: number;
  memoryCharacters: number;
  experienceLessons: number;
  experienceCharacters: number;
  workspaceRunCharacters: number;
  reasoning: RuntimeConfig["reasoning"];
  executorTurns: number | null;
  autopilotIterations: number | null;
  maxWorkers: 2 | 3;
}

const PROFILES = {
  simple: {
    historyMessages: 4,
    historyCharacters: 2_400,
    memoryEntries: 4,
    memoryCharacters: 900,
    experienceLessons: 1,
    experienceCharacters: 500,
    workspaceRunCharacters: 2_000,
    executorTurns: 16,
    autopilotIterations: 2,
    maxWorkers: 2,
    reasoning: "low",
  },
  standard: {
    historyMessages: 8,
    historyCharacters: 5_000,
    memoryEntries: 8,
    memoryCharacters: 1_800,
    experienceLessons: 3,
    experienceCharacters: 1_200,
    workspaceRunCharacters: 6_000,
    executorTurns: 48,
    autopilotIterations: 4,
    maxWorkers: 2,
    reasoning: "medium",
  },
  deep: {
    historyMessages: 16,
    historyCharacters: 12_000,
    memoryEntries: 14,
    memoryCharacters: 3_600,
    experienceLessons: 5,
    experienceCharacters: 2_400,
    workspaceRunCharacters: 12_000,
    executorTurns: 120,
    autopilotIterations: 8,
    maxWorkers: 3,
    reasoning: "high",
  },
} as const;

const COMPLEX_WORK =
  /\b(implement|refactor|migrate|debug|investigate|fix|design|build|integrate|audit|review|optimi[sz]e|test|verify)\b/iu;
const BROAD_SCOPE =
  /\b(architecture|codebase|repository|across|entire|all|multiple|end.to.end|full.featured|production|security|performance)\b/iu;
const SIMPLE_WORK =
  /\b(what is|explain|summari[sz]e|translate|define|list|show me)\b/iu;

export const resolveAdaptiveControllerEnabled = (
  globalEnabled: boolean,
  workspaceOverride?: boolean | null,
  sessionOverride?: boolean | null,
): boolean => sessionOverride ?? workspaceOverride ?? globalEnabled;

export const resolveAdaptiveExecutionPlan = async (
  task: string,
  config: RuntimeConfig,
  context?: TaskConversationContext,
): Promise<AdaptiveExecutionPlan | undefined> => {
  if (!context) return undefined;
  const [userSettings, workspaceSettings] = await Promise.all([
    loadUserConfigFile(),
    context.workspace?.selection === "not-set"
      ? Promise.resolve(undefined)
      : loadWorkspaceConfigFile(config.workspaceRoot),
  ]);
  const globalSetting = userSettings.config.desktop?.adaptiveControllerEnabled;
  const workspaceSetting = workspaceSettings?.config.adaptiveControllerEnabled;
  const enabled = resolveAdaptiveControllerEnabled(
    typeof globalSetting === "boolean"
      ? globalSetting
      : DEFAULT_USER_DESKTOP_SETTINGS.adaptiveControllerEnabled,
    typeof workspaceSetting === "boolean" ? workspaceSetting : null,
    typeof context.adaptiveControllerOverride === "boolean"
      ? context.adaptiveControllerOverride
      : null,
  );
  return enabled ? planAdaptiveExecution(task, config, context) : undefined;
};

export const planAdaptiveExecution = (
  task: string,
  config: RuntimeConfig,
  context?: TaskConversationContext,
): AdaptiveExecutionPlan => {
  const profileScore =
    (COMPLEX_WORK.test(task) ? 2 : 0) +
    (BROAD_SCOPE.test(task) ? 2 : 0) +
    (task.length > 600 ? 2 : task.length > 180 ? 1 : 0) +
    ((task.match(/(?:\n\s*[-*\d]+[.)]?\s+|\n\n)/gu) ?? []).length >= 3
      ? 1
      : 0) +
    ((context?.history.length ?? 0) > 12 ? 1 : 0) +
    (context?.wasQueued ? 1 : 0) -
    (SIMPLE_WORK.test(task) && !COMPLEX_WORK.test(task) ? 2 : 0);
  const level: AdaptiveControllerLevel =
    profileScore >= 5 ? "deep" : profileScore >= 2 ? "standard" : "simple";
  const profile = PROFILES[level];
  const knownContextWindow = getModelContextWindowTokens(
    config.provider,
    config.model,
  );
  const contextWindowTokens =
    typeof config.contextWindow === "number"
      ? Math.min(
          config.contextWindow,
          knownContextWindow ?? config.contextWindow,
        )
      : knownContextWindow;
  const totalContextCharacters =
    profile.historyCharacters +
    profile.memoryCharacters +
    profile.experienceCharacters +
    profile.workspaceRunCharacters;
  const contextScale = contextWindowTokens
    ? Math.min(1, (contextWindowTokens * 4 * 0.18) / totalContextCharacters)
    : 1;
  const supportedReasoning =
    config.provider === "unconfigured"
      ? ["default"]
      : getReasoningModesForProviderModel(config.provider, config.model);
  const reasoning =
    config.reasoning !== "default"
      ? config.reasoning
      : supportedReasoning.includes(profile.reasoning)
        ? profile.reasoning
        : "default";
  const limits = config.agentLimits;

  return {
    level,
    historyMessages: profile.historyMessages,
    historyCharacters: Math.max(
      600,
      Math.floor(profile.historyCharacters * contextScale),
    ),
    memoryEntries: profile.memoryEntries,
    memoryCharacters: Math.max(
      300,
      Math.floor(profile.memoryCharacters * contextScale),
    ),
    experienceLessons: profile.experienceLessons,
    experienceCharacters: Math.max(
      200,
      Math.floor(profile.experienceCharacters * contextScale),
    ),
    workspaceRunCharacters: Math.max(
      1_000,
      Math.floor(profile.workspaceRunCharacters * contextScale),
    ),
    reasoning,
    executorTurns:
      limits?.executorTurns === null
        ? null
        : Math.min(
            limits?.executorTurns ?? profile.executorTurns,
            profile.executorTurns,
          ),
    autopilotIterations:
      limits?.autopilotExecutorIterations === null
        ? null
        : Math.min(
            limits?.autopilotExecutorIterations ?? profile.autopilotIterations,
            profile.autopilotIterations,
          ),
    maxWorkers: profile.maxWorkers,
  };
};
