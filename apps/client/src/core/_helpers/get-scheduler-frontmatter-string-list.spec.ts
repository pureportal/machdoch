import { getSchedulerFrontmatterStringList } from "./get-scheduler-frontmatter-string-list.helper.ts";

describe("getSchedulerFrontmatterStringList", () => {
  it("normalizes array values by trimming empty values and duplicates", () => {
    expect(
      getSchedulerFrontmatterStringList(
        { paths: [" src ", "", "docs", "src", "\tassets\n"] },
        "paths",
      ),
    ).toEqual(["src", "docs", "assets"]);
  });

  it("splits comma-delimited string values", () => {
    expect(
      getSchedulerFrontmatterStringList({ paths: "src, docs, , assets" }, "paths"),
    ).toEqual(["src", "docs", "assets"]);
  });

  it.each([123, true, null, undefined])(
    "returns an empty list for unsupported values %#",
    (value) => {
      expect(getSchedulerFrontmatterStringList({ paths: value }, "paths")).toEqual(
        [],
      );
    },
  );
});
