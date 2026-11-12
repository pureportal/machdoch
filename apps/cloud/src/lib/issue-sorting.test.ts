import { describe, expect, it } from "vitest";
import type { CloudIssueSummary } from "./cloud-contract";
import { sortIssues } from "./issue-sorting";

function issue(
  identifier: string,
  fields: Partial<CloudIssueSummary> = {},
): CloudIssueSummary {
  return {
    identifier,
    title: identifier,
    priority: "none",
    state: "backlog",
    estimatePoints: null,
    dueOn: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...fields,
  } as CloudIssueSummary;
}

const ids = (issues: CloudIssueSummary[]) =>
  issues.map((entry) => entry.identifier);

describe("issue sorting", () => {
  const issues = [
    issue("PLAT-10", {
      title: "beta",
      priority: "low",
      estimatePoints: 3,
      dueOn: "2026-12-01",
      state: "complete",
    }),
    issue("PLAT-2", {
      title: "Alpha",
      priority: "urgent",
      estimatePoints: 8,
      state: "active",
      updatedAt: "2026-11-05T00:00:00.000Z",
    }),
    issue("ENG-3", { title: "gamma", dueOn: "2026-11-20", state: "triage" }),
  ];

  it("orders by each key with its natural direction", () => {
    expect(ids(sortIssues(issues, "priority"))).toEqual([
      "PLAT-2",
      "PLAT-10",
      "ENG-3",
    ]);
    expect(ids(sortIssues(issues, "estimate"))).toEqual([
      "PLAT-2",
      "PLAT-10",
      "ENG-3",
    ]);
    expect(ids(sortIssues(issues, "due"))).toEqual([
      "ENG-3",
      "PLAT-10",
      "PLAT-2",
    ]);
    expect(ids(sortIssues(issues, "status"))).toEqual([
      "ENG-3",
      "PLAT-2",
      "PLAT-10",
    ]);
    expect(ids(sortIssues(issues, "title"))).toEqual([
      "PLAT-2",
      "PLAT-10",
      "ENG-3",
    ]);
    expect(ids(sortIssues(issues, "identifier"))).toEqual([
      "ENG-3",
      "PLAT-2",
      "PLAT-10",
    ]);
    expect(ids(sortIssues(issues, "updated"))[0]).toBe("PLAT-2");
  });

  it("reverses the order but keeps missing values last", () => {
    expect(ids(sortIssues(issues, "due", true))).toEqual([
      "PLAT-10",
      "ENG-3",
      "PLAT-2",
    ]);
    expect(ids(sortIssues(issues, "priority", true))).toEqual([
      "PLAT-10",
      "PLAT-2",
      "ENG-3",
    ]);
    expect(ids(sortIssues(issues, "estimate", true))).toEqual([
      "PLAT-10",
      "PLAT-2",
      "ENG-3",
    ]);
  });

  it("breaks ties by recent activity and leaves the input untouched", () => {
    const tied = [
      issue("A-1"),
      issue("A-2", { updatedAt: "2026-11-09T00:00:00.000Z" }),
    ];
    expect(ids(sortIssues(tied, "priority"))).toEqual(["A-2", "A-1"]);
    expect(ids(tied)).toEqual(["A-1", "A-2"]);
  });
});
