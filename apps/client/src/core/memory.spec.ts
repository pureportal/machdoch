import {
  MAX_GLOBAL_MEMORY_ENTRIES,
  MAX_SESSION_MEMORY_ENTRIES,
  mergeConversationMemoryEntries,
  normalizeConversationMemoryEntries,
  normalizeMemoryContent,
  rememberConversationMemoryEntry,
} from "./memory.ts";
import type { ConversationMemoryEntry } from "./types.ts";

const createEntry = (
  id: string,
  content: string,
  updatedAt: number,
): ConversationMemoryEntry => ({
  id,
  scope: "session",
  content,
  createdAt: updatedAt - 1,
  updatedAt,
});

describe("normalizeMemoryContent", () => {
  it.each([
    ["plain text", "remember this", "remember this"],
    ["surrounding whitespace", "  remember this  ", "remember this"],
    ["multiple whitespace", "remember\n\nthis\ttoo", "remember this too"],
  ])("normalizes %s", (_label, value, expected) => {
    expect(normalizeMemoryContent(value)).toBe(expected);
  });

  it.each([undefined, "", "   ", "\n\t"])(
    "returns undefined for empty input %s",
    (value) => {
      expect(normalizeMemoryContent(value)).toBeUndefined();
    },
  );

  it("truncates long content at the storage boundary", () => {
    const normalized = normalizeMemoryContent("x".repeat(400));

    expect(normalized).toHaveLength(280);
    expect(normalized?.endsWith("…")).toBe(true);
  });
});

describe("normalizeConversationMemoryEntries", () => {
  it("drops invalid entries, normalizes content, deduplicates, and caps by scope", () => {
    const entries = [
      null,
      { id: "old", content: "Remember this", createdAt: 1, updatedAt: 2 },
      { id: "new", content: " remember   this ", createdAt: 3, updatedAt: 5 },
      { id: "blank", content: "   ", createdAt: 6, updatedAt: 7 },
      ...Array.from({ length: MAX_SESSION_MEMORY_ENTRIES + 4 }, (_, index) => ({
        id: `entry-${index}`,
        content: `item ${index}`,
        createdAt: 10 + index,
        updatedAt: 10 + index,
      })),
    ];

    const normalized = normalizeConversationMemoryEntries(entries, "session");

    expect(normalized).toHaveLength(MAX_SESSION_MEMORY_ENTRIES);
    expect(normalized[0]?.content).toBe(`item ${MAX_SESSION_MEMORY_ENTRIES + 3}`);
    expect(normalized.some((entry) => entry.id === "old")).toBe(false);
    expect(normalized.some((entry) => entry.id === "blank")).toBe(false);
  });

  it("returns an empty list for non-array input", () => {
    expect(normalizeConversationMemoryEntries(undefined, "global")).toEqual([]);
  });
});

describe("mergeConversationMemoryEntries", () => {
  it("keeps the newest duplicate and sorts by most recently updated", () => {
    const merged = mergeConversationMemoryEntries(
      [createEntry("old", "Same content", 1), createEntry("other", "Other", 3)],
      [createEntry("new", " same   content ", 5)],
      10,
    );

    expect(merged.map((entry) => entry.id)).toEqual(["new", "other"]);
    expect(merged[0]?.content).toBe("same content");
  });

  it("keeps at least one entry when maxEntries is below one", () => {
    const merged = mergeConversationMemoryEntries(
      [createEntry("one", "One", 1), createEntry("two", "Two", 2)],
      [],
      0,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("two");
  });
});

describe("rememberConversationMemoryEntry", () => {
  it("adds normalized new memory content", () => {
    const result = rememberConversationMemoryEntry([], "global", "  New memory  ", 5, 10);

    expect(result.added).toBe(true);
    expect(result.entry).toMatchObject({
      scope: "global",
      content: "New memory",
      createdAt: 10,
      updatedAt: 10,
    });
    expect(result.entries).toHaveLength(1);
  });

  it("refreshes existing duplicate content instead of adding another entry", () => {
    const existing = createEntry("existing", "same memory", 1);
    const result = rememberConversationMemoryEntry(
      [existing],
      "session",
      " SAME   MEMORY ",
      MAX_SESSION_MEMORY_ENTRIES,
      50,
    );

    expect(result.added).toBe(false);
    expect(result.entry).toMatchObject({ id: "existing", updatedAt: 50 });
    expect(result.entries).toHaveLength(1);
  });

  it("rejects blank memory content", () => {
    expect(() => rememberConversationMemoryEntry([], "global", "   ")).toThrow(
      /non-empty memory content/u,
    );
  });

  it("uses the global cap for global memories", () => {
    const entries = Array.from({ length: MAX_GLOBAL_MEMORY_ENTRIES + 1 }, (_, index) =>
      createEntry(`entry-${index}`, `memory ${index}`, index),
    );

    const result = rememberConversationMemoryEntry(
      entries,
      "global",
      "new global memory",
      undefined,
      100,
    );

    expect(result.entries).toHaveLength(MAX_GLOBAL_MEMORY_ENTRIES);
    expect(result.entries[0]?.content).toBe("new global memory");
  });
});
