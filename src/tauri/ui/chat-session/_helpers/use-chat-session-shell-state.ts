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
  getSessionTitle,
  markSessionRead,
  mergeRecentWorkspaces,
  normalizeShellState,
  recoverInterruptedTasksForLaunch,
  sortSessionsByUpdatedAt,
  type ChatSessionMessage,
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
  type SessionHistoryProjectFacet,
  type SessionHistoryTagFacet,
} from "./session-history-index";
import { useNewestMessageScroll } from "./use-newest-message-scroll";

const serializeShellFragment = (value: unknown): string => {
  return JSON.stringify(value);
};

const getSessionPersistenceTimestamp = (
  session: ChatSessionRecord,
): number => {
  let timestamp = Math.max(
    session.updatedAt,
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
  return serializeShellFragment(left) === serializeShellFragment(right);
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

  return baseMessages.some((message) => !messageIds.has(message.id));
};

const mergeAppendOnlyMessages = (
  localMessages: readonly ChatSessionMessage[],
  latestMessages: readonly ChatSessionMessage[],
): ChatSessionMessage[] => {
  const messagesById = new Map<string, ChatSessionMessage>();

  for (const message of [...localMessages, ...latestMessages]) {
    if (!messagesById.has(message.id)) {
      messagesById.set(message.id, message);
    }
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

  if (localChanged && !latestChanged) {
    return localSession.messages;
  }

  if (!localChanged && latestChanged) {
    return latestSession.messages;
  }

  if (
    localChanged &&
    latestChanged &&
    !didRemoveBaseMessages(localSession.messages, baseSession.messages) &&
    !didRemoveBaseMessages(latestSession.messages, baseSession.messages)
  ) {
    return mergeAppendOnlyMessages(localSession.messages, latestSession.messages);
  }

  return primarySession.messages;
};

const mergeSessionConcurrentFields = (
  primarySession: ChatSessionRecord,
  localSession: ChatSessionRecord,
  baseSession: ChatSessionRecord,
  latestSession: ChatSessionRecord,
): ChatSessionRecord => {
  return {
    ...primarySession,
    draft: mergeSessionFieldForPersistence(
      primarySession.draft,
      localSession.draft,
      baseSession.draft,
      latestSession.draft,
    ),
    draftContextAttachments: mergeSessionFieldForPersistence(
      primarySession.draftContextAttachments,
      localSession.draftContextAttachments,
      baseSession.draftContextAttachments,
      latestSession.draftContextAttachments,
    ),
    messages: mergeSessionMessagesForPersistence(
      primarySession,
      localSession,
      baseSession,
      latestSession,
    ),
    promptHistory: mergeSessionFieldForPersistence(
      primarySession.promptHistory,
      localSession.promptHistory,
      baseSession.promptHistory,
      latestSession.promptHistory,
    ),
    promptContextHistory: mergeSessionFieldForPersistence(
      primarySession.promptContextHistory,
      localSession.promptContextHistory,
      baseSession.promptContextHistory,
      latestSession.promptContextHistory,
    ),
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

    const localSessionChanged =
      !baseSession || !areShellFragmentsEqual(localSession, baseSession);

    if (!localSessionChanged && latestSession) {
      mergedSessionsById.set(sessionId, latestSession);
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
      mergedSessionsById.set(sessionId, primarySession);
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
    localState.activeSessionId !== baseState.activeSessionId &&
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
    contextPacks: mergeContextPacksForPersistence(
      localState.contextPacks,
      baseState.contextPacks,
      latestState.contextPacks,
    ),
    recentWorkspaces:
      localRecentWorkspacesChanged && latestRecentWorkspacesChanged
        ? mergeRecentWorkspaces(
            localState.recentWorkspaces,
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

export const mergeShellStateFromExternalUpdate = (
  currentState: ShellPersistedState,
  baseState: ShellPersistedState,
  externalState: ShellPersistedState,
  hasUnpersistedLocalChanges: boolean,
): ShellPersistedState => {
  return hasUnpersistedLocalChanges
    ? mergeShellStateForPersistence(currentState, baseState, externalState)
    : externalState;
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
  setDraftValue: (value: string) => void;
  scheduleMessage: (callback: () => void, delay: number) => void;
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
  const [draftsBySessionId, setDraftsBySessionId] = useState<
    Record<string, string>
  >({});
  const [activeSessionId, setActiveSessionIdState] = useState<string>(
    initialShellStateRef.current.activeSessionId,
  );
  const [hasHydrated, setHasHydrated] = useState(false);
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
  const scheduledTimeoutsRef = useRef<number[]>([]);

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

  const activeSession = useMemo<ChatSessionRecord>(() => {
    return {
      ...rawActiveSession,
      draft: draftsBySessionId[rawActiveSession.id] ?? rawActiveSession.draft,
    };
  }, [draftsBySessionId, rawActiveSession]);

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
    return createSessionHistoryIndex(sortedSessions);
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
      if (!hasHydrated) {
        didMutateBeforeHydrationRef.current = true;
      }

      localMutationRevisionRef.current += 1;
      setShellState(updater);
    },
    [hasHydrated],
  );

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
    const sessionIds = new Set(
      shellState.sessions.map((session) => session.id),
    );

    setDraftsBySessionId((prev) => {
      let changed = false;
      const nextDrafts: Record<string, string> = {};

      for (const [sessionId, draft] of Object.entries(prev)) {
        if (!sessionIds.has(sessionId)) {
          changed = true;
          continue;
        }

        nextDrafts[sessionId] = draft;
      }

      return changed ? nextDrafts : prev;
    });
  }, [shellState.sessions]);

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

        if (didMutateBeforeHydrationRef.current) {
          return;
        }

        const normalizedShellState = normalizeShellState(value);
        const recoveredShellState = recoverInterruptedTasksForLaunch(
          normalizedShellState,
          launchId,
          Date.now(),
          activeDesktopTaskIds ?? undefined,
        );

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

    const persistShellState = async (): Promise<void> => {
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

          if (!areShellFragmentsEqual(shellStateRef.current, mergedShellState)) {
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
    };

    void persistShellState();
  }, [hasHydrated, shellState]);

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

        lastPersistedShellStateRef.current = normalizedShellState;

        if (!areShellFragmentsEqual(shellStateRef.current, nextShellState)) {
          setShellState(nextShellState);
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

  useEffect(() => {
    return () => {
      scheduledTimeoutsRef.current.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      scheduledTimeoutsRef.current = [];
    };
  }, []);

  const updateActiveSession = useCallback(
    (updater: (session: ChatSessionRecord) => ChatSessionRecord): void => {
      applyShellState((prev) => ({
        ...prev,
        sessions: prev.sessions.map((session) =>
          session.id === activeSession.id ? updater(session) : session,
        ),
      }));
    },
    [activeSession.id, applyShellState],
  );

  const updateSessionById = useCallback(
    (
      sessionId: string,
      updater: (session: ChatSessionRecord) => ChatSessionRecord,
    ): void => {
      applyShellState((prev) => ({
        ...prev,
        sessions: prev.sessions.map((session) =>
          session.id === sessionId ? updater(session) : session,
        ),
      }));
    },
    [applyShellState],
  );

  const setDraftValue = useCallback(
    (value: string): void => {
      setDraftsBySessionId((prev) => {
        if (prev[activeSession.id] === value) {
          return prev;
        }

        return {
          ...prev,
          [activeSession.id]: value,
        };
      });
    },
    [activeSession.id],
  );

  const scheduleMessage = useCallback((callback: () => void, delay: number) => {
    const timeoutId = window.setTimeout(() => {
      scheduledTimeoutsRef.current = scheduledTimeoutsRef.current.filter(
        (entry) => entry !== timeoutId,
      );
      callback();
    }, delay);

    scheduledTimeoutsRef.current.push(timeoutId);
  }, []);

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
    scheduleMessage,
  };
};
