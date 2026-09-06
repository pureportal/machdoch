import { randomUUID } from "node:crypto";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import type {
  TaskActionOutputHandler,
  UiControlRuntimeInfo,
} from "../types.js";
import {
  createToolDefinitions,
  executeToolCall,
} from "../_helpers/agent-tools.js";
import type {
  AgentToolDefinition,
  AgentToolExecutionResult,
  ConversationMemoryRuntime,
} from "../_helpers/agent-tools-shared.js";

export interface LocalToolRuntimeOptions {
  config: RuntimeConfig;
  memory: ConversationMemoryRuntime;
  uiControl?: UiControlRuntimeInfo;
  additionalToolDefinitions?: AgentToolDefinition[];
  runId?: string;
  signal?: AbortSignal;
  onActionOutput?: TaskActionOutputHandler;
  onResult?: (
    definition: AgentToolDefinition,
    result: AgentToolExecutionResult,
  ) => void;
}

export const createLocalToolRuntime = (options: LocalToolRuntimeOptions) => {
  const definitions = [
    ...createToolDefinitions(options.config, options.memory, options.uiControl),
    ...(options.additionalToolDefinitions ?? []),
  ];
  const tools = new Map(
    definitions.map((definition) => [definition.spec.name, definition]),
  );
  const active = new Set<Promise<AgentToolExecutionResult>>();
  return {
    definitions,
    call(
      name: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<AgentToolExecutionResult> {
      const execution = (async () => {
        const signals = [options.signal, signal].filter(
          (value): value is AbortSignal => value !== undefined,
        );
        const combinedSignal = AbortSignal.any(signals);
        combinedSignal.throwIfAborted();
        const { result } = await executeToolCall(
          options.config,
          options.memory,
          options.uiControl,
          tools,
          { id: randomUUID(), name, arguments: args },
          options.onActionOutput,
          options.runId,
          combinedSignal,
        );
        if (!result) throw new Error(`Tool ${name} did not return a result.`);
        const definition = tools.get(name);
        if (definition) options.onResult?.(definition, result);
        return result;
      })();
      active.add(execution);
      void execution.then(
        () => active.delete(execution),
        () => active.delete(execution),
      );
      return execution;
    },
    async waitForIdle(): Promise<void> {
      await Promise.allSettled([...active]);
    },
  };
};

export type LocalToolRuntime = ReturnType<typeof createLocalToolRuntime>;
