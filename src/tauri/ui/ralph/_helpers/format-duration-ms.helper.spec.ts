import {
  formatDurationMs,
  formatRunRecordDuration,
  getTimestampMs,
} from "./format-duration-ms.helper";

describe("Ralph run duration helpers", () => {
  it.each([
    [-1, "0s"],
    [Number.NaN, "0s"],
    [0, "0ms"],
    [499.4, "499ms"],
    [999.6, "1000ms"],
    [1_000, "1s"],
    [1_499, "1s"],
    [1_500, "2s"],
    [59_500, "1m 0s"],
    [60_000, "1m 0s"],
    [61_400, "1m 1s"],
    [3_600_000, "1h 0m"],
    [3_660_000, "1h 1m"],
  ])("formats %s milliseconds as %s", (durationMs, expected) => {
    expect(formatDurationMs(durationMs)).toBe(expected);
  });

  it("parses valid timestamps and rejects empty or invalid timestamps", () => {
    expect(getTimestampMs("2026-06-19T10:00:00.000Z")).toBe(
      Date.parse("2026-06-19T10:00:00.000Z"),
    );
    expect(getTimestampMs("")).toBeNull();
    expect(getTimestampMs(null)).toBeNull();
    expect(getTimestampMs(undefined)).toBeNull();
    expect(getTimestampMs("not-a-date")).toBeNull();
  });

  it("formats run record durations when both timestamps are valid", () => {
    expect(
      formatRunRecordDuration({
        createdAt: "2026-06-19T10:00:00.000Z",
        finishedAt: "2026-06-19T10:02:03.000Z",
      }),
    ).toBe("2m 3s");
  });

  it("returns null for missing or invalid run record timestamps", () => {
    expect(
      formatRunRecordDuration({
        createdAt: "2026-06-19T10:00:00.000Z",
      }),
    ).toBeNull();
    expect(
      formatRunRecordDuration({
        createdAt: "invalid",
        finishedAt: "2026-06-19T10:02:03.000Z",
      }),
    ).toBeNull();
  });

  it("clamps negative finished-before-started durations to zero seconds", () => {
    expect(
      formatRunRecordDuration({
        createdAt: "2026-06-19T10:02:03.000Z",
        finishedAt: "2026-06-19T10:00:00.000Z",
      }),
    ).toBe("0s");
  });
});
