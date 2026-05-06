import type { JSX } from "react";
import type { Components } from "react-markdown";
import type { TaskExecutionResult } from "../../../../core/types.js";
import type { ChatSessionMessage } from "../../chat-session.model";
import type { TaskThinkingTrace } from "../../task-thinking.model";

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
    case "approval-required":
      return `**Approval required.** ${summary}`;
    case "blocked":
      return `**Blocked.** ${summary}`;
    case "cancelled":
      return `**Cancelled.** ${summary}`;
    case "unsupported":
    default:
      return `**Preview only.** ${summary}`;
  }
};

export const getExecutionMessageContent = (
  execution: TaskExecutionResult,
): string => {
  const structuredMarkdown = execution.response?.markdown?.trim();

  return structuredMarkdown || createFallbackExecutionMarkdown(execution);
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
    return getExecutionMessageContent(message.source.execution);
  }

  return message.content;
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
): TaskThinkingTrace["entries"][number]["tone"] => {
  switch (status) {
    case "planned":
      return "info";
    case "executed":
      return "success";
    case "approval-required":
      return "warning";
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
    case "approval-required":
      return "Approval required";
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
  const entries: TaskThinkingTrace["entries"] = [];
  const normalizedSummary = execution.summary.trim();
  let omittedEntryCount = 0;

  const appendEntry = (
    label: string,
    detail: string,
    tone: TaskThinkingTrace["entries"][number]["tone"],
  ): void => {
    const normalizedDetail = detail.trim();

    if (!normalizedDetail) {
      return;
    }

    if (entries.length >= COMPACT_TRACE_ENTRY_LIMIT) {
      omittedEntryCount += 1;
      return;
    }

    entries.push({
      id: `${execution.task}-${entries.length}`,
      label,
      detail: normalizedDetail,
      tone,
      timestamp: entries.length,
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
    if (entries.length >= COMPACT_TRACE_ENTRY_LIMIT) {
      entries.pop();
    }

    appendEntry(
      "More activity",
      `${omittedEntryCount} additional detail${omittedEntryCount === 1 ? "" : "s"} omitted from this compact log.`,
      "neutral",
    );
  }

  if (entries.length === 0) {
    entries.push({
      id: `${execution.task}-empty`,
      label: createExecutionThinkingLabel(execution.status),
      detail: "Task finished without additional execution trace details.",
      tone: summaryTone,
      timestamp: 0,
    });
  }

  return {
    status: "complete",
    mode: execution.mode,
    entries,
  };
};

export const markdownComponents: Components = {
  p: ({ children }): JSX.Element => (
    <p className="m-0 whitespace-pre-wrap">{children}</p>
  ),
  ul: ({ children }): JSX.Element => (
    <ul className="m-0 list-disc space-y-1 pl-5">{children}</ul>
  ),
  ol: ({ children }): JSX.Element => (
    <ol className="m-0 list-decimal space-y-1 pl-5">{children}</ol>
  ),
  li: ({ children }): JSX.Element => <li className="leading-6">{children}</li>,
  blockquote: ({ children }): JSX.Element => (
    <blockquote className="m-0 border-l-2 border-slate-700 pl-4 text-slate-400 italic">
      {children}
    </blockquote>
  ),
  pre: ({ children }): JSX.Element => (
    <pre className="m-0 overflow-x-auto rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3 text-xs leading-6 text-slate-200">
      {children}
    </pre>
  ),
  code: ({ children, className, ...props }): JSX.Element => (
    <code
      {...props}
      className={[
        "rounded-md bg-slate-950/90 px-1.5 py-0.5 font-mono text-[0.92em] text-sky-200",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </code>
  ),
  a: ({ children, href, ...props }): JSX.Element => (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-sky-300 underline decoration-sky-500/40 underline-offset-4 transition-colors hover:text-sky-100"
    >
      {children}
    </a>
  ),
};
