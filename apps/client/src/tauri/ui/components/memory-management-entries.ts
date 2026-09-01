import type { MemoryManagementEntry } from "@machdoch/product-ui";
import type { ConversationMemoryEntry } from "../../../core/types.js";

export interface MemorySourceSession {
  id: string;
  title: string;
}

export const createMemoryManagementEntries = (
  entries: readonly ConversationMemoryEntry[],
  sourceSessions: readonly MemorySourceSession[],
): MemoryManagementEntry[] => {
  const sourceTitleById = new Map(
    sourceSessions.map((session) => [session.id, session.title]),
  );

  return entries.map((entry) => {
    const sourceLabel = entry.sourceSessionId
      ? sourceTitleById.get(entry.sourceSessionId)
      : undefined;

    return {
      id: entry.id,
      content: entry.content,
      createdAt: entry.createdAt,
      ...(sourceLabel ? { sourceLabel } : {}),
    };
  });
};
