import {
  createInitialShellState,
  createSession,
  QUICK_VOICE_SESSION_KIND,
} from "../../chat-session.model.ts";
import {
  createSessionHistoryIndex,
  duplicateSessionRecord,
  importSessionsIntoShellState,
} from "./session-history-index";

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
