import {
  canDuplicateSession,
  compareSessionsByAttention,
  createSession,
  getSessionOverviewStatus,
  getSessionTitle,
  hasUnreadCompletedSessionResponse,
  isQuickVoiceSession,
  isSessionArchived,
  normalizeShellState,
  normalizeSessionTags,
  type ChatSessionMessage,
  type ChatSessionRecord,
  type ShellPersistedState,
} from "../../chat-session.model";
import {
  getWorkspaceLabel,
  isConcreteSessionStatusFilter,
  normalizeSessionStatusFilterSelection,
  type SessionScopeFilter,
  type SessionStatusFilter,
  type SessionStatusFilterSelection,
} from "./session-shell";

export const ALL_SESSION_PROJECTS_FILTER = "__all_projects__";
const NO_WORKSPACE_PROJECT_KEY = "__no_workspace__";
const SESSION_EXPORT_KIND = "machdoch.sessions";
const SESSION_EXPORT_VERSION = 1;

export interface SessionHistoryTagFacet {
  label: string;
  count: number;
}

export interface SessionHistoryProjectFacet {
  id: string;
  label: string;
  path: string | null;
  count: number;
}

export interface SessionHistoryIndexEntry {
  session: ChatSessionRecord;
  title: string;
  searchText: string;
  searchTokens: string[];
  projectId: string;
  projectLabel: string;
  score: number;
}

export interface SessionHistoryIndex {
  entries: SessionHistoryIndexEntry[];
  tags: SessionHistoryTagFacet[];
  projects: SessionHistoryProjectFacet[];
}

export interface SessionHistoryFilterOptions {
  scope: SessionScopeFilter;
  status: SessionStatusFilter | SessionStatusFilterSelection;
  searchQuery?: string;
  projectFilter?: string;
  tagFilters?: string[];
}

export interface SessionHistoryFilterResult {
  sessions: ChatSessionRecord[];
  entries: SessionHistoryIndexEntry[];
}

export interface SessionExportPayload {
  kind: typeof SESSION_EXPORT_KIND;
  version: typeof SESSION_EXPORT_VERSION;
  exportedAt: number;
  activeSessionId?: string;
  sessions: ChatSessionRecord[];
}

const normalizeSearchText = (value: string): string => {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, " ")
    .replace(/[^a-z0-9._:/\\-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
};

const tokenizeSearchQuery = (value: string): string[] => {
  const normalized = normalizeSearchText(value);

  if (!normalized) {
    return [];
  }

  return normalized.split(" ").filter(Boolean);
};

const uniqueTokens = (value: string): string[] => {
  return [...new Set(tokenizeSearchQuery(value))];
};

const normalizeProjectKey = (workspace: string): string => {
  const trimmedWorkspace = workspace.trim();
  const normalizedWorkspace = trimmedWorkspace
    .replace(/\\/gu, "/")
    .replace(/\/+$/u, "");

  return (normalizedWorkspace || trimmedWorkspace).toLowerCase();
};

const getProjectId = (workspace: string | null): string => {
  return workspace?.trim()
    ? normalizeProjectKey(workspace)
    : NO_WORKSPACE_PROJECT_KEY;
};

const getProjectLabel = (workspace: string | null): string => {
  return getWorkspaceLabel(workspace);
};

const getMessageSearchParts = (message: ChatSessionMessage): string[] => {
  const parts = [message.content];

  if (message.source?.kind === "execution") {
    const execution = message.source.execution;

    parts.push(
      execution.task,
      execution.summary,
      execution.reason ?? "",
      execution.response?.markdown ?? "",
      ...(execution.response?.highlights ?? []),
      ...(execution.response?.verification ?? []),
      ...(execution.response?.followUps ?? []),
      ...(execution.response?.relatedFiles.flatMap((file) => [
        file.path,
        file.description,
      ]) ?? []),
      ...execution.outputSections.flatMap((section) => [
        section.title,
        ...section.lines,
      ]),
    );
  }

  if (message.source?.kind === "thinking") {
    const thinking = message.source.thinking;

    parts.push(
      thinking.assistantText ?? "",
      thinking.modelStream?.label ?? "",
      thinking.modelStream?.content ?? "",
      ...(thinking.actionOutputLines?.map((line) => line.text) ?? []),
      ...thinking.entries.flatMap((entry) => [entry.label, entry.detail]),
    );
  }

  return parts;
};

const calculateSearchScore = (
  entry: SessionHistoryIndexEntry,
  queryTokens: string[],
): number => {
  if (queryTokens.length === 0) {
    return 0;
  }

  let score = 0;
  const normalizedTitle = normalizeSearchText(entry.title);
  const normalizedTags = normalizeSearchText(entry.session.tags.join(" "));

  for (const token of queryTokens) {
    if (!entry.searchText.includes(token)) {
      return -1;
    }

    score += 1;

    if (normalizedTitle.includes(token)) {
      score += 6;
    }

    if (normalizedTitle.startsWith(token)) {
      score += 4;
    }

    if (normalizedTags.includes(token)) {
      score += 5;
    }

    if (entry.projectLabel.toLowerCase().includes(token)) {
      score += 2;
    }
  }

  return score;
};

const sortTagFacets = (
  tagsByLabel: Map<string, SessionHistoryTagFacet>,
): SessionHistoryTagFacet[] => {
  return [...tagsByLabel.values()].sort((left, right) => {
    if (left.count !== right.count) {
      return right.count - left.count;
    }

    return left.label.localeCompare(right.label);
  });
};

const sortProjectFacets = (
  projectsById: Map<string, SessionHistoryProjectFacet>,
): SessionHistoryProjectFacet[] => {
  return [...projectsById.values()].sort((left, right) => {
    if (left.count !== right.count) {
      return right.count - left.count;
    }

    return left.label.localeCompare(right.label);
  });
};

const matchesSessionStatusFilters = (
  session: ChatSessionRecord,
  filters: SessionStatusFilter | SessionStatusFilterSelection,
): boolean => {
  const selectedFilters = normalizeSessionStatusFilterSelection(filters).filter(
    isConcreteSessionStatusFilter,
  );

  if (selectedFilters.length === 0) {
    return true;
  }

  const sessionStatus = getSessionOverviewStatus(session);
  const hasUnreadResponse = selectedFilters.includes("unread")
    ? hasUnreadCompletedSessionResponse(session)
    : false;

  return selectedFilters.some((filter) => {
    if (filter === "unread") {
      return hasUnreadResponse;
    }

    return sessionStatus === filter;
  });
};

export const createSessionHistoryIndex = (
  sessions: ChatSessionRecord[],
): SessionHistoryIndex => {
  const tagsByLabel = new Map<string, SessionHistoryTagFacet>();
  const projectsById = new Map<string, SessionHistoryProjectFacet>();
  const entries = sessions.map((session) => {
    const title = getSessionTitle(session);
    const projectId = getProjectId(session.workspace);
    const projectLabel = getProjectLabel(session.workspace);
    const searchParts = [
      title,
      session.workspace ?? "",
      projectLabel,
      session.provider,
      session.model,
      session.draft,
      ...session.tags,
      ...session.messages.flatMap(getMessageSearchParts),
      ...session.promptHistory,
      ...session.draftContextAttachments.flatMap((attachment) => [
        attachment.name,
        attachment.path,
        attachment.parent ?? "",
      ]),
    ];
    const searchText = normalizeSearchText(searchParts.join(" "));

    for (const tag of session.tags) {
      const key = tag.toLowerCase();
      const existing = tagsByLabel.get(key);

      tagsByLabel.set(key, {
        label: existing?.label ?? tag,
        count: (existing?.count ?? 0) + 1,
      });
    }

    const existingProject = projectsById.get(projectId);
    projectsById.set(projectId, {
      id: projectId,
      label: existingProject?.label ?? projectLabel,
      path: session.workspace,
      count: (existingProject?.count ?? 0) + 1,
    });

    return {
      session,
      title,
      searchText,
      searchTokens: uniqueTokens(searchText),
      projectId,
      projectLabel,
      score: 0,
    };
  });

  return {
    entries,
    tags: sortTagFacets(tagsByLabel),
    projects: sortProjectFacets(projectsById),
  };
};

export const filterSessionHistoryIndex = (
  index: SessionHistoryIndex,
  options: SessionHistoryFilterOptions,
): SessionHistoryFilterResult => {
  const queryTokens = tokenizeSearchQuery(options.searchQuery ?? "");
  const tagFilters = new Set(
    normalizeSessionTags(options.tagFilters ?? []).map((tag) => tag.toLowerCase()),
  );
  const projectFilter =
    options.projectFilter && options.projectFilter !== ALL_SESSION_PROJECTS_FILTER
      ? options.projectFilter
      : null;
  const entries = index.entries
    .flatMap((entry) => {
      const isAlwaysVisibleSession = isQuickVoiceSession(entry.session);
      const archived = isSessionArchived(entry.session);
      const matchesScope =
        options.scope === "all"
          ? true
          : options.scope === "archived"
            ? archived
            : !archived;
      const matchesStatus = matchesSessionStatusFilters(
        entry.session,
        options.status,
      );
      const matchesProject = projectFilter ? entry.projectId === projectFilter : true;
      const sessionTagKeys = new Set(
        entry.session.tags.map((tag) => tag.toLowerCase()),
      );
      const matchesTags = [...tagFilters].every((tag) =>
        sessionTagKeys.has(tag),
      );
      const score = isAlwaysVisibleSession
        ? 0
        : calculateSearchScore(entry, queryTokens);

      if (
        !isAlwaysVisibleSession &&
        (!matchesScope ||
          !matchesStatus ||
          !matchesProject ||
          !matchesTags ||
          score < 0)
      ) {
        return [];
      }

      return [{ ...entry, score }];
    })
    .sort((left, right) => {
      const leftIsAlwaysVisibleSession = isQuickVoiceSession(left.session);
      const rightIsAlwaysVisibleSession = isQuickVoiceSession(right.session);

      if (leftIsAlwaysVisibleSession !== rightIsAlwaysVisibleSession) {
        return leftIsAlwaysVisibleSession ? -1 : 1;
      }

      if (left.score !== right.score) {
        return right.score - left.score;
      }

      return compareSessionsByAttention(left.session, right.session);
    });

  return {
    entries,
    sessions: entries.map((entry) => entry.session),
  };
};

const cloneJson = <T>(value: T): T => {
  return JSON.parse(JSON.stringify(value)) as T;
};

const cloneSessionMessages = (
  messages: ChatSessionMessage[],
): ChatSessionMessage[] => {
  const taskIds = new Map<string, string>();

  return messages.map((message) => {
    const clonedMessage = cloneJson(message);

    clonedMessage.id = crypto.randomUUID();

    if (message.taskId) {
      const nextTaskId = taskIds.get(message.taskId) ?? crypto.randomUUID();

      taskIds.set(message.taskId, nextTaskId);
      clonedMessage.taskId = nextTaskId;
    }

    return clonedMessage;
  });
};

export const duplicateSessionRecord = (
  session: ChatSessionRecord,
  mode: "duplicate" | "branch",
  timestamp = Date.now(),
): ChatSessionRecord => {
  if (isQuickVoiceSession(session)) {
    throw new Error("Quick Chat cannot be duplicated.");
  }

  if (!canDuplicateSession(session)) {
    throw new Error("Empty sessions cannot be duplicated.");
  }

  const title = getSessionTitle(session);
  const nextSession = createSession({
    ...cloneJson(session),
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
    manualTitle: `${title} ${mode === "branch" ? "branch" : "copy"}`,
    draft: mode === "branch" ? "" : session.draft,
    draftContextAttachments:
      mode === "branch" ? [] : cloneJson(session.draftContextAttachments),
    messages: cloneSessionMessages(session.messages),
    promptHistory: cloneJson(session.promptHistory),
    promptContextHistory: cloneJson(session.promptContextHistory),
    sessionMemory: cloneJson(session.sessionMemory),
  });

  delete nextSession.archivedAt;
  delete nextSession.pinnedAt;
  delete nextSession.specialSession;

  return nextSession;
};

export const createSessionExportPayload = (
  state: ShellPersistedState,
  sessionIds?: Iterable<string>,
  timestamp = Date.now(),
): SessionExportPayload => {
  const selectedSessionIds = sessionIds ? new Set(sessionIds) : null;
  const sessions = state.sessions
    .filter((session) => !isQuickVoiceSession(session))
    .filter((session) => !selectedSessionIds || selectedSessionIds.has(session.id))
    .map((session) => cloneJson(session));

  return {
    kind: SESSION_EXPORT_KIND,
    version: SESSION_EXPORT_VERSION,
    exportedAt: timestamp,
    ...(state.activeSessionId ? { activeSessionId: state.activeSessionId } : {}),
    sessions,
  };
};

const parseSessionExportPayload = (value: unknown): SessionExportPayload => {
  if (!value || typeof value !== "object") {
    throw new Error("Session import file is not valid JSON.");
  }

  const candidate = value as Partial<SessionExportPayload>;

  if (
    candidate.kind !== SESSION_EXPORT_KIND ||
    candidate.version !== SESSION_EXPORT_VERSION ||
    !Array.isArray(candidate.sessions)
  ) {
    throw new Error("Session import file is not a supported machdoch export.");
  }

  return {
    kind: SESSION_EXPORT_KIND,
    version: SESSION_EXPORT_VERSION,
    exportedAt:
      typeof candidate.exportedAt === "number" ? candidate.exportedAt : Date.now(),
    ...(typeof candidate.activeSessionId === "string"
      ? { activeSessionId: candidate.activeSessionId }
      : {}),
    sessions: candidate.sessions,
  };
};

export const importSessionsIntoShellState = (
  state: ShellPersistedState,
  rawPayload: unknown,
  timestamp = Date.now(),
): ShellPersistedState => {
  const payload = parseSessionExportPayload(rawPayload);
  const candidateSessions = payload.sessions.filter((session) => {
    return (
      session &&
      typeof session === "object" &&
      typeof (session as ChatSessionRecord).id === "string"
    );
  });

  if (candidateSessions.length === 0) {
    throw new Error("Session import file does not contain importable sessions.");
  }

  const existingIds = new Set(state.sessions.map((session) => session.id));
  const normalizedImportState = normalizeShellState({
    ...state,
    activeSessionId:
      payload.activeSessionId ?? candidateSessions[0].id ?? state.activeSessionId,
    sessions: candidateSessions,
  });
  const importedSessions = normalizedImportState.sessions
    .filter((session) => !isQuickVoiceSession(session))
    .map((session, index) => {
      const shouldRemapId = existingIds.has(session.id);
      const nextSession = createSession({
        ...session,
        id: shouldRemapId ? crypto.randomUUID() : session.id,
        createdAt: timestamp + index,
        updatedAt: timestamp + index,
      });

      delete nextSession.pinnedAt;
      existingIds.add(nextSession.id);

      return nextSession;
    });

  if (importedSessions.length === 0) {
    throw new Error("Session import file does not contain importable sessions.");
  }

  return {
    ...state,
    activeSessionId: importedSessions[0].id,
    sessions: [...importedSessions, ...state.sessions],
  };
};
