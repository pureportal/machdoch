import { describe, expect, it } from "vitest";
import {
  issueFilterOperatorChoices,
  primaryIssueFilterIndex,
  removeIssueFilterGroup,
  toggleIssueFilterValue,
  withIssueFilterOperator,
  withoutIssueFilterFields,
} from "./issue-filter-editing";
import type { IssueFilterTree } from "./issue-filter-model";

const first = "6f1c6f2e-4b1a-4c7e-9a52-1d1f0d3c2b10";
const second = "0b8e2f5a-93d4-4e61-8f0c-5a7b9c1d2e3f";
const empty: IssueFilterTree = { conditions: [], groups: [] };

describe("issue filter editing", () => {
  it("offers operators that match the field", () => {
    expect(issueFilterOperatorChoices("label")).toEqual([
      { negated: false },
      { negated: false, operator: "all" },
      { negated: true },
      { negated: false, operator: "empty" },
      { negated: true, operator: "empty" },
    ]);
    expect(issueFilterOperatorChoices("created")).toEqual([
      { negated: false },
      { negated: true },
      { negated: false, operator: "before" },
      { negated: false, operator: "after" },
      { negated: false, operator: "within" },
    ]);
    expect(issueFilterOperatorChoices("blocked")).toEqual([
      { negated: false },
      { negated: true },
    ]);
  });

  it("switches operators while keeping compatible values", () => {
    const labels = { field: "label" as const, negated: false, values: [first, second] };
    expect(withIssueFilterOperator(labels, { negated: false, operator: "all" }, "2026-01-01", first)).toEqual({
      ...labels,
      operator: "all",
    });
    expect(withIssueFilterOperator(labels, { negated: true, operator: "empty" }, "2026-01-01", first)).toEqual({
      field: "label",
      negated: true,
      operator: "empty",
      values: [],
    });
    const due = { field: "due" as const, negated: false, values: ["week"] };
    const before = withIssueFilterOperator(due, { negated: false, operator: "before" }, "2026-01-01", "overdue");
    expect(before).toEqual({ field: "due", negated: false, operator: "before", values: ["2026-01-01"] });
    expect(withIssueFilterOperator(before!, { negated: false, operator: "after" }, "2026-05-05", "overdue")?.values).toEqual(["2026-01-01"]);
    expect(withIssueFilterOperator(before!, { negated: true }, "2026-01-01", "overdue")).toEqual({
      field: "due",
      negated: true,
      values: ["overdue"],
    });
    expect(withIssueFilterOperator(before!, { negated: true }, "2026-01-01", undefined)).toBeNull();
    expect(withIssueFilterOperator(due, { negated: false, operator: "within" }, "2026-01-01", "overdue")?.values).toEqual(["7"]);
  });

  it("toggles values on the primary positive condition only", () => {
    const negated: IssueFilterTree = {
      conditions: [{ field: "label", negated: true, values: [first] }],
      groups: [],
    };
    expect(primaryIssueFilterIndex(negated, "label")).toBe(-1);
    const added = toggleIssueFilterValue(negated, "label", second);
    expect(added.conditions).toEqual([
      { field: "label", negated: true, values: [first] },
      { field: "label", negated: false, values: [second] },
    ]);
    const extended = toggleIssueFilterValue(added, "label", first);
    expect(extended.conditions[1]?.values).toEqual([second, first]);
    const removed = toggleIssueFilterValue(
      toggleIssueFilterValue(extended, "label", second),
      "label",
      first,
    );
    expect(removed.conditions).toEqual(negated.conditions);
    expect(toggleIssueFilterValue(empty, "priority", "high").conditions).toEqual([
      { field: "priority", negated: false, values: ["high"] },
    ]);
  });

  it("removes fields from conditions and groups and dissolves groups that shrink to one", () => {
    const tree: IssueFilterTree = {
      conditions: [{ field: "project", negated: false, values: [first] }],
      groups: [
        [
          { field: "project", negated: false, values: [second] },
          { field: "priority", negated: false, values: ["high"] },
        ],
        [
          { field: "cycle", negated: false, values: ["current"] },
          { field: "cycle", negated: false, values: ["upcoming"] },
        ],
      ],
    };
    expect(withoutIssueFilterFields(tree, ["project"])).toEqual({
      conditions: [{ field: "priority", negated: false, values: ["high"] }],
      groups: [tree.groups[1]],
    });
    expect(removeIssueFilterGroup(tree, 0).groups).toEqual([tree.groups[1]]);
  });
});
