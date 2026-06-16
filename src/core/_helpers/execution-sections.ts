import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { sortEntryNames } from "../../common/_helpers/sort-entry-names.js";
import { resolveRuntimeAgentLimits } from "./agent-runtime-types.js";
import type { CreateFilePathReference } from "../task-paths.js";
import { getToolRegistry } from "../tools.js";
import type {
  CustomizationDiscoveryResult,
  ResolvedPromptInvocation,
  ResolvedTaskContext,
  TaskExecutionSection,
} from "../types.js";
import type { RuntimeConfig } from "../runtime-contract.generated.js";

const MAX_TOP_LEVEL_ENTRIES = 12;
const MAX_FILE_PREVIEW_LINES = 80;
const MAX_DIRECTORY_ENTRIES = 40;

interface PackageSnapshot {
  invalidJson: boolean;
  name?: string;
  type?: string;
  scripts: string[];
}

const formatCommaSeparatedValues = (values: string[]): string => {
  return values.length > 0 ? values.join(", ") : "none";
};

const formatAgentLimit = (limit: number | null): string => {
  return limit === null ? "infinite" : String(limit);
};

const toTitleCase = (value: string): string => {
  return value
    .split(/[^A-Za-z0-9]+/u)
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1)}`)
    .join(" ");
};

export const createInitialFileContent = (
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

export const createFileTargetSection = (
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

export const createFilePreviewSection = (
  content: string,
): TaskExecutionSection => {
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

export const createDirectoryPreviewSection = async (
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

export const createProjectSignalSection = async (
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

export const createRuntimeConfigSection = (
  config: RuntimeConfig,
): TaskExecutionSection => {
  const activeWebSearchConfigured =
    config.webSearch.activeProvider !== "none" &&
    config.webSearch.providerAvailability.some(
      (entry) =>
        entry.provider === config.webSearch.activeProvider && entry.configured,
    );
  const agentLimits = resolveRuntimeAgentLimits(config);

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
      `executor turns: ${formatAgentLimit(agentLimits.executorTurns)}`,
      `machdoch continuations: ${formatAgentLimit(agentLimits.autopilotExecutorIterations)}`,
      `web search provider: ${config.webSearch.activeProvider}`,
      `web search status: ${activeWebSearchConfigured ? "available" : "hidden"}`,
      `github compatibility discovery: ${config.compatibility.discoverGithubCustomizations ? "enabled" : "disabled"}`,
    ],
  };
};

export const createProviderAvailabilitySection = (
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

export const createProfilesSection = (
  config: RuntimeConfig,
): TaskExecutionSection => {
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

export const createToolSurfaceSection = (
  config: RuntimeConfig,
): TaskExecutionSection => {
  const modeLine =
    config.mode === "ask"
      ? "mode surface: ask exposes only read-only function calls"
      : "mode surface: machdoch exposes all function calls";

  return {
    title: "Function-call surface",
    lines: [
      modeLine,
      ...getToolRegistry().flatMap((tool) => [
        `${tool.name} [${tool.riskLevel}]`,
        `  description: ${tool.description}`,
      ]),
    ],
  };
};

export const createCustomizationSummarySection = (
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

export const createInstructionFilesSection = (
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

export const createPromptFilesSection = (
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

export const createSkillFilesSection = (
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
    audience: "internal",
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
    audience: "internal",
    lines: [
      `task: ${taskContext.task}`,
      `effective task: ${taskContext.effectiveTask}`,
      `workspace paths: ${taskContext.workspacePaths.length > 0 ? taskContext.workspacePaths.join(", ") : "none"}`,
      `suggested tools: ${taskContext.suggestedTools.length > 0 ? taskContext.suggestedTools.join(", ") : "none"}`,
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
    audience: "internal",
    lines: taskContext.applicableInstructions.flatMap((instruction) => [
      `${instruction.name} (${instruction.path})${instruction.priority > 0 ? ` [priority ${instruction.priority}]` : ""}`,
      `  reason: ${instruction.reason}`,
      `  body: ${instruction.body}`,
    ]),
  };
};

export const createContextSections = (
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

export const createWorkspaceInspectionSections = async (
  config: RuntimeConfig,
  customizations: CustomizationDiscoveryResult,
  contextSections: TaskExecutionSection[],
): Promise<TaskExecutionSection[]> => {
  const activeWebSearchConfigured =
    config.webSearch.activeProvider !== "none" &&
    config.webSearch.providerAvailability.some(
      (entry) =>
        entry.provider === config.webSearch.activeProvider && entry.configured,
    );

  return [
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
};
