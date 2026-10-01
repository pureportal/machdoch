import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTask } from "../execution.js";
import { runRalphFlow } from "../ralph.js";
import { getRalphStarterFlow } from "../ralph-starter-flows.js";
import {
  createExecutionResult,
  customizations,
  runtimeConfig,
} from "./ralph-test-helpers.js";

vi.mock("../execution.js", () => ({ executeTask: vi.fn() }));

const initializeRepository = (workspace: string): void => {
  expect(spawnSync("git", ["init", "--quiet"], { cwd: workspace }).status).toBe(
    0,
  );
  expect(
    spawnSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "initial",
      ],
      { cwd: workspace },
    ).status,
  ).toBe(0);
};

describe("RALPH continuous code improvement", () => {
  beforeEach(() => {
    vi.mocked(executeTask).mockReset();
  });
  it("keeps waiting and rescanning an empty repository until stopped", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-continuous-idle-"));
    const controller = new AbortController();
    const flow = structuredClone(
      getRalphStarterFlow("autonomous-code-improvement-loop")!.flow,
    );
    const wait = flow.blocks.find(
      (block) => block.id === "wait-for-scope-cycle",
    );
    if (wait?.type !== "UTILITY") {
      throw new Error("Code improvement starter has no cycle delay.");
    }
    expect(wait.utility.delaySeconds).toBe(60);
    expect(flow.settings?.maxTransitions).toBeUndefined();
    wait.utility.delaySeconds = 0.02;
    let waits = 0;
    try {
      const result = await runRalphFlow(
        flow,
        { ...runtimeConfig, workspaceRoot: workspace },
        { ...customizations, workspaceRoot: workspace },
        {
          signal: controller.signal,
          variableValues: { excludePaths: "." },
          autonomy: { maxStagnantTransitions: 20 },
          onEvent: (event) => {
            if (event.type === "block-output" && event.blockId === wait.id) {
              waits += 1;
              if (waits === 4) controller.abort();
            }
          },
        },
      );
      expect(waits, result.summary).toBe(4);
      expect(
        result.blockResults.filter((entry) => entry.blockId === "scan-scopes"),
      ).toHaveLength(4);
      expect(result.autonomy?.totalTransitions).toBeGreaterThan(20);
      expect(result.autonomy?.exhaustion).toBeUndefined();
      expect(result.checkpoint?.progress?.meaningfulTransitions).toBe(0);
      for (const entry of result.blockResults.filter(
        (entry) => entry.blockId === wait.id,
      )) {
        expect(entry.output).toBe("SUCCESS");
        expect(entry.data).toMatchObject({
          delaySeconds: 0.02,
          waitedSeconds: expect.any(Number),
        });
        expect(
          (entry.data as { waitedSeconds: number }).waitedSeconds,
        ).toBeGreaterThan(0);
      }
      expect(controller.signal.aborted).toBe(true);
      expect(executeTask).not.toHaveBeenCalled();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("finishes an empty scan when continuous mode is disabled", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-single-idle-"));
    try {
      initializeRepository(workspace);
      const result = await runRalphFlow(
        getRalphStarterFlow("autonomous-code-improvement-loop")!.flow,
        { ...runtimeConfig, workspaceRoot: workspace },
        { ...customizations, workspaceRoot: workspace },
        { variableValues: { continuous: "false", excludePaths: "." } },
      );
      expect(result.status, result.summary).toBe("completed");
      expect(result.outcome?.status).toBe("no-op");
      expect(
        result.blockResults.some(
          (entry) => entry.blockId === "wait-for-scope-cycle",
        ),
      ).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("stops during the cycle delay without starting another scan", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-stop-idle-"));
    const controller = new AbortController();
    let cancellation: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await runRalphFlow(
        getRalphStarterFlow("autonomous-code-improvement-loop")!.flow,
        { ...runtimeConfig, workspaceRoot: workspace },
        { ...customizations, workspaceRoot: workspace },
        {
          signal: controller.signal,
          variableValues: { excludePaths: "." },
          onEvent: (event) => {
            if (
              event.type === "block-start" &&
              event.blockId === "wait-for-scope-cycle"
            ) {
              cancellation = setTimeout(() => controller.abort(), 20);
            }
          },
        },
      );
      expect(result.status, result.summary).toBe("stopped");
      expect(result.outcome?.status).toBe("cancelled");
      expect(
        result.blockResults.filter((entry) => entry.blockId === "scan-scopes"),
      ).toHaveLength(1);
      expect(
        result.blockResults.find(
          (entry) => entry.blockId === "wait-for-scope-cycle",
        )?.output,
      ).not.toBe("SUCCESS");
      expect(executeTask).not.toHaveBeenCalled();
    } finally {
      clearTimeout(cancellation);
      controller.abort();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each(["true", "false"])(
    "handles discovery with no candidates in continuous mode %s",
    async (continuous) => {
      const workspace = await mkdtemp(join(tmpdir(), "ralph-no-candidates-"));
      const controller = new AbortController();
      const flow = structuredClone(
        getRalphStarterFlow("autonomous-code-improvement-loop")!.flow,
      );
      const wait = flow.blocks.find(
        (block) => block.id === "wait-for-scope-cycle",
      );
      if (wait?.type !== "UTILITY") throw new Error("Missing cycle delay.");
      wait.utility.delaySeconds = 0.02;
      const discovery = JSON.stringify({
        constitution: { purpose: "Review the repository.", constraints: [] },
        candidates: [],
        researchDecision: { needsResearch: false, queries: [] },
      });
      vi.mocked(executeTask).mockResolvedValue(
        createExecutionResult({
          response: {
            markdown: discovery,
            highlights: [],
            relatedFiles: [],
            verification: [],
            followUps: [],
          },
        }),
      );
      try {
        initializeRepository(workspace);
        const result = await runRalphFlow(
          flow,
          { ...runtimeConfig, workspaceRoot: workspace },
          { ...customizations, workspaceRoot: workspace },
          {
            signal: controller.signal,
            variableValues: { continuous },
            onEvent: (event) => {
              if (event.type === "block-output" && event.blockId === wait.id)
                controller.abort();
            },
          },
        );
        expect(executeTask).toHaveBeenCalledTimes(1);
        expect(
          result.blockResults.find(
            (entry) => entry.blockId === "propose-improvements",
          ),
        ).toMatchObject({ output: "SUCCESS" });
        expect(
          result.blockResults.find(
            (entry) => entry.blockId === "record-stop-outcome",
          ),
        ).toMatchObject({ output: "SUCCESS" });
        expect(
          result.blockResults.some(
            (entry) =>
              entry.blockId === "choose-improvement" ||
              entry.blockId === "implement-improvement",
          ),
        ).toBe(false);
        expect(result.autonomy?.exhaustion, result.summary).toBeUndefined();
        if (continuous === "true") {
          expect(
            result.blockResults.find((entry) => entry.blockId === wait.id),
            result.summary,
          ).toMatchObject({ output: "SUCCESS" });
          expect(controller.signal.aborted).toBe(true);
        } else {
          expect(result.status, result.summary).toBe("completed");
          expect(result.outcome?.status).toBe("no-op");
        }
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
