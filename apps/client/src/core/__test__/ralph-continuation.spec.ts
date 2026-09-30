import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTask } from "../execution.js";
import {
  createRalphRunLogger,
  readRalphFlow,
  runRalphFlow,
  validateRalphFlow,
  writeRalphFlow,
  type RalphAutonomyPolicy,
  type RalphFlow,
} from "../ralph.js";
import {
  createFlow,
  createExecutionResult,
  customizations as baseCustomizations,
  runtimeConfig as baseRuntimeConfig,
} from "./ralph-test-helpers.js";

vi.mock("../execution.js", () => ({ executeTask: vi.fn() }));

const workspaces: string[] = [];
let runtimeConfig = baseRuntimeConfig;
let customizations = baseCustomizations;
beforeEach(async () => {
  vi.mocked(executeTask).mockReset();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "ralph-continuation-test-"),
  );
  workspaces.push(workspaceRoot);
  runtimeConfig = { ...baseRuntimeConfig, workspaceRoot };
  customizations = { ...baseCustomizations, workspaceRoot };
});
afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const createContinuousFlow = (autonomy: RalphAutonomyPolicy = {}): RalphFlow =>
  createFlow({
    id: "continuous-test",
    variables: [
      { name: "continuous", type: "boolean", default: "true", required: false },
    ],
    settings: {
      autonomy: {
        restartToBlockId: "start",
        restartDelaySeconds: 0,
        maxStagnantTransitions: 48,
        maxRepeatedCycle: 3,
        ...autonomy,
      },
    },
    blocks: [
      { id: "start", type: "START", title: "Start" },
      {
        id: "work",
        type: "UTILITY",
        title: "Work",
        utility: { type: "WAIT", delaySeconds: 0 },
      },
      {
        id: "success",
        type: "END",
        title: "Success",
        status: "success",
        outcome: "no-op",
      },
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

describe("RALPH continuous execution", () => {
  it("repeats successful cycles until explicitly stopped", async () => {
    const controller = new AbortController();
    let cycles = 0;
    const result = await runRalphFlow(
      createContinuousFlow(),
      runtimeConfig,
      customizations,
      {
        signal: controller.signal,
        onEvent: (event) => {
          if (
            event.type === "edge-route" &&
            event.from === "success" &&
            ++cycles === 5
          )
            controller.abort();
        },
      },
    );
    expect(result.status).toBe("stopped");
    expect(cycles).toBe(5);
    expect(
      result.blockResults.filter((entry) => entry.blockId === "work"),
    ).toHaveLength(5);
    expect(result.checkpoint?.currentBlockId).toBe("start");
  });

  it("ends after one cycle when continuous is false", async () => {
    const result = await runRalphFlow(
      createContinuousFlow(),
      runtimeConfig,
      customizations,
      {
        variableValues: { continuous: "false" },
      },
    );
    expect(result.status).toBe("blocked");
    expect(result.outcome).toMatchObject({
      status: "verification-inconclusive",
      verified: false,
    });
    expect(result.blockResults.map((entry) => entry.blockId)).toEqual([
      "start",
      "work",
      "success",
    ]);
  });

  it("defers matching failures and continues across multiple recovery cycles", async () => {
    const flow = createContinuousFlow({ deferToBlockId: "defer" });
    flow.blocks[1] = {
      id: "work",
      type: "UTILITY",
      title: "Work",
      utility: {
        type: "VALIDATE_JSON",
        input: "{}",
        schema: { required: ["ready"] },
      },
    };
    flow.blocks.push({
      id: "defer",
      type: "UTILITY",
      title: "Defer",
      utility: { type: "WAIT", delaySeconds: 0 },
    });
    flow.edges[1] = {
      id: "work-retry",
      from: "work",
      fromOutput: "INVALID",
      to: "work",
    };
    flow.edges.push({
      id: "defer-restart",
      from: "defer",
      fromOutput: "SUCCESS",
      to: "start",
    });
    const controller = new AbortController();
    let deferred = 0;
    const result = await runRalphFlow(flow, runtimeConfig, customizations, {
      signal: controller.signal,
      repeatedFailureLimit: 3,
      onEvent: (event) => {
        if (
          event.type === "edge-route" &&
          event.from === "work" &&
          event.to === "defer" &&
          ++deferred === 2
        )
          controller.abort();
      },
    });
    expect(result.status).toBe("stopped");
    expect(
      result.blockResults.filter((entry) => entry.blockId === "work"),
    ).toHaveLength(6);
    expect(result.autonomy?.deferred).toHaveLength(2);
    expect(result.checkpoint?.repeatedFailures).toEqual({});
  });

  it("repeats deferred terminal outcomes without declaring success", async () => {
    const flow = createContinuousFlow();
    flow.blocks[2] = {
      id: "success",
      type: "END",
      title: "Deferred",
      status: "failed",
      outcome: "deferred",
    };
    const controller = new AbortController();
    let cycles = 0;
    const result = await runRalphFlow(flow, runtimeConfig, customizations, {
      signal: controller.signal,
      onEvent: (event) => {
        if (
          event.type === "edge-route" &&
          event.from === "success" &&
          ++cycles === 3
        )
          controller.abort();
      },
    });
    expect(result.status).toBe("stopped");
    expect(cycles).toBe(3);
    expect(result.outcome?.verified).toBe(false);
  });

  it("continues after consecutive provider failures exhaust local recovery", async () => {
    vi.mocked(executeTask).mockResolvedValue(
      createExecutionResult({
        status: "blocked",
        summary: "Provider unavailable.",
        reason: "Retryable provider failure.",
      }),
    );
    const flow = createContinuousFlow({
      deferToBlockId: "defer",
      maxRecoveryAttempts: 2,
      backoff: { initialDelaySeconds: 0, maxDelaySeconds: 0 },
    });
    flow.blocks[1] = {
      id: "work",
      type: "PROMPT",
      title: "Work",
      prompt: "Do work.",
    };
    flow.blocks.push(
      { id: "failed", type: "END", title: "Failed", status: "failed" },
      {
        id: "defer",
        type: "UTILITY",
        title: "Defer",
        utility: { type: "WAIT", delaySeconds: 0 },
      },
    );
    flow.edges.push(
      { id: "work-error", from: "work", fromOutput: "ERROR", to: "failed" },
      { id: "defer-start", from: "defer", fromOutput: "SUCCESS", to: "start" },
    );
    const controller = new AbortController();
    let deferred = 0;
    const result = await runRalphFlow(flow, runtimeConfig, customizations, {
      signal: controller.signal,
      onEvent: (event) => {
        if (
          event.type === "edge-route" &&
          event.from === "work" &&
          event.to === "defer" &&
          ++deferred === 2
        )
          controller.abort();
      },
    });
    expect(result.status).toBe("stopped");
    expect(executeTask).toHaveBeenCalledTimes(6);
    expect(result.autonomy?.deferred).toHaveLength(2);
  });

  it("honors a cancellation terminal without restarting", async () => {
    const flow = createContinuousFlow();
    flow.blocks[2] = {
      id: "success",
      type: "END",
      title: "Cancelled",
      status: "failed",
      outcome: "cancelled",
    };
    const result = await runRalphFlow(flow, runtimeConfig, customizations);
    expect(result.outcome?.status).toBe("cancelled");
    expect(result.blockResults).toHaveLength(3);
  });

  it("restarts when the deferral block itself keeps failing", async () => {
    const flow = createContinuousFlow({ deferToBlockId: "work" });
    flow.blocks[1] = {
      id: "work",
      type: "UTILITY",
      title: "Work",
      utility: {
        type: "VALIDATE_JSON",
        input: "{}",
        schema: { required: ["ready"] },
      },
    };
    flow.edges[1] = {
      id: "work-retry",
      from: "work",
      fromOutput: "INVALID",
      to: "work",
    };
    const controller = new AbortController();
    const result = await runRalphFlow(flow, runtimeConfig, customizations, {
      signal: controller.signal,
      onEvent: (event) => {
        if (
          event.type === "edge-route" &&
          event.from === "work" &&
          event.to === "start"
        )
          controller.abort();
      },
    });
    expect(result.status).toBe("stopped");
    expect(result.autonomy?.exhaustion?.kind).toBe("repeated-failure");
    expect(result.checkpoint?.currentBlockId).toBe("start");
  });

  it("recovers stagnation without claiming objective progress", async () => {
    const flow = createContinuousFlow({ maxStagnantTransitions: 4 });
    flow.edges[1] = {
      id: "work-loop",
      from: "work",
      fromOutput: "SUCCESS",
      to: "work",
    };
    const controller = new AbortController();
    const result = await runRalphFlow(flow, runtimeConfig, customizations, {
      signal: controller.signal,
      onEvent: (event) => {
        if (
          event.type === "edge-route" &&
          event.from === "work" &&
          event.to === "start"
        )
          controller.abort();
      },
    });
    expect(result.status).toBe("stopped");
    expect(result.autonomy?.exhaustion?.kind).toBe("stagnation");
    expect(result.progress?.meaningfulTransitions).toBe(0);
    expect(result.checkpoint?.progress?.consecutiveNoProgress).toBe(0);
  });

  it("retains explicit caller budgets in continuous mode", async () => {
    const result = await runRalphFlow(
      createContinuousFlow(),
      runtimeConfig,
      customizations,
      { maxTotalTransitions: 12 },
    );
    expect(result.status).toBe("crashed");
    expect(result.autonomy?.exhaustion).toMatchObject({
      kind: "max-transitions",
      totalTransitions: 12,
    });
  });

  it("keeps recovery history bounded during sustained failures", async () => {
    const flow = createContinuousFlow({ deferToBlockId: "work" });
    flow.blocks[1] = {
      id: "work",
      type: "UTILITY",
      title: "Work",
      utility: {
        type: "VALIDATE_JSON",
        input: "{}",
        schema: { required: ["ready"] },
      },
    };
    flow.edges[1] = {
      id: "work-retry",
      from: "work",
      fromOutput: "INVALID",
      to: "work",
    };
    const result = await runRalphFlow(flow, runtimeConfig, customizations, {
      maxTotalTransitions: 230,
      repeatedFailureLimit: 1,
    });
    expect(result.status).toBe("crashed");
    expect(result.autonomy?.deferred).toHaveLength(100);
    expect(result.checkpoint?.autonomy?.deferred).toHaveLength(100);
  });

  it("persists the cooldown and resumes it before executing more work", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-continuation-"));
    workspaces.push(workspace);
    const flow = createContinuousFlow({ restartDelaySeconds: 0.12 });
    const config = { ...runtimeConfig, workspaceRoot: workspace };
    const logger = await createRalphRunLogger(workspace, flow);
    const controller = new AbortController();
    const first = await runRalphFlow(
      flow,
      config,
      { ...customizations, workspaceRoot: workspace },
      {
        logger,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "edge-route" && event.from === "success")
            setTimeout(() => controller.abort(), 10);
        },
      },
    );
    expect(first.status).toBe("stopped");
    expect(first.checkpoint?.nextRetryAt).toBeDefined();
    const retryAt = Date.parse(first.checkpoint!.nextRetryAt!);
    expect(
      first.blockResults.filter((entry) => entry.blockId === "work"),
    ).toHaveLength(1);
    const resumedController = new AbortController();
    let resumedAt = 0;
    const resumed = await runRalphFlow(
      flow,
      config,
      { ...customizations, workspaceRoot: workspace },
      {
        logger,
        checkpoint: first.checkpoint!,
        signal: resumedController.signal,
        onEvent: (event) => {
          if (event.type === "block-start" && event.blockId === "work") {
            resumedAt = Date.now();
            resumedController.abort();
          }
        },
      },
    );
    expect(resumed.status).toBe("stopped");
    expect(resumedAt).toBeGreaterThanOrEqual(retryAt);
  });

  it("round-trips restart settings and rejects unsafe restart targets", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "ralph-continuation-storage-"),
    );
    workspaces.push(workspace);
    const flow = createContinuousFlow({ restartDelaySeconds: 42 });
    await writeRalphFlow(workspace, flow);
    expect(
      (await readRalphFlow(workspace, flow.id)).settings?.autonomy,
    ).toMatchObject({
      restartToBlockId: "start",
      restartDelaySeconds: 42,
    });
    expect(
      validateRalphFlow(createContinuousFlow({ restartToBlockId: "success" }))
        .valid,
    ).toBe(false);
    expect(
      validateRalphFlow(createContinuousFlow({ restartDelaySeconds: -1 }))
        .valid,
    ).toBe(false);
  });
});
