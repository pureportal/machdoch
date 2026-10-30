"use client";

import Link from "next/link";
import { MarkdownContent } from "@machdoch/client-ui/conversation/markdown-content";
import {
  chatErrorMessages,
  type CloudChatTurn,
} from "@/lib/cloud-chat-contract";
import { Button } from "@/components/ui/button";

const answerComponents = {
  img: ({ alt }: { alt?: string }) => <span>{alt}</span>,
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) =>
    href?.startsWith("/cloud/") ? (
      <Link className="app-markdown-link" href={href}>
        {children}
      </Link>
    ) : (
      <a
        className="app-markdown-link"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    ),
};

export function ChatMessages({
  turns,
  writable,
  pending,
  onCancel,
  onRetry,
}: {
  turns: CloudChatTurn[];
  writable: boolean;
  pending: boolean;
  onCancel: (turn: CloudChatTurn) => void;
  onRetry: (turn: CloudChatTurn) => void;
}) {
  const latest = turns.at(-1)?.id;
  return (
    <ol className="cloud-chat-messages" aria-label="Conversation messages">
      {turns.map((turn) => (
        <li key={turn.id}>
          <article className="cloud-chat-user">
            <h2>You</h2>
            <p>{turn.prompt}</p>
          </article>
          <article className="cloud-chat-answer">
            <header>
              <h2>{turn.model}</h2>
              {["queued", "running", "cancel_requested"].includes(
                turn.state,
              ) && (
                <span role="status">
                  {turn.state === "queued"
                    ? "Queued"
                    : turn.state === "cancel_requested"
                      ? "Stopping…"
                      : "Responding…"}
                </span>
              )}
            </header>
            {turn.answer && (
              <MarkdownContent
                content={turn.answer}
                components={answerComponents}
              />
            )}
            {turn.errorCode && (
              <p className="cloud-error" role="status">
                {chatErrorMessages[turn.errorCode] ??
                  "The response could not be completed."}
              </p>
            )}
            {turn.state === "canceled" && !turn.errorCode && (
              <p className="text-muted-foreground">Response stopped</p>
            )}
            {writable && (
              <div className="cloud-editor-actions">
                {["queued", "running"].includes(turn.state) && (
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => onCancel(turn)}
                  >
                    Stop response
                  </Button>
                )}
                {turn.id === latest &&
                  ["failed", "canceled", "unknown"].includes(turn.state) && (
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() => onRetry(turn)}
                    >
                      Retry response
                    </Button>
                  )}
              </div>
            )}
          </article>
        </li>
      ))}
    </ol>
  );
}
