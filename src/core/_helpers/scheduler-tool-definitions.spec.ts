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
  }, 10_000);

  it("creates event-only jobs and emits scheduler events through AI tools", async () => {
    const workspaceRoot = await createWorkspace();
    const context = createContext(workspaceRoot);
    const createTool = getTool("create_scheduled_job");
    const emitTool = getTool("emit_scheduler_event");
    const eventsTool = getTool("list_scheduler_events");

    const createResult = await createTool.execute(
      {
        name: "Summarize invoice PDFs",
        triggers: [
          {
            kind: "workspace-file",
            eventType: "workspace-file.created",
            filters: [{ path: "payload.path", value: "invoices/*.pdf" }],
            dedupeKeyTemplate: "invoice:{payload.path}:{payload.mtime}",
          },
        ],
        prompt: [
          "When a new invoice PDF appears, summarize it for accounting review.",
          "Read only the new PDF path from the trigger event payload.",
          "Do not modify or delete the invoice file.",
          "Report the invoice date, vendor, total, and any parsing blockers.",
        ].join("\n"),
        dedupeKey: "summarize-invoice-pdfs",
      },
      context,
    );
    const createdJob = JSON.parse(createResult.toolResult.output).job;

    expect(createdJob.schedule).toBeNull();
    expect(createdJob.triggerLabel).toBe(
      "workspace-file:workspace-file.created",
    );

    const emitResult = await emitTool.execute(
      {
        type: "workspace-file.created",
        kind: "workspace-file",
        payload: [
          { path: "path", value: "invoices/june.pdf" },
          { path: "mtime", value: "123" },
        ],
        dedupeKey: "file:june",
      },
      context,
    );
    const emitted = JSON.parse(emitResult.toolResult.output);

    expect(emitted.enqueued).toHaveLength(1);
    expect(emitted.enqueued[0].run.source).toBe("event");
    expect(emitted.event.matches[0]).toMatchObject({
      jobId: createdJob.id,
      matched: true,
    });

    const eventsResult = await eventsTool.execute(
      {
        query: "june.pdf",
      },
      context,
    );
    const events = JSON.parse(eventsResult.toolResult.output).events;

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("workspace-file.created");
  });

  it("creates stateful threshold triggers through AI tools", async () => {
    const workspaceRoot = await createWorkspace();
    const context = createContext(workspaceRoot);
    const createTool = getTool("create_scheduled_job");

    const createResult = await createTool.execute(
      {
        name: "Disk pressure cleanup",
        triggers: [
          {
            kind: "system",
            eventType: "system.disk-threshold",
            firingMode: "state",
            filters: [{ path: "payload.usedPercent", op: ">=", value: 90 }],
            recoveryFilters: [
              { path: "payload.usedPercent", op: "<=", value: 80 },
            ],
            repeatIntervalMs: 3600000,
            maxEventsPerWindow: {
              maxEvents: 2,
              windowMs: 3600000,
            },
            dedupeKeyTemplate: "disk:{payload.path}",
          },
        ],
        prompt: [
          "When disk usage stays above 90%, clean safe temporary files.",
          "Repeat at most hourly while the condition is still active.",
          "Stop repeating once disk usage is at or below 80%.",
          "Do not remove user documents or project files.",
        ].join("\n"),
        dedupeKey: "disk-pressure-cleanup",
      },
      context,
    );
    const createdJob = JSON.parse(createResult.toolResult.output).job;

    expect(createdJob.schedule).toBeNull();
    expect(createdJob.triggers[0]).toMatchObject({
      kind: "system",
      eventType: "system.disk-threshold",
      firingMode: "state",
      repeatIntervalMs: 3600000,
      maxEventsPerWindow: {
        maxEvents: 2,
        windowMs: 3600000,
      },
    });
    expect(createdJob.triggers[0].filters["payload.usedPercent"]).toEqual({
      op: ">=",
      value: 90,
    });
    expect(createdJob.triggers[0].recoveryFilters["payload.usedPercent"]).toEqual({
      op: "<=",
      value: 80,
    });
  });
});
