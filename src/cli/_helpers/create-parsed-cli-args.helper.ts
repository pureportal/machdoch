import type { ModelProvider, ReasoningMode, RuntimeAgentLimitOverrides, RunMode, UserApiProvider } from "../../core/runtime-contract.generated.js";
import type { InstructionCliOptions, McpCliOptions, ParsedCliArgs, RalphCliOptions, SchedulerCliOptions, TaskInterviewCliOptions } from "./cli-args-types.js";

export const createParsedArgs = (
  base: Omit<
    ParsedCliArgs,
    | "mode"
    | "task"
    | "interview"
    | "ralph"
    | "scheduler"
    | "mcp"
    | "instructions"
    | "provider"
    | "runtimeProvider"
    | "key"
    | "configSetting"
    | "configValue"
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
  >,
  options?: {
    mode?: RunMode;
    provider?: UserApiProvider;
    runtimeProvider?: Exclude<ModelProvider, "unconfigured">;
    key?: string;
    configSetting?: string;
    configValue?: string;
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
    interview?: TaskInterviewCliOptions;
    ralph?: RalphCliOptions;
    scheduler?: SchedulerCliOptions;
    mcp?: McpCliOptions;
    instructions?: InstructionCliOptions;
    task?: string;
  },
): ParsedCliArgs => {
  return {
    ...base,
    ...(options?.mode ? { mode: options.mode } : {}),
    ...(options?.provider ? { provider: options.provider } : {}),
    ...(options?.runtimeProvider
      ? { runtimeProvider: options.runtimeProvider }
      : {}),
    ...(options?.key ? { key: options.key } : {}),
    ...(options?.configSetting ? { configSetting: options.configSetting } : {}),
    ...(options?.configValue ? { configValue: options.configValue } : {}),
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
    ...(options?.task ? { task: options.task } : {}),
    ...(options?.interview ? { interview: options.interview } : {}),
    ...(options?.ralph ? { ralph: options.ralph } : {}),
    ...(options?.scheduler ? { scheduler: options.scheduler } : {}),
    ...(options?.mcp ? { mcp: options.mcp } : {}),
    ...(options?.instructions ? { instructions: options.instructions } : {}),
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
  };
};
