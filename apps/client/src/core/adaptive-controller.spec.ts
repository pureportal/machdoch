import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planAdaptiveExecution,
  resolveAdaptiveControllerEnabled,
  resolveAdaptiveExecutionPlan,
} from "./adaptive-controller.js";
import { saveWorkspaceAdaptiveControllerOverride } from "./config.js";
import { saveUserDesktopSettingsPatch } from "./env.js";
import type { RuntimeConfig } from "./runtime-contract.generated.js";

const config: RuntimeConfig = {
  workspaceRoot: "C:/workspace",
  mode: "machdoch",
  provider: "openai",
  model: "gpt-5.6-sol",
  reasoning: "default",
  contextWindow: "default",
  offline: false,
  agentLimits: { executorTurns: 80, autopilotExecutorIterations: 6 },
  compatibility: {},
  providerAvailability: [{ provider: "openai", configured: true }],
  webSearch: { activeProvider: "none", providerAvailability: [] },
  reviewModel: { mode: "base" },
  internalTaskModel: {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoning: "default",
  },
};

describe("adaptive context and compute", () => {
  it("resolves session, workspace, then global settings", () => {
    expect(resolveAdaptiveControllerEnabled(true)).toBe(true);
    expect(resolveAdaptiveControllerEnabled(false, true)).toBe(true);
    expect(resolveAdaptiveControllerEnabled(true, false)).toBe(false);
    expect(resolveAdaptiveControllerEnabled(false, true, false)).toBe(false);
    expect(resolveAdaptiveControllerEnabled(true, false, true)).toBe(true);
    expect(resolveAdaptiveControllerEnabled(false, null, null)).toBe(false);
  });

  it("allocates more context and compute for repository work", () => {
    const simple = planAdaptiveExecution("What is this function?", config);
    const deep = planAdaptiveExecution(
      "Implement a full featured architecture across the repository. Investigate the existing codebase, integrate the changes, fix all affected paths, and verify the behavior with tests and performance checks.",
      config,
    );
    expect(simple.level).toBe("simple");
    expect(deep.level).toBe("deep");
    expect(deep.historyCharacters).toBeGreaterThan(simple.historyCharacters);
    expect(deep.memoryEntries).toBeGreaterThan(simple.memoryEntries);
    expect(deep.executorTurns).toBe(80);
    expect(simple.executorTurns).toBe(16);
    expect(deep.autopilotIterations).toBe(6);
    expect(simple.maxWorkers).toBe(2);
    expect(deep.maxWorkers).toBe(3);
  });

  it("respects selected reasoning and provider capabilities", () => {
    expect(
      planAdaptiveExecution("Fix this bug", { ...config, reasoning: "xhigh" })
        .reasoning,
    ).toBe("xhigh");
    expect(
      planAdaptiveExecution("Fix this bug", {
        ...config,
        provider: "copilot-cli",
        model: "auto",
      }).reasoning,
    ).toBe("default");
  });

  it("keeps context allocations within a small model window", () => {
    const task =
      "Implement and verify a full repository architecture change across multiple packages.";
    const normal = planAdaptiveExecution(task, config);
    const constrained = planAdaptiveExecution(task, {
      ...config,
      contextWindow: 4_000,
    });
    expect(constrained.historyCharacters).toBeLessThan(
      normal.historyCharacters,
    );
    expect(
      constrained.historyCharacters +
        constrained.memoryCharacters +
        constrained.experienceCharacters +
        constrained.workspaceRunCharacters,
    ).toBeLessThanOrEqual(4_000 * 4 * 0.18);
  });

  it("applies saved global, workspace, and chat settings to a request", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-adaptive-controller-"));
    const previousConfigDirectory = process.env.MACHDOCH_USER_CONFIG_DIR;
    process.env.MACHDOCH_USER_CONFIG_DIR = join(root, "user-config");
    const runtime = { ...config, workspaceRoot: root };
    const context = {
      history: [],
      workspace: { selection: "selected" as const, root },
    };
    try {
      await saveUserDesktopSettingsPatch({ adaptiveControllerEnabled: false });
      expect(
        await resolveAdaptiveExecutionPlan("Fix this bug", runtime, context),
      ).toBeUndefined();

      await saveWorkspaceAdaptiveControllerOverride(root, true);
      expect(
        await resolveAdaptiveExecutionPlan("Fix this bug", runtime, context),
      ).toBeDefined();
      expect(
        await resolveAdaptiveExecutionPlan("Fix this bug", runtime, {
          ...context,
          adaptiveControllerOverride: false,
        }),
      ).toBeUndefined();

      await saveWorkspaceAdaptiveControllerOverride(root, false);
      expect(
        await resolveAdaptiveExecutionPlan("Fix this bug", runtime, {
          ...context,
          adaptiveControllerOverride: true,
        }),
      ).toBeDefined();
      expect(
        await resolveAdaptiveExecutionPlan("Fix this bug", runtime, {
          history: [],
          workspace: { selection: "not-set" },
        }),
      ).toBeUndefined();
    } finally {
      if (previousConfigDirectory === undefined) {
        delete process.env.MACHDOCH_USER_CONFIG_DIR;
      } else {
        process.env.MACHDOCH_USER_CONFIG_DIR = previousConfigDirectory;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
