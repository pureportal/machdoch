import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import {
  isMediaAssetContextAttachment,
  type ChatSessionMessage,
  type ChatSessionContextAttachment,
  type ChatSessionRecord,
  type SmartContextPack,
  type ShellPersistedState,
} from "../../chat-session.model";
import { invoke } from "@tauri-apps/api/core";
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
  cancelDesktopTask,
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
import {
  beginCrossWindowOperation,
  completeCrossWindowOperation,
  releaseCrossWindowOperation,
} from "../../lib/cross-window-operation";
import { getRenderedMessageContent } from "./execution-message";
import type { SubmitTaskToSessionOptions } from "./use-session-task-submission";
import {
  canUseTauriStore,
  getCurrentShellWindowLabel,
} from "../../lib/_helpers/shell-store-storage.helper";

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

const STATUS_REFRESH_MS = 15_000;
const SCHEDULER_REFRESH_MS = 60_000;
const SNAPSHOT_PUBLISH_DELAY_MS = 250;
const PENDING_COMMAND_POLL_MS = 15_000;

class NonRetryableRemoteCommandError extends Error {}

const isTerminalSchedulerCommandError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);

  return [
    "Scheduled job not found",
    "Scheduled run not found",
    "No scheduled job id was provided",
    "No scheduled run id was provided",
    "Expected a workspace root",
    "Scheduler idempotency key was already used",
    "Scheduler mutation idempotency conflict",
  ].some((fragment) => message.includes(fragment));
};
const MAIN_WINDOW_LABEL = "main";
const REMOTE_MESSAGE_LIMIT = 80;
const REMOTE_SESSION_LIMIT = 80;
const REMOTE_PROMPT_HISTORY_LIMIT = 30;
const handledRemoteCommandIds = new Set<string>();

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
): RemoteShellAttachmentSnapshot =>
  isMediaAssetContextAttachment(attachment)
    ? {
        id: attachment.id,
        source: "media-asset",
        kind: attachment.kind,
        name: attachment.name,
        workspaceRoot: attachment.workspaceRoot,
        assetId: attachment.assetId,
      }
    : {
        id: attachment.id,
        source: "path",
        kind: attachment.kind,
        name: attachment.name,
        path: attachment.path,
        ...(attachment.parent ? { parent: attachment.parent } : {}),
      };

const createMessageSourceSnapshot = (
  message: ChatSessionMessage,
): RemoteShellMessageSourceSnapshot | undefined => {
  const source = message.source;

  if (!source) {
    return undefined;
  }

  if (source.kind === "execution") {
    const thinking = source.thinking;

    return {
      kind: "execution",
      status: source.execution.status,
      title: source.execution.task,
      summary: source.execution.summary,
      mode: source.execution.mode,
      entries: thinking
        ? thinking.entries.slice(-24).map((entry) => ({
            label: entry.label,
            detail: entry.detail,
            tone: entry.tone,
            timestamp: entry.timestamp,
          }))
        : source.execution.outputSections
            .filter((section) => section.audience !== "internal")
            .flatMap((section) =>
              section.lines.slice(0, 4).map((line) => ({
                label: section.title,
                detail: line,
                ...(section.tone ? { tone: section.tone } : {}),
              })),
            )
            .slice(0, 24),
      timeline: (thinking?.timelineEvents ?? []).slice(-40).map((entry) => ({
        label: entry.label,
        detail: entry.detail,
        tone: entry.tone,
        timestamp: entry.timestamp,
      })),
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
  hasHydrated: boolean;
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
  flushPersistence: () => Promise<void>;
  onMarkRemoteCommandHandled: (commandId: string) => void;
  submitTaskToSession: (options: SubmitTaskToSessionOptions) => boolean;
  onQueueSessionFollowUp: (sessionId: string, prompt: string) => boolean;
  onRetryTask: (message: ChatSessionMessage) => void;
  onContinueTask: (message: ChatSessionMessage) => void;
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
  onApplyContextPack: (sessionId: string, packId: string) => boolean;
  onDeleteContextPack: (packId: string) => void;
  onSaveMessageAsContextPack: (message: ChatSessionMessage) => void;
  onSpeakMessage: (message: ChatSessionMessage) => void;
  onStopSpeaking: () => void;
}): RemoteMissionControlController => {
  const currentWindowLabel = getCurrentShellWindowLabel();
  const isPrimaryController = canUseTauriStore()
    ? currentWindowLabel === MAIN_WINDOW_LABEL
    : true;
  const [status, setStatus] = useState<RemoteControlStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [snapshotPublishRetrySequence, setSnapshotPublishRetrySequence] =
    useState(0);
  const [schedulerState, setSchedulerState] = useState<RemoteSchedulerState>({
    snapshot: null,
    loading: false,
    error: null,
  });
  const handleCommandRef = useRef<
    (command: RemoteControlCommandEvent) => Promise<void>
  >(
    async () => undefined,
  );
  const lastPublishedSnapshotRef = useRef<string>("");
  const schedulerRefreshSequenceRef = useRef(0);
  const schedulerWorkspaceRef = useRef(options.activeSession.workspace);
  const lastSnapshotCapturedAtRef = useRef(0);
  const snapshotPublishRetryAttemptRef = useRef(0);
  const snapshotPublishRetryTimerRef = useRef<number | null>(null);
  const snapshotPublishAttemptSequenceRef = useRef(0);
  const remoteHookMountedRef = useRef(true);
  const statusPollSequenceRef = useRef(0);
  const statusMutationSequenceRef = useRef(0);
  const statusMutationInFlightRef = useRef(false);
  schedulerWorkspaceRef.current = options.activeSession.workspace;

  const getSessionForCommand = useCallback(
    (
      command: Pick<RemoteControlCommandEvent, "taskId" | "sessionId">,
    ): ChatSessionRecord | null => {
      if (command.sessionId) {
        return (
          options.shellState.sessions.find(
            (session) => session.id === command.sessionId,
          ) ?? null
        );
      }

      const activeTaskSessionId = command.taskId
        ? options.activeDesktopTasksRef.current.get(command.taskId)
        : undefined;
      const activeTaskSession = activeTaskSessionId
        ? options.shellState.sessions.find(
            (session) => session.id === activeTaskSessionId,
          )
        : null;

      if (command.taskId) {
        return (
          activeTaskSession ??
          findSessionByTaskId(options.shellState.sessions, command.taskId)
        );
      }

      return options.activeSession;
    },
    [options.activeDesktopTasksRef, options.activeSession, options.shellState.sessions],
  );

  const refreshStatus = useCallback(async (): Promise<void> => {
    if (statusMutationInFlightRef.current) {
      return;
    }

    const requestSequence = statusPollSequenceRef.current + 1;
    statusPollSequenceRef.current = requestSequence;
    try {
      const nextStatus = await getRemoteControlStatus();
      if (
        requestSequence !== statusPollSequenceRef.current ||
        statusMutationInFlightRef.current
      ) {
        return;
      }
      setStatus(nextStatus);
      setMessage(null);
    } catch (error) {
      if (
        requestSequence !== statusPollSequenceRef.current ||
        statusMutationInFlightRef.current
      ) {
        return;
      }
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const refreshScheduler = useCallback(async (): Promise<void> => {
    const workspaceRoot = options.activeSession.workspace;
    const refreshSequence = schedulerRefreshSequenceRef.current + 1;
    schedulerRefreshSequenceRef.current = refreshSequence;

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

      if (
        refreshSequence !== schedulerRefreshSequenceRef.current ||
        schedulerWorkspaceRef.current !== workspaceRoot
      ) {
        return;
      }

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
      if (
        refreshSequence !== schedulerRefreshSequenceRef.current ||
        schedulerWorkspaceRef.current !== workspaceRoot
      ) {
        return;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      setSchedulerState((current) => ({
        snapshot:
          current.snapshot?.workspaceRoot === workspaceRoot
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
  }, [
    options.activeDesktopTasksRef,
    options.activeReasoning,
    options.activeRunMode,
    options.activeSession,
    options.canSendMessage,
    options.chooserProviders,
    options.composerWorkspaceLabel,
    options.defaultMode,
    options.defaultReasoning,
    options.hasAnyProvider,
    options.isGlobalMemoryActive,
    options.isGlobalMemoryAvailable,
    options.isUiControlAvailable,
    options.matchedContextPackIds,
    options.quickTaskAttachmentCount,
    options.quickTaskAutopilotEnabled,
    options.quickTaskDraft,
    options.quickTaskGlobalMemoryEnabled,
    options.quickTaskIsExecuting,
    options.quickTaskModel,
    options.quickTaskProvider,
    options.quickTaskStatus,
    options.quickTaskUiControlEnabled,
    options.runtimeError,
    options.runtimeLoading,
    options.runtimeSnapshot,
    options.sendDisabledReason,
    options.shellState.sessions,
    options.shellState.voice.autoSpeakResponses,
    options.speakingMessageId,
    options.speechInputEnabled,
    options.speechInputStatus,
    options.speechInputSupported,
    options.uiControlDescription,
    options.visibleMessages,
    options.voiceSupported,
    options.workspaceContextPacks,
    schedulerState,
  ]);

  const runRemoteSchedulerAction = useCallback(
    async (action: () => Promise<unknown>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
        if (isTerminalSchedulerCommandError(error)) {
          throw new NonRetryableRemoteCommandError(
            error instanceof Error ? error.message : String(error),
          );
        }
        throw error;
      }

      try {
        await refreshScheduler();
      } catch (error) {
        setMessage(
          `The scheduler action succeeded, but its refreshed status could not be loaded: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
    [refreshScheduler],
  );

  const handleCommand = useCallback(
    async (command: RemoteControlCommandEvent): Promise<void> => {
      if (
        handledRemoteCommandIds.has(command.commandId) ||
        options.shellState.handledRemoteCommandIds.includes(command.commandId)
      ) {
        handledRemoteCommandIds.add(command.commandId);
        return;
      }

      const sourceSession =
        command.kind === "cancel"
          ? options.activeSession
          : getSessionForCommand(command);

      if (!sourceSession) {
        const targetId = command.sessionId ?? command.taskId ?? "unknown";
        throw new NonRetryableRemoteCommandError(
          `Mission Control target \`${targetId}\` is no longer available.`,
        );
      }

      handledRemoteCommandIds.add(command.commandId);

      if (handledRemoteCommandIds.size > 500) {
        const retainedCommandIds = [...handledRemoteCommandIds].slice(-250);
        handledRemoteCommandIds.clear();

        for (const commandId of retainedCommandIds) {
          handledRemoteCommandIds.add(commandId);
        }
      }

      switch (command.kind) {
        case "cancel": {
          if (command.taskId) {
            await cancelDesktopTask(command.taskId);
          }
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
            if (!options.onQueueSessionFollowUp(sourceSession.id, prompt)) {
              throw new Error("The remote follow-up could not be queued.");
            }
            break;
          }

          const accepted = options.submitTaskToSession({
            sessionSnapshot: sourceSession,
            task: prompt,
            contextAttachments: [],
            clearDraft: false,
            activateSession: true,
            visibleMessageContent: prompt,
            promptHistoryContent: prompt,
          });
          if (accepted === false) {
            throw new Error("The remote follow-up could not be submitted.");
          }
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
          if (!command.sessionId || !command.contextPackId) {
            throw new NonRetryableRemoteCommandError(
              "The context-pack command is missing its session or pack id.",
            );
          }

          if (
            !options.onApplyContextPack(
              command.sessionId,
              command.contextPackId,
            )
          ) {
            throw new NonRetryableRemoteCommandError(
              `Context pack \`${command.contextPackId}\` is no longer available for session \`${command.sessionId}\`.`,
            );
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
            await runRemoteSchedulerAction(() =>
              triggerSchedulerJob(
                command.workspace ?? options.activeSession.workspace,
                command.jobId!,
                command.commandId,
              ),
            );
          }
          break;
        }

        case "scheduler-pause": {
          if (command.jobId) {
            await runRemoteSchedulerAction(() =>
              pauseSchedulerJob(
                command.workspace ?? options.activeSession.workspace,
                command.jobId!,
                command.commandId,
              ),
            );
          }
          break;
        }

        case "scheduler-resume": {
          if (command.jobId) {
            await runRemoteSchedulerAction(() =>
              resumeSchedulerJob(
                command.workspace ?? options.activeSession.workspace,
                command.jobId!,
                command.commandId,
              ),
            );
          }
          break;
        }

        case "scheduler-delete": {
          if (command.jobId) {
            await runRemoteSchedulerAction(() =>
              deleteSchedulerJob(
                command.workspace ?? options.activeSession.workspace,
                command.jobId!,
                command.commandId,
              ),
            );
          }
          break;
        }

        case "scheduler-retry-run": {
          if (command.runId) {
            await runRemoteSchedulerAction(() =>
              retrySchedulerRun(
                command.workspace ?? options.activeSession.workspace,
                command.runId!,
                command.commandId,
              ),
            );
          }
          break;
        }

        case "scheduler-cancel-run": {
          if (command.runId) {
            await runRemoteSchedulerAction(() =>
              cancelSchedulerRun(
                command.workspace ?? options.activeSession.workspace,
                command.runId!,
                command.commandId,
              ),
            );
          }
          break;
        }
      }

      options.onMarkRemoteCommandHandled(command.commandId);
    },
    [getSessionForCommand, options, runRemoteSchedulerAction],
  );
  handleCommandRef.current = handleCommand;

  const enable = useCallback(async (): Promise<void> => {
    const requestSequence = statusMutationSequenceRef.current + 1;
    statusMutationSequenceRef.current = requestSequence;
    statusPollSequenceRef.current += 1;
    statusMutationInFlightRef.current = true;
    setLoading(true);
    setMessage(null);

    try {
      const nextStatus = await enableRemoteControlServer();
      if (requestSequence === statusMutationSequenceRef.current) {
        setStatus(nextStatus);
      }
    } catch (error) {
      if (requestSequence === statusMutationSequenceRef.current) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (requestSequence === statusMutationSequenceRef.current) {
        statusMutationInFlightRef.current = false;
        setLoading(false);
      }
    }
  }, []);

  const disable = useCallback(async (): Promise<void> => {
    const requestSequence = statusMutationSequenceRef.current + 1;
    statusMutationSequenceRef.current = requestSequence;
    statusPollSequenceRef.current += 1;
    statusMutationInFlightRef.current = true;
    setLoading(true);
    setMessage(null);

    try {
      const nextStatus = await disableRemoteControlServer();
      if (requestSequence === statusMutationSequenceRef.current) {
        setStatus(nextStatus);
      }
    } catch (error) {
      if (requestSequence === statusMutationSequenceRef.current) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (requestSequence === statusMutationSequenceRef.current) {
        statusMutationInFlightRef.current = false;
        setLoading(false);
      }
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
    const requestSequence = statusMutationSequenceRef.current + 1;
    statusMutationSequenceRef.current = requestSequence;
    statusPollSequenceRef.current += 1;
    statusMutationInFlightRef.current = true;
    setLoading(true);
    setMessage(null);

    try {
      const nextStatus = await setRemoteControlPort(port);
      if (requestSequence === statusMutationSequenceRef.current) {
        setStatus(nextStatus);
        setMessage("Mission Control port saved.");
      }
    } catch (error) {
      if (requestSequence === statusMutationSequenceRef.current) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (requestSequence === statusMutationSequenceRef.current) {
        statusMutationInFlightRef.current = false;
        setLoading(false);
      }
    }
  }, []);

  const forgetPairings = useCallback(async (): Promise<void> => {
    const requestSequence = statusMutationSequenceRef.current + 1;
    statusMutationSequenceRef.current = requestSequence;
    statusPollSequenceRef.current += 1;
    statusMutationInFlightRef.current = true;
    setLoading(true);
    setMessage(null);

    try {
      const nextStatus = await forgetRemoteControlPairings();
      if (requestSequence === statusMutationSequenceRef.current) {
        setStatus(nextStatus);
        setMessage("Mission Control pairings revoked.");
      }
    } catch (error) {
      if (requestSequence === statusMutationSequenceRef.current) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (requestSequence === statusMutationSequenceRef.current) {
        statusMutationInFlightRef.current = false;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!isPrimaryController) {
      return;
    }

    void refreshStatus();
  }, [isPrimaryController, refreshStatus]);

  useEffect(() => {
    if (!isPrimaryController || !status?.enabled) {
      return;
    }

    const refreshInterval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refreshStatus();
      }
    }, STATUS_REFRESH_MS);

    return () => {
      window.clearInterval(refreshInterval);
    };
  }, [isPrimaryController, refreshStatus, status?.enabled]);

  useEffect(() => {
    if (!isPrimaryController || !status?.enabled) {
      return;
    }

    void refreshScheduler();
    const refreshInterval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refreshScheduler();
      }
    }, SCHEDULER_REFRESH_MS);

    return () => {
      window.clearInterval(refreshInterval);
    };
  }, [isPrimaryController, refreshScheduler, status?.enabled]);

  useEffect(() => {
    if (!isPrimaryController || !options.hasHydrated || !status?.enabled) {
      return;
    }

    const publishTimer = window.setTimeout(() => {
      const snapshot = createShellSnapshot();
      snapshot.capturedAt = Math.max(
        snapshot.capturedAt,
        lastSnapshotCapturedAtRef.current + 1,
      );
      lastSnapshotCapturedAtRef.current = snapshot.capturedAt;
      const serializedSnapshot = JSON.stringify({
        ...snapshot,
        capturedAt: 0,
      });

      if (serializedSnapshot === lastPublishedSnapshotRef.current) {
        return;
      }

      const attemptSequence = snapshotPublishAttemptSequenceRef.current + 1;
      snapshotPublishAttemptSequenceRef.current = attemptSequence;
      void updateRemoteControlShellSnapshot(snapshot)
        .then(() => {
          if (
            !remoteHookMountedRef.current ||
            attemptSequence !== snapshotPublishAttemptSequenceRef.current
          ) {
            return;
          }
          lastPublishedSnapshotRef.current = serializedSnapshot;
          snapshotPublishRetryAttemptRef.current = 0;
          if (snapshotPublishRetryTimerRef.current !== null) {
            window.clearTimeout(snapshotPublishRetryTimerRef.current);
            snapshotPublishRetryTimerRef.current = null;
          }
        })
        .catch((error) => {
          if (
            !remoteHookMountedRef.current ||
            attemptSequence !== snapshotPublishAttemptSequenceRef.current
          ) {
            return;
          }
          setMessage(error instanceof Error ? error.message : String(error));
          snapshotPublishRetryAttemptRef.current += 1;
          if (snapshotPublishRetryTimerRef.current === null) {
            const retryDelay = Math.min(
              10_000,
              500 * 2 ** Math.min(snapshotPublishRetryAttemptRef.current - 1, 5),
            );
            snapshotPublishRetryTimerRef.current = window.setTimeout(() => {
              snapshotPublishRetryTimerRef.current = null;
              setSnapshotPublishRetrySequence((sequence) => sequence + 1);
            }, retryDelay);
          }
        });
    }, SNAPSHOT_PUBLISH_DELAY_MS);

    return () => {
      window.clearTimeout(publishTimer);
    };
  }, [
    createShellSnapshot,
    isPrimaryController,
    options.hasHydrated,
    snapshotPublishRetrySequence,
    status?.enabled,
  ]);

  useEffect(() => {
    remoteHookMountedRef.current = true;

    return () => {
      remoteHookMountedRef.current = false;
      snapshotPublishAttemptSequenceRef.current += 1;
      if (snapshotPublishRetryTimerRef.current !== null) {
        window.clearTimeout(snapshotPublishRetryTimerRef.current);
        snapshotPublishRetryTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!isPrimaryController || !options.hasHydrated) {
      return;
    }

    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    let initialized = !canUseTauriStore();
    let draining = false;
    let retryTimer: number | null = null;
    const bufferedCommands: RemoteControlCommandEvent[] = [];
    const commandQueue: RemoteControlCommandEvent[] = [];
    const queuedCommandIds = new Set<string>();
    let loadPendingCommandsRef: (() => Promise<void>) | null = null;

    const executeCommand = async (
      command: RemoteControlCommandEvent,
    ): Promise<void> => {
      const lease = await beginCrossWindowOperation(
        `remote-command:${command.commandId}`,
        12 * 60 * 60 * 1_000,
      );

      if (!lease) {
        return;
      }

      if (disposed) {
        await releaseCrossWindowOperation(lease);
        return;
      }

      try {
        await handleCommandRef.current(command);
        await options.flushPersistence();
        if (canUseTauriStore()) {
          await invoke<boolean>(
            "acknowledge_remote_control_command",
            { commandId: command.commandId },
          );
        }
        await completeCrossWindowOperation(lease);
      } catch (error) {
        handledRemoteCommandIds.delete(command.commandId);

        if (error instanceof NonRetryableRemoteCommandError) {
          try {
            if (canUseTauriStore()) {
              await invoke<boolean>(
                "acknowledge_remote_control_command",
                { commandId: command.commandId },
              );
            }
            setMessage(error.message);
            await completeCrossWindowOperation(lease);
            return;
          } catch (acknowledgementError) {
            await releaseCrossWindowOperation(lease);
            throw acknowledgementError;
          }
        }

        await releaseCrossWindowOperation(lease);
        throw error;
      }
    };

    const drainCommands = async (): Promise<void> => {
      if (disposed || draining) {
        return;
      }

      draining = true;

      try {
        while (!disposed && commandQueue.length > 0) {
          const command = commandQueue[0];

          if (!command) {
            break;
          }

          try {
            await executeCommand(command);
            commandQueue.shift();
            queuedCommandIds.delete(command.commandId);
          } catch (error) {
            console.error("Failed to process remote-control command", error);
            if (retryTimer === null) {
              retryTimer = window.setTimeout(() => {
                retryTimer = null;
                void drainCommands();
              }, PENDING_COMMAND_POLL_MS);
            }
            return;
          }
        }
      } finally {
        draining = false;
      }
    };

    const enqueueCommands = (
      commands: readonly RemoteControlCommandEvent[],
    ): void => {
      let added = false;

      for (const command of commands) {
        if (queuedCommandIds.has(command.commandId)) {
          continue;
        }

        queuedCommandIds.add(command.commandId);
        commandQueue.push(command);
        added = true;
      }

      if (added && retryTimer === null) {
        void drainCommands();
      }
    };

    const receiveCommand = (command: RemoteControlCommandEvent): void => {
      if (canUseTauriStore()) {
        void loadPendingCommandsRef?.().catch((error) => {
          console.error("Failed to load pending remote-control commands", error);
        });
        return;
      }

      if (!initialized) {
        bufferedCommands.push(command);
        return;
      }

      enqueueCommands([command]);
    };

    const loadPendingCommands = async (): Promise<void> => {
      if (!canUseTauriStore()) {
        return;
      }

      const commands = await invoke<RemoteControlCommandEvent[]>(
        "get_pending_remote_control_commands",
      );

      if (disposed) {
        return;
      }

      if (!initialized) {
        const pendingIds = new Set(commands.map((command) => command.commandId));
        const combinedCommands = [
          ...commands,
          ...bufferedCommands.filter(
            (command) => !pendingIds.has(command.commandId),
          ),
        ];
        bufferedCommands.length = 0;
        initialized = true;
        enqueueCommands(combinedCommands);
      } else {
        enqueueCommands(commands);
      }
    };
    loadPendingCommandsRef = loadPendingCommands;

    void subscribeToRemoteControlCommands(receiveCommand).then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }

      unsubscribe = unlisten;
    });
    void loadPendingCommands().catch((error) => {
      console.error("Failed to load pending remote-control commands", error);
    });
    const pendingPoll = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void loadPendingCommands().catch((error) => {
          console.error("Failed to refresh pending remote-control commands", error);
        });
      }
    }, PENDING_COMMAND_POLL_MS);

    return () => {
      disposed = true;
      unsubscribe?.();
      window.clearInterval(pendingPoll);
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [isPrimaryController, options.flushPersistence, options.hasHydrated]);

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
