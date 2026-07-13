import { Check, Clipboard } from "lucide-react";
import {
  isValidElement,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import type { Components } from "react-markdown";
import type { TaskExecutionResult } from "../../../../core/types.js";
import type { ChatSessionMessage } from "../../chat-session.model";
import { Button } from "../../components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../components/ui/tooltip";
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
    return message.content.trim() || getExecutionMessageContent(message.source.execution);
  }

  if (message.role === "user") {
    return (
      getTaskActionDisplayContent(message.content) ??
      stripContextAttachmentsTaskBlock(message.content)
    );
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

const getReactNodeText = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }

  if (
    typeof node === "string" ||
    typeof node === "number" ||
    typeof node === "bigint"
  ) {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(getReactNodeText).join("");
  }

  if (isValidElement<{ children?: ReactNode }>(node)) {
    return getReactNodeText(node.props.children);
  }

  return "";
};

const getStructuredFindingsField = (children: ReactNode): string | undefined => {
  const text = getReactNodeText(children).trimStart();
  const match = /^(severity|location|issue|evidence|impact|recommendation)\s*:/iu.exec(
    text,
  );

  if (!match?.[1]) {
    return undefined;
  }

  switch (match[1].toLowerCase()) {
    case "severity":
      return "severity";
    case "location":
      return "location";
    case "issue":
      return "issue";
    case "evidence":
      return "evidence";
    case "impact":
      return "impact";
    case "recommendation":
      return "recommendation";
    default:
      return undefined;
  }
};

const copyTextToClipboard = async (text: string): Promise<void> => {
  if (globalThis.navigator?.clipboard?.writeText) {
    await globalThis.navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard API is unavailable.");
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";

  document.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  try {
    if (!document.execCommand("copy")) {
      throw new Error("Copy command was rejected.");
    }
  } finally {
    textarea.remove();
  }
};

const CopyableCodeBlock = ({ children }: { children?: ReactNode }): JSX.Element => {
  const [hasCopied, setHasCopied] = useState(false);
  const resetCopiedTimeout = useRef<number | null>(null);
  const codeBlockText = getReactNodeText(children).replace(/\n$/, "");

  useEffect(() => {
    return () => {
      if (resetCopiedTimeout.current !== null) {
        window.clearTimeout(resetCopiedTimeout.current);
      }
    };
  }, []);

  const handleCopy = async (): Promise<void> => {
    try {
      await copyTextToClipboard(codeBlockText);
      setHasCopied(true);

      if (resetCopiedTimeout.current !== null) {
        window.clearTimeout(resetCopiedTimeout.current);
      }

      resetCopiedTimeout.current = window.setTimeout(() => {
        setHasCopied(false);
        resetCopiedTimeout.current = null;
      }, 1_500);
    } catch {
      setHasCopied(false);
    }
  };

  return (
    <div className="app-message-code-block group relative min-w-0">
      <pre className="m-0 max-w-full overflow-x-auto rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3 pr-12 text-xs leading-6 text-slate-200">
        {children}
      </pre>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={
                hasCopied
                  ? "Copied code block"
                  : "Copy code block to clipboard"
              }
              title="Copy to Clipboard"
              onClick={handleCopy}
              className="absolute right-2 top-2 size-7 border border-slate-700/70 bg-slate-900/90 p-0 text-slate-300 shadow-sm opacity-90 hover:bg-slate-800 hover:text-sky-100 focus-visible:ring-sky-400/40"
            >
              {hasCopied ? (
                <Check className="size-3.5" aria-hidden="true" />
              ) : (
                <Clipboard className="size-3.5" aria-hidden="true" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">
            {hasCopied ? "Copied" : "Copy to Clipboard"}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
};

const createExecutionThinkingTone = (
  status: TaskExecutionResult["status"],
): TaskThinkingTrace["entries"][number]["tone"] => {
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
    startedAt: entries[0]?.timestamp ?? 0,
    task: execution.task,
    completedAt: entries.at(-1)?.timestamp ?? 0,
    entries,
  };
};

export const markdownComponents: Components = {
  p: ({ children }): JSX.Element => {
    const structuredField = getStructuredFindingsField(children);

    return (
      <p
        data-md-field={structuredField}
        className="m-0 whitespace-pre-wrap wrap-break-word"
      >
        {children}
      </p>
    );
  },
  ul: ({ children }): JSX.Element => (
    <ul className="m-0 min-w-0 list-disc space-y-1 pl-5 wrap-break-word">
      {children}
    </ul>
  ),
  ol: ({ children }): JSX.Element => (
    <ol className="m-0 min-w-0 list-decimal space-y-1 pl-5 wrap-break-word">
      {children}
    </ol>
  ),
  li: ({ children }): JSX.Element => (
    <li className="leading-6 wrap-break-word">{children}</li>
  ),
  blockquote: ({ children }): JSX.Element => (
    <blockquote className="m-0 min-w-0 border-l-2 border-slate-700 pl-4 text-slate-400 italic wrap-break-word">
      {children}
    </blockquote>
  ),
  pre: ({ children }): JSX.Element => (
    <CopyableCodeBlock>{children}</CopyableCodeBlock>
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
