import { describe, expect, it } from "vitest";
import { issueGroupSummary } from "./issue-group-summary";

describe("issue group summary", () => {
  it("counts issues and sums estimates, treating unestimated issues as zero", () => {
    expect(
      issueGroupSummary([
        { estimatePoints: 3 },
        { estimatePoints: null },
        { estimatePoints: 5 },
        { estimatePoints: 0 },
      ]),
    ).toEqual({ count: 4, estimate: 8 });
  });

  it("returns zero for an empty group", () => {
    expect(issueGroupSummary([])).toEqual({ count: 0, estimate: 0 });
  });
});
