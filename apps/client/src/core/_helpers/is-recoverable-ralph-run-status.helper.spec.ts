import { describe, expect, it } from "vitest";
import { isRecoverableRalphRunStatus } from "./is-recoverable-ralph-run-status.helper.js";

describe("isRecoverableRalphRunStatus", () => {
  it.each(["blocked", "crashed", "stopped", "abandoned"] as const)(
    "allows recovering a %s run",
    (status) => {
      expect(isRecoverableRalphRunStatus(status)).toBe(true);
    },
  );

  it.each(["running", "completed", "waiting-for-input", "partial"] as const)(
    "does not retry a %s run",
    (status) => {
      expect(isRecoverableRalphRunStatus(status)).toBe(false);
    },
  );

  it("allows retrying an expired retained run projected as abandoned", () => {
    expect(isRecoverableRalphRunStatus("running", "abandoned")).toBe(true);
  });
});
