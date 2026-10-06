import { MessageEditor } from "@machdoch/client-ui/conversation/message-editor";
import {
  Bot,
  ChevronDown,
  ChevronUp,
  History,
  Pencil,
  Play,
  RotateCcw,
  Square,
  User,
  Volume2,
  WandSparkles,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import { useOptionalRegisterCommands } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import {
  getOriginalPromptContent,
  OriginalPromptPanel,
  OriginalPromptToggle,
} from "@machdoch/product-ui";
import { createConversationCommands } from "@machdoch/client-ui/conversation/commands";
import { getRetryableAgentMessageIds } from "@machdoch/client-ui/conversation/retryable-messages";
import {
  isPromptEnhancementPlaceholderMessage,
  type ChatSessionMessage,
} from "../../chat-session.model";
import { type ChatSessionContextAttachment } from "@machdoch/client-ui/composer/model";
import { Avatar } from "../../components/ui/avatar";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import { TaskThinkingPanel } from "@machdoch/client-ui/conversation/task-thinking-panel";
import { TaskTimeoutControls } from "@machdoch/client-ui/conversation/task-timeout-controls";
import { resetDesktopTaskTimeout } from "../../runtime";
import { DESKTOP_SETTING_BOUNDS } from "../../../../core/runtime-contract.generated.js";
import { isTauri } from "@tauri-apps/api/core";
import {
  clampAiContextMessageLimit,
  DEFAULT_AI_CONTEXT_MESSAGE_LIMIT,
  getAiContextCutoffMessageId,
} from "../_helpers/ai-context-window";
import {
  createExecutionThinkingTrace,
  getExecutionMessageRenderKey,
  getRenderedMessageContent,
} from "../_helpers/execution-message.tsx";
import {
  getConversationMessageNavigationState,
  getNavigableConversationMessages,
  getRenderedMessageLimitForTarget,
  getVisibleConversationMessageId,
  isNavigableConversationMessage,
} from "@machdoch/client-ui/conversation/message-navigation";
import { isRecoveredTaskCrashMessage } from "../_helpers/session-task-continuation";
import { getMessageWorkspaceRoot } from "../_helpers/message-workspace";
import { MessageAttachmentsList } from "@machdoch/client-ui/composer/context-attachments";
import { ExecutionInsightRow } from "@machdoch/client-ui/conversation/execution-insight-row";
import { getTaskFileChangeFiles, getTaskFileChangeHunks } from "../../runtime";
import { MarkdownContent } from "@machdoch/client-ui/conversation/markdown-content";
import { PromptEnhancementPending } from "./prompt-enhancement-pending";
import {
  MessageContextMenu,
  type MessageContextMenuTarget,
} from "@machdoch/client-ui/conversation/message-context-menu";

const taskFileChangeReader = {
  getFiles: getTaskFileChangeFiles,
  getHunks: getTaskFileChangeHunks,
};

export interface ConversationFeedProps {
  visibleMessages: ChatSessionMessage[];
  hideEmptyState?: boolean;
  poseScenePreview?: ReactNode;
  promptEnhancementPreview?: {
    id: string;
    content: string;
    originalContent?: string;
    contextAttachments: ChatSessionContextAttachment[];
  } | null;
  workspaceRoot?: string | null;
  aiContextMessageLimit?: number;
  isSessionRunning?: boolean;
  bottomRef: Ref<HTMLDivElement>;
  onRetryTask: (message: ChatSessionMessage) => void;
  onRetryMessage?: (message: ChatSessionMessage) => boolean;
  onEditMessage?: (message: ChatSessionMessage, content: string) => boolean;
  onStartEditMessage?: (message: ChatSessionMessage) => void;
  activeEditingMessageId?: string | null;
  editingPromptEnhancement?: {
    messageId: string;
  } | null;
  onCancelPromptEnhancement?: () => void;
  onContinueTask: (message: ChatSessionMessage) => void;
  onSaveMessageAsContextPack?: (message: ChatSessionMessage) => void;
  onOpenWorkspaceFile: (
    relativePath: string,
    line?: number,
    workspaceRoot?: string | null,
  ) => void;
  onOpenLocalFile?: (path: string, line?: number) => void;
  onOpenAttachment?: (
    attachment: ChatSessionContextAttachment,
    workspaceRoot?: string | null,
  ) => void;
  voicePlayback: {
    supported: boolean;
    speakingMessageId: string | null;
    onSpeakMessage: (message: ChatSessionMessage) => void;
    onStopSpeaking: () => void;
  };
}

const INITIAL_RENDERED_MESSAGE_LIMIT = 80;
const RENDERED_MESSAGE_PAGE_SIZE = 80;
const MESSAGE_NAVIGATION_HIGHLIGHT_DURATION_MS = 1_800;
const MESSAGE_NAVIGATION_SCROLL_EDGE_EPSILON_PX = 8;

interface ConversationMessageRowProps {
  aiContextMessageLimit: number;
  canContinueMessage: boolean;
  canRetryMessage: boolean;
  editContent: string;
  isEditing: boolean;
  isActiveEditing: boolean;
  isDimmedForEditing: boolean;
  isPromptEnhancing: boolean;
  isAiContextStart: boolean;
  isNavigationHighlighted: boolean;
  isNavigationTarget: boolean;
  isOriginalPromptExpanded: boolean;
  isSpeakingMessage: boolean;
  message: ChatSessionMessage;
  onContinueTask: (message: ChatSessionMessage) => void;
  onCancelEditing: () => void;
  onCancelPromptEnhancement?: () => void;
  onEditContentChange: (content: string) => void;
  onEditMessage?: (message: ChatSessionMessage) => void;
  onOpenAttachment?: (
    attachment: ChatSessionContextAttachment,
    workspaceRoot?: string | null,
  ) => void;
  onOpenMessageContextMenu: (
    event: MouseEvent<HTMLDivElement>,
    message: ChatSessionMessage,
    content: string,
    canSaveAsContextPack: boolean,
  ) => void;
  onOpenWorkspaceFile: (
    relativePath: string,
    line?: number,
    workspaceRoot?: string | null,
  ) => void;
  onOpenLocalFile?: (path: string, line?: number) => void;
  onMessageElementChange: (
    messageId: string,
    element: HTMLDivElement | null,
  ) => void;
  onRetryTask: (message: ChatSessionMessage) => void;
  onRetryMessage?: (message: ChatSessionMessage) => void;
  onSaveMessageAsContextPack?: (message: ChatSessionMessage) => void;
  onSpeakMessage: (message: ChatSessionMessage) => void;
  onStopSpeaking: () => void;
  onToggleOriginalPrompt: (messageId: string) => void;
  voicePlaybackSupported: boolean;
  workspaceRoot?: string | null;
}

const ConversationMessageRow = memo(function ConversationMessageRow({
  aiContextMessageLimit,
  canContinueMessage,
  canRetryMessage,
  editContent,
  isActiveEditing,
  isDimmedForEditing,
  isEditing,
  isAiContextStart,
  isNavigationHighlighted,
  isNavigationTarget,
  isOriginalPromptExpanded,
  isPromptEnhancing,
  isSpeakingMessage,
  message,
  onCancelEditing,
  onCancelPromptEnhancement,
  onContinueTask,
  onEditContentChange,
  onEditMessage,
  onOpenAttachment,
  onOpenMessageContextMenu,
  onOpenWorkspaceFile,
  onOpenLocalFile,
  onMessageElementChange,
  onRetryTask,
  onRetryMessage,
  onSaveMessageAsContextPack,
  onSpeakMessage,
  onStopSpeaking,
  onToggleOriginalPrompt,
  voicePlaybackSupported,
  workspaceRoot,
}: ConversationMessageRowProps): JSX.Element | null {
  if (!isNavigableConversationMessage(message)) {
    return null;
  }

  const isPromptEnhancementPlaceholder =
    isPromptEnhancementPlaceholderMessage(message);

  const renderedContent = getRenderedMessageContent(message);
  const originalPromptContent =
    message.role === "user"
      ? getOriginalPromptContent(
          renderedContent,
          message.promptEnhancement?.originalContent,
        )
      : null;
  const originalPromptPanelId = `original-prompt-${message.id}`;
  const thinkingTrace =
    message.source?.kind === "execution"
      ? (message.source.thinking ??
        createExecutionThinkingTrace(message.source.execution))
      : message.source?.kind === "thinking"
        ? message.source.thinking
        : null;
  const shouldRenderBubble =
    message.role === "user" || renderedContent.trim().length > 0;
  const showCrashRecoveryActions = isRecoveredTaskCrashMessage(message);
  const messageAttachments =
    message.role === "user" ? (message.contextAttachments ?? []) : [];
  const canSaveMessageAsContextPack =
    message.role === "user" && Boolean(onSaveMessageAsContextPack);
  const showInlineRetry =
    message.role === "agent" &&
    canRetryMessage &&
    shouldRenderBubble &&
    !showCrashRecoveryActions &&
    message.source?.kind !== "execution";
  const retryMessage = (): void => {
    if (onRetryMessage) {
      onRetryMessage(message);
      return;
    }

    onRetryTask(message);
  };
  const openWorkspaceFile = (relativePath: string, line?: number): void => {
    onOpenWorkspaceFile(relativePath, line, workspaceRoot);
  };
  const openAttachment = onOpenAttachment
    ? (attachment: ChatSessionContextAttachment): void => {
        onOpenAttachment(attachment, workspaceRoot);
      }
    : undefined;

  return (
    <div
      ref={(element) => onMessageElementChange(message.id, element)}
      aria-current={isNavigationTarget ? "true" : undefined}
      data-message-id={message.id}
      data-message-role={message.role}
      className={cn(
        "app-message-container grid w-full gap-6 [contain-intrinsic-size:auto_180px] [content-visibility:auto]",
        isNavigationHighlighted &&
          "app-message-container--navigation-highlight",
        isDimmedForEditing && "opacity-40 transition-opacity",
      )}
    >
      {isAiContextStart ? (
        <div
          role="separator"
          aria-label={`AI context starts here. Last ${aiContextMessageLimit} messages are included.`}
          className="app-ai-context-separator flex items-center gap-3 px-2 py-1 text-xs font-medium text-slate-500"
        >
          <div className="h-px flex-1 bg-slate-800" />
          <span className="shrink-0 rounded-full border border-sky-500/20 bg-sky-500/10 px-3 py-1 text-sky-200">
            AI context starts here - last {aiContextMessageLimit} messages
          </span>
          <div className="h-px flex-1 bg-slate-800" />
        </div>
      ) : null}

      {message.role === "user" &&
      message.executionAttempt &&
      message.executionAttempt.retryNumber > 0 ? (
        <div
          role="status"
          className="flex items-center gap-2 px-2 text-xs text-amber-300"
        >
          <RotateCcw aria-hidden="true" className="size-3.5" />
          <span>
            Retry {message.executionAttempt.retryNumber} of{" "}
            {message.executionAttempt.retryLimit} · Previous execution failed
          </span>
        </div>
      ) : (
        <div
          className={cn(
            "app-message-row flex min-w-0 gap-4",
            message.role === "user" ? "flex-row-reverse" : "flex-row",
          )}
        >
          <Avatar
            className={cn(
              "app-message-avatar mt-1 h-10 w-10 shrink-0 border",
              message.role === "agent"
                ? "border-sky-500/20 bg-sky-500/10"
                : "border-emerald-500/20 bg-emerald-500/20",
            )}
          >
            <div className="flex h-full w-full items-center justify-center">
              {message.role === "agent" ? (
                <Bot className="h-5 w-5 text-sky-300" />
              ) : (
                <User className="h-5 w-5 text-emerald-100" />
              )}
            </div>
          </Avatar>

          <div
            className={cn(
              "app-message-stack flex min-w-0 flex-1 flex-col gap-3",
              message.role === "user" ? "items-end" : "items-start",
            )}
          >
            {thinkingTrace ? (
              <div className="app-thinking-wrapper w-full min-w-0 max-w-full pt-1 lg:max-w-4xl">
                <TaskThinkingPanel
                  thinking={thinkingTrace}
                  timeoutControls={
                    isTauri() &&
                    message.taskId &&
                    thinkingTrace.timeout?.idleTimeoutMs ? (
                      <TaskTimeoutControls
                        idleTimeoutMs={thinkingTrace.timeout.idleTimeoutMs}
                        bounds={DESKTOP_SETTING_BOUNDS.chatIdleTimeoutMinutes}
                        onReset={(minutes) =>
                          resetDesktopTaskTimeout(message.taskId!, minutes)
                        }
                      />
                    ) : null
                  }
                />
              </div>
            ) : null}

            {message.role === "user" && message.iteration ? (
              <span className="px-1 text-xs font-medium text-sky-200">
                Iteration {message.iteration.index} of {message.iteration.total}
              </span>
            ) : null}

            {shouldRenderBubble ? (
              <div
                className={cn(
                  "app-message-bubble relative max-w-[90%] min-w-0 overflow-hidden rounded-[1.75rem] px-5 py-4 text-sm leading-7 shadow-lg wrap-break-word",
                  message.role === "user"
                    ? "app-user-message-bubble rounded-tr-md bg-slate-800 text-slate-100 shadow-slate-950/20"
                    : "app-agent-message-bubble rounded-tl-sm border border-slate-800 bg-slate-900/80 pr-14 text-slate-300 shadow-slate-950/30",
                  message.role === "user" && originalPromptContent && "pr-14",
                  isEditing && "w-full pr-5",
                  isActiveEditing &&
                    "border border-sky-400/60 bg-sky-500/10 shadow-sky-950/35 ring-2 ring-sky-400/20",
                )}
                onContextMenu={
                  isEditing
                    ? undefined
                    : (event) =>
                        onOpenMessageContextMenu(
                          event,
                          message,
                          renderedContent,
                          canSaveMessageAsContextPack,
                        )
                }
              >
                {message.role === "agent" &&
                voicePlaybackSupported &&
                renderedContent.trim().length > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={
                      isSpeakingMessage
                        ? "Stop reading aloud"
                        : "Read response aloud"
                    }
                    tooltip={
                      isSpeakingMessage
                        ? "Stop reading aloud"
                        : "Read response aloud"
                    }
                    onClick={() => {
                      if (isSpeakingMessage) {
                        onStopSpeaking();
                        return;
                      }

                      onSpeakMessage(message);
                    }}
                    className={cn(
                      "app-message-voice-button absolute top-3 right-3 h-7 w-7 rounded-full border border-slate-800 bg-slate-950/70 text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                      isSpeakingMessage &&
                        "border-rose-500/30 text-rose-200 hover:text-rose-100",
                    )}
                  >
                    {isSpeakingMessage ? (
                      <Square className="h-3.5 w-3.5" />
                    ) : (
                      <Volume2 className="h-3.5 w-3.5 text-sky-300" />
                    )}
                  </Button>
                ) : null}

                {message.role === "user" &&
                originalPromptContent &&
                !isEditing ? (
                  <OriginalPromptToggle
                    expanded={isOriginalPromptExpanded}
                    panelId={originalPromptPanelId}
                    onToggle={() => onToggleOriginalPrompt(message.id)}
                  />
                ) : null}

                {isActiveEditing && !isEditing ? (
                  <span className="mb-2 inline-flex rounded-full border border-sky-300/30 bg-sky-400/10 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-sky-100">
                    Editing
                  </span>
                ) : null}

                {isEditing ? (
                  <MessageEditor
                    value={editContent}
                    onChange={onEditContentChange}
                    onCancel={onCancelEditing}
                    onSubmit={() => onEditMessage?.(message)}
                  />
                ) : (
                  <MarkdownContent
                    content={renderedContent}
                    workspaceRoot={workspaceRoot}
                    onOpenWorkspaceFile={openWorkspaceFile}
                    onOpenLocalFile={onOpenLocalFile}
                    className={
                      message.role === "user"
                        ? "app-user-message-text"
                        : undefined
                    }
                  />
                )}

                {isPromptEnhancementPlaceholder || isPromptEnhancing ? (
                  <PromptEnhancementPending
                    onCancel={onCancelPromptEnhancement}
                    className="mt-3"
                  />
                ) : null}
              </div>
            ) : null}

            {originalPromptContent && isOriginalPromptExpanded && !isEditing ? (
              <OriginalPromptPanel id={originalPromptPanelId}>
                <MarkdownContent
                  content={originalPromptContent}
                  workspaceRoot={workspaceRoot}
                  onOpenWorkspaceFile={openWorkspaceFile}
                  onOpenLocalFile={onOpenLocalFile}
                />
              </OriginalPromptPanel>
            ) : null}

            {messageAttachments.length > 0 ? (
              <MessageAttachmentsList
                attachments={messageAttachments}
                onOpen={openAttachment}
                align={message.role === "user" ? "end" : "start"}
              />
            ) : null}

            {message.role === "user" &&
            !message.taskAction &&
            onEditMessage &&
            !isEditing ? (
              <div className="app-message-actions flex max-w-[90%] items-center justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onEditMessage(message)}
                  className="h-7 rounded-full px-2.5 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                >
                  <Pencil className="mr-1.5 h-3.5 w-3.5" />
                  Edit
                </Button>
              </div>
            ) : null}

            {showInlineRetry ? (
              <div className="app-message-actions flex max-w-[90%] items-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={retryMessage}
                  className="h-7 rounded-full px-2.5 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                >
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                  Retry
                </Button>
              </div>
            ) : null}

            {message.source?.kind === "execution" ? (
              <ExecutionInsightRow
                fileChangeReader={taskFileChangeReader}
                execution={message.source.execution}
                onRetryTask={canRetryMessage ? retryMessage : undefined}
                onContinueTask={
                  canContinueMessage ? () => onContinueTask(message) : undefined
                }
                onOpenWorkspaceFile={openWorkspaceFile}
              />
            ) : null}

            {showCrashRecoveryActions ? (
              <div className="app-message-actions flex max-w-[90%] min-w-0 flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={retryMessage}
                  className="h-8 rounded-full border-amber-500/30 bg-amber-500/10 px-3 text-xs text-amber-100 hover:bg-amber-500/15 hover:text-white"
                >
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                  Retry
                </Button>
                {canContinueMessage ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onContinueTask(message)}
                    className="h-8 rounded-full border-emerald-500/30 bg-emerald-500/10 px-3 text-xs text-emerald-100 hover:bg-emerald-500/15 hover:text-white"
                  >
                    <Play className="mr-1.5 h-3.5 w-3.5" />
                    Continue
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
});

export const ConversationFeed = ({
  visibleMessages,
  hideEmptyState = false,
  poseScenePreview,
  promptEnhancementPreview = null,
  workspaceRoot,
  aiContextMessageLimit = DEFAULT_AI_CONTEXT_MESSAGE_LIMIT,
  isSessionRunning = false,
  bottomRef,
  onRetryTask,
  onRetryMessage,
  onEditMessage,
  onStartEditMessage,
  activeEditingMessageId = null,
  editingPromptEnhancement = null,
  onCancelPromptEnhancement,
  onContinueTask,
  onSaveMessageAsContextPack,
  onOpenWorkspaceFile,
  onOpenLocalFile,
  onOpenAttachment,
  voicePlayback,
}: ConversationFeedProps): JSX.Element => {
  const [messageContextMenu, setMessageContextMenu] =
    useState<MessageContextMenuTarget<ChatSessionMessage> | null>(null);
  const closeMessageContextMenu = useCallback(
    () => setMessageContextMenu(null),
    [],
  );
  const [expandedOriginalPromptIds, setExpandedOriginalPromptIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [renderedMessageLimit, setRenderedMessageLimit] = useState(
    INITIAL_RENDERED_MESSAGE_LIMIT,
  );
  const [selectedNavigationMessageId, setSelectedNavigationMessageId] =
    useState<string | null>(null);
  const [highlightedNavigationMessageId, setHighlightedNavigationMessageId] =
    useState<string | null>(null);
  const [navigationScrollTargetId, setNavigationScrollTargetId] = useState<
    string | null
  >(null);
  const messageElementsRef = useRef(new Map<string, HTMLDivElement>());
  const openCallbacksRef = useRef({
    onOpenWorkspaceFile,
    onOpenLocalFile,
    onOpenAttachment,
  });
  useLayoutEffect(() => {
    openCallbacksRef.current = {
      onOpenWorkspaceFile,
      onOpenLocalFile,
      onOpenAttachment,
    };
  }, [onOpenWorkspaceFile, onOpenLocalFile, onOpenAttachment]);
  const openLocalFile = useCallback((path: string, line?: number) => {
    openCallbacksRef.current.onOpenLocalFile?.(path, line);
  }, []);
  const openWorkspaceFile = useCallback(
    (
      relativePath: string,
      line?: number,
      messageWorkspaceRoot?: string | null,
    ) => {
      openCallbacksRef.current.onOpenWorkspaceFile(
        relativePath,
        line,
        messageWorkspaceRoot,
      );
    },
    [],
  );
  const openAttachment = useCallback(
    (
      attachment: ChatSessionContextAttachment,
      messageWorkspaceRoot?: string | null,
    ) => {
      openCallbacksRef.current.onOpenAttachment?.(
        attachment,
        messageWorkspaceRoot,
      );
    },
    [],
  );
  const navigationMessageIds = useMemo(
    () =>
      getNavigableConversationMessages(visibleMessages).map(
        (message) => message.id,
      ),
    [visibleMessages],
  );
  const navigationState = useMemo(
    () =>
      getConversationMessageNavigationState(
        visibleMessages,
        selectedNavigationMessageId,
      ),
    [selectedNavigationMessageId, visibleMessages],
  );

  const setMessageElement = useCallback(
    (messageId: string, element: HTMLDivElement | null): void => {
      if (element) {
        messageElementsRef.current.set(messageId, element);
        return;
      }

      messageElementsRef.current.delete(messageId);
    },
    [],
  );

  const navigateToMessage = useCallback(
    (message: ChatSessionMessage | null): void => {
      if (!message) {
        return;
      }

      setRenderedMessageLimit((currentLimit) =>
        getRenderedMessageLimitForTarget(
          visibleMessages,
          message.id,
          currentLimit,
        ),
      );
      setSelectedNavigationMessageId(message.id);
      setHighlightedNavigationMessageId(message.id);
      setNavigationScrollTargetId(message.id);
    },
    [visibleMessages],
  );
  const retryConversationMessage = useCallback(
    (message: ChatSessionMessage): void => {
      void onRetryMessage?.(message);
    },
    [onRetryMessage],
  );

  const toggleOriginalPrompt = useCallback((messageId: string): void => {
    setExpandedOriginalPromptIds((current) => {
      const next = new Set(current);

      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }

      return next;
    });
  }, []);

  const cancelEditing = useCallback((): void => {
    setEditingMessageId(null);
    setEditContent("");
  }, []);

  const startEditing = useCallback(
    (message: ChatSessionMessage): void => {
      if (onStartEditMessage) {
        onStartEditMessage(message);
        return;
      }

      setEditingMessageId(message.id);
      setEditContent(getRenderedMessageContent(message));
    },
    [onStartEditMessage],
  );

  const submitEditedMessage = useCallback(
    (message: ChatSessionMessage): void => {
      if (!onEditMessage?.(message, editContent)) {
        return;
      }

      cancelEditing();
    },
    [cancelEditing, editContent, onEditMessage],
  );

  useEffect(() => {
    if (
      editingMessageId &&
      (isSessionRunning ||
        !visibleMessages.some((message) => message.id === editingMessageId))
    ) {
      cancelEditing();
    }
  }, [cancelEditing, editingMessageId, isSessionRunning, visibleMessages]);

  useEffect(() => {
    if (
      !selectedNavigationMessageId ||
      navigationState.messages.some(
        (message) => message.id === selectedNavigationMessageId,
      )
    ) {
      return;
    }

    setSelectedNavigationMessageId(null);
    setHighlightedNavigationMessageId(null);
    setNavigationScrollTargetId(null);
  }, [navigationState.messages, selectedNavigationMessageId]);

  useEffect(() => {
    if (!highlightedNavigationMessageId) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setHighlightedNavigationMessageId(null);
    }, MESSAGE_NAVIGATION_HIGHLIGHT_DURATION_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [highlightedNavigationMessageId]);

  useLayoutEffect(() => {
    if (!navigationScrollTargetId) {
      return;
    }

    const targetElement = messageElementsRef.current.get(
      navigationScrollTargetId,
    );

    if (!targetElement) {
      return;
    }

    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    targetElement.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start",
      inline: "nearest",
    });
    setNavigationScrollTargetId(null);
  }, [navigationScrollTargetId, renderedMessageLimit, visibleMessages]);

  useLayoutEffect(() => {
    const firstMessageElement = messageElementsRef.current
      .values()
      .next().value;
    const scrollViewport = firstMessageElement?.closest<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );

    if (
      !scrollViewport ||
      !firstMessageElement ||
      navigationMessageIds.length === 0
    ) {
      return;
    }

    let animationFrameId: number | null = null;
    let previousScrollTop: number | null = null;
    const updateActiveMessage = (): void => {
      animationFrameId = null;

      const viewportBounds = scrollViewport.getBoundingClientRect();
      const viewportContentTop =
        viewportBounds.top +
        Number.parseFloat(
          window.getComputedStyle(firstMessageElement).scrollMarginTop,
        );
      const messageBounds = navigationMessageIds.flatMap((messageId) => {
        const element = messageElementsRef.current.get(messageId);

        if (!element) {
          return [];
        }

        const bounds = element.getBoundingClientRect();
        return [{ bottom: bounds.bottom, id: messageId, top: bounds.top }];
      });
      const distanceToBottom =
        scrollViewport.scrollHeight -
        scrollViewport.scrollTop -
        scrollViewport.clientHeight;
      const scrollingUp =
        previousScrollTop !== null &&
        scrollViewport.scrollTop < previousScrollTop;
      previousScrollTop = scrollViewport.scrollTop;
      const isAtBottom =
        distanceToBottom <= MESSAGE_NAVIGATION_SCROLL_EDGE_EPSILON_PX &&
        !scrollingUp;
      const visibleMessageId = getVisibleConversationMessageId(
        messageBounds,
        viewportContentTop,
        viewportBounds.bottom,
        isAtBottom,
      );

      if (visibleMessageId) {
        setSelectedNavigationMessageId((currentMessageId) =>
          currentMessageId === visibleMessageId
            ? currentMessageId
            : visibleMessageId,
        );
      }
    };
    const scheduleActiveMessageUpdate = (): void => {
      if (animationFrameId !== null) {
        return;
      }

      animationFrameId = window.requestAnimationFrame(updateActiveMessage);
    };

    scrollViewport.addEventListener("scroll", scheduleActiveMessageUpdate, {
      passive: true,
    });
    scheduleActiveMessageUpdate();

    return () => {
      scrollViewport.removeEventListener("scroll", scheduleActiveMessageUpdate);

      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
    };
  }, [navigationMessageIds, renderedMessageLimit]);

  const openMessageContextMenu = useCallback(
    (
      event: MouseEvent<HTMLDivElement>,
      message: ChatSessionMessage,
      content: string,
      canSaveAsContextPack: boolean,
    ): void => {
      event.preventDefault();
      event.stopPropagation();

      if (!content && !message.content && !canSaveAsContextPack) {
        setMessageContextMenu(null);
        return;
      }

      setMessageContextMenu({
        message,
        content,
        bubble: event.currentTarget,
        canSaveAsContextPack,
        left: event.clientX,
        top: event.clientY,
      });
    },
    [],
  );

  const conversationCommandStateRef = useRef({
    visibleMessages,
    hasEarlierMessages: visibleMessages.length > renderedMessageLimit,
    loadEarlierMessages: () =>
      setRenderedMessageLimit((limit) =>
        Math.min(visibleMessages.length, limit + RENDERED_MESSAGE_PAGE_SIZE),
      ),
    navigationState,
    selectedNavigationMessageId,
    isSessionRunning,
    activeEditingMessageId,
    editingMessageId,
    editContent,
    onRetryTask,
    onRetryMessage,
    onEditMessage,
    onStartEditMessage,
    onContinueTask,
    onSaveMessageAsContextPack,
    onOpenAttachment,
    workspaceRoot,
    voicePlayback,
    navigateToMessage,
    startEditing,
    submitEditedMessage,
    cancelEditing,
    toggleOriginalPrompt,
  });
  conversationCommandStateRef.current = {
    visibleMessages,
    hasEarlierMessages: visibleMessages.length > renderedMessageLimit,
    loadEarlierMessages: () =>
      setRenderedMessageLimit((limit) =>
        Math.min(visibleMessages.length, limit + RENDERED_MESSAGE_PAGE_SIZE),
      ),
    navigationState,
    selectedNavigationMessageId,
    isSessionRunning,
    activeEditingMessageId,
    editingMessageId,
    editContent,
    onRetryTask,
    onRetryMessage,
    onEditMessage,
    onStartEditMessage,
    onContinueTask,
    onSaveMessageAsContextPack,
    onOpenAttachment,
    workspaceRoot,
    voicePlayback,
    navigateToMessage,
    startEditing,
    submitEditedMessage,
    cancelEditing,
    toggleOriginalPrompt,
  };
  const conversationCommands = useMemo(
    () =>
      createConversationCommands({
        state: () => conversationCommandStateRef.current,
        getContent: getRenderedMessageContent,
        getRetryableMessageIds: getRetryableAgentMessageIds,
        canContinue: (message: ChatSessionMessage) =>
          message.source?.kind === "execution" ||
          isRecoveredTaskCrashMessage(message),
        canEdit: (message: ChatSessionMessage) =>
          message.role === "user" && !message.taskAction,
        canSaveAsContextPack: (message: ChatSessionMessage) =>
          message.role === "user",
        canSpeak: (message: ChatSessionMessage) => message.role === "agent",
        getOriginalPrompt: (message: ChatSessionMessage) =>
          getOriginalPromptContent(
            getRenderedMessageContent(message),
            message.promptEnhancement?.originalContent,
          ),
        getAttachments: (message: ChatSessionMessage) =>
          message.contextAttachments ?? [],
        getWorkspace: getMessageWorkspaceRoot,
      }),
    [],
  );
  useOptionalRegisterCommands(conversationCommands);

  if (visibleMessages.length === 0 && !promptEnhancementPreview) {
    if (hideEmptyState) {
      return (
        <div className="app-conversation-feed mx-auto flex w-full max-w-6xl min-w-0 flex-col px-4 pt-8 lg:px-6">
          {poseScenePreview}
          <div ref={bottomRef} className="h-2 shrink-0" />
        </div>
      );
    }
    return (
      <div className="app-conversation-empty mx-auto flex min-h-full max-w-2xl flex-col items-center justify-center py-16">
        <div className="flex flex-col items-center gap-6 text-center">
          <div className="app-conversation-empty-icon flex h-16 w-16 items-center justify-center rounded-3xl bg-sky-500/10 text-sky-300">
            <WandSparkles className="h-8 w-8" />
          </div>
          <div className="grid gap-2">
            <h2 className="text-xl font-medium text-white">
              Ready to automate
            </h2>
          </div>
        </div>
      </div>
    );
  }

  const normalizedAiContextMessageLimit = clampAiContextMessageLimit(
    aiContextMessageLimit,
  );
  const cutoffMessageId = getAiContextCutoffMessageId(
    visibleMessages,
    normalizedAiContextMessageLimit,
  );
  const promptEnhancementPreviewOriginalContent = promptEnhancementPreview
    ? getOriginalPromptContent(
        promptEnhancementPreview.content,
        promptEnhancementPreview.originalContent,
      )
    : null;
  const promptEnhancementPreviewExpanded = promptEnhancementPreview
    ? expandedOriginalPromptIds.has(promptEnhancementPreview.id)
    : false;
  const promptEnhancementPreviewPanelId = promptEnhancementPreview
    ? `original-prompt-${promptEnhancementPreview.id}`
    : "";
  const renderedMessages = visibleMessages.slice(-renderedMessageLimit);
  const activeEditingId = activeEditingMessageId ?? editingMessageId;
  const hasActiveMessageEdit = activeEditingId !== null;
  const hiddenMessageCount = visibleMessages.length - renderedMessages.length;
  const retryableAgentMessageIds = getRetryableAgentMessageIds(visibleMessages);
  const latestRetryableAgentMessageId =
    Array.from(retryableAgentMessageIds).at(-1) ?? null;
  const currentNavigationPosition =
    navigationState.currentIndex === null
      ? null
      : navigationState.currentIndex + 1;
  const navigationMessageCount = navigationState.messages.length;
  const activeNavigationMessageId = navigationState.currentMessage?.id ?? null;

  return (
    <div className="app-conversation-feed mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-6 pb-2 px-4 pt-8 lg:px-6">
      {activeNavigationMessageId && currentNavigationPosition ? (
        <nav
          aria-label="Message navigation"
          className="app-message-navigation sticky top-3 z-30 mx-auto flex items-center gap-1 rounded-full border border-slate-700 bg-slate-950/90 p-1 text-slate-300 shadow-lg shadow-slate-950/35 backdrop-blur-xl"
        >
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label="Previous message"
            disabled={!navigationState.previousMessage}
            onClick={() => navigateToMessage(navigationState.previousMessage)}
            className="h-7 rounded-full px-2 text-slate-300 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-35"
          >
            <ChevronUp className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Previous</span>
          </Button>
          <span
            role="status"
            aria-live="polite"
            aria-label={`Message ${currentNavigationPosition} of ${navigationMessageCount}`}
            className="min-w-12 px-1 text-center text-[0.6875rem] font-medium tabular-nums text-slate-400"
          >
            {currentNavigationPosition} / {navigationMessageCount}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label="Next message"
            disabled={!navigationState.nextMessage}
            onClick={() => navigateToMessage(navigationState.nextMessage)}
            className="h-7 rounded-full px-2 text-slate-300 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-35"
          >
            <span className="hidden sm:inline">Next</span>
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </nav>
      ) : null}
      {hiddenMessageCount > 0 ? (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setRenderedMessageLimit((current) =>
                Math.min(
                  visibleMessages.length,
                  current + RENDERED_MESSAGE_PAGE_SIZE,
                ),
              );
            }}
          >
            <History className="h-4 w-4" />
            Load earlier messages ({hiddenMessageCount})
          </Button>
        </div>
      ) : null}
      {renderedMessages.map((message) => {
        const messageWorkspaceRoot = getMessageWorkspaceRoot(
          message,
          visibleMessages,
          workspaceRoot,
        );

        return (
          <ConversationMessageRow
            key={getExecutionMessageRenderKey(message)}
            message={message}
            aiContextMessageLimit={normalizedAiContextMessageLimit}
            canContinueMessage={
              !isSessionRunning && message.id === latestRetryableAgentMessageId
            }
            canRetryMessage={
              !isSessionRunning && retryableAgentMessageIds.has(message.id)
            }
            editContent={editingMessageId === message.id ? editContent : ""}
            isEditing={editingMessageId === message.id}
            isActiveEditing={activeEditingId === message.id}
            isDimmedForEditing={
              hasActiveMessageEdit && activeEditingId !== message.id
            }
            isPromptEnhancing={
              editingPromptEnhancement?.messageId === message.id
            }
            isAiContextStart={cutoffMessageId === message.id}
            isNavigationHighlighted={
              highlightedNavigationMessageId === message.id
            }
            isNavigationTarget={activeNavigationMessageId === message.id}
            isOriginalPromptExpanded={expandedOriginalPromptIds.has(message.id)}
            isSpeakingMessage={voicePlayback.speakingMessageId === message.id}
            voicePlaybackSupported={voicePlayback.supported}
            workspaceRoot={messageWorkspaceRoot}
            onRetryTask={onRetryTask}
            onRetryMessage={
              onRetryMessage ? retryConversationMessage : undefined
            }
            onEditMessage={
              (onEditMessage || onStartEditMessage) &&
              !isSessionRunning &&
              !activeEditingMessageId
                ? editingMessageId === message.id
                  ? submitEditedMessage
                  : !editingMessageId
                    ? startEditing
                    : undefined
                : undefined
            }
            onEditContentChange={setEditContent}
            onCancelEditing={cancelEditing}
            onCancelPromptEnhancement={onCancelPromptEnhancement}
            onContinueTask={onContinueTask}
            onSaveMessageAsContextPack={onSaveMessageAsContextPack}
            onOpenWorkspaceFile={openWorkspaceFile}
            onOpenLocalFile={onOpenLocalFile ? openLocalFile : undefined}
            onMessageElementChange={setMessageElement}
            onOpenAttachment={onOpenAttachment ? openAttachment : undefined}
            onSpeakMessage={voicePlayback.onSpeakMessage}
            onStopSpeaking={voicePlayback.onStopSpeaking}
            onOpenMessageContextMenu={openMessageContextMenu}
            onToggleOriginalPrompt={toggleOriginalPrompt}
          />
        );
      })}
      {promptEnhancementPreview ? (
        <div
          key={promptEnhancementPreview.id}
          className="app-prompt-enhancement-preview-row contents"
        >
          <div className="app-message-row flex min-w-0 flex-row-reverse gap-4">
            <Avatar className="app-message-avatar mt-1 h-10 w-10 shrink-0 border border-emerald-500/20 bg-emerald-500/20">
              <div className="flex h-full w-full items-center justify-center">
                <User className="h-5 w-5 text-emerald-100" />
              </div>
            </Avatar>

            <div className="app-message-stack flex min-w-0 flex-1 flex-col items-end gap-3">
              <div
                className={cn(
                  "app-message-bubble app-user-message-bubble relative max-w-[90%] min-w-0 overflow-hidden rounded-[1.75rem] rounded-tr-md bg-slate-800 px-5 py-4 text-sm leading-7 text-slate-100 shadow-lg shadow-slate-950/20 wrap-break-word",
                  promptEnhancementPreviewOriginalContent && "pr-14",
                )}
              >
                {promptEnhancementPreviewOriginalContent ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={
                      promptEnhancementPreviewExpanded
                        ? "Hide original prompt"
                        : "View original prompt"
                    }
                    aria-expanded={promptEnhancementPreviewExpanded}
                    aria-controls={promptEnhancementPreviewPanelId}
                    tooltip={
                      promptEnhancementPreviewExpanded
                        ? "Hide original prompt"
                        : "View original prompt"
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleOriginalPrompt(promptEnhancementPreview.id);
                    }}
                    className="app-message-original-prompt-button absolute top-3 right-3 h-7 w-7 rounded-full border border-emerald-500/25 bg-slate-950/55 text-emerald-100 hover:bg-slate-900 hover:text-white"
                  >
                    <History className="h-3.5 w-3.5" />
                  </Button>
                ) : null}

                <MarkdownContent
                  content={promptEnhancementPreview.content}
                  workspaceRoot={workspaceRoot}
                  onOpenWorkspaceFile={onOpenWorkspaceFile}
                  onOpenLocalFile={onOpenLocalFile}
                  className="app-user-message-text"
                />
              </div>

              {promptEnhancementPreviewOriginalContent &&
              promptEnhancementPreviewExpanded ? (
                <div
                  id={promptEnhancementPreviewPanelId}
                  className="app-original-prompt-panel max-w-[90%] min-w-0 rounded-2xl border border-emerald-500/20 bg-slate-950/80 px-4 py-3 text-sm leading-6 text-slate-300 shadow-lg shadow-slate-950/20 wrap-break-word"
                >
                  <div className="mb-2 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-emerald-200/80">
                    Original prompt
                  </div>
                  <MarkdownContent
                    content={promptEnhancementPreviewOriginalContent}
                    workspaceRoot={workspaceRoot}
                    onOpenWorkspaceFile={onOpenWorkspaceFile}
                    onOpenLocalFile={onOpenLocalFile}
                  />
                </div>
              ) : null}

              {promptEnhancementPreview.contextAttachments.length > 0 ? (
                <MessageAttachmentsList
                  attachments={promptEnhancementPreview.contextAttachments}
                  onOpen={onOpenAttachment}
                  align="end"
                />
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      {messageContextMenu ? (
        <MessageContextMenu
          key={`${messageContextMenu.message.id}:${messageContextMenu.left}:${messageContextMenu.top}`}
          target={messageContextMenu}
          onClose={closeMessageContextMenu}
          onSaveAsContextPack={onSaveMessageAsContextPack}
        />
      ) : null}
      {poseScenePreview}
      <div ref={bottomRef} className="h-2 shrink-0" />
    </div>
  );
};
