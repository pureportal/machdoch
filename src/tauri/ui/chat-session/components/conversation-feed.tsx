import { Bot, User, WandSparkles } from "lucide-react";
import type { JSX, RefObject } from "react";
import type { ChatSessionMessage } from "../../chat-session.model";
import { Avatar } from "../../components/ui/avatar";
import { cn } from "../../lib/utils";
import { TaskThinkingPanel } from "../../task-thinking-panel";
import {
  createExecutionThinkingTrace,
  getRenderedMessageContent,
} from "../_helpers/execution-message.tsx";
import { ExecutionInsightRow } from "./execution-insight-row";
import { MessageMarkdown } from "./message-markdown";

export interface ConversationFeedProps {
  visibleMessages: ChatSessionMessage[];
  bottomRef: RefObject<HTMLDivElement | null>;
  onOpenWorkspaceFile: (relativePath: string) => void;
}

export const ConversationFeed = ({
  visibleMessages,
  bottomRef,
  onOpenWorkspaceFile,
}: ConversationFeedProps): JSX.Element => {
  if (visibleMessages.length === 0) {
    return (
      <div className="mx-auto flex min-h-full max-w-2xl flex-col items-center justify-center py-16">
        <div className="flex flex-col items-center gap-6 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-sky-500/10 text-sky-300">
            <WandSparkles className="h-8 w-8" />
          </div>
          <div className="grid gap-2">
            <h2 className="text-xl font-medium text-white">
              Ready to automate
            </h2>
            <p className="mx-auto max-w-sm text-sm leading-6 text-slate-400">
              Pick a workspace anytime, or start from your home folder.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 pb-2 pr-4 pt-8 lg:pr-6">
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
        const shouldRenderBubble =
          message.role === "user" || renderedContent.trim().length > 0;

        return (
          <div
            key={message.id}
            className={cn(
              "flex gap-4",
              message.role === "user" ? "flex-row-reverse" : "flex-row",
            )}
          >
            <Avatar
              className={cn(
                "mt-1 h-10 w-10 shrink-0 border",
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
                "flex min-w-0 flex-1 flex-col gap-3",
                message.role === "user" ? "items-end" : "items-start",
              )}
            >
              {thinkingTrace ? (
                <div className="w-full pt-1 lg:max-w-4xl">
                  <TaskThinkingPanel thinking={thinkingTrace} />
                </div>
              ) : null}

              {shouldRenderBubble ? (
                <div
                  className={cn(
                    "max-w-[90%] rounded-[1.75rem] px-5 py-4 text-sm leading-7 shadow-lg",
                    message.role === "user"
                      ? "rounded-tr-md bg-slate-800 text-slate-100 shadow-slate-950/20"
                      : "rounded-tl-sm border border-slate-800 bg-slate-900/80 text-slate-300 shadow-slate-950/30",
                  )}
                >
                  {message.role === "agent" ? (
                    <MessageMarkdown content={renderedContent} />
                  ) : (
                    <div className="whitespace-pre-wrap">{renderedContent}</div>
                  )}
                </div>
              ) : null}

              {message.source?.kind === "execution" ? (
                <ExecutionInsightRow
                  execution={message.source.execution}
                  onOpenWorkspaceFile={onOpenWorkspaceFile}
                />
              ) : null}
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} className="h-2 shrink-0" />
    </div>
  );
};
