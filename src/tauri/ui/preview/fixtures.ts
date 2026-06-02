import type {
  ResolvedPromptInvocation,
  RunMode,
  TaskCustomizationMatch,
  TaskExecutionResult,
  TaskExecutionStatus,
  TaskRunPreview,
  ToolName,
} from "../../../core/types.js";

const WORKSPACE_INSPECTION_ACTIONS = [
  "describe",
  "explain",
  "inspect",
  "scan",
  "show",
  "summarize",
  "summary",
];

const WORKSPACE_INSPECTION_TARGETS = [
  "config",
  "configuration",
  "project",
  "repo",
  "repository",
  "setup",
  "structure",
  "workspace",
];

const DEFAULT_WORKSPACE_ROOT = "C:/Development/machdoch";
const DEFAULT_PREVIEW_TASK = "debug the failing task runner tests";
const DEFAULT_EXECUTION_TASK = "scan this workspace and explain the setup";

interface FixtureModelContext {
  mode?: RunMode;
  provider?: string;
  model?: string;
}

const EXPLICIT_INSPECTION_TARGET_PATTERN =
  /\b(show|inspect|read|list)\b\s+(?:(['"`])(.+?)\2|\((.+?)\)|([^\s]+))/i;

const normalizeTask = (task: string, fallback: string): string => {
  const trimmed = task.trim();

  return trimmed.length > 0 ? trimmed : fallback;
};

const createTokenSet = (value: string): Set<string> => {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((part) => part.length > 0),
  );
};

const createWorkspaceLabel = (workspacePath: string): string => {
  const normalized = workspacePath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);

  return parts.at(-1) ?? workspacePath;
};

const extractInspectionTarget = (task: string): string | undefined => {
  const match = task.match(EXPLICIT_INSPECTION_TARGET_PATTERN);
  const rawTarget = match?.[3] ?? match?.[4] ?? match?.[5];
  const normalizedTarget = rawTarget?.trim();

  return normalizedTarget && normalizedTarget.length > 0
    ? normalizedTarget
    : undefined;
};

const inferSuggestedTools = (task: string): ToolName[] => {
  const tokens = createTokenSet(task);
  const suggestedTools: ToolName[] = ["filesystem"];

  if (
    ["build", "command", "debug", "fix", "install", "run", "test"].some(
      (token) => tokens.has(token),
    )
  ) {
    suggestedTools.push("shell");
  }

  if (
    ["api", "fetch", "network", "remote", "web", "website"].some((token) =>
      tokens.has(token),
    )
  ) {
    suggestedTools.push("network");
  }

  return Array.from(new Set(suggestedTools));
};

const supportsWorkspaceInspection = (task: string): boolean => {
  const tokens = createTokenSet(task);
  const hasAction = WORKSPACE_INSPECTION_ACTIONS.some((token) =>
    tokens.has(token),
  );
  const hasTarget = WORKSPACE_INSPECTION_TARGETS.some((token) =>
    tokens.has(token),
  );

  return hasAction && hasTarget;
};

export const supportsMockExecution = (task: string): boolean => {
  return (
    supportsWorkspaceInspection(task) ||
    extractInspectionTarget(task) !== undefined
  );
};

const createInvokedPrompt = (
  task: string,
): ResolvedPromptInvocation | undefined => {
  const trimmedTask = task.trim();

  if (!trimmedTask.startsWith("/")) {
    return undefined;
  }

  const commandText = trimmedTask.slice(1).trim();
  const [name = "task", ...rest] = commandText.split(/\s+/);
  const argumentsText = rest.join(" ").trim();
  const hasArguments = argumentsText.length > 0;

  return {
    path: `.machdoch/prompts/${name}.prompt.md`,
    name,
    description: "Desktop scaffold prompt preview.",
    agent: "🟨 JavaScript & TypeScript Expert",
    model: "gpt-5.4",
    argumentHint: "Provide the prompt arguments inline.",
    inputs: ["task"],
    tools: ["filesystem", "shell"],
    body: "Resolve the prompt input and stage the smallest observable next action.",
    arguments: argumentsText,
    expectedInputs: ["task"],
    inputValues: hasArguments ? { task: argumentsText } : {},
    missingInputs: hasArguments ? [] : ["task"],
    resolvedBody: hasArguments
      ? argumentsText
      : "Provide the required task input before execution.",
  };
};

const createApplicableInstructions = (
  task: string,
): TaskCustomizationMatch[] => {
  const tokens = createTokenSet(task);
  const instructions: TaskCustomizationMatch[] = [
    {
      kind: "always-on",
      name: "Workspace defaults",
      path: ".machdoch/instructions.md",
      priority: 20,
      body: "Keep changes small, verify the result, and surface mode boundaries clearly.",
      reason: "Always-on workspace instruction.",
    },
  ];

  if (
    ["build", "debug", "test", "typescript"].some((token) => tokens.has(token))
  ) {
    instructions.push({
      kind: "conditional",
      name: "TypeScript testing rules",
      path: ".machdoch/instructions/testing.instructions.md",
      priority: 70,
      body: "Prefer behavior-focused tests and verify only the smallest relevant scope.",
      reason: "Matched task terms: build, debug, test, or typescript.",
    });
  }

  if (
    ["auth", "permission", "security", "token"].some((token) =>
      tokens.has(token),
    )
  ) {
    instructions.push({
      kind: "conditional",
      name: "Security guardrails",
      path: ".machdoch/instructions/security.instructions.md",
      priority: 80,
      body: "Keep privileged actions in Machdoch mode and avoid leaking secrets into logs.",
      reason: "Matched task terms: auth, permission, security, or token.",
    });
  }

  return instructions;
};

const createPreviewWarnings = (
  invokedPrompt?: ResolvedPromptInvocation,
): string[] => {
  const warnings: string[] = [];

  if (invokedPrompt?.missingInputs.length) {
    warnings.push(
      `The prompt \`/${invokedPrompt.name}\` still expects input(s): ${invokedPrompt.missingInputs.join(", ")}.`,
    );
  }

  return warnings;
};

const createPreviewNotes = (
  instructions: TaskCustomizationMatch[],
  context?: FixtureModelContext,
  invokedPrompt?: ResolvedPromptInvocation,
): string[] => {
  return [
    ...(context?.provider || context?.model
      ? [
          `Selected runtime: ${(context?.provider ?? "provider").toUpperCase()} · ${context?.model ?? "auto"}.`,
        ]
      : []),
    ...(invokedPrompt?.model
      ? [`The prompt prefers model \`${invokedPrompt.model}\`.`]
      : []),
    `${instructions.length} instruction(s) appear relevant to this task.`,
    "The desktop shell currently renders representative task states while the live executor is still being wired in.",
  ];
};

export const createPreviewFixture = (
  task = DEFAULT_PREVIEW_TASK,
  context: FixtureModelContext = {},
): TaskRunPreview => {
  const normalizedTask = normalizeTask(task, DEFAULT_PREVIEW_TASK);
  const suggestedTools = inferSuggestedTools(normalizedTask);
  const invokedPrompt = createInvokedPrompt(normalizedTask);
  const applicableInstructions = createApplicableInstructions(normalizedTask);

  return {
    task: normalizedTask,
    mode: context.mode ?? "machdoch",
    summary: invokedPrompt
      ? "This staged preview resolved a direct prompt invocation, mapped it to suggested tools, and highlighted any missing input before execution."
      : "This staged preview maps the request to likely tools, mode constraints, and next steps before a live run begins.",
    suggestedTools,
    ...(invokedPrompt ? { invokedPrompt } : {}),
    applicableInstructions,
    suggestedPrompts: [],
    suggestedSkills: [],
    warnings: createPreviewWarnings(invokedPrompt),
    notes: createPreviewNotes(applicableInstructions, context, invokedPrompt),
    steps: [
      {
        title: "Load workspace context",
        description:
          "Read the active workspace folder, customization hints, and effective run mode before doing anything risky.",
      },
      {
        title: invokedPrompt ? "Resolve the prompt" : "Clarify the target",
        description: invokedPrompt
          ? `Resolve \`/${invokedPrompt.name}\` and confirm whether more input is required before execution.`
          : `Interpret the goal \`${normalizedTask}\` and keep the first action as small and observable as possible.`,
      },
      {
        title: "Check mode constraints",
        description:
          "Use read-only function calls in Ask mode or the full function-call surface in Machdoch mode.",
      },
      {
        title: "Verify the result",
        description:
          "Surface what ran, what changed, and anything still blocked so the user can decide the next step quickly.",
      },
    ],
    customizationCounts: {
      instructions: applicableInstructions.length,
      prompts: 1,
      skills: 1,
    },
  };
};

const createUnsupportedExecutionSections = (
  task: string,
  workspacePath: string,
  context: FixtureModelContext,
): TaskExecutionResult["outputSections"] => {
  return [
    {
      title: "Task context",
      lines: [
        `task: ${task}`,
        `workspace: ${workspacePath}`,
        `suggested tools: ${inferSuggestedTools(task).join(", ")}`,
        ...(context.provider ? [`provider: ${context.provider}`] : []),
        ...(context.model ? [`model: ${context.model}`] : []),
      ],
    },
    {
      title: "Execution status",
      lines: [
        "result: preview only",
        "current executor coverage: read-only workspace summaries, file previews, and directory listings.",
        "next step: keep the task in preview mode until the desktop shell is wired to the shared core executor.",
      ],
    },
  ];
};

const createExecutedExecutionSections = (
  task: string,
  workspacePath: string,
  context: FixtureModelContext,
): TaskExecutionResult["outputSections"] => {
  const workspaceLabel = createWorkspaceLabel(workspacePath);
  const explicitTarget = extractInspectionTarget(task);

  if (explicitTarget) {
    return [
      {
        title: "Task context",
        lines: [
          `task: ${task}`,
          `effective task: ${task}`,
          "suggested tools: filesystem",
        ],
      },
      {
        title: "Execution mapping",
        lines: [
          `workspace: ${workspacePath}`,
          `requested target: ${explicitTarget}`,
          ...(context.provider ? [`provider: ${context.provider}`] : []),
          ...(context.model ? [`model: ${context.model}`] : []),
          `matched executor: ${task.toLowerCase().includes("list") ? "read-only directory listing" : "read-only file preview"}`,
        ],
      },
      {
        title: "Representative output",
        lines: task.toLowerCase().includes("list")
          ? ["dir: core", "file: main.ts", "file: README.md"]
          : [
              "1: # machdoch",
              "2: Representative content rendered for the current desktop shell scaffold.",
              "3: Live filesystem output will come from the shared core executor.",
            ],
      },
    ];
  }

  return [
    {
      title: "Task context",
      lines: [
        `task: ${task}`,
        `effective task: ${task}`,
        "suggested tools: filesystem, shell",
      ],
    },
    {
      title: "Workspace context",
      lines: [
        `root: ${workspacePath}`,
        `workspace label: ${workspaceLabel}`,
        `mode: ${context.mode ?? "machdoch"}`,
        "execution surface: deterministic read-only scaffold",
        ...(context.provider ? [`provider: ${context.provider}`] : []),
        ...(context.model ? [`model: ${context.model}`] : []),
      ],
    },
    {
      title: "Project signals",
      lines: [
        "desktop renderer: task panel ready",
        "session rail: active",
        "shared core handoff: pending live wiring",
      ],
    },
  ];
};

const createExecutedExecutionResponse = (
  workspacePath: string,
): NonNullable<TaskExecutionResult["response"]> => {
  const workspaceLabel = createWorkspaceLabel(workspacePath);

  return {
    markdown: [
      "**Workspace scan complete.**",
      "",
      `- Active workspace: \`${workspaceLabel}\``,
      "- Captured the key runtime signals in the compact execution summary",
    ].join("\n"),
    highlights: [
      "Resolved the workspace label and deterministic execution surface.",
      "Kept the execution feedback compact and easy to scan.",
    ],
    relatedFiles: [
      {
        path: "src/tauri/ui/chat-session-shell.tsx",
        description:
          "Desktop chat shell message rendering and compact feedback layout.",
      },
    ],
    verification: [
      "Confirmed the mock workspace label and runtime markers in the execution output.",
    ],
    followUps: [],
  };
};

const createUnsupportedExecutionResponse = (): NonNullable<
  TaskExecutionResult["response"]
> => {
  return {
    markdown: [
      "**Preview only.**",
      "",
      "- This request goes beyond the current deterministic mock executor",
      "- The shell kept the response explicit instead of pretending the task already ran",
    ].join("\n"),
    highlights: [
      "The shell kept the result explicit instead of pretending the task already ran.",
    ],
    relatedFiles: [],
    verification: [],
    followUps: [
      "Run the task against the live shared executor for a real workspace result.",
    ],
  };
};

export const createMockExecutionFixture = (
  task = DEFAULT_EXECUTION_TASK,
  workspacePath = DEFAULT_WORKSPACE_ROOT,
  context: FixtureModelContext = {},
): TaskExecutionResult => {
  const normalizedTask = normalizeTask(task, DEFAULT_EXECUTION_TASK);
  const status: TaskExecutionStatus =
    supportsMockExecution(normalizedTask) ? "executed" : "unsupported";

  return {
    task: normalizedTask,
    mode: context.mode ?? "machdoch",
    status,
    summary:
      status === "executed"
        ? "This request matches a read-only execution path that already exists in the shared core, so the desktop shell can render a representative result shape."
        : "This task stays in preview mode because the deterministic executor only covers read-only workspace and explicit file or directory inspection flows today.",
    executedTools: status === "executed" ? ["filesystem"] : [],
    reason:
      status === "executed"
        ? "Representative data only until the desktop shell is connected to the shared core executor."
        : "Broader task types still fall back to preview mode in the current desktop scaffold.",
    response:
      status === "executed"
        ? createExecutedExecutionResponse(workspacePath)
        : createUnsupportedExecutionResponse(),
    outputSections:
      status === "executed"
        ? createExecutedExecutionSections(
            normalizedTask,
            workspacePath,
            context,
          )
        : createUnsupportedExecutionSections(
            normalizedTask,
            workspacePath,
            context,
          ),
  };
};

export const previewFixture: TaskRunPreview = createPreviewFixture();

export const executionFixture: TaskExecutionResult =
  createMockExecutionFixture();
