import {
  asPaletteCommands,
  type CommandDefinition,
  type CommandPageItem,
} from "@machdoch/media-studio/tauri/ui/commands/command-types.js";
import type { ChatSessionContextAttachment } from "../composer/model";
import type { ConversationMessageNavigationState } from "./message-navigation";
import {
  copyMessageText,
  createMessageMarkdownFileName,
  saveMessageMarkdown,
} from "./message-export";

export interface ConversationCommandMessage {
  id: string;
  role: string;
  content: string;
  createdAt?: number | undefined;
}

export interface ConversationCommandState<
  T extends ConversationCommandMessage,
> {
  visibleMessages: readonly T[];
  navigationState: ConversationMessageNavigationState<T>;
  selectedNavigationMessageId: string | null;
  isSessionRunning: boolean;
  activeEditingMessageId: string | null | undefined;
  editingMessageId: string | null;
  editContent: string;
  onRetryTask: (message: T) => void;
  onRetryMessage?: ((message: T) => void) | undefined;
  onEditMessage?: ((message: T, content: string) => unknown) | undefined;
  onStartEditMessage?: ((message: T) => void) | undefined;
  onContinueTask: (message: T) => void;
  onSaveMessageAsContextPack?: ((message: T) => void) | undefined;
  onOpenAttachment?:
    | ((
        attachment: ChatSessionContextAttachment,
        workspace?: string | null,
        messageId?: string,
      ) => void)
    | undefined;
  workspaceRoot?: string | null | undefined;
  voicePlayback: {
    supported: boolean;
    speakingMessageId: string | null;
    onSpeakMessage: (message: T) => void;
    onStopSpeaking: () => void;
  };
  navigateToMessage: (message: T | null) => void;
  startEditing: (message: T) => void;
  submitEditedMessage: (message: T) => void;
  cancelEditing: () => void;
  toggleOriginalPrompt: (messageId: string) => void;
  hasEarlierMessages: boolean;
  loadEarlierMessages: () => void;
}

export function createConversationCommands<
  T extends ConversationCommandMessage,
>({
  state,
  getContent,
  getRetryableMessageIds,
  canContinue,
  canEdit,
  canSaveAsContextPack,
  canSpeak,
  getOriginalPrompt,
  getAttachments,
  getWorkspace,
}: {
  state: () => ConversationCommandState<T>;
  getContent: (message: T) => string;
  getRetryableMessageIds: (messages: readonly T[]) => ReadonlySet<string>;
  canContinue: (message: T) => boolean;
  canEdit: (message: T) => boolean;
  canSaveAsContextPack: (message: T) => boolean;
  canSpeak: (message: T) => boolean;
  getOriginalPrompt: (message: T) => string | null;
  getAttachments: (message: T) => readonly ChatSessionContextAttachment[];
  getWorkspace: (
    message: T,
    messages: readonly T[],
    workspace?: string | null,
  ) => string | null | undefined;
}): readonly CommandDefinition[] {
  const getMessageTitle = (message: T, index: number): string =>
    getContent(message).trim().replace(/\s+/gu, " ").slice(0, 96) ||
    (message.role === "agent" ? "Assistant" : "User") +
      " message " +
      (index + 1);
  const scope = { kind: "view", ownerId: "chat" } as const;
  const numericKey = (index: number): CommandPageItem["numericKey"] =>
    index < 9 ? (`${index + 1}` as CommandPageItem["numericKey"]) : undefined;
  const renderedMessages = () =>
    state().visibleMessages.filter(
      (message) => getContent(message).trim().length > 0,
    );
  const retryableMessages = () => {
    const current = state();
    const ids = getRetryableMessageIds(current.visibleMessages);
    return current.visibleMessages.filter((message) => ids.has(message.id));
  };
  const continuableMessage = (): T | undefined => {
    const message = retryableMessages().at(-1);
    return message && canContinue(message) ? message : undefined;
  };
  const retry = (message: T): void => {
    const current = state();
    if (current.onRetryMessage) {
      current.onRetryMessage(message);
      return;
    }
    current.onRetryTask(message);
  };
  return asPaletteCommands([
    {
      id: "chat.messages.navigate",
      title: "Go to message",
      group: "Chat messages",
      scope,
      availability: () =>
        state().navigationState.messages.length > 0
          ? { state: "enabled" }
          : { state: "hidden" },
      children: () => ({
        id: "chat.messages.navigate.page",
        title: "Go to message",
        searchPlaceholder: "Search messages",
        numericSelection: true,
        groups: [
          {
            id: "messages",
            items: state().navigationState.messages.map((message, index) => ({
              id: message.id,
              title: getMessageTitle(message, index),
              current: state().selectedNavigationMessageId === message.id,
              numericKey: numericKey(index),
              execute: () => state().navigateToMessage(message),
            })),
          },
        ],
      }),
    },
    {
      id: "chat.messages.previous",
      title: "Go to previous message",
      group: "Chat messages",
      scope,
      availability: () =>
        state().navigationState.previousMessage
          ? { state: "enabled" }
          : { state: "hidden" },
      execute: () =>
        state().navigateToMessage(state().navigationState.previousMessage),
    },
    {
      id: "chat.messages.next",
      title: "Go to next message",
      group: "Chat messages",
      scope,
      availability: () =>
        state().navigationState.nextMessage
          ? { state: "enabled" }
          : { state: "hidden" },
      execute: () =>
        state().navigateToMessage(state().navigationState.nextMessage),
    },
    {
      id: "chat.messages.load-earlier",
      title: "Load earlier messages",
      group: "Chat messages",
      scope,
      availability: () =>
        state().hasEarlierMessages
          ? { state: "enabled" }
          : { state: "hidden" },
      execute: () => state().loadEarlierMessages(),
    },
    {
      id: "chat.message.retry",
      title: "Retry message",
      group: "Chat messages",
      scope,
      availability: () =>
        state().isSessionRunning
          ? { state: "disabled", reason: "A task is already running." }
          : retryableMessages().length > 0
            ? { state: "enabled" }
            : { state: "hidden" },
      children: () => ({
        id: "chat.message.retry.page",
        title: "Retry message",
        searchPlaceholder: "Search messages",
        groups: [
          {
            id: "messages",
            items: retryableMessages().map((message, index) => ({
              id: message.id,
              title: getMessageTitle(message, index),
              execute: () => retry(message),
            })),
          },
        ],
      }),
    },
    {
      id: "chat.message.continue",
      title: "Continue latest recoverable task",
      group: "Chat messages",
      scope,
      availability: () =>
        state().isSessionRunning
          ? { state: "disabled", reason: "A task is already running." }
          : continuableMessage()
            ? { state: "enabled" }
            : { state: "hidden" },
      execute: () => {
        const message = continuableMessage();
        if (message) state().onContinueTask(message);
      },
    },
    {
      id: "chat.message.edit",
      title: "Edit message",
      group: "Chat messages",
      scope,
      availability: () => {
        const current = state();
        if (!current.onEditMessage && !current.onStartEditMessage)
          return { state: "hidden" };
        return current.isSessionRunning
          ? { state: "disabled", reason: "A task is already running." }
          : current.visibleMessages.some((message) => canEdit(message))
            ? { state: "enabled" }
            : { state: "hidden" };
      },
      children: () => ({
        id: "chat.message.edit.page",
        title: "Edit message",
        searchPlaceholder: "Search messages",
        groups: [
          {
            id: "messages",
            items: state()
              .visibleMessages.filter((message) => canEdit(message))
              .map((message, index) => ({
                id: message.id,
                title: getMessageTitle(message, index),
                current:
                  state().editingMessageId === message.id ||
                  state().activeEditingMessageId === message.id,
                availability:
                  state().activeEditingMessageId === message.id
                    ? {
                        state: "disabled",
                        reason: "This message is already being edited.",
                      }
                    : { state: "enabled" },
                execute: () => state().startEditing(message),
              })),
          },
        ],
      }),
    },
    {
      id: "chat.message.edit.submit",
      title: "Save and submit edited message",
      group: "Chat messages",
      scope,
      availability: () =>
        state().editingMessageId
          ? state().editContent.trim()
            ? { state: "enabled" }
            : { state: "disabled", reason: "Enter a message first." }
          : { state: "hidden" },
      execute: () => {
        const current = state();
        const message = current.visibleMessages.find(
          (candidate) => candidate.id === current.editingMessageId,
        );
        if (message) current.submitEditedMessage(message);
      },
    },
    {
      id: "chat.message.edit.cancel",
      title: "Cancel message edit",
      group: "Chat messages",
      scope,
      availability: () =>
        state().editingMessageId ? { state: "enabled" } : { state: "hidden" },
      execute: () => state().cancelEditing(),
    },
    {
      id: "chat.message.speak",
      title: "Read message aloud",
      group: "Chat messages",
      scope,
      availability: () =>
        !state().voicePlayback.supported
          ? { state: "hidden" }
          : renderedMessages().some(canSpeak)
            ? { state: "enabled" }
            : { state: "hidden" },
      children: () => ({
        id: "chat.message.speak.page",
        title: "Read message aloud",
        searchPlaceholder: "Search messages",
        groups: [
          {
            id: "messages",
            items: renderedMessages()
              .filter(canSpeak)
              .map((message, index) => ({
                id: message.id,
                title: getMessageTitle(message, index),
                current: state().voicePlayback.speakingMessageId === message.id,
                execute: () => {
                  const current = state().voicePlayback;
                  if (current.speakingMessageId === message.id)
                    current.onStopSpeaking();
                  else current.onSpeakMessage(message);
                },
              })),
          },
        ],
      }),
    },
    {
      id: "chat.message.speech.stop",
      title: "Stop reading message aloud",
      group: "Chat messages",
      scope,
      availability: () =>
        state().voicePlayback.speakingMessageId
          ? { state: "enabled" }
          : { state: "hidden" },
      execute: () => state().voicePlayback.onStopSpeaking(),
    },
    {
      id: "chat.message.copy-markdown",
      title: "Copy message Markdown",
      group: "Chat messages",
      scope,
      availability: () =>
        renderedMessages().length > 0
          ? { state: "enabled" }
          : { state: "hidden" },
      children: () => ({
        id: "chat.message.copy-markdown.page",
        title: "Copy message Markdown",
        searchPlaceholder: "Search messages",
        groups: [
          {
            id: "messages",
            items: renderedMessages().map((message, index) => ({
              id: message.id,
              title: getMessageTitle(message, index),
              execute: () => copyMessageText(getContent(message)),
            })),
          },
        ],
      }),
    },
    {
      id: "chat.message.save-markdown",
      title: "Save message Markdown",
      group: "Chat messages",
      scope,
      availability: () =>
        renderedMessages().length > 0
          ? { state: "enabled" }
          : { state: "hidden" },
      children: () => ({
        id: "chat.message.save-markdown.page",
        title: "Save message Markdown",
        searchPlaceholder: "Search messages",
        groups: [
          {
            id: "messages",
            items: renderedMessages().map((message, index) => ({
              id: message.id,
              title: getMessageTitle(message, index),
              execute: () =>
                saveMessageMarkdown(
                  getContent(message),
                  createMessageMarkdownFileName(message),
                ),
            })),
          },
        ],
      }),
    },
    {
      id: "chat.message.context-pack.save",
      title: "Save message as context pack",
      group: "Chat messages",
      scope,
      availability: () =>
        state().onSaveMessageAsContextPack &&
        state().visibleMessages.some(canSaveAsContextPack)
          ? { state: "enabled" }
          : { state: "hidden" },
      children: () => ({
        id: "chat.message.context-pack.save.page",
        title: "Save message as context pack",
        searchPlaceholder: "Search messages",
        groups: [
          {
            id: "messages",
            items: state()
              .visibleMessages.filter(canSaveAsContextPack)
              .map((message, index) => ({
                id: message.id,
                title: getMessageTitle(message, index),
                execute: () => state().onSaveMessageAsContextPack?.(message),
              })),
          },
        ],
      }),
    },
    {
      id: "chat.message.original-prompt.toggle",
      title: "Show or hide original prompt",
      group: "Chat messages",
      scope,
      availability: () =>
        state().visibleMessages.some(
          (message) => message.role === "user" && getOriginalPrompt(message),
        )
          ? { state: "enabled" }
          : { state: "hidden" },
      children: () => ({
        id: "chat.message.original-prompt.toggle.page",
        title: "Show or hide original prompt",
        searchPlaceholder: "Search messages",
        groups: [
          {
            id: "messages",
            items: state()
              .visibleMessages.filter(
                (message) =>
                  message.role === "user" && getOriginalPrompt(message),
              )
              .map((message, index) => ({
                id: message.id,
                title: getMessageTitle(message, index),
                execute: () => state().toggleOriginalPrompt(message.id),
              })),
          },
        ],
      }),
    },
    {
      id: "chat.message.attachment.open",
      title: "Open message attachment",
      group: "Chat messages",
      scope,
      availability: () =>
        state().onOpenAttachment &&
        state().visibleMessages.some(
          (message) => getAttachments(message).length > 0,
        )
          ? { state: "enabled" }
          : { state: "hidden" },
      children: () => ({
        id: "chat.message.attachment.open.page",
        title: "Open message attachment",
        searchPlaceholder: "Search attachments",
        groups: [
          {
            id: "attachments",
            items: state().visibleMessages.flatMap((message) =>
              getAttachments(message).map((attachment) => ({
                id: `${message.id}:${attachment.id}`,
                title: attachment.name,
                keywords: [
                  "path" in attachment ? attachment.path : attachment.assetId,
                ],
                execute: () => {
                  const current = state();
                  current.onOpenAttachment?.(
                    attachment,
                    getWorkspace(
                      message,
                      current.visibleMessages,
                      current.workspaceRoot,
                    ),
                    message.id,
                  );
                },
              })),
            ),
          },
        ],
      }),
    },
  ]);
}
