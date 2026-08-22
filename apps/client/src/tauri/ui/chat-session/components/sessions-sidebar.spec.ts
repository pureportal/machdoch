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

const createCompletedSession = ({
  id,
  lastReadAt,
}: {
  id: string;
  lastReadAt: number;
}) =>
  createSession({
    id,
    createdAt: 100,
    updatedAt: 200,
    lastReadAt,
    manualTitle: id,
    messages: [
      {
        id: `${id}-user`,
        taskId: `${id}-task`,
        role: "user",
        content: "Request",
        createdAt: 100,
      },
      {
        id: `${id}-agent`,
        taskId: `${id}-task`,
        role: "agent",
        content: "Response",
        createdAt: 200,
        source: {
          kind: "thinking",
          thinking: {
            status: "complete",
            mode: "machdoch",
            startedAt: 100,
            completedAt: 200,
            timelineEvents: [],
          },
        },
      },
    ],
  });

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

  it("renders completed session states without a new-reply badge", () => {
    const unreadSession = createCompletedSession({
      id: "Unread response",
      lastReadAt: 100,
    });
    const readSession = createCompletedSession({
      id: "Read response",
      lastReadAt: 200,
    });
    const markup = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(
          SessionsSidebar,
          createProps({
            totalSessions: 2,
            activeSessionId: "another-session",
            filteredSessions: [unreadSession, readSession],
          }),
        ),
      ),
    );

    expect(markup).not.toContain("app-session-read-cue");
    expect(markup).not.toContain(">New reply<");
    expect(markup.match(/app-session-card--needs-read/g)).toHaveLength(1);
    expect(markup).toContain(
      'aria-label="Open session Unread response, new reply ready"',
    );
    expect(markup.match(/aria-label="Session status: Done"/g)).toHaveLength(2);
    expect(
      markup.match(
        /aria-label="Session status: Done"[^>]*><svg[^>]*\blucide-check\b/g,
      ),
    ).toHaveLength(2);
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
