import {
  normalizeSchedulerMultilineText,
  normalizeSchedulerOptionalPositiveInteger,
  normalizeSchedulerPositiveInteger,
  normalizeSchedulerPositiveNumber,
  normalizeSchedulerText,
  normalizeSchedulerTrimmedText,
} from "./normalize-scheduler-value.helper.ts";

describe("normalizeSchedulerText", () => {
  it("collapses whitespace and trims scheduler labels", () => {
    expect(normalizeSchedulerText("  Daily\n\tReview  ")).toBe("Daily Review");
  });

  it.each([undefined, "", "   \n\t  "])(
    "returns undefined for empty text %#",
    (value) => {
      expect(normalizeSchedulerText(value)).toBeUndefined();
    },
  );
});

describe("normalizeSchedulerTrimmedText", () => {
  it("trims surrounding whitespace without collapsing internal whitespace", () => {
    expect(normalizeSchedulerTrimmedText("  line one\nline two  ")).toBe(
      "line one\nline two",
    );
  });

  it.each([undefined, "", "   "])(
    "returns undefined for missing trimmed text %#",
    (value) => {
      expect(normalizeSchedulerTrimmedText(value)).toBeUndefined();
    },
  );
});

describe("normalizeSchedulerMultilineText", () => {
  it("preserves internal multiline content while trimming edges", () => {
    expect(normalizeSchedulerMultilineText("  first\n\nsecond  ")).toBe(
      "first\n\nsecond",
    );
  });

  it("normalizes undefined multiline text to an empty string", () => {
    expect(normalizeSchedulerMultilineText(undefined)).toBe("");
  });
});

describe("normalizeSchedulerPositiveInteger", () => {
  it("truncates finite positive numbers", () => {
    expect(normalizeSchedulerPositiveInteger(3.9, 1)).toBe(3);
  });

  it.each([
    [undefined, 5],
    [0, 5],
    [-1, 5],
    [Number.NaN, 5],
    [Number.POSITIVE_INFINITY, 5],
  ])("uses fallback for invalid positive integers %#", (value, fallback) => {
    expect(normalizeSchedulerPositiveInteger(value, fallback)).toBe(fallback);
  });
});

describe("normalizeSchedulerPositiveNumber", () => {
  it("keeps finite positive decimal values", () => {
    expect(normalizeSchedulerPositiveNumber(1.25, 2)).toBe(1.25);
  });

  it.each([
    [undefined, 2],
    [0, 2],
    [-0.5, 2],
    [Number.NaN, 2],
    [Number.NEGATIVE_INFINITY, 2],
  ])("uses fallback for invalid positive numbers %#", (value, fallback) => {
    expect(normalizeSchedulerPositiveNumber(value, fallback)).toBe(fallback);
  });
});

describe("normalizeSchedulerOptionalPositiveInteger", () => {
  it("truncates finite positive numbers", () => {
    expect(normalizeSchedulerOptionalPositiveInteger(10.75)).toBe(10);
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "returns undefined for invalid optional positive integers %#",
    (value) => {
      expect(normalizeSchedulerOptionalPositiveInteger(value)).toBeUndefined();
    },
  );
});
