import type { TaskExecutionResult, TaskRunPreview } from "../../core/types.js";
import { createTextPreviewLines } from "./_helpers/create-text-preview-lines.helper";

export type TaskPanelTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger";

export interface TaskPanelBadge {
  label: string;
  tone: TaskPanelTone;
}

export interface TaskPanelSection {
  id: string;
  title: string;
  lines: string[];
  tone?: TaskPanelTone;
}

export interface TaskPanelModel {
  kind: "preview" | "execution";
  title: string;
  summary: string;
  badges: TaskPanelBadge[];
  sections: TaskPanelSection[];
}

export type TaskPanelSource =
  | { kind: "preview"; preview: TaskRunPreview }
  | { kind: "execution"; execution: TaskExecutionResult };

const formatToolList = (tools: string[]): string => {
  return tools.length > 0 ? tools.join(", ") : "none";
};

const createModeTone = (mode: string): TaskPanelTone => {
  switch (mode) {
    case "machdoch":
      return "success";
    case "ask":
      return "info";
    default:
      return "info";
  }
};

const createStatusTone = (
  status: TaskExecutionResult["status"],
): TaskPanelTone => {
  switch (status) {
    case "planned":
      return "info";
    case "executed":
      return "success";
    case "blocked":
      return "danger";
    case "cancelled":
      return "neutral";
    default:
      return "neutral";
  }
};

const createPromptSection = (
  preview: TaskRunPreview,
): TaskPanelSection | undefined => {
  const prompt = preview.invokedPrompt;

  if (!prompt) {
    return undefined;
  }

  const lines = [
    `prompt: /${prompt.name}`,
    `arguments: ${prompt.arguments.length > 0 ? prompt.arguments : "none"}`,
    ...(prompt.model ? [`model: ${prompt.model}`] : []),
    ...(prompt.tools.length > 0 ? [`tools: ${prompt.tools.join(", ")}`] : []),
    ...(prompt.expectedInputs.length > 0
      ? [`inputs: ${prompt.expectedInputs.join(", ")}`]
      : []),
    ...createTextPreviewLines(prompt.resolvedBody).map(
      (line) => `body: ${line}`,
    ),
  ];

  return {
    id: "prompt",
    title: "Prompt",
    lines,
    tone: "info",
  };
};

const createToolPlanSection = (preview: TaskRunPreview): TaskPanelSection => {
  return {
    id: "tools",
    title: "Tool surface",
    lines: [
      `suggested: ${formatToolList(preview.suggestedTools)}`,
      preview.mode === "ask"
        ? "mode: ask exposes read-only function calls"
        : "mode: machdoch exposes all function calls",
    ],
    tone: "neutral",
  };
};

const createInstructionSection = (
  preview: TaskRunPreview,
): TaskPanelSection | undefined => {
  if (preview.applicableInstructions.length === 0) {
    return undefined;
  }

  return {
    id: "instructions",
    title: "Relevant instructions",
    lines: preview.applicableInstructions.flatMap((instruction) => {
      const prioritySuffix =
        instruction.priority !== 0 ? ` [priority ${instruction.priority}]` : "";

      return [
        `${instruction.name}${prioritySuffix} — ${instruction.reason}`,
        ...createTextPreviewLines(instruction.body, 2, 88).map(
          (line) => `  ${line}`,
        ),
      ];
    }),
  };
};

const createOptionalListSection = (
  id: string,
  title: string,
  lines: string[],
  tone?: TaskPanelTone,
): TaskPanelSection | undefined => {
  if (lines.length === 0) {
    return undefined;
  }

  return {
    id,
    title,
    lines,
    ...(tone ? { tone } : {}),
  };
};

const createPlanSection = (preview: TaskRunPreview): TaskPanelSection => {
  return {
    id: "plan",
    title: "Plan",
    lines: preview.steps.map(
      (step, index) => `${index + 1}. ${step.title} — ${step.description}`,
    ),
  };
};

const createPreviewBadges = (preview: TaskRunPreview): TaskPanelBadge[] => {
  const warningCount = preview.warnings.length;

  return [
    { label: "Preview", tone: "info" },
    { label: preview.mode, tone: createModeTone(preview.mode) },
    ...(warningCount > 0
      ? [
          {
            label: `${warningCount} warning${warningCount === 1 ? "" : "s"}`,
            tone: "warning" as const,
          },
        ]
      : []),
  ];
};

const createPreviewModel = (preview: TaskRunPreview): TaskPanelModel => {
  const sections = [
    createPromptSection(preview),
    createToolPlanSection(preview),
    createInstructionSection(preview),
    createOptionalListSection("warnings", "Warnings", preview.warnings, "warning"),
    createOptionalListSection("notes", "Notes", preview.notes, "info"),
    createPlanSection(preview),
  ].filter((section): section is TaskPanelSection => section !== undefined);

  return {
    kind: "preview",
    title: preview.task,
    summary: preview.summary,
    badges: createPreviewBadges(preview),
    sections,
  };
};

const createExecutionBadges = (
  execution: TaskExecutionResult,
): TaskPanelBadge[] => {
  return [
    {
      label: execution.status,
      tone: createStatusTone(execution.status),
    },
    { label: execution.mode, tone: createModeTone(execution.mode) },
    ...(execution.executedTools.length > 0
      ? execution.executedTools.map((tool) => ({
          label: tool,
          tone: "neutral" as const,
        }))
      : []),
  ];
};

const createExecutionModel = (
  execution: TaskExecutionResult,
): TaskPanelModel => {
  const detailTone =
    execution.executedTools.length > 0
      ? "success"
      : createStatusTone(execution.status);

  const sections = [
    {
      id: "execution-details",
      title: "Execution details",
      lines: [
        `executed tools: ${formatToolList(execution.executedTools)}`,
        ...(execution.reason ? [`reason: ${execution.reason}`] : []),
      ],
      tone: detailTone,
    },
    ...execution.outputSections.map((section, index) => ({
      id: `output-${index}`,
      title: section.title,
      lines: section.lines,
      ...(section.tone ? { tone: section.tone } : {}),
    })),
  ];

  return {
    kind: "execution",
    title: execution.task,
    summary: execution.summary,
    badges: createExecutionBadges(execution),
    sections,
  };
};

/**
 * Creates a desktop-friendly task panel model from either a preview or an
 * execution result.
 */
export const createTaskPanelModel = (
  source: TaskPanelSource,
): TaskPanelModel => {
  return source.kind === "preview"
    ? createPreviewModel(source.preview)
    : createExecutionModel(source.execution);
};
