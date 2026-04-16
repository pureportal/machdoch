import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { maybeExecuteModelDrivenTask } from "./agent-runtime.js";
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
  ResolvedPromptInvocation,
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

const MAX_TOP_LEVEL_ENTRIES = 12;
const MAX_FILE_PREVIEW_LINES = 80;
const MAX_DIRECTORY_ENTRIES = 40;

interface PackageSnapshot {
  invalidJson: boolean;
  name?: string;
  type?: string;
  scripts: string[];
}

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

const formatCommaSeparatedValues = (values: string[]): string => {
  return values.length > 0 ? values.join(", ") : "none";
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

const toTitleCase = (value: string): string => {
  return value
    .split(/[^A-Za-z0-9]+/u)
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1)}`)
    .join(" ");
};

const createInitialFileContent = (
  task: string,
  fileTarget: CreateFilePathReference,
): string => {
  const fileName = fileTarget.workspacePath ?? fileTarget.requestedPath;
  const extension = extname(fileName).toLowerCase();
  const baseName = basename(fileName, extension);
  const normalizedTask = task.toLowerCase();
  const humanTitle = toTitleCase(baseName) || "Untitled";

  if (normalizedTask.includes("empty file")) {
    return "";
  }

  switch (extension) {
    case ".json": {
      return '{\n  "createdBy": "machdoch"\n}\n';
    }

    case ".md": {
      return `# ${humanTitle}\n\nCreated by machdoch.\n`;
    }

    case ".ts":
    case ".js":
    case ".mjs":
    case ".cjs": {
      return "export {};\n";
    }

    case ".html": {
      return [
        "<!doctype html>",
        '<html lang="en">',
        "  <head>",
        '    <meta charset="utf-8" />',
        `    <title>${humanTitle}</title>`,
        "  </head>",
        "  <body>",
        "  </body>",
        "</html>",
        "",
      ].join("\n");
    }

    case ".css": {
      return "/* Created by machdoch */\n";
    }

    case ".yaml":
    case ".yml": {
      return "createdBy: machdoch\n";
    }

    case ".toml": {
      return 'created_by = "machdoch"\n';
    }

    default: {
      return normalizedTask.includes("test file")
        ? "This is a test file created by machdoch.\n"
        : "Created by machdoch.\n";
    }
  }
};

const createFileTargetSection = (
  fileTarget: CreateFilePathReference,
): TaskExecutionSection => {
  return {
    title: "File target",
    lines: [
      `requested: ${fileTarget.requestedPath}`,
      `workspace path: ${fileTarget.workspacePath ?? "outside workspace"}`,
      `path source: ${fileTarget.inferredPath ? "inferred default" : "explicit request"}`,
    ],
  };
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

const createFilePreviewSection = (content: string): TaskExecutionSection => {
  const normalizedContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const allLines = normalizedContent.split("\n");
  const previewLines = allLines
    .slice(0, MAX_FILE_PREVIEW_LINES)
    .map((line, index) => `${index + 1}: ${line}`);

  if (allLines.length > MAX_FILE_PREVIEW_LINES) {
    previewLines.push(
      `… truncated after ${MAX_FILE_PREVIEW_LINES} of ${allLines.length} lines`,
    );
  }

  return {
    title: "File preview",
    lines: previewLines,
  };
};

const sortEntryNames = (left: string, right: string): number => {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
};

const createDirectoryPreviewSection = async (
  directoryPath: string,
): Promise<TaskExecutionSection> => {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const ordered = entries.sort((left, right) => {
    const leftKind = left.isDirectory() ? 0 : 1;
    const rightKind = right.isDirectory() ? 0 : 1;

    if (leftKind !== rightKind) {
      return leftKind - rightKind;
    }

    return sortEntryNames(left.name, right.name);
  });

  const lines = ordered.slice(0, MAX_DIRECTORY_ENTRIES).map((entry) => {
    const kind = entry.isDirectory() ? "dir" : "file";
    return `${kind}: ${entry.name}`;
  });

  if (ordered.length > MAX_DIRECTORY_ENTRIES) {
    lines.push(
      `… truncated after ${MAX_DIRECTORY_ENTRIES} of ${ordered.length} entries`,
    );
  }

  if (lines.length === 0) {
    lines.push("Directory is empty.");
  }

  return {
    title: "Directory entries",
    lines,
  };
};

const listTopLevelEntries = async (
  workspaceRoot: string,
): Promise<string[]> => {
  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  const ordered = entries.sort((left, right) => {
    const leftKind = left.isDirectory() ? 0 : 1;
    const rightKind = right.isDirectory() ? 0 : 1;

    if (leftKind !== rightKind) {
      return leftKind - rightKind;
    }

    return sortEntryNames(left.name, right.name);
  });

  const visibleEntries = ordered
    .slice(0, MAX_TOP_LEVEL_ENTRIES)
    .map((entry) => {
      const kind = entry.isDirectory() ? "dir" : "file";
      return `${kind}: ${entry.name}`;
    });

  if (ordered.length > MAX_TOP_LEVEL_ENTRIES) {
    visibleEntries.push(
      `… ${ordered.length - MAX_TOP_LEVEL_ENTRIES} more top-level entries`,
    );
  }

  return visibleEntries;
};

const readPackageSnapshot = async (
  workspaceRoot: string,
): Promise<PackageSnapshot | undefined> => {
  const packageJsonPath = join(workspaceRoot, "package.json");

  if (!existsSync(packageJsonPath)) {
    return undefined;
  }

  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as {
      name?: unknown;
      scripts?: Record<string, unknown>;
      type?: unknown;
    };

    const scripts =
      typeof parsed.scripts === "object" && parsed.scripts !== null
        ? Object.keys(parsed.scripts).sort(sortEntryNames)
        : [];

    return {
      invalidJson: false,
      ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
      ...(typeof parsed.type === "string" ? { type: parsed.type } : {}),
      scripts,
    };
  } catch {
    return {
      invalidJson: true,
      scripts: [],
    };
  }
};

const createProjectSignalSection = async (
  workspaceRoot: string,
): Promise<TaskExecutionSection> => {
  const packageSnapshot = await readPackageSnapshot(workspaceRoot);
  const lines: string[] = [];

  if (!packageSnapshot) {
    lines.push("package.json: not present");
  } else if (packageSnapshot.invalidJson) {
    lines.push("package.json: present but invalid JSON");
  } else {
    lines.push(
      `package.json: present${packageSnapshot.name ? ` (${packageSnapshot.name})` : ""}`,
    );

    if (packageSnapshot.type) {
      lines.push(`module type: ${packageSnapshot.type}`);
    }

    if (packageSnapshot.scripts.length > 0) {
      lines.push(`scripts: ${packageSnapshot.scripts.join(", ")}`);
    }
  }

  for (const relativePath of [
    "README.md",
    "tsconfig.json",
    ".machdoch",
    ".github",
  ]) {
    lines.push(
      `${relativePath}: ${existsSync(join(workspaceRoot, relativePath)) ? "present" : "missing"}`,
    );
  }

  return {
    title: "Project signals",
    lines,
  };
};

const createRuntimeConfigSection = (
  config: RuntimeConfig,
): TaskExecutionSection => {
  const activeWebSearchConfigured =
    config.webSearch.activeProvider !== "none" &&
    config.webSearch.providerAvailability.some(
      (entry) =>
        entry.provider === config.webSearch.activeProvider && entry.configured,
    );

  return {
    title: "Runtime config",
    lines: [
      `workspace: ${config.workspaceRoot}`,
      `workspace config file: ${config.workspaceConfigPath ?? "not present"}`,
      `active profile: ${config.activeProfile ?? "none"}`,
      `named profiles: ${config.availableProfiles.length}`,
      `mode: ${config.mode}`,
      `provider: ${config.provider}`,
      `model: ${config.model}`,
      `offline: ${config.offline ? "true" : "false"}`,
      `enabled tools: ${formatCommaSeparatedValues(config.enabledTools)}`,
      `web search provider: ${config.webSearch.activeProvider}`,
      `web search status: ${activeWebSearchConfigured ? "available" : "hidden"}`,
      `github compatibility discovery: ${config.compatibility.discoverGithubCustomizations ? "enabled" : "disabled"}`,
    ],
  };
};

const createProviderAvailabilitySection = (
  config: RuntimeConfig,
): TaskExecutionSection => {
  return {
    title: "Provider availability",
    lines: config.providerAvailability.map(
      (entry) =>
        `${entry.provider}: ${entry.configured ? "configured" : "not configured"}`,
    ),
  };
};

const createProfilesSection = (config: RuntimeConfig): TaskExecutionSection => {
  if (config.availableProfiles.length === 0) {
    return {
      title: "Profiles",
      lines: [
        `active profile: ${config.activeProfile ?? "none"}`,
        "No named profiles are configured.",
      ],
    };
  }

  return {
    title: "Profiles",
    lines: [
      `active profile: ${config.activeProfile ?? "none"}`,
      ...config.availableProfiles.map((profile) => {
        const activeSuffix =
          config.activeProfile === profile.name ? " (active)" : "";

        return `${profile.name}${activeSuffix}${profile.description ? `: ${profile.description}` : ""}`;
      }),
    ],
  };
};

const createToolPoliciesSection = (
  config: RuntimeConfig,
): TaskExecutionSection => {
  const policies = resolveToolPolicies(config);

  return {
    title: "Tool policies",
    lines: policies.flatMap((policy) => [
      `${policy.tool.name} [${policy.tool.riskLevel}] -> ${policy.decision}`,
      `  description: ${policy.tool.description}`,
      `  reason: ${policy.reason}`,
    ]),
  };
};

const createCustomizationSummarySection = (
  customizations: CustomizationDiscoveryResult,
): TaskExecutionSection => {
  return {
    title: "Customization summary",
    lines: [
      `workspace: ${customizations.workspaceRoot}`,
      `instructions: ${customizations.instructions.length}`,
      `prompts: ${customizations.prompts.length}`,
      `skills: ${customizations.skills.length}`,
    ],
  };
};

const createInstructionFilesSection = (
  customizations: CustomizationDiscoveryResult,
): TaskExecutionSection => {
  if (customizations.instructions.length === 0) {
    return {
      title: "Instruction files",
      lines: ["No instruction files were discovered."],
    };
  }

  return {
    title: "Instruction files",
    lines: customizations.instructions.flatMap((instruction) => [
      `[${instruction.kind}] ${instruction.name} (${instruction.path})`,
      ...(instruction.description
        ? [`  description: ${instruction.description}`]
        : []),
      ...(instruction.applyTo ? [`  applyTo: ${instruction.applyTo}`] : []),
      ...(instruction.keywords.length > 0
        ? [`  keywords: ${instruction.keywords.join(", ")}`]
        : []),
      ...(instruction.priority !== undefined
        ? [`  priority: ${instruction.priority}`]
        : []),
      `  body: ${instruction.body}`,
    ]),
  };
};

const createPromptFilesSection = (
  customizations: CustomizationDiscoveryResult,
): TaskExecutionSection => {
  if (customizations.prompts.length === 0) {
    return {
      title: "Prompt files",
      lines: ["No prompt files were discovered."],
    };
  }

  return {
    title: "Prompt files",
    lines: customizations.prompts.flatMap((prompt) => [
      `${prompt.name} (${prompt.path})`,
      ...(prompt.description ? [`  description: ${prompt.description}`] : []),
      ...(prompt.argumentHint
        ? [`  argument hint: ${prompt.argumentHint}`]
        : []),
      ...(prompt.agent ? [`  agent: ${prompt.agent}`] : []),
      ...(prompt.model ? [`  model: ${prompt.model}`] : []),
      `  tools: ${formatCommaSeparatedValues(prompt.tools)}`,
      `  inputs: ${formatCommaSeparatedValues(prompt.inputs)}`,
      `  body: ${prompt.body}`,
    ]),
  };
};

const createSkillFilesSection = (
  customizations: CustomizationDiscoveryResult,
): TaskExecutionSection => {
  if (customizations.skills.length === 0) {
    return {
      title: "Skill files",
      lines: ["No skill folders were discovered."],
    };
  }

  return {
    title: "Skill files",
    lines: customizations.skills.flatMap((skill) => [
      `${skill.name} (${skill.path})`,
      `  description: ${skill.description}`,
      ...(skill.argumentHint ? [`  argument hint: ${skill.argumentHint}`] : []),
      `  user invocable: ${skill.userInvocable ? "true" : "false"}`,
      `  model invocation disabled: ${skill.disableModelInvocation ? "true" : "false"}`,
    ]),
  };
};

const createPromptContextSection = (
  invokedPrompt: ResolvedPromptInvocation,
  effectiveTask: string,
): TaskExecutionSection => {
  const resolvedInputs = Object.entries(invokedPrompt.inputValues).map(
    ([name, value]) => `${name}=${value}`,
  );

  return {
    title: "Prompt context",
    lines: [
      `prompt: /${invokedPrompt.name}`,
      `arguments: ${invokedPrompt.arguments.length > 0 ? invokedPrompt.arguments : "none"}`,
      `expanded task: ${effectiveTask}`,
      ...(resolvedInputs.length > 0
        ? [`resolved inputs: ${resolvedInputs.join(", ")}`]
        : []),
      ...(invokedPrompt.missingInputs.length > 0
        ? [`missing inputs: ${invokedPrompt.missingInputs.join(", ")}`]
        : []),
    ],
  };
};

const createTaskContextSection = (
  taskContext: ResolvedTaskContext,
): TaskExecutionSection => {
  return {
    title: "Task context",
    lines: [
      `task: ${taskContext.task}`,
      `effective task: ${taskContext.effectiveTask}`,
      `workspace paths: ${taskContext.workspacePaths.length > 0 ? taskContext.workspacePaths.join(", ") : "none"}`,
      `suggested tools: ${taskContext.suggestedTools.length > 0 ? taskContext.suggestedTools.join(", ") : "none"}`,
      ...(taskContext.blockedTools.length > 0
        ? [`blocked tools: ${taskContext.blockedTools.join(", ")}`]
        : []),
      ...(taskContext.approvalRequiredTools.length > 0
        ? [
            `approval-required tools: ${taskContext.approvalRequiredTools.join(", ")}`,
          ]
        : []),
    ],
  };
};

const createInstructionContextSection = (
  taskContext: ResolvedTaskContext,
): TaskExecutionSection | undefined => {
  if (taskContext.applicableInstructions.length === 0) {
    return undefined;
  }

  return {
    title: "Instruction context",
    lines: taskContext.applicableInstructions.flatMap((instruction) => [
      `${instruction.name} (${instruction.path})${instruction.priority > 0 ? ` [priority ${instruction.priority}]` : ""}`,
      `  reason: ${instruction.reason}`,
      `  body: ${instruction.body}`,
    ]),
  };
};

const createContextSections = (
  taskContext: ResolvedTaskContext,
  options?: {
    includeInstructions?: boolean;
  },
): TaskExecutionSection[] => {
  const instructionContextSection =
    options?.includeInstructions === false
      ? undefined
      : createInstructionContextSection(taskContext);

  return [
    ...(taskContext.invokedPrompt
      ? [
          createPromptContextSection(
            taskContext.invokedPrompt,
            taskContext.effectiveTask,
          ),
        ]
      : []),
    createTaskContextSection(taskContext),
    ...(instructionContextSection ? [instructionContextSection] : []),
  ];
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
      const activeWebSearchConfigured =
        config.webSearch.activeProvider !== "none" &&
        config.webSearch.providerAvailability.some(
          (entry) =>
            entry.provider === config.webSearch.activeProvider &&
            entry.configured,
        );
      const outputSections: TaskExecutionSection[] = [
        ...contextSections,
        {
          title: "Workspace context",
          lines: [
            `root: ${config.workspaceRoot}`,
            `active profile: ${config.activeProfile ?? "none"}`,
            `mode: ${config.mode}`,
            `provider: ${config.provider}`,
            `model: ${config.model}`,
            `offline: ${config.offline ? "true" : "false"}`,
            `enabled tools: ${config.enabledTools.join(", ")}`,
            `web search provider: ${config.webSearch.activeProvider}`,
            `web search status: ${activeWebSearchConfigured ? "available" : "hidden"}`,
          ],
        },
        {
          title: "Top-level entries",
          lines: await listTopLevelEntries(config.workspaceRoot),
        },
        await createProjectSignalSection(config.workspaceRoot),
        {
          title: "Customization summary",
          lines: [
            `instructions: ${customizations.instructions.length}`,
            `prompts: ${customizations.prompts.length}`,
            `skills: ${customizations.skills.length}`,
          ],
        },
      ];

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
