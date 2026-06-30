import {
  ArrowDown,
  ArrowUp,
  GripVertical,
  ListOrdered,
  X,
} from "lucide-react";
import {
  useState,
  type DragEvent,
  type JSX,
} from "react";
import type { ChatSessionContextAttachment } from "../../chat-session.model";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";
import type { AttachmentSelectionKind } from "../_helpers/session-context-attachments";
import {
  ContextAttachmentMenuButton,
  ContextAttachmentsList,
} from "./context-attachments";

const QUEUED_MESSAGE_DRAG_TYPE = "application/x-machdoch-queued-message";

export interface QueuedMessagePanelMessage {
  id: string;
  content: string;
  attachments: ChatSessionContextAttachment[];
  createdAt: number;
}

export interface QueuedMessagesPanelProps {
  messages: QueuedMessagePanelMessage[];
  imageInputDisabled: boolean;
  imageInputDisabledReason: string | null;
  onOpenAttachment?: (attachment: ChatSessionContextAttachment) => void;
  onMessageChange?: (messageId: string, content: string) => void;
  onMessageMove?: (messageId: string, direction: -1 | 1) => void;
  onMessageReorder?: (messageId: string, targetIndex: number) => void;
  onMessageRemove?: (messageId: string) => void;
  onMessageSelectAttachments?: (
    messageId: string,
    selectionKind: AttachmentSelectionKind,
  ) => Promise<void>;
  onMessageRemoveAttachment?: (
    messageId: string,
    attachmentId: string,
  ) => void;
  onMessageClearAttachments?: (messageId: string) => void;
}

const getQueuePositionLabel = (index: number): string =>
  index === 0 ? "Next" : "Later";

const getDragMessageId = (
  event: DragEvent,
  draggingMessageId: string | null,
): string => {
  const droppedId = event.dataTransfer.getData(QUEUED_MESSAGE_DRAG_TYPE);
  const fallbackId = event.dataTransfer.getData("text/plain");

  return droppedId || draggingMessageId || fallbackId;
};

export const QueuedMessagesPanel = ({
  messages,
  imageInputDisabled,
  imageInputDisabledReason,
  onOpenAttachment,
  onMessageChange,
  onMessageMove,
  onMessageReorder,
  onMessageRemove,
  onMessageSelectAttachments,
  onMessageRemoveAttachment,
  onMessageClearAttachments,
}: QueuedMessagesPanelProps): JSX.Element | null => {
  const [draggingMessageId, setDraggingMessageId] = useState<string | null>(
    null,
  );
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  if (messages.length === 0) {
    return null;
  }

  const canReorder = messages.length > 1;

  return (
    <section
      aria-label="Queued messages"
      className="app-composer-queued-messages rounded-xl border border-slate-800/80 bg-slate-900/30 p-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-2">
        <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-slate-300">
          <ListOrdered className="h-3.5 w-3.5 shrink-0 text-sky-300" />
          <span>Execution queue</span>
          <span className="rounded-full bg-slate-800 px-1.5 py-0.5 text-[11px] leading-none text-slate-400">
            {messages.length}
          </span>
        </div>
        <span className="rounded-full border border-slate-800 bg-slate-950/60 px-2 py-0.5 text-[11px] text-slate-400">
          Top to bottom
        </span>
      </div>

      <ol className="max-h-64 space-y-1.5 overflow-y-auto pr-1 [scrollbar-gutter:stable] [scrollbar-width:thin]">
        {messages.map((message, index) => {
          const isDragging = draggingMessageId === message.id;
          const isDragTarget = dragOverIndex === index && !isDragging;

          return (
            <li
              key={message.id}
              aria-label={`Queued message ${index + 1} of ${messages.length}`}
              onDragEnter={() => {
                if (draggingMessageId && draggingMessageId !== message.id) {
                  setDragOverIndex(index);
                }
              }}
              onDragOver={(event) => {
                if (!draggingMessageId || draggingMessageId === message.id) {
                  return;
                }

                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDragOverIndex(index);
              }}
              onDrop={(event) => {
                event.preventDefault();
                const droppedMessageId = getDragMessageId(
                  event,
                  draggingMessageId,
                );
                setDragOverIndex(null);
                setDraggingMessageId(null);

                if (!droppedMessageId || droppedMessageId === message.id) {
                  return;
                }

                onMessageReorder?.(droppedMessageId, index);
              }}
              className={cn(
                "grid gap-2 rounded-lg border border-slate-800/75 bg-slate-950/45 p-2 transition-colors sm:grid-cols-[auto_minmax(0,1fr)_auto]",
                isDragging && "border-sky-400/40 bg-sky-400/10 opacity-70",
                isDragTarget && "border-sky-300/60 bg-sky-400/10",
              )}
            >
              <div className="flex items-start gap-2 sm:block">
                <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-slate-800 bg-slate-950/80 text-xs font-semibold text-slate-300">
                  {index + 1}
                </span>
                <span
                  className={cn(
                    "inline-flex h-7 items-center rounded-full border px-2 text-[11px] font-medium sm:mt-1",
                    index === 0
                      ? "border-sky-400/30 bg-sky-400/10 text-sky-100"
                      : "border-slate-800 bg-slate-950/70 text-slate-400",
                  )}
                >
                  {getQueuePositionLabel(index)}
                </span>
              </div>

              <div className="grid min-w-0 gap-2">
                <Textarea
                  aria-label={`Queued message ${index + 1}`}
                  value={message.content}
                  onChange={(event) =>
                    onMessageChange?.(message.id, event.target.value)
                  }
                  className="max-h-20 min-h-9 resize-none border-slate-800 bg-slate-950/70 px-3 py-2 text-sm leading-5 text-slate-100 shadow-none placeholder:text-slate-500 focus-visible:ring-1 focus-visible:ring-sky-500"
                />

                <div className="flex min-w-0 items-start gap-2 rounded-lg border border-slate-800/60 bg-slate-950/35 p-1.5">
                  <ContextAttachmentMenuButton
                    onSelectFiles={() =>
                      onMessageSelectAttachments?.(message.id, "files") ??
                      Promise.resolve()
                    }
                    onSelectFolders={() =>
                      onMessageSelectAttachments?.(message.id, "folders") ??
                      Promise.resolve()
                    }
                    onSelectImages={() =>
                      onMessageSelectAttachments?.(message.id, "images") ??
                      Promise.resolve()
                    }
                    buttonLabel={`Add attachments to queued message ${index + 1}`}
                    buttonTitle="Add attachments"
                    imageInputDisabled={imageInputDisabled}
                    imageInputDisabledReason={imageInputDisabledReason}
                    className="h-7 w-7 rounded-md border-slate-800 bg-slate-950/70 text-slate-400 shadow-none hover:bg-slate-800 hover:text-slate-100"
                    iconClassName="h-3.5 w-3.5"
                    menuSide="top"
                  />

                  {message.attachments.length > 0 ? (
                    <div className="min-w-0 flex-1">
                      <ContextAttachmentsList
                        attachments={message.attachments}
                        onOpen={onOpenAttachment}
                        onRemove={(attachmentId) =>
                          onMessageRemoveAttachment?.(message.id, attachmentId)
                        }
                        onClearAll={() =>
                          onMessageClearAttachments?.(message.id)
                        }
                        clearAllLabel={`Remove all attachments from queued message ${
                          index + 1
                        }`}
                        compact
                      />
                    </div>
                  ) : (
                    <div className="flex min-h-7 min-w-0 flex-1 items-center px-1 text-[11px] text-slate-500">
                      No attachments
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1 sm:flex-col sm:justify-start">
                <button
                  type="button"
                  draggable={canReorder}
                  aria-label={`Drag queued message ${index + 1} to reorder`}
                  title="Drag to reorder"
                  onDragStart={(event) => {
                    if (!canReorder) {
                      event.preventDefault();
                      return;
                    }

                    setDraggingMessageId(message.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData(
                      QUEUED_MESSAGE_DRAG_TYPE,
                      message.id,
                    );
                    event.dataTransfer.setData("text/plain", message.id);
                  }}
                  onDragEnd={() => {
                    setDraggingMessageId(null);
                    setDragOverIndex(null);
                  }}
                  className={cn(
                    "inline-flex h-6 w-6 items-center justify-center rounded-md border border-slate-800 bg-slate-950/70 text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40",
                    canReorder
                      ? "cursor-grab hover:bg-slate-800 hover:text-slate-100 active:cursor-grabbing"
                      : "cursor-not-allowed opacity-50",
                  )}
                >
                  <GripVertical className="h-3 w-3" />
                </button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-xs"
                  aria-label={`Move queued message ${index + 1} up`}
                  title="Move up"
                  disabled={index === 0}
                  onClick={() => onMessageMove?.(message.id, -1)}
                  className="border-slate-800 bg-slate-950/70 text-slate-400 hover:bg-slate-800 hover:text-slate-100 disabled:bg-slate-950/40 disabled:text-slate-700"
                >
                  <ArrowUp className="h-3 w-3" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-xs"
                  aria-label={`Move queued message ${index + 1} down`}
                  title="Move down"
                  disabled={index === messages.length - 1}
                  onClick={() => onMessageMove?.(message.id, 1)}
                  className="border-slate-800 bg-slate-950/70 text-slate-400 hover:bg-slate-800 hover:text-slate-100 disabled:bg-slate-950/40 disabled:text-slate-700"
                >
                  <ArrowDown className="h-3 w-3" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-xs"
                  aria-label={`Remove queued message ${index + 1}`}
                  title="Remove"
                  onClick={() => onMessageRemove?.(message.id)}
                  className="border-rose-500/20 bg-rose-500/10 text-rose-100 hover:bg-rose-500/15 hover:text-white"
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
};
