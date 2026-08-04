import {
  createInitialShellState,
  createSession,
  QUICK_VOICE_SESSION_KIND,
} from "../../chat-session.model.ts";
import {
  createSessionHistoryIndex,
  duplicateSessionRecord,
  filterSessionHistoryIndex,
  importSessionsIntoShellState,
  type SessionHistoryIndexEntryCache,
} from "./session-history-index";

const createHistorySession = ({
  id,
  title,
  request,
  requestAt,
  pinnedAt,
  tags = [],
  workspace = null,
  archivedAt,
}: {
  id: string;
  title: string;
  request: string;
  requestAt: number;
  pinnedAt?: number;
  tags?: string[];
  workspace?: string | null;
  archivedAt?: number;
}) => {
  return createSession({
    id,
    manualTitle: title,
    createdAt: requestAt,
    updatedAt: requestAt,
    pinnedAt,
    tags,
    workspace,
    archivedAt,
    messages: [
      {
        id: `${id}-request`,
        taskId: `${id}-task`,
        role: "user",
        content: request,
        createdAt: requestAt,
      },
    ],
  });
};

const filterHistory = (
  sessions: ReturnType<typeof createHistorySession>[],
  {
    searchQuery = "",
    entryCache,
    includeContent = true,
  }: {
    searchQuery?: string;
    entryCache?: SessionHistoryIndexEntryCache;
    includeContent?: boolean;
  } = {},
) => {
  const index = createSessionHistoryIndex(sessions, entryCache, {
    includeContent,
  });

  return filterSessionHistoryIndex(index, {
    scope: "all",
    status: "any",
    searchQuery,
  });
};

const expectUniqueSessionOrder = (
  sessions: ReturnType<typeof createHistorySession>[],
  expectedIds: string[],
): void => {
  const ids = sessions.map((session) => session.id);

  expect(ids).toEqual(expectedIds);
  expect(new Set(ids).size).toBe(ids.length);
};

describe("sidebar filtering and ordering", () => {
  const pinnedTitleMatch = createHistorySession({
    id: "pinned-title-match",
    title: "Needle in title",
    request: "unrelated request",
    requestAt: 100,
    pinnedAt: 100,
  });
  const unpinnedTagMatch = createHistorySession({
    id: "unpinned-tag-match",
    title: "Tagged result",
    request: "unrelated request",
    requestAt: 300,
    tags: ["needle"],
  });
  const pinnedContentMatch = createHistorySession({
    id: "pinned-content-match",
    title: "Pinned content result",
    request: "needle appears only in content",
    requestAt: 200,
    pinnedAt: 400,
  });
  const unpinnedNonmatch = createHistorySession({
    id: "unpinned-nonmatch",
    title: "Different result",
    request: "unrelated request",
    requestAt: 500,
  });
  const mixedSessions = [
    pinnedTitleMatch,
    unpinnedTagMatch,
    pinnedContentMatch,
    unpinnedNonmatch,
  ];

  it("keeps the pinned group contiguous before search-ranked unpinned matches", () => {
    const result = filterHistory(mixedSessions, { searchQuery: "needle" });

    expectUniqueSessionOrder(result.sessions, [
      "pinned-title-match",
      "pinned-content-match",
      "unpinned-tag-match",
    ]);
    expect(result.entries.map((entry) => entry.score)).toEqual([11, 1, 6]);
  });

  it("restores the complete default ordering after search is cleared", () => {
    expectUniqueSessionOrder(filterHistory(mixedSessions).sessions, [
      "pinned-content-match",
      "pinned-title-match",
      "unpinned-nonmatch",
      "unpinned-tag-match",
    ]);
  });

  it("updates cached search results through repeated pin and unpin changes", () => {
    const entryCache: SessionHistoryIndexEntryCache = new Map();
    const alpha = createHistorySession({
      id: "alpha",
      title: "Alpha",
      request: "shared appears only in content",
      requestAt: 300,
    });
    const beta = createHistorySession({
      id: "beta",
      title: "Shared beta",
      request: "beta",
      requestAt: 200,
      pinnedAt: 100,
    });
    const gamma = createHistorySession({
      id: "gamma",
      title: "Gamma",
      request: "gamma",
      requestAt: 100,
      tags: ["shared"],
    });
    const runSearch = (
      sessions: ReturnType<typeof createHistorySession>[],
    ): ReturnType<typeof createHistorySession>[] => {
      return filterHistory(sessions, {
        searchQuery: "shared",
        entryCache,
      }).sessions;
    };

    expectUniqueSessionOrder(runSearch([alpha, beta, gamma]), [
      "beta",
      "gamma",
      "alpha",
    ]);

    const pinnedAlpha = { ...alpha, pinnedAt: 200, updatedAt: 400 };
    expectUniqueSessionOrder(runSearch([pinnedAlpha, beta, gamma]), [
      "beta",
      "alpha",
      "gamma",
    ]);

    const unpinnedBeta = { ...beta, pinnedAt: undefined, updatedAt: 500 };
    expectUniqueSessionOrder(runSearch([pinnedAlpha, unpinnedBeta, gamma]), [
      "alpha",
      "beta",
      "gamma",
    ]);

    const unpinnedAlpha = {
      ...pinnedAlpha,
      pinnedAt: undefined,
      updatedAt: 600,
    };
    expectUniqueSessionOrder(runSearch([unpinnedAlpha, unpinnedBeta, gamma]), [
      "beta",
      "gamma",
      "alpha",
    ]);
    expectUniqueSessionOrder(
      filterHistory([unpinnedAlpha, unpinnedBeta, gamma], {
        searchQuery: "",
        entryCache,
        includeContent: false,
      }).sessions,
      ["alpha", "beta", "gamma"],
    );
  });

  it("keeps a selected session identity stable as pinning moves its row", () => {
    const selectedSession = createHistorySession({
      id: "selected",
      title: "Selected",
      request: "needle in selected content",
      requestAt: 200,
    });
    const pinnedSession = createHistorySession({
      id: "pinned",
      title: "Pinned",
      request: "needle in pinned content",
      requestAt: 100,
      pinnedAt: 100,
    });
    const initialResult = filterHistory([selectedSession, pinnedSession], {
      searchQuery: "needle",
    }).sessions;

    expectUniqueSessionOrder(initialResult, ["pinned", "selected"]);
    expect(initialResult[1]).toBe(selectedSession);

    const selectedAndPinned = {
      ...selectedSession,
      pinnedAt: 200,
      updatedAt: 300,
    };
    const pinnedResult = filterHistory([selectedAndPinned, pinnedSession], {
      searchQuery: "needle",
    }).sessions;

    expectUniqueSessionOrder(pinnedResult, ["selected", "pinned"]);
    expect(pinnedResult[0]?.id).toBe(selectedSession.id);

    const selectedAndUnpinned = {
      ...selectedAndPinned,
      pinnedAt: undefined,
      updatedAt: 400,
    };
    const unpinnedResult = filterHistory([selectedAndUnpinned, pinnedSession], {
      searchQuery: "needle",
    }).sessions;

    expectUniqueSessionOrder(unpinnedResult, ["pinned", "selected"]);
    expect(unpinnedResult[1]?.id).toBe(selectedSession.id);
  });

  it("preserves grouping across combined filters and restores every session", () => {
    const entryCache: SessionHistoryIndexEntryCache = new Map();
    const quickSession = createSession({
      id: "quick",
      specialSession: QUICK_VOICE_SESSION_KIND,
    });
    const pinnedMatch = createHistorySession({
      id: "pinned-match",
      title: "Pinned result",
      request: "needle in content",
      requestAt: 200,
      pinnedAt: 200,
      tags: ["sidebar"],
      workspace: "C:\\Development\\machdoch",
    });
    const activeUnpinnedMatch = createHistorySession({
      id: "active-unpinned-match",
      title: "Needle in title",
      request: "different content",
      requestAt: 300,
      tags: ["sidebar"],
      workspace: "C:\\Development\\machdoch",
    });
    const wrongProject = createHistorySession({
      id: "wrong-project",
      title: "Needle elsewhere",
      request: "different content",
      requestAt: 400,
      pinnedAt: 250,
      tags: ["sidebar"],
      workspace: "C:\\Development\\other",
    });
    const wrongTag = createHistorySession({
      id: "wrong-tag",
      title: "Needle without tag",
      request: "different content",
      requestAt: 500,
      tags: ["different"],
      workspace: "C:\\Development\\machdoch",
    });
    const archivedMatch = createHistorySession({
      id: "archived-match",
      title: "Needle archived",
      request: "different content",
      requestAt: 600,
      pinnedAt: 300,
      tags: ["sidebar"],
      workspace: "C:\\Development\\machdoch",
      archivedAt: 700,
    });
    const allSessions = [
      quickSession,
      pinnedMatch,
      activeUnpinnedMatch,
      wrongProject,
      wrongTag,
      archivedMatch,
    ];
    const searchIndex = createSessionHistoryIndex(allSessions, entryCache, {
      includeContent: true,
    });
    const machdochProject = searchIndex.projects.find(
      (project) => project.path === "C:\\Development\\machdoch",
    );

    expect(machdochProject).toBeDefined();

    const filtered = filterSessionHistoryIndex(searchIndex, {
      scope: "open",
      status: "running",
      searchQuery: "needle",
      projectFilter: machdochProject?.id,
      tagFilters: ["sidebar"],
    }).sessions;

    expect(filtered.map((session) => session.id)).toEqual([
      "quick",
      "pinned-match",
      "active-unpinned-match",
    ]);
    expect(filtered[2]).toBe(activeUnpinnedMatch);

    const clearedIndex = createSessionHistoryIndex(allSessions, entryCache, {
      includeContent: false,
    });
    const restored = filterSessionHistoryIndex(clearedIndex, {
      scope: "all",
      status: "any",
      searchQuery: "",
      tagFilters: [],
    }).sessions;
    expectUniqueSessionOrder(restored, [
      "quick",
      "archived-match",
      "wrong-project",
      "pinned-match",
      "wrong-tag",
      "active-unpinned-match",
    ]);
  });
});

describe("workspace facets", () => {
  it("uses configured workspace roots while retaining session counts", () => {
    const index = createSessionHistoryIndex(
      [
        createSession({
          id: "machdoch-one",
          workspace: "C:\\Projects\\machdoch",
        }),
        createSession({
          id: "machdoch-two",
          workspace: "c:/projects/machdoch/",
        }),
        createSession({
          id: "removed-workspace",
          workspace: "C:\\Projects\\removed",
        }),
        createSession({ id: "not-set", workspace: null }),
      ],
      undefined,
      {
        workspaceRoots: [
          "C:\\Projects\\machdoch",
          "C:\\Projects\\new-workspace",
        ],
      },
    );

    expect(
      index.projects.map(({ label, path, count }) => ({ label, path, count })),
    ).toEqual([
      {
        label: "machdoch",
        path: "C:\\Projects\\machdoch",
        count: 2,
      },
      { label: "Not Set", path: null, count: 1 },
      {
        label: "new-workspace",
        path: "C:\\Projects\\new-workspace",
        count: 0,
      },
    ]);
  });

  it("keeps deriving workspace facets from sessions for legacy callers", () => {
    const index = createSessionHistoryIndex([
      createSession({
        id: "legacy-workspace",
        workspace: "C:\\Projects\\legacy",
      }),
    ]);

    expect(index.projects).toMatchObject([
      { label: "legacy", path: "C:\\Projects\\legacy", count: 1 },
    ]);
  });
});

describe("session duplication and import", () => {
  it("does not duplicate Quick Chat records", () => {
    const quickSession = createSession({
      id: "quick-session",
      specialSession: QUICK_VOICE_SESSION_KIND,
    });

    expect(() => duplicateSessionRecord(quickSession, "duplicate")).toThrow(
      "Quick Chat cannot be duplicated.",
    );
  });

  it("does not duplicate empty sessions", () => {
    const emptySession = createSession({
      id: "empty-session",
    });

    expect(() => duplicateSessionRecord(emptySession, "duplicate")).toThrow(
      "Empty sessions cannot be duplicated.",
    );
  });

  it("assigns fresh entity ids when a deleted session backup is imported", () => {
    const state = createInitialShellState();
    const deletedSession = createSession({
      id: "previously-deleted-session",
      messages: [
        {
          id: "previously-deleted-message",
          taskId: "previously-deleted-task",
          role: "user",
          content: "Restore this backup",
          createdAt: 1,
        },
      ],
    });

    const imported = importSessionsIntoShellState(state, {
      kind: "machdoch.sessions",
      version: 1,
      exportedAt: 1,
      sessions: [deletedSession],
    });
    const importedSession = imported.sessions[0];

    expect(importedSession?.id).not.toBe(deletedSession.id);
    expect(importedSession?.messages[0]?.id).not.toBe(
      deletedSession.messages[0]?.id,
    );
    expect(importedSession?.messages[0]?.taskId).not.toBe(
      deletedSession.messages[0]?.taskId,
    );
  });
});
