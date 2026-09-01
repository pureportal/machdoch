import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { productSnapshotVersion } from "@machdoch/fleet-protocol";
import {
  isMediaAssetContextAttachment,
  isTransientChatOperationMessage,
  type ChatSessionMessage,
  type ChatSessionContextAttachment,
  type ChatSessionRecord,
  type SmartContextPack,
  type ShellPersistedState,
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
  acknowledgeFleetControlCommand,
  cancelDesktopTask,
  cancelSchedulerRun,
  deleteSchedulerJob,
  getFleetConnectionStatus,
  getPendingFleetControlCommands,
  loadActiveDesktopTasks,
  loadProviderModelCatalog,
  listSchedulerJobs,
  listSchedulerRuns,
  pauseSchedulerJob,
  REASONING_MODE_ORDER,
  resumeSchedulerJob,
  retrySchedulerRun,
  subscribeToFleetControlCommands,
  triggerSchedulerJob,
  updateFleetControlShellSnapshot,
  type FleetControlCommandEvent,
  type FleetControlShellSnapshot,
  type FleetShellAttachmentSnapshot,
  type FleetShellContextPackSnapshot,
  type FleetShellMessageSnapshot,
  type FleetShellMessageSourceSnapshot,
  type FleetShellMediaSnapshot,
  type FleetShellProviderStatusSnapshot,
  type FleetShellRuntimeCapabilitySnapshot,
  type FleetShellRalphSnapshot,
  type FleetShellSchedulerJobSnapshot,
  type FleetShellSchedulerRunSnapshot,
  type FleetShellSchedulerSnapshot,
  type RuntimeSnapshot,
  type SchedulerJobSummary,
  type SchedulerRunSummary,
  type InstructionRegistryResult,
} from "../../runtime";
import {
  executeFleetMediaCommand,
  loadFleetMediaSnapshot,
  unavailableFleetMediaSnapshot,
} from "../../media/fleet-media";
import {
  executeFleetRalphCommand,
  loadFleetRalphSnapshot,
  resolveFleetRalphCommandRuntime,
  type FleetRalphCommandRuntime,
} from "../../ralph/fleet-ralph";
import {
  getCatalogModelsForProvider,
  getModelLabelForProvider,
  getProviderLabel,
  type ProviderModelCatalogSnapshot,
  type RuntimeProvider,
} from "../../model-catalog";
import { getReasoningModesForProvider } from "../../reasoning-options";
import {
  beginCrossWindowOperation,
  completeCrossWindowOperation,
  releaseCrossWindowOperation,
} from "../../lib/cross-window-operation";
import { getRenderedMessageContent } from "./execution-message";
import {
  canUseTauriStore,
  getCurrentShellWindowLabel,
} from "../../lib/_helpers/shell-store-storage.helper";

interface FleetSchedulerState {
  snapshot: FleetShellSchedulerSnapshot | null;
  loading: boolean;
  error: string | null;
}

interface FleetRalphState {
  snapshot: FleetShellRalphSnapshot | null;
  loading: boolean;
  error: string | null;
}

const STATUS_REFRESH_MS = 15_000;
const SCHEDULER_REFRESH_MS = 60_000;
const RALPH_REFRESH_MS = 5_000;
const MEDIA_REFRESH_MS = 3_000;
const SNAPSHOT_PUBLISH_DELAY_MS = 250;
const PENDING_COMMAND_POLL_MS = 15_000;
const RALPH_LAUNCH_CONFIRMATION_MS = 2_000;
const RALPH_LAUNCH_POLL_MS = 75;

class NonRetryableFleetCommandError extends Error {}
const IDEMPOTENT_FLEET_COMMAND_KINDS = new Set<
  FleetControlCommandEvent["kind"]
>([
  "scheduler-trigger",
  "scheduler-pause",
  "scheduler-resume",
  "scheduler-delete",
  "scheduler-retry-run",
  "scheduler-cancel-run",
  "ralph-run",
  "ralph-resume-run",
  "generate-media",
  "cancel-media-run",
]);
const MAX_IDEMPOTENT_FLEET_COMMAND_ATTEMPTS = 3;
const MAIN_WINDOW_LABEL = "main";
const FLEET_MESSAGE_LIMIT = 80;
const FLEET_SESSION_LIMIT = 80;
const FLEET_PROMPT_HISTORY_LIMIT = 30;
const handledFleetCommandIds = new Set<string>();

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
): FleetShellAttachmentSnapshot =>
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
): FleetShellMessageSourceSnapshot | undefined => {
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
        ? thinking.timelineEvents.slice(-24).map((entry) => ({
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
      entries: source.thinking.timelineEvents.slice(-24).map((entry) => ({
        label: entry.label,
        detail: entry.detail,
        tone: entry.tone,
        timestamp: entry.timestamp,
      })),
      timeline: source.thinking.timelineEvents.slice(-40).map((entry) => ({
        label: entry.label,
        detail: entry.detail,
        tone: entry.tone,
        timestamp: entry.timestamp,
      })),
    };
  }

  if (source.kind === "interrupted-task") {
    return {
      kind: "interrupted-task",
      status: source.status,
      summary: message.content,
      entries: [],
      timeline: [],
    };
  }

  return undefined;
};

const canRetryOrContinueMessage = (message: ChatSessionMessage): boolean => {
  return (
    message.role === "agent" &&
    (message.source?.kind === "execution" ||
      (message.source?.kind === "interrupted-task" &&
        message.source.status === "crashed"))
  );
};

const createMessageSnapshot = (
  message: ChatSessionMessage,
  speakingMessageId: string | null,
  voiceSupported: boolean,
): FleetShellMessageSnapshot => {
  const source = createMessageSourceSnapshot(message);
  const promptEnhancement =
    isTransientChatOperationMessage(message) &&
    message.lifecycle?.owner === "prompt-enhancement";

  return {
    id: message.id,
    role: message.role,
    content: getRenderedMessageContent(message) || message.content,
    ...(typeof message.createdAt === "number"
      ? { createdAt: message.createdAt }
      : {}),
    ...(message.taskId ? { taskId: message.taskId } : {}),
    ...(message.taskAction ? { taskAction: { ...message.taskAction } } : {}),
    presentation: promptEnhancement ? "prompt-enhancement" : "message",
    attachments: (message.contextAttachments ?? []).map(
      createAttachmentSnapshot,
    ),
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
  for (const [
    taskId,
    activeSessionId,
  ] of activeDesktopTasksRef.current.entries()) {
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
    ...(typeof session.archivedAt === "number"
      ? { archivedAt: session.archivedAt }
      : {}),
    ...(typeof session.pinnedAt === "number"
      ? { pinnedAt: session.pinnedAt }
      : {}),
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

const formatSchedulerSchedule = (job: SchedulerJobSummary): string => {
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
): FleetShellSchedulerJobSnapshot => ({
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
): FleetShellSchedulerRunSnapshot => ({
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
): FleetShellContextPackSnapshot => {
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
    ...(pack.promptEnhancementMode !== undefined
      ? { promptEnhancementMode: pack.promptEnhancementMode }
      : {}),
    ...(pack.interviewEnabled !== undefined
      ? { interviewEnabled: pack.interviewEnabled }
      : {}),
    ...(pack.sessionMemoryEnabled !== undefined
      ? { sessionMemoryEnabled: pack.sessionMemoryEnabled }
      : {}),
    ...(pack.useGlobalMemory !== undefined
      ? { useGlobalMemory: pack.useGlobalMemory }
      : {}),
    ...(pack.uiControlEnabled !== undefined
      ? { uiControlEnabled: pack.uiControlEnabled }
      : {}),
  };
};

const createRuntimeCapabilitySnapshot = (
  available: boolean,
  reason?: string,
): FleetShellRuntimeCapabilitySnapshot => ({
  available,
  ...(reason ? { reason } : {}),
});

const createProviderStatusSnapshots = (
  runtimeSnapshot: RuntimeSnapshot | null,
): FleetShellProviderStatusSnapshot[] => {
  return (runtimeSnapshot?.providerAvailability ?? []).map((entry) => ({
    provider: entry.provider,
    available: entry.configured,
    ...(!entry.configured ? { reason: "API key is not configured." } : {}),
  }));
};

const getWorkspaceLabel = (workspace: string): string => {
  const segments = workspace.split(/[\\/]+/u).filter(Boolean);
  return segments.at(-1) ?? workspace;
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

export const useFleetControl = (options: {
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
  recentWorkspaces: string[];
  promptEnhancementMode: "off" | "simple" | "web-search";
  interviewEnabled: boolean;
  interviewAvailable: boolean;
  instructionRegistry: InstructionRegistryResult | null;
  instructionRegistryLoading: boolean;
  instructionRegistryError: string | null;
  onRefreshInstructions: () => Promise<void>;
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
  onMarkFleetCommandHandled: (commandId: string) => void;
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
  onSetSessionWorkspace: (sessionId: string, workspace: string | null) => void;
  onSetPromptEnhancementMode: (mode: "off" | "simple" | "web-search") => void;
  onSetInterview: (enabled: boolean) => void;
  onCancelPromptEnhancement: (taskId: string) => void;
  onSubmitSessionMessage: (input: {
    sessionId: string;
    prompt: string;
    promptEnhancementMode: "off" | "simple" | "web-search";
    interviewEnabled: boolean;
  }) => boolean;
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
}): void => {
  const currentWindowLabel = getCurrentShellWindowLabel();
  const isPrimaryController = canUseTauriStore()
    ? currentWindowLabel === MAIN_WINDOW_LABEL
    : true;
  const [fleetEnabled, setFleetEnabled] = useState(false);
  const [snapshotPublishRetrySequence, setSnapshotPublishRetrySequence] =
    useState(0);
  const [schedulerState, setSchedulerState] = useState<FleetSchedulerState>({
    snapshot: null,
    loading: false,
    error: null,
  });
  const [ralphState, setRalphState] = useState<FleetRalphState>({
    snapshot: null,
    loading: false,
    error: null,
  });
  const [mediaSnapshot, setMediaSnapshot] =
    useState<FleetShellMediaSnapshot | null>(null);
  const [providerModelCatalog, setProviderModelCatalog] =
    useState<ProviderModelCatalogSnapshot | null>(null);
  const [modelCatalogLoading, setModelCatalogLoading] = useState(false);
  const handleCommandRef = useRef<
    (command: FleetControlCommandEvent) => Promise<void>
  >(async () => undefined);
  const lastPublishedSnapshotRef = useRef<string>("");
  const schedulerRefreshSequenceRef = useRef(0);
  const ralphRefreshSequenceRef = useRef(0);
  const mediaRefreshSequenceRef = useRef(0);
  const schedulerWorkspaceRef = useRef(options.activeSession.workspace);
  const ralphWorkspaceRef = useRef(options.activeSession.workspace);
  const lastSnapshotCapturedAtRef = useRef(0);
  const snapshotPublishRetryAttemptRef = useRef(0);
  const snapshotPublishRetryTimerRef = useRef<number | null>(null);
  const snapshotPublishAttemptSequenceRef = useRef(0);
  const fleetControlMountedRef = useRef(true);
  schedulerWorkspaceRef.current = options.activeSession.workspace;
  ralphWorkspaceRef.current = options.activeSession.workspace;
  const fleetPublishingEnabled = fleetEnabled;
  const configuredMediaProviderKey = (
    options.runtimeSnapshot?.providerAvailability ?? []
  )
    .filter((entry) => entry.configured)
    .map((entry) => entry.provider)
    .join(",");
  const configuredMediaProviderIds = useMemo(
    () =>
      configuredMediaProviderKey ? configuredMediaProviderKey.split(",") : [],
    [configuredMediaProviderKey],
  );

  useEffect(() => {
    if (!options.hasHydrated || !fleetPublishingEnabled) {
      return;
    }
    void options.onRefreshInstructions();
  }, [
    options.activeSession.workspace,
    options.hasHydrated,
    options.onRefreshInstructions,
    fleetPublishingEnabled,
  ]);

  useEffect(() => {
    if (!options.hasHydrated || !fleetPublishingEnabled) return;

    let cancelled = false;
    setModelCatalogLoading(true);
    void loadProviderModelCatalog()
      .then((catalog) => {
        if (!cancelled) setProviderModelCatalog(catalog);
      })
      .finally(() => {
        if (!cancelled) setModelCatalogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [options.hasHydrated, fleetPublishingEnabled]);

  const getSessionForCommand = useCallback(
    (
      command: Pick<FleetControlCommandEvent, "taskId" | "sessionId">,
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
    [
      options.activeDesktopTasksRef,
      options.activeSession,
      options.shellState.sessions,
    ],
  );

  const refreshFleetStatus = useCallback(async (): Promise<void> => {
    try {
      const nextStatus = await getFleetConnectionStatus();
      setFleetEnabled(nextStatus.enabled);
    } catch {
      setFleetEnabled(false);
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
      const errorMessage =
        error instanceof Error ? error.message : String(error);
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

  const refreshMedia = useCallback(async (): Promise<void> => {
    const refreshSequence = mediaRefreshSequenceRef.current + 1;
    mediaRefreshSequenceRef.current = refreshSequence;
    try {
      const nextSnapshot = await loadFleetMediaSnapshot(
        configuredMediaProviderIds,
      );
      if (
        refreshSequence === mediaRefreshSequenceRef.current &&
        fleetControlMountedRef.current
      ) {
        setMediaSnapshot(nextSnapshot);
      }
    } catch (error) {
      if (
        refreshSequence === mediaRefreshSequenceRef.current &&
        fleetControlMountedRef.current
      ) {
        setMediaSnapshot((current) =>
          unavailableFleetMediaSnapshot(error, current),
        );
      }
    }
  }, [configuredMediaProviderIds]);

  const refreshRalph = useCallback(async (): Promise<void> => {
    const workspaceRoot = options.activeSession.workspace;
    const refreshSequence = ralphRefreshSequenceRef.current + 1;
    ralphRefreshSequenceRef.current = refreshSequence;

    if (!workspaceRoot) {
      setRalphState({
        snapshot: {
          loading: false,
          flows: [],
          runs: [],
          updatedAt: Date.now(),
        },
        loading: false,
        error: null,
      });
      return;
    }

    setRalphState((current) => ({
      ...current,
      loading: true,
      error: null,
    }));

    try {
      const snapshot = await loadFleetRalphSnapshot(workspaceRoot);
      if (
        refreshSequence !== ralphRefreshSequenceRef.current ||
        ralphWorkspaceRef.current !== workspaceRoot
      ) {
        return;
      }
      setRalphState({ snapshot, loading: false, error: null });
    } catch (error) {
      if (
        refreshSequence !== ralphRefreshSequenceRef.current ||
        ralphWorkspaceRef.current !== workspaceRoot
      ) {
        return;
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      setRalphState((current) => ({
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
                flows: [],
                runs: [],
                updatedAt: Date.now(),
              },
        loading: false,
        error: errorMessage,
      }));
    }
  }, [options.activeSession.workspace]);

  const createShellSnapshot = useCallback((): FleetControlShellSnapshot => {
    const schedulerSnapshot = schedulerState.snapshot
      ? {
          ...schedulerState.snapshot,
          loading: schedulerState.loading || schedulerState.snapshot.loading,
          ...(schedulerState.error ? { error: schedulerState.error } : {}),
        }
      : undefined;
    const ralphSnapshot = ralphState.snapshot
      ? {
          ...ralphState.snapshot,
          loading: ralphState.loading || ralphState.snapshot.loading,
          ...(ralphState.error ? { error: ralphState.error } : {}),
        }
      : undefined;
    const uiControl = options.runtimeSnapshot?.uiControl;
    const webSearchAvailability =
      options.runtimeSnapshot?.webSearch.providerAvailability ?? [];
    const webSearchConfigured = webSearchAvailability.some(
      (entry) => entry.configured,
    );
    const modelCatalog = options.chooserProviders.map((provider) => {
      const runtimeProvider = providerModelCatalog?.providers.find(
        (entry) => entry.provider === provider,
      );
      return {
        provider,
        label: getProviderLabel(provider),
        available: runtimeProvider?.available === true,
        ...(runtimeProvider?.error ? { error: runtimeProvider.error } : {}),
        models: getCatalogModelsForProvider(provider, providerModelCatalog).map(
          (model) => ({
            id: model.id,
            label: model.label,
            reasoningOptions: [
              ...getReasoningModesForProvider(
                provider,
                model.id,
                model.capabilities,
              ),
            ],
          }),
        ),
      };
    });

    return {
      version: productSnapshotVersion,
      capturedAt: Date.now(),
      activeSessionId: options.activeSession.id,
      sessions: options.shellState.sessions
        .slice(0, FLEET_SESSION_LIMIT)
        .map((session) =>
          createSessionSnapshot(
            session,
            options.activeDesktopTasksRef,
            options.defaultMode,
            options.defaultReasoning,
          ),
        ),
      workspaces: options.recentWorkspaces.slice(0, 40).map((root) => ({
        root,
        label: getWorkspaceLabel(root),
        sessionCount: options.shellState.sessions.filter(
          (session) => session.workspace === root,
        ).length,
      })),
      visibleMessages: options.visibleMessages
        .slice(-FLEET_MESSAGE_LIMIT)
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
        providerLabel: getProviderLabel(options.activeSession.provider),
        model: options.activeSession.model,
        modelLabel: getModelLabelForProvider(
          options.activeSession.provider,
          options.activeSession.model,
          providerModelCatalog,
        ),
        modelCatalogLoading,
        modelCatalog,
        mode: options.activeRunMode,
        defaultMode: options.defaultMode,
        reasoning: options.activeReasoning,
        defaultReasoning: options.defaultReasoning,
        reasoningOptions: [
          ...getReasoningModesForProvider(
            options.activeSession.provider,
            options.activeSession.model,
          ),
        ],
        promptEnhancementMode: options.promptEnhancementMode,
        interviewEnabled: options.interviewEnabled,
        interviewAvailable: options.interviewAvailable,
        ...(options.activeSession.workspace
          ? { workspace: options.activeSession.workspace }
          : {}),
        workspaceLabel: options.composerWorkspaceLabel,
        canSend: options.canSendMessage,
        ...(options.sendDisabledReason
          ? { sendDisabledReason: options.sendDisabledReason }
          : {}),
        isExecuting:
          getSessionOverviewStatus(options.activeSession) === "running",
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
        providerStatuses: createProviderStatusSnapshots(
          options.runtimeSnapshot,
        ),
        ...(options.runtimeSnapshot?.mode
          ? { mode: options.runtimeSnapshot.mode }
          : {}),
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
          webSearchConfigured
            ? undefined
            : "No web search provider is configured.",
        ),
      },
      ...(schedulerSnapshot ? { scheduler: schedulerSnapshot } : {}),
      ...(ralphSnapshot ? { ralph: ralphSnapshot } : {}),
      ...(mediaSnapshot ? { media: mediaSnapshot } : {}),
      contextPacks: options.workspaceContextPacks.map((pack) =>
        createContextPackSnapshot(pack, options.matchedContextPackIds),
      ),
      instructions: {
        loading: options.instructionRegistryLoading,
        ...(options.instructionRegistry
          ? { revision: options.instructionRegistry.revision }
          : {}),
        ...(options.instructionRegistryError
          ? { error: options.instructionRegistryError }
          : {}),
        profiles: (options.instructionRegistry?.profiles ?? []).map(
          (profile) => ({
            id: profile.id,
            name: profile.name,
            ...(profile.description
              ? { description: profile.description }
              : {}),
            ...(profile.body ? { body: profile.body } : {}),
            enabled: profile.enabled,
            global: profile.global,
            tags: profile.tags,
          }),
        ),
      },
      promptHistory: options.activeSession.promptHistory.slice(
        -FLEET_PROMPT_HISTORY_LIMIT,
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
    options.instructionRegistry,
    options.instructionRegistryError,
    options.instructionRegistryLoading,
    options.interviewAvailable,
    options.interviewEnabled,
    options.isGlobalMemoryActive,
    options.isGlobalMemoryAvailable,
    options.isUiControlAvailable,
    options.matchedContextPackIds,
    options.promptEnhancementMode,
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
    options.recentWorkspaces,
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
    modelCatalogLoading,
    providerModelCatalog,
    ralphState,
    mediaSnapshot,
    schedulerState,
  ]);

  const runFleetSchedulerAction = useCallback(
    async (action: () => Promise<unknown>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        if (fleetControlMountedRef.current) {
          console.error("Fleet Manager action failed", error);
        }
        throw error;
      }

      try {
        await refreshScheduler();
      } catch (error) {
        if (fleetControlMountedRef.current) {
          console.error(
            "Failed to refresh Fleet Manager scheduler state",
            error,
          );
        }
      }
    },
    [refreshScheduler],
  );

  const startFleetRalphAction = useCallback(
    async (
      command: FleetControlCommandEvent,
      runtime: FleetRalphCommandRuntime,
    ): Promise<void> => {
      const isCurrentWorkspace = (): boolean =>
        ralphWorkspaceRef.current === runtime.workspace;
      if (isCurrentWorkspace()) {
        setRalphState((current) => ({
          ...current,
          loading: true,
          error: null,
        }));
      }

      const completion = executeFleetRalphCommand(command, runtime).then(
        () => ({ status: "completed" as const }),
        (error: unknown) => ({ status: "failed" as const, error }),
      );
      void completion.then((outcome) => {
        if (outcome.status === "completed") {
          if (isCurrentWorkspace()) void refreshRalph();
          return;
        }

        const error = outcome.error;
        if (fleetControlMountedRef.current && isCurrentWorkspace()) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          setRalphState((current) => ({
            ...current,
            loading: false,
            error: errorMessage,
            snapshot: current.snapshot
              ? {
                  ...current.snapshot,
                  loading: false,
                  error: errorMessage,
                  updatedAt: Date.now(),
                }
              : current.snapshot,
          }));
        }
      });

      let launchPending = true;
      const launchConfirmation = (async (): Promise<"active" | "unknown"> => {
        const deadline = Date.now() + RALPH_LAUNCH_CONFIRMATION_MS;
        while (launchPending && Date.now() < deadline) {
          const tasks = await loadActiveDesktopTasks().catch(() => undefined);
          if (tasks?.some((task) => task.id === runtime.taskId)) {
            return "active";
          }
          await new Promise((resolve) =>
            window.setTimeout(resolve, RALPH_LAUNCH_POLL_MS),
          );
        }
        return "unknown";
      })();
      let launchTimeoutId: number | undefined;
      const launchTimeout = new Promise<"unknown">((resolve) => {
        launchTimeoutId = window.setTimeout(
          () => resolve("unknown"),
          RALPH_LAUNCH_CONFIRMATION_MS,
        );
      });
      const launchOutcome = await Promise.race([
        completion,
        launchConfirmation,
        launchTimeout,
      ]);
      launchPending = false;
      if (launchTimeoutId !== undefined) window.clearTimeout(launchTimeoutId);
      if (
        typeof launchOutcome === "object" &&
        launchOutcome.status === "failed"
      ) {
        throw launchOutcome.error;
      }

      window.setTimeout(() => {
        if (isCurrentWorkspace()) void refreshRalph();
      }, 250);
    },
    [refreshRalph],
  );

  const handleCommand = useCallback(
    async (command: FleetControlCommandEvent): Promise<void> => {
      if (
        handledFleetCommandIds.has(command.commandId) ||
        options.shellState.handledFleetCommandIds.includes(command.commandId)
      ) {
        handledFleetCommandIds.add(command.commandId);
        return;
      }

      const sourceSession =
        command.kind === "cancel"
          ? options.activeSession
          : getSessionForCommand(command);

      if (!sourceSession) {
        const targetId = command.sessionId ?? command.taskId ?? "unknown";
        throw new NonRetryableFleetCommandError(
          `Fleet Manager target \`${targetId}\` is no longer available.`,
        );
      }

      handledFleetCommandIds.add(command.commandId);

      if (handledFleetCommandIds.size > 500) {
        const retainedCommandIds = [...handledFleetCommandIds].slice(-250);
        handledFleetCommandIds.clear();

        for (const commandId of retainedCommandIds) {
          handledFleetCommandIds.add(commandId);
        }
      }

      switch (command.kind) {
        case "cancel": {
          if (command.taskId) {
            await cancelDesktopTask(command.taskId);
            void refreshRalph();
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
                (entry.source?.kind === "interrupted-task" &&
                  entry.source.status === "crashed")),
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
                (entry.source?.kind === "interrupted-task" &&
                  entry.source.status === "crashed")),
          );

          if (message) {
            options.onContinueTask(message);
          }
          break;
        }

        case "submit-message": {
          const prompt = command.prompt?.trim();
          const promptEnhancementMode = command.promptEnhancementMode;
          if (
            !prompt ||
            !promptEnhancementMode ||
            !["off", "simple", "web-search"].includes(promptEnhancementMode)
          ) {
            throw new NonRetryableFleetCommandError(
              "The Fleet message options are invalid.",
            );
          }
          if (
            !options.onSubmitSessionMessage({
              sessionId: sourceSession.id,
              prompt,
              promptEnhancementMode: promptEnhancementMode as
                | "off"
                | "simple"
                | "web-search",
              interviewEnabled: command.enabled === true,
            })
          ) {
            throw new Error("The Fleet message could not be submitted.");
          }
          break;
        }

        case "cancel-prompt-enhancement": {
          if (command.taskId) {
            options.onCancelPromptEnhancement(command.taskId);
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
            options.onUpdateSessionDraft(
              command.sessionId,
              command.prompt ?? "",
            );
          }
          break;
        }

        case "set-session-model": {
          const provider = command.provider;
          const runtimeProvider =
            provider &&
            options.chooserProviders.includes(provider as RuntimeProvider)
              ? (provider as RuntimeProvider)
              : null;
          const providerCatalog = providerModelCatalog?.providers.find(
            (entry) => entry.provider === runtimeProvider,
          );
          const modelAvailable = runtimeProvider
            ? getCatalogModelsForProvider(
                runtimeProvider,
                providerModelCatalog,
              ).some((model) => model.id === command.model)
            : false;

          if (
            command.sessionId &&
            runtimeProvider &&
            command.model &&
            providerCatalog?.available &&
            modelAvailable
          ) {
            options.onSetSessionModel(
              command.sessionId,
              runtimeProvider,
              command.model,
            );
          } else {
            throw new NonRetryableFleetCommandError(
              "The selected provider or model is unavailable.",
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

        case "clear-session-mode": {
          if (command.sessionId) {
            options.onSetSessionMode(command.sessionId, null);
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

        case "clear-session-reasoning": {
          if (command.sessionId) {
            options.onSetSessionReasoning(command.sessionId, null);
          }
          break;
        }

        case "set-session-workspace": {
          if (command.sessionId && command.workspace) {
            options.onSetSessionWorkspace(command.sessionId, command.workspace);
          }
          break;
        }

        case "clear-session-workspace": {
          if (command.sessionId) {
            options.onSetSessionWorkspace(command.sessionId, null);
          }
          break;
        }

        case "set-prompt-enhancement-mode": {
          if (
            command.promptEnhancementMode &&
            ["off", "simple", "web-search"].includes(
              command.promptEnhancementMode,
            )
          ) {
            options.onSetPromptEnhancementMode(
              command.promptEnhancementMode as "off" | "simple" | "web-search",
            );
          }
          break;
        }

        case "set-interview": {
          options.onSetInterview(command.enabled === true);
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
            throw new NonRetryableFleetCommandError(
              "The context-pack command is missing its session or pack id.",
            );
          }

          if (
            !options.onApplyContextPack(
              command.sessionId,
              command.contextPackId,
            )
          ) {
            throw new NonRetryableFleetCommandError(
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

        case "generate-media":
        case "cancel-media-run": {
          await executeFleetMediaCommand(command, configuredMediaProviderIds);
          await refreshMedia();
          break;
        }

        case "scheduler-trigger": {
          if (command.jobId) {
            await runFleetSchedulerAction(() =>
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
            await runFleetSchedulerAction(() =>
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
            await runFleetSchedulerAction(() =>
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
            await runFleetSchedulerAction(() =>
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
            await runFleetSchedulerAction(() =>
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
            await runFleetSchedulerAction(() =>
              cancelSchedulerRun(
                command.workspace ?? options.activeSession.workspace,
                command.runId!,
                command.commandId,
              ),
            );
          }
          break;
        }

        case "ralph-run":
        case "ralph-resume-run": {
          if (!providerModelCatalog) {
            throw new Error("The RALPH model catalog is still loading.");
          }

          let runtime: FleetRalphCommandRuntime;
          try {
            runtime = resolveFleetRalphCommandRuntime(
              command,
              providerModelCatalog,
            );
          } catch (error) {
            throw new NonRetryableFleetCommandError(
              error instanceof Error ? error.message : String(error),
            );
          }
          await startFleetRalphAction(command, runtime);
          break;
        }
      }

      options.onMarkFleetCommandHandled(command.commandId);
    },
    [
      getSessionForCommand,
      configuredMediaProviderIds,
      options,
      providerModelCatalog,
      refreshMedia,
      refreshRalph,
      runFleetSchedulerAction,
      startFleetRalphAction,
    ],
  );
  handleCommandRef.current = handleCommand;

  useEffect(() => {
    if (!isPrimaryController) {
      return;
    }

    void refreshFleetStatus();
    const refreshInterval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refreshFleetStatus();
      }
    }, STATUS_REFRESH_MS);

    return () => {
      window.clearInterval(refreshInterval);
    };
  }, [isPrimaryController, refreshFleetStatus]);

  useEffect(() => {
    if (!isPrimaryController || !fleetPublishingEnabled) {
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
  }, [isPrimaryController, refreshScheduler, fleetPublishingEnabled]);

  useEffect(() => {
    if (!isPrimaryController || !fleetPublishingEnabled) {
      return;
    }

    void refreshRalph();
    const refreshInterval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refreshRalph();
      }
    }, RALPH_REFRESH_MS);

    return () => {
      window.clearInterval(refreshInterval);
      ralphRefreshSequenceRef.current += 1;
    };
  }, [isPrimaryController, refreshRalph, fleetPublishingEnabled]);

  useEffect(() => {
    if (!isPrimaryController || !fleetPublishingEnabled) {
      return;
    }

    void refreshMedia();
    const refreshInterval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refreshMedia();
      }
    }, MEDIA_REFRESH_MS);

    return () => {
      window.clearInterval(refreshInterval);
      mediaRefreshSequenceRef.current += 1;
    };
  }, [isPrimaryController, refreshMedia, fleetPublishingEnabled]);

  useEffect(() => {
    if (
      !isPrimaryController ||
      !options.hasHydrated ||
      !fleetPublishingEnabled
    ) {
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
      void updateFleetControlShellSnapshot(snapshot)
        .then(() => {
          if (
            !fleetControlMountedRef.current ||
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
            !fleetControlMountedRef.current ||
            attemptSequence !== snapshotPublishAttemptSequenceRef.current
          ) {
            return;
          }
          console.error("Failed to publish Fleet Manager product state", error);
          snapshotPublishRetryAttemptRef.current += 1;
          if (snapshotPublishRetryTimerRef.current === null) {
            const retryDelay = Math.min(
              10_000,
              500 *
                2 ** Math.min(snapshotPublishRetryAttemptRef.current - 1, 5),
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
    fleetPublishingEnabled,
  ]);

  useEffect(() => {
    fleetControlMountedRef.current = true;

    return () => {
      fleetControlMountedRef.current = false;
      schedulerRefreshSequenceRef.current += 1;
      ralphRefreshSequenceRef.current += 1;
      mediaRefreshSequenceRef.current += 1;
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
    const bufferedCommands: FleetControlCommandEvent[] = [];
    const commandQueue: FleetControlCommandEvent[] = [];
    const queuedCommandIds = new Set<string>();
    const failedAttemptCounts = new Map<string, number>();
    let loadPendingCommandsRef: (() => Promise<void>) | null = null;

    const executeCommand = async (
      command: FleetControlCommandEvent,
    ): Promise<void> => {
      const lease = await beginCrossWindowOperation(
        `fleet-command:${command.commandId}`,
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
          await acknowledgeFleetControlCommand(command.commandId);
        }
        await completeCrossWindowOperation(lease);
        failedAttemptCounts.delete(command.commandId);
      } catch (error) {
        handledFleetCommandIds.delete(command.commandId);
        const attempts = (failedAttemptCounts.get(command.commandId) ?? 0) + 1;
        failedAttemptCounts.set(command.commandId, attempts);
        const shouldAcknowledge =
          error instanceof NonRetryableFleetCommandError ||
          !IDEMPOTENT_FLEET_COMMAND_KINDS.has(command.kind) ||
          attempts >= MAX_IDEMPOTENT_FLEET_COMMAND_ATTEMPTS;

        if (shouldAcknowledge) {
          try {
            if (canUseTauriStore()) {
              await acknowledgeFleetControlCommand(command.commandId);
            }
            if (!disposed) {
              console.error("Fleet Manager command failed", error);
            }
            failedAttemptCounts.delete(command.commandId);
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
            console.error("Failed to process Fleet control command", error);
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
      commands: readonly FleetControlCommandEvent[],
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

    const receiveCommand = (command: FleetControlCommandEvent): void => {
      if (canUseTauriStore()) {
        void loadPendingCommandsRef?.().catch((error) => {
          console.error("Failed to load pending Fleet control commands", error);
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

      const commands = await getPendingFleetControlCommands();

      if (disposed) {
        return;
      }

      if (!initialized) {
        const pendingIds = new Set(
          commands.map((command) => command.commandId),
        );
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

    void subscribeToFleetControlCommands(receiveCommand).then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }

      unsubscribe = unlisten;
    });
    void loadPendingCommands().catch((error) => {
      console.error("Failed to load pending Fleet control commands", error);
    });
    const pendingPoll = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void loadPendingCommands().catch((error) => {
          console.error(
            "Failed to refresh pending Fleet control commands",
            error,
          );
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
};
