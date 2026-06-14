import {
  FileText,
  FolderOpen,
  Image,
  Link,
  Plus,
  X,
  type LucideIcon,
} from "lucide-react";
import type { JSX } from "react";
import type { ChatSessionContextAttachment } from "../../chat-session.model";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { cn } from "../../lib/utils";

const getAttachmentIcon = (
  attachment: ChatSessionContextAttachment,
): LucideIcon => {
  switch (attachment.kind) {
    case "file":
      return FileText;
    case "image":
      return Image;
    case "directory":
      return FolderOpen;
    case "other":
    default:
      return Link;
  }
};

const getAttachmentKindLabel = (
  attachment: ChatSessionContextAttachment,
): string => {
  switch (attachment.kind) {
    case "directory":
      return "folder";
    case "file":
      return "file";
    case "image":
      return "image";
    case "other":
    default:
      return "path";
  }
};

const shouldShowAttachmentKindLabel = (
  attachment: ChatSessionContextAttachment,
): boolean => attachment.kind !== "image";

export const formatContextAttachmentKind = (
  attachment: ChatSessionContextAttachment,
): string => getAttachmentKindLabel(attachment);

export interface ContextAttachmentMenuButtonProps {
  onSelectFiles: () => Promise<void>;
  onSelectFolders: () => Promise<void>;
  onSelectImages: () => Promise<void>;
  buttonLabel?: string;
  buttonTitle?: string;
  imageInputDisabled?: boolean;
  imageInputDisabledReason?: string | null;
  className?: string;
  iconClassName?: string;
  menuSide?: "top" | "right" | "bottom" | "left";
}

export const ContextAttachmentMenuButton = ({
  onSelectFiles,
  onSelectFolders,
  onSelectImages,
  buttonLabel = "Add context",
  buttonTitle = "Add context",
  imageInputDisabled = false,
  imageInputDisabledReason,
  className,
  iconClassName,
  menuSide = "bottom",
}: ContextAttachmentMenuButtonProps): JSX.Element => {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={buttonLabel}
          title={buttonTitle}
          className={className}
        >
          <Plus className={iconClassName} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side={menuSide}
        className="min-w-36 rounded-xl border-slate-800 bg-slate-950 p-1 text-slate-200 shadow-xl shadow-black/30"
      >
        <DropdownMenuItem
          disabled={imageInputDisabled}
          title={imageInputDisabledReason ?? "Attach images"}
          onSelect={() => {
            if (!imageInputDisabled) {
              void onSelectImages();
            }
          }}
          className="rounded-lg text-xs text-sky-100 focus:bg-sky-500/10 focus:text-sky-50 disabled:text-slate-600"
        >
          <Image className="h-3.5 w-3.5 text-sky-300" />
          Images
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            void onSelectFiles();
          }}
          className="rounded-lg text-xs focus:bg-slate-900 focus:text-slate-100"
        >
          <FileText className="h-3.5 w-3.5 text-slate-400" />
          Files
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            void onSelectFolders();
          }}
          className="rounded-lg text-xs focus:bg-slate-900 focus:text-slate-100"
        >
          <FolderOpen className="h-3.5 w-3.5 text-slate-400" />
          Folders
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export interface ContextAttachmentsListProps {
  attachments: ChatSessionContextAttachment[];
  onRemove: (attachmentId: string) => void;
  onClearAll: () => void;
  compact?: boolean;
}

export const ContextAttachmentsList = ({
  attachments,
  onRemove,
  onClearAll,
  compact = false,
}: ContextAttachmentsListProps): JSX.Element | null => {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "app-context-attachments-list grid gap-1.5",
        compact ? "gap-1" : "gap-1.5",
      )}
    >
      <div className="flex justify-end px-0.5">
        <button
          type="button"
          aria-label="Remove all attached context"
          title="Remove all attached context"
          onClick={onClearAll}
          className={cn(
          "app-context-attachments-clear inline-flex items-center gap-1 rounded-full border border-slate-800 bg-slate-950/70 text-slate-500 hover:border-rose-500/25 hover:bg-rose-500/10 hover:text-rose-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/30",
            compact ? "h-6 px-2 text-[11px]" : "h-7 px-2.5 text-xs",
          )}
        >
          <X className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
          Clear all
        </button>
      </div>

      <ul
        aria-label="Attached context"
        className={cn(
          "app-context-attachments-items flex flex-wrap content-start items-start gap-1.5 overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable] [scrollbar-width:thin]",
          compact ? "max-h-20 px-0.5" : "max-h-32 px-1",
        )}
      >
        {attachments.map((attachment) => {
          const Icon = getAttachmentIcon(attachment);
          const kindLabel = getAttachmentKindLabel(attachment);

          return (
            <li
              key={attachment.id}
              className={cn(
                "app-context-attachment-item flex max-w-full items-center gap-1.5 rounded-full border border-slate-800 bg-slate-900/80 text-slate-200",
                attachment.kind === "image" &&
                  "border-sky-400/30 bg-sky-400/10 text-sky-50",
                compact ? "h-7 px-2 text-[11px]" : "h-8 px-2.5 text-xs",
              )}
              title={attachment.path}
            >
              <Icon
                className={cn(
                  "shrink-0 text-sky-300",
                  attachment.kind === "image" && "text-sky-200",
                  compact ? "h-3 w-3" : "h-3.5 w-3.5",
                )}
              />
              <span className="min-w-0 max-w-48 truncate">
                {attachment.name}
              </span>
              <span className="shrink-0 text-slate-500">{kindLabel}</span>
              <button
                type="button"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => onRemove(attachment.id)}
                className={cn(
                  "ml-0.5 flex shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-800 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40",
                  compact ? "h-4 w-4" : "h-5 w-5",
                )}
              >
                <X className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export interface MessageAttachmentsListProps {
  attachments: ChatSessionContextAttachment[];
  onOpen?: (attachment: ChatSessionContextAttachment) => void;
  align?: "start" | "end";
}

export const MessageAttachmentsList = ({
  attachments,
  onOpen,
  align = "start",
}: MessageAttachmentsListProps): JSX.Element | null => {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "app-message-attachments flex max-w-[90%] min-w-0 flex-col gap-1.5",
        align === "end" ? "items-end" : "items-start",
      )}
    >
      <ul
        aria-label="Attached files"
        className={cn(
          "flex max-w-full flex-wrap gap-1.5",
          align === "end" && "justify-end",
        )}
      >
        {attachments.map((attachment) => {
          const Icon = getAttachmentIcon(attachment);
          const kindLabel = getAttachmentKindLabel(attachment);

          return (
            <li key={attachment.id} className="max-w-full">
              <button
                type="button"
                aria-label={`Open ${attachment.name} preview`}
                title={`Open preview: ${attachment.path}`}
                disabled={!onOpen}
                onClick={() => onOpen?.(attachment)}
                className={cn(
                  "app-message-attachment-button inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border border-slate-800 bg-slate-950/70 px-3 text-xs text-slate-300 shadow-sm shadow-slate-950/20 transition-colors hover:bg-slate-900 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/35 disabled:cursor-default disabled:opacity-70",
                  attachment.kind === "image" &&
                    "border-sky-400/30 bg-sky-400/10 text-sky-50 hover:bg-sky-400/15",
                )}
              >
                <Icon
                  className={cn(
                    "h-3.5 w-3.5 shrink-0 text-sky-300",
                    attachment.kind === "image" && "text-sky-200",
                  )}
                />
                <span className="min-w-0 max-w-48 truncate">
                  {attachment.name}
                </span>
                {shouldShowAttachmentKindLabel(attachment) ? (
                  <span className="shrink-0 text-slate-500">{kindLabel}</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
