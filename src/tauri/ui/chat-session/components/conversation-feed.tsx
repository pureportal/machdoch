import {
  Bot,
  Play,
  RotateCcw,
  Square,
  User,
  Volume2,
  WandSparkles,
} from "lucide-react";
import type { JSX, RefObject } from "react";
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

const isRecoveredTaskCrashMessage = (message: ChatSessionMessage): boolean => {
  return (
    message.role === "agent" &&
    !message.source &&
    message.content.startsWith(RECOVERED_TASK_CRASH_PREFIX)
  );
};

export const ConversationFeed = ({
  visibleMessages,
  aiContextMessageLimit = DEFAULT_AI_CONTEXT_MESSAGE_LIMIT,
  bottomRef,
  onRetryTask,
  onContinueTask,
  onOpenWorkspaceFile,
  onOpenAttachment,
  voicePlayback,
}: ConversationFeedProps): JSX.Element => {
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

                    {message.role === "agent" ? (
                      <MessageMarkdown content={renderedContent} />
                    ) : (
                      <div className="app-user-message-text whitespace-pre-wrap wrap-break-word">
                        {renderedContent}
                      </div>
                    )}
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
      <div ref={bottomRef} className="h-2 shrink-0" />
    </div>
  );
};
