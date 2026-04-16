import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { maybeExecuteModelDrivenTask } from "./agent-runtime.js";
import {
  createContextSections,
  createCustomizationSummarySection,
  createDirectoryPreviewSection,
  createFilePreviewSection,
  createFileTargetSection,
  createInitialFileContent,
  createInstructionFilesSection,
  createProfilesSection,
  createPromptFilesSection,
  createProviderAvailabilitySection,
  createRuntimeConfigSection,
  createSkillFilesSection,
  createToolPoliciesSection,
  createWorkspaceInspectionSections,
} from "./_helpers/execution-sections.js";
import { resolveToolPolicies } from "./policy.js";
import { resolveTaskContext } from "./task-context.js";
import {
  resolveReadOnlyInspectionTarget,
  type ReadOnlyInspectionTarget,
} from "./task-inspection.js";
import {
  extractExplicitInspectionPathReference,
  resolveDeterministicCreateFileTarget,
  type CreateFilePathReference,
  type TaskPathReference,
} from "./task-paths.js";
import type {
  CustomizationDiscoveryResult,
  ResolvedTaskContext,
  ResolvedToolPolicy,
  RuntimeConfig,
  TaskExecutionOptions,
  TaskExecutionProgress,
  TaskExecutionResult,
  TaskExecutionSection,
  TaskExecutionState,
  ToolName,
} from "./types.js";

interface TaskExecutionRuntime {
  taskContext: ResolvedTaskContext | undefined;
  contextSections: TaskExecutionSection[];
  explicitPathReference: TaskPathReference | undefined;
  createFileTarget: CreateFilePathReference | undefined;
  inspectionTarget: ReadOnlyInspectionTarget | undefined;
  filesystemPolicy: ResolvedToolPolicy | undefined;
  pendingResult: TaskExecutionResult | undefined;
  executedTools: ToolName[];
}

const createExecutionResult = (
  base: Omit<TaskExecutionResult, "reason">,
  reason?: string,
): TaskExecutionResult => {
  return {
    ...base,
    ...(reason ? { reason } : {}),
  };
};

const createInvariantViolationResult = (
  task: string,
  config: RuntimeConfig,
  runtime: TaskExecutionRuntime,
  summary: string,
  reason: string,
): TaskExecutionResult => {
  return createExecutionResult(
    {
      task,
      mode: config.mode,
      status: "blocked",
      summary,
      executedTools: runtime.executedTools,
      outputSections: runtime.contextSections,
    },
    reason,
  );
};

const isTerminalExecutionState = (state: TaskExecutionState): boolean => {
  return (
    state === "completed" ||
    state === "approval-required" ||
    state === "blocked" ||
    state === "unsupported" ||
    state === "cancelled"
  );
};

const createProgressSnapshot = (
  task: string,
  config: RuntimeConfig,
  state: TaskExecutionState,
  message: string,
  runtime: TaskExecutionRuntime,
  result?: TaskExecutionResult,
): TaskExecutionProgress => {
  return {
    task,
    mode: config.mode,
    state,
    message,
    executedTools:
      result?.executedTools ??
      runtime.pendingResult?.executedTools ??
      runtime.executedTools,
    outputSections:
      result?.outputSections ??
      runtime.pendingResult?.outputSections ??
      runtime.contextSections,
    cancellable: !isTerminalExecutionState(state),
    ...(result?.reason ? { reason: result.reason } : {}),
  };
};

const emitExecutionState = async (
  task: string,
  config: RuntimeConfig,
  state: TaskExecutionState,
  message: string,
  runtime: TaskExecutionRuntime,
  options: TaskExecutionOptions,
  result?: TaskExecutionResult,
): Promise<void> => {
  await options.onStateChange?.(
    createProgressSnapshot(task, config, state, message, runtime, result),
  );
};

const getCancellationReason = (signal: AbortSignal | undefined): string => {
  const reason = signal?.reason;

  if (reason instanceof Error && reason.message.trim().length > 0) {
    return reason.message;
  }

  if (typeof reason === "string" && reason.trim().length > 0) {
    return reason;
  }

  return "Execution cancelled by user.";
};

const createCancellationSection = (
  state: TaskExecutionState,
  message: string,
): TaskExecutionSection => {
  return {
    title: "Cancellation",
    lines: [`state: ${state}`, `message: ${message}`],
  };
};

const createCancelledResult = (
  task: string,
  config: RuntimeConfig,
  state: TaskExecutionState,
  message: string,
  runtime: TaskExecutionRuntime,
  signal: AbortSignal | undefined,
): TaskExecutionResult => {
  const baseSections =
    runtime.pendingResult?.outputSections.length &&
    runtime.pendingResult.outputSections.length > 0
      ? runtime.pendingResult.outputSections
      : runtime.contextSections;

  return createExecutionResult(
    {
      task,
      mode: config.mode,
      status: "cancelled",
      summary: "Execution was cancelled before the task completed.",
      executedTools:
        runtime.pendingResult?.executedTools ?? runtime.executedTools,
      outputSections: [
        ...baseSections,
        createCancellationSection(state, message),
      ],
    },
    getCancellationReason(signal),
  );
};

const maybeReturnCancelledResult = async (
  task: string,
  config: RuntimeConfig,
  state: TaskExecutionState,
  message: string,
  runtime: TaskExecutionRuntime,
  options: TaskExecutionOptions,
): Promise<TaskExecutionResult | undefined> => {
  if (!options.signal?.aborted) {
    return undefined;
  }

  const result = createCancelledResult(
    task,
    config,
    state,
    message,
    runtime,
    options.signal,
  );

  await emitExecutionState(
    task,
    config,
    "cancelled",
    result.summary,
    runtime,
    options,
    result,
  );

  return result;
};

const emitTerminalResult = async (
  task: string,
  config: RuntimeConfig,
  state: TaskExecutionState,
  message: string,
  runtime: TaskExecutionRuntime,
  options: TaskExecutionOptions,
  result: TaskExecutionResult,
): Promise<TaskExecutionResult> => {
  runtime.pendingResult = result;
  runtime.executedTools = result.executedTools;

  await emitExecutionState(
    task,
    config,
    state,
    message,
    runtime,
    options,
    result,
  );

  return result;
};

const verifyExecutedResult = (
  result: TaskExecutionResult,
): string | undefined => {
  if (result.outputSections.length === 0) {
    return "The executor completed without producing any observable output sections.";
  }

  return undefined;
};

const getInspectionLabel = (
  inspectionTarget: ReadOnlyInspectionTarget,
): string => {
  switch (inspectionTarget) {
    case "workspace": {
      return "workspace inspection";
    }
    case "runtime-config": {
      return "runtime configuration inspection";
    }
    case "tools": {
      return "tool policy inspection";
    }
    case "profiles": {
      return "profile inspection";
    }
    case "instructions": {
      return "instruction inspection";
    }
    case "prompts": {
      return "prompt inspection";
    }
    case "skills": {
      return "skill inspection";
    }
    case "customizations": {
      return "customization inspection";
    }
  }
};

const createFileWriteLabel = (): string => {
  return "workspace file creation";
};

const executeCreateFileTarget = async (
  task: string,
  config: RuntimeConfig,
  contextSections: TaskExecutionSection[],
  fileTarget: CreateFilePathReference,
): Promise<TaskExecutionResult> => {
  if (!fileTarget.insideWorkspace) {
    return createExecutionResult(
      {
        task,
        mode: config.mode,
        status: "blocked",
        summary:
          "The requested file target is outside the workspace boundary, so the runtime refused to create it.",
        executedTools: [],
        outputSections: contextSections,
      },
      `Refusing to create \`${fileTarget.requestedPath}\` because it resolves outside ${config.workspaceRoot}.`,
    );
  }

  if (existsSync(fileTarget.resolvedPath)) {
    const existingStats = await stat(fileTarget.resolvedPath);

    return createExecutionResult(
      {
        task,
        mode: config.mode,
        status: "blocked",
        summary: existingStats.isDirectory()
          ? "The requested target already exists as a directory, so the runtime refused to replace it with a file."
          : "The requested file already exists, so the runtime refused to overwrite it during a create-file task.",
        executedTools: [],
        outputSections: [
          ...contextSections,
          createFileTargetSection(fileTarget),
        ],
      },
      `The path \`${fileTarget.requestedPath}\` already exists inside the workspace.`,
    );
  }

  const content = createInitialFileContent(task, fileTarget);

  await mkdir(dirname(fileTarget.resolvedPath), { recursive: true });
  await writeFile(fileTarget.resolvedPath, content, "utf8");

  return createExecutionResult({
    task,
    mode: config.mode,
    status: "executed",
    summary:
      "Executed a deterministic workspace file creation and returned a preview of the created content.",
    executedTools: ["filesystem"],
    outputSections: [
      ...contextSections,
      createFileTargetSection(fileTarget),
      content.length > 0
        ? createFilePreviewSection(content)
        : {
            title: "File preview",
            lines: ["Empty file created."],
          },
    ],
  });
};


const executeExplicitInspectionPath = async (
  task: string,
  config: RuntimeConfig,
  contextSections: TaskExecutionSection[],
  explicitPathReference: TaskPathReference,
): Promise<TaskExecutionResult> => {
  if (!explicitPathReference.insideWorkspace) {
    return createExecutionResult(
      {
        task,
        mode: config.mode,
        status: "blocked",
        summary:
          "The requested file is outside the workspace boundary, so the runtime refused to read it.",
        executedTools: [],
        outputSections: contextSections,
      },
      `Refusing to read \`${explicitPathReference.requestedPath}\` because it resolves outside ${config.workspaceRoot}.`,
    );
  }

  try {
    const fileStats = await stat(explicitPathReference.resolvedPath);
    const relativePath = relative(
      config.workspaceRoot,
      explicitPathReference.resolvedPath,
    )
      .split("\\")
      .join("/");

    if (fileStats.isDirectory()) {
      return createExecutionResult({
        task,
        mode: config.mode,
        status: "executed",
        summary:
          "Executed a safe, read-only directory inspection and returned a truncated entry listing.",
        executedTools: ["filesystem"],
        outputSections: [
          ...contextSections,
          {
            title: "Directory target",
            lines: [
              `requested: ${explicitPathReference.requestedPath}`,
              `workspace path: ${relativePath}`,
            ],
          },
          await createDirectoryPreviewSection(
            explicitPathReference.resolvedPath,
          ),
        ],
      });
    }

    if (!fileStats.isFile()) {
      return createExecutionResult(
        {
          task,
          mode: config.mode,
          status: "blocked",
          summary:
            "The requested path exists, but it is not a regular file or directory that can be previewed.",
          executedTools: [],
          outputSections: contextSections,
        },
        `The path \`${explicitPathReference.requestedPath}\` is not a regular file or directory.`,
      );
    }

    const raw = await readFile(explicitPathReference.resolvedPath);
    const appearsBinary = raw.includes(0);
    const baseSections: TaskExecutionSection[] = [
      {
        title: "File target",
        lines: [
          `requested: ${explicitPathReference.requestedPath}`,
          `workspace path: ${relativePath}`,
          `size: ${fileStats.size} bytes`,
        ],
      },
    ];

    if (appearsBinary) {
      return createExecutionResult({
        task,
        mode: config.mode,
        status: "executed",
        summary:
          "Executed a safe file inspection, but withheld the preview because the file appears to be binary.",
        executedTools: ["filesystem"],
        outputSections: [
          ...contextSections,
          ...baseSections,
          {
            title: "File preview",
            lines: ["Binary-looking content detected; text preview skipped."],
          },
        ],
      });
    }

    const content = raw.toString("utf8");

    return createExecutionResult({
      task,
      mode: config.mode,
      status: "executed",
      summary:
        "Executed a safe, read-only file inspection and returned a truncated text preview.",
      executedTools: ["filesystem"],
      outputSections: [
        ...contextSections,
        ...baseSections,
        createFilePreviewSection(content),
      ],
    });
  } catch {
    return createExecutionResult(
      {
        task,
        mode: config.mode,
        status: "blocked",
        summary: "The requested file could not be found inside the workspace.",
        executedTools: [],
        outputSections: contextSections,
      },
      `The path \`${explicitPathReference.requestedPath}\` could not be read from the workspace.`,
    );
  }
};

const executeInspectionTarget = async (
  task: string,
  config: RuntimeConfig,
  customizations: CustomizationDiscoveryResult,
  contextSections: TaskExecutionSection[],
  inspectionTarget: ReadOnlyInspectionTarget | undefined,
): Promise<TaskExecutionResult> => {
  switch (inspectionTarget) {
    case "runtime-config": {
      return createExecutionResult({
        task,
        mode: config.mode,
        status: "executed",
        summary:
          "Executed a safe, read-only inspection of the resolved runtime configuration.",
        executedTools: ["filesystem"],
        outputSections: [
          ...contextSections,
          createRuntimeConfigSection(config),
          createProviderAvailabilitySection(config),
        ],
      });
    }

    case "tools": {
      return createExecutionResult({
        task,
        mode: config.mode,
        status: "executed",
        summary:
          "Executed a safe, read-only inspection of the registered tools and their resolved policies.",
        executedTools: ["filesystem"],
        outputSections: [...contextSections, createToolPoliciesSection(config)],
      });
    }

    case "profiles": {
      return createExecutionResult({
        task,
        mode: config.mode,
        status: "executed",
        summary:
          "Executed a safe, read-only inspection of the available runtime profiles.",
        executedTools: ["filesystem"],
        outputSections: [...contextSections, createProfilesSection(config)],
      });
    }

    case "instructions": {
      return createExecutionResult({
        task,
        mode: config.mode,
        status: "executed",
        summary:
          "Executed a safe, read-only inspection of the discovered instruction files.",
        executedTools: ["filesystem"],
        outputSections: [
          ...contextSections,
          createCustomizationSummarySection(customizations),
          createInstructionFilesSection(customizations),
        ],
      });
    }

    case "prompts": {
      return createExecutionResult({
        task,
        mode: config.mode,
        status: "executed",
        summary:
          "Executed a safe, read-only inspection of the discovered prompt files.",
        executedTools: ["filesystem"],
        outputSections: [
          ...contextSections,
          createCustomizationSummarySection(customizations),
          createPromptFilesSection(customizations),
        ],
      });
    }

    case "skills": {
      return createExecutionResult({
        task,
        mode: config.mode,
        status: "executed",
        summary:
          "Executed a safe, read-only inspection of the discovered skill folders.",
        executedTools: ["filesystem"],
        outputSections: [
          ...contextSections,
          createCustomizationSummarySection(customizations),
          createSkillFilesSection(customizations),
        ],
      });
    }

    case "customizations": {
      return createExecutionResult({
        task,
        mode: config.mode,
        status: "executed",
        summary:
          "Executed a safe, read-only inspection of the discovered workspace customizations.",
        executedTools: ["filesystem"],
        outputSections: [
          ...contextSections,
          createCustomizationSummarySection(customizations),
          createInstructionFilesSection(customizations),
          createPromptFilesSection(customizations),
          createSkillFilesSection(customizations),
        ],
      });
    }

    case "workspace":
    case undefined: {
      const outputSections = await createWorkspaceInspectionSections(
        config,
        customizations,
        contextSections,
      );

      return createExecutionResult({
        task,
        mode: config.mode,
        status: "executed",
        summary:
          "Executed a safe, read-only filesystem inspection of the workspace and summarized the current setup.",
        executedTools: ["filesystem"],
        outputSections,
      });
    }
  }
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
