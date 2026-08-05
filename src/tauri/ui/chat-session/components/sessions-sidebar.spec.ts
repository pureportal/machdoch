import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createSession } from "../../chat-session.model";
import { TooltipProvider } from "../../components/ui/tooltip";
import { ALL_SESSION_PROJECTS_FILTER } from "../_helpers/session-history-index";
import {
  createSessionActionItems,
  SessionsSidebar,
  type SessionsSidebarProps,
} from "./sessions-sidebar";

const noop = (): void => {};

const createProps = (
  overrides: Partial<SessionsSidebarProps> = {},
): SessionsSidebarProps => {
  const emptySession = createSession({ id: "empty-session" });

  return {
    totalSessions: 1,
    activeSessionId: emptySession.id,
    filteredSessions: [emptySession],
    sessionScopeFilter: "all",
    sessionStatusFilters: ["any"],
    sessionSearchQuery: "",
    sessionProjectFilter: ALL_SESSION_PROJECTS_FILTER,
    inactiveSessionArchiveDays: 7,
    archivedSessionRetentionDays: 7,
    sessionProjectFacets: [],
    sessionTagFacets: [],
    sessionTagFilters: [],
    onSessionScopeFilterChange: noop,
    onSessionStatusFiltersChange: noop,
    onSessionSearchQueryChange: noop,
    onSessionProjectFilterChange: noop,
    onSessionTagFilterToggle: noop,
    onCreateSession: noop,
    onActivateSession: noop,
    onArchiveSession: noop,
    onDeleteSession: noop,
    onTogglePinnedSession: noop,
    onDuplicateSession: noop,
    onExportSessions: noop,
    onImportSessions: noop,
    ...overrides,
  };
};

describe("SessionsSidebar", () => {
  it("shows the action menu for an empty session", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(SessionsSidebar, createProps()),
      ),
    );

    expect(markup).toContain('aria-label="Session actions for New session"');
  });

  it("routes the empty-session delete action", () => {
    const onDeleteSession = vi.fn();
    const actions = createSessionActionItems({
      sessionId: "empty-session",
      canDuplicate: false,
      canPin: false,
      isPinned: false,
      isQuickSession: false,
      showArchiveAction: false,
      showDeleteAction: true,
      onArchiveSession: noop,
      onDeleteSession,
      onDuplicateSession: noop,
      onTogglePinnedSession: noop,
    });

    expect(actions.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "delete", label: "Delete" },
    ]);

    actions[0]?.onSelect();

    expect(onDeleteSession).toHaveBeenCalledWith("empty-session");
  });
});
