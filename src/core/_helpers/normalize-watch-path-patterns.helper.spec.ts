import { normalizeWatchPathPatterns } from "./normalize-watch-path-patterns.helper.ts";

describe("normalizeWatchPathPatterns", () => {
  it("trims values, normalizes separators, removes blanks, and preserves first-seen order", () => {
    expect(
      normalizeWatchPathPatterns([
        "  src\\core  ",
        "",
        "docs",
        "src/core",
        "\tassets\\images\n",
      ]),
    ).toEqual(["src/core", "docs", "assets/images"]);
  });

  it.each([
    ["undefined", undefined],
    ["empty list", []],
    ["blank-only list", ["", "   ", "\n\t"]],
  ])("returns an empty list for %s", (_label, values) => {
    expect(normalizeWatchPathPatterns(values)).toEqual([]);
  });

  it("treats differently cased patterns as distinct", () => {
    expect(normalizeWatchPathPatterns(["Src/**", "src/**"])).toEqual([
      "Src/**",
      "src/**",
    ]);
  });
});
