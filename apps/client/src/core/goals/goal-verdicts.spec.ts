import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRuntimeConfig } from "../config.js";
import { isAgentToolGranted } from "../_helpers/agent-tool-policy.js";
import type { AgentToolDefinition } from "../_helpers/agent-tools-shared.js";
import { startTaskFileChangeCapture } from "../_helpers/task-file-change-capture.js";
import { resolveGoalLimits } from "../_helpers/agent-runtime-types.js";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import type {
  AgentLiveState,
  TaskExecutionOptions,
  TaskExecutionResult,
} from "../types.js";
import { parseGoalCommand } from "./goal-command.js";
import { executeWithSessionGoal } from "./goal-execution.js";
import { parseGoalChecklist } from "./goal-checklist.js";
import {
  getGoalPath,
  pauseInterruptedGoals,
  readGoalRecord,
  updateGoalRecord,
} from "./goal-store.js";
import type { GoalTurnExecutor } from "./run-goal.js";

vi.mock("../_helpers/task-file-change-capture.js", () => ({
  startTaskFileChangeCapture: vi.fn(async () => undefined),
}));

let directory: string;
let config: RuntimeConfig;
let options: TaskExecutionOptions;

const work = (overrides: Partial<TaskExecutionResult> = {}): TaskExecutionResult => ({
  task: "goal work",
  mode: "machdoch",
  status: "executed",
  summary: "Worked.",
  executedTools: ["shell"],
  outputSections: [],
  ...overrides,
});

const check = (
  decision: "complete" | "continue" | "blocked",
  requirements: { text: string; status: string; evidence?: string }[] = [],
): TaskExecutionResult =>
  work({
    control: { kind: "goal-evaluation", decision },
    response: {
      markdown: `${requirements.length ? `<goal_checklist>${JSON.stringify(requirements)}</goal_checklist>\n` : ""}Finish the rest.`,
      highlights: [],
      relatedFiles: [],
      verification: [],
      followUps: [],
    },
  });

const live = (
  overrides: Partial<AgentLiveState>,
): AgentLiveState => ({
  provider: "claude-cli",
  transport: "stream-json",
  capabilities: [],
  ...overrides,
});

const run = (task: string, execute: GoalTurnExecutor) =>
  executeWithSessionGoal(task, config, options, execute);

const goalPath = () =>
  getGoalPath(directory, options.conversationContext!.sessionId!);

const native = (): void => {
  config.provider = "claude-cli";
  options.conversationContext!.goalMode = "native";
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "machdoch-goal-verdict-test-"));
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", directory);
  config = { ...(await loadRuntimeConfig(directory)), provider: "openai" };
  options = { conversationContext: { sessionId: randomUUID(), history: [] } };
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("goal checklist", () => {
  it("splits the checklist from the summary", () => {
    expect(
      parseGoalChecklist(
        'Before.\n<goal_checklist>[{"text":"Login works","status":"verified","evidence":"ran e2e"},{"text":"Bad","status":"unknown"}]</goal_checklist>\nAfter.',
      ),
    ).toEqual({
      requirements: [
        { text: "Login works", status: "verified", evidence: "ran e2e" },
      ],
      summary: "Before.\n\nAfter.",
    });
  });

  it("keeps the summary when the checklist is not valid JSON", () => {
    expect(
      parseGoalChecklist("<goal_checklist>oops</goal_checklist>Next."),
    ).toEqual({ requirements: [], summary: "Next." });
  });

  it("saves each verdict and shows progress on the goal", async () => {
    native();
    const checks = [
      check("continue", [
        { text: "A", status: "verified", evidence: "seen" },
        { text: "B", status: "missing", evidence: "no test" },
      ]),
      check("complete", [
        { text: "A", status: "verified" },
        { text: "B", status: "verified" },
      ]),
    ];
    const prompts: string[] = [];
    const nativeGoals: Array<string | undefined> = [];
    await run(
      "/goal Ship it",
      vi.fn<GoalTurnExecutor>(async (task, _config, turnOptions) => {
        if (turnOptions.resultProtocol) {
          prompts.push(task);
          return checks.shift()!;
        }
        nativeGoals.push(turnOptions.nativeGoal);
        return work();
      }),
    );
    const record = await readGoalRecord(goalPath());
    expect(record.goal).toMatchObject({
      status: "complete",
      verifiedRequirements: 2,
      totalRequirements: 2,
    });
    expect(record.verdicts?.map((verdict) => verdict.decision)).toEqual([
      "continue",
      "complete",
    ]);
    expect(nativeGoals[1]).toContain("- missing: B (no test)");
    expect(prompts[1]).toContain("previousChecklist");
    expect(record.goal?.reason).not.toContain("goal_checklist");
  });

  it("does not accept complete while the checklist has open items", async () => {
    native();
    config.agentLimits = {
      executorTurns: 64,
      autopilotExecutorIterations: 16,
      goalPasses: 1,
    };
    await run(
      "/goal Ship it",
      vi.fn<GoalTurnExecutor>(async (_task, _config, turnOptions) =>
        turnOptions.resultProtocol
          ? check("complete", [
              { text: "A", status: "verified" },
              { text: "B", status: "failed", evidence: "tests fail" },
            ])
          : work(),
      ),
    );
    expect((await readGoalRecord(goalPath())).goal).toMatchObject({
      status: "paused",
      verifiedRequirements: 1,
      totalRequirements: 2,
    });
  });

  it("keeps rerunning while the checklist improves", async () => {
    native();
    let verified = 0;
    const execute = vi.fn<GoalTurnExecutor>(
      async (_task, _config, turnOptions) => {
        if (!turnOptions.resultProtocol) return work();
        verified += 1;
        const requirements = Array.from({ length: 6 }, (_, index) => ({
          text: `R${index}`,
          status: index < verified ? "verified" : "missing",
        }));
        return check(verified === 6 ? "complete" : "continue", requirements);
      },
    );
    await run("/goal Ship it", execute);
    expect((await readGoalRecord(goalPath())).goal).toMatchObject({
      status: "complete",
      turns: 6,
    });
  });
});

describe("goal verification", () => {
  it("lets the check inspect and run things but not edit", async () => {
    let granted: Record<string, boolean> = {};
    const tool = (name: string, effect: string) =>
      ({ spec: { name }, effect }) as unknown as AgentToolDefinition;
    await run(
      "/goal Ship it",
      vi.fn<GoalTurnExecutor>(async (_task, _config, turnOptions) => {
        if (turnOptions.resultProtocol) {
          granted = Object.fromEntries(
            [
              tool("read_file", "read"),
              tool("run_shell_command", "external-side-effect"),
              tool("navigate_browser_page", "external-side-effect"),
              tool("create_file", "workspace-write"),
              tool("create_git_commit", "external-side-effect"),
            ].map((definition) => [
              definition.spec.name,
              isAgentToolGranted(definition),
            ]),
          );
          return check("complete");
        }
        return work();
      }),
    );
    expect(granted).toEqual({
      read_file: true,
      run_shell_command: true,
      navigate_browser_page: true,
      create_file: false,
      create_git_commit: false,
    });
  });

  it("uses the configured check time", async () => {
    config.agentLimits = {
      executorTurns: 64,
      autopilotExecutorIterations: 16,
      goalVerificationMinutes: 45,
    };
    const durations: Array<number | null | undefined> = [];
    const prompts: string[] = [];
    await run(
      "/goal Ship it",
      vi.fn<GoalTurnExecutor>(async (task, _config, turnOptions) => {
        if (turnOptions.resultProtocol) {
          durations.push(turnOptions.maxDurationMs);
          prompts.push(task);
          return check("complete");
        }
        return work();
      }),
    );
    expect(durations).toEqual([45 * 60_000]);
    expect(prompts[0]).toContain("within 45 minutes");
  });

  it("does not accept complete when files changed during the check", async () => {
    vi.mocked(startTaskFileChangeCapture).mockResolvedValueOnce({
      finish: async () => ({ files: [{ path: "src/changed.ts" }] }),
      dispose: async () => undefined,
    } as unknown as Awaited<ReturnType<typeof startTaskFileChangeCapture>>);
    const checks = vi.fn<GoalTurnExecutor>(
      async (_task, _config, turnOptions) =>
        turnOptions.resultProtocol ? check("complete") : work(),
    );
    await run("/goal Ship it", checks);
    const record = await readGoalRecord(goalPath());
    expect(record.verdicts?.[0]).toMatchObject({ decision: "continue" });
    expect(record.verdicts?.[0]?.summary).toContain("src/changed.ts");
    expect(record.goal?.status).toBe("complete");
  });
});

describe("goal limits", () => {
  it("defaults to more passes than a stall needs", () => {
    expect(resolveGoalLimits({})).toEqual({
      passes: 10,
      stalledPasses: 3,
      verificationMs: 30 * 60_000,
      backgroundWaitMs: 120 * 60_000,
      usageWaitMs: 360 * 60_000,
    });
  });

  it("parses a cost limit", () => {
    expect(parseGoalCommand("/goal --cost 2.5 --turns 3 Ship it")).toEqual({
      kind: "set",
      objective: "Ship it",
      costBudgetUsd: 2.5,
      turnBudget: 3,
    });
    expect(() => parseGoalCommand("/goal --cost 0 Ship it")).toThrow(
      "positive",
    );
  });

  it("gives background jobs the goal's remaining time", async () => {
    const waits: Array<number | undefined> = [];
    await run(
      "/goal --minutes 300 Ship it",
      vi.fn<GoalTurnExecutor>(async (_task, _config, turnOptions) => {
        if (turnOptions.resultProtocol) return check("complete");
        waits.push(turnOptions.goalBackgroundWaitMs);
        return work();
      }),
    );
    expect(waits[0]).toBeGreaterThan(299 * 60_000);
    expect(waits[0]).toBeLessThanOrEqual(300 * 60_000);
  });

  it("uses the configured background wait without a time limit", async () => {
    const waits: Array<number | undefined> = [];
    await run(
      "/goal Ship it",
      vi.fn<GoalTurnExecutor>(async (_task, _config, turnOptions) => {
        if (turnOptions.resultProtocol) return check("complete");
        waits.push(turnOptions.goalBackgroundWaitMs);
        return work();
      }),
    );
    expect(waits).toEqual([120 * 60_000]);
  });

  it("saves usage and cost while the turn is still running", async () => {
    native();
    let finishTurn!: () => void;
    const pending = run(
      "/goal Ship it",
      vi.fn<GoalTurnExecutor>(async (task, turnConfig, turnOptions) => {
        if (turnOptions.resultProtocol) return check("complete");
        await turnOptions.onStateChange?.({
          task,
          mode: turnConfig.mode,
          state: "executing",
          message: "Working.",
          cancellable: true,
          executedTools: [],
          outputSections: [],
          agentLive: live({
            usage: {
              inputTokens: 1_000,
              cachedInputTokens: 900,
              outputTokens: 50,
              costUsd: 1.5,
            },
          }),
        });
        await new Promise<void>((resolve) => (finishTurn = resolve));
        return work();
      }),
    );
    await vi.waitFor(
      async () =>
        expect((await readGoalRecord(goalPath())).goal).toMatchObject({
          tokensUsed: 150,
          costUsd: 1.5,
        }),
      { timeout: 10_000, interval: 100 },
    );
    finishTurn();
    await pending;
  }, 20_000);

  it("stops at the cost limit", async () => {
    native();
    await run(
      "/goal --cost 1 Ship it",
      vi.fn<GoalTurnExecutor>(async (task, turnConfig, turnOptions) => {
        await turnOptions.onStateChange?.({
          task,
          mode: turnConfig.mode,
          state: "executing",
          message: "Working.",
          cancellable: true,
          executedTools: [],
          outputSections: [],
          agentLive: live({ usage: { costUsd: 1.5 } }),
        });
        return work();
      }),
    );
    expect((await readGoalRecord(goalPath())).goal).toMatchObject({
      status: "budget-limited",
      reason: "Cost limit reached.",
    });
  });
});

describe("plan usage limits", () => {
  const limitedTurn = (
    resetsAt: number,
    turnOptions: TaskExecutionOptions,
  ): Promise<void> | void =>
    turnOptions.onStateChange?.({
      task: "work",
      mode: "machdoch",
      state: "executing",
      message: "Working.",
      cancellable: true,
      executedTools: [],
      outputSections: [],
      agentLive: live({
        limits: [
          {
            id: "five_hour",
            label: "5-hour",
            usedPercent: 100,
            resetsAt,
            limited: true,
          },
        ],
      }),
    });

  it("waits for the reset and continues", async () => {
    let skippedMs = 0;
    const realNow = Date.now.bind(Date);
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skippedMs);
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
      delay?: number,
    ) => {
      if (delay && delay > 10_000 && delay <= 60_000) {
        skippedMs += delay;
        return realSetTimeout(callback, 1);
      }
      return realSetTimeout(callback, delay);
    }) as typeof setTimeout);
    let turns = 0;
    await run(
      "/goal Ship it",
      vi.fn<GoalTurnExecutor>(async (_task, _config, turnOptions) => {
        if (turnOptions.resultProtocol) return check("complete");
        turns += 1;
        if (turns === 1) {
          await limitedTurn(Date.now() + 60_000, turnOptions);
          return work({ status: "failed", summary: "Limit reached." });
        }
        return work();
      }),
    );
    expect(turns).toBe(2);
    expect(skippedMs).toBeGreaterThanOrEqual(60_000);
    expect((await readGoalRecord(goalPath())).goal?.status).toBe("complete");
  }, 30_000);

  it("pauses when the reset is further away than the configured wait", async () => {
    config.agentLimits = {
      executorTurns: 64,
      autopilotExecutorIterations: 16,
      goalUsageWaitMinutes: 0,
    };
    await run(
      "/goal Ship it",
      vi.fn<GoalTurnExecutor>(async (_task, _config, turnOptions) => {
        await limitedTurn(Date.now() + 60_000, turnOptions);
        return work({ status: "failed", summary: "Limit reached." });
      }),
    );
    const goal = (await readGoalRecord(goalPath())).goal;
    expect(goal?.status).toBe("paused");
    expect(goal?.reason).toContain("Plan usage limit reached");
  });

  it("does not wait for a failure without a plan limit", async () => {
    await run(
      "/goal Ship it",
      vi.fn<GoalTurnExecutor>(async () =>
        work({ status: "failed", summary: "Build broke." }),
      ),
    );
    expect((await readGoalRecord(goalPath())).goal).toMatchObject({
      status: "blocked",
      reason: "Build broke.",
    });
  });
});

describe("interrupted goals", () => {
  it("pauses an active goal no run holds and leaves others alone", async () => {
    const path = goalPath();
    const goal = {
      id: "goal",
      objective: "Ship it",
      mode: "machdoch" as const,
      turns: 1,
      tokensUsed: 0,
      elapsedMs: 0,
      reason: "",
      createdAt: 1,
      updatedAt: 1,
    };
    await updateGoalRecord(path, (record) => ({
      ...record,
      goal: { ...goal, status: "active" },
    }));
    const completePath = getGoalPath(directory, "finished");
    await updateGoalRecord(completePath, (record) => ({
      ...record,
      goal: { ...goal, status: "complete" },
    }));
    await pauseInterruptedGoals();
    expect((await readGoalRecord(path)).goal).toMatchObject({
      status: "paused",
      reason: "Execution interrupted. Resume to continue.",
    });
    expect((await readGoalRecord(completePath)).goal?.status).toBe("complete");
  });
});
