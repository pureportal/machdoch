import {
  Archive,
  ChevronDown,
  Copy,
  Download,
  Ellipsis,
  Folder,
  Pin,
  Plus,
  Search,
  Tag,
  Upload,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  Fragment,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
  type ReactPortal,
} from "react";
import { createPortal } from "react-dom";

const INITIAL_RENDERED_SESSION_LIMIT = 100;
const RENDERED_SESSION_PAGE_SIZE = 100;
import {
  canArchiveSession,
  canDuplicateSession,
  canPinSession,
  getLatestSessionUserRequestAt,
  getSessionOverviewStatus,
  getSessionRetentionProgress,
  getSessionTitle,
  hasUnreadCompletedSessionResponse,
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
  ALL_SESSION_PROJECTS_FILTER,
  type SessionHistoryProjectFacet,
  type SessionHistoryTagFacet,
} from "../_helpers/session-history-index";
import {
  SESSION_SCOPE_FILTERS,
  SESSION_STATUS_FILTERS,
  SESSION_STATUS_META,
  createSessionSubtitle,
  formatSessionTimestamp,
  isConcreteSessionStatusFilter,
  normalizeSessionStatusFilterSelection,
  type SessionScopeFilter,
  type SessionStatusFilter,
  type SessionStatusFilterSelection,
} from "../_helpers/session-shell.ts";

const SESSION_CONTEXT_MENU_WIDTH = 192;
const SESSION_CONTEXT_MENU_HEIGHT = 144;
const SESSION_CONTEXT_MENU_MARGIN = 8;

interface SessionActionItem {
  id: "pin" | "duplicate" | "archive";
  label: string;
  icon: LucideIcon;
  iconClassName: string;
  onSelect: () => void;
}

interface SessionContextMenuState {
  sessionId: string;
  left: number;
  top: number;
}

const createSessionProjectOptionLabel = (
  project: SessionHistoryProjectFacet,
): string => {
  return `${project.label} (${project.count})`;
};

const clampMenuCoordinate = (
  coordinate: number,
  menuSize: number,
  viewportSize: number,
): number => {
  const maxCoordinate = Math.max(
    SESSION_CONTEXT_MENU_MARGIN,
    viewportSize - menuSize - SESSION_CONTEXT_MENU_MARGIN,
  );

  return Math.min(Math.max(coordinate, SESSION_CONTEXT_MENU_MARGIN), maxCoordinate);
};

const createSessionContextMenuPosition = (
  event: MouseEvent<HTMLElement>,
): { left: number; top: number } => {
  if (typeof window === "undefined") {
    return {
      left: event.clientX,
      top: event.clientY,
    };
  }

  return {
    left: clampMenuCoordinate(
      event.clientX,
      SESSION_CONTEXT_MENU_WIDTH,
      window.innerWidth,
    ),
    top: clampMenuCoordinate(
      event.clientY,
      SESSION_CONTEXT_MENU_HEIGHT,
      window.innerHeight,
    ),
  };
};

const createSessionDropdownMenuPosition = (
  trigger: HTMLElement,
): { left: number; top: number } => {
  const triggerRect = trigger.getBoundingClientRect();
  const cardRect =
    trigger.closest<HTMLElement>(".app-session-card")?.getBoundingClientRect() ??
    null;
  const horizontalAnchor =
    cardRect && (cardRect.width > 0 || cardRect.height > 0)
      ? cardRect
      : triggerRect;
  const left = horizontalAnchor.right - SESSION_CONTEXT_MENU_WIDTH;
  const preferredTop = triggerRect.bottom + 4;
  const fallbackTop = triggerRect.top - SESSION_CONTEXT_MENU_HEIGHT - 4;

  if (typeof window === "undefined") {
    return { left, top: preferredTop };
  }

  const hasBottomRoom =
    preferredTop + SESSION_CONTEXT_MENU_HEIGHT + SESSION_CONTEXT_MENU_MARGIN <=
    window.innerHeight;

  return {
    left: clampMenuCoordinate(
      left,
      SESSION_CONTEXT_MENU_WIDTH,
      window.innerWidth,
    ),
    top: clampMenuCoordinate(
      hasBottomRoom ? preferredTop : fallbackTop,
      SESSION_CONTEXT_MENU_HEIGHT,
      window.innerHeight,
    ),
  };
};

const isSessionPinnedInSidebar = (session: ChatSessionRecord): boolean => {
  return isQuickVoiceSession(session) || typeof session.pinnedAt === "number";
};

const createSessionActionItems = ({
  sessionId,
  canDuplicate,
  canPin,
  isPinned,
  isQuickSession,
  showArchiveAction,
  onArchiveSession,
  onDuplicateSession,
  onTogglePinnedSession,
}: {
  sessionId: string;
  canDuplicate: boolean;
  canPin: boolean;
  isPinned: boolean;
  isQuickSession: boolean;
  showArchiveAction: boolean;
  onArchiveSession: (sessionId: string) => void;
  onDuplicateSession: (sessionId: string) => void;
  onTogglePinnedSession: (sessionId: string) => void;
}): SessionActionItem[] => {
  if (isQuickSession) {
    return [];
  }

  const items: SessionActionItem[] = [];

  if (canPin) {
    items.push({
      id: "pin",
      label: isPinned ? "Unpin" : "Pin",
      icon: Pin,
      iconClassName: isPinned ? "text-amber-300" : "text-slate-400",
      onSelect: () => onTogglePinnedSession(sessionId),
    });
  }

  if (canDuplicate) {
    items.push({
      id: "duplicate",
      label: "Duplicate",
      icon: Copy,
      iconClassName: "text-slate-400",
      onSelect: () => onDuplicateSession(sessionId),
    });
  }

  if (showArchiveAction) {
    items.push({
      id: "archive",
      label: "Archive",
      icon: Archive,
      iconClassName: "text-slate-400",
      onSelect: () => onArchiveSession(sessionId),
    });
  }

  return items;
};

const SessionContextActionMenu = ({
  actions,
  left,
  onClose,
  title,
  top,
}: {
  actions: SessionActionItem[];
  left: number;
  onClose: () => void;
  title: string;
  top: number;
}): JSX.Element | ReactPortal => {
  const menu = (
    <div
      role="menu"
      aria-label={`Session actions for ${title}`}
      className="app-session-context-menu fixed z-[140] w-[192px] rounded-lg border border-slate-700 bg-slate-950 p-1.5 text-slate-100 shadow-2xl shadow-black/45"
      style={{ left, top }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="min-w-0 px-2 pb-1 pt-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
        <span className="block truncate">{title}</span>
      </div>
      {actions.map((action) => {
        const ActionIcon = action.icon;

        return (
          <button
            key={action.id}
            type="button"
            role="menuitem"
            onClick={() => {
              action.onSelect();
              onClose();
            }}
            className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs font-medium text-slate-200 outline-none hover:bg-slate-800 focus:bg-slate-800"
          >
            <ActionIcon
              className={cn("h-3.5 w-3.5 shrink-0", action.iconClassName)}
            />
            <span className="min-w-0 flex-1 truncate">{action.label}</span>
          </button>
        );
      })}
    </div>
  );

  return typeof document === "undefined" ? menu : createPortal(menu, document.body);
};

export interface SessionsSidebarProps {
  totalSessions: number;
  activeSessionId: string;
  filteredSessions: ChatSessionRecord[];
  sessionScopeFilter: SessionScopeFilter;
  sessionStatusFilters: SessionStatusFilterSelection;
  sessionSearchQuery: string;
  sessionProjectFilter: string;
  inactiveSessionArchiveDays: number;
  archivedSessionRetentionDays: number;
  sessionProjectFacets: SessionHistoryProjectFacet[];
  sessionTagFacets: SessionHistoryTagFacet[];
  sessionTagFilters: string[];
  onSessionScopeFilterChange: (filter: SessionScopeFilter) => void;
  onSessionStatusFiltersChange: (filters: SessionStatusFilterSelection) => void;
  onSessionSearchQueryChange: (query: string) => void;
  onSessionProjectFilterChange: (filter: string) => void;
  onSessionTagFilterToggle: (tag: string) => void;
  onCreateSession: () => void;
  onActivateSession: (sessionId: string) => void;
  onArchiveSession: (sessionId: string) => void;
  onTogglePinnedSession: (sessionId: string) => void;
  onDuplicateSession: (sessionId: string) => void;
  onExportSessions: () => void;
  onImportSessions: (file: File) => void;
}

export const SessionsSidebar = ({
  totalSessions,
  activeSessionId,
  filteredSessions,
  sessionScopeFilter,
  sessionStatusFilters,
  sessionSearchQuery,
  sessionProjectFilter,
  inactiveSessionArchiveDays,
  archivedSessionRetentionDays,
  sessionProjectFacets,
  sessionTagFacets,
  sessionTagFilters,
  onSessionScopeFilterChange,
  onSessionStatusFiltersChange,
  onSessionSearchQueryChange,
  onSessionProjectFilterChange,
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
  const [sessionContextMenu, setSessionContextMenu] =
    useState<SessionContextMenuState | null>(null);
  const [renderedSessionLimit, setRenderedSessionLimit] = useState(
    INITIAL_RENDERED_SESSION_LIMIT,
  );
  const renderedSessions = filteredSessions.slice(0, renderedSessionLimit);
  const sessionListCountLabel =
    filteredSessions.length === totalSessions
      ? `${totalSessions} saved session${totalSessions === 1 ? "" : "s"}`
      : `${filteredSessions.length} of ${totalSessions} saved sessions`;
  const pinnedSessionCount = renderedSessions.filter(isSessionPinnedInSidebar)
    .length;
  const showPinnedSeparator =
    pinnedSessionCount > 0 && pinnedSessionCount < renderedSessions.length;
  const showSessionProjectFilter = sessionProjectFacets.length > 1;

  useEffect(() => {
    setRenderedSessionLimit(INITIAL_RENDERED_SESSION_LIMIT);
  }, [
    sessionProjectFilter,
    sessionScopeFilter,
    sessionSearchQuery,
    sessionStatusFilters,
    sessionTagFilters,
  ]);
  const sessionProjectCount = sessionProjectFacets.reduce(
    (count, project) => count + project.count,
    0,
  );
  const selectedStatusFilters =
    normalizeSessionStatusFilterSelection(sessionStatusFilters);

  const toggleSessionStatusFilter = useCallback(
    (filter: SessionStatusFilter): void => {
      if (filter === "any") {
        onSessionStatusFiltersChange(["any"]);
        return;
      }

      const concreteFilters = selectedStatusFilters.filter(
        isConcreteSessionStatusFilter,
      );
      const nextFilters = concreteFilters.includes(filter)
        ? concreteFilters.filter((entry) => entry !== filter)
        : [...concreteFilters, filter];

      onSessionStatusFiltersChange(
        nextFilters.length > 0 ? nextFilters : ["any"],
      );
    },
    [onSessionStatusFiltersChange, selectedStatusFilters],
  );

  const closeSessionContextMenu = useCallback((): void => {
    setSessionContextMenu(null);
  }, []);

  const openSessionContextMenu = useCallback(
    (
      event: MouseEvent<HTMLElement>,
      session: ChatSessionRecord,
      actions: SessionActionItem[],
    ): void => {
      event.preventDefault();
      event.stopPropagation();

      if (actions.length === 0) {
        setSessionContextMenu(null);
        return;
      }

      setSessionContextMenu({
        sessionId: session.id,
        ...createSessionContextMenuPosition(event),
      });
    },
    [],
  );

  const openSessionDropdownMenu = useCallback(
    (
      event: MouseEvent<HTMLElement>,
      session: ChatSessionRecord,
      actions: SessionActionItem[],
    ): void => {
      event.preventDefault();
      event.stopPropagation();

      if (actions.length === 0) {
        setSessionContextMenu(null);
        return;
      }

      setSessionContextMenu({
        sessionId: session.id,
        ...createSessionDropdownMenuPosition(event.currentTarget),
      });
    },
    [],
  );

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setRetentionNow(Date.now());
    }, 60_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!sessionContextMenu) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeSessionContextMenu();
      }
    };

    document.addEventListener("pointerdown", closeSessionContextMenu);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", closeSessionContextMenu);
    window.addEventListener("scroll", closeSessionContextMenu, true);

    return () => {
      document.removeEventListener("pointerdown", closeSessionContextMenu);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", closeSessionContextMenu);
      window.removeEventListener("scroll", closeSessionContextMenu, true);
    };
  }, [closeSessionContextMenu, sessionContextMenu]);

  const contextMenuSession = sessionContextMenu
    ? (filteredSessions.find(
        (session) => session.id === sessionContextMenu.sessionId,
      ) ?? null)
    : null;
  const contextMenuSessionTitle = contextMenuSession
    ? getSessionTitle(contextMenuSession)
    : "";
  const contextMenuSessionIsQuick = contextMenuSession
    ? isQuickVoiceSession(contextMenuSession)
    : false;
  const contextMenuSessionActions = contextMenuSession
    ? createSessionActionItems({
        sessionId: contextMenuSession.id,
        canDuplicate: canDuplicateSession(contextMenuSession),
        canPin: canPinSession(contextMenuSession),
        isPinned: isSessionPinnedInSidebar(contextMenuSession),
        isQuickSession: contextMenuSessionIsQuick,
        showArchiveAction: canArchiveSession(contextMenuSession),
        onArchiveSession,
        onDuplicateSession,
        onTogglePinnedSession,
      })
    : [];

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

      <ScrollArea
        className="min-h-0 flex-1 [&_[data-slot=scroll-area-scrollbar]]:border-l-0"
        type="always"
      >
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

            {showSessionProjectFilter ? (
              <div className="relative">
                <Folder className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <select
                  aria-label="Workspace filter"
                  value={sessionProjectFilter}
                  onChange={(event) =>
                    onSessionProjectFilterChange(event.target.value)
                  }
                  className="app-sessions-workspace-filter h-9 w-full appearance-none truncate rounded-xl border border-slate-800 bg-slate-950/80 py-1 pr-8 pl-9 text-sm font-medium text-slate-200 outline-none transition-[border-color,box-shadow] hover:border-slate-700 focus-visible:border-slate-600 focus-visible:ring-1 focus-visible:ring-slate-600/35"
                >
                  <option value={ALL_SESSION_PROJECTS_FILTER}>
                    {`All workspaces (${sessionProjectCount})`}
                  </option>
                  {sessionProjectFacets.map((project) => (
                    <option key={project.id} value={project.id}>
                      {createSessionProjectOptionLabel(project)}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-slate-500" />
              </div>
            ) : null}

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
                          "app-session-filter-button h-7 w-6 rounded-lg border border-transparent text-slate-400 shadow-none hover:bg-slate-900 hover:text-slate-100",
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
                const isSelected = selectedStatusFilters.includes(filter.id);

                return (
                  <Tooltip key={filter.id}>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label={`Status: ${filter.label}`}
                        aria-pressed={isSelected}
                        onClick={() => toggleSessionStatusFilter(filter.id)}
                        className={cn(
                          "app-session-filter-button h-7 w-6 rounded-lg border border-transparent text-slate-400 shadow-none hover:bg-slate-900 hover:text-slate-100",
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
            <>
            {renderedSessions.map((session, index) => {
              const isActive = session.id === activeSessionId;
              const archived = isSessionArchived(session);
              const sessionStatus = getSessionOverviewStatus(session);
              const statusMeta = SESSION_STATUS_META[sessionStatus];
              const SessionStatusIcon = statusMeta.icon;
              const showArchiveAction = canArchiveSession(session);
              const isQuickSession = isQuickVoiceSession(session);
              const isPinned = isSessionPinnedInSidebar(session);
              const hasUnreadCompletion =
                !isActive &&
                !archived &&
                hasUnreadCompletedSessionResponse(session);
              const retentionProgress = getSessionRetentionProgress(
                session,
                {
                  inactiveSessionArchiveDays,
                  archivedSessionRetentionDays,
                },
                retentionNow,
              );
              const primaryTag = session.tags[0];
              const extraTagCount = Math.max(0, session.tags.length - 1);
              const sessionTitle = getSessionTitle(session);
              const sessionActionItems = createSessionActionItems({
                sessionId: session.id,
                canDuplicate: canDuplicateSession(session),
                canPin: canPinSession(session),
                isPinned,
                isQuickSession,
                showArchiveAction,
                onArchiveSession,
                onDuplicateSession,
                onTogglePinnedSession,
              });
              const hasSessionActionMenu = sessionActionItems.length > 0;

              return (
                <Fragment key={session.id}>
                  {showPinnedSeparator && index === pinnedSessionCount ? (
                    <div className="app-session-pin-separator -my-1 flex items-center gap-2 px-1">
                      <span className="h-px flex-1 bg-gradient-to-r from-slate-800/20 via-slate-800 to-slate-800/20" />
                      <span className="text-[10px] font-semibold tracking-[0.18em] text-slate-500 uppercase">
                        Unpinned
                      </span>
                      <span className="h-px flex-1 bg-gradient-to-r from-slate-800/20 via-slate-800 to-slate-800/20" />
                    </div>
                  ) : null}
                  <div
                    onContextMenu={(event) =>
                      openSessionContextMenu(event, session, sessionActionItems)
                    }
                    className={cn(
                      "app-session-card group relative flex min-h-[3.15rem] items-start overflow-hidden rounded-lg border px-2.5 pt-1.5 pb-2 transition-colors",
                      hasUnreadCompletion && "app-session-card--needs-read",
                      isActive
                        ? "border-sky-500/30 bg-sky-500/10 shadow-lg shadow-sky-950/20"
                        : "border-slate-800 bg-slate-950/70 hover:border-slate-700 hover:bg-slate-950",
                      archived &&
                        (isActive
                          ? "border-dashed"
                          : "border-dashed opacity-80"),
                    )}
                  >
                  <button
                    type="button"
                    aria-label={`Open session ${sessionTitle}${
                      hasUnreadCompletion ? ", new reply ready" : ""
                    }`}
                    onClick={() => onActivateSession(session.id)}
                    className="app-session-open-button min-w-0 flex-1 text-left"
                  >
                    <div
                      className={cn(
                        "flex w-full min-w-0 items-start gap-2",
                        hasSessionActionMenu && "pr-6",
                      )}
                    >
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
                        <div className="flex min-w-0 items-center gap-1.5">
                          {isPinned ? (
                            <Pin className="h-3.5 w-3.5 shrink-0 text-amber-300" />
                          ) : null}
                          {archived ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  aria-label="Archived session"
                                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-slate-500"
                                >
                                  <Archive className="h-3.5 w-3.5" />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="top">
                                Archived
                              </TooltipContent>
                            </Tooltip>
                          ) : null}
                          <p
                            className={cn(
                              "app-session-title min-w-0 truncate text-sm font-semibold leading-5 placeholder:text-slate-500",
                              archived ? "text-slate-300" : "text-slate-100",
                            )}
                          >
                            {sessionTitle}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="app-session-meta mt-0.5 flex w-full min-w-0 items-center justify-between gap-2 text-[10px] font-medium tracking-wide text-slate-500 uppercase">
                      <span className="flex min-w-0 flex-1 items-center gap-1.5">
                        {hasUnreadCompletion ? (
                          <span className="app-session-read-cue inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[9px] font-semibold tracking-wide uppercase">
                            New reply
                          </span>
                        ) : null}
                        {primaryTag ? (
                          <span className="app-session-tag-chip max-w-20 shrink-0 truncate rounded-full border border-slate-800 bg-slate-950 px-1.5 py-0.5 text-[9px] font-medium text-slate-500">
                            {extraTagCount > 0
                              ? `${primaryTag} +${extraTagCount}`
                              : primaryTag}
                          </span>
                        ) : null}
                        <span className="min-w-0 truncate">
                          {createSessionSubtitle(session)}
                        </span>
                      </span>
                      <span className="shrink-0">
                        {formatSessionTimestamp(
                          getLatestSessionUserRequestAt(session),
                        )}
                      </span>
                    </div>
                  </button>

                  {hasSessionActionMenu ? (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Session actions for ${sessionTitle}`}
                      title="Session actions"
                      aria-haspopup="menu"
                      aria-expanded={
                        sessionContextMenu?.sessionId === session.id
                          ? "true"
                          : "false"
                      }
                      onClick={(event) =>
                        openSessionDropdownMenu(
                          event,
                          session,
                          sessionActionItems,
                        )
                      }
                      className="app-session-card-action-button absolute top-1.5 right-1.5 h-5 w-5 rounded-md border border-transparent bg-transparent text-slate-500 opacity-0 transition-[background-color,border-color,color,opacity] duration-150 ease-out hover:border-slate-700 hover:bg-slate-900/80 hover:text-slate-100 group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100"
                    >
                      <Ellipsis className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                  {retentionProgress ? (
                    <div
                      aria-label={`${
                        retentionProgress.phase === "archive"
                          ? "Auto-archive"
                          : "Auto-delete"
                      } progress for ${sessionTitle}`}
                      className={cn(
                        "app-session-retention-progress pointer-events-none absolute inset-x-0 bottom-0 h-[2px] overflow-hidden",
                        retentionProgress.phase === "archive"
                          ? "bg-slate-800/80"
                          : "bg-transparent",
                      )}
                    >
                      <div
                        className={cn(
                          "h-full transition-[width] duration-500",
                          retentionProgress.phase === "archive"
                            ? "bg-sky-400/70"
                            : "bg-rose-300/45",
                        )}
                        style={{
                          width: `${Math.round(
                            retentionProgress.progress * 100,
                          )}%`,
                        }}
                      />
                    </div>
                  ) : null}
                  </div>
                </Fragment>
              );
            })}
            {renderedSessions.length < filteredSessions.length ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => {
                  setRenderedSessionLimit((current) =>
                    Math.min(
                      filteredSessions.length,
                      current + RENDERED_SESSION_PAGE_SIZE,
                    ),
                  );
                }}
              >
                Load more sessions ({filteredSessions.length - renderedSessions.length})
              </Button>
            ) : null}
            </>
          )}
        </div>
      </ScrollArea>
      {sessionContextMenu &&
      contextMenuSession &&
      contextMenuSessionActions.length > 0 ? (
        <SessionContextActionMenu
          actions={contextMenuSessionActions}
          left={sessionContextMenu.left}
          onClose={closeSessionContextMenu}
          title={contextMenuSessionTitle}
          top={sessionContextMenu.top}
        />
      ) : null}
    </aside>
  );
};
