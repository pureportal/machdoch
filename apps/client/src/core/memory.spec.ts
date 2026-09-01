import {
  MAX_GLOBAL_MEMORY_ENTRIES,
  MAX_SESSION_MEMORY_ENTRIES,
  mergeConversationMemoryEntries,
  normalizeConversationMemoryEntries,
  normalizeMemoryContent,
  normalizeMemorySearchTerms,
  normalizeMemoryStatement,
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
  key: content.toLowerCase().replaceAll(" ", "-"),
  kind: "fact",
  content,
  searchTerms: [],
  importance: 3,
  confidence: 1,
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

describe("normalizeMemorySearchTerms", () => {
  it("deduplicates and bounds retrieval aliases", () => {
    expect(
      normalizeMemorySearchTerms([
        " dining ",
        "DINING",
        "restaurant recommendations",
        ...Array.from({ length: 10 }, (_, index) => `term-${index}`),
      ]),
    ).toEqual([
      "dining",
      "restaurant recommendations",
      "term-0",
      "term-1",
      "term-2",
      "term-3",
      "term-4",
      "term-5",
    ]);
  });
});

describe("normalizeMemoryStatement", () => {
  it("removes generic user preference framing", () => {
    expect(
      normalizeMemoryStatement(
        "The user prefers: Opens in the active workspace",
      ),
    ).toBe("Opens in the active workspace");
    expect(
      normalizeMemoryStatement("The user prefers compact verification output"),
    ).toBe("Prefers compact verification output");
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
    expect(normalized[0]?.content).toBe(
      `item ${MAX_SESSION_MEMORY_ENTRIES + 3}`,
    );
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

  it("prefers an incoming replacement when timestamps are equal", () => {
    const existing = createEntry("existing", "Use Node 20", 5);
    existing.key = "node-version";
    const incoming = createEntry("existing", "Use Node 22", 5);
    incoming.key = "node-version";

    const merged = mergeConversationMemoryEntries([existing], [incoming], 10);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.content).toBe("Use Node 22");
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
    const result = rememberConversationMemoryEntry(
      [],
      "global",
      "  New memory  ",
      5,
      10,
      { sourceSessionId: "session-1" },
    );

    expect(result.added).toBe(true);
    expect(result.entry).toMatchObject({
      scope: "global",
      content: "New memory",
      sourceSessionId: "session-1",
      createdAt: 10,
      updatedAt: 10,
    });
    expect(result.entries).toHaveLength(1);
  });

  it("refreshes existing duplicate content instead of adding another entry", () => {
    const existing = createEntry("existing", "same memory", 1);
    existing.sourceSessionId = "session-original";
    const result = rememberConversationMemoryEntry(
      [existing],
      "session",
      " SAME   MEMORY ",
      MAX_SESSION_MEMORY_ENTRIES,
      50,
      { sourceSessionId: "session-later" },
    );

    expect(result.added).toBe(false);
    expect(result.entry).toMatchObject({
      id: "existing",
      sourceSessionId: "session-original",
      updatedAt: 50,
    });
    expect(result.entries).toHaveLength(1);
  });

  it("supersedes a stale fact when the concept key is reused", () => {
    const existing = createEntry("existing", "Use Node 20", 1);
    existing.key = "node-version";
    const result = rememberConversationMemoryEntry(
      [existing],
      "session",
      "Use Node 22",
      MAX_SESSION_MEMORY_ENTRIES,
      50,
      {
        key: "node-version",
        kind: "constraint",
        importance: 4,
        confidence: 0.9,
      },
    );

    expect(result).toMatchObject({ added: false, replaced: true });
    expect(result.entry).toMatchObject({
      id: "existing",
      key: "node-version",
      kind: "constraint",
      content: "Use Node 22",
      importance: 4,
      confidence: 0.9,
      createdAt: 0,
      updatedAt: 50,
    });
    expect(result.entries).toHaveLength(1);
  });

  it("rejects blank memory content", () => {
    expect(() => rememberConversationMemoryEntry([], "global", "   ")).toThrow(
      /non-empty memory content/u,
    );
  });

  it("uses the global cap for global memories", () => {
    const entries = Array.from(
      { length: MAX_GLOBAL_MEMORY_ENTRIES + 1 },
      (_, index) => createEntry(`entry-${index}`, `memory ${index}`, index),
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
