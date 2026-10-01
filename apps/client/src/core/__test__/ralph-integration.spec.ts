import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTask } from "../execution.js";
import {
  createRalphRunLogger,
  runRalphFlow,
  type RalphFlow,
  type RalphRunRecord,
} from "../ralph.js";
import {
  createExecutionResult,
  createFlow,
  customizations,
  runtimeConfig,
} from "./ralph-test-helpers.js";

vi.mock("../execution.js", () => ({ executeTask: vi.fn() }));

const temporaryRoots: string[] = [];

beforeEach(() => {
  vi.mocked(executeTask).mockReset();
});
afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) =>
        rm(root, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 200,
        }),
      ),
  );
}, 60_000);

const createWorkspace = async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-flow-integration-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: workspace, windowsHide: true });
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "core.autocrlf", "false");
  await writeFile(join(workspace, "source.txt"), "original\n");
  await writeFile(
    join(workspace, "verify.mjs"),
    'import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync(".machdoch", { recursive: true }); writeFileSync(".machdoch/verified.txt", process.cwd());\n',
  );
  git("add", ".");
  git("commit", "-qm", "initial");
  return workspace;
};

const createIntegrationFlow = (): RalphFlow =>
  createFlow({
    blocks: [
      { id: "start", type: "START", title: "Start" },
      {
        id: "work",
        type: "PROMPT",
        title: "Work",
        prompt: "Complete the task.",
      },
      {
        id: "check",
        type: "UTILITY",
        title: "Check",
        utility: {
          type: "RUN_CHECK",
          command: 'node "{{lastResultSummary}}/verify.mjs"',
          cwd: ".",
        },
      },
      { id: "success", type: "END", title: "Success" },
    ],
    edges: [
      { id: "start-work", from: "start", fromOutput: "SUCCESS", to: "work" },
      { id: "work-check", from: "work", fromOutput: "SUCCESS", to: "check" },
      {
        id: "check-success",
        from: "check",
        fromOutput: "SUCCESS",
        to: "success",
      },
    ],
  });

describe("RALPH flow integration", () => {
  it("reruns successful flow checks against the merged candidate and saves the integration result", async () => {
    const workspace = await createWorkspace();
    const flow = createIntegrationFlow();
    vi.mocked(executeTask).mockImplementation(async (_task, config) => {
      await writeFile(join(config.workspaceRoot, "source.txt"), "completed\n");
      return createExecutionResult({
        summary: config.workspaceRoot.replace(/\\/gu, "/"),
      });
    });
    const logger = await createRalphRunLogger(workspace, flow, {
      runId: "verified-merge",
    });
    const result = await runRalphFlow(
      flow,
      { ...runtimeConfig, workspaceRoot: workspace },
      customizations,
      {
        logger,
        isolatedWorktree: true,
      },
    );
    expect(result.status, result.summary).toBe("completed");
    expect(result.integration).toMatchObject({
      status: "merged",
      changedPaths: ["source.txt"],
    });
    expect(await readFile(join(workspace, "source.txt"), "utf8")).toBe(
      "completed\n",
    );
    const traces = await readFile(logger.paths!.traceJsonlPath, "utf8");
    expect(traces).toContain("-integration-0/verify.mjs");
    const record = JSON.parse(
      await readFile(logger.paths!.recordPath, "utf8"),
    ) as RalphRunRecord;
    expect(record.integration).toEqual(result.integration);
    expect(record.status).toBe("completed");
  }, 120_000);

  it("uses the model to repair a conflict in the integration workspace", async () => {
    const workspace = await createWorkspace();
    const flow = createFlow({
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "work",
          type: "PROMPT",
          title: "Work",
          prompt: "Complete the task.",
        },
        { id: "success", type: "END", title: "Success" },
      ],
      edges: [
        { id: "start-work", from: "start", fromOutput: "SUCCESS", to: "work" },
        {
          id: "work-success",
          from: "work",
          fromOutput: "SUCCESS",
          to: "success",
        },
      ],
    });
    const roots: string[] = [];
    vi.mocked(executeTask).mockImplementation(
      async (task, config, _customizations, options) => {
        roots.push(config.workspaceRoot);
        if (roots.length === 1) {
          await writeFile(join(workspace, "source.txt"), "external edit\n");
          await writeFile(
            join(config.workspaceRoot, "source.txt"),
            "run edit\n",
          );
        } else {
          expect(task).toContain("Resolve the Git merge conflicts");
          expect(config.workspaceRoot).toContain("-integration-0");
          expect(options?.resolvedInstructions?.canonicalDigest).toBe(
            vi.mocked(executeTask).mock.calls[0]?.[3]?.resolvedInstructions
              ?.canonicalDigest,
          );
          expect(await readFile(join(workspace, "source.txt"), "utf8")).toBe(
            "external edit\n",
          );
          await writeFile(
            join(config.workspaceRoot, "source.txt"),
            "external edit and run edit\n",
          );
        }
        return createExecutionResult();
      },
    );
    const logger = await createRalphRunLogger(workspace, flow, {
      runId: "conflict-merge",
    });
    const result = await runRalphFlow(
      flow,
      { ...runtimeConfig, workspaceRoot: workspace },
      customizations,
      {
        logger,
        isolatedWorktree: true,
      },
    );
    expect(result.status, result.summary).toBe("completed");
    expect(result.integration?.status).toBe("merged");
    expect(roots).toHaveLength(2);
    expect(roots[0]).not.toBe(roots[1]);
    expect(await readFile(join(workspace, "source.txt"), "utf8")).toBe(
      "external edit and run edit\n",
    );
  }, 120_000);

  it("publishes completed work before a continuous flow waits for its next task", async () => {
    const workspace = await createWorkspace();
    const controller = new AbortController();
    const flow = createFlow({
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "work",
          type: "PROMPT",
          title: "Work",
          prompt: "Complete the task.",
        },
        {
          id: "done",
          type: "UTILITY",
          title: "Done",
          utility: {
            type: "APPEND_JSONL",
            path: ".machdoch/completed.jsonl",
            input: '{"status":"DONE"}',
            workOutcome: "DONE",
          },
        },
        {
          id: "wait",
          type: "UTILITY",
          title: "Wait",
          utility: { type: "WAIT", delaySeconds: 60 },
        },
        { id: "success", type: "END", title: "Success" },
      ],
      edges: [
        { id: "start-work", from: "start", fromOutput: "SUCCESS", to: "work" },
        { id: "work-done", from: "work", fromOutput: "SUCCESS", to: "done" },
        { id: "done-wait", from: "done", fromOutput: "SUCCESS", to: "wait" },
        {
          id: "wait-success",
          from: "wait",
          fromOutput: "SUCCESS",
          to: "success",
        },
      ],
    });
    vi.mocked(executeTask).mockImplementation(async (_task, config) => {
      await writeFile(
        join(config.workspaceRoot, "source.txt"),
        "completed task\n",
      );
      return createExecutionResult();
    });
    let observedPublishedWork = false;
    const logger = await createRalphRunLogger(workspace, flow, {
      runId: "continuous-merge",
    });
    const result = await runRalphFlow(
      flow,
      { ...runtimeConfig, workspaceRoot: workspace },
      customizations,
      {
        logger,
        isolatedWorktree: true,
        signal: controller.signal,
        onEvent: async (event) => {
          if (event.type === "block-start" && event.blockId === "wait") {
            observedPublishedWork =
              (await readFile(join(workspace, "source.txt"), "utf8")) ===
              "completed task\n";
            controller.abort("Test complete");
          }
        },
      },
    );
    expect(observedPublishedWork, result.summary).toBe(true);
    expect(result.status).toBe("stopped");
    expect(result.integration?.status).toBe("merged");
  }, 120_000);
});
