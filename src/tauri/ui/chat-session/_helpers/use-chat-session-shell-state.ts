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
  getSessionTitle,
  normalizeShellState,
  sortSessionsByUpdatedAt,
  type ChatSessionMessage,
  type ChatSessionRecord,
  type ShellPersistedState,
} from "../../chat-session.model";
import { loadShellState, saveShellState } from "../../lib/shell-store";
import {
  type SessionScopeFilter,
  type SessionStatusFilter,
  type SettingsSection,
} from "./session-shell";
import { filterSessions } from "./session-shell-view-model";

export interface ChatSessionShellStateController {
  shellState: ShellPersistedState;
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

export const useChatSessionShellState = (): ChatSessionShellStateController => {
  const initialShellStateRef = useRef<ShellPersistedState>(
    createInitialShellState(),
  );
  const [shellState, setShellState] = useState<ShellPersistedState>(
    initialShellStateRef.current,
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
  const bottomRef = useRef<HTMLDivElement>(null);
  const scheduledTimeoutsRef = useRef<number[]>([]);

  const activeSession =
    shellState.sessions.find(
      (session) => session.id === shellState.activeSessionId,
    ) ?? shellState.sessions[0];

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

      setShellState(updater);
    },
    [hasHydrated],
  );

  useEffect(() => {
    document.documentElement.classList.add("dark");

    return () => {
      document.documentElement.classList.remove("dark");
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [visibleMessages]);

  useEffect(() => {
    let cancelled = false;

    void loadShellState(initialShellStateRef.current)
      .then((value) => {
        if (cancelled) {
          return;
        }

        if (
          didMutateBeforeHydrationRef.current ||
          value === initialShellStateRef.current
        ) {
          return;
        }

        setShellState(normalizeShellState(value));
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

    void saveShellState(shellState);
  }, [hasHydrated, shellState]);

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
          session.id === prev.activeSessionId ? updater(session) : session,
        ),
      }));
    },
    [applyShellState],
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
      updateActiveSession((session) => ({
        ...session,
        draft: value,
      }));
    },
    [updateActiveSession],
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

  return {
    shellState,
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
