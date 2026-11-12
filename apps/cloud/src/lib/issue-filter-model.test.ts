import { describe, expect, it } from "vitest";
import {
  issueFilterConditionSchema,
  parseIssueFilterConditions,
  withIssueFilterCondition,
} from "./issue-filter-model";

const first = "6f1c6f2e-4b1a-4c7e-9a52-1d1f0d3c2b10";
const second = "0b8e2f5a-93d4-4e61-8f0c-5a7b9c1d2e3f";

describe("issue filter conditions", () => {
  it("parses multi-value and negated conditions and drops invalid values", () => {
    expect(
      parseIssueFilterConditions({
        priority: "high,urgent,high,bogus",
        "assignee.not": `me,none,${first}`,
        label: `${first}, ${second}`,
        due: "someday",
        teamId: first,
        "created.not": ["week"],
      }),
    ).toEqual([
      { field: "assignee", negated: true, values: ["me", "none", first] },
      { field: "priority", negated: false, values: ["high", "urgent"] },
      { field: "label", negated: false, values: [first, second] },
    ]);
  });

  it("keeps one condition per field in the URL", () => {
    const search = new URLSearchParams({ teamId: first, priority: "low" });
    const negated = withIssueFilterCondition(search, "priority", {
      negated: true,
      values: ["low", "none"],
    });
    expect(negated.get("priority")).toBeNull();
    expect(negated.get("priority.not")).toBe("low,none");
    expect(negated.get("teamId")).toBe(first);
    expect(withIssueFilterCondition(negated, "priority", null).toString()).toBe(
      `teamId=${first}`,
    );
    expect(search.get("priority")).toBe("low");
  });

  it("validates values per field", () => {
    expect(
      issueFilterConditionSchema.safeParse({
        field: "creator",
        negated: false,
        values: ["none"],
      }).success,
    ).toBe(false);
    expect(
      issueFilterConditionSchema.safeParse({
        field: "status",
        negated: false,
        values: [first, first],
      }).success,
    ).toBe(false);
    expect(
      issueFilterConditionSchema.safeParse({
        field: "due",
        negated: true,
        values: ["overdue", "none"],
      }).success,
    ).toBe(true);
  });
});
