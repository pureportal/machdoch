import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  getSessionTitle,
  normalizeShellState,
  recoverInterruptedTasksForLaunch,
  sortSessionsByUpdatedAt,
  type ChatSessionMessage,
  type ChatSessionRecord,
  type ShellPersistedState,
} from "../../chat-session.model";
import {
  broadcastShellStateChanged,
  getCurrentShellWindowLabel,
  loadShellState,
  saveShellState,
  subscribeToShellStateChanged,
} from "../../lib/shell-store";
import { loadDesktopLaunchId } from "../../runtime";
import {
  type SessionScopeFilter,
  type SessionStatusFilter,
  type SettingsSection,
} from "./session-shell";
import { filterSessions } from "./session-shell-view-model";

const serializeShellFragment = (value: unknown): string => {
  return JSON.stringify(value);
};

const getSessionPersistenceTimestamp = (
  session: ChatSessionRecord,
): number => {
  let timestamp = Math.max(session.updatedAt, session.archivedAt ?? 0);

  for (const message of session.messages) {
    timestamp = Math.max(timestamp, message.createdAt ?? 0);
  }

  return timestamp;
};

const areShellFragmentsEqual = (left: unknown, right: unknown): boolean => {
  return serializeShellFragment(left) === serializeShellFragment(right);
};

const mergeShellStateForPersistence = (
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

    mergedSessionsById.set(
      sessionId,
      localTimestamp >= latestTimestamp ? localSession : latestSession,
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
  const mergedState: ShellPersistedState = {
    ...latestState,
    version: 1,
    activeSessionId: activeSessionId ?? latestState.activeSessionId,
    sessions,
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

  if (localState.lastSelectedProfile !== baseState.lastSelectedProfile) {
    if (localState.lastSelectedProfile) {
      mergedState.lastSelectedProfile = localState.lastSelectedProfile;
    } else {
      delete mergedState.lastSelectedProfile;
    }
  } else if (latestState.lastSelectedProfile) {
    mergedState.lastSelectedProfile = latestState.lastSelectedProfile;
  } else {
    delete mergedState.lastSelectedProfile;
  }

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

export interface ChatSessionShellStateController {
  shellState: ShellPersistedState;
  activeSessionId: string;
  activeSession: ChatSessionRecord;
  visibleMessages: ChatSessionMessage[];
  filteredSessions: ChatSessionRecord[];
  hasHydrated: boolean;
  sessionScopeFilter: SessionScopeFilter;
  sessionStatusFilter: SessionStatusFilter;
  catalogOpen: boolean;
  settingsSection: SettingsSection;
  isRenamingSession: boolean;
  renameValue: string;
  promptHistoryIndex: number | null;
  draftBeforeHistory: string;
  bottomRef: RefObject<HTMLDivElement | null>;
  setCatalogOpen: Dispatch<SetStateAction<boolean>>;
  setSettingsSection: Dispatch<SetStateAction<SettingsSection>>;
  setActiveSessionId: (sessionId: string) => void;
  setSessionScopeFilter: Dispatch<SetStateAction<SessionScopeFilter>>;
  setSessionStatusFilter: Dispatch<SetStateAction<SessionStatusFilter>>;
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
  const [sessionStatusFilter, setSessionStatusFilter] =
    useState<SessionStatusFilter>("any");
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
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastScrollHeightRef = useRef<number | null>(null);
  const lastScrollSessionIdRef = useRef<string | null>(null);
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

  const sortedSessions = useMemo(() => {
    return sortSessionsByUpdatedAt(shellState.sessions);
  }, [shellState.sessions]);

  const filteredSessions = useMemo(() => {
    return filterSessions(
      sortedSessions,
      sessionScopeFilter,
      sessionStatusFilter,
    );
  }, [sessionScopeFilter, sessionStatusFilter, sortedSessions]);

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

  useLayoutEffect(() => {
    const bottomElement = bottomRef.current;

    if (!bottomElement) {
      return;
    }

    const scrollViewport = bottomElement.closest<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );

    if (!scrollViewport) {
      bottomElement.scrollIntoView({ block: "end" });
      return;
    }

    const previousScrollHeight =
      lastScrollSessionIdRef.current === activeSession.id
        ? lastScrollHeightRef.current
        : null;
    const wasNearBottom =
      previousScrollHeight === null ||
      previousScrollHeight -
        scrollViewport.scrollTop -
        scrollViewport.clientHeight <=
        96;

    lastScrollSessionIdRef.current = activeSession.id;
    lastScrollHeightRef.current = scrollViewport.scrollHeight;

    if (wasNearBottom) {
      scrollViewport.scrollTop = scrollViewport.scrollHeight;
    }
  }, [activeSession.id, visibleMessages]);

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
    let cancelled = false;

    void Promise.all([
      loadShellState(initialShellStateRef.current),
      loadDesktopLaunchId(),
    ])
      .then(([value, launchId]) => {
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

        lastPersistedShellStateRef.current = normalizedShellState;
        setShellState(normalizedShellState);
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
        if (prev.activeSessionId === sessionId) {
          return prev;
        }

        return {
          ...prev,
          activeSessionId: sessionId,
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
    sessionStatusFilter,
    catalogOpen,
    settingsSection,
    isRenamingSession,
    renameValue,
    promptHistoryIndex,
    draftBeforeHistory,
    bottomRef,
    setCatalogOpen,
    setSettingsSection,
    setActiveSessionId,
    setSessionScopeFilter,
    setSessionStatusFilter,
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
