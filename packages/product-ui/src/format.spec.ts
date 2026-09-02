import { describe, expect, it } from "vitest";
import {
  formatRelativeTime,
  formatTimestamp,
  formatTimestampDateTime,
} from "./format";

describe("timestamp formatting", () => {
  it("formats valid timestamps with an ISO datetime value", () => {
    const timestamp = Date.UTC(2026, 0, 2, 3, 4, 5);

    expect(formatTimestampDateTime(timestamp)).toBe("2026-01-02T03:04:05.000Z");
    expect(formatTimestamp(timestamp)).not.toBe("—");
  });

  it("uses safe values for out-of-range timestamps", () => {
    const timestamp = 9_000_000_000_000_000;

    expect(formatTimestampDateTime(timestamp)).toBeUndefined();
    expect(formatTimestamp(timestamp)).toBe("—");
    expect(formatRelativeTime(timestamp)).toBe("—");
  });
});
