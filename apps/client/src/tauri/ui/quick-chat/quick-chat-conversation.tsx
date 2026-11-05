import { memo, useMemo, useRef, type JSX } from "react";
import { MarkdownContent } from "@machdoch/client-ui/conversation/markdown-content";
import { TaskThinkingPanel } from "@machdoch/client-ui/conversation/task-thinking-panel";
import { FollowUpSuggestions } from "@machdoch/client-ui/conversation/follow-up-suggestions";
import { MessageAttachmentsList } from "@machdoch/client-ui/composer/context-attachments";
import type { ChatSessionContextAttachment } from "@machdoch/client-ui/composer/model";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type { ChatSessionMessage } from "../chat-session.model";
import {
  createExecutionThinkingTrace,
  getRenderedMessageContent,
} from "../chat-session/_helpers/execution-message.tsx";
import { useNewestMessageScroll } from "../chat-session/_helpers/use-newest-message-scroll";
import { ScrollArea } from "../components/ui/scroll-area";
import { ScrollToNewestButton } from "../chat-session/components/scroll-to-newest-button";

const NO_SUGGESTIONS: readonly string[] = [];

const readThinkingTrace = (message: ChatSessionMessage) =>
  message.source?.kind === "execution"
    ? (message.source.thinking ??
      createExecutionThinkingTrace(message.source.execution))
    : message.source?.kind === "thinking"
      ? message.source.thinking
      : null;

interface QuickChatMessageHandlers {
  onOpenWorkspaceFile: (relativePath: string, line?: number) => void;
  onOpenLocalFile: (path: string, line?: number, external?: boolean) => void;
  onOpenAttachment: (attachment: ChatSessionContextAttachment) => void;
  onPickSuggestion: (suggestion: string) => void;
  onSendSuggestion: (suggestion: string) => void;
}

export interface QuickChatConversationProps extends QuickChatMessageHandlers {
  sessionId: string;
  messages: readonly ChatSessionMessage[];
  workspaceRoot: string | null;
  running: boolean;
}

const QuickChatMessage = memo(function QuickChatMessage({
  message,
  workspaceRoot,
  suggestions,
  handlers,
}: {
  message: ChatSessionMessage;
  workspaceRoot: string | null;
  suggestions: readonly string[];
  handlers: QuickChatMessageHandlers;
}): JSX.Element {
  const content = getRenderedMessageContent(message).trim();
  if (message.role === "user") {
    const attachments = message.contextAttachments ?? [];
    return (
      <li className="grid justify-items-end gap-1.5">
        <p className="max-w-[88%] rounded-2xl rounded-tr-md bg-slate-800 px-3.5 py-2 text-sm leading-6 whitespace-pre-wrap text-slate-100 [overflow-wrap:anywhere]">
          {content}
        </p>
        {attachments.length > 0 ? (
          <MessageAttachmentsList
            attachments={attachments}
            onOpen={handlers.onOpenAttachment}
            align="end"
          />
        ) : null}
      </li>
    );
  }
  const thinking = readThinkingTrace(message);
  return (
    <li className="grid min-w-0 gap-2">
      {thinking ? <TaskThinkingPanel thinking={thinking} /> : null}
      {content ? (
        <div
          className={cn(
            "min-w-0 rounded-2xl rounded-tl-md border border-slate-800 bg-slate-900/80 px-3.5 py-2.5 text-sm leading-6 text-slate-300",
            message.source?.kind === "execution" &&
              message.source.execution.status === "failed" &&
              "border-rose-500/30",
          )}
        >
          <MarkdownContent
            content={content}
            workspaceRoot={workspaceRoot}
            onOpenWorkspaceFile={handlers.onOpenWorkspaceFile}
            onOpenLocalFile={handlers.onOpenLocalFile}
          />
        </div>
      ) : null}
      <FollowUpSuggestions
        suggestions={suggestions}
        onPick={handlers.onPickSuggestion}
        onSend={handlers.onSendSuggestion}
      />
    </li>
  );
});

export const QuickChatConversation = ({
  sessionId,
  messages,
  workspaceRoot,
  running,
  ...handlerProps
}: QuickChatConversationProps): JSX.Element => {
  const scroll = useNewestMessageScroll({
    resetKey: sessionId,
    contentKey: messages,
  });
  const latestHandlers = useRef(handlerProps);
  latestHandlers.current = handlerProps;
  const handlers = useMemo<QuickChatMessageHandlers>(
    () => ({
      onOpenWorkspaceFile: (relativePath, line) =>
        latestHandlers.current.onOpenWorkspaceFile(relativePath, line),
      onOpenLocalFile: (path, line, external) =>
        latestHandlers.current.onOpenLocalFile(path, line, external),
      onOpenAttachment: (attachment) =>
        latestHandlers.current.onOpenAttachment(attachment),
      onPickSuggestion: (suggestion) =>
        latestHandlers.current.onPickSuggestion(suggestion),
      onSendSuggestion: (suggestion) =>
        latestHandlers.current.onSendSuggestion(suggestion),
    }),
    [],
  );
  const lastAgentMessage = messages
    .filter((message) => message.role === "agent")
    .at(-1);
  const lastSuggestions =
    !running && lastAgentMessage
      ? (readThinkingTrace(lastAgentMessage)?.agentLive?.suggestions ??
        NO_SUGGESTIONS)
      : NO_SUGGESTIONS;

  return (
    <div className="relative min-h-0 flex-1">
      <ScrollArea className="h-full">
        <ol aria-label="Quick Chat messages" className="grid gap-3 px-4 py-4">
          {messages.map((message) => (
            <QuickChatMessage
              key={message.id}
              message={message}
              workspaceRoot={workspaceRoot}
              suggestions={
                message === lastAgentMessage ? lastSuggestions : NO_SUGGESTIONS
              }
              handlers={handlers}
            />
          ))}
        </ol>
        <div ref={scroll.bottomRef} className="h-px" />
      </ScrollArea>
      <ScrollToNewestButton
        visible={scroll.showScrollToNewestButton}
        onClick={scroll.scrollToNewest}
        className="right-3 bottom-3 h-8 w-8"
      />
    </div>
  );
};
