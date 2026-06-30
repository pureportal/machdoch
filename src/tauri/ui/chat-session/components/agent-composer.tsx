import {
  ArrowDown,
  ArrowUp,
  CornerDownRight,
  ListOrdered,
  SendHorizonal,
  Square,
  X,
} from "lucide-react";
import type {
  ClipboardEvent,
  JSX,
  KeyboardEvent,
  ReactNode,
  Ref,
} from "react";
import type { ChatSessionContextAttachment } from "../../chat-session.model";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";
import type { RunningTaskMessageAction } from "../../lib/shell-store";
import type { RuntimeProvider } from "../../model-catalog";
import {
  ContextAttachmentMenuButton,
  ContextAttachmentsList,
} from "./context-attachments";
import { SessionModelPicker } from "./session-model-picker";
import { ToolToggleButton } from "./tool-toggle-button";

export type AgentComposerVariant = "session" | "quick";

export interface AgentComposerToggle {
  id: string;
  label: string;
  title?: string;
  description?: string;
  icon: ReactNode;
  pressed: boolean;
  disabled?: boolean;
  onPressedChange: (pressed: boolean) => void;
  activeClassName?: string;
  unavailableClassName?: string;
}

export interface AgentComposerAction {
  id: string;
  label: string;
  title?: string;
  icon: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
}

export interface AgentComposerQueuedMessage {
  id: string;
  content: string;
  attachmentCount: number;
}

export interface AgentComposerProps {
  variant: AgentComposerVariant;
  draft: string;
  textareaLabel: string;
  placeholder: string;
  chooserProviders: RuntimeProvider[];
  activeProvider: RuntimeProvider;
  activeModel: string;
  contextAttachments: ChatSessionContextAttachment[];
  imageInputSupported: boolean;
  imageInputDisabledReason: string | null;
  canSend: boolean;
  sendDisabledReason: string | null;
  isExecuting: boolean;
  textareaRef?: Ref<HTMLTextAreaElement>;
  toolbarControls?: ReactNode;
  toggles?: AgentComposerToggle[];
  actions?: AgentComposerAction[];
  statusMessage?: {
    text: string;
    tone: "success" | "error" | "info" | null;
  } | null;
  runningTaskMessageAction?: RunningTaskMessageAction;
  queuedMessages?: AgentComposerQueuedMessage[];
  onModelSelection: (provider: RuntimeProvider, model: string) => void;
  onSelectContextFiles: () => Promise<void>;
  onSelectContextFolders: () => Promise<void>;
  onSelectContextImages: () => Promise<void>;
  onPasteContextImages: (files: File[]) => Promise<void>;
  onRemoveContextAttachment: (attachmentId: string) => void;
  onClearContextAttachments: () => void;
  onDraftChange: (value: string) => void;
  onAdditionalTextareaKeyDown?: (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ) => void;
  onRunningTaskMessageActionChange?: (
    action: RunningTaskMessageAction,
  ) => void;
  onQueuedMessageChange?: (messageId: string, content: string) => void;
  onQueuedMessageMove?: (messageId: string, direction: -1 | 1) => void;
  onQueuedMessageRemove?: (messageId: string) => void;
  onSend: () => void;
  onCancel: () => void;
}

const RUNNING_TASK_MESSAGE_ACTIONS = [
  {
    id: "steer",
    label: "Steer",
    sendLabel: "Steer running task",
    icon: CornerDownRight,
  },
  {
    id: "stop-and-send",
    label: "Stop & Send",
    sendLabel: "Stop task and send message",
    icon: Square,
  },
  {
    id: "queue",
    label: "Queue",
    sendLabel: "Queue message",
    icon: ListOrdered,
  },
] as const satisfies ReadonlyArray<{
  id: RunningTaskMessageAction;
  label: string;
  sendLabel: string;
  icon: typeof SendHorizonal;
}>;

const getRunningTaskMessageActionMeta = (
  action: RunningTaskMessageAction | undefined,
) => {
  return (
    RUNNING_TASK_MESSAGE_ACTIONS.find((entry) => entry.id === action) ??
    RUNNING_TASK_MESSAGE_ACTIONS[2]
  );
};

const getVariantStyles = (variant: AgentComposerVariant) => {
  if (variant === "quick") {
    return {
      attachmentListCompact: true,
      attachmentMenuSide: "bottom" as const,
      attachmentButton:
        "h-8 w-8 rounded-full border-slate-800 bg-slate-950/70 text-slate-300 shadow-none hover:bg-slate-900 hover:text-slate-100",
      attachmentIcon: "h-3.5 w-3.5",
      textarea:
        "max-h-32 min-h-16 resize-none overflow-y-auto border-0 bg-transparent px-4 py-3 text-sm text-slate-100 shadow-none placeholder:text-slate-500 focus-visible:border-transparent focus-visible:ring-0 focus-visible:ring-offset-0 [@media(max-height:620px)]:max-h-20 [@media(max-height:620px)]:min-h-12 [@media(max-height:620px)]:py-2.5",
      iconButton:
        "h-8 w-8 rounded-full border-slate-800 bg-slate-950/70 p-0 text-slate-300 shadow-none hover:bg-slate-900 hover:text-slate-100 disabled:cursor-not-allowed disabled:border-dashed disabled:bg-slate-950/40 disabled:text-slate-600 disabled:opacity-100",
      sendButton:
        "h-8 w-8 rounded-full border-slate-800/90 bg-slate-950/70 p-0 text-slate-500 shadow-none hover:bg-slate-800 hover:text-slate-100 disabled:bg-transparent disabled:text-slate-600 disabled:opacity-100",
      sendButtonActive:
        "border-sky-400/30 bg-sky-400/15 text-sky-50 hover:bg-sky-400/20 hover:text-white",
      cancelButton:
        "h-8 w-8 rounded-full border-rose-500/25 bg-rose-500/10 p-0 text-rose-100 shadow-none hover:bg-rose-500/15 hover:text-white",
      iconClassName: "h-3.5 w-3.5",
    };
  }

  return {
    attachmentListCompact: false,
    attachmentMenuSide: "top" as const,
    attachmentButton:
      "app-composer-attachment-button h-11 w-11 shrink-0 rounded-[1.15rem] border-slate-800 bg-slate-900 text-slate-400 shadow-none hover:bg-slate-800 hover:text-slate-100",
    attachmentIcon: "h-4 w-4",
    textarea:
      "app-composer-textarea max-h-[30vh] min-h-14 resize-none overflow-y-auto rounded-[1.4rem] border-slate-800 bg-slate-900/70 px-5 py-4 text-base text-slate-100 shadow-inner shadow-black/20 placeholder:text-slate-500 focus-visible:ring-1 focus-visible:ring-sky-500 disabled:cursor-not-allowed disabled:bg-slate-900/50 disabled:text-slate-500 disabled:opacity-100",
    iconButton:
      "app-composer-icon-button h-11 w-11 shrink-0 rounded-[1.15rem] border-slate-800 bg-slate-900 text-slate-400 shadow-none hover:bg-slate-800 hover:text-slate-100 disabled:border-slate-800 disabled:bg-slate-900 disabled:text-slate-600 disabled:opacity-100",
    sendButton:
      "app-composer-send-button h-11 w-11 shrink-0 rounded-[1.15rem] border-slate-800 bg-slate-900 text-slate-400 shadow-none hover:bg-slate-800 hover:text-slate-100 disabled:border-slate-800 disabled:bg-slate-900 disabled:text-slate-600 disabled:opacity-100",
    sendButtonActive:
      "border-sky-500/20 bg-sky-500/10 text-sky-100 hover:bg-sky-500/15 hover:text-white",
    cancelButton:
      "app-composer-cancel-button h-11 w-11 shrink-0 rounded-[1.15rem] border-rose-500/20 bg-rose-500/10 text-rose-100 shadow-none hover:bg-rose-500/15 hover:text-white",
    iconClassName: "h-4 w-4",
  };
};

const renderToggle = (
  toggle: AgentComposerToggle,
  variant: AgentComposerVariant,
  iconButtonClassName: string,
): JSX.Element => {
  return (
    <ToolToggleButton
      key={toggle.id}
      label={toggle.label}
      title={toggle.title}
      description={
        variant === "session"
          ? toggle.description ?? toggle.title ?? toggle.label
          : undefined
      }
      icon={toggle.icon}
      pressed={toggle.pressed}
      disabled={toggle.disabled}
      disabledMode={variant === "quick" ? "native" : "aria"}
      onPressedChange={toggle.onPressedChange}
      baseClassName={variant === "quick" ? iconButtonClassName : undefined}
      activeClassName={toggle.activeClassName}
      disabledClassName={toggle.unavailableClassName}
      className={variant === "session" ? "app-composer-toggle-button" : undefined}
    />
  );
};

const renderAction = (
  action: AgentComposerAction,
  iconButtonClassName: string,
): JSX.Element => {
  return (
    <Button
      key={action.id}
      type="button"
      variant="outline"
      aria-label={action.label}
      title={action.title ?? action.label}
      disabled={action.disabled}
      onClick={action.onClick}
      className={cn(iconButtonClassName, action.className)}
    >
      {action.icon}
    </Button>
  );
};

const getClipboardImageFiles = (
  event: ClipboardEvent<HTMLTextAreaElement>,
): File[] => {
  const clipboardData = event.clipboardData;
  const itemFiles = Array.from(clipboardData.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .flatMap((item) => {
      const file = item.getAsFile();

      return file ? [file] : [];
    });

  if (itemFiles.length > 0) {
    return itemFiles;
  }

  return Array.from(clipboardData.files).filter((file) =>
    file.type.startsWith("image/"),
  );
};

export const AgentComposer = ({
  variant,
  draft,
  textareaLabel,
  placeholder,
  chooserProviders,
  activeProvider,
  activeModel,
  contextAttachments,
  imageInputSupported,
  imageInputDisabledReason,
  canSend,
  sendDisabledReason,
  isExecuting,
  textareaRef,
  toolbarControls,
  toggles = [],
  actions = [],
  statusMessage,
  runningTaskMessageAction,
  queuedMessages = [],
  onModelSelection,
  onSelectContextFiles,
  onSelectContextFolders,
  onSelectContextImages,
  onPasteContextImages,
  onRemoveContextAttachment,
  onClearContextAttachments,
  onDraftChange,
  onAdditionalTextareaKeyDown,
  onRunningTaskMessageActionChange,
  onQueuedMessageChange,
  onQueuedMessageMove,
  onQueuedMessageRemove,
  onSend,
  onCancel,
}: AgentComposerProps): JSX.Element => {
  const styles = getVariantStyles(variant);
  const showCancelButton = isExecuting && (variant === "quick" || !canSend);
  const selectedRunningAction =
    runningTaskMessageAction ?? RUNNING_TASK_MESSAGE_ACTIONS[2].id;
  const selectedRunningActionMeta =
    getRunningTaskMessageActionMeta(selectedRunningAction);
  const sendLabel =
    variant === "session" && isExecuting
      ? selectedRunningActionMeta.sendLabel
      : variant === "quick"
        ? "Send"
        : "Send message";
  const queuePanelVisible = variant === "session" && queuedMessages.length > 0;

  const submit = (): void => {
    if (canSend) {
      onSend();
    }
  };

  const handleTextareaKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }

    onAdditionalTextareaKeyDown?.(event);
  };

  const handleTextareaPaste = (
    event: ClipboardEvent<HTMLTextAreaElement>,
  ): void => {
    const imageFiles = getClipboardImageFiles(event);

    if (imageFiles.length === 0) {
      return;
    }

    event.preventDefault();

    if (!imageInputSupported) {
      console.error(imageInputDisabledReason ?? "Image input is unavailable.");
      return;
    }

    void onPasteContextImages(imageFiles).catch((error) => {
      console.error("Failed to attach pasted image", error);
    });
  };

  const attachmentMenu = (
    <ContextAttachmentMenuButton
      onSelectFiles={onSelectContextFiles}
      onSelectFolders={onSelectContextFolders}
      onSelectImages={onSelectContextImages}
      imageInputDisabled={!imageInputSupported}
      imageInputDisabledReason={imageInputDisabledReason}
      menuSide={styles.attachmentMenuSide}
      className={styles.attachmentButton}
      iconClassName={styles.attachmentIcon}
    />
  );
  const textarea = (
    <Textarea
      ref={textareaRef}
      aria-label={textareaLabel}
      value={draft}
      onChange={(event) => onDraftChange(event.target.value)}
      onKeyDown={handleTextareaKeyDown}
      onPaste={handleTextareaPaste}
      placeholder={placeholder}
      className={styles.textarea}
    />
  );
  const toggleButtons = toggles.map((toggle) =>
    renderToggle(toggle, variant, styles.iconButton),
  );
  const actionButtons = actions.map((action) =>
    renderAction(action, styles.iconButton),
  );
  const runningTaskControls =
    variant === "session" && isExecuting ? (
      <div className="app-composer-running-controls flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800/80 bg-slate-900/35 px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-medium text-slate-300">
          <span className="h-2 w-2 rounded-full bg-sky-400 shadow-[0_0_12px_rgba(56,189,248,0.65)]" />
          Running
        </div>
        <div
          aria-label="Running task message action"
          className="flex min-w-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-950/70 p-0.5"
          role="group"
        >
          {RUNNING_TASK_MESSAGE_ACTIONS.map((action) => {
            const Icon = action.icon;
            const selected = action.id === selectedRunningAction;

            return (
              <button
                key={action.id}
                type="button"
                aria-pressed={selected}
                onClick={() => onRunningTaskMessageActionChange?.(action.id)}
                className={cn(
                  "inline-flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-slate-400 transition hover:bg-slate-800 hover:text-slate-100",
                  selected &&
                    "bg-sky-500/12 text-sky-100 shadow-[inset_0_0_0_1px_rgba(56,189,248,0.2)]",
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span>{action.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    ) : null;
  const queuedMessagesPanel = queuePanelVisible ? (
    <div
      aria-label="Queued messages"
      className="app-composer-queued-messages rounded-xl border border-slate-800/80 bg-slate-900/30 p-2"
    >
      <div className="flex items-center gap-2 px-1 pb-2 text-xs font-medium text-slate-300">
        <ListOrdered className="h-3.5 w-3.5 text-sky-300" />
        Queued
        <span className="rounded-full bg-slate-800 px-1.5 py-0.5 text-[11px] leading-none text-slate-400">
          {queuedMessages.length}
        </span>
      </div>
      <div className="grid gap-2">
        {queuedMessages.map((message, index) => (
          <div
            key={message.id}
            className="grid gap-2 rounded-lg border border-slate-800/75 bg-slate-950/45 p-2 sm:grid-cols-[minmax(0,1fr)_auto]"
          >
            <div className="grid min-w-0 gap-1.5">
              <Textarea
                aria-label={`Queued message ${index + 1}`}
                value={message.content}
                onChange={(event) =>
                  onQueuedMessageChange?.(message.id, event.target.value)
                }
                className="min-h-10 resize-y border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 shadow-none placeholder:text-slate-500 focus-visible:ring-1 focus-visible:ring-sky-500"
              />
              {message.attachmentCount > 0 ? (
                <div className="px-1 text-[11px] leading-4 text-slate-500">
                  {message.attachmentCount} attached
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-1 sm:flex-col sm:justify-start">
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                aria-label={`Move queued message ${index + 1} up`}
                title="Move up"
                disabled={index === 0}
                onClick={() => onQueuedMessageMove?.(message.id, -1)}
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
                disabled={index === queuedMessages.length - 1}
                onClick={() => onQueuedMessageMove?.(message.id, 1)}
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
                onClick={() => onQueuedMessageRemove?.(message.id)}
                className="border-rose-500/20 bg-rose-500/10 text-rose-100 hover:bg-rose-500/15 hover:text-white"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  ) : null;
  const sendControl = showCancelButton ? (
    <Button
      type="button"
      variant="outline"
      size={variant === "session" ? "icon" : undefined}
      aria-label={variant === "quick" ? "Cancel Quick Chat" : "Cancel task"}
      title="Cancel"
      onClick={onCancel}
      className={styles.cancelButton}
    >
      <Square className={cn(styles.iconClassName, "fill-current")} />
    </Button>
  ) : (
    <Button
      type="submit"
      variant="outline"
      size={variant === "session" ? "icon" : undefined}
      aria-label={sendLabel}
      title={sendDisabledReason ?? sendLabel}
      disabled={!canSend}
      className={cn(styles.sendButton, canSend && styles.sendButtonActive)}
    >
      <SendHorizonal className={styles.iconClassName} />
    </Button>
  );

  if (variant === "quick") {
    return (
      <form
        className="grid gap-2.5 [@media(max-height:620px)]:gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <ContextAttachmentsList
          attachments={contextAttachments}
          onRemove={onRemoveContextAttachment}
          onClearAll={onClearContextAttachments}
          compact={styles.attachmentListCompact}
        />

        <div className="overflow-hidden rounded-2xl border border-slate-800/90 bg-slate-900/60 shadow-inner shadow-black/10 focus-within:border-sky-400/40 focus-within:ring-2 focus-within:ring-sky-500/20">
          {textarea}

          <div className="flex items-center gap-2 border-t border-slate-800/75 px-2.5 py-2">
            {attachmentMenu}

            <div className="min-w-0 flex-1 [&>button]:h-8 [&>button]:w-full [&>button]:max-w-none [&>button]:justify-start">
              <SessionModelPicker
                chooserProviders={chooserProviders}
                activeProvider={activeProvider}
                activeModel={activeModel}
                onSessionModelSelection={onModelSelection}
              />
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              {toggleButtons}
              {actionButtons}
              {sendControl}
            </div>
          </div>
        </div>
      </form>
    );
  }

  return (
    <div
      className="app-agent-composer app-agent-composer-session rounded-[1.75rem] border border-slate-800/80 bg-slate-950/75 p-3 shadow-[0_18px_48px_rgba(2,6,23,0.42)]"
      data-variant={variant}
    >
      <div className="app-composer-toolbar flex flex-wrap items-center gap-2 border-b border-slate-900/80 pb-3">
        <SessionModelPicker
          chooserProviders={chooserProviders}
          activeProvider={activeProvider}
          activeModel={activeModel}
          onSessionModelSelection={onModelSelection}
        />
        {toolbarControls}
        {toggleButtons}
      </div>

      <div className="app-composer-body mt-3 grid gap-2">
        {runningTaskControls}

        <ContextAttachmentsList
          attachments={contextAttachments}
          onRemove={onRemoveContextAttachment}
          onClearAll={onClearContextAttachments}
        />

        <form
          className="app-composer-form flex items-center gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {attachmentMenu}
          {textarea}
          {actionButtons}
          {sendControl}
        </form>

        {queuedMessagesPanel}

        {statusMessage?.text ? (
          <p
            aria-live="polite"
            className={cn(
              "app-composer-status px-1 text-xs leading-6",
              statusMessage.tone === "error"
                ? "text-rose-300"
                : statusMessage.tone === "success"
                  ? "text-emerald-300"
                  : "text-slate-400",
            )}
          >
            {statusMessage.text}
          </p>
        ) : null}
      </div>
    </div>
  );
};
