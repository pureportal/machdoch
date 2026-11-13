import { describe, expect, it } from "vitest";
import { parseIssueViewOptions, visibleIssues } from "./issue-view-options";

const now = Date.parse("2026-11-13T12:00:00Z");
const daysAgo = (days: number) =>
  new Date(now - days * 86_400_000).toISOString();
const issues = [
  {
    id: "open",
    state: "active" as const,
    updatedAt: daysAgo(90),
    parent: null,
  },
  {
    id: "recent",
    state: "complete" as const,
    updatedAt: daysAgo(2),
    parent: null,
  },
  {
    id: "older",
    state: "canceled" as const,
    updatedAt: daysAgo(20),
    parent: null,
  },
  {
    id: "old",
    state: "complete" as const,
    updatedAt: daysAgo(60),
    parent: null,
  },
  {
    id: "child",
    state: "ready" as const,
    updatedAt: daysAgo(1),
    parent: { id: "open", identifier: "TM-1", title: "Open" },
  },
];
const ids = (list: { id: string }[]) => list.map((issue) => issue.id);

describe("parseIssueViewOptions", () => {
  it("falls back to defaults for unknown values", () => {
    expect(
      parseIssueViewOptions(
        new URLSearchParams("density=huge&completed=decade&view=table"),
      ),
    ).toEqual({
      board: false,
      density: "comfortable",
      completed: "all",
      subIssues: true,
      emptyGroups: false,
    });
  });

  it("reads every option", () => {
    expect(
      parseIssueViewOptions(
        new URLSearchParams(
          "view=board&density=compact&completed=week&subIssues=hide&empty=show",
        ),
      ),
    ).toEqual({
      board: true,
      density: "compact",
      completed: "week",
      subIssues: false,
      emptyGroups: true,
    });
  });
});

describe("visibleIssues", () => {
  const options = parseIssueViewOptions(new URLSearchParams());

  it("limits completed issues to the chosen window", () => {
    expect(ids(visibleIssues(issues, options, now))).toHaveLength(5);
    expect(
      ids(visibleIssues(issues, { ...options, completed: "week" }, now)),
    ).toEqual(["open", "recent", "child"]);
    expect(
      ids(visibleIssues(issues, { ...options, completed: "month" }, now)),
    ).toEqual(["open", "recent", "older", "child"]);
    expect(
      ids(visibleIssues(issues, { ...options, completed: "none" }, now)),
    ).toEqual(["open", "child"]);
  });

  it("hides sub-issues on request", () => {
    expect(
      ids(visibleIssues(issues, { ...options, subIssues: false }, now)),
    ).not.toContain("child");
  });
});
