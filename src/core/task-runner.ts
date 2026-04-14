import { parsePromptInvocation } from "./prompt-resolution.js";
import {
  rankTaskMatchText,
  resolveTaskContext,
  tokenizeTaskMatchText,
} from "./task-context.js";
import type {
  CustomizationDiscoveryResult,
  DiscoveredPrompt,
  RuntimeConfig,
  TaskPlanStep,
  TaskRunPreview,
  TaskSuggestion,
  ResolvedPromptInvocation,
  ToolName,
} from "./types.js";

/**
 * Formats a short explanation for the terms that matched a suggestion.
 */
const createMatchReason = (matchedTerms: string[]): string => {
  return `Matched terms: ${matchedTerms.join(", ")}`;
};

/**
 * Builds searchable text from prompt metadata for suggestion ranking.
 */
const createPromptCandidateText = (prompt: DiscoveredPrompt): string => {
  return [
    prompt.name,
    prompt.description,
    prompt.agent,
    prompt.model,
    prompt.argumentHint,
    prompt.inputs.join(" "),
  ]
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    )
    .join(" ");
};

/**
 * Ranks prompt suggestions using simple token-overlap scoring.
 */
const rankPromptSuggestions = (
  task: string,
  customizations: CustomizationDiscoveryResult,
): TaskSuggestion[] => {
  const taskTokens = tokenizeTaskMatchText(task);

  return customizations.prompts
    .flatMap((prompt) => {
      const candidateText = createPromptCandidateText(prompt);
      const { score, matchedTerms } = rankTaskMatchText(
        taskTokens,
        candidateText,
      );

      if (score === 0) {
        return [];
      }

      return [
        {
          name: prompt.name,
          path: prompt.path,
          score,
          reason: createMatchReason(matchedTerms),
        },
      ];
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);
};

/**
 * Ranks skill suggestions using simple token-overlap scoring.
 */
const rankSkillSuggestions = (
  task: string,
  customizations: CustomizationDiscoveryResult,
): TaskSuggestion[] => {
  const taskTokens = tokenizeTaskMatchText(task);

  return customizations.skills
    .flatMap((skill) => {
      const candidateText = [skill.name, skill.description, skill.argumentHint]
        .filter(
          (part): part is string => typeof part === "string" && part.length > 0,
        )
        .join(" ");
      const { score, matchedTerms } = rankTaskMatchText(
        taskTokens,
        candidateText,
      );

      if (score === 0) {
        return [];
      }

      return [
        {
          name: skill.name,
          path: skill.path,
          score,
          reason: createMatchReason(matchedTerms),
        },
      ];
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);
};

/**
 * Builds the staged plan shown in preview mode for a task run.
 */
const createPlanSteps = (
  task: string,
  config: RuntimeConfig,
  blockedTools: ToolName[],
  invokedPrompt?: ResolvedPromptInvocation,
): TaskPlanStep[] => {
  const approvalStepDescription =
    config.mode === "safe"
      ? "Do not execute actions automatically. Pause for explicit confirmation before any state-changing step."
      : config.mode === "ask"
        ? "Request approval before risky actions, especially shell execution, writes, package installs, and elevated access."
        : "Proceed automatically only within the configured tool and policy boundaries.";

  return [
    {
      title: "Load workspace context",
      description:
        "Read `.machdoch` configuration, discover custom instructions/prompts/skills, and establish the active runtime mode.",
    },
    invokedPrompt
      ? {
          title: "Resolve prompt template",
          description:
            invokedPrompt.arguments.length > 0
              ? `Resolve the \`/${invokedPrompt.name}\` prompt with the provided arguments: ${invokedPrompt.arguments}`
              : `Resolve the \`/${invokedPrompt.name}\` prompt and determine whether it needs additional input before execution.`,
        }
      : {
          title: "Clarify the task target",
          description: `Interpret the user goal: ${task}`,
        },
    {
      title: "Check tools and approvals",
      description:
        blockedTools.length > 0
          ? `${approvalStepDescription} The current task likely needs additional tools: ${blockedTools.join(", ")}.`
          : approvalStepDescription,
    },
    {
      title: "Execute and keep iterating",
      description:
        "Run the smallest useful step first, inspect the result, update the plan, and continue until the task is complete or an approval/blocker prevents the next step.",
    },
    {
      title: "Verify before stopping",
      description:
        "Confirm the requested outcome with tests, commands, diffs, or observable output before declaring success. If the task cannot be completed, summarize the exact blocker and next required action.",
    },
  ];
};

/**
 * Builds a staged task preview by combining prompt resolution, tool policy
 * decisions, and discovered workspace customizations.
 */
export const previewTaskRun = (
  task: string,
  config: RuntimeConfig,
  customizations: CustomizationDiscoveryResult,
): TaskRunPreview => {
  const parsedPromptInvocation = parsePromptInvocation(task);
  const taskContext = resolveTaskContext(task, config, customizations);
  const suggestedPrompts = taskContext.invokedPrompt
    ? []
    : rankPromptSuggestions(taskContext.taskContextText, customizations);
  const suggestedSkills = rankSkillSuggestions(
    taskContext.taskContextText,
    customizations,
  );
  const warnings: string[] = [];
  const notes: string[] = [];
  const selectedProvider = config.providerAvailability.find(
    (entry) => entry.provider === config.provider,
  );

  if (config.provider === "unconfigured") {
    warnings.push(
      "No model provider is configured yet. The CLI can still preview plans, but real model-driven execution is not wired up yet.",
    );
  } else if (!selectedProvider?.configured && !config.offline) {
    warnings.push(
      `The selected provider \`${config.provider}\` does not look configured yet. Save an API key in the Machdoch user config before wiring in live model calls.`,
    );
  }

  if (taskContext.blockedTools.length > 0) {
    warnings.push(
      `The current task likely needs tools that are not enabled in .machdoch/config.json: ${taskContext.blockedTools.join(", ")}.`,
    );
  }

  if (parsedPromptInvocation && !taskContext.invokedPrompt) {
    warnings.push(
      `The task looks like a prompt invocation, but no prompt named \`${parsedPromptInvocation.name}\` was discovered.`,
    );
  }

  if (taskContext.invokedPrompt && taskContext.invokedPrompt.missingInputs.length > 0) {
    warnings.push(
      `The prompt \`/${taskContext.invokedPrompt.name}\` still expects input(s) ${taskContext.invokedPrompt.missingInputs.join(", ")}. Provide them as \`name=value\` arguments, or use a single freeform argument when only one input remains unresolved.`,
    );
  }

  if (taskContext.approvalRequiredTools.length > 0) {
    notes.push(
      `These relevant tools would require approval in ${config.mode} mode: ${taskContext.approvalRequiredTools.join(", ")}.`,
    );
  }

  if (customizations.instructions.length === 0) {
    notes.push("No instruction files were discovered.");
  }

  if (taskContext.invokedPrompt) {
    notes.push(
      `Resolved the \`/${taskContext.invokedPrompt.name}\` prompt from ${taskContext.invokedPrompt.path}.`,
    );

    if (taskContext.invokedPrompt.model) {
      notes.push(
        `The prompt prefers model \`${taskContext.invokedPrompt.model}\`.`,
      );
    }
  }

  if (taskContext.applicableInstructions.length > 0) {
    notes.push(
      `${taskContext.applicableInstructions.length} instruction(s) appear relevant to this task.`,
    );
  }

  if (customizations.prompts.length > 0) {
    notes.push(
      `${customizations.prompts.length} prompt file(s) are available for task-specific workflows.`,
    );
  }

  if (customizations.skills.length > 0) {
    notes.push(
      `${customizations.skills.length} skill folder(s) are available for specialized capabilities.`,
    );
  }

  return {
    task,
    mode: config.mode,
    summary: taskContext.invokedPrompt
      ? "This preview resolved a direct prompt invocation, merged its declared tools with the task context, and staged a run that should continue until the task is complete, blocked, or waiting on approval."
      : "This preview now combines config, tool policy decisions, and customization discovery to show how the agent should stage and continue the next task until it is complete, blocked, or waiting on approval.",
    suggestedTools: taskContext.suggestedTools,
    blockedTools: taskContext.blockedTools,
    toolPolicies: taskContext.toolPolicies,
    ...(taskContext.invokedPrompt ? { invokedPrompt: taskContext.invokedPrompt } : {}),
    applicableInstructions: taskContext.applicableInstructions,
    suggestedPrompts,
    suggestedSkills,
    warnings,
    notes,
    steps: createPlanSteps(
      task,
      config,
      taskContext.blockedTools,
      taskContext.invokedPrompt,
    ),
    customizationCounts: {
      instructions: customizations.instructions.length,
      prompts: customizations.prompts.length,
      skills: customizations.skills.length,
    },
  };
};
