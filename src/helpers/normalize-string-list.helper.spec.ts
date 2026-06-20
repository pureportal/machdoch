import { normalizeStringList } from "./normalize-string-list.helper.ts";

describe("normalizeStringList", () => {
  it("trims values, removes blanks, and preserves first-seen order", () => {
    expect(
      normalizeStringList(["  src  ", "", "docs", "src", "\tassets\n"]),
    ).toEqual(["src", "docs", "assets"]);
  });

  it.each([
    ["undefined", undefined],
    ["empty list", []],
    ["blank-only list", ["", "   ", "\n\t"]],
  ])("returns an empty list for %s", (_label, values) => {
    expect(normalizeStringList(values)).toEqual([]);
  });

  it("treats differently cased values as distinct", () => {
    expect(normalizeStringList(["Machdoch", "machdoch"])).toEqual([
      "Machdoch",
      "machdoch",
    ]);
  });

  it("does not normalize path separators", () => {
    expect(normalizeStringList(["src\\core", "src/core"])).toEqual([
      "src\\core",
      "src/core",
    ]);
  });
});
