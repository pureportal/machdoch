import {
  Bot,
  Copy,
  Download,
  Play,
  RotateCcw,
  Save,
  Square,
  User,
  Volume2,
  WandSparkles,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useState,
  type JSX,
  type MouseEvent,
  type RefObject,
} from "react";
import type {
  ChatSessionContextAttachment,
  ChatSessionMessage,
} from "../../chat-session.model";
import { Avatar } from "../../components/ui/avatar";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { TaskThinkingPanel } from "../../task-thinking-panel";
import {
  clampAiContextMessageLimit,
  DEFAULT_AI_CONTEXT_MESSAGE_LIMIT,
  getAiContextCutoffMessageId,
} from "../_helpers/ai-context-window";
import {
  createExecutionThinkingTrace,
  getRenderedMessageContent,
} from "../_helpers/execution-message.tsx";
import { createContextAttachmentsFromTaskBlock } from "../_helpers/session-context-attachments";
import { MessageAttachmentsList } from "./context-attachments";
import { ExecutionInsightRow } from "./execution-insight-row";
import { MessageMarkdown } from "./message-markdown";

export interface ConversationFeedProps {
  visibleMessages: ChatSessionMessage[];
  aiContextMessageLimit?: number;
  bottomRef: RefObject<HTMLDivElement | null>;
  onRetryTask: (message: ChatSessionMessage) => void;
  onContinueTask: (message: ChatSessionMessage) => void;
  onSaveMessageAsContextPack?: (message: ChatSessionMessage) => void;
  onOpenWorkspaceFile: (relativePath: string) => void;
  onOpenAttachment?: (attachment: ChatSessionContextAttachment) => void;
  voicePlayback: {
    supported: boolean;
    speakingMessageId: string | null;
    onSpeakMessage: (message: ChatSessionMessage) => void;
    onStopSpeaking: () => void;
  };
}

const RECOVERED_TASK_CRASH_PREFIX = "**Task crashed.**";
const MESSAGE_CONTEXT_MENU_WIDTH = 196;
const MESSAGE_CONTEXT_MENU_HEADER_HEIGHT = 44;
const MESSAGE_CONTEXT_MENU_ITEM_HEIGHT = 32;
const MESSAGE_CONTEXT_MENU_MARGIN = 8;

interface MessageContextMenuState {
  role: ChatSessionMessage["role"];
  content: string;
  fileName: string;
  contextPackMessage: ChatSessionMessage | null;
  hasMarkdownContent: boolean;
  left: number;
  top: number;
}

const isRecoveredTaskCrashMessage = (message: ChatSessionMessage): boolean => {
  return (
    message.role === "agent" &&
    !message.source &&
    message.content.startsWith(RECOVERED_TASK_CRASH_PREFIX)
  );
};

const clampMenuCoordinate = (
  coordinate: number,
  menuSize: number,
  viewportSize: number,
): number => {
  const maxCoordinate = Math.max(
    MESSAGE_CONTEXT_MENU_MARGIN,
    viewportSize - menuSize - MESSAGE_CONTEXT_MENU_MARGIN,
  );

  return Math.min(Math.max(coordinate, MESSAGE_CONTEXT_MENU_MARGIN), maxCoordinate);
};

const createMessageContextMenuPosition = (
  event: MouseEvent<HTMLElement>,
  menuHeight: number,
): { left: number; top: number } => {
  if (typeof window === "undefined") {
    return {
      left: event.clientX,
      top: event.clientY,
    };
  }

  return {
    left: clampMenuCoordinate(
      event.clientX,
      MESSAGE_CONTEXT_MENU_WIDTH,
      window.innerWidth,
    ),
    top: clampMenuCoordinate(
      event.clientY,
      menuHeight,
      window.innerHeight,
    ),
  };
};

const getMessageContextMenuHeight = (itemCount: number): number =>
  MESSAGE_CONTEXT_MENU_HEADER_HEIGHT + itemCount * MESSAGE_CONTEXT_MENU_ITEM_HEIGHT;

const sanitizeMessageFileNamePart = (value: string): string => {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
};

const createMessageMarkdownFileName = (message: ChatSessionMessage): string => {
  const roleLabel = message.role === "agent" ? "assistant" : "user";
  const createdAtLabel =
    typeof message.createdAt === "number" && Number.isFinite(message.createdAt)
      ? new Date(message.createdAt).toISOString().replace(/[:.]/g, "-")
      : null;
  const fallbackLabel = sanitizeMessageFileNamePart(message.id) || "message";

  return `machdoch-${roleLabel}-message-${createdAtLabel ?? fallbackLabel}.md`;
};

const copyMarkdownToClipboard = async (content: string): Promise<void> => {
  if (!navigator.clipboard?.writeText) {
    throw new Error("Clipboard write access is unavailable.");
  }

  await navigator.clipboard.writeText(content);
};

const saveMarkdownDownload = (content: string, fileName: string): void => {
  if (typeof document === "undefined") {
    throw new Error("Document downloads are unavailable.");
  }

  const blob = new Blob([content], {
    type: "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  try {
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
};

export const ConversationFeed = ({
  visibleMessages,
  aiContextMessageLimit = DEFAULT_AI_CONTEXT_MESSAGE_LIMIT,
  bottomRef,
  onRetryTask,
  onContinueTask,
  onSaveMessageAsContextPack,
  onOpenWorkspaceFile,
  onOpenAttachment,
  voicePlayback,
}: ConversationFeedProps): JSX.Element => {
  const [messageContextMenu, setMessageContextMenu] =
    useState<MessageContextMenuState | null>(null);

  useEffect(() => {
    if (!messageContextMenu) {
      return;
    }

    const closeMessageContextMenu = (): void => {
      setMessageContextMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeMessageContextMenu();
      }
    };

    document.addEventListener("pointerdown", closeMessageContextMenu);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", closeMessageContextMenu);
    window.addEventListener("scroll", closeMessageContextMenu, true);

    return () => {
      document.removeEventListener("pointerdown", closeMessageContextMenu);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", closeMessageContextMenu);
      window.removeEventListener("scroll", closeMessageContextMenu, true);
    };
  }, [messageContextMenu]);

  const openMessageContextMenu = useCallback(
    (
      event: MouseEvent<HTMLDivElement>,
      message: ChatSessionMessage,
      content: string,
      canSaveAsContextPack: boolean,
    ): void => {
      event.preventDefault();
      event.stopPropagation();

      const hasMarkdownContent = content.length > 0;

      if (!hasMarkdownContent && !canSaveAsContextPack) {
        setMessageContextMenu(null);
        return;
      }

      const position = createMessageContextMenuPosition(
        event,
        getMessageContextMenuHeight(
          (canSaveAsContextPack ? 1 : 0) + (hasMarkdownContent ? 2 : 0),
        ),
      );

      setMessageContextMenu({
        role: message.role,
        content,
        fileName: createMessageMarkdownFileName(message),
        contextPackMessage: canSaveAsContextPack ? message : null,
        hasMarkdownContent,
        ...position,
      });
    },
    [],
  );

  const copyMessageMarkdown = useCallback(async (): Promise<void> => {
    const activeMenu = messageContextMenu;

    if (!activeMenu) {
      return;
    }

    setMessageContextMenu(null);

    try {
      await copyMarkdownToClipboard(activeMenu.content);
    } catch (error) {
      console.error("Failed to copy message Markdown:", error);
    }
  }, [messageContextMenu]);

  const saveMessageMarkdown = useCallback((): void => {
    const activeMenu = messageContextMenu;

    if (!activeMenu) {
      return;
    }

    setMessageContextMenu(null);

    try {
      saveMarkdownDownload(activeMenu.content, activeMenu.fileName);
    } catch (error) {
      console.error("Failed to save message Markdown:", error);
    }
  }, [messageContextMenu]);

  const saveMessageAsContextPack = useCallback((): void => {
    const activeMenu = messageContextMenu;

    if (!activeMenu?.contextPackMessage) {
      return;
    }

    setMessageContextMenu(null);
    onSaveMessageAsContextPack?.(activeMenu.contextPackMessage);
  }, [messageContextMenu, onSaveMessageAsContextPack]);

  if (visibleMessages.length === 0) {
    return (
      <div className="app-conversation-empty mx-auto flex min-h-full max-w-2xl flex-col items-center justify-center py-16">
        <div className="flex flex-col items-center gap-6 text-center">
          <div className="app-conversation-empty-icon flex h-16 w-16 items-center justify-center rounded-3xl bg-sky-500/10 text-sky-300">
            <WandSparkles className="h-8 w-8" />
          </div>
          <div className="grid gap-2">
            <h2 className="text-xl font-medium text-white">
              Ready to automate
            </h2>
          </div>
        </div>
      </div>
    );
  }

  const normalizedAiContextMessageLimit = clampAiContextMessageLimit(
    aiContextMessageLimit,
  );
  const cutoffMessageId = getAiContextCutoffMessageId(
    visibleMessages,
    normalizedAiContextMessageLimit,
  );

  return (
    <div className="app-conversation-feed mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-6 pb-2 px-4 pt-8 lg:px-6">
      {visibleMessages.map((message) => {
        if (message.role === "agent" && message.source?.kind === "preview") {
          return null;
        }

        const renderedContent = getRenderedMessageContent(message);
        const thinkingTrace =
          message.source?.kind === "execution"
            ? createExecutionThinkingTrace(message.source.execution)
            : message.source?.kind === "thinking"
              ? message.source.thinking
              : null;
        const isSpeakingMessage = voicePlayback.speakingMessageId === message.id;
        const shouldRenderBubble =
          message.role === "user" || renderedContent.trim().length > 0;
        const showCrashRecoveryActions = isRecoveredTaskCrashMessage(message);
        const messageAttachments =
          message.role === "user"
            ? message.contextAttachments?.length
              ? message.contextAttachments
              : createContextAttachmentsFromTaskBlock(
                  message.content,
                  `legacy-message-context-${message.id}`,
                )
            : [];
        const canSaveMessageAsContextPack =
          message.role === "user" && Boolean(onSaveMessageAsContextPack);

        return (
          <div key={message.id} className="contents">
            {cutoffMessageId === message.id ? (
              <div
                role="separator"
                aria-label={`AI context starts here. Last ${normalizedAiContextMessageLimit} messages are included.`}
                className="app-ai-context-separator flex items-center gap-3 px-2 py-1 text-xs font-medium text-slate-500"
              >
                <div className="h-px flex-1 bg-slate-800" />
                <span className="shrink-0 rounded-full border border-sky-500/20 bg-sky-500/10 px-3 py-1 text-sky-200">
                  AI context starts here - last {normalizedAiContextMessageLimit} messages
                </span>
                <div className="h-px flex-1 bg-slate-800" />
              </div>
            ) : null}

            <div
              className={cn(
                "app-message-row flex min-w-0 gap-4",
                message.role === "user" ? "flex-row-reverse" : "flex-row",
              )}
            >
              <Avatar
                className={cn(
                  "app-message-avatar mt-1 h-10 w-10 shrink-0 border",
                  message.role === "agent"
                    ? "border-sky-500/20 bg-sky-500/10"
                    : "border-emerald-500/20 bg-emerald-500/20",
                )}
              >
                <div className="flex h-full w-full items-center justify-center">
                  {message.role === "agent" ? (
                    <Bot className="h-5 w-5 text-sky-300" />
                  ) : (
                    <User className="h-5 w-5 text-emerald-100" />
                  )}
                </div>
              </Avatar>

              <div
                className={cn(
                  "app-message-stack flex min-w-0 flex-1 flex-col gap-3",
                  message.role === "user" ? "items-end" : "items-start",
                )}
              >
                {thinkingTrace ? (
                  <div className="app-thinking-wrapper w-full min-w-0 max-w-full pt-1 lg:max-w-4xl">
                    <TaskThinkingPanel thinking={thinkingTrace} />
                  </div>
                ) : null}

                {shouldRenderBubble ? (
                  <div
                    className={cn(
                      "app-message-bubble relative max-w-[90%] min-w-0 overflow-hidden rounded-[1.75rem] px-5 py-4 text-sm leading-7 shadow-lg wrap-break-word",
                      message.role === "user"
                        ? "app-user-message-bubble rounded-tr-md bg-slate-800 text-slate-100 shadow-slate-950/20"
                        : "app-agent-message-bubble rounded-tl-sm border border-slate-800 bg-slate-900/80 pr-14 text-slate-300 shadow-slate-950/30",
                    )}
                    onContextMenu={(event) =>
                      openMessageContextMenu(
                        event,
                        message,
                        renderedContent,
                        canSaveMessageAsContextPack,
                      )
                    }
                  >
                    {message.role === "agent" &&
                    voicePlayback.supported &&
                    renderedContent.trim().length > 0 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={
                          isSpeakingMessage
                            ? "Stop reading aloud"
                            : "Read response aloud"
                        }
                        title={
                          isSpeakingMessage
                            ? "Stop reading aloud"
                            : "Read response aloud"
                        }
                        onClick={() => {
                          if (isSpeakingMessage) {
                            voicePlayback.onStopSpeaking();
                            return;
                          }

                          voicePlayback.onSpeakMessage(message);
                        }}
                        className={cn(
                          "app-message-voice-button absolute top-3 right-3 h-7 w-7 rounded-full border border-slate-800 bg-slate-950/70 text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                          isSpeakingMessage &&
                            "border-rose-500/30 text-rose-200 hover:text-rose-100",
                        )}
                      >
                        {isSpeakingMessage ? (
                          <Square className="h-3.5 w-3.5" />
                        ) : (
                          <Volume2 className="h-3.5 w-3.5 text-sky-300" />
                        )}
                      </Button>
                    ) : null}

                    <MessageMarkdown
                      content={renderedContent}
                      className={
                        message.role === "user"
                          ? "app-user-message-text"
                          : undefined
                      }
                    />
                  </div>
                ) : null}

                {messageAttachments.length > 0 ? (
                  <MessageAttachmentsList
                    attachments={messageAttachments}
                    onOpen={onOpenAttachment}
                    align={message.role === "user" ? "end" : "start"}
                  />
                ) : null}

                {message.source?.kind === "execution" ? (
                  <ExecutionInsightRow
                    execution={message.source.execution}
                    onRetryTask={() => onRetryTask(message)}
                    onContinueTask={() => onContinueTask(message)}
                    onOpenWorkspaceFile={onOpenWorkspaceFile}
                  />
                ) : null}

                {showCrashRecoveryActions ? (
                  <div className="app-message-actions flex max-w-[90%] min-w-0 flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onRetryTask(message)}
                      className="h-8 rounded-full border-amber-500/30 bg-amber-500/10 px-3 text-xs text-amber-100 hover:bg-amber-500/15 hover:text-white"
                    >
                      <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                      Retry
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onContinueTask(message)}
                      className="h-8 rounded-full border-emerald-500/30 bg-emerald-500/10 px-3 text-xs text-emerald-100 hover:bg-emerald-500/15 hover:text-white"
                    >
                      <Play className="mr-1.5 h-3.5 w-3.5" />
                      Continue
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
      {messageContextMenu ? (
        <div
          role="menu"
          aria-label="Message actions"
          className="app-message-context-menu fixed z-[140] w-[196px] rounded-lg border border-slate-700 bg-slate-950 p-1.5 text-slate-100 shadow-2xl shadow-black/45"
          style={{
            left: messageContextMenu.left,
            top: messageContextMenu.top,
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <div className="min-w-0 px-2 pb-1 pt-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
            <span className="block truncate">
              {messageContextMenu.role === "agent" ? "Assistant" : "User"} message
            </span>
          </div>
          {messageContextMenu.contextPackMessage ? (
            <button
              type="button"
              role="menuitem"
              onClick={saveMessageAsContextPack}
              className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs font-medium text-slate-200 outline-none hover:bg-slate-800 focus:bg-slate-800"
            >
              <Save className="h-3.5 w-3.5 shrink-0 text-sky-300" />
              <span className="min-w-0 flex-1 truncate">Save as pack</span>
            </button>
          ) : null}
          {messageContextMenu.hasMarkdownContent ? (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => void copyMessageMarkdown()}
                className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs font-medium text-slate-200 outline-none hover:bg-slate-800 focus:bg-slate-800"
              >
                <Copy className="h-3.5 w-3.5 shrink-0 text-sky-300" />
                <span className="min-w-0 flex-1 truncate">Copy Markdown</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={saveMessageMarkdown}
                className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs font-medium text-slate-200 outline-none hover:bg-slate-800 focus:bg-slate-800"
              >
                <Download className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
                <span className="min-w-0 flex-1 truncate">Save Message</span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      <div ref={bottomRef} className="h-2 shrink-0" />
    </div>
  );
};
