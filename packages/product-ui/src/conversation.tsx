import type {
  ProductMessage,
  ProductSession,
  ProductAttachment,
} from "@machdoch/fleet-protocol";
import { Bot, ChevronDown, User, WandSparkles } from "lucide-react";
import {
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { formatRelativeTime, formatTimestampDateTime } from "./format";
import { MessageActions } from "./message-actions";
import { PromptEnhancementIndicator } from "./prompt-enhancement";
import {
  getOriginalPromptContent,
  OriginalPromptPanel,
  OriginalPromptToggle,
} from "./original-prompt";
import type { ProductCommandHandler } from "./product-runtime";
import {
  useConversationControls,
  type ConversationControls,
} from "./conversation-controls";

export interface RemoteConversationProps {
  messages: ProductMessage[];
  session: ProductSession;
  pending: boolean;
  onCommand: ProductCommandHandler;
  historyAvailable: boolean;
}

export interface ConversationProps {
  renderInsights?: ((message: ProductMessage) => ReactNode) | undefined;
  renderActivity?: ((message: ProductMessage) => ReactNode) | undefined;
  messages: ProductMessage[];
  sessionId: string;
  pending: boolean;
  onCommand: ProductCommandHandler;
  renderAttachments: (
    attachments: ProductAttachment[],
    isUser: boolean,
    message?: ProductMessage,
  ) => ReactNode;
  renderContent: (
    content: string,
    className?: string,
    message?: ProductMessage,
  ) => ReactNode;
  renderEditor: (message: ProductMessage, onClose: () => void) => ReactNode;
  onOpenContextMenu: (
    event: MouseEvent<HTMLDivElement>,
    message: ProductMessage,
  ) => void;
  controls?: ConversationControls | undefined;
  onMessageElementChange?:
    | ((messageId: string, element: HTMLElement | null) => void)
    | undefined;
  onViewportChange?: ((element: HTMLElement) => void) | undefined;
}

export function Conversation({
  renderInsights,
  renderActivity,
  messages,
  sessionId,
  pending,
  onCommand,
  renderAttachments,
  renderContent,
  renderEditor,
  onOpenContextMenu,
  controls: suppliedControls,
  onMessageElementChange,
  onViewportChange,
}: ConversationProps): React.ReactElement {
  const internalControls = useConversationControls();
  const controls = suppliedControls ?? internalControls;
  const conversationRef = useRef<HTMLDivElement>(null);
  const followingNewestRef = useRef(true);
  const previousSessionIdRef = useRef(sessionId);
  const [showLatest, setShowLatest] = useState(false);

  useLayoutEffect(() => {
    const conversation = conversationRef.current;
    if (!conversation) return;
    if (previousSessionIdRef.current !== sessionId) {
      previousSessionIdRef.current = sessionId;
      followingNewestRef.current = true;
      setShowLatest(false);
      controls.reset();
    }
    if (followingNewestRef.current) {
      conversation.scrollTop = conversation.scrollHeight;
    }
  }, [messages, sessionId]);

  return (
    <div className="m-product-conversation-wrap">
      <div
        ref={conversationRef}
        className="m-product-conversation"
        aria-live="polite"
        onScroll={(event) => {
          const conversation = event.currentTarget;
          const distanceFromNewest =
            conversation.scrollHeight -
            conversation.scrollTop -
            conversation.clientHeight;
          followingNewestRef.current = distanceFromNewest <= 64;
          setShowLatest(!followingNewestRef.current);
          onViewportChange?.(conversation);
        }}
      >
        {messages.length === 0 ? (
          <div className="m-product-empty">
            <div className="m-product-empty-icon">
              <WandSparkles aria-hidden="true" />
            </div>
            <h2>Ready to automate</h2>
          </div>
        ) : (
          messages.map((message) => (
            <Message
              key={message.id}
              message={message}
              sessionId={sessionId}
              pending={pending}
              onCommand={onCommand}
              renderAttachments={renderAttachments}
              renderContent={renderContent}
              renderEditor={renderEditor}
              renderActivity={renderActivity}
              renderInsights={renderInsights}
              onOpenContextMenu={onOpenContextMenu}
              controls={controls}
              onMessageElementChange={onMessageElementChange}
            />
          ))
        )}
      </div>
      {showLatest ? (
        <button
          type="button"
          className="m-product-latest m-product-secondary-button"
          onClick={() => {
            const conversation = conversationRef.current;
            if (conversation)
              conversation.scrollTop = conversation.scrollHeight;
            followingNewestRef.current = true;
            setShowLatest(false);
          }}
        >
          <ChevronDown aria-hidden="true" /> Latest message
        </button>
      ) : null}
    </div>
  );
}

function Message({
  renderInsights,
  renderActivity,
  message,
  sessionId,
  pending,
  onCommand,
  renderAttachments,
  renderContent,
  renderEditor,
  onOpenContextMenu,
  controls,
  onMessageElementChange,
}: {
  message: ProductMessage;
  renderActivity: ConversationProps["renderActivity"];
  renderInsights: ConversationProps["renderInsights"];
  sessionId: string;
  pending: boolean;
  onCommand: ProductCommandHandler;
  renderAttachments: ConversationProps["renderAttachments"];
  renderContent: ConversationProps["renderContent"];
  renderEditor: ConversationProps["renderEditor"];
  onOpenContextMenu: ConversationProps["onOpenContextMenu"];
  controls: ConversationControls;
  onMessageElementChange: ConversationProps["onMessageElementChange"];
}): React.ReactElement {
  const isUser = message.role === "user";
  const isPromptEnhancement = message.presentation === "prompt-enhancement";
  const insights = isPromptEnhancement ? undefined : renderInsights?.(message);
  const originalExpanded = controls.expandedOriginalPromptIds.has(message.id);
  const editing = controls.editingMessageId === message.id;
  const original = isUser
    ? getOriginalPromptContent(message.content, message.originalPrompt)
    : null;
  const originalId = `original-prompt-${message.id}`;
  return (
    <article
      ref={(element) => onMessageElementChange?.(message.id, element)}
      className="m-product-message"
      data-message-id={message.id}
      data-navigation-target={
        controls.selectedMessageId === message.id || undefined
      }
      data-role={isUser ? "user" : "agent"}
    >
      <div className="m-product-message-avatar" aria-hidden="true">
        {isUser ? <User /> : <Bot />}
      </div>
      <div className="m-product-message-body">
        <div className="m-product-message-meta">
          <span>{isUser ? "You" : "Machdoch"}</span>
          {message.createdAt !== undefined ? (
            <time dateTime={formatTimestampDateTime(message.createdAt)}>
              {formatRelativeTime(message.createdAt)}
            </time>
          ) : null}
        </div>
        {message.content || isPromptEnhancement ? (
          <div
            className="m-product-message-bubble"
            style={
              original
                ? { position: "relative", paddingRight: "3.5rem" }
                : undefined
            }
            onContextMenu={(event) => onOpenContextMenu(event, message)}
          >
            {original && !editing ? (
              <OriginalPromptToggle
                expanded={originalExpanded}
                panelId={originalId}
                onToggle={() => controls.toggleOriginalPrompt(message.id)}
              />
            ) : null}
            {editing
              ? renderEditor(message, controls.cancelEditing)
              : message.content
                ? renderContent(
                    message.content,
                    "m-product-message-content",
                    message,
                  )
                : null}
            {isPromptEnhancement ? (
              <PromptEnhancementIndicator
                disabled={pending}
                {...(message.taskId
                  ? {
                      onCancel: () =>
                        void onCommand({
                          kind: "cancel-prompt-enhancement",
                          taskId: message.taskId!,
                        }),
                    }
                  : {})}
              />
            ) : null}
          </div>
        ) : null}
        {original && originalExpanded && !editing ? (
          <OriginalPromptPanel id={originalId}>
            {renderContent(original, undefined, message)}
          </OriginalPromptPanel>
        ) : null}
        {renderAttachments(message.attachments, isUser, message)}
        {!isPromptEnhancement ? renderActivity?.(message) : null}
        {insights}
        <MessageActions
          showTaskActions={insights === undefined}
          message={message}
          sessionId={sessionId}
          pending={pending}
          onCommand={onCommand}
          onEdit={() => controls.startEditing(message.id)}
        />
      </div>
    </article>
  );
}
