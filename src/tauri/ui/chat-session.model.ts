import type { TaskTimelineMessage } from "./task-timeline.model";
import {
  getCatalogModelsForProvider,
  getDefaultModelForProvider,
  type RuntimeProvider,
} from "./model-catalog";

const isRuntimeProvider = (value: unknown): value is RuntimeProvider => {
  return value === "openai" || value === "anthropic" || value === "google";
};

export interface ChatSessionRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  workspace: string | null;
  provider: RuntimeProvider;
  model: string;
  draft: string;
  manualTitle?: string;
  messages: TaskTimelineMessage[];
  promptHistory: string[];
}

export interface ShellPersistedState {
  version: 1;
  activeSessionId: string;
  sessions: ChatSessionRecord[];
  lastSelectedProvider: RuntimeProvider;
  lastSelectedModelByProvider: Partial<Record<RuntimeProvider, string>>;
}

const DEFAULT_PROVIDER: RuntimeProvider = "openai";

export const createSession = (
  overrides: Partial<ChatSessionRecord> = {},
): ChatSessionRecord => {
  const provider = overrides.provider ?? DEFAULT_PROVIDER;
  const now = overrides.updatedAt ?? Date.now();

  return {
    id: overrides.id ?? crypto.randomUUID(),
    createdAt: overrides.createdAt ?? now,
    updatedAt: now,
    workspace: overrides.workspace ?? null,
    provider,
    model: overrides.model ?? getDefaultModelForProvider(provider),
    draft: overrides.draft ?? "",
    ...(overrides.manualTitle ? { manualTitle: overrides.manualTitle } : {}),
    messages: overrides.messages ?? [],
    promptHistory: overrides.promptHistory ?? [],
  };
};

export const getSessionTitle = (session: ChatSessionRecord): string => {
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
    lastSelectedProvider: DEFAULT_PROVIDER,
    lastSelectedModelByProvider: {
      openai: getDefaultModelForProvider("openai"),
      anthropic: getDefaultModelForProvider("anthropic"),
      google: getDefaultModelForProvider("google"),
    },
  };
};

export const normalizeShellState = (
  value: unknown,
): ShellPersistedState => {
  const fallback = createInitialShellState();

  if (!value || typeof value !== "object") {
    return fallback;
  }

  const candidate = value as Partial<ShellPersistedState>;
  const sessions = Array.isArray(candidate.sessions)
    ? candidate.sessions
        .filter((session): session is ChatSessionRecord => {
          return Boolean(
            session &&
              typeof session === "object" &&
              typeof (session as ChatSessionRecord).id === "string",
          );
        })
        .map((session) => {
          const provider = isRuntimeProvider(session.provider)
            ? session.provider
            : "openai";
          const sessionModel =
            typeof session.model === "string" && session.model.trim().length > 0
              ? session.model.trim()
              : undefined;
          const providerModels = getCatalogModelsForProvider(provider);
          const model =
            session.provider === provider &&
            sessionModel &&
            providerModels.some((entry) => entry.id === sessionModel)
              ? sessionModel
              : getDefaultModelForProvider(provider);

          return createSession({
            ...session,
            provider,
            model,
            draft: typeof session.draft === "string" ? session.draft : "",
            workspace:
              typeof session.workspace === "string"
                ? session.workspace
                : null,
            manualTitle:
              typeof session.manualTitle === "string"
                ? session.manualTitle
                : undefined,
            messages: Array.isArray(session.messages) ? session.messages : [],
            promptHistory: Array.isArray(session.promptHistory)
              ? session.promptHistory.filter(
                  (entry): entry is string => typeof entry === "string",
                )
              : [],
            createdAt:
              typeof session.createdAt === "number"
                ? session.createdAt
                : undefined,
            updatedAt:
              typeof session.updatedAt === "number"
                ? session.updatedAt
                : undefined,
          });
        })
    : [];

  const normalizedSessions = sessions.length > 0 ? sessions : fallback.sessions;
  const hasActiveSession = normalizedSessions.some(
    (session) => session.id === candidate.activeSessionId,
  );
  const lastSelectedProvider = isRuntimeProvider(candidate.lastSelectedProvider)
    ? candidate.lastSelectedProvider
    : fallback.lastSelectedProvider;

  return {
    version: 1,
    activeSessionId: hasActiveSession
      ? (candidate.activeSessionId as string)
      : normalizedSessions[0].id,
    sessions: normalizedSessions,
    lastSelectedProvider,
    lastSelectedModelByProvider: {
      ...fallback.lastSelectedModelByProvider,
      ...(candidate.lastSelectedModelByProvider ?? {}),
    },
  };
};

export const sortSessionsByUpdatedAt = (
  sessions: ChatSessionRecord[],
): ChatSessionRecord[] => {
  return [...sessions].sort((left, right) => right.updatedAt - left.updatedAt);
};

export const createVisibleConversationMessages = (
  messages: TaskTimelineMessage[],
): TaskTimelineMessage[] => {
  const latestAgentMessageByTask = new Map<string, string>();

  messages.forEach((message) => {
    if (message.role === "agent" && message.taskId) {
      latestAgentMessageByTask.set(message.taskId, message.id);
    }
  });

  return messages.filter((message) => {
    if (message.role !== "agent" || !message.taskId) {
      return true;
    }

    return latestAgentMessageByTask.get(message.taskId) === message.id;
  });
};