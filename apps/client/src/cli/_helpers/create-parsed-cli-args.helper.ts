import type {
  ModelProvider,
  ReasoningMode,
  RuntimeAgentLimitOverrides,
  RunMode,
  UserApiProvider,
} from "../../core/runtime-contract.generated.js";
import type { TaskDeterministicAction } from "../../core/types.js";
import type {
  ConfigCliOptions,
  FleetCliOptions,
  InstructionCliOptions,
  McpCliOptions,
  ParsedCliArgs,
  ProviderSyncCliOptions,
  RalphCliOptions,
  SchedulerCliOptions,
  TaskInterviewCliOptions,
} from "./cli-args-types.js";

export const createParsedArgs = (
  base: Omit<
    ParsedCliArgs,
    | "mode"
    | "helpTopic"
    | "task"
    | "config"
    | "interview"
    | "ralph"
    | "scheduler"
    | "mcp"
    | "providerSync"
    | "fleet"
    | "instructions"
    | "provider"
    | "runtimeProvider"
    | "key"
    | "model"
    | "defaultModel"
    | "reasoning"
    | "sessionMemoryEnabled"
    | "globalMemoryEnabled"
    | "setGlobalMemoryEnabled"
    | "agentLimits"
    | "conversationContextFile"
    | "contextPaths"
    | "imagePaths"
    | "deterministicAction"
    | "skipFileChangeDetection"
  >,
  options?: {
    helpTopic?: string;
    mode?: RunMode;
    provider?: UserApiProvider;
    runtimeProvider?: Exclude<ModelProvider, "unconfigured">;
    key?: string;
    model?: string;
    defaultModel?: string;
    reasoning?: ReasoningMode;
    sessionMemoryEnabled?: boolean;
    globalMemoryEnabled?: boolean;
    setGlobalMemoryEnabled?: boolean;
    agentLimits?: RuntimeAgentLimitOverrides;
    conversationContextFile?: string;
    contextPaths?: string[];
    imagePaths?: string[];
    deterministicAction?: TaskDeterministicAction;
    skipFileChangeDetection?: boolean;
    interview?: TaskInterviewCliOptions;
    ralph?: RalphCliOptions;
    scheduler?: SchedulerCliOptions;
    mcp?: McpCliOptions;
    providerSync?: ProviderSyncCliOptions;
    fleet?: FleetCliOptions;
    instructions?: InstructionCliOptions;
    config?: ConfigCliOptions;
    task?: string;
  },
): ParsedCliArgs => {
  return {
    ...base,
    ...(options?.helpTopic ? { helpTopic: options.helpTopic } : {}),
    ...(options?.mode ? { mode: options.mode } : {}),
    ...(options?.provider ? { provider: options.provider } : {}),
    ...(options?.runtimeProvider
      ? { runtimeProvider: options.runtimeProvider }
      : {}),
    ...(options?.key ? { key: options.key } : {}),
    ...(options?.model ? { model: options.model } : {}),
    ...(options?.defaultModel ? { defaultModel: options.defaultModel } : {}),
    ...(options?.reasoning ? { reasoning: options.reasoning } : {}),
    ...(options?.sessionMemoryEnabled !== undefined
      ? { sessionMemoryEnabled: options.sessionMemoryEnabled }
      : {}),
    ...(options?.globalMemoryEnabled !== undefined
      ? { globalMemoryEnabled: options.globalMemoryEnabled }
      : {}),
    ...(options?.setGlobalMemoryEnabled !== undefined
      ? { setGlobalMemoryEnabled: options.setGlobalMemoryEnabled }
      : {}),
    ...(options?.agentLimits ? { agentLimits: options.agentLimits } : {}),
    ...(options?.conversationContextFile
      ? { conversationContextFile: options.conversationContextFile }
      : {}),
    ...(options?.contextPaths && options.contextPaths.length > 0
      ? { contextPaths: options.contextPaths }
      : {}),
    ...(options?.imagePaths && options.imagePaths.length > 0
      ? { imagePaths: options.imagePaths }
      : {}),
    ...(options?.deterministicAction
      ? { deterministicAction: options.deterministicAction }
      : {}),
    ...(options?.skipFileChangeDetection
      ? { skipFileChangeDetection: true }
      : {}),
    ...(options?.task ? { task: options.task } : {}),
    ...(options?.interview ? { interview: options.interview } : {}),
    ...(options?.ralph ? { ralph: options.ralph } : {}),
    ...(options?.scheduler ? { scheduler: options.scheduler } : {}),
    ...(options?.mcp ? { mcp: options.mcp } : {}),
    ...(options?.providerSync ? { providerSync: options.providerSync } : {}),
    ...(options?.fleet ? { fleet: options.fleet } : {}),
    ...(options?.instructions ? { instructions: options.instructions } : {}),
    ...(options?.config ? { config: options.config } : {}),
  };
};

export const createSharedParsedOptions = (options: {
  json: boolean;
  verbose: boolean;
  workspaceRoot: string;
  mode?: RunMode;
  runtimeProvider?: Exclude<ModelProvider, "unconfigured">;
  model?: string;
  defaultModel?: string;
  reasoning?: ReasoningMode;
  sessionMemoryEnabled?: boolean;
  globalMemoryEnabled?: boolean;
  agentLimits?: RuntimeAgentLimitOverrides;
  conversationContextFile?: string;
  contextPaths?: string[];
  imagePaths?: string[];
  deterministicAction?: TaskDeterministicAction;
  skipFileChangeDetection?: boolean;
}): Omit<ParsedCliArgs, "command" | "task"> => {
  return {
    json: options.json,
    verbose: options.verbose,
    workspaceRoot: options.workspaceRoot,
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.runtimeProvider
      ? { runtimeProvider: options.runtimeProvider }
      : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.defaultModel ? { defaultModel: options.defaultModel } : {}),
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
    ...(options.sessionMemoryEnabled !== undefined
      ? { sessionMemoryEnabled: options.sessionMemoryEnabled }
      : {}),
    ...(options.globalMemoryEnabled !== undefined
      ? { globalMemoryEnabled: options.globalMemoryEnabled }
      : {}),
    ...(options.agentLimits ? { agentLimits: options.agentLimits } : {}),
    ...(options.conversationContextFile
      ? { conversationContextFile: options.conversationContextFile }
      : {}),
    ...(options.contextPaths && options.contextPaths.length > 0
      ? { contextPaths: options.contextPaths }
      : {}),
    ...(options.imagePaths && options.imagePaths.length > 0
      ? { imagePaths: options.imagePaths }
      : {}),
    ...(options.deterministicAction
      ? { deterministicAction: options.deterministicAction }
      : {}),
    ...(options.skipFileChangeDetection
      ? { skipFileChangeDetection: true }
      : {}),
  };
};
