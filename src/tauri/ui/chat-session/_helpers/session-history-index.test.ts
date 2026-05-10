import {
  createSession,
  QUICK_VOICE_SESSION_KIND,
} from "../../chat-session.model.ts";
import {
  duplicateSessionRecord,
  filterSessionHistoryIndex,
  createSessionHistoryIndex,
  ALL_SESSION_PROJECTS_FILTER,
} from "./session-history-index";

describe("session history index", () => {
  it("keeps Quick Chat visible at the top regardless of filters", () => {
    const quickSession = createSession({
      id: "quick-session",
      specialSession: QUICK_VOICE_SESSION_KIND,
      updatedAt: 1,
    });
    const matchingSession = createSession({
      id: "matching-session",
      manualTitle: "Matching session",
      updatedAt: 2,
    });
    const index = createSessionHistoryIndex([matchingSession, quickSession]);

    expect(
      filterSessionHistoryIndex(index, {
        scope: "archived",
        status: "running",
        searchQuery: "no matching tokens",
        projectFilter: ALL_SESSION_PROJECTS_FILTER,
        tagFilters: ["missing"],
      }).sessions.map((session) => session.id),
    ).toEqual(["quick-session"]);
  });

  it("does not duplicate Quick Chat records", () => {
    const quickSession = createSession({
      id: "quick-session",
      specialSession: QUICK_VOICE_SESSION_KIND,
    });

    expect(() => duplicateSessionRecord(quickSession, "duplicate")).toThrow(
      "Quick Chat cannot be duplicated.",
    );
  });
});
