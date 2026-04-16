import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import {
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
} from "./execution-sections.js";
import { createExecutionResult } from "./execution-state.js";
import type {
  CustomizationDiscoveryResult,
  RuntimeConfig,
  TaskExecutionResult,
  TaskExecutionSection,
} from "../types.js";
import type { ReadOnlyInspectionTarget } from "../task-inspection.js";
import type {
  CreateFilePathReference,
  TaskPathReference,
} from "../task-paths.js";

export const getInspectionLabel = (
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

export const createFileWriteLabel = (): string => {
  return "workspace file creation";
};

export const executeCreateFileTarget = async (
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

export const executeExplicitInspectionPath = async (
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

export const executeInspectionTarget = async (
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
