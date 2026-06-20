import { getSchedulerFrontmatterString } from "./get-scheduler-frontmatter-string.helper.ts";

describe("getSchedulerFrontmatterString", () => {
  it("returns trimmed string frontmatter values", () => {
    expect(getSchedulerFrontmatterString({ name: "  Daily\nReview  " }, "name")).toBe(
      "Daily\nReview",
    );
  });

  it.each([
    [{ name: "" }],
    [{ name: "   " }],
    [{ name: 123 }],
    [{ name: true }],
    [{}],
  ])("returns undefined for missing or non-string values %#", (attributes) => {
    expect(getSchedulerFrontmatterString(attributes, "name")).toBeUndefined();
  });
});
