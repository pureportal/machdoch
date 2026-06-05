import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type {
  ChatSessionMessage,
  ChatSessionRecord,
  ShellPersistedState,
} from "../../chat-session.model";
import {
  disableRemoteControlServer,
  enableRemoteControlServer,
  forgetRemoteControlPairings,
  getRemoteControlStatus,
  openRemoteControlUrl,
  setRemoteControlPort,
  subscribeToRemoteControlCommands,
  type RemoteControlCommandEvent,
  type RemoteControlStatus,
} from "../../runtime";
import type { SubmitTaskToSessionOptions } from "./use-session-task-submission";

interface QueuedRemoteFollowUp {
  commandId: string;
  taskId: string;
  prompt: string;
}

export interface RemoteMissionControlController {
  status: RemoteControlStatus | null;
  loading: boolean;
  message: string | null;
  open: boolean;
  setOpen: (open: boolean) => void;
  onEnable: () => Promise<void>;
  onDisable: () => Promise<void>;
  onOpenUrl: () => Promise<void>;
  onSavePort: (port: number) => Promise<void>;
  onForgetPairings: () => Promise<void>;
}

const STATUS_REFRESH_MS = 2_500;
const QUEUE_FLUSH_MS = 1_000;

const findSessionByTaskId = (
  sessions: ChatSessionRecord[],
  taskId: string | undefined,
): ChatSessionRecord | null => {
  if (!taskId) {
    return null;
  }

  return (
    sessions.find((session) =>
      session.messages.some((message) => message.taskId === taskId),
    ) ?? null
  );
};

const findTaskMessage = (
  session: ChatSessionRecord,
  taskId: string | undefined,
  predicate: (message: ChatSessionMessage) => boolean,
): ChatSessionMessage | null => {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];

    if (taskId && message?.taskId !== taskId) {
      continue;
    }

    if (message && predicate(message)) {
      return message;
    }
  }

  return null;
};

export const useRemoteMissionControl = (options: {
  shellState: ShellPersistedState;
  activeSession: ChatSessionRecord;
  activeDesktopTasksRef: MutableRefObject<Map<string, string>>;
  submitTaskToSession: (options: SubmitTaskToSessionOptions) => void;
  onRetryTask: (message: ChatSessionMessage) => void;
  onContinueTask: (message: ChatSessionMessage) => void;
  onCancelSessionTask: (session: ChatSessionRecord) => void;
}): RemoteMissionControlController => {
  const [status, setStatus] = useState<RemoteControlStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const handledCommandIdsRef = useRef<Set<string>>(new Set());
  const queuedFollowUpsRef = useRef<QueuedRemoteFollowUp[]>([]);

  const getSessionForCommand = useCallback(
    (command: Pick<RemoteControlCommandEvent, "taskId">): ChatSessionRecord => {
      const activeTaskSessionId = command.taskId
        ? options.activeDesktopTasksRef.current.get(command.taskId)
        : undefined;
      const activeTaskSession = activeTaskSessionId
        ? options.shellState.sessions.find(
            (session) => session.id === activeTaskSessionId,
          )
        : null;

      return (
        activeTaskSession ??
        findSessionByTaskId(options.shellState.sessions, command.taskId) ??
        options.activeSession
      );
    },
    [options.activeDesktopTasksRef, options.activeSession, options.shellState.sessions],
  );

  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      setStatus(await getRemoteControlStatus());
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const submitFollowUp = useCallback(
    (command: QueuedRemoteFollowUp): void => {
      const sourceSession = getSessionForCommand({ taskId: command.taskId });

      options.submitTaskToSession({
        sessionSnapshot: sourceSession,
        task: command.prompt,
        contextAttachments: [],
        clearDraft: false,
        activateSession: true,
        visibleMessageContent: command.prompt,
        promptHistoryContent: command.prompt,
      });
    },
    [getSessionForCommand, options],
  );

  const flushQueuedFollowUps = useCallback((): void => {
    const pending = queuedFollowUpsRef.current;

    if (pending.length === 0) {
      return;
    }

    const remaining: QueuedRemoteFollowUp[] = [];

    for (const command of pending) {
      if (options.activeDesktopTasksRef.current.has(command.taskId)) {
        remaining.push(command);
        continue;
      }

      submitFollowUp(command);
    }

    queuedFollowUpsRef.current = remaining;
  }, [options.activeDesktopTasksRef, submitFollowUp]);

  const handleCommand = useCallback(
    (command: RemoteControlCommandEvent): void => {
      if (handledCommandIdsRef.current.has(command.commandId)) {
        return;
      }

      handledCommandIdsRef.current.add(command.commandId);

      if (handledCommandIdsRef.current.size > 500) {
        handledCommandIdsRef.current = new Set(
          [...handledCommandIdsRef.current].slice(-250),
        );
      }

      const sourceSession = getSessionForCommand(command);

      switch (command.kind) {
        case "cancel": {
          options.onCancelSessionTask(sourceSession);
          break;
        }

        case "retry": {
          const message = findTaskMessage(
            sourceSession,
            command.taskId,
            (entry) =>
              entry.role === "agent" &&
              (entry.source?.kind === "execution" ||
                entry.content.startsWith("**Task crashed.**")),
          );

          if (message) {
            options.onRetryTask(message);
          }
          break;
        }

        case "continue": {
          const message = findTaskMessage(
            sourceSession,
            command.taskId,
            (entry) =>
              entry.role === "agent" &&
              (entry.source?.kind === "execution" ||
                entry.content.startsWith("**Task crashed.**")),
          );

          if (message) {
            options.onContinueTask(message);
          }
          break;
        }

        case "follow-up": {
          const prompt = command.prompt?.trim();

          if (!prompt) {
            break;
          }

          if (
            command.taskId &&
            options.activeDesktopTasksRef.current.has(command.taskId)
          ) {
            queuedFollowUpsRef.current = [
              ...queuedFollowUpsRef.current,
              {
                commandId: command.commandId,
                taskId: command.taskId,
                prompt,
              },
            ];
            break;
          }

          options.submitTaskToSession({
            sessionSnapshot: sourceSession,
            task: prompt,
            contextAttachments: [],
            clearDraft: false,
            activateSession: true,
            visibleMessageContent: prompt,
            promptHistoryContent: prompt,
          });
          break;
        }

        case "approval-decision": {
          setMessage(
            command.decision
              ? `Remote approval ${command.decision} received.`
              : "Remote approval response received.",
          );
          break;
        }
      }
    },
    [getSessionForCommand, options],
  );

  const enable = useCallback(async (): Promise<void> => {
    setLoading(true);
    setMessage(null);

    try {
      setStatus(await enableRemoteControlServer());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  const disable = useCallback(async (): Promise<void> => {
    setLoading(true);
    setMessage(null);

    try {
      setStatus(await disableRemoteControlServer());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  const openUrl = useCallback(async (): Promise<void> => {
    setMessage(null);

    try {
      await openRemoteControlUrl(status?.displayUrl);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [status?.displayUrl]);

  const savePort = useCallback(async (port: number): Promise<void> => {
    setLoading(true);
    setMessage(null);

    try {
      setStatus(await setRemoteControlPort(port));
      setMessage("Mission Control port saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  const forgetPairings = useCallback(async (): Promise<void> => {
    setLoading(true);
    setMessage(null);

    try {
      setStatus(await forgetRemoteControlPairings());
      setMessage("Mission Control pairings revoked.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (!status?.enabled) {
      return;
    }

    const refreshInterval = window.setInterval(() => {
      void refreshStatus();
    }, STATUS_REFRESH_MS);

    return () => {
      window.clearInterval(refreshInterval);
    };
  }, [refreshStatus, status?.enabled]);

  useEffect(() => {
    const flushInterval = window.setInterval(
      flushQueuedFollowUps,
      QUEUE_FLUSH_MS,
    );

    return () => {
      window.clearInterval(flushInterval);
    };
  }, [flushQueuedFollowUps]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void subscribeToRemoteControlCommands((command) => {
      if (!disposed) {
        handleCommand(command);
      }
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
  }, [handleCommand]);

  return {
    status,
    loading,
    message,
    open,
    setOpen,
    onEnable: enable,
    onDisable: disable,
    onOpenUrl: openUrl,
    onSavePort: savePort,
    onForgetPairings: forgetPairings,
  };
};
