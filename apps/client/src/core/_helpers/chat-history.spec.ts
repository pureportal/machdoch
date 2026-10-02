import { describe, expect, it } from "vitest";
import { hasUnpairedUtf16Surrogate } from "../../shared/unicode.js";
import { readChatHistory, searchChatHistory } from "./chat-history.js";

const history = Array.from({ length: 250 }, (_, index) => ({
  role: "assistant" as const,
  content: `Message ${index}`,
  createdAt: index,
}));

describe("chat history pages", () => {
  it("reads the latest messages by default and can page from the beginning", () => {
    const latest = readChatHistory(history, {});
    expect(latest.startIndex).toBe(240);
    expect(latest.messages).toHaveLength(10);
    expect(latest.nextIndex).toBeNull();
    const first = readChatHistory(history, { startIndex: 0, limit: 2 });
    expect(first.messages[0]).toMatchObject({
      index: 0,
      createdAt: 0,
      content: "Message 0",
    });
    expect(first.nextIndex).toBe(2);
    expect(
      readChatHistory(history, { startIndex: first.nextIndex! }).messages[0]
        ?.content,
    ).toBe("Message 2");
  });

  it("recovers every character of long messages across bounded Unicode-safe pages", () => {
    const content = `${"a".repeat(19_999)}😀${"b".repeat(30_000)}\n3. Keep this recommendation.`;
    const entries = [
      { role: "assistant" as const, content },
      { role: "user" as const, content: "Apply all three." },
    ];
    const chunks: string[] = [];
    let startIndex: number | null = 0;
    let offset = 0;
    while (startIndex !== null) {
      const page = readChatHistory(entries, { startIndex, offset });
      expect(
        page.messages.reduce((sum, message) => sum + message.content.length, 0),
      ).toBeLessThanOrEqual(20_000);
      expect(page.messages.length).toBeGreaterThan(0);
      for (const message of page.messages) {
        expect(hasUnpairedUtf16Surrogate(message.content)).toBe(false);
        if (message.index === 0) chunks.push(message.content);
      }
      startIndex = page.nextIndex;
      offset = page.nextOffset;
    }
    expect(chunks.join("")).toBe(content);
  });

  it("rejects positions outside the snapshot and offsets inside a Unicode character", () => {
    expect(() => readChatHistory(history, { startIndex: 251 })).toThrow(
      "startIndex",
    );
    expect(() =>
      readChatHistory(history, { startIndex: 0, offset: 100 }),
    ).toThrow("offset");
    expect(() =>
      readChatHistory([{ role: "user", content: "😀" }], {
        startIndex: 0,
        offset: 1,
      }),
    ).toThrow("Unicode");
    expect(
      readChatHistory(history, { startIndex: history.length }).messages,
    ).toEqual([]);
    expect(readChatHistory([], {})).toMatchObject({
      totalMessages: 0,
      messages: [],
      nextIndex: null,
    });
  });
});

describe("chat history search", () => {
  it("finds literal text without interpreting regex syntax and pages through matches", () => {
    const entries = [
      { role: "assistant" as const, content: "Earlier: [Recommendation 1]." },
      { role: "user" as const, content: "Unrelated" },
      { role: "assistant" as const, content: "Later: [recommendation 1]." },
    ];
    const first = searchChatHistory(entries, {
      query: "[recommendation 1].",
      limit: 1,
    });
    expect(first.matches).toEqual([
      expect.objectContaining({ index: 0, matchOffset: 9 }),
    ]);
    expect(first.nextIndex).toBe(1);
    const next = searchChatHistory(entries, {
      query: "[recommendation 1].",
      startIndex: first.nextIndex!,
    });
    expect(next.matches[0]?.index).toBe(2);
    expect(next.nextIndex).toBeNull();
  });

  it("searches old messages and returns bounded excerpts around matches deep in a long answer", () => {
    const content = `${"😀".repeat(2_000)}Recommendation 3${"😀".repeat(2_000)}`;
    const entries = [{ role: "assistant" as const, content }, ...history];
    const found = searchChatHistory(entries, { query: "recommendation 3" });
    expect(found.matches[0]).toMatchObject({ index: 0, matchOffset: 4_000 });
    expect(found.matches[0]?.content).toContain("Recommendation 3");
    expect(found.matches[0]!.content.length).toBeLessThanOrEqual(620);
    expect(hasUnpairedUtf16Surrogate(found.matches[0]!.content)).toBe(false);
    expect(searchChatHistory(entries, { query: "absent" }).matches).toEqual([]);
  });

  it("rejects empty search text and invalid positions", () => {
    expect(() => searchChatHistory(history, { query: "  " })).toThrow("query");
    expect(() =>
      searchChatHistory(history, { query: "Message", startIndex: 251 }),
    ).toThrow("startIndex");
  });
});
