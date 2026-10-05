import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createRalphRunLogger, runRalphFlow } from "../ralph.js";
import {
  createFlow,
  customizations,
  runtimeConfig,
} from "./ralph-test-helpers.js";

it("restores deferred verification with fresh evidence without repeating implementation", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralph-deferred-phase-"));
  try {
    await writeFile(
      join(workspace, "tasks.json"),
      JSON.stringify({ tasks: [{ id: "feature", status: "planned" }] }),
    );
    const mark = (id: string, status: string) => ({
      id,
      title: id,
      type: "UTILITY" as const,
      utility: {
        type: "MARK_JSON_TASK" as const,
        path: "tasks.json",
        input: "{{data:select}}",
        status,
      },
    });
    const flow = createFlow({
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "select",
          title: "Select",
          type: "UTILITY",
          utility: { type: "SELECT_JSON_TASK", path: "tasks.json" },
        },
        {
          id: "implement",
          title: "Implement",
          type: "UTILITY",
          utility: {
            type: "WRITE_FILE",
            path: "implementation.txt",
            content: "once\n",
            append: true,
          },
        },
        mark("verifying", "verifying"),
        {
          id: "baseline",
          title: "Baseline",
          type: "UTILITY",
          utility: {
            type: "RUN_CHECK",
            command: "node --version",
            verificationRole: "baseline",
            verificationPlanId: "feature",
          },
        },
        {
          id: "candidate",
          title: "Candidate",
          type: "UTILITY",
          utility: {
            type: "RUN_CHECK",
            command: "node --version",
            verificationRole: "candidate",
            verificationPlanId: "feature",
            baselineBlockId: "baseline",
          },
        },
        {
          id: "review",
          title: "Review",
          type: "UTILITY",
          utility: {
            type: "RUN_CHECK",
            command:
              "node -e \"process.exit(require('fs').existsSync('retry.ready') ? 0 : 1)\"",
          },
        },
        mark("deferred", "deferred"),
        {
          ...mark("complete", "completed"),
          utility: {
            ...mark("complete", "completed").utility,
            verificationBlockId: "candidate",
          },
        },
        { id: "done", type: "END", title: "Done" },
      ],
      edges: [
        {
          id: "start-select",
          from: "start",
          fromOutput: "SUCCESS",
          to: "select",
        },
        {
          id: "select-implement",
          from: "select",
          fromOutput: "SELECTED",
          to: "implement",
        },
        {
          id: "implement-verifying",
          from: "implement",
          fromOutput: "SUCCESS",
          to: "verifying",
        },
        {
          id: "verifying-baseline",
          from: "verifying",
          fromOutput: "SUCCESS",
          to: "baseline",
        },
        {
          id: "baseline-candidate",
          from: "baseline",
          fromOutput: "SUCCESS",
          to: "candidate",
        },
        {
          id: "candidate-review",
          from: "candidate",
          fromOutput: "SUCCESS",
          to: "review",
        },
        {
          id: "review-complete",
          from: "review",
          fromOutput: "SUCCESS",
          to: "complete",
        },
        {
          id: "review-deferred",
          from: "review",
          fromOutput: "FAILED",
          to: "deferred",
        },
        {
          id: "deferred-review",
          from: "deferred",
          fromOutput: "SUCCESS",
          to: "review",
        },
        {
          id: "complete-done",
          from: "complete",
          fromOutput: "SUCCESS",
          to: "done",
        },
      ],
    });
    const logger = await createRalphRunLogger(workspace, flow);
    const controller = new AbortController();
    const config = { ...runtimeConfig, workspaceRoot: workspace };
    const stopped = await runRalphFlow(flow, config, customizations, {
      logger,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "edge-route" && event.from === "deferred")
          controller.abort();
      },
    });
    expect(stopped.status, stopped.summary).toBe("stopped");
    expect(stopped.checkpoint?.currentBlockId).toBe("review");
    const deferred = JSON.parse(
      await readFile(join(workspace, "tasks.json"), "utf8"),
    );
    expect(deferred.tasks[0].status).toBe("deferred");
    const originalVerification = stopped.blockResults.find(
      (result) => result.blockId === "candidate",
    );
    await writeFile(join(workspace, "retry.ready"), "ready");
    const resumed = await runRalphFlow(flow, config, customizations, {
      logger,
      checkpoint: stopped.checkpoint!,
    });
    expect(resumed.status, resumed.summary).toBe("completed");
    expect(await readFile(join(workspace, "implementation.txt"), "utf8")).toBe(
      "once\n",
    );
    expect(
      resumed.blockResults.filter((result) => result.blockId === "candidate"),
    ).toHaveLength(2);
    const completed = JSON.parse(
      await readFile(join(workspace, "tasks.json"), "utf8"),
    );
    expect(completed.tasks[0].status).toBe("completed");
    expect(completed.tasks[0].stateHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "deferred", to: "verifying" }),
      ]),
    );
    expect(completed.tasks[0].verification.verifiedAt).not.toBe(
      (originalVerification?.data as { verification?: { verifiedAt?: string } })
        ?.verification?.verifiedAt,
    );
    expect(resumed.durability?.status).toBe("healthy");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}, 180_000);

it.each(["deferred", "verifying"])(
  "retains a selected %s journal instead of archiving it",
  async (status) => {
    const workspace = await mkdtemp(
      join(tmpdir(), "ralph-unfinished-archive-"),
    );
    try {
      await writeFile(
        join(workspace, "tasks.json"),
        JSON.stringify({ tasks: [{ id: "feature", status: "planned" }] }),
      );
      const flow = createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "select",
            title: "Select",
            type: "UTILITY",
            utility: { type: "SELECT_JSON_TASK", path: "tasks.json" },
          },
          {
            id: "phase",
            title: "Phase",
            type: "UTILITY",
            utility: {
              type: "MARK_JSON_TASK",
              path: "tasks.json",
              input: "{{data:select}}",
              status,
            },
          },
          {
            id: "archive",
            title: "Archive",
            type: "UTILITY",
            utility: {
              type: "ARCHIVE_FILE",
              path: "tasks.json",
              outputPath: "archived.json",
            },
          },
          { id: "retained", type: "END", title: "Retained", status: "failed" },
        ],
        edges: [
          {
            id: "start-select",
            from: "start",
            fromOutput: "SUCCESS",
            to: "select",
          },
          {
            id: "select-phase",
            from: "select",
            fromOutput: "SELECTED",
            to: "phase",
          },
          {
            id: "phase-archive",
            from: "phase",
            fromOutput: "SUCCESS",
            to: "archive",
          },
          {
            id: "archive-retained",
            from: "archive",
            fromOutput: "ERROR",
            to: "retained",
          },
        ],
      });
      const result = await runRalphFlow(
        flow,
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
      );
      expect(
        result.blockResults.find((block) => block.blockId === "archive"),
      ).toMatchObject({
        output: "ERROR",
        summary: expect.stringContaining("retained unfinished work"),
      });
      expect(
        JSON.parse(await readFile(join(workspace, "tasks.json"), "utf8"))
          .tasks[0].status,
      ).toBe(status);
      await expect(
        readFile(join(workspace, "archived.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(result.status).not.toBe("completed");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  },
  60_000,
);
