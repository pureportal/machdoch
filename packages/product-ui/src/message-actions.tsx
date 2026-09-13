import type { ProductMessage } from "@machdoch/fleet-protocol";
import { Check, Copy, RotateCcw, Save, Square, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ProductCommandHandler } from "./product-runtime";

export function MessageActions({
  message,
  sessionId,
  pending,
  onCommand,
}: {
  message: ProductMessage;
  sessionId: string;
  pending: boolean;
  onCommand: ProductCommandHandler;
}): React.ReactElement | null {
  const hasTaskActions = message.taskId !== undefined;
  const hasActions =
    Boolean(message.content) ||
    (hasTaskActions &&
      (message.actions.canRetry || message.actions.canContinue)) ||
    message.actions.canSaveAsContextPack ||
    message.actions.canSpeak ||
    message.actions.isSpeaking;
  if (!hasActions) return null;

  return (
    <div className="m-product-message-actions">
      {message.content ? <CopyMessage content={message.content} /> : null}
      {message.actions.canRetry && message.taskId ? (
        <button
          type="button"
          disabled={pending}
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
          disabled={pending}
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
          disabled={pending}
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
          disabled={pending}
          onClick={() => void onCommand({ kind: "stop-speaking" })}
        >
          <Square aria-hidden="true" />
          Stop
        </button>
      ) : message.actions.canSpeak ? (
        <button
          type="button"
          disabled={pending}
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

function CopyMessage({ content }: { content: string }): React.ReactElement {
  const [state, setState] = useState<"idle" | "copying" | "copied" | "failed">(
    "idle",
  );
  const attempt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setState("idle");
    return () => {
      attempt.current += 1;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [content]);
  const copy = async (): Promise<void> => {
    const currentAttempt = ++attempt.current;
    if (timer.current !== null) clearTimeout(timer.current);
    setState("copying");
    try {
      await navigator.clipboard.writeText(content);
      if (attempt.current !== currentAttempt) return;
      setState("copied");
      timer.current = setTimeout(() => setState("idle"), 1_500);
    } catch {
      if (attempt.current === currentAttempt) setState("failed");
    }
  };
  return (
    <>
      <button
        type="button"
        aria-label={state === "copied" ? "Copied message" : "Copy message"}
        disabled={state === "copying"}
        onClick={() => void copy()}
      >
        {state === "copied" ? (
          <Check aria-hidden="true" />
        ) : (
          <Copy aria-hidden="true" />
        )}
        <span aria-live="polite">{state === "copied" ? "Copied" : "Copy"}</span>
      </button>
      {state === "failed" ? (
        <p className="m-product-inline-error m-product-copy-error" role="alert">
          Could not copy. Try again or select the message to copy it.
        </p>
      ) : null}
    </>
  );
}
