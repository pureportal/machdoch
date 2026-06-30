import type {
  TaskExecutionProgress,
  TaskExecutionResult,
} from "../../../../core/types.js";
import type {
  ChatSessionMessage,
  ChatSessionRecord,
} from "../../chat-session.model";
import { getExecutionMessageContent } from "./execution-message.tsx";
import {
  compactPromptText,
  getConciseTaskObjective,
} from "./task-action-prompts";

const RECOVERED_TASK_CRASH_PREFIX = "**Task crashed.**";

const TERMINAL_PROGRESS_STATUS_BY_STATE: Partial<
  Record<TaskExecutionProgress["state"], TaskExecutionResult["status"]>
> = {
  planned: "planned",
  completed: "executed",
  blocked: "blocked",
  cancelled: "cancelled",
  unsupported: "unsupported",
};

export const formatTaskExecutionError = (error: unknown): string => {
  const detail = error instanceof Error ? error.message : String(error);

  return `**Desktop handoff failed.** ${detail}`;
};

export const createExecutionMessageContent = (
  execution: TaskExecutionResult,
): string => {
  return getExecutionMessageContent(execution);
};

export const createExecutionFromTerminalProgress = (
  progress: TaskExecutionProgress,
  latestAssistantText = "",
): TaskExecutionResult | null => {
  if (progress.cancellable) {
    return null;
  }

  const status = TERMINAL_PROGRESS_STATUS_BY_STATE[progress.state];

  if (!status) {
    return null;
  }

  const responseMarkdown =
    latestAssistantText.trim() || progress.assistantText?.trim() || "";

  return {
    task: progress.task,
    mode: progress.mode,
    status,
    summary: progress.message.trim() || "The task finished.",
    executedTools: progress.executedTools,
    outputSections: progress.outputSections,
    ...(progress.reason ? { reason: progress.reason } : {}),
    ...(responseMarkdown
      ? {
          response: {
            markdown: responseMarkdown,
            highlights: [],
            relatedFiles: [],
            verification: [],
            followUps: [],
          },
        }
      : {}),
  };
};

export const isRecoveredTaskCrashMessage = (
  message: ChatSessionMessage,
): boolean => {
  return (
    message.role === "agent" &&
    !message.source &&
    message.content.startsWith(RECOVERED_TASK_CRASH_PREFIX)
  );
};

export const getRecoveredTaskUserPrompt = (
  session: ChatSessionRecord,
  message: ChatSessionMessage,
): string | null => {
  let latestMatchingUserMessage: ChatSessionMessage | null = null;

  for (const entry of session.messages) {
    if (entry.id === message.id) {
      break;
    }

    if (entry.role !== "user") {
      continue;
    }

    if (!message.taskId || entry.taskId === message.taskId) {
      latestMatchingUserMessage = entry;
    }
  }

  const prompt = latestMatchingUserMessage?.content.trim();

  return prompt ? prompt : null;
};

export const createRecoveredRetryTaskPrompt = (
  recoveredTask: string,
): string => {
  const objective = getConciseTaskObjective(recoveredTask);

  return [
    "Retry the task that was interrupted by an app restart.",
    "",
    "Context:",
    `Objective: ${objective}`,
    "",
    "Instructions:",
    "- Use prior conversation only as background.",
    "- Restart from the smallest useful recovery point.",
    "- Verify the result.",
  ].join("\n");
};

export const createRecoveredContinueTaskPrompt = (
  recoveredTask: string,
): string => {
  const objective = getConciseTaskObjective(recoveredTask);

  return [
    "Continue the task that was interrupted by an app restart.",
    "",
    "Context:",
    `Objective: ${objective}`,
    "",
    "Instructions:",
    "- Use prior conversation only as background.",
    "- Continue from the last useful point.",
    "- Verify the result.",
  ].join("\n");
};

export const createRetryTaskPrompt = (
  execution: TaskExecutionResult,
): string => {
  const objective = getConciseTaskObjective(execution.task);
  const summary = compactPromptText(execution.summary, 700);
  const reason = execution.reason
    ? compactPromptText(execution.reason, 500)
    : "";

  return [
    "Retry the previous task from the failed or interrupted step.",
    "",
    "Context:",
    `Objective: ${objective}`,
    `Status: ${execution.status}`,
    ...(summary ? [`Summary: ${summary}`] : []),
    ...(reason ? [`Reason: ${reason}`] : []),
    "",
    "Instructions:",
    "- Reuse only the relevant prior context.",
    "- Do not repeat completed work unless it is required to recover.",
    "- Take the smallest useful next step and verify it.",
  ].join("\n");
};

export const createContinuationTaskPrompt = (
  execution: TaskExecutionResult,
): string => {
  const objective = getConciseTaskObjective(execution.task);
  const summary = compactPromptText(execution.summary, 700);
  const followUps = (execution.response?.followUps ?? [])
    .map((item) => compactPromptText(item, 220))
    .filter(Boolean)
    .slice(0, 4);

  return [
    "Continue the previous task.",
    "",
    "Context:",
    `Objective: ${objective}`,
    `Status: ${execution.status}`,
    ...(summary ? [`Summary: ${summary}`] : []),
    ...(followUps.length > 0
      ? ["Suggested follow-ups:", ...followUps.map((item) => `- ${item}`)]
      : []),
    "",
    "Instructions:",
    "- Use prior conversation only as background.",
    "- Do not repeat completed work.",
    "- Take the next useful step and verify the result.",
  ].join("\n");
};
