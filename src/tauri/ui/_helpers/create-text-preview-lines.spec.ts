import { createTextPreviewLines } from "./create-text-preview-lines.helper";

describe("createTextPreviewLines", () => {
  it("normalizes line endings, trims outer whitespace, and limits lines", () => {
    expect(createTextPreviewLines(" first\r\nsecond\rthird\nfourth ", 2, 20)).toEqual([
      "first",
      "second",
      "…",
    ]);
  });

  it("truncates long lines at the requested boundary", () => {
    expect(createTextPreviewLines("abcdef", 3, 4)).toEqual(["abc…"]);
  });

  it("returns no preview for empty, nullish, or invalid limits", () => {
    expect(createTextPreviewLines("   ")).toEqual([]);
    expect(createTextPreviewLines(null)).toEqual([]);
    expect(createTextPreviewLines(undefined)).toEqual([]);
    expect(createTextPreviewLines("body", 0)).toEqual([]);
    expect(createTextPreviewLines("body", 1, 1)).toEqual([]);
  });
});
