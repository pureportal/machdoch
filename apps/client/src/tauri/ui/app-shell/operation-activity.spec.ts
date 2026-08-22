import { describe, expect, it } from "vitest";
import {
  getCompletedOperationIds,
  toAppActivityState,
} from "./operation-activity";

describe("operation activity", () => {
  it("records one concurrent completion while another operation remains active", () => {
    expect(
      getCompletedOperationIds(
        new Set(["chat-1", "chat-2"]),
        new Set(["chat-2"]),
      ),
    ).toEqual(["chat-1"]);
    expect(toAppActivityState(true, true)).toBe("running-and-completed");
  });

  it("tracks helper operations by identity", () => {
    expect(
      getCompletedOperationIds(
        new Set(["prompt-enhancement-1", "task-interview-1"]),
        new Set(["task-interview-1"]),
      ),
    ).toEqual(["prompt-enhancement-1"]);
  });
});
