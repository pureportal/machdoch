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
import { useMemo, useState } from "react";
import { formatRelativeTime } from "./format";
import type { ProductCommandHandler } from "./product-runtime";

const sessionScopeFilters = [
  { id: "all", label: "All", icon: Inbox },
  { id: "open", label: "Open", icon: MessageSquare },
  { id: "archived", label: "Archived", icon: Archive },
] as const;

const sessionStatusFilters = [
  { id: "empty", label: "Empty", icon: CircleDashed },
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
  activeSessionId,
  sessions,
  workspace,
  onCommand,
}: {
  activeSessionId: string | undefined;
  sessions: ProductSession[];
  workspace: string | undefined;
  onCommand: ProductCommandHandler;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SessionScope>("all");
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>([]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const availableStatusFilters = useMemo(() => {
    const statuses = new Set(sessions.map((session) => session.status));
    return sessionStatusFilters.filter((filter) => statuses.has(filter.id));
  }, [sessions]);
  const filteredSessions = useMemo(
    () =>
      sessions.filter((session) => {
        const archived = session.archivedAt !== undefined;
        if (scope === "open" && archived) return false;
        if (scope === "archived" && !archived) return false;
        if (
          selectedStatuses.length > 0 &&
          !selectedStatuses.includes(session.status)
        ) {
          return false;
        }
        if (!normalizedQuery) return true;
        return [session.title, session.workspace, ...session.tags].some(
          (value) => value?.toLocaleLowerCase().includes(normalizedQuery),
        );
      }),
    [normalizedQuery, scope, selectedStatuses, sessions],
  );

  return (
    <aside className="m-product-sidebar" aria-label="Sessions">
      <div className="m-product-sidebar-header">
        <div>
          <p className="m-product-sidebar-title">Sessions</p>
          <p className="m-product-sidebar-count">
            {sessions.length} saved session{sessions.length === 1 ? "" : "s"}
          </p>
        </div>
        <button
          className="m-product-primary-button"
          type="button"
          onClick={() =>
            void onCommand({
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
      <div className="m-product-session-filter-strip">
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
                onClick={() =>
                  setSelectedStatuses((current) =>
                    current.includes(filter.id)
                      ? current.filter((status) => status !== filter.id)
                      : [...current, filter.id],
                  )
                }
              >
                <Icon aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </div>
      <div className="m-product-session-list">
        {filteredSessions.map((session) => {
          const StatusIcon = statusIconById.get(session.status) ?? CircleDashed;
          return (
            <button
              key={session.id}
              type="button"
              className="m-product-session-item"
              data-active={session.id === activeSessionId}
              onClick={() =>
                void onCommand({
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
        {filteredSessions.length === 0 ? (
          <p className="m-product-empty-small">No sessions</p>
        ) : null}
      </div>
    </aside>
  );
}
