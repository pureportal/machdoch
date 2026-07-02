export type TaskActionPromptKind = "retry-task" | "continue-task";

export const RETRY_TASK_DISPLAY_CONTENT = "Retry previous task.";
export const CONTINUE_TASK_DISPLAY_CONTENT = "Continue previous task.";

const GENERATED_PROMPT_PREFIXES: Record<TaskActionPromptKind, string[]> = {
  "retry-task": [
    "Retry this task from the failed or interrupted step.",
    "Retry this task after the app restarted before it finished.",
    "Retry the previous task from the failed or interrupted step.",
    "Retry the task that was interrupted before it finished.",
    "Retry the task that was interrupted by an app restart.",
    RETRY_TASK_DISPLAY_CONTENT,
  ],
  "continue-task": [
    "Continue from this previous task.",
    "Continue the previous task.",
    "Continue this task after the app restarted before it finished.",
    "Continue the task that was interrupted before it finished.",
    "Continue the task that was interrupted by an app restart.",
    CONTINUE_TASK_DISPLAY_CONTENT,
  ],
};

const SECTION_LABELS = new Set([
  "Context:",
  "Instructions:",
  "Objective:",
  "Original task:",
  "Plan summary:",
  "Previous reason:",
  "Previous status:",
  "Previous summary:",
  "Previous task:",
  "Reason:",
  "Status:",
  "Suggested follow-ups:",
  "Summary:",
]);

const TASK_OBJECTIVE_LABELS = ["Objective:", "Previous task:", "Original task:"];

export const compactPromptText = (value: string, maxLength: number): string => {
  const compacted = value.replace(/\s+/gu, " ").trim();

  if (compacted.length <= maxLength) {
    return compacted;
  }

  return `${compacted.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
};

export const getTaskActionPromptKind = (
  content: string,
): TaskActionPromptKind | null => {
  const normalizedContent = content.trim();

  if (!normalizedContent) {
    return null;
  }

  for (const [kind, prefixes] of Object.entries(GENERATED_PROMPT_PREFIXES)) {
    if (
      prefixes.some(
        (prefix) =>
          normalizedContent === prefix ||
          normalizedContent.startsWith(`${prefix}\n`),
      )
    ) {
      return kind as TaskActionPromptKind;
    }
  }

  return null;
};

export const getTaskActionDisplayContent = (
  content: string,
): string | null => {
  switch (getTaskActionPromptKind(content)) {
    case "retry-task":
      return RETRY_TASK_DISPLAY_CONTENT;
    case "continue-task":
      return CONTINUE_TASK_DISPLAY_CONTENT;
    default:
      return null;
  }
};

export const shouldOmitTaskActionPromptFromAiContext = (
  content: string,
): boolean => {
  return getTaskActionPromptKind(content) !== null;
};

const extractLastSectionValue = (
  content: string,
  labels: string[],
): string | null => {
  const lines = content.replace(/\r\n/gu, "\n").split("\n");
  let latestValue: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";

    const inlineLabel = labels.find((label) => line.startsWith(`${label} `));

    if (inlineLabel) {
      const inlineValue = line.slice(inlineLabel.length).trim();

      if (inlineValue) {
        latestValue = inlineValue;
      }

      continue;
    }

    if (!labels.includes(line)) {
      continue;
    }

    const valueLines: string[] = [];

    for (let valueIndex = index + 1; valueIndex < lines.length; valueIndex += 1) {
      const valueLine = lines[valueIndex] ?? "";

      if (SECTION_LABELS.has(valueLine.trim())) {
        break;
      }

      valueLines.push(valueLine);
    }

    const value = valueLines.join("\n").trim();

    if (value) {
      latestValue = value;
    }
  }

  return latestValue;
};

export const getConciseTaskObjective = (
  task: string,
  maxLength = 1_000,
): string => {
  const normalizedTask = task.trim();

  if (!normalizedTask) {
    return "";
  }

  if (getTaskActionPromptKind(normalizedTask)) {
    const extracted = extractLastSectionValue(
      normalizedTask,
      TASK_OBJECTIVE_LABELS,
    );

    if (extracted && extracted !== normalizedTask) {
      return getConciseTaskObjective(extracted, maxLength);
    }
  }

  return compactPromptText(normalizedTask, maxLength);
};
