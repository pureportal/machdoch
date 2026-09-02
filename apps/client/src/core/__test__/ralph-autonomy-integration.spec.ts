import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverRalphScopeEvidence,
  readRalphScopeRegistryFile,
  updateRalphScopeRegistryFromEvidence,
  writeRalphScopeRegistryFile,
} from "../_helpers/ralph-scope-registry.helper.js";
import { runRalphFlow } from "../ralph.js";
import { STARTER_RALPH_FLOWS } from "../ralph-starter-flows.js";
import {
  createFlow,
  customizations,
  runtimeConfig,
} from "./ralph-test-helpers.js";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map((workspace) => rm(workspace, { recursive: true, force: true })),
  );
});

const createWorkspace = async (): Promise<string> => {
  const workspace = await mkdtemp(join(tmpdir(), "ralph-autonomy-"));
  workspaces.push(workspace);
  return workspace;
};

describe("RALPH autonomy integration", () => {
  it("turns a premature successful END into a resumable verification blocker", async () => {
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "premature.flag"), "present\n", "utf8");
    const flow = createFlow({
      id: "premature-success",
      settings: { autonomy: true },
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "gate",
          type: "UTILITY",
          title: "Premature gate",
          utility: {
            type: "FILE_EXISTS",
            path: "premature.flag",
          },
        },
        {
          id: "baseline",
          type: "UTILITY",
          title: "Baseline verification",
          utility: {
            type: "RUN_CHECK",
            command: "node --version",
            verificationRole: "baseline",
            verificationPlanId: "frozen",
          },
        },
        {
          id: "candidate",
          type: "UTILITY",
          title: "Candidate verification",
          utility: {
            type: "RUN_CHECK",
            command: "node --version",
            verificationRole: "candidate",
            baselineBlockId: "baseline",
            verificationPlanId: "frozen",
          },
        },
        {
          id: "report",
          type: "UTILITY",
          title: "Report",
          utility: { type: "FINAL_REPORT" },
        },
        {
          id: "success",
          type: "END",
          title: "Success",
          status: "success",
          outcome: "succeeded",
        },
      ],
      edges: [
        {
          id: "start-gate",
          from: "start",
          fromOutput: "SUCCESS",
          to: "gate",
        },
        {
          id: "gate-success",
          from: "gate",
          fromOutput: "EXISTS",
          to: "success",
        },
        {
          id: "gate-baseline",
          from: "gate",
          fromOutput: "NOT_FOUND",
          to: "baseline",
        },
        {
          id: "baseline-candidate",
          from: "baseline",
          fromOutput: "SUCCESS",
          to: "candidate",
        },
        {
          id: "candidate-report",
          from: "candidate",
          fromOutput: "SUCCESS",
          to: "report",
        },
        {
          id: "report-success",
          from: "report",
          fromOutput: "SUCCESS",
          to: "success",
        },
      ],
    });

    const result = await runRalphFlow(
      flow,
      { ...runtimeConfig, workspaceRoot: workspace },
      { ...customizations, workspaceRoot: workspace },
    );

    expect(result).toMatchObject({
      status: "blocked",
      outcome: {
        status: "verification-inconclusive",
        verified: false,
        retryable: true,
      },
      checkpoint: expect.objectContaining({ currentBlockId: "gate" }),
    });
  }, 60_000);

  it("stops a repeated semantic cycle before exhausting the transition budget", async () => {
    const workspace = await createWorkspace();
    if (spawnSync("git", ["--version"]).status === 0) {
      await writeFile(join(workspace, "README.md"), "# Fixture\n", "utf8");
      expect(spawnSync("git", ["init"], { cwd: workspace }).status).toBe(0);
      expect(
        spawnSync("git", ["config", "user.email", "test@example.com"], {
          cwd: workspace,
        }).status,
      ).toBe(0);
      expect(
        spawnSync("git", ["config", "user.name", "Test"], { cwd: workspace })
          .status,
      ).toBe(0);
      expect(spawnSync("git", ["add", "."], { cwd: workspace }).status).toBe(0);
      expect(
        spawnSync("git", ["commit", "-m", "initial"], { cwd: workspace })
          .status,
      ).toBe(0);
    }
    const flow = createFlow({
      id: "semantic-cycle",
      settings: {
        maxTransitions: 30,
        autonomy: {
          maxStagnantTransitions: 20,
          maxRepeatedCycle: 2,
        },
      },
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "analyze",
          type: "UTILITY",
          title: "Analyze",
          utility: { type: "NOTIFY", message: "Same analysis." },
        },
        {
          id: "retry",
          type: "UTILITY",
          title: "Retry",
          utility: {
            type: "LOOP_COUNTER",
            path: ".machdoch/ralph/counters.json",
            counterName: "unproductive-cycle",
          },
        },
      ],
      edges: [
        {
          id: "start-analyze",
          from: "start",
          fromOutput: "SUCCESS",
          to: "analyze",
        },
        {
          id: "analyze-retry",
          from: "analyze",
          fromOutput: "SUCCESS",
          to: "retry",
        },
        {
          id: "retry-analyze",
          from: "retry",
          fromOutput: "CONTINUE",
          to: "analyze",
        },
      ],
    });

    const result = await runRalphFlow(
      flow,
      { ...runtimeConfig, workspaceRoot: workspace },
      { ...customizations, workspaceRoot: workspace },
    );

    expect(result).toMatchObject({
      status: "blocked",
      outcome: {
        status: "stalled",
        verified: false,
        retryable: true,
      },
      autonomy: {
        exhaustion: {
          kind: "stagnation",
        },
      },
    });
    expect(result.autonomy!.totalTransitions).toBeLessThan(30);
    expect(result.progress?.stalledReason).toContain(
      "2-step semantic cycle repeated 2 times",
    );
  });

  it("routes repeated execution failures through recovery instead of semantic-cycle handling", async () => {
    const workspace = await createWorkspace();
    const ledgerPath = join(workspace, "events.jsonl.ralph-operations.json");
    await mkdir(ledgerPath);
    const flow = createFlow({
      id: "repeated-execution-failure",
      settings: {
        maxTransitions: 20,
        autonomy: {
          recoveryExhaustion: "defer",
          deferToBlockId: "defer-work",
          maxStagnantTransitions: 20,
          maxRepeatedCycle: 3,
        },
      },
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "append",
          type: "UTILITY",
          title: "Append",
          settings: {
            retry: { mode: "finite", maxRetries: 3, delaySeconds: 0 },
          },
          utility: {
            type: "APPEND_JSONL",
            path: "events.jsonl",
            input: '{"item":1}',
          },
        },
        {
          id: "defer-work",
          type: "UTILITY",
          title: "Defer work",
          utility: { type: "NOTIFY", message: "Deferred." },
        },
        {
          id: "deferred",
          type: "END",
          title: "Deferred",
          outcome: "deferred",
        },
      ],
      edges: [
        {
          id: "start-append",
          from: "start",
          fromOutput: "SUCCESS",
          to: "append",
        },
        {
          id: "append-error",
          from: "append",
          fromOutput: "ERROR",
          to: "defer-work",
        },
        {
          id: "defer-end",
          from: "defer-work",
          fromOutput: "SUCCESS",
          to: "deferred",
        },
      ],
    });

    const result = await runRalphFlow(
      flow,
      { ...runtimeConfig, workspaceRoot: workspace },
      { ...customizations, workspaceRoot: workspace },
    );

    expect(result.status).toBe("blocked");
    expect(
      result.blockResults.filter((entry) => entry.blockId === "append"),
    ).toHaveLength(3);
    expect(result.progress?.stalledReason).toBeUndefined();
    expect(result.progress?.recent.slice(-4, -1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blockId: "append",
          cycleEligible: false,
        }),
      ]),
    );
    expect(result.autonomy?.exhaustion).toMatchObject({
      kind: "repeated-failure",
      blockId: "append",
    });
    expect(result.autonomy?.deferred).toEqual([
      expect.objectContaining({
        blockId: "append",
        routedToBlockId: "defer-work",
      }),
    ]);
  });

  it("blocks a failing defer target instead of routing recovery back to itself", async () => {
    const workspace = await createWorkspace();
    const flow = createFlow({
      id: "failing-defer-target",
      settings: {
        maxTransitions: 20,
        autonomy: {
          recoveryExhaustion: "defer",
          deferToBlockId: "defer-work",
          maxStagnantTransitions: 20,
          maxRepeatedCycle: 3,
        },
      },
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "defer-work",
          type: "UTILITY",
          title: "Defer work",
          utility: {
            type: "VALIDATE_JSON",
            input: "{}",
            schema: { type: "object", required: ["ok"] },
          },
        },
      ],
      edges: [
        {
          id: "start-defer",
          from: "start",
          fromOutput: "SUCCESS",
          to: "defer-work",
        },
        {
          id: "defer-retry",
          from: "defer-work",
          fromOutput: "INVALID",
          to: "defer-work",
        },
      ],
    });

    const result = await runRalphFlow(
      flow,
      { ...runtimeConfig, workspaceRoot: workspace },
      { ...customizations, workspaceRoot: workspace },
    );

    expect(result.status).toBe("blocked");
    expect(result.summary).toContain("after 3 identical non-success result(s)");
    expect(
      result.blockResults.filter((entry) => entry.blockId === "defer-work"),
    ).toHaveLength(3);
    expect(result.progress?.stalledReason).toBeUndefined();
    expect(result.autonomy).toMatchObject({
      exhaustion: {
        kind: "repeated-failure",
        blockId: "defer-work",
      },
      deferred: [],
    });
  });

  it("does not defer failed-end recovery to its current block", async () => {
    const workspace = await createWorkspace();
    const flow = createFlow({
      id: "self-targeted-failed-end-recovery",
      settings: {
        maxTransitions: 20,
        autonomy: {
          recoverFailedEnd: true,
          maxRecoveryAttempts: 1,
          backoff: { initialDelaySeconds: 0, maxDelaySeconds: 0 },
          recoveryExhaustion: "defer",
          deferToBlockId: "validate",
          maxStagnantTransitions: 20,
          maxRepeatedCycle: 3,
        },
      },
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "validate",
          type: "UTILITY",
          title: "Validate",
          utility: {
            type: "VALIDATE_JSON",
            input: "{}",
            schema: { type: "object", required: ["ok"] },
          },
        },
        { id: "failed", type: "END", title: "Failed", status: "failed" },
      ],
      edges: [
        {
          id: "start-validate",
          from: "start",
          fromOutput: "SUCCESS",
          to: "validate",
        },
        {
          id: "validate-failed",
          from: "validate",
          fromOutput: "INVALID",
          to: "failed",
        },
      ],
    });

    const result = await runRalphFlow(
      flow,
      { ...runtimeConfig, workspaceRoot: workspace },
      { ...customizations, workspaceRoot: workspace },
    );

    expect(result.status).toBe("blocked");
    expect(
      result.blockResults.filter((entry) => entry.blockId === "validate"),
    ).toHaveLength(2);
    expect(result.progress?.stalledReason).toBeUndefined();
    expect(result.autonomy).toMatchObject({
      exhaustion: {
        kind: "recovery",
        blockId: "validate",
      },
      deferred: [],
    });
    expect(result.blockResults.at(-2)?.recovery).toMatchObject({
      disposition: "exhausted",
    });
  });

  it("continues a repeated route when repository output proves progress", async () => {
    if (spawnSync("git", ["--version"]).status !== 0) {
      return;
    }

    const workspace = await createWorkspace();
    await writeFile(join(workspace, "README.md"), "# Fixture\n", "utf8");
    expect(spawnSync("git", ["init"], { cwd: workspace }).status).toBe(0);
    expect(
      spawnSync("git", ["config", "user.email", "test@example.com"], {
        cwd: workspace,
      }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "user.name", "Test"], { cwd: workspace })
        .status,
    ).toBe(0);
    expect(spawnSync("git", ["add", "."], { cwd: workspace }).status).toBe(0);
    expect(
      spawnSync("git", ["commit", "-m", "initial"], { cwd: workspace }).status,
    ).toBe(0);

    const flow = createFlow({
      id: "productive-cycle",
      settings: {
        maxTransitions: 30,
        autonomy: {
          maxStagnantTransitions: 20,
          maxRepeatedCycle: 2,
        },
      },
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "write",
          type: "UTILITY",
          title: "Write product output",
          utility: {
            type: "APPEND_JSONL",
            path: "work.jsonl",
            input: '{"worked":true}',
          },
        },
        {
          id: "counter",
          type: "UTILITY",
          title: "Bound passes",
          utility: {
            type: "LOOP_COUNTER",
            path: ".machdoch/ralph/counters.json",
            counterName: "productive-cycle",
            maxAttempts: 2,
          },
        },
        {
          id: "success",
          type: "END",
          title: "Success",
          outcome: "deferred",
        },
      ],
      edges: [
        {
          id: "start-write",
          from: "start",
          fromOutput: "SUCCESS",
          to: "write",
        },
        {
          id: "write-counter",
          from: "write",
          fromOutput: "SUCCESS",
          to: "counter",
        },
        {
          id: "counter-write",
          from: "counter",
          fromOutput: "CONTINUE",
          to: "write",
        },
        {
          id: "counter-success",
          from: "counter",
          fromOutput: "LIMIT_REACHED",
          to: "success",
        },
      ],
    });

    const result = await runRalphFlow(
      flow,
      { ...runtimeConfig, workspaceRoot: workspace },
      { ...customizations, workspaceRoot: workspace },
    );

    expect(result).toMatchObject({
      status: "blocked",
      outcome: {
        status: "deferred",
        verified: false,
        retryable: true,
      },
    });
    expect(result.progress?.stalledReason).toBeUndefined();
    expect(result.progress?.meaningfulTransitions).toBeGreaterThan(0);
    expect(
      result.blockResults.filter((entry) => entry.blockId === "write"),
    ).toHaveLength(3);
    expect(
      (await readFile(join(workspace, "work.jsonl"), "utf8"))
        .trim()
        .split("\n"),
    ).toHaveLength(3);
  }, 60_000);

  it("continues a durable task portfolio after one task is deferred", async () => {
    const workspace = await createWorkspace();
    const portfolioPath = join(workspace, "portfolio.json");
    await writeFile(
      portfolioPath,
      JSON.stringify({
        tasks: [
          {
            id: "recoverable-first",
            status: "planned",
            priority: 100,
          },
          {
            id: "ready-second",
            status: "planned",
            priority: 90,
          },
        ],
      }),
      "utf8",
    );

    const flow = createFlow({
      id: "persistent-task-portfolio",
      settings: { maxTransitions: 40 },
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "assess",
          type: "UTILITY",
          title: "Assess portfolio",
          utility: {
            type: "ASSESS_JSON_TASKS",
            path: "portfolio.json",
            jsonPath: "tasks",
            strategy: "priority",
            maxTasks: 1,
          },
        },
        {
          id: "select",
          type: "UTILITY",
          title: "Select task",
          utility: {
            type: "SELECT_JSON_TASK",
            path: "portfolio.json",
            jsonPath: "tasks",
            strategy: "priority",
            maxTasks: 1,
          },
        },
        {
          id: "defer-first",
          type: "UTILITY",
          title: "Defer first task",
          utility: {
            type: "CONDITION",
            condition: {
              style: "javascript",
              expression: 'lastData?.tasks?.[0]?.id === "recoverable-first"',
            },
          },
        },
        {
          id: "mark-deferred",
          type: "UTILITY",
          title: "Mark task deferred",
          utility: {
            type: "MARK_JSON_TASK",
            path: "portfolio.json",
            jsonPath: "tasks",
            input: "{{data:select}}",
            status: "deferred",
            delaySeconds: 3_600,
          },
        },
        {
          id: "mark-verifying",
          type: "UTILITY",
          title: "Mark task verifying",
          utility: {
            type: "MARK_JSON_TASK",
            path: "portfolio.json",
            jsonPath: "tasks",
            input: "{{data:select}}",
            status: "verifying",
          },
        },
        {
          id: "mark-completed",
          type: "UTILITY",
          title: "Mark task completed",
          utility: {
            type: "MARK_JSON_TASK",
            path: "portfolio.json",
            jsonPath: "tasks",
            input: "{{data:select}}",
            status: "completed",
          },
        },
        {
          id: "success",
          type: "END",
          title: "Success",
          status: "success",
          outcome: "succeeded",
        },
        {
          id: "deferred",
          type: "END",
          title: "Deferred",
          outcome: "deferred",
        },
      ],
      edges: [
        {
          id: "start-assess",
          from: "start",
          fromOutput: "SUCCESS",
          to: "assess",
        },
        {
          id: "assess-ready",
          from: "assess",
          fromOutput: "READY",
          to: "select",
        },
        {
          id: "assess-complete",
          from: "assess",
          fromOutput: "COMPLETE",
          to: "success",
        },
        {
          id: "assess-blocked",
          from: "assess",
          fromOutput: "BLOCKED",
          to: "deferred",
        },
        {
          id: "assess-deferred",
          from: "assess",
          fromOutput: "DEFERRED",
          to: "deferred",
        },
        {
          id: "select-task",
          from: "select",
          fromOutput: "SELECTED",
          to: "defer-first",
        },
        {
          id: "select-empty",
          from: "select",
          fromOutput: "EMPTY",
          to: "deferred",
        },
        {
          id: "defer-first-task",
          from: "defer-first",
          fromOutput: "MATCH",
          to: "mark-deferred",
        },
        {
          id: "complete-next-task",
          from: "defer-first",
          fromOutput: "NO_MATCH",
          to: "mark-verifying",
        },
        {
          id: "deferred-reassess",
          from: "mark-deferred",
          fromOutput: "SUCCESS",
          to: "assess",
        },
        {
          id: "verifying-complete",
          from: "mark-verifying",
          fromOutput: "SUCCESS",
          to: "mark-completed",
        },
        {
          id: "completed-reassess",
          from: "mark-completed",
          fromOutput: "SUCCESS",
          to: "assess",
        },
      ],
    });

    const result = await runRalphFlow(
      flow,
      { ...runtimeConfig, workspaceRoot: workspace },
      { ...customizations, workspaceRoot: workspace },
      { runId: "persistent-task-portfolio" },
    );
    const portfolio = JSON.parse(await readFile(portfolioPath, "utf8")) as {
      tasks: Array<{ id: string; status: string; nextEligibleAt?: string }>;
    };

    expect(result).toMatchObject({
      status: "blocked",
      outcome: {
        status: "deferred",
        verified: false,
        retryable: true,
      },
    });
    expect(
      result.blockResults.filter((entry) => entry.blockId === "select"),
    ).toHaveLength(2);
    expect(
      result.blockResults.map((entry) => entry.blockId + ":" + entry.output),
    ).toEqual(
      expect.arrayContaining([
        "mark-deferred:SUCCESS",
        "mark-completed:SUCCESS",
        "assess:DEFERRED",
      ]),
    );
    expect(portfolio.tasks).toEqual([
      expect.objectContaining({
        id: "recoverable-first",
        status: "deferred",
        nextEligibleAt: expect.any(String),
      }),
      expect.objectContaining({ id: "ready-second", status: "completed" }),
    ]);
  });

  it("completes every eligible task in a durable portfolio before succeeding", async () => {
    const workspace = await createWorkspace();
    const portfolioPath = join(workspace, "complete-portfolio.json");
    await writeFile(
      portfolioPath,
      JSON.stringify({
        tasks: [
          { id: "first-opportunity", status: "planned", priority: 100 },
          { id: "second-opportunity", status: "planned", priority: 90 },
        ],
      }),
      "utf8",
    );

    const flow = createFlow({
      id: "complete-task-portfolio",
      settings: { maxTransitions: 40 },
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "assess",
          type: "UTILITY",
          title: "Assess portfolio",
          utility: {
            type: "ASSESS_JSON_TASKS",
            path: "complete-portfolio.json",
            jsonPath: "tasks",
            strategy: "priority",
            maxTasks: 1,
          },
        },
        {
          id: "select",
          type: "UTILITY",
          title: "Select task",
          utility: {
            type: "SELECT_JSON_TASK",
            path: "complete-portfolio.json",
            jsonPath: "tasks",
            strategy: "priority",
            maxTasks: 1,
          },
        },
        {
          id: "mark-verifying",
          type: "UTILITY",
          title: "Mark task verifying",
          utility: {
            type: "MARK_JSON_TASK",
            path: "complete-portfolio.json",
            jsonPath: "tasks",
            input: "{{data:select}}",
            status: "verifying",
          },
        },
        {
          id: "mark-completed",
          type: "UTILITY",
          title: "Mark task completed",
          utility: {
            type: "MARK_JSON_TASK",
            path: "complete-portfolio.json",
            jsonPath: "tasks",
            input: "{{data:select}}",
            status: "completed",
          },
        },
        {
          id: "baseline",
          type: "UTILITY",
          title: "Baseline",
          utility: {
            type: "RUN_CHECK",
            command: "node --version",
            verificationRole: "baseline",
            verificationPlanId: "complete-task-portfolio",
          },
        },
        {
          id: "candidate",
          type: "UTILITY",
          title: "Candidate",
          utility: {
            type: "RUN_CHECK",
            command: "node --version",
            verificationRole: "candidate",
            baselineBlockId: "baseline",
            verificationPlanId: "complete-task-portfolio",
          },
        },
        {
          id: "report",
          type: "UTILITY",
          title: "Report",
          utility: {
            type: "FINAL_REPORT",
            path: "complete-portfolio-report.json",
          },
        },
        {
          id: "success",
          type: "END",
          title: "Success",
          status: "success",
          outcome: "succeeded",
        },
      ],
      edges: [
        {
          id: "start-assess",
          from: "start",
          fromOutput: "SUCCESS",
          to: "assess",
        },
        {
          id: "assess-ready",
          from: "assess",
          fromOutput: "READY",
          to: "select",
        },
        {
          id: "assess-complete",
          from: "assess",
          fromOutput: "COMPLETE",
          to: "baseline",
        },
        {
          id: "select-task",
          from: "select",
          fromOutput: "SELECTED",
          to: "mark-verifying",
        },
        {
          id: "verifying-complete",
          from: "mark-verifying",
          fromOutput: "SUCCESS",
          to: "mark-completed",
        },
        {
          id: "completed-reassess",
          from: "mark-completed",
          fromOutput: "SUCCESS",
          to: "assess",
        },
        {
          id: "baseline-candidate",
          from: "baseline",
          fromOutput: "SUCCESS",
          to: "candidate",
        },
        {
          id: "candidate-report",
          from: "candidate",
          fromOutput: "SUCCESS",
          to: "report",
        },
        {
          id: "report-success",
          from: "report",
          fromOutput: "SUCCESS",
          to: "success",
        },
      ],
    });

    const result = await runRalphFlow(
      flow,
      { ...runtimeConfig, workspaceRoot: workspace },
      { ...customizations, workspaceRoot: workspace },
      { runId: "complete-task-portfolio" },
    );
    const portfolio = JSON.parse(await readFile(portfolioPath, "utf8")) as {
      tasks: Array<{ id: string; status: string }>;
    };

    expect(result).toMatchObject({
      status: "completed",
      outcome: {
        status: "succeeded",
        verified: true,
        retryable: false,
      },
    });
    expect(
      result.blockResults.filter((entry) => entry.blockId === "select"),
    ).toHaveLength(2);
    expect(
      result.blockResults.map((entry) => entry.blockId + ":" + entry.output),
    ).toEqual(expect.arrayContaining(["assess:COMPLETE", "success:SUCCESS"]));
    expect(portfolio.tasks).toEqual([
      expect.objectContaining({ id: "first-opportunity", status: "completed" }),
      expect.objectContaining({
        id: "second-opportunity",
        status: "completed",
      }),
    ]);
  });

  it("starts a new scope cycle only after prior coverage is terminal", async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "index.ts"), "export {};\n", {
      encoding: "utf8",
      flag: "w",
    });
    const registryPath = join(workspace, "scope-registry.json");
    const evidence = await discoverRalphScopeEvidence(workspace);
    const registry = updateRalphScopeRegistryFromEvidence(
      await readRalphScopeRegistryFile(registryPath, {
        flowAlias: "cycle-test",
        strategy: "start-to-end",
      }),
      evidence,
      { flowAlias: "cycle-test", strategy: "start-to-end" },
    ).registry;
    const activeScopeIds = registry.scopes
      .filter((scope) => scope.status === "active")
      .map((scope) => scope.id);

    await writeRalphScopeRegistryFile(registryPath, {
      ...registry,
      selection: {
        ...registry.selection,
        completedScopeIds: activeScopeIds,
      },
      scopes: registry.scopes.map((scope) =>
        scope.status === "active"
          ? {
              ...scope,
              lastOutcome: "completed",
              eligibleAfter: null,
            }
          : scope,
      ),
    });

    const exhaustedFlow = createFlow({
      id: "exhausted-scope-cycle",
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "select",
          type: "UTILITY",
          title: "Select scope",
          utility: {
            type: "SELECT_SCOPE",
            flowAlias: "cycle-test",
            registryPath: "scope-registry.json",
            strategy: "start-to-end",
          },
        },
        {
          id: "success",
          type: "END",
          title: "Success",
          status: "success",
          outcome: "succeeded",
        },
      ],
      edges: [
        {
          id: "start-select",
          from: "start",
          fromOutput: "SUCCESS",
          to: "select",
        },
        {
          id: "exhausted-success",
          from: "select",
          fromOutput: "EXHAUSTED",
          to: "success",
        },
      ],
    });
    const exhausted = await runRalphFlow(
      exhaustedFlow,
      { ...runtimeConfig, workspaceRoot: workspace },
      { ...customizations, workspaceRoot: workspace },
      { runId: "exhausted-scope-cycle" },
    );
    const unchanged = await readRalphScopeRegistryFile(registryPath, {
      flowAlias: "cycle-test",
      strategy: "start-to-end",
    });

    expect(exhausted.status).toBe("completed");
    expect(
      exhausted.blockResults.find((entry) => entry.blockId === "select"),
    ).toMatchObject({
      output: "EXHAUSTED",
      data: { availability: { status: "exhausted" } },
    });
    expect(unchanged.selection.cycle).toBe(1);
    expect(unchanged.selection.completedScopeIds).toEqual(activeScopeIds);

    const flow = createFlow({
      id: "begin-scope-cycle",
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "begin",
          type: "UTILITY",
          title: "Begin scope cycle",
          utility: {
            type: "BEGIN_SCOPE_CYCLE",
            flowAlias: "cycle-test",
            registryPath: "scope-registry.json",
            strategy: "start-to-end",
          },
        },
        {
          id: "select",
          type: "UTILITY",
          title: "Select scope",
          utility: {
            type: "SELECT_SCOPE",
            flowAlias: "cycle-test",
            registryPath: "scope-registry.json",
            strategy: "start-to-end",
          },
        },
        {
          id: "success",
          type: "END",
          title: "Success",
          status: "success",
          outcome: "succeeded",
        },
      ],
      edges: [
        {
          id: "start-begin",
          from: "start",
          fromOutput: "SUCCESS",
          to: "begin",
        },
        {
          id: "begin-select",
          from: "begin",
          fromOutput: "SUCCESS",
          to: "select",
        },
        {
          id: "select-success",
          from: "select",
          fromOutput: "SELECTED",
          to: "success",
        },
      ],
    });

    const result = await runRalphFlow(
      flow,
      { ...runtimeConfig, workspaceRoot: workspace },
      { ...customizations, workspaceRoot: workspace },
      { runId: "begin-scope-cycle" },
    );
    const persisted = await readRalphScopeRegistryFile(registryPath, {
      flowAlias: "cycle-test",
      strategy: "start-to-end",
    });

    expect(result.status).toBe("completed");
    expect(
      result.blockResults.find((entry) => entry.blockId === "begin"),
    ).toMatchObject({
      output: "SUCCESS",
      data: { cycleStarted: true, cycle: 2 },
    });
    expect(
      result.blockResults.find((entry) => entry.blockId === "select"),
    ).toMatchObject({ output: "SELECTED" });
    expect(persisted.selection.cycle).toBe(2);
    expect(persisted.selection.completedScopeIds).toEqual([]);
  });

  it("defers the real security starter when every scope is temporarily ineligible", async () => {
    if (spawnSync("git", ["--version"]).status !== 0) {
      return;
    }

    const workspace = await createWorkspace();
    expect(spawnSync("git", ["init"], { cwd: workspace }).status).toBe(0);
    expect(
      spawnSync("git", ["config", "user.email", "test@example.com"], {
        cwd: workspace,
      }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "user.name", "Test"], { cwd: workspace })
        .status,
    ).toBe(0);
    expect(
      spawnSync("git", ["commit", "--allow-empty", "-m", "initial"], {
        cwd: workspace,
      }).status,
    ).toBe(0);
    const registryPath = join(
      workspace,
      ".machdoch",
      "ralph",
      "scope-registry",
      "security-review-fix-loop.scope-registry.json",
    );
    const evidence = await discoverRalphScopeEvidence(workspace);
    const emptyRegistry = await readRalphScopeRegistryFile(registryPath, {
      flowAlias: "security-review-fix-loop",
      strategy: "risk-first",
    });
    const registry = updateRalphScopeRegistryFromEvidence(
      emptyRegistry,
      evidence,
      {
        flowAlias: "security-review-fix-loop",
        strategy: "risk-first",
      },
    ).registry;
    await writeRalphScopeRegistryFile(registryPath, {
      ...registry,
      scopes: registry.scopes.map((scope) => ({
        ...scope,
        lastOutcome: "deferred",
        lastOutcomeAt: new Date().toISOString(),
        eligibleAfter: "2099-01-01T00:00:00.000Z",
      })),
    });
    const starter = STARTER_RALPH_FLOWS.find(
      (candidate) => candidate.id === "security-fix-loop",
    )!;

    const result = await runRalphFlow(
      starter.flow,
      { ...runtimeConfig, workspaceRoot: workspace },
      { ...customizations, workspaceRoot: workspace },
      { runId: "starter-security-no-op" },
    );

    expect(
      result,
      JSON.stringify(
        {
          summary: result.summary,
          progress: result.progress,
          blocks: result.blockResults.map((entry) => ({
            id: entry.blockId,
            output: entry.output,
            summary: entry.summary,
          })),
        },
        null,
        2,
      ),
    ).toMatchObject({
      status: "blocked",
      outcome: {
        status: "deferred",
        verified: false,
        retryable: true,
      },
    });
    expect(result.blockResults.map((entry) => entry.blockId)).toEqual(
      expect.arrayContaining([
        "scan-scopes",
        "select-scope",
        "record-coverage-deferred-outcome",
        "retained-outcome-report",
        "deferred",
      ]),
    );
    expect(
      result.blockResults.find(
        (entry) => entry.blockId === "retained-outcome-report",
      )?.data,
    ).toMatchObject({
      outcome: { status: "deferred", verified: false },
      lifecycle: { status: "blocked" },
    });
    expect(
      (
        await readFile(
          join(
            workspace,
            ".machdoch",
            "ralph",
            "runs",
            "starter-security-no-op",
            "security",
            "final-report.json",
          ),
          "utf8",
        )
      ).trim(),
    ).toContain('"status": "deferred"');
  }, 60_000);
});
