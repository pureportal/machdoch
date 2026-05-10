import {
  Archive,
  Copy,
  Download,
  Pin,
  Plus,
  Search,
  Tag,
  Upload,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from "react";
import {
  canArchiveSession,
  getSessionOverviewStatus,
  getSessionRetentionProgress,
  getSessionTitle,
  isQuickVoiceSession,
  isSessionArchived,
  type ChatSessionRecord,
} from "../../chat-session.model";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { ScrollArea } from "../../components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import {
  type SessionHistoryTagFacet,
} from "../_helpers/session-history-index";
import {
  SESSION_SCOPE_FILTERS,
  SESSION_STATUS_FILTERS,
  SESSION_STATUS_META,
  createSessionSubtitle,
  formatSessionTimestamp,
  type SessionScopeFilter,
  type SessionStatusFilter,
} from "../_helpers/session-shell.ts";

export interface SessionsSidebarProps {
  totalSessions: number;
  activeSessionId: string;
  filteredSessions: ChatSessionRecord[];
  sessionScopeFilter: SessionScopeFilter;
  sessionStatusFilter: SessionStatusFilter;
  sessionSearchQuery: string;
  inactiveSessionArchiveDays: number;
  archivedSessionRetentionDays: number;
  sessionTagFacets: SessionHistoryTagFacet[];
  sessionTagFilters: string[];
  onSessionScopeFilterChange: (filter: SessionScopeFilter) => void;
  onSessionStatusFilterChange: (filter: SessionStatusFilter) => void;
  onSessionSearchQueryChange: (query: string) => void;
  onSessionTagFilterToggle: (tag: string) => void;
  onCreateSession: () => void;
  onActivateSession: (sessionId: string) => void;
  onArchiveSession: (sessionId: string) => void;
  onTogglePinnedSession: (sessionId: string) => void;
  onDuplicateSession: (sessionId: string) => void;
  onExportSessions: () => void;
  onImportSessions: (file: File) => void;
}

const SESSION_TITLE_CLAMP_STYLE: CSSProperties = {
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 2,
  overflow: "hidden",
};

export const SessionsSidebar = ({
  totalSessions,
  activeSessionId,
  filteredSessions,
  sessionScopeFilter,
  sessionStatusFilter,
  sessionSearchQuery,
  inactiveSessionArchiveDays,
  archivedSessionRetentionDays,
  sessionTagFacets,
  sessionTagFilters,
  onSessionScopeFilterChange,
  onSessionStatusFilterChange,
  onSessionSearchQueryChange,
  onSessionTagFilterToggle,
  onCreateSession,
  onActivateSession,
  onArchiveSession,
  onTogglePinnedSession,
  onDuplicateSession,
  onExportSessions,
  onImportSessions,
}: SessionsSidebarProps): JSX.Element => {
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [retentionNow, setRetentionNow] = useState(() => Date.now());
  const sessionListCountLabel =
    filteredSessions.length === totalSessions
      ? `${totalSessions} saved session${totalSessions === 1 ? "" : "s"}`
      : `${filteredSessions.length} of ${totalSessions} saved sessions`;

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setRetentionNow(Date.now());
    }, 60_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  return (
    <aside className="app-sessions-sidebar flex min-h-0 w-84 shrink-0 flex-col border-r border-slate-900 bg-slate-950/50 backdrop-blur-xl">
      <div className="app-sessions-sidebar-header flex h-16 items-center justify-between border-b border-slate-900 px-5">
        <div>
          <p className="text-xs font-semibold tracking-[0.24em] text-slate-500 uppercase">
            Sessions
          </p>
          <p className="mt-1 text-sm text-slate-400">{sessionListCountLabel}</p>
        </div>

        <div className="app-sessions-actions flex items-center gap-1.5">
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];

              if (file) {
                onImportSessions(file);
              }

              event.currentTarget.value = "";
            }}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label="Import sessions"
                onClick={() => importInputRef.current?.click()}
                className="app-sessions-toolbar-button h-8 w-8 rounded-xl text-slate-400 hover:bg-slate-900 hover:text-slate-100"
              >
                <Upload className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Import sessions</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label="Export visible sessions"
                onClick={onExportSessions}
                className="app-sessions-toolbar-button h-8 w-8 rounded-xl text-slate-400 hover:bg-slate-900 hover:text-slate-100"
              >
                <Download className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Export visible sessions</TooltipContent>
          </Tooltip>
          <Button
            type="button"
            size="sm"
            onClick={onCreateSession}
            className="app-sessions-new-button rounded-xl bg-sky-600 text-white hover:bg-sky-500"
          >
            <Plus className="h-4 w-4" />
            New
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1" type="always">
        <div className="app-sessions-scroll-content grid gap-4 px-5 py-5 pr-6">
          <div className="app-sessions-filter-stack grid gap-3">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <Input
                value={sessionSearchQuery}
                aria-label="Search sessions"
                placeholder="Search sessions"
                onChange={(event) =>
                  onSessionSearchQueryChange(event.target.value)
                }
                className="app-sessions-filter-input h-9 rounded-xl border-slate-800 bg-slate-950/80 pl-9 text-sm text-slate-100 placeholder:text-slate-600"
              />
            </div>

            {sessionTagFacets.length > 0 ? (
              <div className="app-sessions-tag-list flex flex-wrap gap-1.5">
                {sessionTagFacets.slice(0, 10).map((tag) => {
                  const selected = sessionTagFilters.some(
                    (entry) => entry.toLowerCase() === tag.label.toLowerCase(),
                  );

                  return (
                    <Button
                      key={tag.label}
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`Tag: ${tag.label}`}
                      aria-pressed={selected}
                      onClick={() => onSessionTagFilterToggle(tag.label)}
                      className={cn(
                        "app-sidebar-tag-button h-7 max-w-full rounded-full border border-slate-800 bg-slate-950/70 px-2 text-[11px] text-slate-400 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
                        selected &&
                          "border-emerald-500/30 bg-emerald-500/10 text-emerald-100",
                      )}
                    >
                      <Tag className="mr-1 h-3 w-3 shrink-0" />
                      <span className="truncate">{tag.label}</span>
                    </Button>
                  );
                })}
              </div>
            ) : null}
          </div>

          <div className="app-session-filter-strip flex h-9 items-center justify-between rounded-xl border border-slate-800/80 bg-slate-950/70 p-1">
            <div className="flex items-center gap-0.5">
              {SESSION_SCOPE_FILTERS.map((filter) => {
                const FilterIcon = filter.icon;
                const isSelected = sessionScopeFilter === filter.id;

                return (
                  <Tooltip key={filter.id}>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label={`Scope: ${filter.label}`}
                        aria-pressed={isSelected}
                        onClick={() => onSessionScopeFilterChange(filter.id)}
                        className={cn(
                          "app-session-filter-button h-7 w-7 rounded-lg border border-transparent text-slate-400 shadow-none hover:bg-slate-900 hover:text-slate-100",
                          isSelected &&
                            "border-sky-500/30 bg-sky-500/10 text-sky-100 hover:bg-sky-500/15 hover:text-white",
                        )}
                      >
                        <FilterIcon className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {`Scope: ${filter.label}`}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>

            <div className="mx-1 h-4 w-px shrink-0 bg-slate-800" />

            <div className="flex items-center gap-0.5">
              {SESSION_STATUS_FILTERS.map((filter) => {
                const FilterIcon = filter.icon;
                const isSelected = sessionStatusFilter === filter.id;

                return (
                  <Tooltip key={filter.id}>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label={`Status: ${filter.label}`}
                        aria-pressed={isSelected}
                        onClick={() => onSessionStatusFilterChange(filter.id)}
                        className={cn(
                          "app-session-filter-button h-7 w-7 rounded-lg border border-transparent text-slate-400 shadow-none hover:bg-slate-900 hover:text-slate-100",
                          isSelected &&
                            "border-sky-500/30 bg-sky-500/10 text-sky-100 hover:bg-sky-500/15 hover:text-white",
                        )}
                      >
                        <FilterIcon className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {`Status: ${filter.label}`}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </div>

          {filteredSessions.length === 0 ? (
            <div className="app-sessions-empty rounded-2xl border border-dashed border-slate-800 bg-slate-950/60 px-4 py-6 text-center text-sm leading-6 text-slate-500">
              No sessions match the current filters.
            </div>
          ) : (
            filteredSessions.map((session) => {
              const isActive = session.id === activeSessionId;
              const archived = isSessionArchived(session);
              const sessionStatus = getSessionOverviewStatus(session);
              const statusMeta = SESSION_STATUS_META[sessionStatus];
              const SessionStatusIcon = statusMeta.icon;
              const showArchiveAction = canArchiveSession(session);
              const isQuickSession = isQuickVoiceSession(session);
              const isPinned =
                isQuickSession || typeof session.pinnedAt === "number";
              const retentionProgress = getSessionRetentionProgress(
                session,
                {
                  inactiveSessionArchiveDays,
                  archivedSessionRetentionDays,
                },
                retentionNow,
              );

              return (
                <div
                  key={session.id}
                  className={cn(
                    "app-session-card group flex items-start gap-2 rounded-xl border px-3 py-2.5 transition-all",
                    isActive
                      ? "border-sky-500/30 bg-sky-500/10 shadow-lg shadow-sky-950/20"
                      : "border-slate-800 bg-slate-950/70 hover:border-slate-700 hover:bg-slate-950",
                    archived &&
                      (isActive ? "border-dashed" : "border-dashed opacity-80"),
                  )}
                >
                  <button
                    type="button"
                    aria-label={`Open session ${getSessionTitle(session)}`}
                    onClick={() => onActivateSession(session.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex w-full min-w-0 items-start gap-2">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div
                            aria-label={`Session status: ${statusMeta.label}`}
                            className={cn(
                              "app-session-status-icon flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
                              statusMeta.containerClassName,
                            )}
                          >
                            <SessionStatusIcon
                              className={cn("h-3 w-3", statusMeta.iconClassName)}
                            />
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          {statusMeta.label}
                        </TooltipContent>
                      </Tooltip>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-start gap-1.5">
                          {isPinned ? (
                            <Pin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
                          ) : null}
                          <p
                            style={SESSION_TITLE_CLAMP_STYLE}
                            className={cn(
                              "app-session-title wrap-break-word text-sm font-semibold leading-5 placeholder:text-slate-500",
                              archived ? "text-slate-300" : "text-slate-100",
                            )}
                          >
                            {getSessionTitle(session)}
                          </p>
                        </div>
                        {session.tags.length > 0 ? (
                          <div className="app-session-tags mt-1 flex flex-wrap gap-1">
                            {session.tags.slice(0, 3).map((tag) => (
                              <span
                                key={tag}
                                className="app-session-tag-chip max-w-24 truncate rounded-full border border-slate-800 bg-slate-950 px-1.5 py-0.5 text-[10px] font-medium text-slate-500"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <div className="app-session-meta mt-1 flex w-full min-w-0 items-center justify-between gap-2 text-[10px] font-medium tracking-wide text-slate-500 uppercase">
                      <span className="min-w-0 flex-1 truncate">
                        {createSessionSubtitle(session)}
                      </span>
                      <span className="shrink-0">
                        {formatSessionTimestamp(session.updatedAt)}
                      </span>
                    </div>
                    {retentionProgress ? (
                      <div
                        aria-label={`${
                          retentionProgress.phase === "archive"
                            ? "Auto-archive"
                            : "Auto-delete"
                        } progress for ${getSessionTitle(session)}`}
                        className="mt-2 h-1 overflow-hidden rounded-full bg-slate-800/80"
                      >
                        <div
                          className={cn(
                            "h-full rounded-full transition-[width] duration-500",
                            retentionProgress.phase === "archive"
                              ? "bg-sky-400"
                              : "bg-rose-400",
                          )}
                          style={{
                            width: `${Math.round(
                              retentionProgress.progress * 100,
                            )}%`,
                          }}
                        />
                      </div>
                    ) : null}
                  </button>

                  <div className="app-session-card-actions flex shrink-0 items-start gap-1 self-start pt-0.5">
                    {!isQuickSession ? (
                      <div
                        className={cn(
                          "app-session-card-action-slot overflow-hidden transition-[width,opacity] duration-150 ease-out",
                          isActive || isPinned
                            ? "w-8 opacity-100"
                            : "w-0 opacity-0 group-hover:w-8 group-hover:opacity-100 group-focus-within:w-8 group-focus-within:opacity-100",
                        )}
                      >
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              aria-label={`${isPinned ? "Unpin" : "Pin"} ${getSessionTitle(session)}`}
                              aria-pressed={isPinned}
                              onClick={() => onTogglePinnedSession(session.id)}
                              className={cn(
                                "app-session-card-action-button h-8 w-8 rounded-full border border-slate-800 bg-slate-950/80 text-slate-500 transition-all hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
                                isPinned &&
                                  "border-amber-500/30 bg-amber-500/10 text-amber-200",
                              )}
                            >
                              <Pin className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            {isPinned ? "Unpin" : "Pin"}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    ) : null}

                    {!isQuickSession ? (
                      <div
                        className={cn(
                          "app-session-card-action-slot overflow-hidden transition-[width,opacity] duration-150 ease-out",
                          isActive
                            ? "w-8 opacity-100"
                            : "w-0 opacity-0 group-hover:w-8 group-hover:opacity-100 group-focus-within:w-8 group-focus-within:opacity-100",
                        )}
                      >
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              aria-label={`Duplicate ${getSessionTitle(session)}`}
                              onClick={() => onDuplicateSession(session.id)}
                              className="app-session-card-action-button h-8 w-8 rounded-full border border-slate-800 bg-slate-950/80 text-slate-500 transition-all hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100"
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top">Duplicate</TooltipContent>
                        </Tooltip>
                      </div>
                    ) : null}

                    {archived ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div
                            aria-label="Archived session"
                            className="app-session-card-action-button flex h-8 w-8 items-center justify-center rounded-full border border-slate-800 bg-slate-950/80 text-slate-500"
                          >
                            <Archive className="h-3.5 w-3.5" />
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="top">Archived</TooltipContent>
                      </Tooltip>
                    ) : null}

                    {showArchiveAction ? (
                      <div
                        className={cn(
                          "app-session-card-action-slot overflow-hidden transition-[width,opacity] duration-150 ease-out",
                          isActive
                            ? "w-8 opacity-100"
                            : "w-0 opacity-0 group-hover:w-8 group-hover:opacity-100 group-focus-within:w-8 group-focus-within:opacity-100",
                        )}
                      >
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              aria-label={`Archive ${getSessionTitle(session)}`}
                              onClick={() => onArchiveSession(session.id)}
                              className="app-session-card-action-button h-8 w-8 rounded-full border border-slate-800 bg-slate-950/80 text-slate-500 transition-all hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100"
                            >
                              <Archive className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top">Archive</TooltipContent>
                        </Tooltip>
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>
    </aside>
  );
};
