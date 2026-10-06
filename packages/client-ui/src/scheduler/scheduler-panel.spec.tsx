import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SchedulerJobSummary } from "@machdoch/fleet-protocol/scheduler-contract";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { CommandProvider } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import { SchedulerPanel } from "./scheduler-panel";
import type { SchedulerRuntime } from "./scheduler-runtime";

const workspace = "/projects/demo";
const commandScope = { kind: "view" as const, ownerId: "scheduler" };
const job: SchedulerJobSummary = {
  id: "job-1",
  name: "Daily review",
  status: "active",
  schedule: { type: "interval", intervalMs: 60_000, anchorAt: 0 },
  triggers: [],
  triggerLabel: "",
  targetType: "prompt",
  workspaceRoot: workspace,
  prompt: "Review changes",
  ralphFlow: null,
  nextRunAt: null,
  lastStartedAt: null,
  lastFinishedAt: null,
  queue: { concurrencyKey: "review", concurrencyLimit: 1 },
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutMs: 1000,
    maxTimeoutMs: 60000,
    randomize: true,
  },
  dedupeKey: null,
  ttlMs: null,
  maxDurationMs: null,
};

function runtime() {
  return {
    listSchedulerJobs: vi
      .fn()
      .mockResolvedValue({ workspaceRoot: workspace, jobs: [] }),
    listSchedulerRuns: vi
      .fn()
      .mockResolvedValue({ workspaceRoot: workspace, runs: [] }),
    createSchedulerJob: vi.fn().mockResolvedValue({ job }),
    pauseSchedulerJob: vi.fn().mockResolvedValue({ job }),
    resumeSchedulerJob: vi.fn().mockResolvedValue({ job }),
    deleteSchedulerJob: vi.fn().mockResolvedValue({ job }),
    triggerSchedulerJob: vi.fn(),
    retrySchedulerRun: vi.fn(),
    cancelSchedulerRun: vi.fn(),
    runDueSchedulerJobs: vi.fn().mockResolvedValue({ queued: [], runs: [] }),
    inspectSchedulerRalphFlow: vi.fn().mockResolvedValue({
      ready: false,
      flowId: "flow",
      variables: [],
      errors: ["Enter the required path."],
      warnings: [],
    }),
    listRalphFlows: vi
      .fn()
      .mockResolvedValue({ flows: [{ id: "flow", name: "Review" }] }),
    getReasoningModesForProvider: () => ["default"] as const,
    normalizeReasoningModeForProvider: (reasoning) => reasoning,
    reasoningLabels: {
      default: "Default",
      none: "None",
      minimal: "Minimal",
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "Extra high",
      max: "Max",
      ultra: "Ultra",
      aeon: "Aeon",
    },
  } satisfies SchedulerRuntime;
}

function mount(operations: SchedulerRuntime, root: string | null = workspace) {
  return render(
    <TooltipProvider>
      <CommandProvider activeView="scheduler" runtime="browser">
        <SchedulerPanel
          workspaceRoot={root}
          runtime={operations}
          commandScope={commandScope}
        />
      </CommandProvider>
    </TooltipProvider>,
  );
}

afterEach(cleanup);

describe("shared Scheduler controls", () => {
  it("submits the selected schedule and retains the draft when the host rejects it", async () => {
    const operations = runtime();
    operations.createSchedulerJob.mockRejectedValueOnce(
      new Error("Device disconnected. Reconnect and retry."),
    );
    mount(operations);
    await screen.findByText("No scheduled jobs.");
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Daily review" },
    });
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Review changes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "interval" }));
    fireEvent.change(screen.getByLabelText("Interval ms"), {
      target: { value: "60000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByText("Device disconnected. Reconnect and retry.");
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe(
      "Review changes",
    );
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByText("Created Daily review.");
    expect(operations.createSchedulerJob).toHaveBeenLastCalledWith(
      workspace,
      expect.objectContaining({
        name: "Daily review",
        prompt: "Review changes",
        schedule: { type: "interval", intervalMs: 60000 },
      }),
    );
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");
  });

  it("requires RALPH readiness even when the form is submitted directly", async () => {
    const operations = runtime();
    mount(operations);
    fireEvent.click(screen.getByRole("button", { name: "RALPH Flow" }));
    fireEvent.change(screen.getByLabelText("RALPH Flow ID"), {
      target: { value: "flow" },
    });
    await screen.findByText("Enter the required path.");
    expect(
      (
        screen.getByRole("button", {
          name: "Create",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.submit(screen.getByLabelText("Name").closest("form")!);
    await act(async () => {});
    expect(operations.createSchedulerJob).not.toHaveBeenCalled();
    expect(operations.listRalphFlows).toHaveBeenCalledWith(
      workspace,
      "workspace",
    );
    operations.inspectSchedulerRalphFlow.mockResolvedValueOnce({
      ready: true,
      flowId: "ready-flow",
      variables: [],
      errors: [],
      warnings: [],
    });
    fireEvent.change(screen.getByLabelText("RALPH Flow ID"), {
      target: { value: "ready-flow" },
    });
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Create",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(operations.createSchedulerJob).toHaveBeenCalledWith(
        workspace,
        expect.objectContaining({
          targetType: "ralph-flow",
          ralphFlow: expect.objectContaining({
            id: "ready-flow",
            executionProfile: "unattended",
            permissions: expect.objectContaining({ allowedRoots: [workspace] }),
          }),
        }),
      ),
    );
  });

  it("confirms deletion and keeps the confirmation open on failure", async () => {
    const operations = runtime();
    operations.listSchedulerJobs.mockResolvedValue({
      workspaceRoot: workspace,
      jobs: [job],
    });
    operations.deleteSchedulerJob.mockRejectedValueOnce(
      new Error("Deletion failed. Retry."),
    );
    mount(operations);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Delete scheduled job",
      }),
    );
    expect(operations.deleteSchedulerJob).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Delete scheduled job" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete job" }));
    await waitFor(() =>
      expect(operations.deleteSchedulerJob).toHaveBeenCalledTimes(1),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Delete job",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(screen.getByRole("dialog")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete job" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(operations.deleteSchedulerJob).toHaveBeenLastCalledWith(
      workspace,
      job.id,
    );
  });

  it("prevents commands without a selected workspace", async () => {
    const operations = runtime();
    mount(operations, null);
    expect(
      (
        screen.getByRole("button", {
          name: "Create",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Run due",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.submit(screen.getByLabelText("Name").closest("form")!);
    await act(async () => {});
    expect(operations.createSchedulerJob).not.toHaveBeenCalled();
    expect(operations.listSchedulerJobs).not.toHaveBeenCalled();
  });
});
