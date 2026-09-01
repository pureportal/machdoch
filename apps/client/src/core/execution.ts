import {
  createFileWriteLabel,
  executeCreateFileTarget,
  executeExplicitInspectionPath,
  executeInspectionTarget,
  getInspectionLabel,
} from "./_helpers/deterministic-task-execution.js";
import { resolveDeterministicAction } from "./_helpers/deterministic-action.js";
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
import {
  attachInstructionDeliveryMetadata,
  maybeExecuteModelDrivenTask,
} from "./agent-runtime.js";
import { consolidateTaskExecutionMemory } from "./memory-consolidation.js";
import { runWithTaskModelUsageRecording } from "./model-usage.js";
import { resolveTaskContext } from "./task-context.js";
import { runWithWorkspaceAgentPresence } from "./_helpers/workspace-agent-presence.js";
import {
  createInstructionDeliveryPlan,
  resolveInstructionSet,
  type InstructionDeliveryPlan,
  type InstructionDeliveryReceipt,
} from "./instruction-system/index.js";
import { createInstructionDeliveryPlanForRuntime } from "./provider-enrollment/instruction-delivery-preflight.js";
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

const shouldPrepareModelInstructionDelivery = (
  config: RuntimeConfig,
  options: TaskExecutionOptions,
): boolean =>
  options.deterministicAction === undefined &&
  (options.modelAdapter !== undefined ||
    (!config.offline &&
      config.provider !== "unconfigured" &&
      providerIsConfigured(config)));

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
        summary: `This task needs the model-driven agent loop, but the selected provider \`${config.provider}\` is not configured.`,
        reason: `Install ${label} so its binary is on PATH, or configure \`agent-cli.${config.provider}.path\` with the CLI binary path.`,
        sectionLines,
      };
    }

    return {
      summary: `This task needs the model-driven agent loop, but the selected provider \`${config.provider}\` is not configured.`,
      reason: `Configure \`api.${config.provider}.key\`, choose another configured provider, or check the user config path if this command is running with sudo or elevation.`,
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
    deterministicAction: undefined,
    pendingResult: undefined,
    executedTools: [],
  };

  let state: TaskExecutionState = "starting";
  let message = "Initialize the task execution loop.";
  let instructionDeliveryPlan: InstructionDeliveryPlan | undefined =
    options.instructionDeliveryPlan;
  const instructionDeliveryReceipts: InstructionDeliveryReceipt[] =
    options.instructionDeliveryReceipts ?? [];
  const attachResolvedInstructionMetadata = (
    result: TaskExecutionResult,
  ): TaskExecutionResult => {
    if (Array.isArray(result.metadata?.instructionDeliveryPlans)) {
      return result;
    }

    const instructionResolution = runtime.taskContext?.instructionResolution;
    if (!instructionResolution) {
      return result;
    }

    instructionDeliveryPlan ??= createInstructionDeliveryPlan(
      instructionResolution,
    );

    return attachInstructionDeliveryMetadata(
      result,
      instructionResolution,
      instructionDeliveryPlan,
      [instructionDeliveryPlan],
      instructionDeliveryReceipts,
    );
  };
  const emitTerminalResultWithInstructions = (
    terminalTask: string,
    terminalConfig: RuntimeConfig,
    terminalState: TaskExecutionState,
    terminalMessage: string,
    terminalRuntime: TaskExecutionRuntime,
    terminalOptions: TaskExecutionOptions,
    result: TaskExecutionResult,
  ): Promise<TaskExecutionResult> =>
    emitTerminalResult(
      terminalTask,
      terminalConfig,
      terminalState,
      terminalMessage,
      terminalRuntime,
      terminalOptions,
      attachResolvedInstructionMetadata(result),
    );

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
      return attachResolvedInstructionMetadata(cancelledBeforeStep);
    }

    switch (state) {
      case "starting": {
        state = "resolving-context";
        message =
          "Resolve prompt inputs, workspace paths, and applicable instructions.";
        break;
      }

      case "resolving-context": {
        const configuredProvider =
          config.provider === "unconfigured" ? "openai" : config.provider;
        const instructionResolution =
          options.resolvedInstructions ??
          (await resolveInstructionSet({
            workspaceRoot: config.workspaceRoot,
            providerId: configuredProvider,
            surface: isAgentCliProvider(configuredProvider) ? "cli" : "api",
            model: config.model,
            ...(options.instructionFlow === undefined
              ? {}
              : { flow: options.instructionFlow }),
          }));
        runtime.taskContext = resolveTaskContext(task, customizations, {
          ...(options.executionRole
            ? { executionRole: options.executionRole }
            : {}),
          instructionResolution,
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
          return emitTerminalResultWithInstructions(
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
          return emitTerminalResultWithInstructions(
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

        const actionResolution = resolveDeterministicAction(
          options.deterministicAction,
          config.workspaceRoot,
        );

        if (actionResolution.state === "invalid") {
          return emitTerminalResultWithInstructions(
            task,
            config,
            "blocked",
            "The requested deterministic action is invalid.",
            runtime,
            options,
            createExecutionResult(
              {
                task,
                mode: config.mode,
                status: "blocked",
                summary: "The structured deterministic action was rejected.",
                executedTools: [],
                outputSections: runtime.contextSections,
              },
              actionResolution.reason,
            ),
          );
        }

        runtime.deterministicAction =
          actionResolution.state === "resolved"
            ? actionResolution.action
            : undefined;

        state = "checking-tools";
        message =
          "Resolve the available tool surface before any execution starts.";
        break;
      }

      case "checking-tools": {
        if (runtime.taskContext && !runtime.deterministicAction) {
          const instructionResolution =
            runtime.taskContext.instructionResolution;
          if (!instructionResolution) {
            return emitTerminalResultWithInstructions(
              task,
              config,
              "blocked",
              "Instruction resolution was not available at the provider boundary.",
              runtime,
              options,
              createInvariantViolationResult(
                task,
                config,
                runtime,
                "The provider call was blocked because its immutable instruction snapshot was missing.",
                "Internal invariant failed: instruction resolution was undefined.",
              ),
            );
          }
          if (
            instructionDeliveryPlan === undefined &&
            shouldPrepareModelInstructionDelivery(config, options)
          ) {
            instructionDeliveryPlan =
              await createInstructionDeliveryPlanForRuntime(
                instructionResolution,
                {
                  workspaceRoot: config.workspaceRoot,
                  reasoning: config.reasoning,
                },
              );
          }
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
            ...(options.imageInputs
              ? { imageInputs: options.imageInputs }
              : {}),
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
            ...(options.resultProtocol
              ? { resultProtocol: options.resultProtocol }
              : {}),
            ...(instructionDeliveryPlan === undefined
              ? {}
              : { instructionDeliveryPlan }),
            instructionDeliveryReceipts,
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
            return attachResolvedInstructionMetadata(
              cancelledAfterModelExecution,
            );
          }

          if (modelDrivenResult) {
            return emitTerminalResultWithInstructions(
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

        if (!runtime.deterministicAction) {
          const unavailable = createLiveExecutionUnavailableMessage(config);

          return emitTerminalResultWithInstructions(
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

        if (
          config.mode === "ask" &&
          runtime.deterministicAction.kind === "create-file"
        ) {
          return emitTerminalResultWithInstructions(
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
        message =
          runtime.deterministicAction.kind === "create-file"
            ? "Execute the deterministic workspace file creation."
            : runtime.deterministicAction.kind === "inspect-path"
              ? "Execute the explicit filesystem inspection target."
              : `Execute the read-only ${getInspectionLabel(runtime.deterministicAction.target)}.`;
        break;
      }

      case "executing": {
        const action = runtime.deterministicAction;
        if (!action) {
          return emitTerminalResultWithInstructions(
            task,
            config,
            "blocked",
            "The deterministic action was lost before execution.",
            runtime,
            options,
            createInvariantViolationResult(
              task,
              config,
              runtime,
              "The execution loop reached deterministic execution without an action.",
              "Internal invariant failed: deterministic action was undefined.",
            ),
          );
        }

        switch (action.kind) {
          case "create-file":
            runtime.pendingResult = await executeCreateFileTarget(
              task,
              config,
              runtime.contextSections,
              action.target,
              action.content,
            );
            break;
          case "inspect-path":
            runtime.pendingResult = await executeExplicitInspectionPath(
              task,
              config,
              runtime.contextSections,
              action.target,
            );
            break;
          case "inspect":
            runtime.pendingResult = await executeInspectionTarget(
              task,
              config,
              customizations,
              runtime.contextSections,
              action.target,
            );
            break;
        }
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
          return attachResolvedInstructionMetadata(cancelledAfterExecution);
        }

        if (runtime.pendingResult.status !== "executed") {
          return emitTerminalResultWithInstructions(
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
          return emitTerminalResultWithInstructions(
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
          return emitTerminalResultWithInstructions(
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

        return emitTerminalResultWithInstructions(
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

  const controller: TaskExecutionController = {
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
          config.mode === "machdoch" && options.captureFileChanges !== false
            ? await startTaskFileChangeCapture(config.workspaceRoot)
            : undefined;
        return await runWithTaskModelUsageRecording(async () => {
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
        });
      } finally {
        await fileChangeCapture?.dispose();
        managedTimeout.cleanup();
      }
    },
  };

  return {
    ...controller,
    execute: () =>
      runWithWorkspaceAgentPresence(
        config.workspaceRoot,
        config.mode,
        options.executionRole ?? "executor",
        controller.execute,
      ),
  };
};

const executeTaskWithoutWorkspacePresence = async (
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
    return await runWithTaskModelUsageRecording(async () => {
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
    });
  } finally {
    managedTimeout.cleanup();
  }
};

export const executeTask = async (
  task: string,
  config: RuntimeConfig,
  customizations: CustomizationDiscoveryResult,
  options: TaskExecutionOptions = {},
): Promise<TaskExecutionResult> => {
  return runWithWorkspaceAgentPresence(
    config.workspaceRoot,
    config.mode,
    options.executionRole ?? "executor",
    () =>
      executeTaskWithoutWorkspacePresence(
        task,
        config,
        customizations,
        options,
      ),
  );
};
