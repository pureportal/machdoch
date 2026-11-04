import { describe, expect, it } from "vitest";
import {
  createFindExpression,
  findFirstIndex,
  findTextMatches,
  formatFindStatus,
  locateFindSpan,
  stepFindIndex,
} from "./find-text-matches";

const DEFAULT_OPTIONS = { matchCase: false, wholeWord: false };

describe("findTextMatches", () => {
  it("ignores empty and whitespace-only queries", () => {
    expect(findTextMatches("anything", "   ", DEFAULT_OPTIONS)).toEqual({
      matches: [],
      limited: false,
    });
    expect(createFindExpression("", DEFAULT_OPTIONS)).toBeNull();
  });

  it("matches case-insensitively by default and literally", () => {
    const { matches } = findTextMatches(
      "Playwright runs playwright. a.b axb",
      "PLAYWRIGHT",
      DEFAULT_OPTIONS,
    );
    expect(matches).toEqual([
      { start: 0, end: 10 },
      { start: 16, end: 26 },
    ]);
    expect(findTextMatches("a.b axb", "a.b", DEFAULT_OPTIONS).matches).toEqual([
      { start: 0, end: 3 },
    ]);
  });

  it("respects match case", () => {
    expect(
      findTextMatches("Find find FIND", "find", {
        matchCase: true,
        wholeWord: false,
      }).matches,
    ).toEqual([{ start: 5, end: 9 }]);
  });

  it("respects whole words including unicode letters", () => {
    expect(
      findTextMatches("cat concat cats cat_ cat. Übercat cat", "cat", {
        matchCase: false,
        wholeWord: true,
      }).matches,
    ).toEqual([
      { start: 0, end: 3 },
      { start: 21, end: 24 },
      { start: 34, end: 37 },
    ]);
  });

  it("matches any whitespace run between words but not block separators", () => {
    const text = "run\n  the tests\u0000run the\u0000tests";
    expect(findTextMatches(text, "run the tests", DEFAULT_OPTIONS)).toEqual({
      matches: [{ start: 0, end: 15 }],
      limited: false,
    });
  });

  it("stops at the match limit", () => {
    const result = findTextMatches("aaaa", "a", DEFAULT_OPTIONS, 3);
    expect(result.limited).toBe(true);
    expect(result.matches).toHaveLength(3);
    expect(findTextMatches("aaa", "a", DEFAULT_OPTIONS, 3).limited).toBe(false);
  });
});

describe("locateFindSpan", () => {
  const segments = [
    { start: 0, end: 5 },
    { start: 5, end: 8 },
    { start: 9, end: 14 },
  ];

  it("maps spans inside one segment", () => {
    expect(locateFindSpan(segments, { start: 1, end: 4 })).toEqual({
      start: { segmentIndex: 0, offset: 1 },
      end: { segmentIndex: 0, offset: 4 },
    });
  });

  it("maps spans across adjacent segments", () => {
    expect(locateFindSpan(segments, { start: 3, end: 7 })).toEqual({
      start: { segmentIndex: 0, offset: 3 },
      end: { segmentIndex: 1, offset: 2 },
    });
  });

  it("clamps spans that touch unmapped separators", () => {
    expect(locateFindSpan(segments, { start: 8, end: 11 })).toEqual({
      start: { segmentIndex: 2, offset: 0 },
      end: { segmentIndex: 2, offset: 2 },
    });
    expect(locateFindSpan(segments, { start: 6, end: 9 })).toEqual({
      start: { segmentIndex: 1, offset: 1 },
      end: { segmentIndex: 1, offset: 3 },
    });
  });

  it("returns null outside of mapped text", () => {
    expect(locateFindSpan(segments, { start: 14, end: 16 })).toBeNull();
    expect(locateFindSpan([], { start: 0, end: 1 })).toBeNull();
  });
});

describe("find navigation", () => {
  it("finds the first index satisfying a monotonic predicate", () => {
    const values = [1, 3, 5, 7];
    expect(findFirstIndex(values.length, (index) => values[index]! >= 4)).toBe(
      2,
    );
    expect(findFirstIndex(values.length, () => false)).toBe(4);
    expect(findFirstIndex(0, () => true)).toBe(0);
  });

  it("wraps when stepping through matches", () => {
    expect(stepFindIndex(2, 3, 1)).toBe(0);
    expect(stepFindIndex(0, 3, -1)).toBe(2);
    expect(stepFindIndex(-1, 3, 1)).toBe(0);
    expect(stepFindIndex(-1, 3, -1)).toBe(2);
    expect(stepFindIndex(0, 0, 1)).toBe(-1);
  });

  it("formats the match status", () => {
    expect(formatFindStatus(" ", 0, -1, false)).toBe("");
    expect(formatFindStatus("x", 0, -1, false)).toBe("No matches");
    expect(formatFindStatus("x", 12, 2, false)).toBe("3 of 12");
    expect(formatFindStatus("x", 1000, 0, true)).toBe("1 of 1000+");
  });
});
