import { sortEntryNames } from "./sort-entry-names.helper.ts";

describe("sortEntryNames", () => {
  it("sorts entry names alphabetically", () => {
    expect(["zeta", "alpha", "Beta"].sort(sortEntryNames)).toEqual([
      "alpha",
      "Beta",
      "zeta",
    ]);
  });

  it("compares names case-insensitively", () => {
    expect(sortEntryNames("Readme", "readme")).toBe(0);
  });

  it("keeps empty names before non-empty names", () => {
    expect(["machdoch", "", "agent"].sort(sortEntryNames)).toEqual([
      "",
      "agent",
      "machdoch",
    ]);
  });

  it("supports path-like names without normalizing separators", () => {
    expect(
      ["src/zeta.ts", "src/Alpha.ts", "README.md"].sort(sortEntryNames),
    ).toEqual(["README.md", "src/Alpha.ts", "src/zeta.ts"]);
  });
});
