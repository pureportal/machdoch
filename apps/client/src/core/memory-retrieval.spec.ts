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
  searchTerms: [],
  importance: 3,
  confidence: 1,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  ...overrides,
});

describe("retrieveConversationMemory", () => {
  const now = 1_700_000_000_000;

  it("excludes expired memories before ranking even when search aliases match", () => {
    const current = createEntry(
      "current",
      "workspace",
      "release-build",
      "Use the release build command",
    );
    const expired = createEntry(
      "expired",
      "workspace",
      "old-compiler",
      "Use the previous compiler",
      {
        searchTerms: ["release", "build", "command"],
        importance: 5,
        applicability: { expiresAt: now },
      },
    );
    const options = { now, minimumScore: 0 };
    const baseline = retrieveConversationMemory("release build command", [current], options);
    const result = retrieveConversationMemory(
      "release build command",
      [expired, current],
      options,
    );

    expect(result.ranked).toEqual(baseline.ranked);
    expect(result.diagnostics).toMatchObject({
      candidateCount: 2,
      excludedCount: 1,
      excludedByReason: { expired: 1 },
      selectedCount: 1,
    });
  });

  it.each<{
    reason: string;
    applicability: NonNullable<ConversationMemoryEntry["applicability"]>;
  }>([
    { reason: "disabled", applicability: { enabled: false } },
    {
      reason: "too-old",
      applicability: { verifiedAt: now - 2 * 86_400_000, maxAgeDays: 1 },
    },
    { reason: "future-evidence", applicability: { verifiedAt: now + 1 } },
    {
      reason: "unmatched-task-terms",
      applicability: { taskTerms: ["deployment"] },
    },
    {
      reason: "excluded-task-term",
      applicability: { excludedTaskTerms: ["release"] },
    },
  ])("excludes $reason memories despite a matching query", ({ reason, applicability }) => {
    const result = retrieveConversationMemory(
      "release build command",
      [
        createEntry("restricted", "workspace", "release-build", "Use the release build command", {
          importance: 5,
          applicability,
        }),
      ],
      { now, minimumScore: 0 },
    );

    expect(result.entries).toEqual([]);
    expect(result.diagnostics.excludedCount).toBe(1);
    expect(result.diagnostics.excludedByReason).toEqual({ [reason]: 1 });
  });

  it("excludes unrelated facts even when the minimum ranking score is zero", () => {
    const result = retrieveConversationMemory(
      "release build command",
      [
        createEntry("database", "session", "database", "PostgreSQL stores application data", {
          importance: 5,
        }),
      ],
      { now, minimumScore: 0 },
    );

    expect(result.entries).toEqual([]);
    expect(result.diagnostics.excludedByReason).toEqual({ "irrelevant-content": 1 });
  });

  it("allows matching task rules and counts every reason for an excluded memory", () => {
    const result = retrieveConversationMemory(
      "release build command",
      [
        createEntry("valid", "workspace", "release-build", "Use the release build command", {
          applicability: { taskTerms: ["release build"] },
        }),
        createEntry("invalid", "global", "output-style", "Keep responses brief", {
          kind: "preference",
          applicability: { enabled: false, expiresAt: now },
        }),
      ],
      { now, minimumScore: 0 },
    );

    expect(result.entries.map((entry) => entry.id)).toEqual(["valid"]);
    expect(result.diagnostics).toMatchObject({
      excludedCount: 1,
      excludedByReason: { disabled: 1, expired: 1 },
    });
  });

  it("uses expanded search terms without exposing them as memory content", () => {
    const result = retrieveConversationMemory(
      "Find dinner restaurants nearby",
      [
        createEntry(
          "diet",
          "global",
          "dietary-restriction",
          "Avoids animal products",
          { searchTerms: ["dinner", "restaurant", "meal"] },
        ),
      ],
      { now },
    );

    expect(result.entries.map((entry) => entry.id)).toEqual(["diet"]);
    expect(result.entries[0]?.content).toBe("Avoids animal products");
  });

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
