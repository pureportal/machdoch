import {
  createFileWriteLabel,
  executeCreateFileTarget,
  executeExplicitInspectionPath,
  executeInspectionTarget,
  getInspectionLabel,
} from "./_helpers/deterministic-task-execution.js";
import { createContextSections } from "./_helpers/execution-sections.js";
import {
  createExecutionResult,
  createInvariantViolationResult,
  emitExecutionState,
  emitTerminalResult,
  maybeReturnCancelledResult,
  type TaskExecutionRuntime,
  verifyExecutedResult,
} from "./_helpers/execution-state.js";
import { TASK_EXECUTION_STATUS_TO_TERMINAL_STATE } from "./_helpers/execution-progress.js";
import { startTaskFileChangeCapture } from "./_helpers/task-file-change-capture.js";
import {
  getAgentCliProviderLabel,
  isAgentCliProvider,
} from "./_helpers/agent-cli-providers.js";
import {
  createManagedTaskExecutionTimeout,
  resolveTaskExecutionTimeouts,
  type ManagedTaskExecutionTimeout,
} from "./_helpers/task-execution-timeouts.js";
import { maybeExecuteModelDrivenTask } from "./agent-runtime.js";
import { consolidateTaskExecutionMemory } from "./memory-consolidation.js";
import { resolveTaskContext } from "./task-context.js";
import { resolveReadOnlyInspectionTarget } from "./task-inspection.js";
import {
  extractExplicitInspectionPathReference,
  resolveDeterministicCreateFileTarget,
} from "./task-paths.js";
import type {
  CustomizationDiscoveryResult,
  TaskExecutionOptions,
  TaskExecutionResult,
  TaskExecutionState,
} from "./types.js";
import type { RuntimeConfig } from "./runtime-contract.generated.js";

const providerIsConfigured = (config: RuntimeConfig): boolean => {
  return config.providerAvailability.some(
    (entry) => entry.provider === config.provider && entry.configured,
  );
};

const createLiveExecutionUnavailableMessage = (
  config: RuntimeConfig,
): { summary: string; reason: string; sectionLines: string[] } => {
  const userConfigPath = config.userConfigPath?.trim();
  const sectionLines = [
    `mode: ${config.mode}`,
    `provider: ${config.provider}`,
    `offline: ${config.offline ? "true" : "false"}`,
    ...(userConfigPath ? [`user config: ${userConfigPath}`] : []),
  ];

  if (config.offline) {
    return {
      summary:
        "This task needs the model-driven agent loop, but offline mode is enabled.",
      reason:
        "Turn off offline mode with `machdoch config set workspace.offline off` or unset `MACHDOCH_OFFLINE`, then run the task again.",
      sectionLines,
    };
  }

  if (config.provider === "unconfigured") {
    return {
      summary:
        "This task needs the model-driven agent loop, but no model provider is configured.",
      reason:
        "Configure a provider key with `machdoch config set api.openai.key <key>` or `machdoch --set-api --provider openai --key <key>`. If this command is running with sudo or elevation, check the user config path for that elevated context.",
      sectionLines,
    };
  }

  if (!providerIsConfigured(config)) {
    if (isAgentCliProvider(config.provider)) {
      const label = getAgentCliProviderLabel(config.provider);

      return {
        summary:
          `This task needs the model-driven agent loop, but the selected provider \`${config.provider}\` is not configured.`,
        reason:
          `Install ${label} so its binary is on PATH, or configure \`agent-cli.${config.provider}.path\` with the CLI binary path.`,
        sectionLines,
      };
    }

    return {
      summary:
        `This task needs the model-driven agent loop, but the selected provider \`${config.provider}\` is not configured.`,
      reason:
        `Configure \`api.${config.provider}.key\`, choose another configured provider, or check the user config path if this command is running with sudo or elevation.`,
      sectionLines,
    };
  }

  return {
    summary:
      "No deterministic execution path is available for this task without a live model executor.",
    reason:
      "The task does not match a built-in deterministic local action, and the live executor did not return a runnable result.",
    sectionLines,
  };
};

const createActivityAwareExecutionOptions = (
  options: TaskExecutionOptions,
  managedTimeout: ManagedTaskExecutionTimeout,
): TaskExecutionOptions => {
  const onStateChange = options.onStateChange;
  const onActionOutput = options.onActionOutput;
  const onStreamActivity = options.onStreamActivity;

  return {
    ...options,
    signal: managedTimeout.signal,
    onStateChange: async (progress): Promise<void> => {
      managedTimeout.markActivity();
      await onStateChange?.({
        ...progress,
        timeout: managedTimeout.getState(),
      });
    },
    onActionOutput: async (output): Promise<void> => {
      managedTimeout.markActivity();
      await onActionOutput?.(output);
    },
    onStreamActivity: (): void => {
      managedTimeout.markActivity();
      onStreamActivity?.();
    },
  };
};

const runTaskExecutionStateMachine = async (
  task: string,
  config: RuntimeConfig,
  customizations: CustomizationDiscoveryResult,
  options: TaskExecutionOptions = {},
): Promise<TaskExecutionResult> => {
  const runtime: TaskExecutionRuntime = {
    taskContext: undefined,
    contextSections: [],
    explicitPathReference: undefined,
    createFileTarget: undefined,
    inspectionTarget: undefined,
    pendingResult: undefined,
    executedTools: [],
  };

  let state: TaskExecutionState = "starting";
  let message = "Initialize the task execution loop.";

  while (true) {
    await emitExecutionState(task, config, state, message, runtime, options);

    const cancelledBeforeStep = await maybeReturnCancelledResult(
      task,
      config,
      state,
      message,
      runtime,
      options,
    );

    if (cancelledBeforeStep) {
      return cancelledBeforeStep;
    }

    switch (state) {
      case "starting": {
        state = "resolving-context";
        message =
          "Resolve prompt inputs, workspace paths, and applicable instructions.";
        break;
      }

      case "resolving-context": {
        runtime.taskContext = resolveTaskContext(task, customizations, {
          ...(options.instructionAudience
            ? { instructionAudience: options.instructionAudience }
            : {}),
        });
        runtime.contextSections = createContextSections(runtime.taskContext);
        state = "checking-inputs";
        message =
          "Check for missing inputs and determine the deterministic inspection target.";
        break;
      }

      case "checking-inputs": {
        const taskContext = runtime.taskContext;

        if (!taskContext) {
          return emitTerminalResult(
            task,
            config,
            "blocked",
            "The execution loop lost its task context.",
            runtime,
            options,
            createInvariantViolationResult(
              task,
              config,
              runtime,
              "The execution loop lost its task context before it could continue.",
              "Internal invariant failed: task context was undefined during input checks.",
            ),
          );
        }

        if (
          taskContext.invokedPrompt &&
          taskContext.invokedPrompt.missingInputs.length > 0
        ) {
          return emitTerminalResult(
            task,
            config,
            "blocked",
            "The task is blocked on required prompt input.",
            runtime,
            options,
            createExecutionResult(
              {
                task,
                mode: config.mode,
                status: "blocked",
                summary:
                  "The invoked prompt still needs more input before a deterministic read-only execution can begin.",
                executedTools: [],
                outputSections: createContextSections(taskContext, {
                  includeInstructions: false,
                }),
              },
              `The prompt \`/${taskContext.invokedPrompt.name}\` is missing input(s): ${taskContext.invokedPrompt.missingInputs.join(", ")}.`,
            ),
          );
        }

        runtime.explicitPathReference = extractExplicitInspectionPathReference(
          taskContext.effectiveTask,
          config.workspaceRoot,
        );
        runtime.createFileTarget = resolveDeterministicCreateFileTarget(
          taskContext.effectiveTask,
          config.workspaceRoot,
        );
        runtime.inspectionTarget = resolveReadOnlyInspectionTarget(
          taskContext.effectiveTask,
        );

        state = "checking-tools";
        message =
          "Resolve the available tool surface before any execution starts.";
        break;
      }

      case "checking-tools": {
        if (runtime.taskContext) {
          const modelDrivenResult = await maybeExecuteModelDrivenTask({
            task,
            config,
            taskContext: runtime.taskContext,
            contextSections: runtime.contextSections,
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.runId ? { runId: options.runId } : {}),
            ...(options.conversationContext
              ? { conversationContext: options.conversationContext }
              : {}),
            ...(options.imageInputs ? { imageInputs: options.imageInputs } : {}),
            ...(options.modelAdapter
              ? { modelAdapter: options.modelAdapter }
              : {}),
            ...(options.monitorModelAdapter
              ? { monitorModelAdapter: options.monitorModelAdapter }
              : {}),
            ...(options.additionalToolDefinitions
              ? { additionalToolDefinitions: options.additionalToolDefinitions }
              : {}),
            ...(options.systemPromptSections
              ? { systemPromptSections: options.systemPromptSections }
              : {}),
            ...(options.structuredOutput
              ? { structuredOutput: options.structuredOutput }
              : {}),
            ...(options.onStateChange
              ? { onStateChange: options.onStateChange }
              : {}),
            ...(options.onActionOutput
              ? { onActionOutput: options.onActionOutput }
              : {}),
            ...(options.onStreamActivity
              ? { onStreamActivity: options.onStreamActivity }
              : {}),
          });

          const cancelledAfterModelExecution = await maybeReturnCancelledResult(
            task,
            config,
            state,
            message,
            runtime,
            options,
          );

          if (cancelledAfterModelExecution) {
            return cancelledAfterModelExecution;
          }

          if (modelDrivenResult) {
            return emitTerminalResult(
              task,
              config,
              TASK_EXECUTION_STATUS_TO_TERMINAL_STATE[modelDrivenResult.status],
              modelDrivenResult.summary,
              runtime,
              options,
              modelDrivenResult,
            );
          }
        }

        if (
          !runtime.explicitPathReference &&
          !runtime.createFileTarget &&
          !runtime.inspectionTarget
        ) {
          const unavailable = createLiveExecutionUnavailableMessage(config);

          return emitTerminalResult(
            task,
            config,
            "unsupported",
            unavailable.summary,
            runtime,
            options,
            createExecutionResult(
              {
                task,
                mode: config.mode,
                status: "unsupported",
                summary: unavailable.summary,
                executedTools: [],
                outputSections: [
                  ...runtime.contextSections,
                  {
                    title: "Live execution",
                    lines: unavailable.sectionLines,
                  },
                ],
              },
              unavailable.reason,
            ),
          );
        }

        if (config.mode === "ask" && runtime.createFileTarget) {
          return emitTerminalResult(
            task,
            config,
            "blocked",
            "Ask mode cannot run the required filesystem write.",
            runtime,
            options,
            createExecutionResult(
              {
                task,
                mode: config.mode,
                status: "blocked",
                summary: `This task can be executed as a deterministic ${createFileWriteLabel()}, but Ask mode is read-only.`,
                executedTools: [],
                outputSections: runtime.contextSections,
              },
              "Switch to machdoch mode to let the agent create or modify files.",
            ),
          );
        }

        state = "executing";
        message = runtime.createFileTarget
          ? "Execute the deterministic workspace file creation."
          : runtime.explicitPathReference
            ? "Execute the explicit filesystem inspection target."
            : `Execute the read-only ${getInspectionLabel(runtime.inspectionTarget ?? "workspace")}.`;
        break;
      }

      case "executing": {
        runtime.pendingResult = runtime.createFileTarget
          ? await executeCreateFileTarget(
              task,
              config,
              runtime.contextSections,
              runtime.createFileTarget,
            )
          : runtime.explicitPathReference
            ? await executeExplicitInspectionPath(
                task,
                config,
                runtime.contextSections,
                runtime.explicitPathReference,
              )
            : await executeInspectionTarget(
                task,
                config,
                customizations,
                runtime.contextSections,
                runtime.inspectionTarget,
              );
        runtime.executedTools = runtime.pendingResult.executedTools;

        const cancelledAfterExecution = await maybeReturnCancelledResult(
          task,
          config,
          state,
          message,
          runtime,
          options,
        );

        if (cancelledAfterExecution) {
          return cancelledAfterExecution;
        }

        if (runtime.pendingResult.status !== "executed") {
          return emitTerminalResult(
            task,
            config,
            TASK_EXECUTION_STATUS_TO_TERMINAL_STATE[
              runtime.pendingResult.status
            ],
            runtime.pendingResult.summary,
            runtime,
            options,
            runtime.pendingResult,
          );
        }

        state = "verifying";
        message =
          "Verify the execution result before declaring the task complete.";
        break;
      }

      case "verifying": {
        const pendingResult = runtime.pendingResult;

        if (!pendingResult) {
          return emitTerminalResult(
            task,
            config,
            "blocked",
            "The execution loop had nothing to verify.",
            runtime,
            options,
            createInvariantViolationResult(
              task,
              config,
              runtime,
              "The execution loop reached verification without a result to verify.",
              "Internal invariant failed: pending result was undefined during verification.",
            ),
          );
        }

        const verificationFailure = verifyExecutedResult(pendingResult);

        if (verificationFailure) {
          return emitTerminalResult(
            task,
            config,
            "blocked",
            "Verification failed for the executed task.",
            runtime,
            options,
            createExecutionResult(
              {
                task,
                mode: config.mode,
                status: "blocked",
                summary:
                  "Execution completed, but the result could not be verified safely.",
                executedTools: pendingResult.executedTools,
                outputSections: pendingResult.outputSections,
              },
              verificationFailure,
            ),
          );
        }

        return emitTerminalResult(
          task,
          config,
          "completed",
          pendingResult.summary,
          runtime,
          options,
          pendingResult,
        );
      }
    }
  }
};

export interface TaskExecutionController {
  readonly signal: AbortSignal;
  cancel(reason?: string): void;
  execute(): Promise<TaskExecutionResult>;
}

export const createTaskExecutionController = (
  task: string,
  config: RuntimeConfig,
  customizations: CustomizationDiscoveryResult,
  options: Omit<TaskExecutionOptions, "signal"> = {},
): TaskExecutionController => {
  const abortController = new AbortController();

  return {
    signal: abortController.signal,
    cancel: (reason?: string): void => {
      if (!abortController.signal.aborted) {
        abortController.abort(reason ?? "Execution cancelled by user.");
      }
    },
    execute: async (): Promise<TaskExecutionResult> => {
      const managedTimeout = createManagedTaskExecutionTimeout(
        abortController.signal,
        resolveTaskExecutionTimeouts(options),
      );

      let fileChangeCapture: Awaited<
        ReturnType<typeof startTaskFileChangeCapture>
      > = undefined;

      try {
        fileChangeCapture =
          config.mode === "machdoch"
            ? await startTaskFileChangeCapture(config.workspaceRoot)
            : undefined;
        const result = await runTaskExecutionStateMachine(
          task,
          config,
          customizations,
          createActivityAwareExecutionOptions(options, managedTimeout),
        );
        const fileChanges = await fileChangeCapture?.finish();

        const consolidatedResult = await consolidateTaskExecutionMemory(
          task,
          config,
          result,
          options.conversationContext,
          { signal: managedTimeout.signal },
        );

        return fileChanges
          ? { ...consolidatedResult, fileChanges }
          : consolidatedResult;
      } finally {
        await fileChangeCapture?.dispose();
        managedTimeout.cleanup();
      }
    },
  };
};

export const executeTask = async (
  task: string,
  config: RuntimeConfig,
  customizations: CustomizationDiscoveryResult,
  options: TaskExecutionOptions = {},
): Promise<TaskExecutionResult> => {
  const managedTimeout = createManagedTaskExecutionTimeout(
    options.signal,
    resolveTaskExecutionTimeouts(options),
  );

  try {
    const result = await runTaskExecutionStateMachine(
      task,
      config,
      customizations,
      createActivityAwareExecutionOptions(options, managedTimeout),
    );

    return await consolidateTaskExecutionMemory(
      task,
      config,
      result,
      options.conversationContext,
      { signal: managedTimeout.signal },
    );
  } finally {
    managedTimeout.cleanup();
  }
};
