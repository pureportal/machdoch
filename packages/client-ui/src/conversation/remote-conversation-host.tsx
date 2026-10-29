import { McpAppResults } from "../mcp-apps/results";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ProductConversation,
  type FleetOperationTransport,
  type RemoteConversationProps,
  getOriginalPromptContent,
  useConversationControls,
  useBrowserAppearance,
} from "@machdoch/product-ui";
import type { ProductMessage } from "@machdoch/fleet-protocol";
import type { FleetMediaTransport } from "@machdoch/media-studio/fleet-transport.js";
import type { ChatSessionContextAttachment } from "../composer/model";
import { MessageAttachmentsList } from "../composer/context-attachments";
import { toContextAttachment } from "../composer/remote-attachments";
import { useRemoteFilePreview } from "../file-preview/use-remote-file-preview";
import {
  MessageContextMenu,
  type MessageContextMenuTarget,
} from "./message-context-menu";
import { RemoteDirectoryPreview } from "./remote-directory-preview";
import { MarkdownContent } from "./markdown-content";
import { MessageEditor } from "./message-editor";
import { normalizeLocalPath } from "./workspace-markdown-links";
import { useRemoteConversationHistory } from "./use-remote-conversation-history";
import { TaskThinkingPanel } from "./task-thinking-panel";
import { AgentLiveRunDetails, formatQuestionAnswers } from "./agent-live-run-details";
import { FollowUpSuggestions } from "./follow-up-suggestions";
import { TaskTimeoutControls } from "./task-timeout-controls";
import { RemoteExecutionInsight } from "./remote-execution-insight";
import { taskTimeoutSchema } from "@machdoch/fleet-protocol/task-thinking";
import {
  createConversationCommands,
  type ConversationCommandState,
} from "./commands";
import {
  getConversationMessageNavigationState,
  getVisibleConversationMessageId,
} from "./message-navigation";
import { useOptionalRegisterCommands } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";

export function RemoteConversationHost({
  session,
  messages: snapshotMessages,
  pending,
  onCommand,
  workspaceTransport,
  mediaTransport,
  historyAvailable,
}: RemoteConversationProps & {
  workspaceTransport: FleetOperationTransport;
  mediaTransport: FleetMediaTransport;
}): React.ReactElement {
  const controls = useConversationControls();
  const appearance = useBrowserAppearance();
  const history = useRemoteConversationHistory({
    sessionId: session.id,
    messages: snapshotMessages,
    running: session.status === "running",
    enabled: historyAvailable,
    transport: workspaceTransport,
  });
  const messages = history.messages;
  const latestRunMessageId = useMemo(
    () => [...messages].reverse().find((message) => history.thinking.has(message.id))?.id,
    [messages, history.thinking],
  );
  // A remote view answers and continues through ordinary messages, which the
  // desktop routes to the waiting agent.
  const sendMessage = useCallback(
    async (prompt: string): Promise<void> => {
      const sent = await onCommand({
        kind: "submit-message",
        sessionId: session.id,
        prompt,
        promptEnhancementMode: "off",
        interviewEnabled: false,
      });
      if (!sent) throw new Error("The message could not be sent. Try again.");
    },
    [onCommand, session.id],
  );
  const [editContent, setEditContent] = useState("");
  const messageElements = useRef(new Map<string, HTMLElement>());
  const editorSubmit = useRef<(() => void) | null>(null);
  const registerEditor = useCallback((submit: (() => void) | null) => {
    editorSubmit.current = submit;
  }, []);
  const [menu, setMenu] =
    useState<MessageContextMenuTarget<ProductMessage> | null>(null);
  const [folder, setFolder] = useState<{
    attachment: Extract<ChatSessionContextAttachment, { source: "path" }>;
    workspace: string | null | undefined;
    messageId: string | undefined;
  } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const preview = useRemoteFilePreview({
    sessionId: session.id,
    workspace: session.workspace,
    workspaceTransport,
    mediaTransport,
  });
  const openWorkspaceFile = (
    relativePath: string,
    message: ProductMessage,
    line?: number,
    external?: boolean,
  ): void => {
    if (!message.workspace) return;
    const path = `${normalizeLocalPath(message.workspace).replace(/\/+$/u, "")}/${relativePath}`;
    preview.open(
      {
        source: "path",
        id: path,
        path,
        name: relativePath.split(/[\\/]/u).pop() ?? relativePath,
        kind: "file",
      },
      line,
      message.id,
      external,
    );
  };
  const openAttachment = useCallback(
    (
      attachment: ChatSessionContextAttachment,
      workspace?: string | null,
      messageId?: string,
    ) => {
      if (attachment.source === "path" && attachment.kind === "directory")
        setFolder({ attachment, workspace, messageId });
      else preview.open(attachment, undefined, messageId);
    },
    [preview.open],
  );
  useEffect(() => {
    setMenu(null);
    setFolder(null);
    controls.reset();
    setEditContent("");
  }, [session.id, session.workspace]);
  useEffect(() => {
    if (menu && !messages.some(({ id }) => id === menu.message.id))
      setMenu(null);
  }, [menu, messages]);
  useEffect(() => {
    if (
      controls.editingMessageId &&
      !messages.some(({ id }) => id === controls.editingMessageId)
    )
      controls.cancelEditing();
  }, [messages, controls.editingMessageId, controls.cancelEditing]);
  const commandState = useRef<ConversationCommandState<ProductMessage> | null>(
    null,
  );
  commandState.current = {
    visibleMessages: messages,
    navigationState: getConversationMessageNavigationState(
      messages,
      controls.selectedMessageId,
    ),
    selectedNavigationMessageId: controls.selectedMessageId,
    isSessionRunning:
      pending ||
      !history.ready ||
      history.loading ||
      session.status === "running",
    activeEditingMessageId: null,
    editingMessageId: controls.editingMessageId,
    editContent,
    onRetryTask: (message) => {
      if (message.taskId)
        void onCommand({ kind: "retry", taskId: message.taskId });
    },
    onRetryMessage: (message) => {
      if (message.actions.canReplay)
        void onCommand({
          kind: "replay-message",
          sessionId: session.id,
          messageId: message.id,
        });
      else if (message.actions.canRetry && message.taskId)
        void onCommand({ kind: "retry", taskId: message.taskId });
    },
    onStartEditMessage: (message) => controls.startEditing(message.id),
    onContinueTask: (message) => {
      if (message.taskId)
        void onCommand({ kind: "continue", taskId: message.taskId });
    },
    onSaveMessageAsContextPack: (message) => {
      void onCommand({
        kind: "save-message-context-pack",
        sessionId: session.id,
        messageId: message.id,
      });
    },
    onOpenAttachment: openAttachment,
    workspaceRoot: session.workspace,
    voicePlayback: {
      supported: messages.some((message) => message.actions.canSpeak),
      speakingMessageId:
        messages.find((message) => message.actions.isSpeaking)?.id ?? null,
      onSpeakMessage: (message) => {
        void onCommand({
          kind: "speak-message",
          sessionId: session.id,
          messageId: message.id,
        });
      },
      onStopSpeaking: () => {
        void onCommand({ kind: "stop-speaking" });
      },
    },
    navigateToMessage: (message) => {
      if (!message) return;
      controls.selectMessage(message.id);
      messageElements.current
        .get(message.id)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    startEditing: (message) => controls.startEditing(message.id),
    submitEditedMessage: () => editorSubmit.current?.(),
    cancelEditing: controls.cancelEditing,
    toggleOriginalPrompt: controls.toggleOriginalPrompt,
    hasEarlierMessages: history.hasEarlier,
    loadEarlierMessages: () => {
      void history.loadEarlier();
    },
  };
  const commands = useMemo(
    () =>
      createConversationCommands<ProductMessage>({
        state: () => {
          if (!commandState.current)
            throw new Error("The conversation is unavailable.");
          return commandState.current;
        },
        getContent: (message) => message.content,
        getRetryableMessageIds: (messages) =>
          new Set(
            messages
              .filter(
                (message) =>
                  message.actions.canReplay === true ||
                  message.actions.canRetry,
              )
              .map((message) => message.id),
          ),
        canContinue: (message) => message.actions.canContinue,
        canEdit: (message) => message.actions.canEdit === true,
        canSaveAsContextPack: (message) => message.actions.canSaveAsContextPack,
        canSpeak: (message) => message.actions.canSpeak,
        getOriginalPrompt: (message) =>
          getOriginalPromptContent(message.content, message.originalPrompt),
        getAttachments: (message) =>
          message.attachments.map(toContextAttachment),
        getWorkspace: (message) => message.workspace,
      }),
    [],
  );
  useOptionalRegisterCommands(commands);

  return (
    <>
      {history.error ? (
        <div role="alert" className="m-product-inline-error">
          {history.error}
          <button
            type="button"
            className="m-product-secondary-button"
            onClick={() => void history.reload()}
          >
            Reload history
          </button>
        </div>
      ) : null}
      {history.hasEarlier ? (
        <button
          type="button"
          className="m-product-secondary-button"
          disabled={history.loading}
          onClick={() => void history.loadEarlier()}
        >
          Load earlier messages
        </button>
      ) : null}
      <ProductConversation
        renderInsights={(message) => {
          const execution = history.executions.get(message.id);
          if (!execution) return undefined;
          return (
            <RemoteExecutionInsight
              showChangedFiles={appearance.settings.showChangedFiles}
              sessionId={session.id}
              message={message}
              execution={execution}
              transport={workspaceTransport}
              onCommand={onCommand}
              enabled={
                !pending && session.status !== "running" && history.ready
              }
              onOpenWorkspaceFile={(path) => openWorkspaceFile(path, message)}
            />
          );
        }}
        renderActivity={(message) => {
          const thinking = history.thinking.get(message.id);
          if (!thinking && !message.mcpAppIds?.length) return null;
          return (
            <>
            <McpAppResults thinking={thinking} appIds={message.mcpAppIds} workspaceRoot={message.workspace ?? session.workspace} invoke={(root, input) => workspaceTransport.invoke("run_mcp_app_command", { workspaceRoot: root, input })} />
            {thinking && <TaskThinkingPanel
              thinking={thinking}
              timeoutControls={
                message.taskId && thinking.timeout?.idleTimeoutMs ? (
                  <TaskTimeoutControls
                    idleTimeoutMs={thinking.timeout.idleTimeoutMs}
                    bounds={{ min: 1, max: 1440 }}
                    onReset={async (minutes) => {
                      const timeout = taskTimeoutSchema.parse(
                        await workspaceTransport.invoke(
                          "reset_desktop_task_timeout",
                          {
                            taskId: message.taskId,
                            ...(minutes === undefined
                              ? {}
                              : { idleTimeoutMinutes: minutes }),
                          },
                        ),
                      );
                      history.updateTimeout(message.id, timeout);
                    }}
                  />
                ) : null
              }
            />}
            {thinking?.agentLive ? (
              <AgentLiveRunDetails
                live={thinking.agentLive}
                running={thinking.status === "running" && session.status === "running"}
                onAnswer={async (_questionId, answers) => {
                  const question = thinking.agentLive?.question;
                  if (question) await sendMessage(formatQuestionAnswers(question, answers));
                }}
                onSendMessage={(text) => {
                  void sendMessage(text);
                }}
              />
            ) : null}
            {message.id === latestRunMessageId && session.status !== "running" ? (
              <FollowUpSuggestions
                suggestions={thinking?.agentLive?.suggestions ?? []}
                disabled={pending}
                onPick={(prompt) => {
                  void onCommand({ kind: "update-draft", sessionId: session.id, prompt });
                }}
                onSend={(prompt) => {
                  void sendMessage(prompt);
                }}
              />
            ) : null}
            </>
          );
        }}
        messages={messages}
        sessionId={session.id}
        pending={pending || !history.ready || history.loading}
        onCommand={onCommand}
        controls={controls}
        onMessageElementChange={(id, element) => {
          if (element) messageElements.current.set(id, element);
          else messageElements.current.delete(id);
        }}
        onViewportChange={(element) => {
          const viewport = element.getBoundingClientRect();
          const bounds = getConversationMessageNavigationState(
            messages,
            null,
          ).messages.flatMap(({ id }) => {
            const rectangle = messageElements.current
              .get(id)
              ?.getBoundingClientRect();
            return rectangle
              ? [{ id, top: rectangle.top, bottom: rectangle.bottom }]
              : [];
          });
          const visible = getVisibleConversationMessageId(
            bounds,
            viewport.top,
            viewport.bottom,
            element.scrollHeight - element.scrollTop - element.clientHeight <=
              64,
          );
          if (visible) controls.selectMessage(visible);
        }}
        renderEditor={(message, onClose) => (
          <RemoteMessageEditor
            key={message.id}
            message={message}
            sessionId={session.id}
            pending={pending}
            onCommand={onCommand}
            onClose={onClose}
            onValueChange={setEditContent}
            registerSubmit={registerEditor}
          />
        )}
        renderContent={(content, className, message) => (
          <MarkdownContent
            content={content}
            className={className}
            workspaceRoot={message?.workspace ?? null}
            onOpenWorkspaceFile={(relativePath, line, external) => {
              if (message)
                openWorkspaceFile(relativePath, message, line, external);
            }}
            onOpenLocalFile={(path, line, external) =>
              preview.open(
                {
                  source: "path",
                  id: path,
                  path,
                  name: path.split(/[\\/]/u).pop() ?? path,
                  kind: "file",
                },
                line,
                message?.id,
                external,
              )
            }
          />
        )}
        renderAttachments={(attachments, isUser, message) => (
          <MessageAttachmentsList
            attachments={attachments.map(toContextAttachment)}
            align={isUser ? "end" : "start"}
            onOpen={(attachment) =>
              openAttachment(attachment, message?.workspace, message?.id)
            }
          />
        )}
        onOpenContextMenu={(event, message) => {
          if (!message.content && !message.actions.canSaveAsContextPack) return;
          event.preventDefault();
          event.stopPropagation();
          setMenu({
            message: {
              ...message,
              content: message.rawContent ?? message.content,
            },
            content: message.content,
            bubble: event.currentTarget,
            canSaveAsContextPack: message.actions.canSaveAsContextPack,
            left: event.clientX,
            top: event.clientY,
          });
        }}
      />
      {menu ? (
        <MessageContextMenu
          key={`${menu.message.id}:${menu.left}:${menu.top}`}
          target={menu}
          onClose={closeMenu}
          onSaveAsContextPack={async (message) => {
            if (
              !(await onCommand({
                kind: "save-message-context-pack",
                sessionId: session.id,
                messageId: message.id,
              }))
            )
              throw new Error(
                "The context pack could not be saved. Try again.",
              );
          }}
        />
      ) : null}
      {folder ? (
        <RemoteDirectoryPreview
          key={`${session.id}:${folder.attachment.path}`}
          folder={folder.attachment}
          workspace={folder.workspace ?? undefined}
          transport={workspaceTransport}
          onOpenFile={(attachment) =>
            preview.open(attachment, undefined, folder.messageId)
          }
          onClose={() => setFolder(null)}
        />
      ) : null}
      {preview.error ? (
        <p role="alert" className="m-product-inline-error">
          {preview.error}
        </p>
      ) : null}
      {preview.dialog}
    </>
  );
}

function RemoteMessageEditor({
  message,
  sessionId,
  pending,
  onCommand,
  onClose,
  onValueChange,
  registerSubmit,
}: {
  message: ProductMessage;
  sessionId: string;
  pending: boolean;
  onCommand: RemoteConversationProps["onCommand"];
  onClose: () => void;
  onValueChange: (value: string) => void;
  registerSubmit: (submit: (() => void) | null) => void;
}): React.ReactElement {
  const [value, setValue] = useState(message.content);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submit = async (): Promise<void> => {
    if (pending || submitting || !value.trim()) return;
    setError(null);
    setSubmitting(true);
    try {
      if (
        !(await onCommand({
          kind: "edit-message",
          sessionId,
          messageId: message.id,
          prompt: value,
        }))
      )
        throw new Error("The message could not be submitted. Try again.");
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  };
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    registerSubmit(() => void submitRef.current());
    return () => registerSubmit(null);
  }, [registerSubmit]);
  useEffect(() => onValueChange(value), [value, onValueChange]);
  return (
    <>
      <MessageEditor
        value={value}
        pending={pending || submitting}
        onChange={setValue}
        onCancel={onClose}
        onSubmit={() => void submit()}
      />
      {error ? (
        <p role="alert" className="m-product-inline-error">
          {error}
        </p>
      ) : null}
    </>
  );
}
