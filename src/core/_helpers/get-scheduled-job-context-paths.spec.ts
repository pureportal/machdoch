import type { ScheduledJob } from "../scheduler.js";
import { getScheduledJobContextPaths } from "./get-scheduled-job-context-paths.helper.ts";

const createJob = (
  target: Partial<ScheduledJob["target"]>,
): ScheduledJob =>
  ({
    id: "job_1",
    name: "Daily",
    status: "active",
    triggers: [],
    target: {
      type: "prompt",
      workspaceRoot: "/workspace",
      prompt: "Run it",
      contextPaths: [],
      imagePaths: [],
      contextPacks: [],
      macros: [],
      ...target,
    },
    missedRunPolicy: "enqueue-latest",
    missedRunGraceMs: 60_000,
    retry: {
      maxAttempts: 1,
      factor: 2,
      minTimeoutMs: 1_000,
      maxTimeoutMs: 60_000,
      randomize: true,
    },
    queue: {
      concurrencyKey: "job_1",
      concurrencyLimit: 1,
    },
    historyLimit: 100,
    maxCatchUpRuns: 100,
    createdAt: 1,
    updatedAt: 1,
  }) satisfies ScheduledJob;

describe("getScheduledJobContextPaths", () => {
  it("combines direct and context-pack paths", () => {
    const job = createJob({
      contextPaths: ["src", "docs"],
      contextPacks: [{ name: "pack", contextPaths: ["README.md", "src"] }],
    });

    expect(getScheduledJobContextPaths(job)).toEqual(["src", "docs", "README.md"]);
  });

  it("returns an empty list when no context paths are configured", () => {
    expect(getScheduledJobContextPaths(createJob({}))).toEqual([]);
  });
});
