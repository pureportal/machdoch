import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DurableSmartScheduler,
  getWorkspaceSchedulerStatePath,
} from "../scheduler.ts";
import type { AgentToolExecutionContext } from "./agent-tools-shared.ts";
import { createSchedulerToolDefinitions } from "./scheduler-tool-definitions.ts";

const workspacesToClean: string[] = [];

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-scheduler-tools-"));
  workspacesToClean.push(workspaceRoot);
  return workspaceRoot;
};

const createContext = (workspaceRoot: string): AgentToolExecutionContext => ({
  workspaceRoot,
  memory: {
    sessionEnabled: false,
    sessionEntries: [],
    globalEnabled: false,
    globalEntries: [],
  },
});

const getTool = (name: string) => {
  const tool = createSchedulerToolDefinitions().find(
    (definition) => definition.spec.name === name,
  );

  if (!tool) {
    throw new Error(`Missing scheduler tool ${name}`);
  }

  return tool;
};

afterEach(async () => {
  await Promise.all(
    workspacesToClean
      .splice(0)
      .map((workspaceRoot) =>
        rm(workspaceRoot, { recursive: true, force: true }),
      ),
  );
});

describe("createSchedulerToolDefinitions", () => {
  it("creates, lists, and updates durable scheduler jobs for AI-driven requests", async () => {
    const workspaceRoot = await createWorkspace();
    const context = createContext(workspaceRoot);
    const createTool = getTool("create_scheduled_job");
    const listTool = getTool("list_scheduled_jobs");
    const updateTool = getTool("update_scheduled_job");

    const createResult = await createTool.execute(
      {
        name: "Clean Windows Recycle Bin",
        schedule: {
          type: "cron",
          expression: "0 9 * * 1",
          timezone: "Europe/Berlin",
        },
        prompt: [
          "Every scheduled run should empty the Windows Recycle Bin safely.",
          "Use Windows-appropriate commands or desktop automation only when available.",
          "Do not delete arbitrary files outside the Recycle Bin.",
          "If permissions are missing, report the blocker clearly.",
          "Verify the Recycle Bin is empty or report what prevented cleanup.",
        ].join("\n"),
        dedupeKey: "clean-windows-recycle-bin",
        retryAttempts: 2,
        concurrencyKey: "windows-maintenance",
        concurrencyLimit: 1,
      },
      context,
    );
    const createdJob = JSON.parse(createResult.toolResult.output).job;

    expect(createdJob.name).toBe("Clean Windows Recycle Bin");
    expect(createdJob.schedule).toMatchObject({
      type: "cron",
      expression: "0 9 * * 1",
      timezone: "Europe/Berlin",
    });
    expect(createdJob.prompt).toContain("Recycle Bin safely");
    expect(createdJob.prompt).toContain("Do not delete arbitrary files");
    expect(createdJob.dedupeKey).toBe("clean-windows-recycle-bin");

    const listResult = await listTool.execute(
      {
        query: "trash recycle cleanup",
        maxJobs: 5,
      },
      context,
    );
    const listedJobs = JSON.parse(listResult.toolResult.output).jobs;

    expect(listedJobs).toHaveLength(1);
    expect(listedJobs[0].id).toBe(createdJob.id);

    await updateTool.execute(
      {
        jobId: createdJob.id,
        schedule: {
          type: "cron",
          expression: "0 9 * * 2",
          timezone: "Europe/Berlin",
        },
        prompt: [
          "Every Tuesday, empty the Windows Recycle Bin safely.",
          "Use Windows-appropriate commands or desktop automation only when available.",
          "Do not delete arbitrary files outside the Recycle Bin.",
          "Verify the Recycle Bin is empty or report what prevented cleanup.",
        ].join("\n"),
      },
      context,
    );

    const scheduler = new DurableSmartScheduler({
      statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
    });
    const updatedJob = await scheduler.getJob(createdJob.id);

    expect(updatedJob?.schedule).toMatchObject({
      type: "cron",
      expression: "0 9 * * 2",
    });
    expect(updatedJob?.target.prompt).toContain("Every Tuesday");
    expect(updatedJob?.target.prompt).not.toContain("Every scheduled run");
  });
});
