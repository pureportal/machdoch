import { describe, expect, it } from "vitest";
import type { ProductSnapshot } from "@machdoch/fleet-protocol";
import { observeClient, presenceEvent } from "./client-events";

interface ShellParts {
  activeSessionId?: string;
  visibleTaskIds?: string[];
  sessions?: {
    id: string;
    runningTaskId?: string;
    provider: string;
    model: string;
  }[];
  runtimeError?: string;
  providers?: { provider: string; available: boolean; reason?: string }[];
  jobs?: { id: string; name: string }[];
  scheduledRuns?: {
    id: string;
    jobId: string;
    status: string;
    error?: string;
  }[];
  workflowRuns?: {
    id: string;
    flowName: string;
    status: string;
    summary: string;
  }[];
}

function snapshot(
  tasks: { taskId: string; state: string; message?: string }[],
  shell: ShellParts = {},
): ProductSnapshot {
  return {
    enabled: true,
    serverTime: 1,
    eventId: 1,
    commands: [],
    sessions: tasks.map((task) => ({
      taskId: task.taskId,
      task: "Private prompt",
      mode: "machdoch",
      state: task.state,
      message: task.message ?? "",
      cancellable: false,
      startedAt: 1,
      updatedAt: 1,
      progressCount: 0,
      logs: [],
      timeline: [],
    })),
    shell: {
      ...(shell.activeSessionId
        ? { activeSessionId: shell.activeSessionId }
        : {}),
      visibleMessages: (shell.visibleTaskIds ?? []).map((taskId) => ({
        id: `message-${taskId}`,
        taskId,
      })),
      sessions: shell.sessions ?? [],
      runtime: {
        loading: false,
        hasAnyProvider: true,
        providerStatuses: shell.providers ?? [],
        ...(shell.runtimeError ? { error: shell.runtimeError } : {}),
      },
      scheduler: {
        loading: false,
        jobs: shell.jobs ?? [],
        runs: shell.scheduledRuns ?? [],
        updatedAt: 1,
      },
      ralph: {
        loading: false,
        flows: [],
        runs: shell.workflowRuns ?? [],
        updatedAt: 1,
      },
    } as unknown as ProductSnapshot["shell"],
  };
}

describe("client observations", () => {
  it("starts from a baseline without replaying history but reports current errors", () => {
    const { events, observation } = observeClient(
      null,
      snapshot([{ taskId: "old", state: "failed", message: "Old failure" }], {
        runtimeError: "Provider configuration is invalid",
        providers: [{ provider: "openai", available: false, reason: "No key" }],
      }),
    );
    expect(events).toEqual([
      {
        status: "failed",
        title: "Runtime error",
        detail: "Provider configuration is invalid",
      },
    ]);
    expect(observation.tasks).toEqual({ old: { state: "failed" } });
    expect(observation.unavailableProviders).toEqual({ openai: "No key" });
  });

  it("reports task starts and outcomes once with the reason and model that ran them", () => {
    const first = observeClient(null, snapshot([]));
    const started = observeClient(
      first.observation,
      snapshot([{ taskId: "t1", state: "running" }], {
        sessions: [
          {
            id: "s1",
            runningTaskId: "t1",
            provider: "claude-cli",
            model: "sonnet",
          },
        ],
      }),
    );
    expect(started.events).toEqual([
      {
        status: "started",
        title: "Task started",
        detail: "",
        provider: "claude-cli",
        model: "sonnet",
      },
    ]);
    const failed = observeClient(
      started.observation,
      snapshot([
        { taskId: "t1", state: "failed", message: "Provider rate limited" },
        { taskId: "t2", state: "completed", message: "Done" },
      ]),
    );
    expect(failed.events).toEqual([
      {
        status: "failed",
        title: "Task failed",
        detail: "Provider rate limited",
        provider: "claude-cli",
        model: "sonnet",
      },
      { status: "succeeded", title: "Task completed", detail: "" },
    ]);
    expect(
      observeClient(
        failed.observation,
        snapshot([
          { taskId: "t1", state: "failed", message: "Provider rate limited" },
        ]),
      ).events,
    ).toEqual([]);
  });

  it("attributes a task that started and failed between polls to the active session model", () => {
    const base = observeClient(null, snapshot([]));
    expect(
      observeClient(
        base.observation,
        snapshot(
          [{ taskId: "t9", state: "failed", message: "Model not supported" }],
          {
            activeSessionId: "s1",
            visibleTaskIds: ["t9"],
            sessions: [
              { id: "s1", provider: "codex-cli", model: "gpt-5.6-sol" },
            ],
          },
        ),
      ).events,
    ).toEqual([
      {
        status: "failed",
        title: "Task failed",
        detail: "Model not supported",
        provider: "codex-cli",
        model: "gpt-5.6-sol",
      },
    ]);
  });

  it("names failed scheduled jobs and RALPH runs with their reasons", () => {
    const base = observeClient(
      null,
      snapshot([], {
        jobs: [{ id: "j1", name: "Nightly report" }],
        scheduledRuns: [{ id: "r1", jobId: "j1", status: "running" }],
        workflowRuns: [
          { id: "w1", flowName: "Release", status: "running", summary: "" },
        ],
      }),
    );
    const settled = observeClient(
      base.observation,
      snapshot([], {
        jobs: [{ id: "j1", name: "Nightly report" }],
        scheduledRuns: [
          {
            id: "r1",
            jobId: "j1",
            status: "timed_out",
            error: "Exceeded 30 minutes",
          },
        ],
        workflowRuns: [
          {
            id: "w1",
            flowName: "Release",
            status: "waiting-for-input",
            summary: "Needs a version number",
          },
        ],
      }),
    );
    expect(settled.events).toEqual([
      {
        status: "failed",
        title: "Scheduled job timed out",
        detail: "Nightly report · Exceeded 30 minutes",
      },
      {
        status: "warning",
        title: "RALPH run waiting for input",
        detail: "Release · Needs a version number",
      },
    ]);
  });

  it("reports recoveries and provider availability changes", () => {
    const failing = observeClient(
      null,
      snapshot([], {
        runtimeError: "Runtime crashed",
        providers: [{ provider: "openai", available: true }],
      }),
    );
    const changed = observeClient(
      failing.observation,
      snapshot([], {
        providers: [
          { provider: "openai", available: false, reason: "Key revoked" },
        ],
      }),
    );
    expect(changed.events).toEqual([
      { status: "succeeded", title: "Runtime recovered", detail: "" },
      {
        status: "warning",
        title: "openai unavailable",
        detail: "Key revoked",
        provider: "openai",
      },
    ]);
    expect(
      observeClient(
        changed.observation,
        snapshot([], { providers: [{ provider: "openai", available: true }] }),
      ).events,
    ).toEqual([
      {
        status: "succeeded",
        title: "openai available",
        detail: "",
        provider: "openai",
      },
    ]);
    expect(presenceEvent(false)).toMatchObject({
      status: "warning",
      title: "Client disconnected",
    });
  });
});
