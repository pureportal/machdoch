import type { TaskExecutionResult } from "../../../../core/types.js";
import type { ChatSessionMessage } from "../../chat-session.model";
import type { TaskThinkingTrace } from "../../task-thinking.model";
import { stripContextAttachmentsTaskBlock } from "./session-context-attachments";
import { getTaskActionDisplayContent } from "./task-action-prompts";

export const createFallbackExecutionMarkdown = (
  execution: TaskExecutionResult,
): string => {
  const summary =
    execution.summary.trim() ||
    "The task completed without a detailed summary.";

  switch (execution.status) {
    case "planned":
      return `**Plan ready.** ${summary}`;
    case "executed":
      return `**Done.** ${summary}`;
    case "blocked":
      return `**Blocked.** ${summary}`;
    case "cancelled":
      return `**Cancelled.** ${summary}`;
    case "unsupported":
    default:
      return `**Preview only.** ${summary}`;
  }
};

const stripPreviewLineNumber = (line: string): string => {
  return line.replace(/^\d+:\s?/, "");
};

const getAssistantAnswerSectionMarkdown = (
  execution: TaskExecutionResult,
): string | null => {
  const answerSection = execution.outputSections.find(
    (section) =>
      section.audience !== "internal" &&
      section.title === "Agent answer" &&
      section.lines.some((line) => line.trim().length > 0),
  );

  if (!answerSection) {
    return null;
  }

  const markdown = answerSection.lines
    .map(stripPreviewLineNumber)
    .join("\n")
    .trim();

  return markdown.length > 0 && markdown !== "(empty)" ? markdown : null;
};

export const getExecutionMessageContent = (
  execution: TaskExecutionResult,
): string => {
  const structuredMarkdown = execution.response?.markdown?.trim();

  return (
    structuredMarkdown ||
    getAssistantAnswerSectionMarkdown(execution) ||
    createFallbackExecutionMarkdown(execution)
  );
};

export const getRelatedFileButtonLabel = (path: string): string => {
  return path.length <= 42 ? path : `…${path.slice(path.length - 39)}`;
};

export const getRenderedMessageContent = (
  message: ChatSessionMessage,
): string => {
  if (message.role === "agent" && message.source?.kind === "thinking") {
    return "";
  }

  if (message.role === "agent" && message.source?.kind === "execution") {
    return (
      message.content.trim() ||
      getExecutionMessageContent(message.source.execution)
    );
  }

  if (message.role === "user") {
    return (
      getTaskActionDisplayContent(message.taskAction) ??
      stripContextAttachmentsTaskBlock(message.content)
    );
  }

  return message.content;
};

export const getExecutionMessageRenderKey = (
  message: ChatSessionMessage,
): string => {
  if (
    message.role === "agent" &&
    message.taskId &&
    (message.source?.kind === "thinking" ||
      message.source?.kind === "execution")
  ) {
    return `task-execution:${message.taskId}`;
  }

  return message.id;
};

export const normalizeMarkdownForSpeech = (content: string): string => {
  const normalized = content
    .replace(/```[\s\S]*?```/g, " Code sample omitted. ")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\|/g, " ")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length > 0) {
    return normalized;
  }

  return content.replace(/\s+/g, " ").trim();
};

export const getSpeechMessageContent = (
  message: ChatSessionMessage,
): string => {
  return normalizeMarkdownForSpeech(getRenderedMessageContent(message));
};

const createExecutionThinkingTone = (
  status: TaskExecutionResult["status"],
): TaskThinkingTrace["timelineEvents"][number]["tone"] => {
  switch (status) {
    case "planned":
      return "info";
    case "executed":
      return "success";
    case "blocked":
      return "danger";
    case "cancelled":
    case "unsupported":
    default:
      return "neutral";
  }
};

const createExecutionThinkingLabel = (
  status: TaskExecutionResult["status"],
): string => {
  switch (status) {
    case "planned":
      return "Plan ready";
    case "executed":
      return "Completed";
    case "blocked":
      return "Blocked";
    case "cancelled":
      return "Cancelled";
    case "unsupported":
    default:
      return "Preview only";
  }
};

const COMPACT_TRACE_SECTION_LINE_LIMIT = 3;
const COMPACT_TRACE_ENTRY_LIMIT = 16;

export const createExecutionThinkingTrace = (
  execution: TaskExecutionResult,
): TaskThinkingTrace => {
  const summaryTone = createExecutionThinkingTone(execution.status);
  const timelineEvents: TaskThinkingTrace["timelineEvents"] = [];
  const normalizedSummary = execution.summary.trim();
  let omittedEntryCount = 0;

  const appendEntry = (
    label: string,
    detail: string,
    tone: TaskThinkingTrace["timelineEvents"][number]["tone"],
  ): void => {
    const normalizedDetail = detail.trim();

    if (!normalizedDetail) {
      return;
    }

    if (timelineEvents.length >= COMPACT_TRACE_ENTRY_LIMIT) {
      omittedEntryCount += 1;
      return;
    }

    timelineEvents.push({
      id: `${execution.task}-${timelineEvents.length}`,
      kind: "state",
      phase: "completed",
      label,
      detail: normalizedDetail,
      tone,
      timestamp: timelineEvents.length,
      elapsedMs: timelineEvents.length,
    });
  };

  if (normalizedSummary.length > 0) {
    appendEntry(
      createExecutionThinkingLabel(execution.status),
      normalizedSummary,
      summaryTone,
    );
  }

  execution.outputSections
    .filter((section) => section.audience !== "internal")
    .forEach((section, sectionIndex) => {
      const sectionTone =
        section.tone ?? (sectionIndex === 0 ? summaryTone : "neutral");
      const visibleLines = section.lines
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, COMPACT_TRACE_SECTION_LINE_LIMIT);

      visibleLines.forEach((line) => {
        appendEntry(section.title, line, sectionTone);
      });

      if (section.lines.length > visibleLines.length) {
        omittedEntryCount += section.lines.length - visibleLines.length;
      }
    });

  if (omittedEntryCount > 0) {
    if (timelineEvents.length >= COMPACT_TRACE_ENTRY_LIMIT) {
      timelineEvents.pop();
    }

    appendEntry(
      "More activity",
      `${omittedEntryCount} additional detail${omittedEntryCount === 1 ? "" : "s"} omitted from this compact log.`,
      "neutral",
    );
  }

  if (timelineEvents.length === 0) {
    timelineEvents.push({
      id: `${execution.task}-empty`,
      kind: "state",
      phase: "completed",
      label: createExecutionThinkingLabel(execution.status),
      detail: "Task finished without additional execution trace details.",
      tone: summaryTone,
      timestamp: 0,
      elapsedMs: 0,
    });
  }

  return {
    status: "complete",
    mode: execution.mode,
    startedAt: timelineEvents[0]?.timestamp ?? 0,
    task: execution.task,
    completedAt: timelineEvents.at(-1)?.timestamp ?? 0,
    timelineEvents,
  };
};
