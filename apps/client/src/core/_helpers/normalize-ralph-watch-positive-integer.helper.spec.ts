import { normalizeRalphWatchPositiveInteger } from "./normalize-ralph-watch-positive-integer.helper.ts";

describe("normalizeRalphWatchPositiveInteger", () => {
  it.each([
    [1, 99, 1],
    [12, 99, 12],
  ])("keeps positive integer %s", (value, fallback, expected) => {
    expect(normalizeRalphWatchPositiveInteger(value, fallback)).toBe(expected);
  });

  it.each([
    [undefined, 5],
    [0, 5],
    [-1, 5],
    [1.5, 5],
    [Number.NaN, 5],
    [Number.POSITIVE_INFINITY, 5],
  ])("uses fallback for invalid value %#", (value, fallback) => {
    expect(normalizeRalphWatchPositiveInteger(value, fallback)).toBe(fallback);
  });
});
