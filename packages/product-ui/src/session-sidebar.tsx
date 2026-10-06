import type { ProductSession } from "@machdoch/fleet-protocol";
import {
  Archive,
  Ban,
  Check,
  CircleDashed,
  CircleSlash,
  CircleStop,
  ClockAlert,
  Inbox,
  ListFilter,
  LoaderCircle,
  MessageSquare,
  Pin,
  Plus,
  Search,
  ServerCrash,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState, type ComponentType } from "react";
import { formatRelativeTime } from "./format";
import type { SessionDataSource } from "./session-data";
import { useSessionIndex } from "./use-session-index";
import { SessionArchiveControls } from "./session-archive-controls";
import { useSessionArchive } from "./use-session-archive";
import type {
  SessionSidebarCommandState,
  SessionSidebarStatus,
} from "./session-sidebar-commands-state";
import type { SessionIndexQuery } from "@machdoch/fleet-protocol/session-data";
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

const getSidebarGroup = (session: ProductSession) => ({
  quick: session.specialKind === "quick-voice",
  pinned: session.pinnedAt !== undefined,
});

const sessionScopeFilters = [
  { id: "all", label: "All", icon: Inbox },
  { id: "open", label: "Open", icon: MessageSquare },
  { id: "archived", label: "Archived", icon: Archive },
] as const;

const sessionStatusFilters = [
  { id: "empty", label: "Empty", icon: CircleDashed },
  { id: "unread", label: "Unread", icon: MessageSquare },
  { id: "running", label: "Running", icon: LoaderCircle },
  { id: "done", label: "Done", icon: Check },
  { id: "failed", label: "Failed", icon: XCircle },
  { id: "blocked", label: "Blocked", icon: Ban },
  { id: "cancelled", label: "Cancelled", icon: CircleStop },
  { id: "timed-out", label: "Timed out", icon: ClockAlert },
  { id: "unsupported", label: "Unsupported", icon: CircleSlash },
  { id: "crashed", label: "Crashed", icon: ServerCrash },
] as const;

type SessionScope = (typeof sessionScopeFilters)[number]["id"];

const statusIconById = new Map<string, LucideIcon>(
  sessionStatusFilters.map(({ id, icon }) => [id, icon]),
);

export function SessionSidebar({
  Commands,
  activeSessionId,
  sessions,
  workspace,
  pending,
  onCommand,
  dataSource,
}: {
  Commands?: ComponentType<SessionSidebarCommandState> | undefined;
  activeSessionId: string | undefined;
  sessions: ProductSession[];
  workspace: string | undefined;
  pending: boolean;
  onCommand: ProductCommandHandler;
  dataSource?: SessionDataSource | undefined;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<SessionScope>("all");
  const [selectedStatuses, setSelectedStatuses] = useState<
    SessionIndexQuery["statuses"]
  >([]);
  const [project, setProject] = useState(ALL_SESSION_PROJECTS_FILTER);
  const [tags, setTags] = useState<string[]>([]);
  const remote = useSessionIndex(
    dataSource,
    {
      offset: 0,
      limit: 80,
      query,
      scope,
      statuses: selectedStatuses,
      project,
      tags,
    },
    JSON.stringify(
      sessions.map(
        ({ id, updatedAt, messageCount, unread, archivedAt, pinnedAt }) => [
          id,
          updatedAt,
          messageCount,
          unread,
          archivedAt,
          pinnedAt,
        ],
      ),
    ),
  );
  const queryTokens = useMemo(() => tokenizeSessionSearchQuery(query), [query]);
  const execute: ProductCommandHandler = async (command) => {
    if (pending) return false;
    setError(null);
    const accepted = await onCommand(command);
    if (!accepted)
      setError(
        command.kind === "create-session"
          ? "Session could not be created. Try again."
          : "Session could not be opened. Try again.",
      );
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
    project,
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
    onProjectChange: setProject,
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
        <div>
          <p className="m-product-sidebar-title">Sessions</p>
        </div>
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
      <label className="m-product-search">
        <Search aria-hidden="true" />
        <span className="m-product-visually-hidden">Search sessions</span>
        <input
          value={query}
          placeholder="Search sessions"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {error ? (
        <p className="m-product-inline-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="m-product-session-filter-strip">
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
        <div className="m-product-session-filter-group">
          {sessionScopeFilters.map((filter) => {
            const Icon = filter.icon;
            return (
              <button
                key={filter.id}
                type="button"
                data-active={scope === filter.id}
                aria-label={`Scope: ${filter.label}`}
                aria-pressed={scope === filter.id}
                onClick={() => setScope(filter.id)}
              >
                <Icon aria-hidden="true" />
              </button>
            );
          })}
        </div>
        <div className="m-product-session-filter-divider" />
        <div className="m-product-session-filter-group m-product-session-status-filters">
          <button
            type="button"
            data-active={selectedStatuses.length === 0}
            aria-label="Any status"
            aria-pressed={selectedStatuses.length === 0}
            onClick={() => setSelectedStatuses([])}
          >
            <ListFilter aria-hidden="true" />
          </button>
          {availableStatusFilters.map((filter) => {
            const Icon = filter.icon;
            const active = selectedStatuses.includes(filter.id);
            return (
              <button
                key={filter.id}
                type="button"
                data-active={active}
                aria-label={`Status: ${filter.label}`}
                aria-pressed={active}
                onClick={() => toggleStatus(filter.id)}
              >
                <Icon aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </div>
      {projects.length > 1 || availableTags.length > 0 ? (
        <div className="m-product-session-facets">
          {projects.length > 1 ? (
            <label>
              <span className="m-product-visually-hidden">
                Workspace filter
              </span>
              <select
                value={project}
                onChange={(event) => setProject(event.target.value)}
              >
                <option value={ALL_SESSION_PROJECTS_FILTER}>
                  All workspaces
                </option>
                {projects.map(({ id, label }) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {availableTags.length > 0 ? (
            <label>
              <span className="m-product-visually-hidden">Tag filter</span>
              <select
                value=""
                onChange={(event) => {
                  const tag = event.target.value;
                  if (tag) toggleTag(tag);
                }}
              >
                <option value="">
                  Tags{tags.length ? ` (${tags.length})` : ""}
                </option>
                {availableTags.map((tag) => (
                  <option key={tag} value={tag}>
                    {tags.includes(tag) ? "✓ " : ""}
                    {tag}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}
      <div className="m-product-session-list">
        {filteredSessions.map((session, index) => {
          const StatusIcon = statusIconById.get(session.status) ?? CircleDashed;
          return (
            <button
              key={session.id}
              type="button"
              className="m-product-session-item"
              data-unpinned-divider={index === dividerIndex || undefined}
              data-active={session.id === activeSessionId}
              aria-current={session.id === activeSessionId ? "page" : undefined}
              disabled={pending}
              onClick={() =>
                void execute({
                  kind: "activate-session",
                  sessionId: session.id,
                })
              }
            >
              <span className="m-product-session-title-row">
                <span
                  className="m-product-session-status"
                  data-state={session.status}
                  aria-label={`Status: ${session.status}`}
                >
                  <StatusIcon aria-hidden="true" />
                </span>
                <span className="m-product-session-title">{session.title}</span>
                {session.unread ? (
                  <span
                    className="m-product-session-unread"
                    aria-label="Unread reply"
                  >
                    •
                  </span>
                ) : null}
                {session.pinnedAt !== undefined ? (
                  <Pin aria-label="Pinned" />
                ) : null}
                {session.archivedAt !== undefined ? (
                  <Archive aria-label="Archived" />
                ) : null}
              </span>
              <span className="m-product-session-meta">
                <span>
                  {session.provider || "Provider"} · {session.effectiveMode}
                </span>
                <span>{formatRelativeTime(session.updatedAt)}</span>
              </span>
            </button>
          );
        })}
        {remote.loading ? (
          <LoaderCircle
            className="m-product-spin"
            aria-label="Loading sessions"
          />
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
