import { describe, expect, it } from "vitest";
import { isMediaRunActive } from "./media-run-activity";

describe("Media Studio run activity", () => {
  it("ignores orphaned queued work that has no resumable worker", () => {
    expect(
      isMediaRunActive({
        id: "run:orphaned-local-video",
        status: "queued",
        executor: "local-wan-video",
      }),
    ).toBe(false);
  });

  it("keeps running and resumable queued work active", () => {
    expect(
      isMediaRunActive({
        id: "run:local-video",
        status: "running",
        executor: "local-wan-video",
      }),
    ).toBe(true);
    expect(
      isMediaRunActive({
        id: "run:fixture",
        status: "queued",
        executor: "deterministic-fixture",
      }),
    ).toBe(true);
    expect(
      isMediaRunActive({
        id: "run:remote",
        status: "queued",
        executor: "mock-remote-provider",
      }),
    ).toBe(true);
  });
});
