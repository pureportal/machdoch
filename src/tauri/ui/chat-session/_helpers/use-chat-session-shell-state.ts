import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  createInitialShellState,
  createVisibleConversationMessages,
  getLatestCompletedSessionResponseAt,
  getLatestRunningTaskId,
  getSessionTitle,
  isQuickVoiceSession,
  markSessionRead,
  mergeRecentWorkspacesForPersistence,
  normalizeShellState,
  recoverInterruptedTasksForLaunch,
  sortSessionsByUpdatedAt,
  type ChatSessionMessage,
  type ChatSessionQueuedMessage,
  type ChatSessionRecord,
  type SmartContextPack,
  type ShellPersistedState,
} from "../../chat-session.model";
import {
  broadcastShellStateChanged,
  getCurrentShellWindowLabel,
  loadShellState,
  saveShellState,
  subscribeToShellStateChanged,
} from "../../lib/shell-store";
import {
  loadActiveDesktopTaskIds,
  loadDesktopLaunchId,
} from "../../runtime";
import {
  type SessionScopeFilter,
  type SessionStatusFilterSelection,
  type SettingsSection,
} from "./session-shell";
import {
  ALL_SESSION_PROJECTS_FILTER,
  createSessionHistoryIndex,
  filterSessionHistoryIndex,
  type SessionHistoryIndex,
  type SessionHistoryIndexEntryCache,
  type SessionHistoryProjectFacet,
  type SessionHistoryTagFacet,
} from "./session-history-index";
import { useNewestMessageScroll } from "./use-newest-message-scroll";

const serializeShellFragment = (value: unknown): string => {
  return JSON.stringify(value);
};

const SHELL_STATE_PERSIST_DELAY_MS = 120;

const getSessionPersistenceTimestamp = (
  session: ChatSessionRecord,
): number => {
  let timestamp = Math.max(
    session.updatedAt,
    session.composerUpdatedAt ?? 0,
    session.lastReadAt ?? 0,
    session.archivedAt ?? 0,
    session.pinnedAt ?? 0,
  );

  for (const message of session.messages) {
    timestamp = Math.max(timestamp, message.createdAt ?? 0);
  }

  return timestamp;
};

const areShellFragmentsEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) {
    return true;
  }

  return serializeShellFragment(left) === serializeShellFragment(right);
};

const isMessageVersionRegression = (
  currentMessage: ChatSessionMessage,
  incomingMessage: ChatSessionMessage,
): boolean => {
  if (currentMessage.id !== incomingMessage.id) {
    return false;
  }

  const currentAttachments = currentMessage.contextAttachments ?? [];
  const incomingAttachments = incomingMessage.contextAttachments ?? [];

  if (incomingAttachments.length < currentAttachments.length) {
    return true;
  }

  if (currentMessage.content.trim() && !incomingMessage.content.trim()) {
    return true;
  }

  const currentSource = currentMessage.source;
  const incomingSource = incomingMessage.source;

  if (currentSource && !incomingSource) {
    return true;
  }

  if (!currentSource || !incomingSource) {
    return false;
  }

  if (currentSource.kind === "execution") {
    if (incomingSource.kind !== "execution") {
      return true;
    }

    const currentResponseMarkdown =
      currentSource.execution.response?.markdown.trim() ?? "";
    const incomingResponseMarkdown =
      incomingSource.execution.response?.markdown.trim() ?? "";

    return Boolean(currentResponseMarkdown && !incomingResponseMarkdown);
  }

  if (currentSource.kind === "thinking") {
    if (incomingSource.kind === "execution") {
      return false;
    }

    if (incomingSource.kind !== "thinking") {
      return true;
    }

    const currentTimelineEvents =
      currentSource.thinking.timelineEvents?.length ?? 0;
    const incomingTimelineEvents =
      incomingSource.thinking.timelineEvents?.length ?? 0;

    if (
      currentSource.thinking.status === "complete" &&
      incomingSource.thinking.status !== "complete"
    ) {
      return true;
    }

    if (
      incomingSource.thinking.entries.length <
      currentSource.thinking.entries.length
    ) {
      return true;
    }

    if (incomingTimelineEvents < currentTimelineEvents) {
      return true;
    }

    return Boolean(
      currentSource.thinking.assistantText?.trim() &&
        !incomingSource.thinking.assistantText?.trim(),
    );
  }

  return false;
};

const isMessageSafelyReplaced = (
  message: ChatSessionMessage,
  candidateMessages: readonly ChatSessionMessage[],
): boolean => {
  if (message.role !== "agent" || !message.taskId) {
    return false;
  }

  return candidateMessages.some(
    (candidate) =>
      candidate.taskId === message.taskId &&
      candidate.role === "agent" &&
      candidate.id !== message.id &&
      (candidate.source?.kind === "execution" ||
        (candidate.source === undefined && candidate.content.trim().length > 0)),
  );
};

const isPromptEnhancementPlaceholderMessage = (
  message: ChatSessionMessage,
): boolean => {
  const taskId = message.taskId;

  if (!taskId?.startsWith("prompt-enhancement-")) {
    return false;
  }

  return message.id === `${taskId}-user` || message.id === `${taskId}-thinking`;
};

const hasMessageRegression = (
  currentMessages: readonly ChatSessionMessage[],
  incomingMessages: readonly ChatSessionMessage[],
): boolean => {
  const incomingMessagesById = new Map(
    incomingMessages.map((message) => [message.id, message]),
  );

  for (const currentMessage of currentMessages) {
    const incomingMessage = incomingMessagesById.get(currentMessage.id);

    if (!incomingMessage) {
      if (isPromptEnhancementPlaceholderMessage(currentMessage)) {
        continue;
      }

      if (!isMessageSafelyReplaced(currentMessage, incomingMessages)) {
        return true;
      }

      continue;
    }

    if (isMessageVersionRegression(currentMessage, incomingMessage)) {
      return true;
    }
  }

  return false;
};

const mergeSessionRuntimeSelection = (
  primarySession: ChatSessionRecord,
  localSession: ChatSessionRecord,
  baseSession: ChatSessionRecord,
  latestSession: ChatSessionRecord,
): ChatSessionRecord => {
  const localProviderChanged = localSession.provider !== baseSession.provider;
  const latestProviderChanged = latestSession.provider !== baseSession.provider;
  const localModelChanged = localSession.model !== baseSession.model;
  const latestModelChanged = latestSession.model !== baseSession.model;
  let mergedSession = primarySession;

  if (!localProviderChanged && latestProviderChanged) {
    mergedSession = {
      ...mergedSession,
      provider: latestSession.provider,
    };
  } else if (localProviderChanged && !latestProviderChanged) {
    mergedSession = {
      ...mergedSession,
      provider: localSession.provider,
    };
  }

  if (!localModelChanged && latestModelChanged) {
    mergedSession = {
      ...mergedSession,
      model: latestSession.model,
    };
  } else if (localModelChanged && !latestModelChanged) {
    mergedSession = {
      ...mergedSession,
      model: localSession.model,
    };
  }

  return mergedSession;
};

const getSessionComposerTimestamp = (session: ChatSessionRecord): number => {
  return Math.max(session.composerUpdatedAt ?? 0, session.createdAt);
};

const mergeSessionFieldForPersistence = <T,>(
  primaryValue: T,
  localValue: T,
  baseValue: T,
  latestValue: T,
): T => {
  const localChanged = !areShellFragmentsEqual(localValue, baseValue);
  const latestChanged = !areShellFragmentsEqual(latestValue, baseValue);

  if (localChanged && !latestChanged) {
    return localValue;
  }

  if (!localChanged && latestChanged) {
    return latestValue;
  }

  return primaryValue;
};

const didRemoveBaseMessages = (
  messages: readonly ChatSessionMessage[],
  baseMessages: readonly ChatSessionMessage[],
): boolean => {
  const messageIds = new Set(messages.map((message) => message.id));

  return baseMessages.some(
    (message) =>
      !isPromptEnhancementPlaceholderMessage(message) &&
      !messageIds.has(message.id) && !isMessageSafelyReplaced(message, messages),
  );
};

const mergeMessageVersionForPersistence = (
  primaryMessage: ChatSessionMessage | undefined,
  localMessage: ChatSessionMessage,
  baseMessage: ChatSessionMessage | undefined,
  latestMessage: ChatSessionMessage,
): ChatSessionMessage => {
  const localChanged =
    !baseMessage || !areShellFragmentsEqual(localMessage, baseMessage);
  const latestChanged =
    !baseMessage || !areShellFragmentsEqual(latestMessage, baseMessage);
  const localRegressed =
    baseMessage !== undefined &&
    isMessageVersionRegression(baseMessage, localMessage);
  const latestRegressed =
    baseMessage !== undefined &&
    isMessageVersionRegression(baseMessage, latestMessage);

  if (localRegressed && !latestRegressed) {
    return latestMessage;
  }

  if (!localRegressed && latestRegressed) {
    return localMessage;
  }

  if (localChanged && !latestChanged) {
    return localMessage;
  }

  if (!localChanged && latestChanged) {
    return latestMessage;
  }

  return primaryMessage ?? localMessage;
};

const mergeAppendOnlyMessages = (
  primaryMessages: readonly ChatSessionMessage[],
  localMessages: readonly ChatSessionMessage[],
  baseMessages: readonly ChatSessionMessage[],
  latestMessages: readonly ChatSessionMessage[],
): ChatSessionMessage[] => {
  const primaryMessagesById = new Map(
    primaryMessages.map((message) => [message.id, message]),
  );
  const localMessagesById = new Map(
    localMessages.map((message) => [message.id, message]),
  );
  const baseMessagesById = new Map(
    baseMessages.map((message) => [message.id, message]),
  );
  const latestMessagesById = new Map(
    latestMessages.map((message) => [message.id, message]),
  );
  const messagesById = new Map<string, ChatSessionMessage>();

  for (const messageId of new Set([
    ...localMessagesById.keys(),
    ...latestMessagesById.keys(),
  ])) {
    const localMessage = localMessagesById.get(messageId);
    const latestMessage = latestMessagesById.get(messageId);

    if (!localMessage) {
      if (latestMessage) {
        if (isPromptEnhancementPlaceholderMessage(latestMessage)) {
          continue;
        }

        if (isMessageSafelyReplaced(latestMessage, localMessages)) {
          continue;
        }

        messagesById.set(messageId, latestMessage);
      }
      continue;
    }

    if (!latestMessage) {
      if (isMessageSafelyReplaced(localMessage, latestMessages)) {
        continue;
      }

      messagesById.set(messageId, localMessage);
      continue;
    }

    messagesById.set(
      messageId,
      mergeMessageVersionForPersistence(
        primaryMessagesById.get(messageId),
        localMessage,
        baseMessagesById.get(messageId),
        latestMessage,
      ),
    );
  }

  return [...messagesById.values()].sort((left, right) => {
    const leftCreatedAt = left.createdAt ?? 0;
    const rightCreatedAt = right.createdAt ?? 0;

    if (leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt - rightCreatedAt;
    }

    return 0;
  });
};

const mergeSessionMessagesForPersistence = (
  primarySession: ChatSessionRecord,
  localSession: ChatSessionRecord,
  baseSession: ChatSessionRecord,
  latestSession: ChatSessionRecord,
): ChatSessionMessage[] => {
  const localChanged = !areShellFragmentsEqual(
    localSession.messages,
    baseSession.messages,
  );
  const latestChanged = !areShellFragmentsEqual(
    latestSession.messages,
    baseSession.messages,
  );
  const localMessageRegression = hasMessageRegression(
    baseSession.messages,
    localSession.messages,
  );
  const latestMessageRegression = hasMessageRegression(
    baseSession.messages,
    latestSession.messages,
  );
  const localQuickVoiceClear =
    isQuickVoiceSession(localSession) &&
    localSession.messages.length === 0 &&
    localSession.updatedAt > baseSession.updatedAt &&
    localSession.updatedAt >= latestSession.updatedAt;
  const latestQuickVoiceClear =
    isQuickVoiceSession(latestSession) &&
    latestSession.messages.length === 0 &&
    latestSession.updatedAt > baseSession.updatedAt &&
    latestSession.updatedAt >= localSession.updatedAt;

  if (localQuickVoiceClear) {
    return localSession.messages;
  }

  if (latestQuickVoiceClear) {
    return latestSession.messages;
  }

  if (localChanged && !latestChanged) {
    if (isQuickVoiceSession(localSession) && localSession.messages.length === 0) {
      return localSession.messages;
    }

    return didRemoveBaseMessages(localSession.messages, baseSession.messages) ||
      localMessageRegression
      ? mergeAppendOnlyMessages(
          primarySession.messages,
          localSession.messages,
          baseSession.messages,
          latestSession.messages,
        )
      : localSession.messages;
  }

  if (!localChanged && latestChanged) {
    if (isQuickVoiceSession(latestSession) && latestSession.messages.length === 0) {
      return latestSession.messages;
    }

    return didRemoveBaseMessages(latestSession.messages, baseSession.messages) ||
      latestMessageRegression
      ? mergeAppendOnlyMessages(
          primarySession.messages,
          localSession.messages,
          baseSession.messages,
          latestSession.messages,
        )
      : latestSession.messages;
  }

  if (localChanged && latestChanged) {
    return mergeAppendOnlyMessages(
      primarySession.messages,
      localSession.messages,
      baseSession.messages,
      latestSession.messages,
    );
  }

  return primarySession.messages;
};

const mergeSessionConcurrentFields = (
  primarySession: ChatSessionRecord,
  localSession: ChatSessionRecord,
  baseSession: ChatSessionRecord,
  latestSession: ChatSessionRecord,
): ChatSessionRecord => {
  const composerPrimarySession =
    getSessionComposerTimestamp(localSession) >=
    getSessionComposerTimestamp(latestSession)
      ? localSession
      : latestSession;
  const latestMessageRegression = hasMessageRegression(
    baseSession.messages,
    latestSession.messages,
  );
  const promptHistory = latestMessageRegression
    ? localSession.promptHistory
    : mergeSessionFieldForPersistence(
        primarySession.promptHistory,
        localSession.promptHistory,
        baseSession.promptHistory,
        latestSession.promptHistory,
      );
  const promptContextHistory = latestMessageRegression
    ? localSession.promptContextHistory
    : mergeSessionFieldForPersistence(
        primarySession.promptContextHistory,
        localSession.promptContextHistory,
        baseSession.promptContextHistory,
        latestSession.promptContextHistory,
      );

  return {
    ...primarySession,
    draft: mergeSessionFieldForPersistence(
      composerPrimarySession.draft,
      localSession.draft,
      baseSession.draft,
      latestSession.draft,
    ),
    draftContextAttachments: mergeSessionFieldForPersistence(
      composerPrimarySession.draftContextAttachments,
      localSession.draftContextAttachments,
      baseSession.draftContextAttachments,
      latestSession.draftContextAttachments,
    ),
    composerUpdatedAt: Math.max(
      getSessionComposerTimestamp(localSession),
      getSessionComposerTimestamp(latestSession),
    ),
    messages: mergeSessionMessagesForPersistence(
      primarySession,
      localSession,
      baseSession,
      latestSession,
    ),
    promptHistory,
    promptContextHistory,
  };
};

const createNewSessionConcurrentBase = (
  session: ChatSessionRecord,
): ChatSessionRecord => {
  return {
    ...session,
    draft: "",
    draftContextAttachments: [],
    composerUpdatedAt: session.createdAt,
    messages: [],
    promptHistory: [],
    promptContextHistory: [],
  };
};

const mergeNewSessionConcurrentFields = (
  primarySession: ChatSessionRecord,
  localSession: ChatSessionRecord,
  latestSession: ChatSessionRecord,
): ChatSessionRecord => {
  return mergeSessionConcurrentFields(
    primarySession,
    localSession,
    createNewSessionConcurrentBase(primarySession),
    latestSession,
  );
};

const mergeRunningSessionWithExternalSnapshot = (
  currentSession: ChatSessionRecord,
  externalSession: ChatSessionRecord,
): ChatSessionRecord => {
  const primarySession: ChatSessionRecord = {
    ...externalSession,
    updatedAt: Math.max(externalSession.updatedAt, currentSession.updatedAt),
    messages: currentSession.messages,
  };

  return mergeNewSessionConcurrentFields(
    primarySession,
    currentSession,
    externalSession,
  );
};

const hasSessionComposerInput = (session: ChatSessionRecord): boolean => {
  return (
    session.draft.trim().length > 0 ||
    session.draftContextAttachments.length > 0
  );
};

const isOnlySessionComposerChanged = (
  localSession: ChatSessionRecord,
  baseSession: ChatSessionRecord,
): boolean => {
  return areShellFragmentsEqual(
    {
      ...localSession,
      draft: baseSession.draft,
      draftContextAttachments: baseSession.draftContextAttachments,
      composerUpdatedAt: baseSession.composerUpdatedAt,
      updatedAt: baseSession.updatedAt,
    },
    baseSession,
  );
};

const rebasePreHydrationComposerInput = (
  localState: ShellPersistedState,
  baseState: ShellPersistedState,
  hydratedState: ShellPersistedState,
): ShellPersistedState => {
  const baseActiveSession = baseState.sessions.find(
    (session) => session.id === baseState.activeSessionId,
  );
  const localActiveSession = localState.sessions.find(
    (session) => session.id === baseState.activeSessionId,
  );

  if (
    !baseActiveSession ||
    !localActiveSession ||
    !hasSessionComposerInput(localActiveSession) ||
    localState.sessions.length !== baseState.sessions.length ||
    !isOnlySessionComposerChanged(localActiveSession, baseActiveSession)
  ) {
    return localState;
  }

  const hydratedActiveSessionId =
    hydratedState.sessions.find(
      (session) => session.id === hydratedState.activeSessionId,
    )?.id ?? hydratedState.sessions[0]?.id;

  if (!hydratedActiveSessionId) {
    return localState;
  }

  return {
    ...localState,
    activeSessionId: hydratedActiveSessionId,
    sessions: hydratedState.sessions.map((session) => {
      if (session.id !== hydratedActiveSessionId) {
        return session;
      }

      const nextSession: ChatSessionRecord = {
        ...session,
        updatedAt: Math.max(session.updatedAt, localActiveSession.updatedAt),
        composerUpdatedAt: Math.max(
          getSessionComposerTimestamp(session),
          getSessionComposerTimestamp(localActiveSession),
        ),
      };

      if (!session.draft.trim()) {
        nextSession.draft = localActiveSession.draft;
      }

      if (session.draftContextAttachments.length === 0) {
        nextSession.draftContextAttachments =
          localActiveSession.draftContextAttachments;
      }

      return nextSession;
    }),
  };
};

const preserveCurrentComposerInput = (
  externalSession: ChatSessionRecord,
  currentSession: ChatSessionRecord,
): ChatSessionRecord => {
  if (
    externalSession.draft === currentSession.draft &&
    areShellFragmentsEqual(
      externalSession.draftContextAttachments,
      currentSession.draftContextAttachments,
    )
  ) {
    return externalSession;
  }

  if (
    getSessionComposerTimestamp(externalSession) >
    getSessionComposerTimestamp(currentSession)
  ) {
    return externalSession;
  }

  return {
    ...externalSession,
    draft: currentSession.draft,
    draftContextAttachments: currentSession.draftContextAttachments,
    composerUpdatedAt: getSessionComposerTimestamp(currentSession),
    updatedAt: Math.max(externalSession.updatedAt, currentSession.updatedAt),
  };
};

const mergeExternalSessionWithCurrentState = (
  currentSession: ChatSessionRecord,
  externalSession: ChatSessionRecord,
): ChatSessionRecord | null => {
  if (getLatestRunningTaskId(currentSession)) {
    return mergeRunningSessionWithExternalSnapshot(currentSession, externalSession);
  }

  const externalHasMessageAdvance = hasMessageRegression(
    externalSession.messages,
    currentSession.messages,
  );

  if (
    getSessionPersistenceTimestamp(currentSession) >
      getSessionPersistenceTimestamp(externalSession) &&
    !externalHasMessageAdvance
  ) {
    return currentSession;
  }

  const composerPreservedSession = preserveCurrentComposerInput(
    externalSession,
    currentSession,
  );

  return composerPreservedSession === externalSession
    ? null
    : composerPreservedSession;
};

const preserveCurrentSessionState = (
  currentState: ShellPersistedState,
  externalState: ShellPersistedState,
): ShellPersistedState => {
  const externalSessionsById = new Map(
    externalState.sessions.map((session) => [session.id, session]),
  );
  const protectedSessions = new Map<string, ChatSessionRecord>();

  for (const currentSession of currentState.sessions) {
    const externalSession = externalSessionsById.get(currentSession.id);

    if (!externalSession) {
      if (
        getLatestRunningTaskId(currentSession) ||
        hasSessionComposerInput(currentSession)
      ) {
        protectedSessions.set(currentSession.id, currentSession);
      }
      continue;
    }

    const protectedSession = mergeExternalSessionWithCurrentState(
      currentSession,
      externalSession,
    );

    if (protectedSession) {
      protectedSessions.set(currentSession.id, protectedSession);
    }
  }

  if (protectedSessions.size === 0) {
    return externalState;
  }

  const nextSessionsById = new Map(
    externalState.sessions.map((session) => [session.id, session]),
  );

  for (const [sessionId, session] of protectedSessions) {
    nextSessionsById.set(sessionId, session);
  }

  const activeSessionId = nextSessionsById.has(currentState.activeSessionId)
    ? currentState.activeSessionId
    : nextSessionsById.has(externalState.activeSessionId)
      ? externalState.activeSessionId
      : sortSessionsByUpdatedAt([...nextSessionsById.values()])[0]?.id;

  return {
    ...externalState,
    activeSessionId: activeSessionId ?? externalState.activeSessionId,
    sessions: sortSessionsByUpdatedAt([...nextSessionsById.values()]),
  };
};

const getContextPackPersistenceTimestamp = (
  pack: SmartContextPack,
): number => {
  return Math.max(pack.updatedAt, pack.lastUsedAt ?? 0, pack.createdAt);
};

const sortContextPacksForPersistence = (
  packs: SmartContextPack[],
): SmartContextPack[] => {
  return [...packs].sort(
    (left, right) =>
      getContextPackPersistenceTimestamp(right) -
      getContextPackPersistenceTimestamp(left),
  );
};

const mergeContextPacksForPersistence = (
  localPacks: SmartContextPack[],
  basePacks: SmartContextPack[],
  latestPacks: SmartContextPack[],
): SmartContextPack[] => {
  const localPacksById = new Map(localPacks.map((pack) => [pack.id, pack]));
  const basePacksById = new Map(basePacks.map((pack) => [pack.id, pack]));
  const latestPacksById = new Map(latestPacks.map((pack) => [pack.id, pack]));
  const deletedPackIds = new Set<string>();

  for (const packId of basePacksById.keys()) {
    if (!localPacksById.has(packId)) {
      deletedPackIds.add(packId);
    }
  }

  const mergedPacksById = new Map<string, SmartContextPack>();

  for (const packId of new Set([
    ...latestPacksById.keys(),
    ...localPacksById.keys(),
  ])) {
    if (deletedPackIds.has(packId)) {
      continue;
    }

    const localPack = localPacksById.get(packId);
    const basePack = basePacksById.get(packId);
    const latestPack = latestPacksById.get(packId);

    if (!localPack) {
      if (latestPack) {
        mergedPacksById.set(packId, latestPack);
      }

      continue;
    }

    const localPackChanged =
      !basePack || !areShellFragmentsEqual(localPack, basePack);

    if (!localPackChanged && latestPack) {
      mergedPacksById.set(packId, latestPack);
      continue;
    }

    if (!latestPack) {
      mergedPacksById.set(packId, localPack);
      continue;
    }

    const localTimestamp = getContextPackPersistenceTimestamp(localPack);
    const latestTimestamp = getContextPackPersistenceTimestamp(latestPack);

    mergedPacksById.set(
      packId,
      localTimestamp >= latestTimestamp ? localPack : latestPack,
    );
  }

  return sortContextPacksForPersistence([...mergedPacksById.values()]);
};

const getQueuedMessagePersistenceTimestamp = (
  message: ChatSessionQueuedMessage,
): number => {
  return Math.max(message.updatedAt, message.createdAt);
};

const getQueuedMessagesPersistenceTimestamp = (
  messages: readonly ChatSessionQueuedMessage[],
): number => {
  return messages.reduce(
    (timestamp, message) =>
      Math.max(timestamp, getQueuedMessagePersistenceTimestamp(message)),
    0,
  );
};

const mergeQueuedMessageVersionForPersistence = (
  localMessage: ChatSessionQueuedMessage,
  baseMessage: ChatSessionQueuedMessage | undefined,
  latestMessage: ChatSessionQueuedMessage,
): ChatSessionQueuedMessage => {
  const localChanged =
    !baseMessage || !areShellFragmentsEqual(localMessage, baseMessage);
  const latestChanged =
    !baseMessage || !areShellFragmentsEqual(latestMessage, baseMessage);

  if (localChanged && !latestChanged) {
    return localMessage;
  }

  if (!localChanged && latestChanged) {
    return latestMessage;
  }

  return getQueuedMessagePersistenceTimestamp(localMessage) >=
    getQueuedMessagePersistenceTimestamp(latestMessage)
    ? localMessage
    : latestMessage;
};

const createQueuedMessageSubmittedContentSet = (
  message: ChatSessionQueuedMessage,
): Set<string> => {
  return new Set(
    [
      message.visibleMessageContent,
      message.promptHistoryContent,
      message.task,
    ].flatMap((content) => {
      const normalizedContent = content?.trim();

      return normalizedContent ? [normalizedContent] : [];
    }),
  );
};

const wasQueuedMessageSubmittedInSessions = (
  message: ChatSessionQueuedMessage,
  sessions: readonly ChatSessionRecord[],
): boolean => {
  const submittedContent = createQueuedMessageSubmittedContentSet(message);
  const session = sessions.find((entry) => entry.id === message.sessionId);

  if (!session || submittedContent.size === 0) {
    return false;
  }

  return session.messages.some((entry) => {
    return (
      entry.role === "user" &&
      (entry.createdAt ?? 0) >= message.createdAt &&
      submittedContent.has(entry.content.trim())
    );
  });
};

const mergeQueuedSessionMessagesForPersistence = (
  localMessages: ChatSessionQueuedMessage[],
  localSessions: ChatSessionRecord[],
  baseMessages: ChatSessionQueuedMessage[],
  latestMessages: ChatSessionQueuedMessage[],
  latestSessions: ChatSessionRecord[],
  sessionIds: ReadonlySet<string>,
): ChatSessionQueuedMessage[] => {
  const localMessagesById = new Map(
    localMessages.map((message) => [message.id, message]),
  );
  const baseMessagesById = new Map(
    baseMessages.map((message) => [message.id, message]),
  );
  const latestMessagesById = new Map(
    latestMessages.map((message) => [message.id, message]),
  );
  const deletedMessageIds = new Set<string>();

  for (const [messageId, baseMessage] of baseMessagesById.entries()) {
    if (
      !localMessagesById.has(messageId) ||
      (!latestMessagesById.has(messageId) &&
        wasQueuedMessageSubmittedInSessions(baseMessage, latestSessions))
    ) {
      deletedMessageIds.add(messageId);
    }
  }

  const mergedMessagesById = new Map<string, ChatSessionQueuedMessage>();

  for (const messageId of new Set([
    ...latestMessagesById.keys(),
    ...localMessagesById.keys(),
  ])) {
    if (deletedMessageIds.has(messageId)) {
      continue;
    }

    const localMessage = localMessagesById.get(messageId);
    const latestMessage = latestMessagesById.get(messageId);

    if (!localMessage) {
      if (latestMessage && sessionIds.has(latestMessage.sessionId)) {
        mergedMessagesById.set(messageId, latestMessage);
      }
      continue;
    }

    if (!latestMessage) {
      if (sessionIds.has(localMessage.sessionId)) {
        mergedMessagesById.set(messageId, localMessage);
      }
      continue;
    }

    const mergedMessage = mergeQueuedMessageVersionForPersistence(
      localMessage,
      baseMessagesById.get(messageId),
      latestMessage,
    );

    if (sessionIds.has(mergedMessage.sessionId)) {
      mergedMessagesById.set(messageId, mergedMessage);
    }
  }

  const localTimestamp = getQueuedMessagesPersistenceTimestamp(localMessages);
  const latestTimestamp = getQueuedMessagesPersistenceTimestamp(latestMessages);
  const orderSource =
    localTimestamp >= latestTimestamp ? localMessages : latestMessages;
  const orderById = new Map(
    orderSource.map((message, index) => [message.id, index]),
  );

  return [...mergedMessagesById.values()].sort((left, right) => {
    const leftOrder = orderById.get(left.id);
    const rightOrder = orderById.get(right.id);

    if (leftOrder !== undefined && rightOrder !== undefined) {
      return leftOrder - rightOrder;
    }

    if (leftOrder !== undefined) {
      return -1;
    }

    if (rightOrder !== undefined) {
      return 1;
    }

    return left.createdAt - right.createdAt;
  });
};

export const mergeShellStateForPersistence = (
  localState: ShellPersistedState,
  baseState: ShellPersistedState,
  latestState: ShellPersistedState,
): ShellPersistedState => {
  const localSessionsById = new Map(
    localState.sessions.map((session) => [session.id, session]),
  );
  const baseSessionsById = new Map(
    baseState.sessions.map((session) => [session.id, session]),
  );
  const latestSessionsById = new Map(
    latestState.sessions.map((session) => [session.id, session]),
  );
  const deletedSessionIds = new Set<string>();

  for (const sessionId of baseSessionsById.keys()) {
    if (!localSessionsById.has(sessionId)) {
      deletedSessionIds.add(sessionId);
    }
  }

  const mergedSessionsById = new Map<string, ChatSessionRecord>();

  for (const sessionId of new Set([
    ...latestSessionsById.keys(),
    ...localSessionsById.keys(),
  ])) {
    if (deletedSessionIds.has(sessionId)) {
      continue;
    }

    const localSession = localSessionsById.get(sessionId);
    const baseSession = baseSessionsById.get(sessionId);
    const latestSession = latestSessionsById.get(sessionId);

    if (!localSession) {
      if (latestSession) {
        mergedSessionsById.set(sessionId, latestSession);
      }

      continue;
    }

    if (!latestSession) {
      mergedSessionsById.set(sessionId, localSession);
      continue;
    }

    const localTimestamp = getSessionPersistenceTimestamp(localSession);
    const latestTimestamp = getSessionPersistenceTimestamp(latestSession);

    const primarySession =
      localTimestamp >= latestTimestamp ? localSession : latestSession;

    if (!baseSession) {
      mergedSessionsById.set(
        sessionId,
        mergeNewSessionConcurrentFields(
          primarySession,
          localSession,
          latestSession,
        ),
      );
      continue;
    }

    const runtimeMergedSession = mergeSessionRuntimeSelection(
      primarySession,
      localSession,
      baseSession,
      latestSession,
    );

    mergedSessionsById.set(
      sessionId,
      mergeSessionConcurrentFields(
        runtimeMergedSession,
        localSession,
        baseSession,
        latestSession,
      ),
    );
  }

  const sessions = sortSessionsByUpdatedAt([...mergedSessionsById.values()]);
  const sessionIds = new Set(sessions.map((session) => session.id));
  const activeSessionId =
    sessionIds.has(localState.activeSessionId)
      ? localState.activeSessionId
      : sessionIds.has(latestState.activeSessionId)
        ? latestState.activeSessionId
        : sessions[0]?.id;
  const localRecentWorkspacesChanged = !areShellFragmentsEqual(
    localState.recentWorkspaces,
    baseState.recentWorkspaces,
  );
  const latestRecentWorkspacesChanged = !areShellFragmentsEqual(
    latestState.recentWorkspaces,
    baseState.recentWorkspaces,
  );
  const mergedState: ShellPersistedState = {
    ...latestState,
    version: 1,
    activeSessionId: activeSessionId ?? latestState.activeSessionId,
    sessions,
    queuedSessionMessages: mergeQueuedSessionMessagesForPersistence(
      localState.queuedSessionMessages,
      localState.sessions,
      baseState.queuedSessionMessages,
      latestState.queuedSessionMessages,
      latestState.sessions,
      sessionIds,
    ),
    contextPacks: mergeContextPacksForPersistence(
      localState.contextPacks,
      baseState.contextPacks,
      latestState.contextPacks,
    ),
    recentWorkspaces:
      localRecentWorkspacesChanged && latestRecentWorkspacesChanged
        ? mergeRecentWorkspacesForPersistence(
            localState.recentWorkspaces,
            baseState.recentWorkspaces,
            latestState.recentWorkspaces,
          )
        : localRecentWorkspacesChanged
          ? localState.recentWorkspaces
          : latestState.recentWorkspaces,
    voice: areShellFragmentsEqual(localState.voice, baseState.voice)
      ? latestState.voice
      : localState.voice,
    lastSelectedProvider:
      localState.lastSelectedProvider === baseState.lastSelectedProvider
        ? latestState.lastSelectedProvider
        : localState.lastSelectedProvider,
    lastSelectedModelByProvider: areShellFragmentsEqual(
      localState.lastSelectedModelByProvider,
      baseState.lastSelectedModelByProvider,
    )
      ? latestState.lastSelectedModelByProvider
      : localState.lastSelectedModelByProvider,
    lastSelectedSessionMemoryEnabled:
      localState.lastSelectedSessionMemoryEnabled ===
      baseState.lastSelectedSessionMemoryEnabled
        ? latestState.lastSelectedSessionMemoryEnabled
        : localState.lastSelectedSessionMemoryEnabled,
    lastSelectedUseGlobalMemory:
      localState.lastSelectedUseGlobalMemory ===
      baseState.lastSelectedUseGlobalMemory
        ? latestState.lastSelectedUseGlobalMemory
        : localState.lastSelectedUseGlobalMemory,
    lastSelectedUiControlEnabled:
      localState.lastSelectedUiControlEnabled ===
      baseState.lastSelectedUiControlEnabled
        ? latestState.lastSelectedUiControlEnabled
        : localState.lastSelectedUiControlEnabled,
  };

  if (localState.lastSelectedMode !== baseState.lastSelectedMode) {
    if (localState.lastSelectedMode) {
      mergedState.lastSelectedMode = localState.lastSelectedMode;
    } else {
      delete mergedState.lastSelectedMode;
    }
  } else if (latestState.lastSelectedMode) {
    mergedState.lastSelectedMode = latestState.lastSelectedMode;
  } else {
    delete mergedState.lastSelectedMode;
  }

  if (localState.lastSelectedReasoning !== baseState.lastSelectedReasoning) {
    if (localState.lastSelectedReasoning) {
      mergedState.lastSelectedReasoning = localState.lastSelectedReasoning;
    } else {
      delete mergedState.lastSelectedReasoning;
    }
  } else if (latestState.lastSelectedReasoning) {
    mergedState.lastSelectedReasoning = latestState.lastSelectedReasoning;
  } else {
    delete mergedState.lastSelectedReasoning;
  }

  if (localState.lastRecoveredLaunchId !== baseState.lastRecoveredLaunchId) {
    if (localState.lastRecoveredLaunchId) {
      mergedState.lastRecoveredLaunchId = localState.lastRecoveredLaunchId;
    } else {
      delete mergedState.lastRecoveredLaunchId;
    }
  } else if (latestState.lastRecoveredLaunchId) {
    mergedState.lastRecoveredLaunchId = latestState.lastRecoveredLaunchId;
  } else {
    delete mergedState.lastRecoveredLaunchId;
  }

  return mergedState;
};

const isExternalStateRegressive = (
  currentState: ShellPersistedState,
  externalState: ShellPersistedState,
): boolean => {
  const externalSessionsById = new Map(
    externalState.sessions.map((session) => [session.id, session]),
  );
  const externalQueuedMessagesById = new Map(
    externalState.queuedSessionMessages.map((message) => [message.id, message]),
  );

  for (const currentSession of currentState.sessions) {
    const externalSession = externalSessionsById.get(currentSession.id);

    if (!externalSession) {
      if (
        currentSession.messages.length > 0 ||
        currentSession.promptHistory.length > 0
      ) {
        return true;
      }

      continue;
    }

    if (hasMessageRegression(currentSession.messages, externalSession.messages)) {
      return true;
    }
  }

  for (const currentQueuedMessage of currentState.queuedSessionMessages) {
    if (externalQueuedMessagesById.has(currentQueuedMessage.id)) {
      continue;
    }

    if (
      !wasQueuedMessageSubmittedInSessions(
        currentQueuedMessage,
        externalState.sessions,
      )
    ) {
      return true;
    }
  }

  return false;
};

export const mergeShellStateFromExternalUpdate = (
  currentState: ShellPersistedState,
  baseState: ShellPersistedState,
  externalState: ShellPersistedState,
  hasUnpersistedLocalChanges: boolean,
): ShellPersistedState => {
  if (
    hasUnpersistedLocalChanges ||
    isExternalStateRegressive(currentState, externalState)
  ) {
    return mergeShellStateForPersistence(currentState, baseState, externalState);
  }

  return preserveCurrentSessionState(currentState, externalState);
};

export interface ChatSessionShellStateController {
  shellState: ShellPersistedState;
  activeSessionId: string;
  activeSession: ChatSessionRecord;
  visibleMessages: ChatSessionMessage[];
  filteredSessions: ChatSessionRecord[];
  hasHydrated: boolean;
  sessionScopeFilter: SessionScopeFilter;
  sessionStatusFilters: SessionStatusFilterSelection;
  sessionSearchQuery: string;
  sessionProjectFilter: string;
  sessionTagFilters: string[];
  sessionHistoryIndex: SessionHistoryIndex;
  sessionProjectFacets: SessionHistoryProjectFacet[];
  sessionTagFacets: SessionHistoryTagFacet[];
  catalogOpen: boolean;
  settingsSection: SettingsSection;
  isRenamingSession: boolean;
  renameValue: string;
  promptHistoryIndex: number | null;
  draftBeforeHistory: string;
  bottomRef: RefObject<HTMLDivElement | null>;
  showScrollToNewestButton: boolean;
  scrollToNewest: () => void;
  setCatalogOpen: Dispatch<SetStateAction<boolean>>;
  setSettingsSection: Dispatch<SetStateAction<SettingsSection>>;
  setActiveSessionId: (sessionId: string) => void;
  setSessionScopeFilter: Dispatch<SetStateAction<SessionScopeFilter>>;
  setSessionStatusFilters: Dispatch<
    SetStateAction<SessionStatusFilterSelection>
  >;
  setSessionSearchQuery: Dispatch<SetStateAction<string>>;
  setSessionProjectFilter: Dispatch<SetStateAction<string>>;
  setSessionTagFilters: Dispatch<SetStateAction<string[]>>;
  setIsRenamingSession: Dispatch<SetStateAction<boolean>>;
  setRenameValue: Dispatch<SetStateAction<string>>;
  setPromptHistoryIndex: Dispatch<SetStateAction<number | null>>;
  setDraftBeforeHistory: Dispatch<SetStateAction<string>>;
  applyShellState: (updater: SetStateAction<ShellPersistedState>) => void;
  updateActiveSession: (
    updater: (session: ChatSessionRecord) => ChatSessionRecord,
  ) => void;
  updateSessionById: (
    sessionId: string,
    updater: (session: ChatSessionRecord) => ChatSessionRecord,
  ) => void;
  setDraftValue: Dispatch<SetStateAction<string>>;
}

export interface UseChatSessionShellStateOptions {
  isolateActiveSession?: boolean;
}

export const useChatSessionShellState = (
  options: UseChatSessionShellStateOptions = {},
): ChatSessionShellStateController => {
  const isolateActiveSession = options.isolateActiveSession !== false;
  const initialShellStateRef = useRef<ShellPersistedState>(
    createInitialShellState(),
  );
  const [shellState, setShellState] = useState<ShellPersistedState>(
    initialShellStateRef.current,
  );
  const [activeSessionId, setActiveSessionIdState] = useState<string>(
    initialShellStateRef.current.activeSessionId,
  );
  const [hasHydrated, setHasHydrated] = useState(false);
  const [persistenceSignal, setPersistenceSignal] = useState(0);
  const [sessionScopeFilter, setSessionScopeFilter] =
    useState<SessionScopeFilter>("open");
  const [sessionStatusFilters, setSessionStatusFilters] =
    useState<SessionStatusFilterSelection>(["any"]);
  const [sessionSearchQuery, setSessionSearchQuery] = useState("");
  const [sessionProjectFilter, setSessionProjectFilter] = useState(
    ALL_SESSION_PROJECTS_FILTER,
  );
  const [sessionTagFilters, setSessionTagFilters] = useState<string[]>([]);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("providers");
  const [isRenamingSession, setIsRenamingSession] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [promptHistoryIndex, setPromptHistoryIndex] = useState<number | null>(
    null,
  );
  const [draftBeforeHistory, setDraftBeforeHistory] = useState("");
  const didMutateBeforeHydrationRef = useRef(false);
  const shellStateRef = useRef(shellState);
  const lastPersistedShellStateRef = useRef(initialShellStateRef.current);
  const localMutationRevisionRef = useRef(0);
  const persistedMutationRevisionRef = useRef(0);
  const persistInFlightRef = useRef(false);
  const persistQueuedRef = useRef(false);
  const persistTimerRef = useRef<number | null>(null);
  const sessionHistoryIndexEntryCacheRef =
    useRef<SessionHistoryIndexEntryCache>(new Map());

  const resolvedActiveSessionId = useMemo(() => {
    if (!isolateActiveSession) {
      if (
        shellState.sessions.some(
          (session) => session.id === shellState.activeSessionId,
        )
      ) {
        return shellState.activeSessionId;
      }

      return shellState.sessions[0]?.id ?? activeSessionId;
    }

    if (shellState.sessions.some((session) => session.id === activeSessionId)) {
      return activeSessionId;
    }

    if (
      shellState.sessions.some(
        (session) => session.id === shellState.activeSessionId,
      )
    ) {
      return shellState.activeSessionId;
    }

    return shellState.sessions[0]?.id ?? activeSessionId;
  }, [
    activeSessionId,
    isolateActiveSession,
    shellState.activeSessionId,
    shellState.sessions,
  ]);

  const rawActiveSession =
    shellState.sessions.find((session) => session.id === resolvedActiveSessionId) ??
    shellState.sessions[0];
  const activeSession = rawActiveSession;

  const visibleMessages = useMemo(() => {
    return createVisibleConversationMessages(activeSession.messages);
  }, [activeSession.messages]);
  const newestMessageScroll = useNewestMessageScroll({
    resetKey: activeSession.id,
    contentKey: visibleMessages,
  });

  const sortedSessions = useMemo(() => {
    return sortSessionsByUpdatedAt(shellState.sessions);
  }, [shellState.sessions]);

  const sessionHistoryIndex = useMemo(() => {
    return createSessionHistoryIndex(
      sortedSessions,
      sessionHistoryIndexEntryCacheRef.current,
    );
  }, [sortedSessions]);

  const filteredSessions = useMemo(() => {
    return filterSessionHistoryIndex(sessionHistoryIndex, {
      scope: sessionScopeFilter,
      status: sessionStatusFilters,
      searchQuery: sessionSearchQuery,
      projectFilter: sessionProjectFilter,
      tagFilters: sessionTagFilters,
    }).sessions;
  }, [
    sessionHistoryIndex,
    sessionProjectFilter,
    sessionScopeFilter,
    sessionSearchQuery,
    sessionStatusFilters,
    sessionTagFilters,
  ]);

  const applyShellState = useCallback(
    (updater: SetStateAction<ShellPersistedState>): void => {
      const previousState = shellStateRef.current;
      const nextState =
        typeof updater === "function" ? updater(previousState) : updater;

      if (nextState === previousState) {
        return;
      }

      if (!hasHydrated) {
        didMutateBeforeHydrationRef.current = true;
      }

      localMutationRevisionRef.current += 1;
      shellStateRef.current = nextState;
      setShellState(nextState);
    },
    [hasHydrated],
  );

  const clearScheduledShellStatePersistence = useCallback((): void => {
    if (persistTimerRef.current === null) {
      return;
    }

    if (typeof window !== "undefined") {
      window.clearTimeout(persistTimerRef.current);
    }

    persistTimerRef.current = null;
  }, []);

  const persistShellState = useCallback(async (): Promise<void> => {
    if (persistInFlightRef.current) {
      persistQueuedRef.current = true;
      return;
    }

    persistInFlightRef.current = true;

    try {
      do {
        persistQueuedRef.current = false;

        const targetRevision = localMutationRevisionRef.current;

        if (persistedMutationRevisionRef.current >= targetRevision) {
          continue;
        }

        const latestPersistedState = normalizeShellState(
          await loadShellState(lastPersistedShellStateRef.current),
        );
        const mergedShellState = mergeShellStateForPersistence(
          shellStateRef.current,
          lastPersistedShellStateRef.current,
          latestPersistedState,
        );

        await saveShellState(mergedShellState);

        lastPersistedShellStateRef.current = mergedShellState;
        persistedMutationRevisionRef.current = targetRevision;

        if (
          localMutationRevisionRef.current === targetRevision &&
          !areShellFragmentsEqual(shellStateRef.current, mergedShellState)
        ) {
          shellStateRef.current = mergedShellState;
          setShellState(mergedShellState);
        }

        void broadcastShellStateChanged();
      } while (
        persistQueuedRef.current ||
        persistedMutationRevisionRef.current < localMutationRevisionRef.current
      );
    } finally {
      persistInFlightRef.current = false;
    }
  }, []);

  const scheduleShellStatePersistence = useCallback((): void => {
    if (persistTimerRef.current !== null) {
      return;
    }

    if (typeof window === "undefined") {
      void persistShellState();
      return;
    }

    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      void persistShellState();
    }, SHELL_STATE_PERSIST_DELAY_MS);
  }, [persistShellState]);

  const flushShellStatePersistence = useCallback((): void => {
    clearScheduledShellStatePersistence();
    void persistShellState();
  }, [clearScheduledShellStatePersistence, persistShellState]);

  useEffect(() => {
    shellStateRef.current = shellState;
  }, [shellState]);

  useEffect(() => {
    document.documentElement.classList.add("dark");

    return () => {
      document.documentElement.classList.remove("dark");
    };
  }, []);

  useEffect(() => {
    if (!activeSession || resolvedActiveSessionId === activeSessionId) {
      return;
    }

    setActiveSessionIdState(resolvedActiveSessionId);
  }, [activeSession, activeSessionId, resolvedActiveSessionId]);

  useEffect(() => {
    if (sessionTagFilters.length === 0) {
      return;
    }

    const availableTags = new Set(
      sessionHistoryIndex.tags.map((tag) => tag.label.toLowerCase()),
    );
    const nextTagFilters = sessionTagFilters.filter((tag) =>
      availableTags.has(tag.toLowerCase()),
    );

    if (nextTagFilters.length !== sessionTagFilters.length) {
      setSessionTagFilters(nextTagFilters);
    }
  }, [sessionHistoryIndex.tags, sessionTagFilters]);

  useEffect(() => {
    if (sessionProjectFilter === ALL_SESSION_PROJECTS_FILTER) {
      return;
    }

    const availableProjects = new Set(
      sessionHistoryIndex.projects.map((project) => project.id),
    );

    if (!availableProjects.has(sessionProjectFilter)) {
      setSessionProjectFilter(ALL_SESSION_PROJECTS_FILTER);
    }
  }, [sessionHistoryIndex.projects, sessionProjectFilter]);

  useEffect(() => {
    let cancelled = false;

    void Promise.all([
      loadShellState(initialShellStateRef.current),
      loadDesktopLaunchId(),
      loadActiveDesktopTaskIds(),
    ])
      .then(([value, launchId, activeDesktopTaskIds]) => {
        if (cancelled) {
          return;
        }

        const normalizedShellState = normalizeShellState(value);
        const recoveredShellState = recoverInterruptedTasksForLaunch(
          normalizedShellState,
          launchId,
          Date.now(),
          activeDesktopTaskIds ?? undefined,
        );

        if (didMutateBeforeHydrationRef.current) {
          const preHydrationShellState = rebasePreHydrationComposerInput(
            shellStateRef.current,
            initialShellStateRef.current,
            recoveredShellState,
          );
          const mergedShellState = mergeShellStateForPersistence(
            preHydrationShellState,
            initialShellStateRef.current,
            recoveredShellState,
          );

          lastPersistedShellStateRef.current = normalizedShellState;

          if (!areShellFragmentsEqual(mergedShellState, normalizedShellState)) {
            localMutationRevisionRef.current += 1;
          }

          shellStateRef.current = mergedShellState;
          setShellState(mergedShellState);
          return;
        }

        if (
          value === initialShellStateRef.current &&
          areShellFragmentsEqual(
            recoveredShellState,
            initialShellStateRef.current,
          )
        ) {
          return;
        }

        lastPersistedShellStateRef.current = normalizedShellState;

        if (!areShellFragmentsEqual(recoveredShellState, normalizedShellState)) {
          localMutationRevisionRef.current += 1;
        }

        shellStateRef.current = recoveredShellState;
        setShellState(recoveredShellState);
      })
      .finally(() => {
        if (!cancelled) {
          setHasHydrated(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hasHydrated) {
      return;
    }

    scheduleShellStatePersistence();
  }, [
    hasHydrated,
    persistenceSignal,
    scheduleShellStatePersistence,
    shellState,
  ]);

  useEffect(() => {
    return () => {
      clearScheduledShellStatePersistence();
    };
  }, [clearScheduledShellStatePersistence]);

  useEffect(() => {
    if (!hasHydrated) {
      return;
    }

    const flushWhenHidden = (): void => {
      if (document.visibilityState === "hidden") {
        flushShellStatePersistence();
      }
    };

    window.addEventListener("pagehide", flushShellStatePersistence);
    document.addEventListener("visibilitychange", flushWhenHidden);

    return () => {
      window.removeEventListener("pagehide", flushShellStatePersistence);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, [flushShellStatePersistence, hasHydrated]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void subscribeToShellStateChanged((payload) => {
      if (!hasHydrated) {
        return;
      }

      if (payload.originWindowLabel === getCurrentShellWindowLabel()) {
        return;
      }

      void loadShellState(initialShellStateRef.current).then((value) => {
        if (disposed) {
          return;
        }

        const normalizedShellState = normalizeShellState(value);
        const previousPersistedShellState =
          lastPersistedShellStateRef.current;
        const hasUnpersistedLocalChanges =
          localMutationRevisionRef.current >
          persistedMutationRevisionRef.current;
        const nextShellState = mergeShellStateFromExternalUpdate(
          shellStateRef.current,
          previousPersistedShellState,
          normalizedShellState,
          hasUnpersistedLocalChanges,
        );

        const nextStateNeedsPersistence = !areShellFragmentsEqual(
          nextShellState,
          normalizedShellState,
        );

        lastPersistedShellStateRef.current = normalizedShellState;

        if (nextStateNeedsPersistence) {
          localMutationRevisionRef.current += 1;
        }

        if (!areShellFragmentsEqual(shellStateRef.current, nextShellState)) {
          shellStateRef.current = nextShellState;
          setShellState(nextShellState);
        } else if (nextStateNeedsPersistence) {
          setPersistenceSignal((revision) => revision + 1);
        }
      });
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }

      unsubscribe = unlisten;
    });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [hasHydrated]);

  useEffect(() => {
    setPromptHistoryIndex(null);
    setDraftBeforeHistory("");
    setIsRenamingSession(false);
    setRenameValue(getSessionTitle(activeSession));
  }, [activeSession.id, activeSession.manualTitle, activeSession.messages]);

  useEffect(() => {
    if (!hasHydrated) {
      return;
    }

    const latestCompletedResponseAt =
      getLatestCompletedSessionResponseAt(activeSession);

    if (
      latestCompletedResponseAt === null ||
      (activeSession.lastReadAt ?? 0) >= latestCompletedResponseAt
    ) {
      return;
    }

    applyShellState((prev) => ({
      ...prev,
      sessions: prev.sessions.map((session) =>
        session.id === activeSession.id
          ? markSessionRead(session, latestCompletedResponseAt)
          : session,
      ),
    }));
  }, [
    activeSession,
    activeSession.id,
    activeSession.lastReadAt,
    applyShellState,
    hasHydrated,
  ]);

  const updateActiveSession = useCallback(
    (updater: (session: ChatSessionRecord) => ChatSessionRecord): void => {
      const targetSessionId = activeSession.id;
      const allowHydrationFallback = !hasHydrated;

      applyShellState((prev) => {
        const targetSessionExists = prev.sessions.some(
          (session) => session.id === targetSessionId,
        );
        const fallbackSessionId = allowHydrationFallback
          ? prev.activeSessionId
          : null;
        const resolvedSessionId = targetSessionExists
          ? targetSessionId
          : fallbackSessionId &&
              prev.sessions.some((session) => session.id === fallbackSessionId)
            ? fallbackSessionId
            : null;

        if (!resolvedSessionId) {
          return prev;
        }

        let didUpdateSession = false;
        const sessions = prev.sessions.map((session) => {
          if (session.id !== resolvedSessionId) {
            return session;
          }

          const nextSession = updater(session);

          if (nextSession !== session) {
            didUpdateSession = true;
          }

          return nextSession;
        });

        if (!didUpdateSession) {
          return prev;
        }

        return {
          ...prev,
          sessions,
        };
      });
    },
    [activeSession.id, applyShellState, hasHydrated],
  );

  const updateSessionById = useCallback(
    (
      sessionId: string,
      updater: (session: ChatSessionRecord) => ChatSessionRecord,
    ): void => {
      applyShellState((prev) => {
        let didFindSession = false;
        let didUpdateSession = false;
        const sessions = prev.sessions.map((session) => {
          if (session.id !== sessionId) {
            return session;
          }

          didFindSession = true;
          const nextSession = updater(session);

          if (nextSession !== session) {
            didUpdateSession = true;
          }

          return nextSession;
        });

        if (!didFindSession || !didUpdateSession) {
          return prev;
        }

        return {
          ...prev,
          sessions,
        };
      });
    },
    [applyShellState],
  );

  const setDraftValue = useCallback(
    (value: SetStateAction<string>): void => {
      const sessionId = activeSession.id;

      applyShellState((prev) => {
        let didFindSession = false;
        let didUpdateSession = false;
        const updatedAt = Date.now();
        const sessions = prev.sessions.map((session) => {
          if (session.id !== sessionId) {
            return session;
          }

          didFindSession = true;
          const nextDraft =
            typeof value === "function" ? value(session.draft) : value;

          if (session.draft === nextDraft) {
            return session;
          }

          didUpdateSession = true;
          return {
            ...session,
            draft: nextDraft,
            updatedAt,
            composerUpdatedAt: updatedAt,
          };
        });

        if (!didFindSession || !didUpdateSession) {
          return prev;
        }

        return {
          ...prev,
          sessions,
        };
      });
    },
    [activeSession.id, applyShellState],
  );

  const setActiveSessionId = useCallback(
    (sessionId: string): void => {
      setActiveSessionIdState(sessionId);
      applyShellState((prev) => {
        const readAt = Date.now();
        let didUpdateReadState = false;
        const sessions = prev.sessions.map((session) => {
          if (session.id !== sessionId) {
            return session;
          }

          const nextSession = markSessionRead(session, readAt);

          if (nextSession !== session) {
            didUpdateReadState = true;
          }

          return nextSession;
        });

        if (prev.activeSessionId === sessionId && !didUpdateReadState) {
          return prev;
        }

        return {
          ...prev,
          activeSessionId: sessionId,
          sessions,
        };
      });
    },
    [applyShellState],
  );

  return {
    shellState,
    activeSessionId: activeSession.id,
    activeSession,
    visibleMessages,
    filteredSessions,
    hasHydrated,
    sessionScopeFilter,
    sessionStatusFilters,
    sessionSearchQuery,
    sessionProjectFilter,
    sessionTagFilters,
    sessionHistoryIndex,
    sessionProjectFacets: sessionHistoryIndex.projects,
    sessionTagFacets: sessionHistoryIndex.tags,
    catalogOpen,
    settingsSection,
    isRenamingSession,
    renameValue,
    promptHistoryIndex,
    draftBeforeHistory,
    bottomRef: newestMessageScroll.bottomRef,
    showScrollToNewestButton: newestMessageScroll.showScrollToNewestButton,
    scrollToNewest: newestMessageScroll.scrollToNewest,
    setCatalogOpen,
    setSettingsSection,
    setActiveSessionId,
    setSessionScopeFilter,
    setSessionStatusFilters,
    setSessionSearchQuery,
    setSessionProjectFilter,
    setSessionTagFilters,
    setIsRenamingSession,
    setRenameValue,
    setPromptHistoryIndex,
    setDraftBeforeHistory,
    applyShellState,
    updateActiveSession,
    updateSessionById,
    setDraftValue,
  };
};
