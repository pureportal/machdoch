import { ListOrdered, LoaderCircle } from "lucide-react";
import type { JSX } from "react";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type { QueuedMessagePanelMessage } from "./queued-messages-panel";

const getNextMessageTitle = (message: QueuedMessagePanelMessage): string =>
  message.content
    .split("\n")
    .map((line) => line.replace(/^[#>\s*-]+/u, "").trim())
    .find(Boolean) ?? "";

export interface QueueStatusButtonProps {
  messages: readonly QueuedMessagePanelMessage[];
  onClick: () => void;
}

/** Summarises the queue in one line and opens it for editing. */
export const QueueStatusButton = ({
  messages,
  onClick,
}: QueueStatusButtonProps): JSX.Element => {
  const failedCount = messages.filter(
    (message) => message.status === "failed",
  ).length;
  const inProgress = messages.some(
    (message) =>
      message.status === "enhancing" || message.status === "dispatching",
  );
  const nextTitle = messages[0] ? getNextMessageTitle(messages[0]) : "";
  const countLabel = `${messages.length} queued ${messages.length === 1 ? "message" : "messages"}${
    failedCount ? `, ${failedCount} failed` : ""
  }`;

  return (
    <button
      type="button"
      aria-label={`Open queue: ${countLabel}`}
      title={nextTitle ? `Next: ${nextTitle}` : undefined}
      onClick={onClick}
      className={cn(
        "m-composer-queue-button inline-flex h-6 max-w-[min(100%,20rem)] min-w-0 shrink items-center gap-1.5 rounded-md px-1.5 text-xs text-slate-300 transition-colors hover:bg-slate-800 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40",
        failedCount > 0 && "bg-rose-400/10 text-rose-100 hover:bg-rose-400/15",
      )}
    >
      {inProgress ? (
        <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-cyan-200" />
      ) : (
        <ListOrdered className="h-3.5 w-3.5 shrink-0 text-sky-300" />
      )}
      <span className="shrink-0 font-semibold tabular-nums">
        {failedCount ? `${failedCount} failed` : messages.length}
      </span>
      {nextTitle && !failedCount ? (
        <span className="m-composer-queue-next min-w-0 truncate text-slate-500">
          {nextTitle}
        </span>
      ) : null}
    </button>
  );
};
