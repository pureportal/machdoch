import {
  CornerDownRight,
  ListOrdered,
  SendHorizonal,
  Square,
  X,
} from "lucide-react";
import type { ClipboardEvent, JSX, KeyboardEvent, ReactNode, Ref } from "react";
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChatSessionContextAttachment } from "../../chat-session.model";
import { getDefaultCommandShortcut } from "../../commands/command-defaults";
import { useOptionalRegisterCommands } from "../../commands/command-context";
import type {
  CommandDefinition,
  CommandPageItem,
} from "../../commands/command-types";
import { Button } from "../../components/ui/button";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "../../components/ui/submit-shortcut";
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
  draftRevision: number;
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
  autoFocus?: boolean;
  submissionLabel?: string;
  showCancelAlongsideSend?: boolean;
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
  onRunningTaskMessageActionChange?: (action: RunningTaskMessageAction) => void;
  onQueuedMessageChange?: (messageId: string, content: string) => void;
  onQueuedMessageMove?: (messageId: string, direction: -1 | 1) => void;
  onQueuedMessageReorder?: (messageId: string, targetIndex: number) => void;
  onQueuedMessageRemove?: (messageId: string) => void;
  onQueuedMessageRetry?: (messageId: string) => void;
  onQueuedMessageSend?: (messageId: string) => void;
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
  draftRevision: number,
  onDraftChange: (value: string) => void,
): {
  value: string;
  setValue: (value: string) => void;
  flush: () => void;
  getValue: () => string;
} => {
  const [value, setValueState] = useState(draft);
  const valueRef = useRef(draft);
  const identityRef = useRef(draftIdentity);
  const publishedValueRef = useRef(draft);
  const publishedRevisionRef = useRef(draftRevision);
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
  const getValue = useCallback((): string => valueRef.current, []);

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
    publishedRevisionRef.current = draftRevision;
    pendingValuesRef.current = [];
    valueRef.current = draft;
    setValueState(draft);
  }, [draft, draftIdentity, draftRevision]);

  useEffect(() => {
    if (identityRef.current !== draftIdentity) {
      return;
    }

    if (draft.length === 0 && draftRevision !== publishedRevisionRef.current) {
      pendingValuesRef.current = [];
      publishedValueRef.current = draft;
      publishedRevisionRef.current = draftRevision;
      valueRef.current = draft;
      setValueState(draft);
      return;
    }

    const pendingIndex = pendingValuesRef.current.lastIndexOf(draft);
    if (pendingIndex >= 0) {
      pendingValuesRef.current.splice(0, pendingIndex + 1);
      publishedValueRef.current = draft;
      publishedRevisionRef.current = draftRevision;
      return;
    }

    if (
      draft === publishedValueRef.current &&
      draftRevision === publishedRevisionRef.current
    ) {
      return;
    }

    pendingValuesRef.current = [];
    publishedValueRef.current = draft;
    publishedRevisionRef.current = draftRevision;
    valueRef.current = draft;
    setValueState(draft);
  }, [draft, draftIdentity, draftRevision]);

  return { value, setValue, flush, getValue };
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
      "app-composer-textarea max-h-[30vh] min-h-14 min-w-0 flex-1 resize-none overflow-y-auto rounded-[1.4rem] border-slate-800 bg-slate-900/70 px-5 py-4 text-base text-slate-100 shadow-inner shadow-black/20 placeholder:text-slate-500 focus-visible:ring-1 focus-visible:ring-sky-500 disabled:cursor-not-allowed disabled:bg-slate-900/50 disabled:text-slate-500 disabled:opacity-100",
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
      icon={toggle.icon}
      pressed={toggle.pressed}
      disabled={toggle.disabled}
      disabledMode={variant === "quick" ? "native" : "aria"}
      onPressedChange={toggle.onPressedChange}
      baseClassName={variant === "quick" ? iconButtonClassName : undefined}
      activeClassName={toggle.activeClassName}
      disabledClassName={toggle.unavailableClassName}
      className={
        variant === "session" ? "app-composer-toggle-button" : undefined
      }
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
      size="icon"
      aria-label={action.label}
      tooltip={action.title ?? action.label}
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
  draftRevision,
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
  autoFocus = false,
  submissionLabel,
  showCancelAlongsideSend = false,
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
  onQueuedMessageRetry,
  onQueuedMessageSend,
  onQueuedMessageSelectContextAttachments,
  onQueuedMessageRemoveContextAttachment,
  onQueuedMessageClearContextAttachments,
  onSend,
  onCancel,
}: AgentComposerProps): JSX.Element => {
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const handleTextareaRef = useCallback(
    (node: HTMLTextAreaElement | null): void => {
      composerTextareaRef.current = node;
      if (typeof textareaRef === "function") {
        textareaRef(node);
      } else if (textareaRef) {
        textareaRef.current = node;
      }
    },
    [textareaRef],
  );
  const bufferedDraft = useBufferedDraft(
    draftIdentity,
    draft,
    draftRevision,
    onDraftChange,
  );
  const styles = getVariantStyles(variant);
  const canSubmit = canSend && Boolean(bufferedDraft.value.trim());
  const showCancelButton = isExecuting && (variant === "quick" || !canSubmit);
  const selectedRunningAction =
    runningTaskMessageAction ?? RUNNING_TASK_MESSAGE_ACTIONS[2].id;
  const selectedRunningActionMeta = getRunningTaskMessageActionMeta(
    selectedRunningAction,
  );
  const sendLabel =
    submissionLabel ??
    (variant === "session" && isExecuting
      ? selectedRunningActionMeta.sendLabel
      : variant === "quick"
        ? "Send"
        : "Send message");
  const queuePanelVisible = variant === "session" && queuedMessages.length > 0;

  const submit = useCallback((): void => {
    const currentDraft = bufferedDraft.getValue();
    if (!inputBlocked && canSend && currentDraft.trim()) {
      bufferedDraft.flush();
      onSend(currentDraft);
    }
  }, [
    bufferedDraft.flush,
    bufferedDraft.getValue,
    canSend,
    inputBlocked,
    onSend,
  ]);

  const handleTextareaKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }

    if (event.key === "Escape" && showCancelAlongsideSend) {
      event.preventDefault();
      onCancel();
      return;
    }

    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
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
      ref={handleTextareaRef}
      autoFocus={autoFocus}
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
  const composerCommands = useMemo<readonly CommandDefinition[]>(() => {
    if (variant !== "session") return [];
    const ordinaryFocus = [
      "document",
      "text-entry",
      "interactive-control",
      "command-surface",
    ] as const;
    return [
      {
        id: "chat.composer.focus",
        title: "Focus message input",
        group: "Chat",
        scope: { kind: "view", ownerId: "chat" },
        shortcuts: [
          {
            chord: getDefaultCommandShortcut("chat.composer.focus"),
            allowIn: ["document", "text-entry", "interactive-control"],
          },
        ],
        palette: "hidden",
        availability: () =>
          inputBlocked ||
          showCancelAlongsideSend ||
          !composerTextareaRef.current
            ? { state: "hidden" }
            : { state: "enabled" },
        execute: () =>
          composerTextareaRef.current?.focus({ preventScroll: true }),
      },
      {
        id: "chat.composer.send",
        title: sendLabel,
        group: "Chat",
        scope: { kind: "view", ownerId: "chat" },
        palette: "visible",
        availability: () =>
          inputBlocked
            ? { state: "disabled", reason: "The composer is busy" }
            : canSubmit
              ? { state: "enabled" }
              : {
                  state: "disabled",
                  reason: sendDisabledReason ?? "Enter a message first",
                },
        execute: () => submit(),
      },
      {
        id: "chat.task.cancel",
        title: showCancelAlongsideSend ? "Cancel message edit" : "Cancel task",
        group: "Chat",
        scope: { kind: "view", ownerId: "chat" },
        shortcuts: [
          {
            chord: getDefaultCommandShortcut("chat.task.cancel"),
            allowIn: ordinaryFocus,
          },
        ],
        palette: "visible",
        overlayPolicy: "replace-non-modal",
        availability: () =>
          isExecuting || showCancelAlongsideSend
            ? { state: "enabled" }
            : { state: "disabled", reason: "No active task or edit" },
        execute: () => onCancel(),
      },
      {
        id: "chat.composer.context.add",
        title: "Add context",
        group: "Chat",
        keywords: ["attach", "file", "folder", "image", "media"],
        scope: { kind: "view", ownerId: "chat" },
        palette: "visible",
        overlayPolicy: "replace-non-modal",
        availability: () =>
          inputBlocked
            ? { state: "disabled", reason: "The composer is busy" }
            : { state: "enabled" },
        children: () => ({
          id: "chat-composer-context-add",
          title: "Add context",
          searchPlaceholder: "Choose source",
          groups: [
            {
              id: "context",
              items: [
                {
                  id: "images",
                  title: "Images",
                  availability: imageInputSupported
                    ? { state: "enabled" }
                    : {
                        state: "disabled",
                        reason:
                          imageInputDisabledReason ??
                          "Image input is unavailable",
                      },
                  execute: async () => onSelectContextImages(),
                },
                ...(onBrowseMediaAssets
                  ? [
                      {
                        id: "media-library",
                        title: "Media Library",
                        availability: imageInputSupported
                          ? ({ state: "enabled" } as const)
                          : ({
                              state: "disabled",
                              reason:
                                imageInputDisabledReason ??
                                "Image input is unavailable",
                            } as const),
                        execute: () => onBrowseMediaAssets(),
                      },
                    ]
                  : []),
                ...(onCreateMediaAsset
                  ? [
                      {
                        id: "media-create",
                        title: "Create in Media Studio",
                        execute: () =>
                          onCreateMediaAsset(bufferedDraft.getValue().trim()),
                      },
                    ]
                  : []),
                {
                  id: "files",
                  title: "Files",
                  execute: async () => onSelectContextFiles(),
                },
                {
                  id: "folders",
                  title: "Folders",
                  execute: async () => onSelectContextFolders(),
                },
              ],
            },
          ],
        }),
      },
      {
        id: "chat.composer.context.open",
        title: "Open context attachment",
        group: "Chat",
        scope: { kind: "view", ownerId: "chat" },
        palette: "visible",
        availability: () =>
          contextAttachments.length > 0 && onOpenContextAttachment
            ? { state: "enabled" }
            : { state: "disabled", reason: "No context attachments" },
        children: () => ({
          id: "chat-composer-context-open",
          title: "Open context attachment",
          searchPlaceholder: "Choose attachment",
          groups: [
            {
              id: "attachments",
              items: contextAttachments.map((attachment) => ({
                id: attachment.id,
                title: attachment.name,
                keywords: [
                  "path" in attachment ? attachment.path : attachment.assetId,
                ],
                execute: () => onOpenContextAttachment?.(attachment),
              })),
            },
          ],
        }),
      },
      {
        id: "chat.composer.context.remove",
        title: "Remove context attachment",
        group: "Chat",
        scope: { kind: "view", ownerId: "chat" },
        palette: "visible",
        availability: () =>
          contextAttachments.length > 0
            ? { state: "enabled" }
            : { state: "disabled", reason: "No context attachments" },
        children: () => ({
          id: "chat-composer-context-remove",
          title: "Remove context attachment",
          searchPlaceholder: "Choose attachment",
          groups: [
            {
              id: "attachments",
              items: contextAttachments.map((attachment) => ({
                id: attachment.id,
                title: attachment.name,
                execute: () => onRemoveContextAttachment(attachment.id),
              })),
            },
          ],
        }),
      },
      {
        id: "chat.composer.context.clear",
        title: "Clear context attachments",
        group: "Chat",
        scope: { kind: "view", ownerId: "chat" },
        palette: "visible",
        availability: () =>
          contextAttachments.length > 0
            ? { state: "enabled" }
            : { state: "disabled", reason: "No context attachments" },
        execute: () => onClearContextAttachments(),
      },
      ...toggles.map(
        (toggle): CommandDefinition => ({
          id: `chat.composer.${toggle.id}.toggle`,
          title: `${toggle.pressed ? "Disable" : "Enable"} ${toggle.label.toLowerCase()}`,
          group: "Chat",
          keywords: toggle.description ? [toggle.description] : undefined,
          scope: { kind: "view", ownerId: "chat" },
          palette: "visible",
          availability: () =>
            inputBlocked
              ? { state: "disabled", reason: "The composer is busy" }
              : toggle.disabled
                ? {
                    state: "disabled",
                    reason:
                      toggle.description ?? `${toggle.label} is unavailable`,
                  }
                : { state: "enabled" },
          execute: () => toggle.onPressedChange(!toggle.pressed),
        }),
      ),
      ...actions.map(
        (action): CommandDefinition => ({
          id: `chat.composer.${action.id}`,
          title: action.label,
          group: "Chat",
          scope: { kind: "view", ownerId: "chat" },
          palette: "visible",
          availability: () =>
            inputBlocked
              ? { state: "disabled", reason: "The composer is busy" }
              : action.disabled
                ? {
                    state: "disabled",
                    reason: `${action.label} is unavailable`,
                  }
                : { state: "enabled" },
          execute: () => action.onClick(),
        }),
      ),
      {
        id: "chat.task.message-action.select",
        title: "Choose running-task message action",
        group: "Chat",
        scope: { kind: "view", ownerId: "chat" },
        palette: "visible",
        availability: () =>
          isExecuting
            ? { state: "enabled" }
            : { state: "disabled", reason: "No task is running" },
        children: () => ({
          id: "chat-running-task-message-action",
          title: "Running-task message action",
          searchPlaceholder: "Choose action",
          numericSelection: true,
          groups: [
            {
              id: "actions",
              items: RUNNING_TASK_MESSAGE_ACTIONS.map(
                (action, index): CommandPageItem => ({
                  id: action.id,
                  title: action.label,
                  current: action.id === selectedRunningAction,
                  numericKey: String(
                    index + 1,
                  ) as CommandPageItem["numericKey"],
                  execute: () => onRunningTaskMessageActionChange?.(action.id),
                }),
              ),
            },
          ],
        }),
      },
      {
        id: "chat.queue.remove",
        title: "Remove queued message",
        group: "Chat",
        scope: { kind: "view", ownerId: "chat" },
        palette: "visible",
        availability: () =>
          queuedMessages.length > 0 && onQueuedMessageRemove
            ? { state: "enabled" }
            : { state: "disabled", reason: "No queued messages" },
        children: () => ({
          id: "chat-queue-remove",
          title: "Remove queued message",
          searchPlaceholder: "Choose message",
          groups: [
            {
              id: "messages",
              items: queuedMessages.map((message, index) => ({
                id: message.id,
                title:
                  message.content.trim().replace(/\s+/gu, " ") ||
                  `Queued message ${index + 1}`,
                execute: () => onQueuedMessageRemove?.(message.id),
              })),
            },
          ],
        }),
      },
      {
        id: "chat.queue.move",
        title: "Move queued message",
        group: "Chat",
        scope: { kind: "view", ownerId: "chat" },
        palette: "visible",
        availability: () =>
          queuedMessages.length > 1 && onQueuedMessageMove
            ? { state: "enabled" }
            : { state: "hidden" },
        children: () => ({
          id: "chat-queue-move",
          title: "Move queued message",
          searchPlaceholder: "Choose message and direction",
          groups: [
            {
              id: "messages",
              items: queuedMessages.flatMap((message, index) => {
                const title =
                  message.content.trim().replace(/\s+/gu, " ") ||
                  `Queued message ${index + 1}`;
                return [
                  {
                    id: `${message.id}:up`,
                    title: `Move up: ${title}`,
                    availability:
                      index > 0
                        ? ({ state: "enabled" } as const)
                        : ({ state: "hidden" } as const),
                    execute: () => onQueuedMessageMove?.(message.id, -1),
                  },
                  {
                    id: `${message.id}:down`,
                    title: `Move down: ${title}`,
                    availability:
                      index < queuedMessages.length - 1
                        ? ({ state: "enabled" } as const)
                        : ({ state: "hidden" } as const),
                    execute: () => onQueuedMessageMove?.(message.id, 1),
                  },
                ];
              }),
            },
          ],
        }),
      },
      {
        id: "chat.queue.context.add",
        title: "Add context to queued message",
        group: "Chat",
        scope: { kind: "view", ownerId: "chat" },
        palette: "visible",
        availability: () =>
          queuedMessages.length > 0 && onQueuedMessageSelectContextAttachments
            ? { state: "enabled" }
            : { state: "hidden" },
        children: () => ({
          id: "chat-queue-context-add",
          title: "Add context to queued message",
          searchPlaceholder: "Choose message and source",
          groups: [
            {
              id: "messages",
              items: queuedMessages.flatMap((message, index) => {
                const title =
                  message.content.trim().replace(/\s+/gu, " ") ||
                  `Queued message ${index + 1}`;
                return (["files", "folders", "images"] as const).map(
                  (kind) => ({
                    id: `${message.id}:${kind}`,
                    title: `${kind[0]?.toUpperCase()}${kind.slice(1)}: ${title}`,
                    availability:
                      kind === "images" && !imageInputSupported
                        ? ({
                            state: "disabled",
                            reason:
                              imageInputDisabledReason ??
                              "Image input is unavailable",
                          } as const)
                        : ({ state: "enabled" } as const),
                    execute: () =>
                      onQueuedMessageSelectContextAttachments?.(
                        message.id,
                        kind,
                      ),
                  }),
                );
              }),
            },
          ],
        }),
      },
      {
        id: "chat.queue.context.open",
        title: "Open queued-message attachment",
        group: "Chat",
        scope: { kind: "view", ownerId: "chat" },
        palette: "visible",
        availability: () =>
          onOpenContextAttachment &&
          queuedMessages.some((message) => message.attachments.length)
            ? { state: "enabled" }
            : { state: "hidden" },
        children: () => ({
          id: "chat-queue-context-open",
          title: "Open queued-message attachment",
          searchPlaceholder: "Search attachments",
          groups: [
            {
              id: "attachments",
              items: queuedMessages.flatMap((message) =>
                message.attachments.map((attachment) => ({
                  id: `${message.id}:${attachment.id}`,
                  title: attachment.name,
                  execute: () => onOpenContextAttachment?.(attachment),
                })),
              ),
            },
          ],
        }),
      },
      {
        id: "chat.queue.context.clear",
        title: "Clear queued-message context",
        group: "Chat",
        scope: { kind: "view", ownerId: "chat" },
        palette: "visible",
        availability: () =>
          onQueuedMessageClearContextAttachments &&
          queuedMessages.some((message) => message.attachments.length)
            ? { state: "enabled" }
            : { state: "hidden" },
        children: () => ({
          id: "chat-queue-context-clear",
          title: "Clear queued-message context",
          searchPlaceholder: "Choose message",
          groups: [
            {
              id: "messages",
              items: queuedMessages.flatMap((message, index) =>
                message.attachments.length
                  ? [
                      {
                        id: message.id,
                        title:
                          message.content.trim().replace(/\s+/gu, " ") ||
                          `Queued message ${index + 1}`,
                        execute: () =>
                          onQueuedMessageClearContextAttachments?.(message.id),
                      },
                    ]
                  : [],
              ),
            },
          ],
        }),
      },
    ];
  }, [
    actions,
    bufferedDraft.getValue,
    canSubmit,
    contextAttachments,
    imageInputDisabledReason,
    imageInputSupported,
    inputBlocked,
    isExecuting,
    onBrowseMediaAssets,
    onCancel,
    onClearContextAttachments,
    onCreateMediaAsset,
    onOpenContextAttachment,
    onQueuedMessageRemove,
    onQueuedMessageMove,
    onQueuedMessageSelectContextAttachments,
    onQueuedMessageClearContextAttachments,
    onRemoveContextAttachment,
    onSelectContextFiles,
    onSelectContextFolders,
    onSelectContextImages,
    onRunningTaskMessageActionChange,
    queuedMessages,
    selectedRunningAction,
    sendDisabledReason,
    sendLabel,
    showCancelAlongsideSend,
    submit,
    toggles,
    variant,
  ]);
  useOptionalRegisterCommands(composerCommands);
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
      onMessageRetry={onQueuedMessageRetry}
      onMessageSend={onQueuedMessageSend}
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
      tooltip="Cancel"
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
      tooltip={sendDisabledReason ?? sendLabel}
      disabled={inputBlocked || !canSubmit}
      {...SUBMIT_SHORTCUT_ACTION_PROPS}
      className={cn(
        styles.sendButton,
        !inputBlocked && canSubmit && styles.sendButtonActive,
      )}
    >
      <SendHorizonal className={styles.iconClassName} />
    </Button>
  );
  const editCancelControl = showCancelAlongsideSend ? (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-label="Cancel edit"
      tooltip="Cancel edit"
      onClick={onCancel}
      className={styles.cancelButton}
    >
      <X className={styles.iconClassName} />
    </Button>
  ) : null;
  const sessionActionControls = showCancelAlongsideSend ? (
    <div
      role="group"
      aria-label="Edit message actions"
      className="app-composer-edit-actions flex shrink-0 items-center gap-2"
    >
      {actionButtons}
      {editCancelControl}
      {sendControl}
    </div>
  ) : (
    <>
      {actionButtons}
      {sendControl}
    </>
  );

  if (variant === "quick") {
    return (
      <SubmitShortcut asChild>
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
      </SubmitShortcut>
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

        <SubmitShortcut asChild>
          <form
            className={cn(
              "app-composer-form flex gap-3",
              showCancelAlongsideSend ? "items-end" : "items-center",
            )}
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            {attachmentMenu}
            {textarea}
            {sessionActionControls}
          </form>
        </SubmitShortcut>

        {queuedMessagesPanel}
      </div>
    </div>
  );
};
