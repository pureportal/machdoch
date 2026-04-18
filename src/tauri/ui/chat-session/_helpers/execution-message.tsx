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

export const createExecutionThinkingTrace = (
  execution: TaskExecutionResult,
): TaskThinkingTrace => {
  const summaryTone = createExecutionThinkingTone(execution.status);
  const entries: TaskThinkingTrace["entries"] = [];
  const normalizedSummary = execution.summary.trim();

  if (normalizedSummary.length > 0) {
    entries.push({
      id: `${execution.task}-summary`,
      label: createExecutionThinkingLabel(execution.status),
      detail: normalizedSummary,
      tone: summaryTone,
      timestamp: 0,
    });
  }

  execution.outputSections.forEach((section, sectionIndex) => {
    section.lines.forEach((line, lineIndex) => {
      const normalizedLine = line.trim();

      if (!normalizedLine) {
        return;
      }

      entries.push({
        id: `${execution.task}-${sectionIndex}-${lineIndex}`,
        label: section.title,
        detail: normalizedLine,
        tone: sectionIndex === 0 ? summaryTone : "neutral",
        timestamp: entries.length,
      });
    });
  });

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
