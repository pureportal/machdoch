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
import { maybeExecuteModelDrivenTask } from "./agent-runtime.js";
import { resolveToolPolicies } from "./policy.js";
import { resolveTaskContext } from "./task-context.js";
import { resolveReadOnlyInspectionTarget } from "./task-inspection.js";
import {
  extractExplicitInspectionPathReference,
  resolveDeterministicCreateFileTarget,
} from "./task-paths.js";
import type {
  CustomizationDiscoveryResult,
  RuntimeConfig,
  TaskExecutionOptions,
  TaskExecutionResult,
  TaskExecutionState,
} from "./types.js";

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
    filesystemPolicy: undefined,
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
        runtime.taskContext = resolveTaskContext(task, config, customizations);
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

        state = "checking-policies";
        message =
          "Resolve tool approvals and blocked tools before any execution starts.";
        break;
      }

      case "checking-policies": {
        if (runtime.taskContext) {
          const modelDrivenResult = await maybeExecuteModelDrivenTask({
            task,
            config,
            taskContext: runtime.taskContext,
            contextSections: runtime.contextSections,
            ...(options.conversationContext
              ? { conversationContext: options.conversationContext }
              : {}),
            ...(options.modelAdapter
              ? { modelAdapter: options.modelAdapter }
              : {}),
            ...(options.monitorModelAdapter
              ? { monitorModelAdapter: options.monitorModelAdapter }
              : {}),
            ...(options.onStateChange
              ? { onStateChange: options.onStateChange }
              : {}),
          });

          if (modelDrivenResult) {
            const terminalState: TaskExecutionState =
              modelDrivenResult.status === "executed"
                ? "completed"
                : modelDrivenResult.status === "approval-required"
                  ? "approval-required"
                  : modelDrivenResult.status === "unsupported"
                    ? "unsupported"
                    : modelDrivenResult.status === "cancelled"
                      ? "cancelled"
                      : "blocked";

            return emitTerminalResult(
              task,
              config,
              terminalState,
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
          return emitTerminalResult(
            task,
            config,
            "unsupported",
            "No deterministic execution path is available for this task yet.",
            runtime,
            options,
            createExecutionResult({
              task,
              mode: config.mode,
              status: "unsupported",
              summary:
                "Live execution is not implemented for this task yet, so the CLI will fall back to a staged preview.",
              executedTools: [],
              outputSections: runtime.contextSections,
            }),
          );
        }

        runtime.filesystemPolicy = resolveToolPolicies(config, [
          "filesystem",
        ])[0];

        if (
          !runtime.filesystemPolicy ||
          runtime.filesystemPolicy.decision === "blocked"
        ) {
          return emitTerminalResult(
            task,
            config,
            "blocked",
            "The required filesystem tool is blocked.",
            runtime,
            options,
            createExecutionResult(
              {
                task,
                mode: config.mode,
                status: "blocked",
                summary: runtime.explicitPathReference
                  ? "This task maps to a safe filesystem inspection, but the filesystem tool is currently blocked."
                  : `This task maps to a safe ${getInspectionLabel(runtime.inspectionTarget ?? "workspace")}, but the filesystem tool is currently blocked.`,
                executedTools: [],
                outputSections: runtime.contextSections,
              },
              runtime.filesystemPolicy?.reason ??
                "The filesystem tool is unavailable.",
            ),
          );
        }

        if (runtime.filesystemPolicy.decision === "ask") {
          return emitTerminalResult(
            task,
            config,
            "approval-required",
            "The task requires approval before the filesystem step can run.",
            runtime,
            options,
            createExecutionResult(
              {
                task,
                mode: config.mode,
                status: "approval-required",
                summary: runtime.createFileTarget
                  ? `This task can be executed as a deterministic ${createFileWriteLabel()}, but the current mode still requires explicit approval first.`
                  : runtime.explicitPathReference
                    ? "This task can be executed as a read-only filesystem inspection, but the current mode still requires explicit approval first."
                    : `This task can be executed as a read-only ${getInspectionLabel(runtime.inspectionTarget ?? "workspace")}, but the current mode still requires explicit approval first.`,
                executedTools: [],
                outputSections: runtime.contextSections,
              },
              runtime.filesystemPolicy.reason,
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
          const terminalState: TaskExecutionState =
            runtime.pendingResult.status === "approval-required"
              ? "approval-required"
              : runtime.pendingResult.status === "unsupported"
                ? "unsupported"
                : runtime.pendingResult.status === "cancelled"
                  ? "cancelled"
                  : "blocked";

          return emitTerminalResult(
            task,
            config,
            terminalState,
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
    execute: (): Promise<TaskExecutionResult> => {
      return runTaskExecutionStateMachine(task, config, customizations, {
        ...options,
        signal: abortController.signal,
      });
    },
  };
};

export const executeTask = async (
  task: string,
  config: RuntimeConfig,
  customizations: CustomizationDiscoveryResult,
  options: TaskExecutionOptions = {},
): Promise<TaskExecutionResult> => {
  return runTaskExecutionStateMachine(task, config, customizations, options);
};
