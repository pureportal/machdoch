import type {
  ChatSessionTaskAction,
  ChatSessionTaskActionKind,
} from "../../chat-session.model";

export const RETRY_TASK_DISPLAY_CONTENT = "Retry previous task.";
export const CONTINUE_TASK_DISPLAY_CONTENT = "Continue previous task.";

export const compactPromptText = (value: string, maxLength: number): string => {
  const compacted = value.replace(/\s+/gu, " ").trim();

  if (compacted.length <= maxLength) {
    return compacted;
  }

  return `${compacted.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
};

export const getTaskActionDisplayContent = (
  taskAction: ChatSessionTaskAction | undefined,
): string | null => {
  switch (taskAction?.kind) {
    case "retry-task":
      return RETRY_TASK_DISPLAY_CONTENT;
    case "continue-task":
      return CONTINUE_TASK_DISPLAY_CONTENT;
    default:
      return null;
  }
};

export const getConciseTaskObjective = (
  task: string,
  maxLength = 1_000,
): string => {
  return compactPromptText(task, maxLength);
};

export const createTaskAction = (
  kind: ChatSessionTaskActionKind,
  objective: string,
): ChatSessionTaskAction | null => {
  const normalizedObjective = getConciseTaskObjective(objective);

  return normalizedObjective ? { kind, objective: normalizedObjective } : null;
};
