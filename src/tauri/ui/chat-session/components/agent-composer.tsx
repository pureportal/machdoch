import {
  CornerDownRight,
  ListOrdered,
  SendHorizonal,
  Square,
} from "lucide-react";
import type {
  ClipboardEvent,
  JSX,
  KeyboardEvent,
  ReactNode,
  Ref,
} from "react";
import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ChatSessionContextAttachment } from "../../chat-session.model";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";
import type { RunningTaskMessageAction } from "../../lib/shell-store";
import type { RuntimeProvider } from "../../model-catalog";
import type { AttachmentSelectionKind } from "../_helpers/session-context-attachments";
import {
  ContextAttachmentMenuButton,
  ContextAttachmentsList,
} from "./context-attachments";
import {
  QueuedMessagesPanel,
  type QueuedMessagePanelMessage,
} from "./queued-messages-panel";
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

export type AgentComposerQueuedMessage = QueuedMessagePanelMessage;

export interface AgentComposerProps {
  variant: AgentComposerVariant;
  draftIdentity: string;
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
  inputBlocked?: boolean;
  textareaRef?: Ref<HTMLTextAreaElement>;
  toolbarControls?: ReactNode;
  toggles?: AgentComposerToggle[];
  actions?: AgentComposerAction[];
  runningTaskMessageAction?: RunningTaskMessageAction;
  queuedMessages?: AgentComposerQueuedMessage[];
  onModelSelection: (provider: RuntimeProvider, model: string) => void;
  onSelectContextFiles: () => Promise<void>;
  onSelectContextFolders: () => Promise<void>;
  onSelectContextImages: () => Promise<void>;
  onBrowseMediaAssets?: () => void;
  onCreateMediaAsset?: (prompt: string) => void;
  onPasteContextImages: (files: File[]) => Promise<void>;
  onOpenContextAttachment?: (attachment: ChatSessionContextAttachment) => void;
  onRemoveContextAttachment: (attachmentId: string) => void;
  onClearContextAttachments: () => void;
  onDraftChange: (value: string) => void;
  onAdditionalTextareaKeyDown?: (
    event: KeyboardEvent<HTMLTextAreaElement>,
    currentDraft: string,
  ) => void;
  onRunningTaskMessageActionChange?: (
    action: RunningTaskMessageAction,
  ) => void;
  onQueuedMessageChange?: (messageId: string, content: string) => void;
  onQueuedMessageMove?: (messageId: string, direction: -1 | 1) => void;
  onQueuedMessageReorder?: (messageId: string, targetIndex: number) => void;
  onQueuedMessageRemove?: (messageId: string) => void;
  onQueuedMessageSelectContextAttachments?: (
    messageId: string,
    selectionKind: AttachmentSelectionKind,
  ) => Promise<void>;
  onQueuedMessageRemoveContextAttachment?: (
    messageId: string,
    attachmentId: string,
  ) => void;
  onQueuedMessageClearContextAttachments?: (messageId: string) => void;
  onSend: (draft: string) => void;
  onCancel: () => void;
}

const useBufferedDraft = (
  draftIdentity: string,
  draft: string,
  onDraftChange: (value: string) => void,
): {
  value: string;
  setValue: (value: string) => void;
  flush: () => void;
} => {
  const [value, setValueState] = useState(draft);
  const valueRef = useRef(draft);
  const identityRef = useRef(draftIdentity);
  const publishedValueRef = useRef(draft);
  const pendingValuesRef = useRef<string[]>([]);
  const onDraftChangeRef = useRef(onDraftChange);

  onDraftChangeRef.current = onDraftChange;

  const flush = useCallback((): void => {
    const currentValue = valueRef.current;
    if (currentValue === publishedValueRef.current) {
      return;
    }

    onDraftChangeRef.current(currentValue);
  }, []);

  const setValue = useCallback(
    (nextValue: string): void => {
      valueRef.current = nextValue;
      setValueState(nextValue);
      pendingValuesRef.current.push(nextValue);
      if (pendingValuesRef.current.length > 32) {
        pendingValuesRef.current.splice(
          0,
          pendingValuesRef.current.length - 32,
        );
      }
      startTransition(() => onDraftChange(nextValue));
    },
    [onDraftChange],
  );

  useEffect(() => {
    if (identityRef.current === draftIdentity) {
      return;
    }

    identityRef.current = draftIdentity;
    publishedValueRef.current = draft;
    pendingValuesRef.current = [];
    valueRef.current = draft;
    setValueState(draft);
  }, [draft, draftIdentity]);

  useEffect(() => {
    if (identityRef.current !== draftIdentity) {
      return;
    }

    const pendingIndex = pendingValuesRef.current.lastIndexOf(draft);
    if (pendingIndex >= 0) {
      pendingValuesRef.current.splice(0, pendingIndex + 1);
      publishedValueRef.current = draft;
      return;
    }

    if (draft === publishedValueRef.current) {
      return;
    }

    pendingValuesRef.current = [];
    publishedValueRef.current = draft;
    valueRef.current = draft;
    setValueState(draft);
  }, [draft, draftIdentity]);

  return { value, setValue, flush };
};

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
  draftIdentity,
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
  inputBlocked = false,
  textareaRef,
  toolbarControls,
  toggles = [],
  actions = [],
  runningTaskMessageAction,
  queuedMessages = [],
  onModelSelection,
  onSelectContextFiles,
  onSelectContextFolders,
  onSelectContextImages,
  onBrowseMediaAssets,
  onCreateMediaAsset,
  onPasteContextImages,
  onOpenContextAttachment,
  onRemoveContextAttachment,
  onClearContextAttachments,
  onDraftChange,
  onAdditionalTextareaKeyDown,
  onRunningTaskMessageActionChange,
  onQueuedMessageChange,
  onQueuedMessageMove,
  onQueuedMessageReorder,
  onQueuedMessageRemove,
  onQueuedMessageSelectContextAttachments,
  onQueuedMessageRemoveContextAttachment,
  onQueuedMessageClearContextAttachments,
  onSend,
  onCancel,
}: AgentComposerProps): JSX.Element => {
  const bufferedDraft = useBufferedDraft(
    draftIdentity,
    draft,
    onDraftChange,
  );
  const styles = getVariantStyles(variant);
  const canSubmit = canSend && Boolean(bufferedDraft.value.trim());
  const showCancelButton =
    isExecuting && (variant === "quick" || !canSubmit);
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
    if (!inputBlocked && canSubmit) {
      bufferedDraft.flush();
      onSend(bufferedDraft.value);
    }
  };

  const handleTextareaKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      bufferedDraft.flush();
    }
    onAdditionalTextareaKeyDown?.(event, bufferedDraft.value);
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
      onBrowseMediaAssets={onBrowseMediaAssets}
      onCreateMediaAsset={
        onCreateMediaAsset
          ? () => onCreateMediaAsset(bufferedDraft.value.trim())
          : undefined
      }
      disabled={inputBlocked}
      imageInputDisabled={!imageInputSupported}
      imageInputDisabledReason={imageInputDisabledReason}
      mediaLibraryDisabled={!imageInputSupported}
      mediaLibraryDisabledReason={imageInputDisabledReason}
      menuSide={styles.attachmentMenuSide}
      className={styles.attachmentButton}
      iconClassName={styles.attachmentIcon}
    />
  );
  const textarea = (
    <Textarea
      ref={textareaRef}
      aria-label={textareaLabel}
      value={bufferedDraft.value}
      onChange={(event) => bufferedDraft.setValue(event.target.value)}
      onBlur={bufferedDraft.flush}
      onKeyDown={handleTextareaKeyDown}
      onPaste={handleTextareaPaste}
      placeholder={placeholder}
      disabled={inputBlocked}
      className={styles.textarea}
    />
  );
  const toggleButtons = toggles.map((toggle) =>
    renderToggle(
      {
        ...toggle,
        disabled: inputBlocked || toggle.disabled,
      },
      variant,
      styles.iconButton,
    ),
  );
  const actionButtons = actions.map((action) =>
    renderAction(
      {
        ...action,
        disabled: inputBlocked || action.disabled,
      },
      styles.iconButton,
    ),
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
                disabled={inputBlocked}
                onClick={() => onRunningTaskMessageActionChange?.(action.id)}
                className={cn(
                  "inline-flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-slate-400 transition hover:bg-slate-800 hover:text-slate-100 disabled:cursor-not-allowed disabled:text-slate-600 disabled:hover:bg-transparent",
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
    <QueuedMessagesPanel
      messages={queuedMessages}
      imageInputDisabled={!imageInputSupported}
      imageInputDisabledReason={imageInputDisabledReason}
      onOpenAttachment={onOpenContextAttachment}
      onMessageChange={onQueuedMessageChange}
      onMessageMove={onQueuedMessageMove}
      onMessageReorder={onQueuedMessageReorder}
      onMessageRemove={onQueuedMessageRemove}
      onMessageSelectAttachments={onQueuedMessageSelectContextAttachments}
      onMessageRemoveAttachment={onQueuedMessageRemoveContextAttachment}
      onMessageClearAttachments={onQueuedMessageClearContextAttachments}
    />
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
      disabled={inputBlocked || !canSubmit}
      className={cn(
        styles.sendButton,
        !inputBlocked && canSubmit && styles.sendButtonActive,
      )}
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
          onOpen={onOpenContextAttachment}
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
      aria-busy={inputBlocked}
      aria-disabled={inputBlocked}
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
          onOpen={onOpenContextAttachment}
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

      </div>
    </div>
  );
};
