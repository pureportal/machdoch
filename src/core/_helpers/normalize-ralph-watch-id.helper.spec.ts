import { normalizeRalphWatchId } from "./normalize-ralph-watch-id.helper.ts";

describe("normalizeRalphWatchId", () => {
  it.each([
    ["spaces and punctuation", "  Nightly Import! ", "nightly-import"],
    ["underscores", "watch_daily_run", "watch-daily-run"],
    ["long ids", "x".repeat(100), "x".repeat(80)],
  ])("normalizes %s", (_label, value, expected) => {
    expect(normalizeRalphWatchId(value)).toBe(expected);
  });

  it.each(["", "   ", undefined])("creates a fallback id for %s", (value) => {
    expect(normalizeRalphWatchId(value)).toMatch(/^watch-/u);
  });
});
