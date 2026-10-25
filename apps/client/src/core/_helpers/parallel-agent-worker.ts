import type { AgentToolDefinition } from "./agent-tools-shared.js";
import { executeToolCall } from "./agent-tools.js";
import { createProviderAdapter } from "./provider-adapters.js";
import { isAgentCliProvider } from "./agent-cli-providers.js";
import { maybeExecuteExternalAgentProviderTask } from "./external-agent-provider.js";
import { observeAgentModelCall } from "../model-usage.js";
import { assertInstructionInvocationBudget } from "../instruction-system/index.js";
import type { AgentModelToolCall, AgentModelToolResult, AgentModelTurn } from "@machdoch/model-runtime/types";
import type { TaskExecutionTimelineEvent } from "../types.js";
import type {
  ParallelAgentSessionOptions,
  ValidatedWorker,
} from "./parallel-agent-types.js";
import { createWorkerTools } from "./parallel-agent-plans.js";
import {
  MAX_WORKER_TOOL_CALLS,
  WorkerBoundaryError,
  recordWorkerToolResult,
  type ParallelWorkerState,
} from "./parallel-agent-worker-state.js";

const MAX_WORKER_TURNS = 8;

const awaitModelCall = async <T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> => {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      finish();
      reject(signal.reason ?? new Error("Parallel work was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        if (settled) return;
        finish();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        finish();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
};

export const reportWorkerProgress = (
  options: ParallelAgentSessionOptions,
  event: TaskExecutionTimelineEvent,
): void => {
  if (options.signal?.aborted) return;
  options.onStreamActivity?.();
  if (!options.onProgress) return;
  try {
    void Promise.resolve(options.onProgress(event)).catch((error: unknown) => {
      console.warn("Could not report parallel agent progress:", error);
    });
  } catch (error) {
    console.warn("Could not report parallel agent progress:", error);
  }
};

const workerModelEvent = (
  worker: ValidatedWorker,
  pass: number,
  phase: "started" | "completed" | "failed",
): TaskExecutionTimelineEvent => ({
  kind: "model-call",
  phase,
  label: `Agent ${worker.id} · AI pass ${pass}`,
  tone:
    phase === "failed" ? "danger" : phase === "completed" ? "success" : "info",
});

const workerToolEvent = (
  worker: ValidatedWorker,
  call: AgentModelTurn["toolCalls"][number],
  phase: "started" | "completed" | "failed",
): TaskExecutionTimelineEvent => {
  const target =
    call.arguments.path ?? call.arguments.query ?? call.arguments.url;
  return {
    kind: "tool-call",
    phase,
    label: `Agent ${worker.id} · ${call.name.replaceAll("_", " ")}`,
    ...(typeof target === "string" ? { detail: target.slice(0, 240) } : {}),
    tone:
      phase === "failed"
        ? "danger"
        : phase === "completed"
          ? "success"
          : "info",
    toolName: call.name,
    callId: `${worker.id}:${call.id}`,
  };
};

const runCliWorker = async (
  worker: ValidatedWorker,
  options: ParallelAgentSessionOptions,
  signal: AbortSignal,
  tools: AgentToolDefinition[],
  onBoundaryViolation: (error: WorkerBoundaryError) => void,
  state: ParallelWorkerState,
): Promise<void> => {
  if (
    !options.instructionDeliveryPlan ||
    !options.preparedConversationContext
  ) {
    throw new Error("The CLI worker instruction plan is missing.");
  }
  reportWorkerProgress(options, workerModelEvent(worker, 1, "started"));
  const controller = new AbortController();
  const workerSignal = AbortSignal.any([signal, controller.signal]);
  const pendingCalls = new Map<string, AgentModelToolCall>();
  const trackedTools = tools.map((tool) => ({
    ...tool,
    execute: async (...args: Parameters<typeof tool.execute>) => {
      workerSignal.throwIfAborted();
      try {
        return await tool.execute(...args);
      } catch (error) {
        recordWorkerToolResult(state, {
          callId: "",
          name: tool.spec.name,
          isError: true,
          output: error instanceof Error ? error.message : String(error),
        });
        if (error instanceof WorkerBoundaryError) onBoundaryViolation(error);
        controller.abort(error);
        throw error;
      }
    },
  }));
  try {
    const result = await awaitModelCall(
      maybeExecuteExternalAgentProviderTask({
        task: `Original task: ${options.task}\n\nYour objective: ${worker.objective}`,
        config: {
          ...options.config,
          mode: worker.access === "write" ? "machdoch" : "ask",
        },
        taskContext: {
          ...options.taskContext,
          executionRole: worker.access === "write" ? "executor" : "generator",
        },
        contextSections: [],
        systemPromptSections: [
          "You are one parallel worker. Complete only your objective. Do not delegate or write memory. Correct tool errors or report their effect on your objective.",
          worker.access === "write"
            ? `You may edit only these workspace-relative files: ${worker.writePaths.join(", ")}. Use only the scoped Machdoch MCP tools for edits.`
            : "Read only. Do not modify files or external resources.",
          worker.readPaths.length > 0
            ? `Read paths: ${worker.readPaths.join(", ")}.`
            : "",
        ].filter(Boolean),
        preparedConversationContext: {
          wasQueued: options.preparedConversationContext.wasQueued,
          workspace: options.preparedConversationContext.workspace,
          parallelAgentMode: "disabled",
          sections: [],
          uiControlEnabled: false,
          memory: {
            sessionEnabled: false,
            sessionEntries: [],
            workspaceEnabled: false,
            workspaceEntries: [],
            globalEnabled: false,
            globalEntries: [],
          },
        },
        instructionDeliveryPlan: options.instructionDeliveryPlan,
        scopedWorkerToolDefinitions: trackedTools,
        onScopedWorkerToolCall: (call) => {
          workerSignal.throwIfAborted();
          if (state.toolCalls >= MAX_WORKER_TOOL_CALLS) {
            const error = new Error(
              `Worker ${worker.id} exceeded its tool limit.`,
            );
            controller.abort(error);
            throw error;
          }
          state.toolCalls += 1;
          pendingCalls.set(call.id, call);
          reportWorkerProgress(
            options,
            workerToolEvent(worker, call, "started"),
          );
          workerSignal.throwIfAborted();
        },
        onScopedWorkerToolResult: (_name, result) => {
          workerSignal.throwIfAborted();
          recordWorkerToolResult(state, result.toolResult);
          const call = pendingCalls.get(result.toolResult.callId) ?? {
            id: result.toolResult.callId,
            name: result.toolResult.name,
            arguments: {},
          };
          pendingCalls.delete(result.toolResult.callId);
          reportWorkerProgress(
            options,
            workerToolEvent(
              worker,
              call,
              result.toolResult.isError ? "failed" : "completed",
            ),
          );
        },
        ...(options.onStreamActivity
          ? { onStreamActivity: options.onStreamActivity }
          : {}),
        onActionOutput: ({ chunk }) => {
          if (chunk.trim()) options.onStreamActivity?.();
        },
        signal: workerSignal,
      }),
      workerSignal,
    );
    if (workerSignal.aborted)
      throw workerSignal.reason ?? new Error("Parallel work was cancelled.");
    state.answer =
      result?.response?.markdown?.trim() || result?.summary?.trim() || "";
    if (!result || result.status !== "executed") {
      throw new Error(
        result?.reason ||
          result?.summary ||
          `Worker ${worker.id} could not start.`,
      );
    }
    if (worker.access === "write" && state.successfulWrites === 0) {
      throw new Error(
        `Worker ${worker.id} did not complete a scoped file edit.`,
      );
    }
    if (!state.answer)
      throw new Error(`Worker ${worker.id} returned no result.`);
    reportWorkerProgress(options, workerModelEvent(worker, 1, "completed"));
  } catch (error) {
    for (const call of pendingCalls.values())
      reportWorkerProgress(options, workerToolEvent(worker, call, "failed"));
    reportWorkerProgress(options, workerModelEvent(worker, 1, "failed"));
    throw error;
  } finally {
    controller.abort();
  }
};

export const runWorker = async (
  worker: ValidatedWorker,
  options: ParallelAgentSessionOptions,
  signal: AbortSignal,
  scopedReads: boolean,
  onBoundaryViolation: (error: WorkerBoundaryError) => void,
  state: ParallelWorkerState,
): Promise<void> => {
  if (signal.aborted)
    throw signal.reason ?? new Error("Parallel work was cancelled.");
  const tools = createWorkerTools(
    options,
    worker,
    scopedReads || worker.canonicalReadPaths.length > 0,
  );
  if (
    isAgentCliProvider(options.config.provider) &&
    !options.createWorkerAdapter
  ) {
    return runCliWorker(
      worker,
      options,
      signal,
      tools,
      onBoundaryViolation,
      state,
    );
  }
  const specs = tools.map((tool) => tool.spec);
  const toolMap = new Map(tools.map((tool) => [tool.spec.name, tool]));
  if (signal.aborted)
    throw signal.reason ?? new Error("Parallel work was cancelled.");
  const adapter = await awaitModelCall(
    options.createWorkerAdapter
      ? options.createWorkerAdapter()
      : createProviderAdapter(options.config, specs, undefined),
    signal,
  );
  if (!adapter)
    throw new Error("The selected provider cannot start a worker session.");
  const instructionResolution = options.taskContext.instructionResolution;
  const instructions = instructionResolution?.renderedEnvelope;
  if (!instructionResolution || !instructions)
    throw new Error("The worker instruction snapshot is missing.");
  const systemPrompt = [
    instructions,
    "You are a bounded parallel worker in one Machdoch task. Complete only your objective. Do not delegate or write memory. Return findings and verification evidence. Correct tool errors or report their effect on your objective. Do not give instructions to the parent.",
    worker.access === "write"
      ? `You may edit only these files: ${worker.writePaths.join(", ")}.`
      : "Read only. Do not modify any resource.",
  ].join("\n\n");
  const userPrompt = `Original task: ${options.task}\n\nYour objective: ${worker.objective}`;
  const initialRequestBytes = Buffer.byteLength(
    JSON.stringify({ systemPrompt, userPrompt, tools: specs }),
    "utf8",
  );
  assertInstructionInvocationBudget(instructionResolution, {
    phase: "initial",
    assembledRequestBytes: initialRequestBytes,
  });
  const workerConfig = {
    ...options.config,
    mode: worker.access === "write" ? ("machdoch" as const) : ("ask" as const),
  };
  const emptyMemory = {
    sessionEnabled: false,
    sessionEntries: [],
    workspaceEnabled: false,
    workspaceEntries: [],
    globalEnabled: false,
    globalEntries: [],
  };
  if (signal.aborted)
    throw signal.reason ?? new Error("Parallel work was cancelled.");
  reportWorkerProgress(options, workerModelEvent(worker, 1, "started"));
  if (signal.aborted)
    throw signal.reason ?? new Error("Parallel work was cancelled.");
  let turn: AgentModelTurn;
  try {
    turn = await awaitModelCall(
      observeAgentModelCall(
        {
          stage: "executor",
          provider: options.config.provider,
          model: options.config.model,
          operation: `parallelWorker:${worker.id}:start`,
          requestBytes: initialRequestBytes,
          toolDefinitions: specs,
        },
        async (onRequestAttempt) =>
          adapter.startTurn({
            model: options.config.model,
            reasoning: options.config.reasoning,
            systemPrompt,
            userPrompt,
            tools: specs,
            signal,
            onStreamEvent: () => options.onStreamActivity?.(),
            ...(onRequestAttempt ? { onRequestAttempt } : {}),
          }),
      ),
      signal,
    );
  } catch (error) {
    reportWorkerProgress(options, workerModelEvent(worker, 1, "failed"));
    throw error;
  }
  if (signal.aborted)
    throw signal.reason ?? new Error("Parallel work was cancelled.");
  reportWorkerProgress(options, workerModelEvent(worker, 1, "completed"));
  for (let index = 0; index <= MAX_WORKER_TURNS; index += 1) {
    if (signal.aborted) throw new Error("Parallel work was cancelled.");
    state.answer = turn.text.trim() || state.answer;
    if (turn.toolCalls.length === 0) {
      if (!turn.text.trim())
        throw new Error(`Worker ${worker.id} returned no result.`);
      if (worker.access === "write" && state.successfulWrites === 0)
        throw new Error(
          `Worker ${worker.id} did not complete a scoped file edit.`,
        );
      return;
    }
    if (index === MAX_WORKER_TURNS) break;
    const results: AgentModelToolResult[] = [];
    for (const call of turn.toolCalls) {
      if (state.toolCalls >= MAX_WORKER_TOOL_CALLS)
        throw new Error(`Worker ${worker.id} exceeded its tool limit.`);
      state.toolCalls += 1;
      if (signal.aborted) throw new Error("Parallel work was cancelled.");
      reportWorkerProgress(options, workerToolEvent(worker, call, "started"));
      if (signal.aborted)
        throw signal.reason ?? new Error("Parallel work was cancelled.");
      const outcome = await awaitModelCall(
        executeToolCall(
          workerConfig,
          emptyMemory,
          undefined,
          toolMap,
          call,
          undefined,
          undefined,
          signal,
        ),
        signal,
      ).catch(async (error: unknown) => {
        recordWorkerToolResult(state, {
          callId: call.id,
          name: call.name,
          isError: true,
          output: error instanceof Error ? error.message : String(error),
        });
        reportWorkerProgress(options, workerToolEvent(worker, call, "failed"));
        throw error;
      });
      if (!outcome.result) {
        reportWorkerProgress(options, workerToolEvent(worker, call, "failed"));
        throw new Error(`Worker ${worker.id} produced no tool result.`);
      }
      if (signal.aborted)
        throw signal.reason ?? new Error("Parallel work was cancelled.");
      reportWorkerProgress(
        options,
        workerToolEvent(
          worker,
          call,
          outcome.result.toolResult.isError ? "failed" : "completed",
        ),
      );
      recordWorkerToolResult(state, outcome.result.toolResult);
      results.push(outcome.result.toolResult);
    }
    if (signal.aborted)
      throw signal.reason ?? new Error("Parallel work was cancelled.");
    reportWorkerProgress(
      options,
      workerModelEvent(worker, index + 2, "started"),
    );
    if (signal.aborted)
      throw signal.reason ?? new Error("Parallel work was cancelled.");
    try {
      turn = await awaitModelCall(
        observeAgentModelCall(
          {
            stage: "executor",
            provider: options.config.provider,
            model: options.config.model,
            operation: `parallelWorker:${worker.id}:continue`,
            requestBytes: Buffer.byteLength(JSON.stringify(results), "utf8"),
            toolDefinitions: specs,
          },
          async (onRequestAttempt) =>
            adapter.continueTurn({
              toolResults: results,
              signal,
              onStreamEvent: () => options.onStreamActivity?.(),
              ...(onRequestAttempt ? { onRequestAttempt } : {}),
            }),
        ),
        signal,
      );
    } catch (error) {
      reportWorkerProgress(
        options,
        workerModelEvent(worker, index + 2, "failed"),
      );
      throw error;
    }
    if (signal.aborted)
      throw signal.reason ?? new Error("Parallel work was cancelled.");
    reportWorkerProgress(
      options,
      workerModelEvent(worker, index + 2, "completed"),
    );
    if (signal.aborted)
      throw signal.reason ?? new Error("Parallel work was cancelled.");
  }
  throw new Error(`Worker ${worker.id} exceeded its turn limit.`);
};
