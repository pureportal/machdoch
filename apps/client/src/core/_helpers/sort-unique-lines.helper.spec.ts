/// <reference types="vitest/globals" />
import { sortUniqueLines } from "./sort-unique-lines.helper.ts";

const defaultOptions = {
  caseSensitive: true,
  trimLines: true,
  removeEmpty: true,
  descending: false,
} as const;

describe("sortUniqueLines", () => {
  it("sorts, trims, and deduplicates lines case-sensitively by default", () => {
    const result = sortUniqueLines(
      " banana\nApple\napple\nbanana\n",
      defaultOptions,
    );

    expect(result).toEqual(["apple", "Apple", "banana"]);
  });

  it("deduplicates case-insensitively while preserving the first matching line", () => {
    const result = sortUniqueLines("banana\nApple\napple\nBANANA", {
      ...defaultOptions,
      caseSensitive: false,
    });

    expect(result).toEqual(["Apple", "banana"]);
  });

  it("keeps whitespace and empty lines when requested", () => {
    const result = sortUniqueLines(" beta\n\nalpha\n beta", {
      ...defaultOptions,
      trimLines: false,
      removeEmpty: false,
    });

    expect(result).toEqual(["", " beta", "alpha"]);
  });

  it("sorts descending when requested", () => {
    const result = sortUniqueLines("alpha\ncharlie\nbravo", {
      ...defaultOptions,
      descending: true,
    });

    expect(result).toEqual(["charlie", "bravo", "alpha"]);
  });

  it("returns an empty list for empty text or only removed empty lines", () => {
    expect(sortUniqueLines("", defaultOptions)).toEqual([]);
    expect(sortUniqueLines("\n  \r\n", defaultOptions)).toEqual([]);
  });

  it("accepts the maximum bounded line count", () => {
    const text = Array.from({ length: 2_000 }, (_, index) =>
      String(index).padStart(4, "0"),
    ).join("\n");

    const result = sortUniqueLines(text, defaultOptions);

    expect(result).toHaveLength(2_000);
  });

  it("rejects input above the maximum bounded line count", () => {
    const text = Array.from({ length: 2_001 }, (_, index) =>
      String(index).padStart(4, "0"),
    ).join("\n");

    const result = sortUniqueLines(text, defaultOptions);

    expect(result).toBe("Expected `text` to contain no more than 2000 lines.");
  });
});
