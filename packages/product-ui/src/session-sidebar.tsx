import type { ProductCommand, ProductSession } from "@machdoch/fleet-protocol";
import { LoaderCircle, Plus, Search } from "lucide-react";
import { useMemo, useState, type ComponentType } from "react";
import type { SessionDataSource } from "./session-data";
import type { useSessionSidebarIndex } from "./use-session-sidebar-index";
import { SessionArchiveControls } from "./session-archive-controls";
import { useSessionArchive } from "./use-session-archive";
import type {
  SessionSidebarCommandState,
  SessionSidebarStatus,
} from "./session-sidebar-commands-state";
import type { ProductCommandHandler } from "./product-runtime";
import {
  ALL_SESSION_PROJECTS_FILTER,
  calculateSessionSearchScore,
  compareSessionsBySidebarGroup,
  getSessionProjectId,
  getUnpinnedSessionDividerIndex,
  normalizeSessionSearchText,
  tokenizeSessionSearchQuery,
} from "./session-sidebar-model";
import {
  SessionFilterMenus,
  SessionTagFilters,
  sessionScopeFilters,
  sessionStatusFilters,
} from "./session-sidebar-filters";
import { SessionSidebarRow } from "./session-sidebar-row";

const getSidebarGroup = (session: ProductSession) => ({
  quick: session.specialKind === "quick-voice",
  pinned: session.pinnedAt !== undefined,
});

const commandFailureMessage = (command: ProductCommand): string =>
  command.kind === "create-session"
    ? "Session could not be created. Try again."
    : command.kind === "activate-session"
      ? "Session could not be opened. Try again."
      : "Session could not be updated. Try again.";

export function SessionSidebar({
  Commands,
  activeSessionId,
  sessions,
  workspace,
  pending,
  onCommand,
  dataSource,
  index,
}: {
  Commands?: ComponentType<SessionSidebarCommandState> | undefined;
  activeSessionId: string | undefined;
  sessions: ProductSession[];
  workspace: string | undefined;
  pending: boolean;
  onCommand: ProductCommandHandler;
  dataSource?: SessionDataSource | undefined;
  index: ReturnType<typeof useSessionSidebarIndex>;
}): React.ReactElement {
  const [error, setError] = useState<string | null>(null);
  const {
    query,
    setQuery,
    scope,
    setScope,
    selectedStatuses,
    setSelectedStatuses,
    project,
    setProject,
    tags,
    setTags,
    remote,
  } = index;
  const queryTokens = useMemo(() => tokenizeSessionSearchQuery(query), [query]);
  const execute: ProductCommandHandler = async (command) => {
    if (pending) return false;
    setError(null);
    const accepted = await onCommand(command);
    if (!accepted) setError(commandFailureMessage(command));
    return accepted;
  };
  const availableStatusFilters = useMemo(() => {
    if (dataSource)
      return sessionStatusFilters.filter((filter) =>
        remote.page?.statuses.includes(filter.id),
      );
    const statuses = new Set(sessions.map((session) => session.status));
    if (sessions.some((session) => session.unread !== undefined))
      statuses.add("unread");
    return sessionStatusFilters.filter((filter) => statuses.has(filter.id));
  }, [sessions, dataSource, remote.page?.statuses]);
  const localProjects = useMemo(() => {
    const workspaces = new Map(
      sessions.map((session) => [
        getSessionProjectId(session.workspace),
        session.workspace,
      ]),
    );
    return [...workspaces].map(([id, path]) => ({
      id,
      label: path?.split(/[\\/]/u).filter(Boolean).at(-1) ?? "No workspace",
    }));
  }, [sessions]);
  const localTags = useMemo(
    () =>
      [...new Set(sessions.flatMap((session) => session.tags))].sort(
        (left, right) => left.localeCompare(right),
      ),
    [sessions],
  );
  const localFilteredSessions = useMemo(
    () =>
      sessions
        .flatMap((session) => {
          if (getSidebarGroup(session).quick) return [{ session, score: 0 }];
          const archived = session.archivedAt !== undefined;
          if (scope === "open" && archived) return [];
          if (scope === "archived" && !archived) return [];
          if (
            selectedStatuses.length > 0 &&
            !selectedStatuses.some((status) =>
              status === "unread" ? session.unread : status === session.status,
            )
          ) {
            return [];
          }
          if (
            project !== ALL_SESSION_PROJECTS_FILTER &&
            getSessionProjectId(session.workspace) !== project
          )
            return [];
          const keys = new Set(session.tags.map((tag) => tag.toLowerCase()));
          if (tags.some((tag) => !keys.has(tag.toLowerCase()))) return [];
          const score = calculateSessionSearchScore(
            {
              searchText: normalizeSessionSearchText(
                [session.title, session.workspace, ...session.tags].join(" "),
              ),
              titleSearchText: normalizeSessionSearchText(session.title),
              tagSearchText: normalizeSessionSearchText(session.tags.join(" ")),
              projectSearchText: normalizeSessionSearchText(
                session.workspace?.split(/[\\/]/u).at(-1) ?? "",
              ),
            },
            queryTokens,
          );
          return score < 0 ? [] : [{ session, score }];
        })
        .sort((left, right) => {
          const a = getSidebarGroup(left.session);
          const b = getSidebarGroup(right.session);
          if (a.quick !== b.quick) return a.quick ? -1 : 1;
          return (
            compareSessionsBySidebarGroup(a, b) || right.score - left.score
          );
        })
        .map(({ session }) => session),
    [queryTokens, scope, selectedStatuses, sessions, project, tags],
  );
  const projects = dataSource ? (remote.page?.projects ?? []) : localProjects;
  const availableTags = dataSource
    ? (remote.page?.tags.map(({ label }) => label) ?? [])
    : localTags;
  const filteredSessions = dataSource
    ? (remote.page?.sessions ?? [])
    : localFilteredSessions;
  const archive = useSessionArchive({
    source: dataSource,
    sessionIds: remote.page?.sessionIds ?? [],
    disabled: pending || (remote.loading && !remote.page),
    onImported: remote.reload,
  });
  const toggleTag = (tag: string): void =>
    setTags((current) =>
      current.some((value) => value.toLowerCase() === tag.toLowerCase())
        ? current.filter((value) => value.toLowerCase() !== tag.toLowerCase())
        : [...current, tag],
    );
  const toggleStatus = (status: SessionSidebarStatus): void =>
    setSelectedStatuses((current) =>
      status === "any"
        ? []
        : current.includes(status)
          ? current.filter((value) => value !== status)
          : [...current, status],
    );
  const commandState: SessionSidebarCommandState = {
    disabled: pending || archive.disabled,
    sessions: filteredSessions.map((session) => ({
      id: session.id,
      title: session.title,
      workspace: session.workspace,
      tags: session.tags,
      pinned: session.pinnedAt !== undefined,
      actions: {
        pin: session.canPin,
        duplicate: session.canDuplicate,
        archive: session.canArchive,
        delete: session.status === "empty" && session.canDelete,
      },
    })),
    scope,
    scopeOptions: sessionScopeFilters,
    statuses: selectedStatuses.length ? selectedStatuses : ["any"],
    statusOptions: [
      { id: "any", label: "Any status" },
      ...sessionStatusFilters,
    ],
    projectFilter: {
      mode: "include",
      projectIds: project === ALL_SESSION_PROJECTS_FILTER ? [] : [project],
    },
    projects,
    tags,
    availableTags,
    ...(dataSource
      ? {
          importSessions: archive.requestImport,
          ...(archive.canExport
            ? { exportSessions: archive.exportSessions }
            : {}),
        }
      : {}),
    onScopeChange: setScope,
    onStatusToggle: toggleStatus,
    onProjectToggle: (projectId) =>
      setProject((current) =>
        projectId === current ? ALL_SESSION_PROJECTS_FILTER : projectId,
      ),
    onTagToggle: toggleTag,
    onSessionAction: async (action, sessionId) => {
      await execute({
        kind:
          action === "pin"
            ? "pin-session"
            : action === "duplicate"
              ? "duplicate-session"
              : action === "archive"
                ? "archive-session"
                : "delete-session",
        sessionId,
      });
    },
  };
  const dividerIndex = getUnpinnedSessionDividerIndex(
    filteredSessions,
    getSidebarGroup,
  );

  return (
    <aside className="m-product-sidebar" aria-label="Sessions">
      {Commands ? <Commands {...commandState} /> : null}
      <div className="m-product-sidebar-header">
        <p className="m-product-sidebar-title">Sessions</p>
        <div className="m-product-sidebar-actions">
          {dataSource ? <SessionArchiveControls controller={archive} /> : null}
          <button
            className="m-product-primary-button"
            type="button"
            disabled={pending}
            onClick={() =>
              void execute({
                kind: "create-session",
                ...(workspace ? { workspace } : {}),
              })
            }
          >
            <Plus aria-hidden="true" />
            New
          </button>
        </div>
      </div>
      <label className="m-product-search">
        <Search aria-hidden="true" />
        <span className="m-product-visually-hidden">Search sessions</span>
        <input
          value={query}
          placeholder="Search sessions"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="m-product-session-filters">
        {error ? (
          <p className="m-product-inline-error" role="alert">
            {error}
          </p>
        ) : null}
        {remote.error ? (
          <div className="m-product-inline-error" role="alert">
            {remote.error}
            <button
              type="button"
              className="m-product-secondary-button"
              onClick={() => void remote.reload()}
            >
              Retry
            </button>
          </div>
        ) : null}
        {projects.length > 1 ? (
          <label>
            <span className="m-product-visually-hidden">Workspace filter</span>
            <select
              className="m-product-session-filter-select"
              data-active={project !== ALL_SESSION_PROJECTS_FILTER}
              value={project}
              onChange={(event) => setProject(event.target.value)}
            >
              <option value={ALL_SESSION_PROJECTS_FILTER}>All workspaces</option>
              {projects.map(({ id, label }) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {availableTags.length > 0 ? (
          <SessionTagFilters
            tags={availableTags}
            selected={tags}
            onToggle={toggleTag}
          />
        ) : null}
        <SessionFilterMenus
          scope={scope}
          statuses={selectedStatuses}
          availableStatuses={availableStatusFilters}
          onScopeChange={setScope}
          onStatusToggle={toggleStatus}
        />
      </div>
      <div className="m-product-session-list">
        {filteredSessions.map((session, index) => (
          <SessionSidebarRow
            key={session.id}
            session={session}
            active={session.id === activeSessionId}
            firstUnpinned={index === dividerIndex}
            pending={pending}
            onCommand={(command) => void execute(command)}
          />
        ))}
        {remote.loading && !remote.page ? (
          <div role="status" aria-label="Loading sessions">
            <LoaderCircle className="m-product-spin" aria-hidden="true" />
          </div>
        ) : null}
        {dataSource && remote.page?.nextOffset !== null && remote.page ? (
          <button
            type="button"
            className="m-product-secondary-button"
            disabled={remote.loading}
            onClick={() => void remote.loadEarlier()}
          >
            Load more sessions
          </button>
        ) : null}
        {filteredSessions.length === 0 && !remote.loading && !remote.error ? (
          <div className="m-product-empty-small">
            <p role="status">
              {sessions.length ? "No matching sessions" : "No sessions"}
            </p>
            {query ||
            scope !== "all" ||
            selectedStatuses.length ||
            tags.length ||
            project !== ALL_SESSION_PROJECTS_FILTER ? (
              <button
                type="button"
                className="m-product-secondary-button"
                onClick={() => {
                  setQuery("");
                  setScope("all");
                  setSelectedStatuses([]);
                  setTags([]);
                  setProject(ALL_SESSION_PROJECTS_FILTER);
                }}
              >
                Clear filters
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
