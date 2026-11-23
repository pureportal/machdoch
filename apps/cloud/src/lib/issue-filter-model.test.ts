import { describe, expect, it } from "vitest";
import {
  decodeIssueFilter,
  encodeIssueFilter,
  issueFilterConditionSchema,
  issueFilterGroupSchema,
  issueFilterOperatorsFor,
  parseIssueFilterTree,
  withIssueFilterTree,
  type IssueFilterTree,
} from "./issue-filter-model";

const first = "6f1c6f2e-4b1a-4c7e-9a52-1d1f0d3c2b10";
const second = "0b8e2f5a-93d4-4e61-8f0c-5a7b9c1d2e3f";

const valid = (condition: unknown) =>
  issueFilterConditionSchema.safeParse(condition).success;

describe("issue filter conditions", () => {
  it("parses legacy multi-value and negated keys and drops invalid values", () => {
    expect(
      parseIssueFilterTree({
        priority: "high,urgent,high,bogus",
        "assignee.not": `me,none,${first}`,
        label: `${first}, ${second}`,
        due: "someday",
        teamId: first,
        "created.not": ["week"],
      }),
    ).toEqual({
      conditions: [
        { field: "assignee", negated: true, values: ["me", "none", first] },
        { field: "priority", negated: false, values: ["high", "urgent"] },
        { field: "label", negated: false, values: [first, second] },
      ],
      groups: [],
    });
  });

  it("round-trips operators, negation and OR groups through the filter parameter", () => {
    const tree: IssueFilterTree = {
      conditions: [
        { field: "label", negated: false, operator: "all", values: [first, second] },
        { field: "estimate", negated: true, values: ["3", "5"] },
        { field: "blocked", negated: true, values: ["yes"] },
        { field: "assignee", negated: false, operator: "empty", values: [] },
        { field: "due", negated: false, operator: "before", values: ["2026-03-01"] },
        { field: "created", negated: false, operator: "within", values: ["14"] },
      ],
      groups: [
        [
          { field: "cycle", negated: false, values: ["current"] },
          { field: "cycle", negated: false, values: ["upcoming"] },
        ],
      ],
    };
    const encoded = encodeIssueFilter(tree);
    expect(decodeIssueFilter(encoded)).toEqual(tree);
    expect(parseIssueFilterTree({ filter: encoded })).toEqual(tree);
  });

  it("replaces legacy keys with one filter parameter and keeps other parameters", () => {
    const search = new URLSearchParams({ teamId: first, priority: "low" });
    const next = withIssueFilterTree(search, {
      conditions: [{ field: "priority", negated: true, values: ["low", "none"] }],
      groups: [],
    });
    expect(next.get("priority")).toBeNull();
    expect(next.get("teamId")).toBe(first);
    expect(parseIssueFilterTree(Object.fromEntries(next))).toEqual({
      conditions: [{ field: "priority", negated: true, values: ["low", "none"] }],
      groups: [],
    });
    expect(
      withIssueFilterTree(next, { conditions: [], groups: [] }).toString(),
    ).toBe(`teamId=${first}`);
    expect(search.get("priority")).toBe("low");
  });

  it("ignores malformed terms and collapses single-member groups", () => {
    expect(
      decodeIssueFilter(`bogus:1;priority:high;(status:${first});label.before:x`),
    ).toEqual({
      conditions: [
        { field: "priority", negated: false, values: ["high"] },
        { field: "status", negated: false, values: [first] },
      ],
      groups: [],
    });
  });

  it("validates values and operators per field", () => {
    expect(valid({ field: "creator", negated: false, values: ["none"] })).toBe(false);
    expect(valid({ field: "status", negated: false, values: [first, first] })).toBe(false);
    expect(valid({ field: "due", negated: true, values: ["overdue", "none"] })).toBe(true);
    expect(valid({ field: "status", negated: false, operator: "all", values: [first] })).toBe(false);
    expect(valid({ field: "label", negated: false, operator: "all", values: [first] })).toBe(true);
    expect(valid({ field: "label", negated: false, operator: "empty", values: [first] })).toBe(false);
    expect(valid({ field: "creator", negated: false, operator: "empty", values: [] })).toBe(false);
    expect(valid({ field: "due", negated: false, operator: "after", values: ["2026-02-30"] })).toBe(false);
    expect(valid({ field: "updated", negated: false, operator: "within", values: ["0"] })).toBe(false);
    expect(valid({ field: "updated", negated: false, operator: "within", values: ["30"] })).toBe(true);
    expect(valid({ field: "blocking", negated: false, values: ["no"] })).toBe(false);
    expect(valid({ field: "estimate", negated: false, values: ["a,b"] })).toBe(false);
    expect(valid({ field: "cycle", negated: false, values: ["previous", first] })).toBe(true);
    expect(issueFilterOperatorsFor("label")).toEqual(["all", "empty"]);
    expect(issueFilterOperatorsFor("due")).toEqual(["empty", "before", "after", "within"]);
    expect(issueFilterOperatorsFor("hasParent")).toEqual([]);
  });

  it("requires OR groups to hold two to ten valid conditions", () => {
    const condition = { field: "priority", negated: false, values: ["high"] };
    expect(issueFilterGroupSchema.safeParse([condition]).success).toBe(false);
    expect(issueFilterGroupSchema.safeParse([condition, condition]).success).toBe(true);
    expect(
      issueFilterGroupSchema.safeParse(Array.from({ length: 11 }, () => condition)).success,
    ).toBe(false);
  });
});
