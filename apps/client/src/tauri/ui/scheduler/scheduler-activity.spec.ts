import { describe, expect, it } from "vitest";
import {
  getCompletedSchedulerRunIds,
  mergeSchedulerActivityStatuses,
} from "./scheduler-activity";

describe("scheduler activity", () => {
  it("keeps failed workspaces active while applying successful completion updates", () => {
    const previous = new Map([
      ["first\0run-1", "running" as const],
      ["second\0run-1", "running" as const],
    ]);
    const statuses = mergeSchedulerActivityStatuses(previous, [
      { workspaceRoot: "first", error: "Workspace is unavailable" },
      { workspaceRoot: "second", runs: [{ id: "run-1", status: "succeeded" }] },
    ]);

    expect(statuses.get("first\0run-1")).toBe("running");
    expect(getCompletedSchedulerRunIds(previous, statuses)).toEqual([
      "second\0run-1",
    ]);
  });

  it("removes pruned runs after the workspace is readable again", () => {
    const previous = new Map([["first\0run-1", "running" as const]]);
    const statuses = mergeSchedulerActivityStatuses(previous, [
      { workspaceRoot: "first", runs: [] },
    ]);
    expect(getCompletedSchedulerRunIds(previous, statuses)).toEqual([
      "first\0run-1",
    ]);
  });

  it("records a terminal run while another run remains active", () => {
    expect(
      getCompletedSchedulerRunIds(
        new Map([
          ["run-1", "running"],
          ["run-2", "queued"],
        ]),
        new Map([
          ["run-1", "failed"],
          ["run-2", "running"],
        ]),
      ),
    ).toEqual(["run-1"]);
  });

  it("records an active run that leaves the durable run listing", () => {
    expect(
      getCompletedSchedulerRunIds(new Map([["run-1", "running"]]), new Map()),
    ).toEqual(["run-1"]);
  });
});
