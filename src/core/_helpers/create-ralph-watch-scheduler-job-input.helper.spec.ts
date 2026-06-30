import { createRalphWatchSchedulerJobInput } from "./create-ralph-watch-scheduler-job-input.helper.ts";
import type { RalphWatchDefinition } from "../ralph-watches.ts";

const createWatchDefinition = (
  override: Partial<RalphWatchDefinition> = {},
): RalphWatchDefinition => ({
  id: "watch-1",
  enabled: true,
  flow: { scope: "workspace", id: "flow-1" },
  executionWorkspaceRoot: "C:\\Workspace",
  roots: [],
  events: ["changed"],
  params: { mode: "dry-run" },
  permissions: {
    allowedRoots: ["C:\\Workspace"],
    allowCommands: false,
    allowWrites: false,
    allowNetwork: false,
    allowMcpTools: false,
  },
  debounceMs: 1_000,
  stabilityMs: 300,
  pollIntervalMs: 5_000,
  maxEventsPerWindow: { maxEvents: 100, windowMs: 60_000 },
  concurrencyLimit: 1,
  createdAt: "2026-06-19T00:00:00.000Z",
  updatedAt: "2026-06-19T00:00:00.000Z",
  ...override,
});

describe("createRalphWatchSchedulerJobInput", () => {
  it("maps a Ralph watch into a scheduler job with stable dedupe and queue keys", () => {
    const job = createRalphWatchSchedulerJobInput(createWatchDefinition());

    expect(job).toMatchObject({
      name: "Ralph watch watch-1",
      dedupeKey: "ralph-watch:watch-1",
      retry: { maxAttempts: 1 },
      queue: {
        concurrencyKey: "ralph-watch:watch-1",
        concurrencyLimit: 1,
      },
      target: {
        type: "ralph-flow",
        workspaceRoot: "C:\\Workspace",
        ralphFlow: {
          scope: "workspace",
          id: "flow-1",
          params: { mode: "dry-run" },
        },
      },
    });
    expect(job.triggers).toEqual([
      {
        kind: "workspace-file",
        eventType: "workspace-file.*",
        filters: { "payload.watchId": "watch-1" },
        debounceMs: 1_000,
        dedupeKeyTemplate: "{payload.watchId}:{payload.eventType}:{payload.path}:{payload.mtimeMs}",
        maxEventsPerWindow: { maxEvents: 100, windowMs: 60_000 },
      },
    ]);
  });

  it("preserves optional watch controls when present", () => {
    const permissions = {
      allowedRoots: ["C:\\Workspace"],
      allowCommands: true,
      allowWrites: true,
      allowNetwork: true,
      allowMcpTools: true,
    };
    const job = createRalphWatchSchedulerJobInput(
      createWatchDefinition({
        name: "Nightly import",
        runLogScope: "user",
        cooldownMs: 5_000,
        maxTransitions: 7,
        concurrencyLimit: 3,
        permissions,
      }),
    );

    expect(job.name).toBe("Nightly import");
    expect(job.queue?.concurrencyLimit).toBe(3);
    expect(job.triggers?.[0]).toMatchObject({ cooldownMs: 5_000 });
    expect(job.target.ralphFlow).toMatchObject({
      runLogScope: "user",
      maxTransitions: 7,
      permissions,
    });
  });

  it("omits optional fields when their watch values are empty or undefined", () => {
    const job = createRalphWatchSchedulerJobInput(createWatchDefinition());

    expect(job.name).toBe("Ralph watch watch-1");
    expect(job.triggers?.[0]).not.toHaveProperty("cooldownMs");
    expect(job.target.ralphFlow).not.toHaveProperty("runLogScope");
    expect(job.target.ralphFlow).not.toHaveProperty("maxTransitions");
  });
});
