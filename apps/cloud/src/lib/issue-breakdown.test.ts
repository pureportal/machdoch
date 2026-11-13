import { describe, expect, it } from "vitest";
import { issueBreakdown } from "./issue-breakdown";

const label = (id: string) => ({ id, name: id, color: "blue" });
const issues = [
  {
    state: "complete" as const,
    assigneeId: "a",
    projectId: "p",
    labels: [label("bug")],
    estimatePoints: 3,
  },
  {
    state: "active" as const,
    assigneeId: "a",
    projectId: null,
    labels: [label("bug"), label("ui")],
    estimatePoints: 2,
  },
  {
    state: "ready" as const,
    assigneeId: null,
    projectId: "p",
    labels: [],
    estimatePoints: null,
  },
  {
    state: "canceled" as const,
    assigneeId: "b",
    projectId: "p",
    labels: [],
    estimatePoints: 5,
  },
];

describe("issueBreakdown", () => {
  it("counts progress per assignee with unassigned last", () => {
    expect(issueBreakdown(issues, "assignee")).toEqual([
      { id: "a", total: 2, completed: 1, points: 5 },
      { id: null, total: 1, completed: 0, points: 0 },
    ]);
  });

  it("counts an issue once for each of its labels", () => {
    expect(issueBreakdown(issues, "label")).toEqual([
      { id: "bug", total: 2, completed: 1, points: 5 },
      { id: "ui", total: 1, completed: 0, points: 2 },
      { id: null, total: 1, completed: 0, points: 0 },
    ]);
  });

  it("groups by project", () => {
    expect(issueBreakdown(issues, "project").map((entry) => entry.id)).toEqual([
      "p",
      null,
    ]);
  });
});
