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
  type ChatSessionQueuedMessage,
  type ChatSessionRecord,
  type ShellPersistedState,
} from "../../chat-session.model";
import { isMediaAssetContextAttachment } from "@machdoch/client-ui/composer/model";
import {
  getWorkspaceLabel,
  isConcreteSessionStatusFilter,
  normalizeSessionStatusFilterSelection,
  type SessionScopeFilter,
  type SessionStatusFilter,
  type SessionStatusFilterSelection,
} from "./session-shell";
import {
  compareSessionsBySidebarGroup,
  ALL_SESSION_PROJECTS_FILTER,
  calculateSessionSearchScore,
  getSessionProjectId,
  normalizeSessionSearchText,
  tokenizeSessionSearchQuery,
} from "@machdoch/product-ui";
import { getSessionSidebarGroup } from "./session-sidebar-group";

export { ALL_SESSION_PROJECTS_FILTER } from "@machdoch/product-ui";
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
  contentIndexed: boolean;
  title: string;
  searchText: string;
  titleSearchText: string;
  tagSearchText: string;
  projectSearchText: string;
  projectId: string;
  projectLabel: string;
  score: number;
}

export type SessionHistoryIndexEntryCache = Map<
  string,
  SessionHistoryIndexEntry
>;

export interface SessionHistoryIndex {
  entries: SessionHistoryIndexEntry[];
  tags: SessionHistoryTagFacet[];
  projects: SessionHistoryProjectFacet[];
}

export interface SessionHistoryIndexOptions {
  includeContent?: boolean;
  workspaceRoots?: readonly string[];
}

export interface SessionHistoryFilterOptions {
  scope: SessionScopeFilter;
  status: SessionStatusFilter | SessionStatusFilterSelection;
  queuedSessionMessages?: readonly ChatSessionQueuedMessage[];
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

const getProjectLabel = (workspace: string | null): string => {
  return getWorkspaceLabel(workspace);
};

const appendMessageSearchParts = (
  parts: string[],
  message: ChatSessionMessage,
): void => {
  parts.push(message.content);
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
  queuedSessionMessages: readonly ChatSessionQueuedMessage[],
): boolean => {
  const selectedFilters = normalizeSessionStatusFilterSelection(filters).filter(
    isConcreteSessionStatusFilter,
  );

  if (selectedFilters.length === 0) {
    return true;
  }

  const sessionStatus = getSessionOverviewStatus(
    session,
    queuedSessionMessages,
  );
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
  entryCache?: SessionHistoryIndexEntryCache,
  options: SessionHistoryIndexOptions = {},
): SessionHistoryIndex => {
  const includeContent = options.includeContent !== false;
  const tagsByLabel = new Map<string, SessionHistoryTagFacet>();
  const projectsById = new Map<string, SessionHistoryProjectFacet>();
  const configuredProjectIds = options.workspaceRoots
    ? new Set(
        options.workspaceRoots.flatMap((workspaceRoot) => {
          const root = workspaceRoot.trim();

          if (!root) {
            return [];
          }

          const id = getSessionProjectId(root);
          projectsById.set(id, {
            id,
            label: getProjectLabel(root),
            path: root,
            count: 0,
          });
          return [id];
        }),
      )
    : null;
  const nextEntryCache = entryCache
    ? new Map<string, SessionHistoryIndexEntry>()
    : null;
  const entries = sessions.map((session) => {
    const title = getSessionTitle(session);
    const projectId = getSessionProjectId(session.workspace);
    const projectLabel = getProjectLabel(session.workspace);

    for (const tag of session.tags) {
      const key = tag.toLowerCase();
      const existing = tagsByLabel.get(key);

      tagsByLabel.set(key, {
        label: existing?.label ?? tag,
        count: (existing?.count ?? 0) + 1,
      });
    }

    if (
      configuredProjectIds === null ||
      !session.workspace?.trim() ||
      configuredProjectIds.has(projectId)
    ) {
      const existingProject = projectsById.get(projectId);
      projectsById.set(projectId, {
        id: projectId,
        label: existingProject?.label ?? projectLabel,
        path: existingProject?.path ?? session.workspace,
        count: (existingProject?.count ?? 0) + 1,
      });
    }

    const cachedEntry = entryCache?.get(session.id);

    if (
      cachedEntry?.session === session &&
      cachedEntry.contentIndexed === includeContent
    ) {
      nextEntryCache?.set(session.id, cachedEntry);
      return cachedEntry;
    }

    const searchParts = [
      title,
      session.workspace ?? "",
      projectLabel,
      session.provider,
      session.model,
      ...session.tags,
      ...(includeContent ? session.promptHistory : []),
    ];

    if (includeContent) {
      for (const message of session.messages) {
        appendMessageSearchParts(searchParts, message);
      }

      for (const attachment of session.draftContextAttachments) {
        searchParts.push(
          attachment.name,
          isMediaAssetContextAttachment(attachment)
            ? `${attachment.assetId} ${attachment.workspaceRoot}`
            : `${attachment.path} ${attachment.parent ?? ""}`,
        );
      }
    }

    const searchText = normalizeSessionSearchText(searchParts.join(" "));
    const entry: SessionHistoryIndexEntry = {
      session,
      contentIndexed: includeContent,
      title,
      searchText,
      titleSearchText: normalizeSessionSearchText(title),
      tagSearchText: normalizeSessionSearchText(session.tags.join(" ")),
      projectSearchText: normalizeSessionSearchText(projectLabel),
      projectId,
      projectLabel,
      score: 0,
    };

    nextEntryCache?.set(session.id, entry);
    return entry;
  });

  if (entryCache && nextEntryCache) {
    entryCache.clear();

    for (const [sessionId, entry] of nextEntryCache) {
      entryCache.set(sessionId, entry);
    }
  }

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
  const queryTokens = tokenizeSessionSearchQuery(options.searchQuery ?? "");
  const tagFilters = new Set(
    normalizeSessionTags(options.tagFilters ?? []).map((tag) =>
      tag.toLowerCase(),
    ),
  );
  const hasTagFilters = tagFilters.size > 0;
  const projectFilter =
    options.projectFilter &&
    options.projectFilter !== ALL_SESSION_PROJECTS_FILTER
      ? options.projectFilter
      : null;
  const entries: SessionHistoryIndexEntry[] = [];

  for (const entry of index.entries) {
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
      options.queuedSessionMessages ?? [],
    );
    const matchesProject = projectFilter
      ? entry.projectId === projectFilter
      : true;

    if (
      !isAlwaysVisibleSession &&
      (!matchesScope || !matchesStatus || !matchesProject)
    ) {
      continue;
    }

    const sessionTagKeys = hasTagFilters
      ? new Set(entry.session.tags.map((tag) => tag.toLowerCase()))
      : null;
    let matchesTags = true;

    if (sessionTagKeys) {
      for (const tag of tagFilters) {
        if (!sessionTagKeys.has(tag)) {
          matchesTags = false;
          break;
        }
      }
    }

    if (!isAlwaysVisibleSession && !matchesTags) {
      continue;
    }

    const score = isAlwaysVisibleSession
      ? 0
      : calculateSessionSearchScore(entry, queryTokens);

    if (!isAlwaysVisibleSession && score < 0) {
      continue;
    }

    entries.push({ ...entry, score });
  }

  entries.sort((left, right) => {
    const leftIsAlwaysVisibleSession = isQuickVoiceSession(left.session);
    const rightIsAlwaysVisibleSession = isQuickVoiceSession(right.session);

    if (leftIsAlwaysVisibleSession !== rightIsAlwaysVisibleSession) {
      return leftIsAlwaysVisibleSession ? -1 : 1;
    }

    const sidebarGroupDelta = compareSessionsBySidebarGroup(
      getSessionSidebarGroup(left.session),
      getSessionSidebarGroup(right.session),
    );

    if (sidebarGroupDelta !== 0) {
      return sidebarGroupDelta;
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
    draftUpdatedAt: timestamp,
    draftAttachmentsUpdatedAt: timestamp,
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
  delete nextSession.timeResetAt;
  delete nextSession.movedToTopAt;
  delete nextSession.goal;

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
    .filter(
      (session) => !selectedSessionIds || selectedSessionIds.has(session.id),
    )
    .map((session) => cloneJson(session));

  return {
    kind: SESSION_EXPORT_KIND,
    version: SESSION_EXPORT_VERSION,
    exportedAt: timestamp,
    ...(state.activeSessionId
      ? { activeSessionId: state.activeSessionId }
      : {}),
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
      typeof candidate.exportedAt === "number"
        ? candidate.exportedAt
        : Date.now(),
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
    throw new Error(
      "Session import file does not contain importable sessions.",
    );
  }

  const normalizedImportState = normalizeShellState({
    ...state,
    activeSessionId:
      payload.activeSessionId ??
      candidateSessions[0].id ??
      state.activeSessionId,
    sessions: candidateSessions,
  });
  const importedSessions = normalizedImportState.sessions
    .filter((session) => !isQuickVoiceSession(session))
    .map((session, index) => {
      const nextSession = createSession({
        ...session,
        id: crypto.randomUUID(),
        createdAt: timestamp + index,
        updatedAt: timestamp + index,
        messages: cloneSessionMessages(session.messages),
      });

      delete nextSession.pinnedAt;
      delete nextSession.timeResetAt;
      delete nextSession.movedToTopAt;
      delete nextSession.goal;

      return nextSession;
    });

  if (importedSessions.length === 0) {
    throw new Error(
      "Session import file does not contain importable sessions.",
    );
  }

  return {
    ...state,
    activeSessionId: importedSessions[0].id,
    sessions: [...importedSessions, ...state.sessions],
  };
};
