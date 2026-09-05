// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  addSearchMatchesToHighlightedHtml,
  findFilePreviewMatches,
  MAX_FILE_PREVIEW_MATCHES,
} from "./file-preview-search";

describe("bounded preview search", () => {
  it("caps match retention and marks incomplete results", () => {
    const result = findFilePreviewMatches("a".repeat(10_000), "a", false);
    expect(result.matches).toHaveLength(MAX_FILE_PREVIEW_MATCHES);
    expect(result.limited).toBe(true);
    expect(
      findFilePreviewMatches("a".repeat(MAX_FILE_PREVIEW_MATCHES), "a", false)
        .limited,
    ).toBeUndefined();
  });
  it("escapes literal patterns and retains Unicode source offsets", () => {
    expect(
      findFilePreviewMatches("😀 [foo] [FOO]", "[foo]", false).matches,
    ).toEqual([
      { start: 3, end: 8 },
      { start: 9, end: 14 },
    ]);
    expect(findFilePreviewMatches("text", "[", true).error).toBeTruthy();
    expect(
      findFilePreviewMatches("text", "x".repeat(2_049), false).error,
    ).toContain("2,048");
    expect(findFilePreviewMatches("text", "(?=.)", true).matches).toEqual([]);
  });
  it("preserves literal file text and highlights matches crossing syntax spans", () => {
    const content = "<tag>";
    const result = findFilePreviewMatches(content, "tag", false);
    const markup = addSearchMatchesToHighlightedHtml(
      "&lt;<span>ta</span>g&gt;",
      content,
      result.matches,
      -1,
    )!;
    const root = document.createElement("div");
    root.innerHTML = markup;
    expect(root.textContent).toBe(content);
    expect(root.querySelectorAll('mark[data-match-index="0"]')).toHaveLength(2);
    expect(root.querySelector("tag")).toBeNull();
  });
});
