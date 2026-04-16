import { Archive, Plus } from "lucide-react";
import type { JSX } from "react";
import {
  canArchiveSession,
  getSessionOverviewStatus,
  getSessionTitle,
  isSessionArchived,
  type ChatSessionRecord,
} from "../../chat-session.model";
import {
  SESSION_SCOPE_FILTERS,
  SESSION_STATUS_FILTERS,
  SESSION_STATUS_META,
  createSessionSubtitle,
  formatSessionTimestamp,
  type SessionScopeFilter,
  type SessionStatusFilter,
} from "../_helpers/session-shell.ts";
import { Button } from "../../components/ui/button";
import { ScrollArea } from "../../components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";

export interface SessionsSidebarProps {
  totalSessions: number;
  activeSessionId: string;
  filteredSessions: ChatSessionRecord[];
  sessionScopeFilter: SessionScopeFilter;
  sessionStatusFilter: SessionStatusFilter;
  onSessionScopeFilterChange: (filter: SessionScopeFilter) => void;
  onSessionStatusFilterChange: (filter: SessionStatusFilter) => void;
  onCreateSession: () => void;
  onActivateSession: (sessionId: string) => void;
  onArchiveSession: (sessionId: string) => void;
}

export const SessionsSidebar = ({
  totalSessions,
  activeSessionId,
  filteredSessions,
  sessionScopeFilter,
  sessionStatusFilter,
  onSessionScopeFilterChange,
  onSessionStatusFilterChange,
  onCreateSession,
  onActivateSession,
  onArchiveSession,
}: SessionsSidebarProps): JSX.Element => {
  const sessionListCountLabel =
    filteredSessions.length === totalSessions
      ? `${totalSessions} saved session${totalSessions === 1 ? "" : "s"}`
      : `${filteredSessions.length} of ${totalSessions} saved sessions`;

  return (
    <aside className="flex min-h-0 w-84 flex-col border-r border-slate-900 bg-slate-950/50 backdrop-blur-xl">
      <div className="flex h-16 items-center justify-between border-b border-slate-900 px-5">
        <div>
          <p className="text-xs font-semibold tracking-[0.24em] text-slate-500 uppercase">
            Sessions
          </p>
          <p className="mt-1 text-sm text-slate-400">{sessionListCountLabel}</p>
        </div>

        <Button
          type="button"
          size="sm"
          onClick={onCreateSession}
          className="rounded-xl bg-sky-600 text-white hover:bg-sky-500"
        >
          <Plus className="h-4 w-4" />
          New
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1" type="always">
        <div className="space-y-4 px-5 py-5 pr-7">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-full border border-slate-800/80 bg-slate-950/70 p-1">
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
                          "h-8 w-8 rounded-full border border-transparent text-slate-400 shadow-none hover:bg-slate-900 hover:text-slate-100",
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

            <div className="flex items-center gap-1.5 rounded-full border border-slate-800/80 bg-slate-950/70 p-1">
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
                          "h-8 w-8 rounded-full border border-transparent text-slate-400 shadow-none hover:bg-slate-900 hover:text-slate-100",
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
            <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-950/60 px-4 py-6 text-center text-sm leading-6 text-slate-500">
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

              return (
                <div
                  key={session.id}
                  className={cn(
                    "group flex items-start gap-2 rounded-xl border px-3 py-2.5 transition-all",
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
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p
                          className={cn(
                            "truncate text-sm font-semibold placeholder:text-slate-500",
                            archived ? "text-slate-300" : "text-slate-100",
                          )}
                        >
                          {getSessionTitle(session)}
                        </p>
                      </div>
                    </div>

                    <div className="mt-1 flex items-center justify-between text-[10px] font-medium tracking-wide text-slate-500 uppercase">
                      <span className="mr-2 truncate">
                        {createSessionSubtitle(session)}
                      </span>
                      <span className="shrink-0">
                        {formatSessionTimestamp(session.updatedAt)}
                      </span>
                    </div>
                  </button>

                  <div className="flex shrink-0 items-center gap-1 self-start pt-0.5">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div
                          aria-label={`Session status: ${statusMeta.label}`}
                          className={cn(
                            "flex h-8 w-8 items-center justify-center rounded-full border",
                            statusMeta.containerClassName,
                          )}
                        >
                          <SessionStatusIcon
                            className={cn(
                              "h-4 w-4",
                              statusMeta.iconClassName,
                            )}
                          />
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        {statusMeta.label}
                      </TooltipContent>
                    </Tooltip>

                    {archived ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div
                            aria-label="Archived session"
                            className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-800 bg-slate-950/80 text-slate-500"
                          >
                            <Archive className="h-3.5 w-3.5" />
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="top">Archived</TooltipContent>
                      </Tooltip>
                    ) : null}

                    {showArchiveAction ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            aria-label={`Archive ${getSessionTitle(session)}`}
                            onClick={() => onArchiveSession(session.id)}
                            className={cn(
                              "h-8 w-8 rounded-full border border-slate-800 bg-slate-950/80 text-slate-500 transition-all hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
                              isActive
                                ? "opacity-100"
                                : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
                            )}
                          >
                            <Archive className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top">Archive</TooltipContent>
                      </Tooltip>
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
