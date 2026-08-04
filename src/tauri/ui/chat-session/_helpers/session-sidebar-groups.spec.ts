import {
  createSession,
  QUICK_VOICE_SESSION_KIND,
} from "../../chat-session.model";
import {
  compareSessionsBySidebarGroup,
  getUnpinnedSessionDividerIndex,
  isSessionPinnedInSidebar,
} from "./session-sidebar-groups";

describe("sidebar session groups", () => {
  const pinnedSession = createSession({
    id: "pinned",
    pinnedAt: 10,
  });
  const unpinnedSession = createSession({ id: "unpinned" });
  const quickSession = createSession({
    id: "quick",
    specialSession: QUICK_VOICE_SESSION_KIND,
  });

  it("treats Quick Chat and explicitly pinned sessions as pinned rows", () => {
    expect(isSessionPinnedInSidebar(quickSession)).toBe(true);
    expect(isSessionPinnedInSidebar(pinnedSession)).toBe(true);
    expect(isSessionPinnedInSidebar(unpinnedSession)).toBe(false);
  });

  it("orders pinned rows before unpinned rows without reordering a group", () => {
    expect(compareSessionsBySidebarGroup(pinnedSession, unpinnedSession)).toBe(
      -1,
    );
    expect(compareSessionsBySidebarGroup(unpinnedSession, pinnedSession)).toBe(
      1,
    );
    expect(compareSessionsBySidebarGroup(quickSession, pinnedSession)).toBe(0);
    expect(
      compareSessionsBySidebarGroup(unpinnedSession, unpinnedSession),
    ).toBe(0);
  });

  it("places a divider only between non-empty pinned and unpinned groups", () => {
    expect(
      getUnpinnedSessionDividerIndex([
        quickSession,
        pinnedSession,
        unpinnedSession,
      ]),
    ).toBe(2);
    expect(
      getUnpinnedSessionDividerIndex([quickSession, pinnedSession]),
    ).toBeNull();
    expect(getUnpinnedSessionDividerIndex([unpinnedSession])).toBeNull();
    expect(getUnpinnedSessionDividerIndex([])).toBeNull();
  });

  it("updates the divider boundary after repeated pin state changes", () => {
    const newlyPinnedSession = {
      ...unpinnedSession,
      pinnedAt: 20,
    };
    expect(
      getUnpinnedSessionDividerIndex([newlyPinnedSession, pinnedSession]),
    ).toBeNull();

    const unpinnedAgainSession = {
      ...newlyPinnedSession,
      pinnedAt: undefined,
    };
    expect(
      getUnpinnedSessionDividerIndex([pinnedSession, unpinnedAgainSession]),
    ).toBe(1);

    const allUnpinnedSessions = [
      { ...pinnedSession, pinnedAt: undefined },
      unpinnedAgainSession,
    ];
    expect(getUnpinnedSessionDividerIndex(allUnpinnedSessions)).toBeNull();
  });
});
