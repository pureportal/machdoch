import { describe, expect, it } from "vitest";
import {
  getChatOperationRecoveryAction,
  getOrphanedChatOperationIds,
} from "./chat-operation-ownership";

const current = {
  launchId: "launch-2",
  windowId: "window-1",
  instanceId: "instance-2",
};

describe("chat helper operation ownership", () => {
  it("retains work owned by the current controller instance", () => {
    expect(getChatOperationRecoveryAction(current, current, true)).toBe(
      "retain",
    );
  });

  it("cancels native work orphaned by a webview reload", () => {
    expect(
      getChatOperationRecoveryAction(
        { ...current, instanceId: "instance-1" },
        current,
        true,
      ),
    ).toBe("cancel");
  });

  it("reconciles completed work from an earlier launch", () => {
    expect(
      getChatOperationRecoveryAction(
        { ...current, launchId: "launch-1" },
        current,
        false,
      ),
    ).toBe("reconcile");
  });

  it("does not take ownership from another live window", () => {
    const owner = { ...current, windowId: "window-2" };
    expect(getChatOperationRecoveryAction(owner, current, true)).toBe("retain");
    expect(getChatOperationRecoveryAction(owner, current, false)).toBe(
      "observe",
    );
  });

  it("finds native chat work whose session was deleted", () => {
    expect(
      getOrphanedChatOperationIds(
        [
          { id: "chat-owned", kind: "chat-run", sessionId: "deleted" },
          {
            id: "interview-owned",
            kind: "task-interview",
            sessionId: "retained",
          },
          { id: "ralph-owned", kind: "ralph" },
        ],
        new Set(["retained"]),
      ),
    ).toEqual(["chat-owned"]);
  });
});
