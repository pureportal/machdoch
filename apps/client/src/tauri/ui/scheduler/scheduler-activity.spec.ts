import { describe, expect, it } from "vitest";
import { getCompletedSchedulerRunIds } from "./scheduler-activity";

describe("scheduler activity", () => {
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
