import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type {
  ChatSessionMessage,
  ChatSessionContextAttachment,
  ChatSessionRecord,
  SmartContextPack,
  ShellPersistedState,
} from "../../chat-session.model";
import {
  canArchiveSession,
  canDeleteSession,
  canDuplicateSession,
  canPinSession,
  canRenameSession,
  getSessionOverviewStatus,
  getSessionTitle,
} from "../../chat-session.model";
import {
  getSmartContextPackScope,
  getSmartContextPackScopeLabel,
} from "./smart-context-packs";
import {
  cancelSchedulerRun,
  deleteSchedulerJob,
  disableRemoteControlServer,
  enableRemoteControlServer,
  forgetRemoteControlPairings,
  getRemoteControlStatus,
  listSchedulerJobs,
  listSchedulerRuns,
  openRemoteControlUrl,
  pauseSchedulerJob,
  REASONING_MODE_ORDER,
  resumeSchedulerJob,
  retrySchedulerRun,
  setRemoteControlPort,
  subscribeToRemoteControlCommands,
  triggerSchedulerJob,
  updateRemoteControlShellSnapshot,
  type RemoteControlCommandEvent,
  type RemoteControlShellSnapshot,
  type RemoteShellAttachmentSnapshot,
  type RemoteShellContextPackSnapshot,
  type RemoteShellMessageSnapshot,
  type RemoteShellMessageSourceSnapshot,
  type RemoteShellProviderStatusSnapshot,
  type RemoteShellRuntimeCapabilitySnapshot,
  type RemoteShellSchedulerJobSnapshot,
  type RemoteShellSchedulerRunSnapshot,
  type RemoteShellSchedulerSnapshot,
  type RuntimeSnapshot,
  type RemoteControlStatus,
  type SchedulerJobSummary,
  type SchedulerRunSummary,
} from "../../runtime";
import type { RuntimeProvider } from "../../model-catalog";
import { getRenderedMessageContent } from "./execution-message";
import type { SubmitTaskToSessionOptions } from "./use-session-task-submission";

interface QueuedRemoteFollowUp {
  commandId: string;
  taskId: string;
  prompt: string;
}

interface RemoteSchedulerState {
  snapshot: RemoteShellSchedulerSnapshot | null;
  loading: boolean;
  error: string | null;
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
const SCHEDULER_REFRESH_MS = 10_000;
const SNAPSHOT_PUBLISH_DELAY_MS = 250;
const REMOTE_MESSAGE_LIMIT = 80;
const REMOTE_SESSION_LIMIT = 80;
const REMOTE_PROMPT_HISTORY_LIMIT = 30;

const runtimeModes = new Set(["ask", "machdoch"]);
const runtimeReasoningModes = new Set<string>(REASONING_MODE_ORDER);

const isRuntimeMode = (
  value: string | undefined,
): value is RuntimeSnapshot["mode"] => {
  return Boolean(value && runtimeModes.has(value));
};

const isRuntimeReasoningMode = (
  value: string | undefined,
): value is RuntimeSnapshot["reasoning"] => {
  return Boolean(value && runtimeReasoningModes.has(value));
};

const createAttachmentSnapshot = (
  attachment: ChatSessionContextAttachment,
): RemoteShellAttachmentSnapshot => ({
  id: attachment.id,
  kind: attachment.kind,
  name: attachment.name,
  path: attachment.path,
  ...(attachment.parent ? { parent: attachment.parent } : {}),
});

const createMessageSourceSnapshot = (
  message: ChatSessionMessage,
): RemoteShellMessageSourceSnapshot | undefined => {
  const source = message.source;

  if (!source) {
    return undefined;
  }

  if (source.kind === "execution") {
    return {
      kind: "execution",
      status: source.execution.status,
      title: source.execution.task,
      summary: source.execution.summary,
      mode: source.execution.mode,
      entries: source.execution.outputSections
        .filter((section) => section.audience !== "internal")
        .flatMap((section) =>
          section.lines.slice(0, 4).map((line) => ({
            label: section.title,
            detail: line,
            ...(section.tone ? { tone: section.tone } : {}),
          })),
        )
        .slice(0, 24),
      timeline: [],
    };
  }

  if (source.kind === "preview") {
    return {
      kind: "preview",
      title: source.preview.task,
      summary: source.preview.summary,
      mode: source.preview.mode,
      entries: source.preview.steps.slice(0, 24).map((step) => ({
        label: step.title,
        detail: step.description,
      })),
      timeline: [],
    };
  }

  if (source.kind === "thinking") {
    return {
      kind: "thinking",
      status: source.thinking.status,
      ...(source.thinking.task ? { title: source.thinking.task } : {}),
      ...(source.thinking.assistantText
        ? { summary: source.thinking.assistantText }
        : {}),
      mode: source.thinking.mode,
      entries: source.thinking.entries.slice(-24).map((entry) => ({
        label: entry.label,
        detail: entry.detail,
        tone: entry.tone,
        timestamp: entry.timestamp,
      })),
      timeline: (source.thinking.timelineEvents ?? []).slice(-40).map((entry) => ({
        label: entry.label,
        detail: entry.detail,
        tone: entry.tone,
        timestamp: entry.timestamp,
      })),
    };
  }

  return undefined;
};

const canRetryOrContinueMessage = (message: ChatSessionMessage): boolean => {
  return (
    message.role === "agent" &&
    (message.source?.kind === "execution" ||
      message.content.startsWith("**Task crashed.**"))
  );
};

const createMessageSnapshot = (
  message: ChatSessionMessage,
  speakingMessageId: string | null,
  voiceSupported: boolean,
): RemoteShellMessageSnapshot => {
  const source = createMessageSourceSnapshot(message);

  return {
    id: message.id,
    role: message.role,
    content: getRenderedMessageContent(message) || message.content,
    ...(typeof message.createdAt === "number" ? { createdAt: message.createdAt } : {}),
    ...(message.taskId ? { taskId: message.taskId } : {}),
    ...(message.intent ? { intent: message.intent } : {}),
    attachments: (message.contextAttachments ?? []).map(createAttachmentSnapshot),
    ...(source ? { source } : {}),
    actions: {
      canRetry: canRetryOrContinueMessage(message),
      canContinue: canRetryOrContinueMessage(message),
      canSaveAsContextPack: message.content.trim().length > 0,
      canSpeak: voiceSupported && message.role === "agent",
      isSpeaking: speakingMessageId === message.id,
    },
  };
};

const findRunningTaskIdForSession = (
  activeDesktopTasksRef: MutableRefObject<Map<string, string>>,
  sessionId: string,
): string | undefined => {
  for (const [taskId, activeSessionId] of activeDesktopTasksRef.current.entries()) {
    if (activeSessionId === sessionId) {
      return taskId;
    }
  }

  return undefined;
};

const createSessionSnapshot = (
  session: ChatSessionRecord,
  activeDesktopTasksRef: MutableRefObject<Map<string, string>>,
  defaultMode: RuntimeSnapshot["mode"],
  defaultReasoning: RuntimeSnapshot["reasoning"],
) => {
  const specialKind = session.specialSession;

  return {
    id: session.id,
    title: getSessionTitle(session),
    status: getSessionOverviewStatus(session),
    ...(session.workspace ? { workspace: session.workspace } : {}),
    provider: session.provider,
    model: session.model,
    ...(session.mode ? { mode: session.mode } : {}),
    effectiveMode: session.mode ?? defaultMode,
    ...(session.reasoning ? { reasoning: session.reasoning } : {}),
    effectiveReasoning: session.reasoning ?? defaultReasoning,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(typeof session.archivedAt === "number" ? { archivedAt: session.archivedAt } : {}),
    ...(typeof session.pinnedAt === "number" ? { pinnedAt: session.pinnedAt } : {}),
    tags: session.tags,
    messageCount: session.messages.length,
    promptHistoryCount: session.promptHistory.length,
    attachmentCount: session.draftContextAttachments.length,
    ...(findRunningTaskIdForSession(activeDesktopTasksRef, session.id)
      ? {
          runningTaskId: findRunningTaskIdForSession(
            activeDesktopTasksRef,
            session.id,
          ),
        }
      : {}),
    canRename: canRenameSession(session),
    canDelete: canDeleteSession(session),
    canArchive: canArchiveSession(session),
    canPin: canPinSession(session),
    canDuplicate: canDuplicateSession(session),
    canBranch: canDuplicateSession(session),
    ...(specialKind ? { specialKind } : {}),
  };
};

const formatTimestamp = (timestamp: number | null | undefined): string => {
  if (!timestamp) {
    return "none";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
};

const formatDuration = (milliseconds: number | null | undefined): string => {
  if (!milliseconds) {
    return "default";
  }

  if (milliseconds < 60_000) {
    return `${Math.round(milliseconds / 1_000)}s`;
  }

  if (milliseconds < 3_600_000) {
    return `${Math.round(milliseconds / 60_000)}m`;
  }

  return `${Math.round(milliseconds / 3_600_000)}h`;
};

const formatSchedulerSchedule = (
  job: SchedulerJobSummary,
): string => {
  const schedule = job.schedule;

  if (!schedule) {
    return job.triggerLabel || "Event triggered";
  }

  switch (schedule.type) {
    case "cron":
      return `${schedule.expression} | ${schedule.timezone}`;
    case "interval":
      return `every ${formatDuration(schedule.intervalMs)}`;
    case "delay":
      return `at ${formatTimestamp(schedule.runAt)}`;
  }
};

const createSchedulerJobSnapshot = (
  job: SchedulerJobSummary,
): RemoteShellSchedulerJobSnapshot => ({
  id: job.id,
  name: job.name,
  status: job.status,
  schedule: formatSchedulerSchedule(job),
  promptPreview: job.prompt,
  ...(job.nextRunAt ? { nextRunAt: job.nextRunAt } : {}),
  ...(job.lastStartedAt ? { lastStartedAt: job.lastStartedAt } : {}),
  ...(job.lastFinishedAt ? { lastFinishedAt: job.lastFinishedAt } : {}),
});

const createSchedulerRunSnapshot = (
  run: SchedulerRunSummary,
): RemoteShellSchedulerRunSnapshot => ({
  id: run.id,
  jobId: run.jobId,
  source: run.source,
  status: run.status,
  scheduledFor: run.scheduledFor,
  updatedAt: run.updatedAt,
  attempt: run.attempt,
  maxAttempts: run.maxAttempts,
  ...(run.startedAt ? { startedAt: run.startedAt } : {}),
  ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
  ...(run.nextAttemptAt ? { nextAttemptAt: run.nextAttemptAt } : {}),
  ...(run.error ? { error: run.error } : {}),
  ...(run.summary ? { summary: run.summary } : {}),
});

const createContextPackSnapshot = (
  pack: SmartContextPack,
  matchedContextPackIds: string[],
): RemoteShellContextPackSnapshot => {
  const scope = getSmartContextPackScope(pack);

  return {
    id: pack.id,
    name: pack.name,
    scope,
    scopeLabel: getSmartContextPackScopeLabel(scope),
    ...(pack.workspace ? { workspace: pack.workspace } : {}),
    instructionsPreview: pack.instructions,
    promptPreview: pack.prompt,
    attachmentCount: pack.contextAttachments.length,
    variables: pack.variables.map((variable) => variable.name),
    matched: matchedContextPackIds.includes(pack.id),
    ...(pack.provider ? { provider: pack.provider } : {}),
    ...(pack.model ? { model: pack.model } : {}),
    ...(pack.mode ? { mode: pack.mode } : {}),
    ...(pack.reasoning ? { reasoning: pack.reasoning } : {}),
  };
};

const createRuntimeCapabilitySnapshot = (
  available: boolean,
  reason?: string,
): RemoteShellRuntimeCapabilitySnapshot => ({
  available,
  ...(reason ? { reason } : {}),
});

const createProviderStatusSnapshots = (
  runtimeSnapshot: RuntimeSnapshot | null,
): RemoteShellProviderStatusSnapshot[] => {
  return (runtimeSnapshot?.providerAvailability ?? []).map((entry) => ({
    provider: entry.provider,
    available: entry.configured,
    ...(!entry.configured ? { reason: "API key is not configured." } : {}),
  }));
};

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
  visibleMessages: ChatSessionMessage[];
  runtimeSnapshot: RuntimeSnapshot | null;
  runtimeLoading: boolean;
  runtimeError: string | null;
  hasAnyProvider: boolean;
  chooserProviders: RuntimeProvider[];
  defaultMode: RuntimeSnapshot["mode"];
  defaultReasoning: RuntimeSnapshot["reasoning"];
  activeRunMode: RuntimeSnapshot["mode"];
  activeReasoning: RuntimeSnapshot["reasoning"];
  composerWorkspaceLabel: string;
  isGlobalMemoryAvailable: boolean;
  isGlobalMemoryActive: boolean;
  isUiControlAvailable: boolean;
  uiControlDescription: string;
  canSendMessage: boolean;
  sendDisabledReason: string | null;
  workspaceContextPacks: SmartContextPack[];
  matchedContextPackIds: string[];
  quickTaskSession: ChatSessionRecord | null;
  quickTaskDraft: string;
  quickTaskProvider: RuntimeProvider;
  quickTaskModel: string;
  quickTaskAutopilotEnabled: boolean;
  quickTaskGlobalMemoryEnabled: boolean;
  quickTaskUiControlEnabled: boolean;
  quickTaskAttachmentCount: number;
  quickTaskStatus: string;
  quickTaskIsExecuting: boolean;
  voiceSupported: boolean;
  speakingMessageId: string | null;
  speechInputSupported: boolean;
  speechInputEnabled: boolean;
  speechInputStatus: string | null;
  activeDesktopTasksRef: MutableRefObject<Map<string, string>>;
  submitTaskToSession: (options: SubmitTaskToSessionOptions) => void;
  onRetryTask: (message: ChatSessionMessage) => void;
  onContinueTask: (message: ChatSessionMessage) => void;
  onCancelSessionTask: (session: ChatSessionRecord) => void;
  onCreateSession: (workspace?: string) => void;
  onActivateSession: (sessionId: string) => void;
  onArchiveSession: (sessionId: string) => void;
  onTogglePinnedSession: (sessionId: string) => void;
  onDuplicateSession: (sessionId: string) => void;
  onBranchSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onTagSession: (sessionId: string, tags: string[]) => void;
  onClearSessionHistory: (sessionId: string) => void;
  onUpdateSessionDraft: (sessionId: string, draft: string) => void;
  onSetSessionModel: (
    sessionId: string,
    provider: RuntimeProvider,
    model: string,
  ) => void;
  onSetSessionMode: (
    sessionId: string,
    mode: RuntimeSnapshot["mode"] | null,
  ) => void;
  onSetSessionReasoning: (
    sessionId: string,
    reasoning: RuntimeSnapshot["reasoning"] | null,
  ) => void;
  onSetSessionMemory: (sessionId: string, enabled: boolean) => void;
  onSetGlobalMemory: (sessionId: string, enabled: boolean) => void;
  onSetUiControl: (sessionId: string, enabled: boolean) => void;
  onRemoveContextAttachment: (sessionId: string, attachmentId: string) => void;
  onClearContextAttachments: (sessionId: string) => void;
  onApplyContextPack: (sessionId: string, packId: string) => void;
  onDeleteContextPack: (packId: string) => void;
  onSaveMessageAsContextPack: (message: ChatSessionMessage) => void;
  onSpeakMessage: (message: ChatSessionMessage) => void;
  onStopSpeaking: () => void;
}): RemoteMissionControlController => {
  const [status, setStatus] = useState<RemoteControlStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [schedulerState, setSchedulerState] = useState<RemoteSchedulerState>({
    snapshot: null,
    loading: false,
    error: null,
  });
  const handledCommandIdsRef = useRef<Set<string>>(new Set());
  const queuedFollowUpsRef = useRef<QueuedRemoteFollowUp[]>([]);
  const lastPublishedSnapshotRef = useRef<string>("");

  const getSessionForCommand = useCallback(
    (
      command: Pick<RemoteControlCommandEvent, "taskId" | "sessionId">,
    ): ChatSessionRecord => {
      const explicitSession = command.sessionId
        ? options.shellState.sessions.find(
            (session) => session.id === command.sessionId,
          )
        : null;

      if (explicitSession) {
        return explicitSession;
      }

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

  const refreshScheduler = useCallback(async (): Promise<void> => {
    const workspaceRoot = options.activeSession.workspace;

    if (!workspaceRoot) {
      setSchedulerState({
        snapshot: {
          loading: false,
          jobs: [],
          runs: [],
          updatedAt: Date.now(),
        },
        loading: false,
        error: null,
      });
      return;
    }

    setSchedulerState((current) => ({
      ...current,
      loading: true,
      error: null,
    }));

    try {
      const [jobsResult, runsResult] = await Promise.all([
        listSchedulerJobs(workspaceRoot),
        listSchedulerRuns(workspaceRoot),
      ]);

      setSchedulerState({
        snapshot: {
          workspaceRoot: jobsResult.workspaceRoot || workspaceRoot,
          loading: false,
          jobs: jobsResult.jobs.map(createSchedulerJobSnapshot),
          runs: runsResult.runs.map(createSchedulerRunSnapshot),
          updatedAt: Date.now(),
        },
        loading: false,
        error: null,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setSchedulerState((current) => ({
        snapshot: current.snapshot
          ? {
              ...current.snapshot,
              loading: false,
              error: errorMessage,
              updatedAt: Date.now(),
            }
          : {
              workspaceRoot,
              loading: false,
              error: errorMessage,
              jobs: [],
              runs: [],
              updatedAt: Date.now(),
            },
        loading: false,
        error: errorMessage,
      }));
    }
  }, [options.activeSession.workspace]);

  const createShellSnapshot = useCallback((): RemoteControlShellSnapshot => {
    const schedulerSnapshot = schedulerState.snapshot
      ? {
          ...schedulerState.snapshot,
          loading: schedulerState.loading || schedulerState.snapshot.loading,
          ...(schedulerState.error ? { error: schedulerState.error } : {}),
        }
      : undefined;
    const uiControl = options.runtimeSnapshot?.uiControl;
    const webSearchAvailability =
      options.runtimeSnapshot?.webSearch.providerAvailability ?? [];
    const webSearchConfigured = webSearchAvailability.some(
      (entry) => entry.configured,
    );

    return {
      version: 1,
      capturedAt: Date.now(),
      activeSessionId: options.activeSession.id,
      sessions: options.shellState.sessions
        .slice(0, REMOTE_SESSION_LIMIT)
        .map((session) =>
          createSessionSnapshot(
            session,
            options.activeDesktopTasksRef,
            options.defaultMode,
            options.defaultReasoning,
          ),
        ),
      visibleMessages: options.visibleMessages
        .slice(-REMOTE_MESSAGE_LIMIT)
        .map((entry) =>
          createMessageSnapshot(
            entry,
            options.speakingMessageId,
            options.voiceSupported,
          ),
        ),
      composer: {
        sessionId: options.activeSession.id,
        draft: options.activeSession.draft,
        provider: options.activeSession.provider,
        model: options.activeSession.model,
        mode: options.activeRunMode,
        defaultMode: options.defaultMode,
        reasoning: options.activeReasoning,
        defaultReasoning: options.defaultReasoning,
        ...(options.activeSession.workspace
          ? { workspace: options.activeSession.workspace }
          : {}),
        workspaceLabel: options.composerWorkspaceLabel,
        canSend: options.canSendMessage,
        ...(options.sendDisabledReason
          ? { sendDisabledReason: options.sendDisabledReason }
          : {}),
        isExecuting: getSessionOverviewStatus(options.activeSession) === "running",
        sessionMemoryEnabled: options.activeSession.sessionMemoryEnabled,
        globalMemoryAvailable: options.isGlobalMemoryAvailable,
        globalMemoryEnabled: options.isGlobalMemoryActive,
        uiControlAvailable: options.isUiControlAvailable,
        uiControlEnabled: options.activeSession.uiControlEnabled,
        uiControlDescription: options.uiControlDescription,
        attachments: options.activeSession.draftContextAttachments.map(
          createAttachmentSnapshot,
        ),
        chooserProviders: options.chooserProviders,
        matchedContextPackIds: options.matchedContextPackIds,
      },
      runtime: {
        loading: options.runtimeLoading,
        ...(options.runtimeError ? { error: options.runtimeError } : {}),
        hasAnyProvider: options.hasAnyProvider,
        providerStatuses: createProviderStatusSnapshots(options.runtimeSnapshot),
        ...(options.runtimeSnapshot?.mode ? { mode: options.runtimeSnapshot.mode } : {}),
        ...(options.runtimeSnapshot?.reasoning
          ? { reasoning: options.runtimeSnapshot.reasoning }
          : {}),
        ...(uiControl
          ? {
              uiControl: createRuntimeCapabilitySnapshot(
                uiControl.available,
                uiControl.reason,
              ),
            }
          : {}),
        webSearch: createRuntimeCapabilitySnapshot(
          webSearchConfigured,
          webSearchConfigured ? undefined : "No web search provider is configured.",
        ),
      },
      ...(schedulerSnapshot ? { scheduler: schedulerSnapshot } : {}),
      contextPacks: options.workspaceContextPacks.map((pack) =>
        createContextPackSnapshot(pack, options.matchedContextPackIds),
      ),
      promptHistory: options.activeSession.promptHistory.slice(
        -REMOTE_PROMPT_HISTORY_LIMIT,
      ),
      voice: {
        supported: options.voiceSupported,
        autoSpeakResponses: options.shellState.voice.autoSpeakResponses,
        ...(options.speakingMessageId
          ? { speakingMessageId: options.speakingMessageId }
          : {}),
        speechInputSupported: options.speechInputSupported,
        speechInputEnabled: options.speechInputEnabled,
        ...(options.speechInputStatus
          ? { speechInputStatus: options.speechInputStatus }
          : {}),
      },
      quickTask: {
        status: options.quickTaskStatus,
        draft: options.quickTaskDraft,
        isExecuting: options.quickTaskIsExecuting,
        provider: options.quickTaskProvider,
        model: options.quickTaskModel,
        autopilotEnabled: options.quickTaskAutopilotEnabled,
        globalMemoryEnabled: options.quickTaskGlobalMemoryEnabled,
        uiControlEnabled: options.quickTaskUiControlEnabled,
        attachmentCount: options.quickTaskAttachmentCount,
      },
    };
  }, [options, schedulerState]);

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

  const runRemoteSchedulerAction = useCallback(
    (action: () => Promise<unknown>): void => {
      void action()
        .then(() => refreshScheduler())
        .catch((error) => {
          setMessage(error instanceof Error ? error.message : String(error));
        });
    },
    [refreshScheduler],
  );

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

        case "create-session": {
          options.onCreateSession(command.workspace);
          break;
        }

        case "activate-session": {
          if (command.sessionId) {
            options.onActivateSession(command.sessionId);
          }
          break;
        }

        case "archive-session": {
          if (command.sessionId) {
            options.onArchiveSession(command.sessionId);
          }
          break;
        }

        case "pin-session": {
          if (command.sessionId) {
            options.onTogglePinnedSession(command.sessionId);
          }
          break;
        }

        case "duplicate-session": {
          if (command.sessionId) {
            options.onDuplicateSession(command.sessionId);
          }
          break;
        }

        case "branch-session": {
          if (command.sessionId) {
            options.onBranchSession(command.sessionId);
          }
          break;
        }

        case "delete-session": {
          if (command.sessionId) {
            options.onDeleteSession(command.sessionId);
          }
          break;
        }

        case "rename-session": {
          if (command.sessionId && command.title) {
            options.onRenameSession(command.sessionId, command.title);
          }
          break;
        }

        case "tag-session": {
          if (command.sessionId && command.tags) {
            options.onTagSession(command.sessionId, command.tags);
          }
          break;
        }

        case "clear-session-history": {
          if (command.sessionId) {
            options.onClearSessionHistory(command.sessionId);
          }
          break;
        }

        case "update-draft": {
          if (command.sessionId) {
            options.onUpdateSessionDraft(command.sessionId, command.prompt ?? "");
          }
          break;
        }

        case "set-session-model": {
          const provider = command.provider;

          if (
            command.sessionId &&
            provider &&
            command.model &&
            options.chooserProviders.includes(provider as RuntimeProvider)
          ) {
            options.onSetSessionModel(
              command.sessionId,
              provider as RuntimeProvider,
              command.model,
            );
          }
          break;
        }

        case "set-session-mode": {
          if (command.sessionId && isRuntimeMode(command.mode)) {
            options.onSetSessionMode(command.sessionId, command.mode);
          }
          break;
        }

        case "set-session-reasoning": {
          if (command.sessionId) {
            options.onSetSessionReasoning(
              command.sessionId,
              isRuntimeReasoningMode(command.reasoning)
                ? command.reasoning
                : null,
            );
          }
          break;
        }

        case "set-session-memory": {
          if (command.sessionId && typeof command.enabled === "boolean") {
            options.onSetSessionMemory(command.sessionId, command.enabled);
          }
          break;
        }

        case "set-global-memory": {
          if (command.sessionId && typeof command.enabled === "boolean") {
            options.onSetGlobalMemory(command.sessionId, command.enabled);
          }
          break;
        }

        case "set-ui-control": {
          if (command.sessionId && typeof command.enabled === "boolean") {
            options.onSetUiControl(command.sessionId, command.enabled);
          }
          break;
        }

        case "remove-attachment": {
          if (command.sessionId && command.attachmentId) {
            options.onRemoveContextAttachment(
              command.sessionId,
              command.attachmentId,
            );
          }
          break;
        }

        case "clear-attachments": {
          if (command.sessionId) {
            options.onClearContextAttachments(command.sessionId);
          }
          break;
        }

        case "apply-context-pack": {
          if (command.sessionId && command.contextPackId) {
            options.onApplyContextPack(command.sessionId, command.contextPackId);
          }
          break;
        }

        case "delete-context-pack": {
          if (command.contextPackId) {
            options.onDeleteContextPack(command.contextPackId);
          }
          break;
        }

        case "save-message-context-pack": {
          const targetMessage = sourceSession.messages.find(
            (entry) => entry.id === command.messageId,
          );

          if (targetMessage) {
            options.onSaveMessageAsContextPack(targetMessage);
          }
          break;
        }

        case "speak-message": {
          const targetMessage = sourceSession.messages.find(
            (entry) => entry.id === command.messageId,
          );

          if (targetMessage) {
            options.onSpeakMessage(targetMessage);
          }
          break;
        }

        case "stop-speaking": {
          options.onStopSpeaking();
          break;
        }

        case "scheduler-trigger": {
          if (command.jobId) {
            runRemoteSchedulerAction(() =>
              triggerSchedulerJob(command.workspace ?? options.activeSession.workspace, command.jobId!),
            );
          }
          break;
        }

        case "scheduler-pause": {
          if (command.jobId) {
            runRemoteSchedulerAction(() =>
              pauseSchedulerJob(command.workspace ?? options.activeSession.workspace, command.jobId!),
            );
          }
          break;
        }

        case "scheduler-resume": {
          if (command.jobId) {
            runRemoteSchedulerAction(() =>
              resumeSchedulerJob(command.workspace ?? options.activeSession.workspace, command.jobId!),
            );
          }
          break;
        }

        case "scheduler-delete": {
          if (command.jobId) {
            runRemoteSchedulerAction(() =>
              deleteSchedulerJob(command.workspace ?? options.activeSession.workspace, command.jobId!),
            );
          }
          break;
        }

        case "scheduler-retry-run": {
          if (command.runId) {
            runRemoteSchedulerAction(() =>
              retrySchedulerRun(command.workspace ?? options.activeSession.workspace, command.runId!),
            );
          }
          break;
        }

        case "scheduler-cancel-run": {
          if (command.runId) {
            runRemoteSchedulerAction(() =>
              cancelSchedulerRun(command.workspace ?? options.activeSession.workspace, command.runId!),
            );
          }
          break;
        }
      }
    },
    [getSessionForCommand, options, runRemoteSchedulerAction],
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
    if (!status?.enabled) {
      return;
    }

    void refreshScheduler();
    const refreshInterval = window.setInterval(() => {
      void refreshScheduler();
    }, SCHEDULER_REFRESH_MS);

    return () => {
      window.clearInterval(refreshInterval);
    };
  }, [refreshScheduler, status?.enabled]);

  useEffect(() => {
    if (!status?.enabled) {
      return;
    }

    const publishTimer = window.setTimeout(() => {
      const snapshot = createShellSnapshot();
      const serializedSnapshot = JSON.stringify(snapshot);

      if (serializedSnapshot === lastPublishedSnapshotRef.current) {
        return;
      }

      lastPublishedSnapshotRef.current = serializedSnapshot;
      void updateRemoteControlShellSnapshot(snapshot).catch((error) => {
        setMessage(error instanceof Error ? error.message : String(error));
      });
    }, SNAPSHOT_PUBLISH_DELAY_MS);

    return () => {
      window.clearTimeout(publishTimer);
    };
  }, [createShellSnapshot, status?.enabled]);

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
