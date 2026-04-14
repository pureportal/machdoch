import type {
  ResolvedToolPolicy,
  TaskExecutionResult,
  TaskRunPreview,
} from "../../core/types.js";

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

const PREVIEW_LINE_LIMIT = 3;
const SINGLE_LINE_PREVIEW_LIMIT = 96;

const createTextPreviewLines = (
  value: string,
  maxLines = PREVIEW_LINE_LIMIT,
  maxLineLength = SINGLE_LINE_PREVIEW_LIMIT,
): string[] => {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();

  if (normalized.length === 0) {
    return [];
  }

  const allLines = normalized.split("\n");
  const previewLines = allLines.slice(0, maxLines).map((line) => {
    if (line.length <= maxLineLength) {
      return line;
    }

    return `${line.slice(0, maxLineLength - 1)}…`;
  });

  if (allLines.length > maxLines) {
    previewLines.push("…");
  }

  return previewLines;
};

const formatToolList = (tools: string[]): string => {
  return tools.length > 0 ? tools.join(", ") : "none";
};

const createModeTone = (mode: string): TaskPanelTone => {
  switch (mode) {
    case "auto":
      return "success";
    case "safe":
      return "warning";
    default:
      return "info";
  }
};

const createStatusTone = (
  status: TaskExecutionResult["status"],
): TaskPanelTone => {
  switch (status) {
    case "executed":
      return "success";
    case "approval-required":
      return "warning";
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
  const approvalRequiredTools = preview.toolPolicies
    .filter((policy) => policy.decision === "ask")
    .map((policy) => policy.tool.name);
  const policySummaries = preview.toolPolicies.map(
    (policy: ResolvedToolPolicy) =>
      `${policy.tool.name}: ${policy.decision}`,
  );
  const tone = preview.toolPolicies.some((policy) => policy.decision === "blocked")
    ? "danger"
    : preview.toolPolicies.some((policy) => policy.decision === "ask")
      ? "warning"
      : "neutral";

  return {
    id: "tools",
    title: "Tool plan",
    lines: [
      `suggested: ${formatToolList(preview.suggestedTools)}`,
      `blocked: ${formatToolList(preview.blockedTools)}`,
      `approval required: ${formatToolList(approvalRequiredTools)}`,
      `policies: ${policySummaries.join(" · ")}`,
    ],
    tone,
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
    ...(preview.blockedTools.length > 0
      ? [
          {
            label: `${preview.blockedTools.length} blocked`,
            tone: "danger" as const,
          },
        ]
      : []),
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