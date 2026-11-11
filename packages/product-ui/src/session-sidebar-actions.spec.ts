import type { ProductSession } from "@machdoch/fleet-protocol";
import { describe, expect, it } from "vitest";
import { getSessionRowActions } from "./session-sidebar-actions";

const session = (values: Partial<ProductSession> = {}): ProductSession => ({
  id: "session",
  title: "Session",
  status: "done",
  provider: "claude-cli",
  model: "claude-opus-5-5",
  effectiveMode: "machdoch",
  createdAt: 0,
  updatedAt: 0,
  tags: [],
  messageCount: 2,
  promptHistoryCount: 1,
  attachmentCount: 0,
  canRename: true,
  canDelete: true,
  canArchive: true,
  canPin: true,
  canDuplicate: true,
  canBranch: true,
  ...values,
});

describe("session row actions", () => {
  it("offers every permitted lifecycle action in the client order", () => {
    expect(
      getSessionRowActions(
        session({ canResetTime: true, canMoveToTop: true, status: "empty" }),
      ),
    ).toEqual([
      {
        id: "reset-time",
        command: { kind: "reset-session-time", sessionId: "session" },
      },
      {
        id: "move-to-top",
        command: { kind: "move-session-to-top", sessionId: "session" },
      },
      { id: "pin", command: { kind: "pin-session", sessionId: "session" } },
      {
        id: "duplicate",
        command: { kind: "duplicate-session", sessionId: "session" },
      },
      {
        id: "archive",
        command: { kind: "archive-session", sessionId: "session" },
      },
      {
        id: "delete",
        command: { kind: "delete-session", sessionId: "session" },
      },
    ]);
  });

  it("toggles pinned and archived sessions back", () => {
    expect(
      getSessionRowActions(session({ pinnedAt: 1, archivedAt: 2 })).map(
        ({ id }) => id,
      ),
    ).toEqual(["unpin", "duplicate", "restore"]);
  });

  it("keeps deletion to empty sessions and hides actions the device forbids", () => {
    expect(getSessionRowActions(session()).map(({ id }) => id)).not.toContain(
      "delete",
    );
    expect(
      getSessionRowActions(
        session({
          status: "empty",
          canDelete: false,
          canPin: false,
          canDuplicate: false,
          canArchive: false,
        }),
      ),
    ).toEqual([]);
  });
});
