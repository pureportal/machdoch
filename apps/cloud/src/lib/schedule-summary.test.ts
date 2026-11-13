import { describe, expect, it } from "vitest";
import { describeRecurrence } from "./schedule-summary";

const start = "2026-11-01T09:00:00Z";
const calendar = { start, timezone: "Europe/Berlin" };

describe("schedule recurrence summary", () => {
  it("names fixed intervals and delays in the largest whole unit", () => {
    expect(
      describeRecurrence({ kind: "interval", start, everyMs: 604_800_000 }),
    ).toBe("Every week");
    expect(
      describeRecurrence({ kind: "interval", start, everyMs: 7_200_000 }),
    ).toBe("Every 2 hours");
    expect(
      describeRecurrence({ kind: "interval", start, everyMs: 90_000 }),
    ).toBe("Every 2 minutes");
    expect(
      describeRecurrence({ kind: "fixed-delay", start, delayMs: 86_400_000 }),
    ).toBe("1 day after the previous task");
    expect(describeRecurrence({ kind: "once", at: start })).toBe("Once");
  });

  it("summarizes calendar rules with days and times", () => {
    expect(
      describeRecurrence({
        kind: "calendar",
        ...calendar,
        rules: [
          {
            frequency: "weekly",
            times: ["09:00"],
            weekdays: [{ day: 1 }, { day: 5 }],
          },
        ],
      }),
    ).toBe("Weekly on Mon, Fri at 09:00");
    expect(
      describeRecurrence({
        kind: "calendar",
        ...calendar,
        rules: [
          { frequency: "daily", interval: 2, times: ["08:00", "17:30"] },
          { frequency: "monthly", times: ["12:00"] },
        ],
      }),
    ).toBe("Every 2 days at 08:00, 17:30 +1 more");
    expect(
      describeRecurrence({
        kind: "cron",
        ...calendar,
        expression: "0 9 * * 1-5",
      }),
    ).toBe("Cron 0 9 * * 1-5");
  });
});
