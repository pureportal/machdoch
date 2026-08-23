import { retrieveConversationMemory } from "./memory-retrieval.ts";
import type {
  ConversationMemoryEntry,
  ConversationMemoryScope,
} from "./types.ts";

const createEntry = (
  id: string,
  scope: ConversationMemoryScope,
  key: string,
  content: string,
  overrides: Partial<ConversationMemoryEntry> = {},
): ConversationMemoryEntry => ({
  id,
  scope,
  key,
  kind: "fact",
  content,
  importance: 3,
  confidence: 1,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  ...overrides,
});

describe("retrieveConversationMemory", () => {
  const now = 1_700_000_000_000;

  it("ranks task-relevant memories ahead of unrelated recent facts", () => {
    const result = retrieveConversationMemory(
      "Why does the Vite health check fail on port 5173?",
      [
        createEntry(
          "unrelated",
          "session",
          "database-choice",
          "The workspace uses PostgreSQL for application data",
        ),
        createEntry(
          "relevant",
          "workspace",
          "vite-health-check-port",
          "The Vite health check fails when another server owns port 5173",
          { kind: "workaround", updatedAt: now - 86_400_000 },
        ),
      ],
      { now },
    );

    expect(result.entries.map((entry) => entry.id)).toEqual(["relevant"]);
    expect(result.ranked[0]?.reasons).toContain("lexical");
    expect(result.diagnostics).toMatchObject({
      candidateCount: 2,
      selectedCount: 1,
      selectedByScope: { session: 0, workspace: 1, global: 0 },
    });
  });

  it("keeps globally useful preferences subject to relevance filtering", () => {
    const result = retrieveConversationMemory(
      "Summarize the verification output",
      [
        createEntry(
          "preference",
          "global",
          "verification-output-style",
          "The user prefers compact verification output",
          { kind: "preference", importance: 4 },
        ),
        createEntry(
          "irrelevant",
          "global",
          "image-layout",
          "The user prefers large gallery images",
          { kind: "preference", importance: 4 },
        ),
      ],
      { now },
    );

    expect(result.entries.map((entry) => entry.id)).toEqual(["preference"]);
  });

  it("enforces scope quotas and the prompt character budget", () => {
    const entries = Array.from({ length: 7 }, (_, index) =>
      createEntry(
        `workspace-${index}`,
        "workspace",
        `build-command-${index}`,
        `Use build command variant ${index} for the release build`,
        { importance: 5 - (index % 2) },
      ),
    );
    const result = retrieveConversationMemory(
      "release build command",
      entries,
      {
        now,
        maxEntries: 7,
        maxCharacters: 500,
      },
    );

    expect(result.entries).toHaveLength(4);
    expect(result.diagnostics.selectedByScope.workspace).toBe(4);
    expect(result.diagnostics.contextCharacters).toBeLessThanOrEqual(500);
  });

  it("returns no memory for an unrelated request", () => {
    const result = retrieveConversationMemory(
      "Create a watercolor illustration",
      [
        createEntry(
          "build",
          "workspace",
          "release-command",
          "Run pnpm package to create the desktop release",
        ),
        createEntry(
          "important-global",
          "global",
          "gallery-image-layout",
          "The user prefers large gallery images",
          { kind: "preference", importance: 5 },
        ),
      ],
      { now },
    );

    expect(result.entries).toEqual([]);
    expect(result.diagnostics.contextCharacters).toBe(0);
  });
});
