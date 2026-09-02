import type { ProductMessage } from "@machdoch/fleet-protocol";
import {
  Activity,
  Bot,
  ChevronDown,
  LoaderCircle,
  RotateCcw,
  Save,
  Square,
  User,
  Volume2,
  WandSparkles,
} from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { formatRelativeTime, formatTimestampDateTime } from "./format";
import { ProductMarkdown } from "./markdown";
import { PromptEnhancementIndicator } from "./prompt-enhancement";
import type { ProductCommandHandler } from "./product-runtime";

export function Conversation({
  messages,
  sessionId,
  onCommand,
}: {
  messages: ProductMessage[];
  sessionId: string;
  onCommand: ProductCommandHandler;
}): React.ReactElement {
  const conversationRef = useRef<HTMLDivElement>(null);
  const followingNewestRef = useRef(true);
  const previousSessionIdRef = useRef(sessionId);

  useLayoutEffect(() => {
    const conversation = conversationRef.current;
    if (!conversation) return;
    if (previousSessionIdRef.current !== sessionId) {
      previousSessionIdRef.current = sessionId;
      followingNewestRef.current = true;
    }
    if (followingNewestRef.current) {
      conversation.scrollTop = conversation.scrollHeight;
    }
  }, [messages, sessionId]);

  return (
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
            onCommand={onCommand}
          />
        ))
      )}
    </div>
  );
}

function Message({
  message,
  sessionId,
  onCommand,
}: {
  message: ProductMessage;
  sessionId: string;
  onCommand: ProductCommandHandler;
}): React.ReactElement {
  const isUser = message.role === "user";
  const isPromptEnhancement = message.presentation === "prompt-enhancement";
  return (
    <article
      className="m-product-message"
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
          <div className="m-product-message-bubble">
            {message.content ? (
              <ProductMarkdown
                className="m-product-message-content"
                content={message.content}
              />
            ) : null}
            {isPromptEnhancement ? (
              <PromptEnhancementIndicator
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
        {message.attachments.length > 0 ? (
          <div className="m-product-chips" aria-label="Attachments">
            {message.attachments.map((attachment) => (
              <span key={attachment.id} className="m-product-chip">
                {attachment.name}
              </span>
            ))}
          </div>
        ) : null}
        {message.source && !isPromptEnhancement ? (
          <ExecutionActivity message={message} />
        ) : null}
        <MessageActions
          message={message}
          sessionId={sessionId}
          onCommand={onCommand}
        />
      </div>
    </article>
  );
}

function ExecutionActivity({
  message,
}: {
  message: ProductMessage;
}): React.ReactElement | null {
  const source = message.source;
  if (!source) return null;
  const entries = [...source.entries, ...source.timeline].slice(-20);
  if (!entries.length && !source.summary) return null;
  const running = ["running", "executing", "starting"].includes(
    source.status ?? "",
  );
  return (
    <details className="m-product-activity" open={running}>
      <summary>
        <span className="m-product-activity-icon" data-running={running}>
          {running ? (
            <LoaderCircle aria-hidden="true" />
          ) : (
            <Activity aria-hidden="true" />
          )}
        </span>
        <strong>{source.kind === "thinking" ? "Thinking" : "Execution"}</strong>
        <span>{running ? "Running" : source.status}</span>
        <ChevronDown
          className="m-product-activity-chevron"
          aria-hidden="true"
        />
      </summary>
      <div className="m-product-activity-body">
        {entries.map((entry, index) => (
          <div
            className="m-product-activity-row"
            key={`${entry.label}-${index}`}
          >
            <span className="m-product-activity-node" data-tone={entry.tone} />
            <div>
              <strong>{entry.label}</strong>
              {entry.detail ? <p>{entry.detail}</p> : null}
            </div>
          </div>
        ))}
        {source.summary && entries.length === 0 ? (
          <p>{source.summary}</p>
        ) : null}
      </div>
    </details>
  );
}

function MessageActions({
  message,
  sessionId,
  onCommand,
}: {
  message: ProductMessage;
  sessionId: string;
  onCommand: ProductCommandHandler;
}): React.ReactElement | null {
  const hasTaskActions = message.taskId !== undefined;
  const hasActions =
    (hasTaskActions &&
      (message.actions.canRetry || message.actions.canContinue)) ||
    message.actions.canSaveAsContextPack ||
    message.actions.canSpeak ||
    message.actions.isSpeaking;
  if (!hasActions) return null;

  return (
    <div className="m-product-message-actions">
      {message.actions.canRetry && message.taskId ? (
        <button
          type="button"
          onClick={() =>
            void onCommand({ kind: "retry", taskId: message.taskId! })
          }
        >
          <RotateCcw aria-hidden="true" />
          Retry
        </button>
      ) : null}
      {message.actions.canContinue && message.taskId ? (
        <button
          type="button"
          onClick={() =>
            void onCommand({ kind: "continue", taskId: message.taskId! })
          }
        >
          Continue
        </button>
      ) : null}
      {message.actions.canSaveAsContextPack ? (
        <button
          type="button"
          onClick={() =>
            void onCommand({
              kind: "save-message-context-pack",
              sessionId,
              messageId: message.id,
            })
          }
        >
          <Save aria-hidden="true" />
          Save context
        </button>
      ) : null}
      {message.actions.isSpeaking ? (
        <button
          type="button"
          onClick={() => void onCommand({ kind: "stop-speaking" })}
        >
          <Square aria-hidden="true" />
          Stop
        </button>
      ) : message.actions.canSpeak ? (
        <button
          type="button"
          onClick={() =>
            void onCommand({
              kind: "speak-message",
              sessionId,
              messageId: message.id,
            })
          }
        >
          <Volume2 aria-hidden="true" />
          Speak
        </button>
      ) : null}
    </div>
  );
}
