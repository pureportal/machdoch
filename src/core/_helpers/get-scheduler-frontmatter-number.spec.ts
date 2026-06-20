import { getSchedulerFrontmatterNumber } from "./get-scheduler-frontmatter-number.helper.ts";

describe("getSchedulerFrontmatterNumber", () => {
  it.each([
    [42, 42],
    [0, 0],
    [-3, -3],
    [1.25, 1.25],
    [" 5000 ", 5000],
    ["0", 0],
    ["", 0],
  ])("parses finite numeric frontmatter values %#", (value, expected) => {
    expect(getSchedulerFrontmatterNumber({ delay: value }, "delay")).toBe(expected);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "not-a-number",
    true,
    null,
    undefined,
  ])("returns undefined for non-finite or unsupported values %#", (value) => {
    expect(getSchedulerFrontmatterNumber({ delay: value }, "delay")).toBeUndefined();
  });
});
