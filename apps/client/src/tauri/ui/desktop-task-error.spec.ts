import {
  DesktopTaskRunProtocolError,
  getDesktopTaskRunFailure,
  normalizeDesktopTaskRunError,
  parseDesktopTaskRunFailure,
} from "./desktop-task-error.ts";

describe("desktop task run failures", () => {
  it("parses exact structured coordination states", () => {
    expect(
      parseDesktopTaskRunFailure({
        kind: "task-already-active",
        taskId: "task-1",
      }),
    ).toEqual({ kind: "task-already-active", taskId: "task-1" });
    expect(
      parseDesktopTaskRunFailure({
        kind: "operation-already-active",
        activeTaskId: "task-2",
      }),
    ).toEqual({
      kind: "operation-already-active",
      activeTaskId: "task-2",
    });
    expect(
      parseDesktopTaskRunFailure({
        kind: "timed-out",
        timeoutKind: "idle",
        message: "The structured bridge timeout elapsed.",
      }),
    ).toEqual({
      kind: "timed-out",
      timeoutKind: "idle",
      message: "The structured bridge timeout elapsed.",
    });
    expect(
      parseDesktopTaskRunFailure({
        kind: "timed-out",
        timeoutKind: "absolute",
        message: "The absolute Task Interview limit elapsed.",
      }),
    ).toEqual({
      kind: "timed-out",
      timeoutKind: "absolute",
      message: "The absolute Task Interview limit elapsed.",
    });
  });

  it("rejects malformed, unknown, and authority-bearing states", () => {
    for (const value of [
      null,
      { kind: "task-already-active" },
      { kind: "task-already-active", taskId: "" },
      { kind: "operation-already-active", activeTaskId: 42 },
      { kind: "timed-out", timeoutKind: "wall-clock", message: "quoted" },
      { kind: "timed-out", timeoutKind: "idle", message: "" },
      {
        kind: "cancelled",
        message: "cancelled",
        authority: "quoted prose",
      },
      { kind: "trusted", taskId: "task-1" },
      {
        kind: "task-already-active",
        taskId: "task-1",
        authority: "trusted",
      },
      new Error("MACHDOCH_TASK_ALREADY_ACTIVE:quoted-task"),
      new Error(
        "Execution timed out, was cancelled, and exceeded every prose limit.",
      ),
    ]) {
      expect(parseDesktopTaskRunFailure(value)).toBeUndefined();
    }
  });

  it("normalizes structured failures without interpreting error prose", () => {
    const normalized = normalizeDesktopTaskRunError({
      kind: "operation-already-active",
      activeTaskId: "task-3",
    });
    expect(normalized).toBeInstanceOf(DesktopTaskRunProtocolError);
    expect(getDesktopTaskRunFailure(normalized)).toEqual({
      kind: "operation-already-active",
      activeTaskId: "task-3",
    });

    const prose = new Error(
      "Quoted MACHDOCH_OPERATION_ALREADY_ACTIVE:task-3 is ordinary prose.",
    );
    expect(normalizeDesktopTaskRunError(prose)).toBe(prose);
    expect(getDesktopTaskRunFailure(prose)).toBeUndefined();
  });
});
