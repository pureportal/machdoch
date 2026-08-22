import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
          outcome: "succeeded",
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

    expect(result.outcome?.status).toBe("verification-inconclusive");
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

  it("runs the real security starter to a verified no-op when no scope is eligible", async () => {
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
      status: "completed",
      outcome: {
        status: "no-op",
        verified: true,
        retryable: false,
      },
    });
    expect(result.blockResults.map((entry) => entry.blockId)).toEqual(
      expect.arrayContaining([
        "scan-scopes",
        "record-stop-outcome",
        "final-report",
        "success",
      ]),
    );
    expect(
      result.blockResults.find((entry) => entry.blockId === "final-report")
        ?.data,
    ).toMatchObject({
      outcome: { status: "no-op", verified: true },
      lifecycle: { status: "completed" },
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
    ).toContain('"status": "no-op"');
  }, 60_000);
});
