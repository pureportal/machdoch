import { normalizeConversationMemoryEntries } from "../../core/memory.js";
import type { ConversationMemoryEntry } from "../../core/types.js";
import {
  getDefaultModelForProvider,
  type RuntimeProvider,
} from "./model-catalog";
import type { TaskPanelSource } from "./task-panel.model";

export interface ChatSessionMessage {
  id: string;
  taskId?: string;
  role: "user" | "agent";
  content: string;
  createdAt?: number;
  source?: TaskPanelSource;
}

export interface ChatSessionRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  workspace: string | null;
  provider: RuntimeProvider;
  model: string;
  draft: string;
  manualTitle?: string;
  messages: ChatSessionMessage[];
  promptHistory: string[];
  sessionMemoryEnabled: boolean;
  useGlobalMemory: boolean;
  sessionMemory: ConversationMemoryEntry[];
}

export type SessionOverviewStatus = "empty" | "running" | "waiting" | "done";

export interface ShellPersistedState {
  version: 1;
  activeSessionId: string;
  sessions: ChatSessionRecord[];
  lastSelectedProvider: RuntimeProvider;
  lastSelectedModelByProvider: Partial<Record<RuntimeProvider, string>>;
}

const DEFAULT_PROVIDER: RuntimeProvider = "openai";
const RUNTIME_PROVIDERS: RuntimeProvider[] = ["openai", "anthropic", "google"];

const isRuntimeProvider = (value: unknown): value is RuntimeProvider => {
  return (
    typeof value === "string" &&
    RUNTIME_PROVIDERS.includes(value as RuntimeProvider)
  );
};

export const createSession = (
  overrides: Partial<ChatSessionRecord> = {},
): ChatSessionRecord => {
  const provider = overrides.provider ?? DEFAULT_PROVIDER;
  const now = overrides.updatedAt ?? Date.now();

  return {
    id: overrides.id ?? crypto.randomUUID(),
    createdAt: overrides.createdAt ?? now,
    updatedAt: now,
    ...(typeof overrides.archivedAt === "number"
      ? { archivedAt: overrides.archivedAt }
      : {}),
    workspace: overrides.workspace ?? null,
    provider,
    model: overrides.model ?? getDefaultModelForProvider(provider),
    draft: overrides.draft ?? "",
    ...(overrides.manualTitle ? { manualTitle: overrides.manualTitle } : {}),
    messages: overrides.messages ?? [],
    promptHistory: overrides.promptHistory ?? [],
    sessionMemoryEnabled: overrides.sessionMemoryEnabled ?? true,
    useGlobalMemory: overrides.useGlobalMemory ?? true,
    sessionMemory: overrides.sessionMemory ?? [],
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

export const normalizeShellState = (value: unknown): ShellPersistedState => {
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
              : DEFAULT_PROVIDER;
            const preserveModel = provider === session.provider;

            return createSession({
              ...session,
              provider,
              model:
                preserveModel &&
                typeof session.model === "string" &&
                session.model.trim().length > 0
                  ? session.model
                  : undefined,
              draft: typeof session.draft === "string" ? session.draft : "",
              workspace:
                typeof session.workspace === "string" ? session.workspace : null,
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
              sessionMemoryEnabled: session.sessionMemoryEnabled !== false,
              useGlobalMemory: session.useGlobalMemory !== false,
              sessionMemory: normalizeConversationMemoryEntries(
                session.sessionMemory,
                "session",
              ),
              createdAt:
                typeof session.createdAt === "number"
                  ? session.createdAt
                  : undefined,
              updatedAt:
                typeof session.updatedAt === "number"
                  ? session.updatedAt
                  : undefined,
              archivedAt:
                typeof session.archivedAt === "number"
                  ? session.archivedAt
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
  const lastSelectedModelByProvider = Object.entries(
    candidate.lastSelectedModelByProvider ?? {},
  ).reduce<Partial<Record<RuntimeProvider, string>>>((accumulator, entry) => {
    const [provider, model] = entry;

    if (
      isRuntimeProvider(provider) &&
      typeof model === "string" &&
      model.trim().length > 0
    ) {
      accumulator[provider] = model;
    }

    return accumulator;
  }, {});

  return {
    version: 1,
    activeSessionId: hasActiveSession
      ? (candidate.activeSessionId as string)
      : normalizedSessions[0].id,
    sessions: normalizedSessions,
    lastSelectedProvider,
    lastSelectedModelByProvider: {
      ...fallback.lastSelectedModelByProvider,
      ...lastSelectedModelByProvider,
    },
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

  messages.forEach((message, index) => {
    if (message.role !== "user") {
      return;
    }

    const timestamp = getMessageTimestamp(message, index);
    const taskId = getMessageTaskId(message);

    if (!latestTask || timestamp >= latestTask.timestamp) {
      latestTask = { taskId, timestamp };
    }
  });

  return latestTask?.taskId ?? null;
};

export const isSessionArchived = (session: ChatSessionRecord): boolean => {
  return typeof session.archivedAt === "number";
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

  const taskMessages = session.messages.filter(
    (message) => getMessageTaskId(message) === latestUserTaskId,
  );
  const latestTerminalAgentMessage = [...taskMessages]
    .reverse()
    .find((message) => {
      if (message.role !== "agent") {
        return false;
      }

      return message.source?.kind !== "preview";
    });

  if (!latestTerminalAgentMessage) {
    return "running";
  }

  if (
    latestTerminalAgentMessage.source?.kind === "execution" &&
    latestTerminalAgentMessage.source.execution.status === "approval-required"
  ) {
    return "waiting";
  }

  return "done";
};

export const canArchiveSession = (session: ChatSessionRecord): boolean => {
  return (
    !isSessionArchived(session) &&
    getSessionOverviewStatus(session) !== "running"
  );
};

export const createVisibleConversationMessages = (
  messages: ChatSessionMessage[],
): ChatSessionMessage[] => {
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
