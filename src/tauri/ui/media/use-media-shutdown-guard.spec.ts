import { describe, expect, it } from "vitest";
import type {
  MediaRunStatus,
  MediaRuntimeRunRecord,
} from "../../../core/media/contracts.js";
import { getActiveMediaShutdownRuns } from "./use-media-shutdown-guard";

const createRun = (id: string, status: MediaRunStatus): MediaRuntimeRunRecord =>
  ({ id, status }) as MediaRuntimeRunRecord;

describe("getActiveMediaShutdownRuns", () => {
  it("warns only for work that can be interrupted by application shutdown", () => {
    const active = getActiveMediaShutdownRuns([
      createRun("queued", "queued"),
      createRun("running", "running"),
      createRun("canceling", "canceling"),
      createRun("human-review", "waiting-for-review"),
      createRun("provider-review", "needs-review"),
      createRun("completed", "completed"),
    ]);

    expect(active.map((run) => run.id)).toEqual([
      "queued",
      "running",
      "canceling",
    ]);
  });
});
