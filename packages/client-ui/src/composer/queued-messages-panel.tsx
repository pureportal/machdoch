import {
  ArrowDown,
  ArrowUp,
  GripVertical,
  LoaderCircle,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useState, type ClipboardEvent, type DragEvent, type JSX } from "react";
import type {
  ChatSessionContextAttachment,
  ChatSessionRequestIteration,
} from "./model";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { SubmitShortcut } from "@machdoch/media-studio/tauri/ui/components/ui/submit-shortcut.js";
import { Textarea } from "@machdoch/media-studio/tauri/ui/components/ui/textarea.js";
import { ControlTooltip } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import { getClipboardImageFiles } from "./clipboard-image-files";
import type { AttachmentSelectionKind } from "./model";
import {
  findQueuedMessageBlockIndex,
  getQueuedMessageBlocks,
} from "./queued-message-blocks";
import {
  ContextAttachmentMenuButton,
  ContextAttachmentsList,
} from "./context-attachments";

const QUEUED_MESSAGE_DRAG_TYPE = "application/x-machdoch-queued-message";
const QUEUE_ICON_BUTTON_CLASS_NAME =
  "h-7 w-7 rounded-md border-transparent bg-transparent text-slate-400 shadow-none hover:bg-slate-800 hover:text-slate-100 disabled:bg-transparent disabled:text-slate-700";

export interface QueuedMessagePanelMessage {
  id: string;
  content: string;
  iteration?: ChatSessionRequestIteration;
  waitingForIteration?: number;
  attachments: ChatSessionContextAttachment[];
  promptEnhancementMode?: "simple" | "web-search";
  status: "queued" | "enhancing" | "dispatching" | "failed";
  failureMessage?: string;
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
  onMessageRetry?: (messageId: string) => void;
  onMessageSelectAttachments?: (
    messageId: string,
    selectionKind: AttachmentSelectionKind,
  ) => Promise<void>;
  onMessagePasteImages?: (messageId: string, files: File[]) => Promise<void>;
  onMessageRemoveAttachment?: (messageId: string, attachmentId: string) => void;
  onMessageClearAttachments?: (messageId: string) => void;
}

const getQueueStateLabel = (
  status: QueuedMessagePanelMessage["status"],
  index: number,
): string | null => {
  const statusLabel =
    status === "enhancing"
      ? "Enhancing"
      : status === "dispatching"
        ? "Dispatching"
        : status === "failed"
          ? "Failed"
          : null;

  if (index === 0 && status !== "failed") {
    return statusLabel ? `Next · ${statusLabel}` : "Next";
  }

  return statusLabel;
};

const getQueueStateClassName = (
  status: QueuedMessagePanelMessage["status"],
  index: number,
): string => {
  if (status === "enhancing" || status === "dispatching") {
    return "bg-cyan-400/10 text-cyan-100";
  }

  if (status === "failed") {
    return "bg-rose-400/10 text-rose-100";
  }

  return index === 0
    ? "bg-sky-400/10 text-sky-100"
    : "bg-slate-800/70 text-slate-400";
};

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
  onMessageRetry,
  onMessageSelectAttachments,
  onMessagePasteImages,
  onMessageRemoveAttachment,
  onMessageClearAttachments,
}: QueuedMessagesPanelProps): JSX.Element | null => {
  const [draggingMessageId, setDraggingMessageId] = useState<string | null>(
    null,
  );
  const [dragOverBlockIndex, setDragOverBlockIndex] = useState<number | null>(
    null,
  );

  if (messages.length === 0) {
    return null;
  }

  const handleMessagePaste = (
    event: ClipboardEvent<HTMLTextAreaElement>,
    messageId: string,
  ): void => {
    if (!onMessagePasteImages) {
      return;
    }

    const imageFiles = getClipboardImageFiles(event.clipboardData);

    if (imageFiles.length === 0) {
      return;
    }

    event.preventDefault();

    if (imageInputDisabled) {
      console.error(imageInputDisabledReason ?? "Image input is unavailable.");
      return;
    }

    void onMessagePasteImages(messageId, imageFiles).catch((error) => {
      console.error("Failed to attach pasted image to queued message", error);
    });
  };

  const hasMessageInProgress = messages.some(
    (message) =>
      message.status === "enhancing" || message.status === "dispatching",
  );
  const blocks = getQueuedMessageBlocks(messages);
  const showReorderControls = blocks.length > 1;
  const canReorder = showReorderControls && !hasMessageInProgress;
  const draggingBlockIndex = findQueuedMessageBlockIndex(
    blocks,
    draggingMessageId,
  );

  return (
    <section
      aria-label="Queued messages"
      className="app-composer-queued-messages min-w-0"
    >
      <ol className="m-0 grid list-none gap-2 p-0">
        {messages.map((message, index) => {
          const blockIndex = findQueuedMessageBlockIndex(blocks, message.id);
          const isDragging = draggingBlockIndex === blockIndex;
          const isDragTarget = dragOverBlockIndex === blockIndex && !isDragging;
          const isInProgress =
            message.status === "enhancing" || message.status === "dispatching";
          const stateLabel = message.waitingForIteration
            ? `Waiting for iteration ${message.waitingForIteration}`
            : getQueueStateLabel(message.status, index);

          return (
            <SubmitShortcut key={message.id} asChild>
              <li
                aria-label={`Queued message ${index + 1} of ${messages.length}`}
                onDragEnter={() => {
                  if (draggingMessageId) {
                    setDragOverBlockIndex(isDragging ? null : blockIndex);
                  }
                }}
                onDragOver={(event) => {
                  if (!draggingMessageId || isDragging) {
                    return;
                  }

                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDragOverBlockIndex(blockIndex);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const droppedMessageId = getDragMessageId(
                    event,
                    draggingMessageId,
                  );
                  setDragOverBlockIndex(null);
                  setDraggingMessageId(null);

                  if (!droppedMessageId || droppedMessageId === message.id) {
                    return;
                  }

                  onMessageReorder?.(droppedMessageId, index);
                }}
                className={cn(
                  "min-w-0 rounded-xl border border-slate-800/80 bg-slate-950/40 transition-colors",
                  isDragging && "border-sky-400/40 bg-sky-400/10 opacity-70",
                  isDragTarget && "border-sky-300/60 bg-sky-400/10",
                  message.status === "failed" &&
                    "border-rose-400/30 bg-rose-400/5",
                  isInProgress && "border-cyan-400/30 bg-cyan-400/5",
                )}
              >
                <div className="flex min-h-9 min-w-0 items-center gap-2 py-1 pr-1 pl-2">
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
                    {showReorderControls ? (
                      <ControlTooltip content="Drag to reorder">
                        <button
                          type="button"
                          draggable={canReorder}
                          disabled={!canReorder}
                          aria-label={`Drag queued message ${index + 1} to reorder`}
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
                            event.dataTransfer.setData(
                              "text/plain",
                              message.id,
                            );
                          }}
                          onDragEnd={() => {
                            setDraggingMessageId(null);
                            setDragOverBlockIndex(null);
                          }}
                          className={cn(
                            "inline-flex h-6 w-4 shrink-0 items-center justify-center rounded text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40",
                            canReorder
                              ? "cursor-grab hover:text-slate-100 active:cursor-grabbing"
                              : "cursor-not-allowed opacity-40",
                          )}
                        >
                          <GripVertical className="h-3.5 w-3.5" />
                        </button>
                      </ControlTooltip>
                    ) : null}
                    <span className="min-w-4 shrink-0 text-center text-xs font-semibold tabular-nums text-slate-400">
                      {index + 1}
                    </span>
                    {stateLabel ? (
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full px-2 text-[11px] leading-5 font-medium",
                          getQueueStateClassName(message.status, index),
                        )}
                      >
                        {isInProgress ? (
                          <LoaderCircle className="h-3 w-3 animate-spin" />
                        ) : null}
                        {stateLabel}
                      </span>
                    ) : null}
                    {message.iteration ? (
                      <span className="text-[11px] leading-5 font-medium text-sky-200">
                        Iteration {message.iteration.index} of{" "}
                        {message.iteration.total}
                      </span>
                    ) : null}
                    {message.promptEnhancementMode ? (
                      <span className="rounded-full bg-violet-400/10 px-2 text-[11px] leading-5 font-medium text-violet-100">
                        {message.promptEnhancementMode === "web-search"
                          ? "Web enhance"
                          : "Enhance"}
                      </span>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 items-center gap-0.5">
                    {message.status === "failed" ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        aria-label={`Retry queued message ${index + 1}`}
                        onClick={() => onMessageRetry?.(message.id)}
                        className="mr-1 h-7 gap-1 rounded-md border-rose-400/30 bg-transparent px-2 text-[11px] text-rose-100 shadow-none hover:bg-rose-400/15 hover:text-white"
                      >
                        <RotateCcw className="h-3 w-3" />
                        Retry
                      </Button>
                    ) : null}
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
                      disabled={isInProgress}
                      imageInputDisabled={imageInputDisabled}
                      imageInputDisabledReason={imageInputDisabledReason}
                      className={QUEUE_ICON_BUTTON_CLASS_NAME}
                      iconClassName="h-3.5 w-3.5"
                      menuSide="bottom"
                    />
                    {showReorderControls ? (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon-xs"
                          aria-label={`Move queued message ${index + 1} up`}
                          tooltip="Move up"
                          disabled={!canReorder || blockIndex === 0}
                          onClick={() => onMessageMove?.(message.id, -1)}
                          className={QUEUE_ICON_BUTTON_CLASS_NAME}
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon-xs"
                          aria-label={`Move queued message ${index + 1} down`}
                          tooltip="Move down"
                          disabled={
                            !canReorder || blockIndex === blocks.length - 1
                          }
                          onClick={() => onMessageMove?.(message.id, 1)}
                          className={QUEUE_ICON_BUTTON_CLASS_NAME}
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-xs"
                      aria-label={`Remove queued message ${index + 1}`}
                      tooltip="Remove"
                      disabled={isInProgress}
                      onClick={() => onMessageRemove?.(message.id)}
                      className={cn(
                        QUEUE_ICON_BUTTON_CLASS_NAME,
                        "hover:bg-rose-500/15 hover:text-rose-100",
                      )}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                <div className="grid min-w-0 gap-2 px-2 pb-2">
                  <Textarea
                    aria-label={`Queued message ${index + 1}`}
                    value={message.content}
                    disabled={isInProgress}
                    onChange={(event) =>
                      onMessageChange?.(message.id, event.target.value)
                    }
                    onPaste={(event) => handleMessagePaste(event, message.id)}
                    className="max-h-56 min-h-8 resize-none overflow-y-auto rounded-lg border-transparent bg-slate-900/50 px-2.5 py-1.5 text-[13px] leading-5 text-slate-100 shadow-none placeholder:text-slate-500 focus-visible:border-slate-700 focus-visible:ring-1 focus-visible:ring-sky-500 md:text-[13px]"
                  />

                  {message.status === "failed" && message.failureMessage ? (
                    <p className="m-0 text-xs leading-4 text-rose-200">
                      {message.failureMessage}
                    </p>
                  ) : null}

                  {message.attachments.length > 0 ? (
                    <ContextAttachmentsList
                      attachments={message.attachments}
                      onOpen={onOpenAttachment}
                      onRemove={(attachmentId) =>
                        onMessageRemoveAttachment?.(message.id, attachmentId)
                      }
                      onClearAll={() => onMessageClearAttachments?.(message.id)}
                      clearAllLabel={`Remove all attachments from queued message ${
                        index + 1
                      }`}
                      compact
                      disabled={isInProgress}
                    />
                  ) : null}
                </div>
              </li>
            </SubmitShortcut>
          );
        })}
      </ol>
    </section>
  );
};
