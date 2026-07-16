import { describe, expect, it } from "vitest";
import { createTaskTimeoutIndicator } from "./task-timeout-indicator.helper.js";

describe("createTaskTimeoutIndicator", () => {
  it("uses the nearer idle deadline", () => {
    expect(
      createTaskTimeoutIndicator(
        {
          startedAt: 0,
          lastActivityAt: 400,
          idleTimeoutMs: 1_000,
          absoluteTimeoutMs: 5_000,
        },
        900,
      ),
    ).toEqual({
      kind: "idle",
      progress: 0.5,
      progressPercent: 50,
      remainingMs: 500,
    });
  });

  it("uses the absolute deadline when activity cannot extend it", () => {
    expect(
      createTaskTimeoutIndicator(
        {
          startedAt: 0,
          lastActivityAt: 4_800,
          idleTimeoutMs: 1_000,
          absoluteTimeoutMs: 5_000,
        },
        4_900,
      ),
    ).toMatchObject({
      kind: "absolute",
      progressPercent: 98,
      remainingMs: 100,
    });
  });

  it("returns no indicator when both limits are disabled", () => {
    expect(
      createTaskTimeoutIndicator(
        {
          startedAt: 0,
          lastActivityAt: 0,
          idleTimeoutMs: null,
          absoluteTimeoutMs: null,
        },
        500,
      ),
    ).toBeUndefined();
  });
});
