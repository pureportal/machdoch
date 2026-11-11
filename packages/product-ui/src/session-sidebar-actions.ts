import type { ProductCommand, ProductSession } from "@machdoch/fleet-protocol";

export type SessionRowActionId =
  | "reset-time"
  | "move-to-top"
  | "pin"
  | "unpin"
  | "duplicate"
  | "archive"
  | "restore"
  | "delete";

export interface SessionRowAction {
  id: SessionRowActionId;
  command: ProductCommand;
}

export const getSessionRowActions = (
  session: ProductSession,
): SessionRowAction[] => {
  const sessionId = session.id;
  const actions: SessionRowAction[] = [];
  if (session.canResetTime)
    actions.push({
      id: "reset-time",
      command: { kind: "reset-session-time", sessionId },
    });
  if (session.canMoveToTop)
    actions.push({
      id: "move-to-top",
      command: { kind: "move-session-to-top", sessionId },
    });
  if (session.canPin)
    actions.push({
      id: session.pinnedAt === undefined ? "pin" : "unpin",
      command: { kind: "pin-session", sessionId },
    });
  if (session.canDuplicate)
    actions.push({
      id: "duplicate",
      command: { kind: "duplicate-session", sessionId },
    });
  if (session.canArchive)
    actions.push({
      id: session.archivedAt === undefined ? "archive" : "restore",
      command: { kind: "archive-session", sessionId },
    });
  if (session.status === "empty" && session.canDelete)
    actions.push({
      id: "delete",
      command: { kind: "delete-session", sessionId },
    });
  return actions;
};
