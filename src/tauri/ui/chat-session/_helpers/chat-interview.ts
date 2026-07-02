import type {
  ReasoningMode,
  RunMode,
} from "../../../../core/runtime-contract.generated.js";
import type {
  RalphInputField,
  RalphInputValue,
} from "../../../../core/ralph.js";
import type { TaskInterviewSession } from "../../../../core/task-interview.js";
import type { RuntimeProvider } from "../../model-catalog";
import type {
  ChatSessionContextAttachment,
  ChatSessionRecord,
} from "../../chat-session.model";
import { createAiContextHistory } from "./ai-context-window";

const MAX_TASK_INTERVIEW_CONTEXT_NOTE_LENGTH = 1_500;

export interface ChatInterviewStartContext {
  sessionSnapshot: ChatSessionRecord;
  task: string;
  contextAttachments: ChatSessionContextAttachment[];
  mode: RunMode;
  provider: RuntimeProvider;
  model: string;
  reasoning?: ReasoningMode;
}

export type ChatInterviewDialogStatus =
  | "loading"
  | "ready"
  | "starting"
  | "blocked";

export interface ChatInterviewDialogState {
  context: ChatInterviewStartContext;
  status: ChatInterviewDialogStatus;
  session?: TaskInterviewSession;
  fields: RalphInputField[];
  values: Record<string, RalphInputValue>;
  answerComments: Record<string, string>;
  expandedCommentFieldIds: string[];
  skippedFieldIds: string[];
  validationErrors: Record<string, string>;
  summary: string;
  findings: string[];
  assumptions: string[];
  relevantFiles: string[];
  finalPrompt?: string;
  provider?: string | null;
  model?: string | null;
  error?: string;
  taskId?: string;
}

export const getTrimmedTaskInterviewAnswerComments = (
  answerComments: Record<string, string>,
): Record<string, string> => {
  return Object.fromEntries(
    Object.entries(answerComments).flatMap(([fieldId, comment]) => {
      const trimmedComment = comment.trim();

      return trimmedComment ? [[fieldId, trimmedComment]] : [];
    }),
  );
};

const normalizeTaskInterviewContextNote = (value: string): string => {
  return value.replace(/\s+/gu, " ").trim();
};

const truncateTaskInterviewContextNote = (value: string): string => {
  const normalized = normalizeTaskInterviewContextNote(value);

  if (normalized.length <= MAX_TASK_INTERVIEW_CONTEXT_NOTE_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_TASK_INTERVIEW_CONTEXT_NOTE_LENGTH - 3).trimEnd()}...`;
};

const createTaskInterviewHistoryNotes = (
  session: ChatSessionRecord,
  maxHistoryMessages?: number,
): string[] => {
  return createAiContextHistory(session.messages, maxHistoryMessages).map(
    (entry) => {
      const role = entry.role === "assistant" ? "assistant" : "user";

      return `Recent chat ${role} message: ${truncateTaskInterviewContextNote(entry.content)}`;
    },
  );
};

const getTaskInterviewAttachmentKindLabel = (
  attachment: ChatSessionContextAttachment,
): string => {
  switch (attachment.kind) {
    case "directory":
      return "folder";
    case "file":
      return "file";
    case "image":
      return "image";
    case "other":
    default:
      return "path";
  }
};

export const createTaskInterviewContextNotes = (
  context: Pick<
    ChatInterviewStartContext,
    "contextAttachments" | "sessionSnapshot"
  >,
  maxHistoryMessages?: number,
): string[] => {
  const attachmentNotes = context.contextAttachments.flatMap((attachment) => {
    const path = attachment.path.trim();

    if (!path) {
      return [];
    }

    const kind = getTaskInterviewAttachmentKindLabel(attachment);
    const name = attachment.name.trim();
    const displayName = name && name !== path ? ` (${name})` : "";

    return [`Attached ${kind}${displayName}: ${path}`];
  });

  return [
    ...createTaskInterviewHistoryNotes(
      context.sessionSnapshot,
      maxHistoryMessages,
    ),
    ...attachmentNotes,
  ];
};

const formatTaskInterviewValueForPrompt = (
  value: RalphInputValue | undefined,
): string => {
  if (value === undefined || value === null) {
    return "Skipped";
  }

  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : "Skipped";
  }

  return String(value);
};

const formatTaskInterviewAnswerForPrompt = (
  label: string,
  value: RalphInputValue | undefined,
  comment?: string,
): string[] => {
  const lines = [`- ${label}: ${formatTaskInterviewValueForPrompt(value)}`];
  const trimmedComment = comment?.trim();

  if (trimmedComment) {
    lines.push(`  Comment: ${trimmedComment}`);
  }

  return lines;
};

export const createLocalTaskInterviewPrompt = (
  context: ChatInterviewStartContext,
  session: TaskInterviewSession | undefined,
  fields: readonly RalphInputField[],
  values: Record<string, RalphInputValue>,
  answerComments: Record<string, string> = {},
): string => [
  context.task,
  "",
  "Interview context for this task:",
  session?.contextSummary ?? context.task,
  "",
  "Findings:",
  ...((session?.findings.length ?? 0) > 0
    ? (session?.findings ?? []).map((entry) => `- ${entry}`)
    : ["- None"]),
  "",
  "Assumptions:",
  ...((session?.assumptions.length ?? 0) > 0
    ? (session?.assumptions ?? []).map((entry) => `- ${entry}`)
    : ["- None"]),
  "",
  "Relevant files/config:",
  ...((session?.relevantFiles.length ?? 0) > 0
    ? (session?.relevantFiles ?? []).map((entry) => `- ${entry}`)
    : ["- None"]),
  "",
  "Interview answers:",
  ...(session?.transcript ?? []).flatMap((turn) => [
    turn.questionScope ? `${turn.questionScope}:` : `Turn ${turn.turn}:`,
    ...turn.answers.flatMap((answer) =>
      formatTaskInterviewAnswerForPrompt(
        answer.label,
        answer.value,
        answer.comment,
      ),
    ),
  ]),
  ...(fields.length > 0
    ? [
        "Current answers:",
        ...fields.flatMap((field) =>
          formatTaskInterviewAnswerForPrompt(
            field.label,
            values[field.id],
            answerComments[field.id],
          ),
        ),
      ]
    : []),
  "",
  "Use this interview context when executing the task.",
].join("\n");
