import { useCallback, useMemo, useState } from "react";
import {
  getSessionTitle,
  type ChatSessionMessage,
  type ChatSessionMessageReference,
  type ChatSessionRecord,
} from "../../chat-session.model";
import {
  canReceiveSharedMessage,
  createSharedMessagePrompt,
  getDefaultSharedMessageId,
  type MessageShareDraft,
} from "./message-sharing";

interface MessageSharingOptions {
  sessions: readonly ChatSessionRecord[];
  activeSessionId: string;
  onActivateSession: (sessionId: string) => void;
  onSubmitMessage: (input: {
    sessionId: string;
    prompt: string;
    reference: ChatSessionMessageReference;
  }) => boolean;
}

export function useMessageSharing({
  sessions,
  activeSessionId,
  onActivateSession,
  onSubmitMessage,
}: MessageSharingOptions) {
  const [draft, setDraft] = useState<MessageShareDraft | null>(null);
  const [navigationRequest, setNavigationRequest] =
    useState<ChatSessionMessageReference | null>(null);
  const sortedSessions = useMemo(
    () => [...sessions].sort((left, right) => right.updatedAt - left.updatedAt),
    [sessions],
  );
  const findSession = (sessionId: string) =>
    sessions.find((session) => session.id === sessionId);

  const shareMessage = (message: ChatSessionMessage): void =>
    setDraft({
      sourceSessionId: activeSessionId,
      messageId: message.id,
      targetSessionId: null,
    });

  const shareSessionMessage = (sessionId: string): void => {
    const source = findSession(sessionId);
    const active = findSession(activeSessionId);
    if (!source) return;
    setDraft({
      sourceSessionId: source.id,
      messageId: getDefaultSharedMessageId(source),
      targetSessionId:
        active && active.id !== source.id && canReceiveSharedMessage(active)
          ? active.id
          : null,
    });
  };

  const sendDraft = (current: MessageShareDraft): void => {
    const source = findSession(current.sourceSessionId);
    const message = source?.messages.find(
      (entry) => entry.id === current.messageId,
    );
    if (!source || !message || !current.targetSessionId) return;
    if (
      onSubmitMessage({
        sessionId: current.targetSessionId,
        prompt: createSharedMessagePrompt(getSessionTitle(source), message),
        reference: { sessionId: source.id, messageId: message.id },
      })
    )
      setDraft(null);
  };

  const getReferenceTitle = (
    reference: ChatSessionMessageReference,
  ): string | null => {
    const source = findSession(reference.sessionId);
    return source?.messages.some(
      (message) => message.id === reference.messageId,
    )
      ? getSessionTitle(source)
      : null;
  };

  const openReference = (reference: ChatSessionMessageReference): void => {
    onActivateSession(reference.sessionId);
    setNavigationRequest(reference);
  };

  const clearNavigationRequest = useCallback(
    () => setNavigationRequest(null),
    [],
  );

  return {
    shareMessage,
    shareSessionMessage,
    getReferenceTitle,
    openReference,
    navigationRequestMessageId:
      navigationRequest?.sessionId === activeSessionId
        ? navigationRequest.messageId
        : null,
    clearNavigationRequest,
    dialog: {
      draft,
      sessions: sortedSessions,
      onDraftChange: setDraft,
      onClose: () => setDraft(null),
      onSend: sendDraft,
    },
  };
}
