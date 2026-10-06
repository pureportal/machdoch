import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { schedulerRequestSchema } from "@machdoch/fleet-protocol";
import { createFleetOperationTransport } from "@machdoch/product-ui/fleet-operation-transport";
import type {
  SchedulerJobActionResult,
  SchedulerListJobsResult,
  SchedulerListRunsResult,
  SchedulerRetryResult,
  SchedulerRunActionResult,
  SchedulerRunDueResult,
  SchedulerTriggerResult,
} from "@machdoch/fleet-protocol/scheduler-contract";
import { writeRalphFlow } from "../../core/ralph.js";
import {
  readSmartSchedulerState,
  DurableSmartScheduler,
  getWorkspaceSchedulerStatePath,
} from "../../core/scheduler.js";
import { FleetSchedulerRuntime } from "./cli-fleet-scheduler.js";

let root: string;
let workspace: string;
let scheduler: FleetSchedulerRuntime;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "machdoch-fleet-scheduler-"));
  workspace = join(root, "workspace");
  await mkdir(workspace);
  workspace = await realpath(workspace);
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", join(root, "config"));
  scheduler = createRuntime();
});

afterEach(async () => {
  await scheduler.shutdown();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function createRuntime(): FleetSchedulerRuntime {
  return new FleetSchedulerRuntime(
    async (value) => {
      if (value !== workspace)
        throw new Error("Choose a workspace listed on this device.");
      return workspace;
    },
    async () => [workspace],
  );
}

function transport() {
  return createFleetOperationTransport((request) =>
    scheduler.request(schedulerRequestSchema.parse(request)),
  );
}

function invoke<T>(
  argumentsList: string[],
  selectedWorkspace = workspace,
): Promise<T> {
  return transport().invoke<T>("run_scheduler_command", {
    request: { workspaceRoot: selectedWorkspace, arguments: argumentsList },
  });
}

it("creates, persists, pauses, resumes and deletes a real remote job", async () => {
  const { job } = await invoke<SchedulerJobActionResult>([
    "create",
    "--name",
    "Remote sweep",
    "--prompt",
    "Inspect the workspace",
    "--interval-ms",
    "3600000",
    "--retry-attempts",
    "2",
    "--concurrency-limit",
    "1",
    "--trigger",
    "workspace-file:workspace-file.created",
    "--trigger-filter",
    "extension=.ts",
  ]);
  expect(job).toMatchObject({
    name: "Remote sweep",
    status: "active",
    retry: { maxAttempts: 2 },
  });
  expect(job.triggers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "workspace-file",
        filters: { extension: ".ts" },
      }),
    ]),
  );
  await scheduler.shutdown();
  scheduler = createRuntime();
  expect(
    (await invoke<SchedulerListJobsResult>(["list"])).jobs.map(
      (entry) => entry.id,
    ),
  ).toContain(job.id);
  expect(
    (await invoke<SchedulerJobActionResult>(["pause", job.id])).job.status,
  ).toBe("paused");
  expect(
    (await invoke<SchedulerJobActionResult>(["resume", job.id])).job.status,
  ).toBe("active");
  expect(
    (await invoke<SchedulerJobActionResult>(["delete", job.id])).job.status,
  ).toBe("deleted");
  const state = await readSmartSchedulerState(
    getWorkspaceSchedulerStatePath(workspace),
  );
  expect(state.jobs.find((entry) => entry.id === job.id)?.status).toBe(
    "deleted",
  );
});

it("deduplicates create requests after the host restarts", async () => {
  const id = randomUUID();
  const client = createFleetOperationTransport((request) =>
    scheduler.request(schedulerRequestSchema.parse({ ...request, id })),
  );
  const args = {
    request: {
      workspaceRoot: workspace,
      arguments: ["create", "--prompt", "Check files", "--delay-ms", "3600000"],
    },
  };
  const first = await client.invoke<SchedulerJobActionResult>(
    "run_scheduler_command",
    args,
  );
  await scheduler.shutdown();
  scheduler = createRuntime();
  const replay = await client.invoke<SchedulerJobActionResult>(
    "run_scheduler_command",
    args,
  );
  expect(replay.job.id).toBe(first.job.id);
  expect((await invoke<SchedulerListJobsResult>(["list"])).jobs).toHaveLength(
    1,
  );
});

it("rejects unknown workspaces without writing a job", async () => {
  await expect(
    invoke(
      ["create", "--prompt", "Check files", "--delay-ms", "60000"],
      join(root, "foreign"),
    ),
  ).rejects.toThrow("Choose a workspace listed");
  expect((await invoke<SchedulerListJobsResult>(["list"])).jobs).toHaveLength(
    0,
  );
});

async function createVerifiedRalphFixture(): Promise<void> {
  const git = promisify(execFile);
  await writeFile(join(workspace, ".gitignore"), ".machdoch/\n");
  await writeFile(
    join(workspace, "README.md"),
    "Scheduler verification fixture\n",
  );
  await git("git", ["init", "--quiet", workspace]);
  await git("git", ["add", "."], { cwd: workspace });
  await git(
    "git",
    [
      "-c",
      "user.name=Scheduler test",
      "-c",
      "user.email=scheduler@example.test",
      "commit",
      "--quiet",
      "-m",
      "Fixture",
    ],
    { cwd: workspace },
  );
  await mkdir(join(workspace, ".machdoch"), { recursive: true });
  await writeFile(
    join(workspace, ".machdoch", "config.json"),
    JSON.stringify({ offline: true, provider: "openai", model: "gpt-5.4" }),
  );
  await writeRalphFlow(workspace, {
    schemaVersion: 1,
    id: "remote-flow",
    name: "Remote flow",
    blocks: [
      { id: "start", type: "START", title: "Start" },
      {
        id: "report",
        type: "UTILITY",
        title: "Report",
        utility: { type: "FINAL_REPORT" },
      },
      {
        id: "done",
        type: "END",
        title: "Done",
        status: "success",
        outcome: "no-op",
      },
    ],
    edges: [
      {
        id: "start-report",
        from: "start",
        fromOutput: "SUCCESS",
        to: "report",
      },
      { id: "report-done", from: "report", fromOutput: "SUCCESS", to: "done" },
    ],
  });
}

it("discovers, inspects, triggers, cancels, retries and runs due RALPH jobs", async () => {
  await createVerifiedRalphFixture();
  const result = await transport().invoke<{ flows: Array<{ id: string }> }>(
    "run_ralph_command",
    {
      request: {
        workspaceRoot: workspace,
        arguments: ["list", "--scope", "workspace"],
      },
    },
  );
  expect(result.flows.map((flow) => flow.id)).toContain("remote-flow");
  const readiness = await invoke<{ ready: boolean; errors: string[] }>([
    "inspect-ralph",
    "remote-flow",
    "--scheduled-ralph-profile",
    "unattended",
    "--scheduled-ralph-allowed-root",
    workspace,
  ]);
  expect(readiness.ready, readiness.errors.join("\n")).toBe(true);
  const targetOptions = [
    "--scheduler-target",
    "ralph-flow",
    "--scheduled-ralph-flow",
    "remote-flow",
    "--scheduled-ralph-profile",
    "unattended",
    "--scheduled-ralph-allowed-root",
    workspace,
  ];
  const { job } = await invoke<SchedulerJobActionResult>([
    "create",
    "--interval-ms",
    "3600000",
    ...targetOptions,
  ]);
  const core = new DurableSmartScheduler({
    statePath: getWorkspaceSchedulerStatePath(workspace),
    workspaceRoot: workspace,
  });
  const queued = await core.triggerJobNow(job.id);
  const cancelled = await invoke<SchedulerRunActionResult>([
    "cancel",
    queued.run.id,
  ]);
  expect(cancelled.run.status).toBe("cancelled");
  const retried = await invoke<SchedulerRetryResult>(["retry", queued.run.id]);
  expect(retried.handle.runId).not.toBe(queued.run.id);
  expect(retried.runs).toEqual([
    expect.objectContaining({ status: "succeeded" }),
  ]);
  const triggered = await invoke<SchedulerTriggerResult>(["trigger", job.id]);
  expect(triggered.runs).toEqual([
    expect.objectContaining({ status: "succeeded" }),
  ]);
  await invoke<SchedulerJobActionResult>([
    "create",
    "--delay-ms",
    "1",
    ...targetOptions,
  ]);
  const due = await invoke<SchedulerRunDueResult>(["run-due"]);
  expect(due.runs).toEqual([expect.objectContaining({ status: "succeeded" })]);
  const history = await invoke<SchedulerListRunsResult>(["runs", job.id]);
  expect(history.runs.map((run) => run.status)).toEqual(
    expect.arrayContaining(["cancelled", "succeeded"]),
  );
});

it("automatically runs persisted jobs and imports scheduled prompts when the host starts", async () => {
  await createVerifiedRalphFixture();
  const prompts = join(workspace, ".machdoch", "prompts");
  await mkdir(prompts, { recursive: true });
  await writeFile(
    join(prompts, "daily.prompt.md"),
    [
      "---",
      "name: daily",
      "schedule-enabled: true",
      "schedule-name: Daily review",
      "schedule-interval-ms: 86400000",
      "---",
      "Review the workspace.",
    ].join("\n"),
  );
  const { job } = await invoke<SchedulerJobActionResult>([
    "create",
    "--delay-ms",
    "1",
    "--scheduler-target",
    "ralph-flow",
    "--scheduled-ralph-flow",
    "remote-flow",
    "--scheduled-ralph-profile",
    "unattended",
    "--scheduled-ralph-allowed-root",
    workspace,
  ]);
  scheduler.start();
  scheduler.start();
  const core = new DurableSmartScheduler({
    workspaceRoot: workspace,
    statePath: getWorkspaceSchedulerStatePath(workspace),
  });
  await expect
    .poll(() => core.listRuns(job.id), { timeout: 30000 })
    .toEqual([expect.objectContaining({ status: "succeeded" })]);
  expect(await core.listJobs()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "Daily review",
        provenance: {
          kind: "workspace-prompt",
          definitionPath: ".machdoch/prompts/daily.prompt.md",
        },
      }),
    ]),
  );
  await scheduler.shutdown();
  scheduler = createRuntime();
  scheduler.start();
  expect(
    (await invoke<SchedulerListRunsResult>(["runs", job.id])).runs,
  ).toEqual([expect.objectContaining({ status: "succeeded" })]);
});
