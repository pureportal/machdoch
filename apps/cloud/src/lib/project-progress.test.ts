import { describe, expect, it } from "vitest";
import { daysUntil, projectStateBreakdown } from "./project-progress";

describe("project progress", () => {
  it("counts open work by state in delivery order and skips canceled or archived issues", () => {
    expect(
      projectStateBreakdown([
        { state: "backlog", archived: false },
        { state: "complete", archived: false },
        { state: "active", archived: false },
        { state: "backlog", archived: false },
        { state: "canceled", archived: false },
        { state: "complete", archived: true },
      ]),
    ).toEqual({
      total: 4,
      segments: [
        { state: "complete", count: 1 },
        { state: "active", count: 1 },
        { state: "backlog", count: 2 },
      ],
    });
    expect(projectStateBreakdown([])).toEqual({ total: 0, segments: [] });
  });

  it("counts calendar days to the target date", () => {
    expect(daysUntil("2026-11-20", "2026-11-12")).toBe(8);
    expect(daysUntil("2026-11-12", "2026-11-12")).toBe(0);
    expect(daysUntil("2026-11-01", "2026-11-12")).toBe(-11);
    expect(daysUntil("2027-03-29", "2027-03-27")).toBe(2);
  });
});
