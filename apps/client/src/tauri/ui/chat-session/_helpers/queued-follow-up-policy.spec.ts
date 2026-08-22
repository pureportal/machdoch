import { describe, expect, it } from "vitest";
import type { ChatSessionTaskOutcomeStatus } from "../../chat-session.model";
import { shouldDispatchQueuedFollowUp } from "./queued-follow-up-policy";

const terminalOutcomes: ChatSessionTaskOutcomeStatus[] = [
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
  "timed-out",
  "unsupported",
  "crashed",
];

describe("queued follow-up dispatch policy", () => {
  it("dispatches ordinary queued work only after success", () => {
    for (const status of terminalOutcomes) {
      expect(
        shouldDispatchQueuedFollowUp("after-success", { status }, false),
      ).toBe(status === "succeeded");
    }
    expect(shouldDispatchQueuedFollowUp("after-success", null, true)).toBe(
      false,
    );
    expect(shouldDispatchQueuedFollowUp("after-success", null, false)).toBe(
      false,
    );
  });

  it("dispatches stop-and-send work after every terminal outcome", () => {
    for (const status of terminalOutcomes) {
      expect(
        shouldDispatchQueuedFollowUp("after-terminal", { status }, false),
      ).toBe(true);
    }
    expect(shouldDispatchQueuedFollowUp("after-terminal", null, true)).toBe(
      false,
    );
    expect(shouldDispatchQueuedFollowUp("after-terminal", null, false)).toBe(
      true,
    );
  });
});
