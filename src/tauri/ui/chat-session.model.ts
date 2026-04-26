import { normalizeConversationMemoryEntries } from "../../core/memory.js";
import type { ConversationMemoryEntry, RunMode } from "../../core/types.js";
import {
  getDefaultModelForProvider,
  type RuntimeProvider,
} from "./model-catalog";
import type { TaskPanelSource } from "./task-panel.model";
import type { TaskThinkingSource } from "./task-thinking.model";

export type ChatSessionMessageSource = TaskPanelSource | TaskThinkingSource;

export type ChatSessionSpecialKind = "quick-voice";

export interface ChatSessionMessage {
  id: string;
  taskId?: string;
  role: "user" | "agent";
  content: string;
  createdAt?: number;
  source?: ChatSessionMessageSource;
}

export interface ChatSessionRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  specialSession?: ChatSessionSpecialKind;
  workspace: string | null;
  profile?: string;
  provider: RuntimeProvider;
  model: string;
  mode?: RunMode;
  draft: string;
  manualTitle?: string;
  messages: ChatSessionMessage[];
  promptHistory: string[];
  sessionMemoryEnabled: boolean;
  useGlobalMemory: boolean;
  uiControlEnabled: boolean;
  sessionMemory: ConversationMemoryEntry[];
}

export interface ShellVoiceSettings {
  autoSpeakResponses: boolean;
  preferredVoiceURI?: string;
  rate: number;
}

export type SessionOverviewStatus =
  | "empty"
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "crashed";

export interface ShellPersistedState {
  version: 1;
  activeSessionId: string;
  sessions: ChatSessionRecord[];
  voice: ShellVoiceSettings;
  lastSelectedProvider: RuntimeProvider;
  lastSelectedModelByProvider: Partial<Record<RuntimeProvider, string>>;
  lastSelectedProfile?: string;
  lastSelectedMode?: RunMode;
  lastRecoveredLaunchId?: string;
}

const DEFAULT_PROVIDER: RuntimeProvider = "openai";
const DEFAULT_VOICE_RATE = 1;
const MIN_VOICE_RATE = 0.8;
const MAX_VOICE_RATE = 1.4;
const SPECIAL_SESSION_KINDS = ["quick-voice"] as const;
const RUN_MODES: RunMode[] = ["safe", "ask", "auto"];
const RUNTIME_PROVIDERS: RuntimeProvider[] = ["openai", "anthropic", "google"];

export const QUICK_VOICE_SESSION_KIND: ChatSessionSpecialKind = "quick-voice";

const clampVoiceRate = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_VOICE_RATE;
  }

  return Math.min(MAX_VOICE_RATE, Math.max(MIN_VOICE_RATE, value));
};

export const createDefaultShellVoiceSettings = (): ShellVoiceSettings => {
  return {
    autoSpeakResponses: false,
    rate: DEFAULT_VOICE_RATE,
  };
};

const isRunMode = (value: unknown): value is RunMode => {
  return typeof value === "string" && RUN_MODES.includes(value as RunMode);
};

const isRuntimeProvider = (value: unknown): value is RuntimeProvider => {
  return (
    typeof value === "string" &&
    RUNTIME_PROVIDERS.includes(value as RuntimeProvider)
  );
};

const isSpecialSessionKind = (
  value: unknown,
): value is ChatSessionSpecialKind => {
  return (
    typeof value === "string" &&
    SPECIAL_SESSION_KINDS.includes(value as ChatSessionSpecialKind)
  );
};

export const createSession = (
  overrides: Partial<ChatSessionRecord> = {},
): ChatSessionRecord => {
  const provider = overrides.provider ?? DEFAULT_PROVIDER;
  const now = overrides.updatedAt ?? Date.now();
  const specialSession = isSpecialSessionKind(overrides.specialSession)
    ? overrides.specialSession
    : undefined;
  const isQuickTaskSession = specialSession === QUICK_VOICE_SESSION_KIND;

  return {
    id: overrides.id ?? crypto.randomUUID(),
    createdAt: overrides.createdAt ?? now,
    updatedAt: now,
    ...(typeof overrides.archivedAt === "number"
      ? { archivedAt: overrides.archivedAt }
      : {}),
    ...(specialSession ? { specialSession } : {}),
    workspace: overrides.workspace ?? null,
    ...(overrides.profile ? { profile: overrides.profile } : {}),
    provider,
    model: overrides.model ?? getDefaultModelForProvider(provider),
    ...(overrides.mode ? { mode: overrides.mode } : {}),
    draft: overrides.draft ?? "",
    ...(overrides.manualTitle ? { manualTitle: overrides.manualTitle } : {}),
    messages: overrides.messages ?? [],
    promptHistory: overrides.promptHistory ?? [],
    sessionMemoryEnabled: isQuickTaskSession
      ? false
      : (overrides.sessionMemoryEnabled ?? true),
    useGlobalMemory: overrides.useGlobalMemory ?? true,
    uiControlEnabled: overrides.uiControlEnabled ?? false,
    sessionMemory: isQuickTaskSession ? [] : (overrides.sessionMemory ?? []),
  };
};

export const getSessionTitle = (session: ChatSessionRecord): string => {
  if (session.specialSession === QUICK_VOICE_SESSION_KIND) {
    return "Quick Tasks";
  }

  if (session.manualTitle?.trim()) {
    return session.manualTitle.trim();
  }

  const firstUserMessage = session.messages.find(
    (message) => message.role === "user" && message.content.trim().length > 0,
  );

  if (!firstUserMessage) {
    return "New session";
  }

  const normalized = firstUserMessage.content.trim();

  if (normalized.length <= 48) {
    return normalized;
  }

  return `${normalized.slice(0, 45)}…`;
};

export const createInitialShellState = (): ShellPersistedState => {
  const initialSession = createSession();

  return {
    version: 1,
    activeSessionId: initialSession.id,
    sessions: [initialSession],
    voice: createDefaultShellVoiceSettings(),
    lastSelectedProvider: DEFAULT_PROVIDER,
    lastSelectedModelByProvider: {
      openai: getDefaultModelForProvider("openai"),
      anthropic: getDefaultModelForProvider("anthropic"),
      google: getDefaultModelForProvider("google"),
    },
  };
};

const normalizePromptHistoryEntries = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalizedEntries: string[] = [];

  for (const entry of value) {
    if (typeof entry === "string") {
      normalizedEntries.push(entry);
    }
  }

  return normalizedEntries;
};

const normalizeSessionRecord = (session: ChatSessionRecord): ChatSessionRecord => {
  const provider = isRuntimeProvider(session.provider)
    ? session.provider
    : DEFAULT_PROVIDER;
  const preserveModel = provider === session.provider;
  const mode = isRunMode(session.mode) ? session.mode : undefined;
  const specialSession = isSpecialSessionKind(session.specialSession)
    ? session.specialSession
    : undefined;
  const isQuickTaskSession = specialSession === QUICK_VOICE_SESSION_KIND;

  return createSession({
    ...session,
    provider,
    ...(specialSession ? { specialSession } : {}),
    ...(typeof session.profile === "string" && session.profile.trim().length > 0
      ? { profile: session.profile }
      : {}),
    ...(mode ? { mode } : {}),
    model:
      preserveModel &&
      typeof session.model === "string" &&
      session.model.trim().length > 0
        ? session.model
        : undefined,
    draft: typeof session.draft === "string" ? session.draft : "",
    workspace: typeof session.workspace === "string" ? session.workspace : null,
    manualTitle:
      typeof session.manualTitle === "string" ? session.manualTitle : undefined,
    messages: Array.isArray(session.messages) ? session.messages : [],
    promptHistory: normalizePromptHistoryEntries(session.promptHistory),
    sessionMemoryEnabled: isQuickTaskSession
      ? false
      : session.sessionMemoryEnabled !== false,
    useGlobalMemory: session.useGlobalMemory !== false,
    uiControlEnabled: session.uiControlEnabled === true,
    sessionMemory: isQuickTaskSession
      ? []
      : normalizeConversationMemoryEntries(session.sessionMemory, "session"),
    createdAt:
      typeof session.createdAt === "number" ? session.createdAt : undefined,
    updatedAt:
      typeof session.updatedAt === "number" ? session.updatedAt : undefined,
    archivedAt:
      typeof session.archivedAt === "number" ? session.archivedAt : undefined,
  });
};

export const normalizeShellState = (value: unknown): ShellPersistedState => {
  const fallback = createInitialShellState();

  if (!value || typeof value !== "object") {
    return fallback;
  }

  const candidate = value as Partial<ShellPersistedState>;
  const sessions: ChatSessionRecord[] = [];

  if (Array.isArray(candidate.sessions)) {
    for (const session of candidate.sessions) {
      if (
        !session ||
        typeof session !== "object" ||
        typeof (session as ChatSessionRecord).id !== "string"
      ) {
        continue;
      }

      sessions.push(normalizeSessionRecord(session as ChatSessionRecord));
    }
  }

  const normalizedSessions = sessions.length > 0 ? sessions : fallback.sessions;
  let hasActiveSession = false;

  for (const session of normalizedSessions) {
    if (session.id === candidate.activeSessionId) {
      hasActiveSession = true;
      break;
    }
  }

  const lastSelectedProvider = isRuntimeProvider(candidate.lastSelectedProvider)
    ? candidate.lastSelectedProvider
    : fallback.lastSelectedProvider;
  const lastSelectedModelByProvider: Partial<Record<RuntimeProvider, string>> =
    {};

  for (const [provider, model] of Object.entries(
    candidate.lastSelectedModelByProvider ?? {},
  )) {
    if (
      isRuntimeProvider(provider) &&
      typeof model === "string" &&
      model.trim().length > 0
    ) {
      lastSelectedModelByProvider[provider] = model;
    }
  }

  const lastSelectedProfile =
    typeof candidate.lastSelectedProfile === "string" &&
    candidate.lastSelectedProfile.trim().length > 0
      ? candidate.lastSelectedProfile
      : undefined;
  const lastSelectedMode = isRunMode(candidate.lastSelectedMode)
    ? candidate.lastSelectedMode
    : undefined;
  const lastRecoveredLaunchId =
    typeof candidate.lastRecoveredLaunchId === "string" &&
    candidate.lastRecoveredLaunchId.trim().length > 0
      ? candidate.lastRecoveredLaunchId
      : undefined;
  const voiceCandidate =
    candidate.voice && typeof candidate.voice === "object"
      ? (candidate.voice as Partial<ShellVoiceSettings>)
      : null;
  const normalizedPreferredVoiceURI =
    typeof voiceCandidate?.preferredVoiceURI === "string" &&
    voiceCandidate.preferredVoiceURI.trim().length > 0
      ? voiceCandidate.preferredVoiceURI
      : undefined;
  const normalizedVoice: ShellVoiceSettings = {
    autoSpeakResponses: voiceCandidate?.autoSpeakResponses === true,
    rate: clampVoiceRate(voiceCandidate?.rate),
    ...(normalizedPreferredVoiceURI
      ? { preferredVoiceURI: normalizedPreferredVoiceURI }
      : {}),
  };

  return {
    version: 1,
    activeSessionId: hasActiveSession
      ? (candidate.activeSessionId as string)
      : normalizedSessions[0].id,
    sessions: normalizedSessions,
    voice: normalizedVoice,
    lastSelectedProvider,
    lastSelectedModelByProvider: {
      ...fallback.lastSelectedModelByProvider,
      ...lastSelectedModelByProvider,
    },
    ...(lastSelectedProfile ? { lastSelectedProfile } : {}),
    ...(lastSelectedMode ? { lastSelectedMode } : {}),
    ...(lastRecoveredLaunchId ? { lastRecoveredLaunchId } : {}),
  };
};

export const sortSessionsByUpdatedAt = (
  sessions: ChatSessionRecord[],
): ChatSessionRecord[] => {
  return [...sessions].sort((left, right) => right.updatedAt - left.updatedAt);
};

const getMessageTaskId = (message: ChatSessionMessage): string => {
  return message.taskId ?? message.id;
};

const getMessageTimestamp = (
  message: ChatSessionMessage,
  fallback: number,
): number => {
  return typeof message.createdAt === "number" ? message.createdAt : fallback;
};

const getLatestUserTaskId = (messages: ChatSessionMessage[]): string | null => {
  let latestTask: { taskId: string; timestamp: number } | null = null;

  for (const [index, message] of messages.entries()) {
    if (message.role !== "user") {
      continue;
    }

    const timestamp = getMessageTimestamp(message, index);
    const taskId = getMessageTaskId(message);

    if (!latestTask || timestamp >= latestTask.timestamp) {
      latestTask = { taskId, timestamp };
    }
  }

  return latestTask?.taskId ?? null;
};

export const isSessionArchived = (session: ChatSessionRecord): boolean => {
  return typeof session.archivedAt === "number";
};

export const isQuickVoiceSession = (
  session: ChatSessionRecord,
): boolean => {
  return session.specialSession === QUICK_VOICE_SESSION_KIND;
};

export const canDeleteSession = (session: ChatSessionRecord): boolean => {
  return !isQuickVoiceSession(session);
};

export const canRenameSession = (session: ChatSessionRecord): boolean => {
  return !isQuickVoiceSession(session);
};

export const getSessionOverviewStatus = (
  session: ChatSessionRecord,
): SessionOverviewStatus => {
  if (session.messages.length === 0) {
    return "empty";
  }

  const latestUserTaskId = getLatestUserTaskId(session.messages);

  if (!latestUserTaskId) {
    return "empty";
  }

  let latestTerminalAgentMessage: ChatSessionMessage | null = null;

  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];

    if (getMessageTaskId(message) !== latestUserTaskId) {
      continue;
    }

    if (message.role !== "agent" || message.source?.kind === "preview") {
      continue;
    }

    latestTerminalAgentMessage = message;
    break;
  }

  if (!latestTerminalAgentMessage) {
    return "running";
  }

  if (!latestTerminalAgentMessage.source) {
    return "crashed";
  }

  if (latestTerminalAgentMessage.source.kind === "thinking") {
    if (latestTerminalAgentMessage.source.thinking.status === "running") {
      return "running";
    }
    return "done";
  }

  if (latestTerminalAgentMessage.source.kind === "execution") {
    const status = latestTerminalAgentMessage.source.execution.status;

    if (status === "approval-required") {
      return "waiting";
    }

    if (status === "blocked" || status === "cancelled") {
      return "failed";
    }
  }

  return "done";
};

const getInterruptedTaskIds = (
  messages: ChatSessionMessage[],
): Set<string> => {
  const taskIdsWithUserMessage = new Set<string>();
  const latestTerminalAgentMessageByTaskId = new Map<
    string,
    ChatSessionMessage
  >();
  let latestUserTaskId: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      const taskId = getMessageTaskId(message);

      latestUserTaskId = taskId;
      taskIdsWithUserMessage.add(taskId);
      continue;
    }

    if (message.role !== "agent" || message.source?.kind === "preview") {
      continue;
    }

    const taskId = message.taskId ?? latestUserTaskId ?? message.id;

    latestTerminalAgentMessageByTaskId.set(taskId, message);
  }

  const interruptedTaskIds = new Set<string>();

  for (const taskId of taskIdsWithUserMessage) {
    const latestTerminalAgentMessage =
      latestTerminalAgentMessageByTaskId.get(taskId);

    if (!latestTerminalAgentMessage) {
      interruptedTaskIds.add(taskId);
      continue;
    }

    if (
      latestTerminalAgentMessage.source?.kind === "thinking" &&
      latestTerminalAgentMessage.source.thinking.status === "running"
    ) {
      interruptedTaskIds.add(taskId);
    }
  }

  return interruptedTaskIds;
};

const createInterruptedTaskCrashMessage = (
  taskId: string,
  timestamp: number,
  index: number,
): ChatSessionMessage => {
  return {
    id: `interrupted-${taskId}-${timestamp}-${index}`,
    taskId,
    role: "agent",
    content:
      "**Task crashed.** machdoch restarted before this AI task finished, so it was marked as crashed.",
    createdAt: timestamp,
  };
};

const recoverInterruptedSessionTasks = (
  session: ChatSessionRecord,
  timestamp: number,
): ChatSessionRecord => {
  const interruptedTaskIds = getInterruptedTaskIds(session.messages);

  if (interruptedTaskIds.size === 0) {
    return session;
  }

  const messageTaskIds: string[] = [];
  const lastMessageIndexByTaskId = new Map<string, number>();
  const hasCrashMessageByTaskId = new Map<string, boolean>();
  let latestUserTaskId: string | null = null;

  for (const [index, message] of session.messages.entries()) {
    const taskId =
      message.role === "agent"
        ? message.taskId ?? latestUserTaskId ?? message.id
        : getMessageTaskId(message);

    if (message.role === "user") {
      latestUserTaskId = taskId;
    }

    messageTaskIds[index] = taskId;
    lastMessageIndexByTaskId.set(taskId, index);

    if (message.role === "agent" && !message.source) {
      hasCrashMessageByTaskId.set(taskId, true);
    }
  }

  const nextMessages: ChatSessionMessage[] = [];
  let crashMessageIndex = 0;

  for (const [index, message] of session.messages.entries()) {
    const taskId = messageTaskIds[index] ?? getMessageTaskId(message);
    const isStaleRunningThinkingMessage =
      interruptedTaskIds.has(taskId) &&
      message.role === "agent" &&
      message.source?.kind === "thinking" &&
      message.source.thinking.status === "running";

    if (!isStaleRunningThinkingMessage) {
      nextMessages.push(message);
    }

    if (
      interruptedTaskIds.has(taskId) &&
      lastMessageIndexByTaskId.get(taskId) === index &&
      hasCrashMessageByTaskId.get(taskId) !== true
    ) {
      nextMessages.push(
        createInterruptedTaskCrashMessage(
          taskId,
          timestamp,
          crashMessageIndex,
        ),
      );
      crashMessageIndex += 1;
    }
  }

  return {
    ...session,
    messages: nextMessages,
  };
};

export const recoverInterruptedTasksForLaunch = (
  state: ShellPersistedState,
  launchId: string | null | undefined,
  timestamp = Date.now(),
): ShellPersistedState => {
  const normalizedLaunchId = launchId?.trim();

  if (!normalizedLaunchId || state.lastRecoveredLaunchId === normalizedLaunchId) {
    return state;
  }

  let didRecoverInterruptedTasks = false;
  const sessions = state.sessions.map((session) => {
    const recoveredSession = recoverInterruptedSessionTasks(session, timestamp);

    if (recoveredSession !== session) {
      didRecoverInterruptedTasks = true;
    }

    return recoveredSession;
  });

  return {
    ...state,
    lastRecoveredLaunchId: normalizedLaunchId,
    sessions: didRecoverInterruptedTasks ? sessions : state.sessions,
  };
};

export const canArchiveSession = (session: ChatSessionRecord): boolean => {
  return (
    !isQuickVoiceSession(session) &&
    !isSessionArchived(session) &&
    getSessionOverviewStatus(session) !== "running"
  );
};

export const createVisibleConversationMessages = (
  messages: ChatSessionMessage[],
): ChatSessionMessage[] => {
  const latestRenderableAgentMessageByTask = new Map<string, string>();

  for (const message of messages) {
    if (
      message.role === "agent" &&
      message.taskId &&
      message.source?.kind !== "preview"
    ) {
      latestRenderableAgentMessageByTask.set(message.taskId, message.id);
    }
  }

  const visibleMessages: ChatSessionMessage[] = [];

  for (const message of messages) {
    if (message.role !== "agent" || !message.taskId) {
      visibleMessages.push(message);
      continue;
    }

    if (message.source?.kind === "preview") {
      continue;
    }

    if (latestRenderableAgentMessageByTask.get(message.taskId) === message.id) {
      visibleMessages.push(message);
    }
  }

  return visibleMessages;
};

export const trimSessionTaskGroupsToVisibleMessageLimit = (
  messages: ChatSessionMessage[],
  maxVisibleMessages: number,
): ChatSessionMessage[] => {
  if (!Number.isFinite(maxVisibleMessages) || maxVisibleMessages <= 0) {
    return [];
  }

  const normalizedLimit = Math.max(1, Math.floor(maxVisibleMessages));
  const taskGroups: ChatSessionMessage[][] = [];

  for (const message of messages) {
    const taskGroupId = getMessageTaskId(message);
    const currentGroup = taskGroups.at(-1);
    const currentGroupId = currentGroup?.[0]
      ? getMessageTaskId(currentGroup[0])
      : null;

    if (currentGroup && currentGroupId === taskGroupId) {
      currentGroup.push(message);
      continue;
    }

    taskGroups.push([message]);
  }

  let visibleMessageCount = 0;
  const keptGroups: ChatSessionMessage[][] = [];

  for (let index = taskGroups.length - 1; index >= 0; index -= 1) {
    const taskGroup = taskGroups[index];
    const taskGroupVisibleMessages = createVisibleConversationMessages(
      taskGroup,
    ).length;

    if (
      keptGroups.length > 0 &&
      visibleMessageCount + taskGroupVisibleMessages > normalizedLimit
    ) {
      break;
    }

    visibleMessageCount += taskGroupVisibleMessages;
    keptGroups.unshift(taskGroup);
  }

  return keptGroups.flat();
};
