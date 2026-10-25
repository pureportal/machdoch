import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consolidateTaskReasoning } from "./reasoning-bank-consolidation.js";
import {
  createLocalReasoningBank,
  retrieveReasoningLessons,
} from "./reasoning-bank.js";
import type { RuntimeConfig } from "./runtime-contract.generated.js";
import type { AgentModelAdapter } from "@machdoch/model-runtime/types";
import type { TaskExecutionResult } from "./types.js";

const roots: string[] = [];

const setup = async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "machdoch-reasoning-review-"),
  );
  roots.push(workspaceRoot);
  const config: RuntimeConfig = {
    workspaceRoot,
    mode: "machdoch",
    provider: "unconfigured",
    model: "test",
    reasoning: "default",
    contextWindow: "default",
    offline: false,
    compatibility: { discoverGithubCustomizations: false },
    providerAvailability: [{ provider: "openai", configured: false }],
    webSearch: { activeProvider: "none", providerAvailability: [] },
    reviewModel: { mode: "base" },
    internalTaskModel: {
      provider: "openai",
      model: "test",
      reasoning: "default",
    },
  };
  const result: TaskExecutionResult = {
    task: "Fix a generated contract mismatch",
    mode: "machdoch",
    status: "failed",
    summary: "The runtime contract remained stale after a schema edit.",
    executedTools: ["filesystem", "shell"],
    outputSections: [
      {
        title: "Verification",
        lines: ["Type check failed on stale bindings."],
      },
    ],
  };
  return { workspaceRoot, config, result };
};

const adapter = (value: unknown): AgentModelAdapter => ({
  startTurn: vi.fn(async () => ({
    text: JSON.stringify(value),
    toolCalls: [],
  })),
  continueTurn: async () => {
    throw new Error("Unexpected continuation");
  },
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ReasoningBank post-task review", () => {
  it("learns a preventive strategy from failure and credits retrieved lessons", async () => {
    const { workspaceRoot, config, result } = await setup();
    const bank = createLocalReasoningBank(workspaceRoot);
    const [retrieved] = await bank.consolidate([
      {
        title: "Check generated bindings",
        description: "Check bindings when runtime schemas change.",
        content:
          "Regenerate contracts after schema edits to avoid stale types.",
        triggerTerms: ["schema"],
        outcome: "success",
        confidence: 0.8,
      },
    ]);

    const reviewed = await consolidateTaskReasoning(
      result.task,
      config,
      {
        ...result,
        metadata: { reasoningBankRetrievedIds: [retrieved!.id] },
      },
      undefined,
      {
        modelAdapter: adapter({
          outcome: "failure",
          helpfulLessonIds: [],
          harmfulLessonIds: [retrieved!.id],
          lessons: [
            {
              title: "Regenerate contracts before verification",
              description:
                "When generated bindings follow a schema, refresh them first.",
              content:
                "After changing a runtime schema, regenerate all language bindings before running type checks because stale contracts can conceal the actual integration state.",
              triggerTerms: ["runtime schema", "bindings"],
              applicability: {
                taskTerms: [" Runtime   Schema "],
                excludedTaskTerms: [" Prototype "],
                maxAgeDays: 7,
              },
              confidence: 0.85,
            },
          ],
        }),
      },
    );

    expect(reviewed.metadata?.reasoningBankCapture).toEqual({
      outcome: "failure",
      storedCount: 1,
    });
    const lessons = await bank.load();
    expect(lessons).toHaveLength(2);
    expect(
      lessons.find((entry) => entry.id === retrieved!.id)?.harmfulCount,
    ).toBe(1);
    expect(lessons.find((entry) => entry.id !== retrieved!.id)).toMatchObject({
      outcome: "failure",
      applicability: {
        taskTerms: ["runtime schema"],
        excludedTaskTerms: ["prototype"],
        maxAgeDays: 7,
        verifiedAt: expect.any(Number),
      },
    });
  });

  it("does not rejuvenate a repeated lesson or discard its expiration", async () => {
    const { workspaceRoot, config, result } = await setup();
    const bank = createLocalReasoningBank(workspaceRoot);
    const now = Date.now();
    const verifiedAt = now - 10 * 86_400_000;
    const guidance = {
      title: "Check generated bindings",
      description: "Check bindings when runtime schemas change.",
      content: "Regenerate contracts after schema edits to avoid stale types.",
      triggerTerms: ["schema"],
      confidence: 0.8,
    };
    const [stored] = await bank.consolidate([
      {
        ...guidance,
        outcome: "failure",
        applicability: {
          taskTerms: ["schema"],
          maxAgeDays: 7,
          verifiedAt,
          expiresAt: now + 86_400_000,
        },
      },
    ]);
    const reviewed = await consolidateTaskReasoning(
      result.task,
      config,
      { ...result, metadata: { reasoningBankRetrievedIds: [stored!.id] } },
      undefined,
      {
        modelAdapter: adapter({
          outcome: "failure",
          helpfulLessonIds: [stored!.id],
          harmfulLessonIds: [],
          lessons: [
            {
              ...guidance,
              applicability: {
                taskTerms: ["schema"],
                excludedTaskTerms: [],
                maxAgeDays: null,
              },
            },
          ],
        }),
      },
    );

    expect(reviewed.metadata?.reasoningBankCapture).toEqual({
      outcome: "failure",
      storedCount: 1,
    });
    const reloaded = await bank.load();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({
      id: stored!.id,
      helpfulCount: 1,
      applicability: {
        taskTerms: ["schema"],
        maxAgeDays: 7,
        verifiedAt,
        expiresAt: now + 86_400_000,
      },
    });
    expect(
      retrieveReasoningLessons("Check runtime schema and generated bindings", reloaded),
    ).toEqual([]);
  });

  it("does not impose an age limit on a durable strategy", async () => {
    const { workspaceRoot, config, result } = await setup();
    const reviewed = await consolidateTaskReasoning(
      result.task,
      config,
      result,
      undefined,
      {
        modelAdapter: adapter({
          outcome: "failure",
          helpfulLessonIds: [],
          harmfulLessonIds: [],
          lessons: [
            {
              title: "Check generated bindings",
              description: "Check bindings when runtime schemas change.",
              content: "Regenerate contracts after schema edits to avoid stale types.",
              triggerTerms: ["schema"],
              applicability: {
                taskTerms: [],
                excludedTaskTerms: [],
                maxAgeDays: null,
              },
              confidence: 0.8,
            },
          ],
        }),
      },
    );
    expect(reviewed.metadata?.reasoningBankCapture).toMatchObject({ storedCount: 1 });
    const [stored] = await createLocalReasoningBank(workspaceRoot).load();
    expect(stored?.applicability).toEqual({ verifiedAt: expect.any(Number) });
  });

  it.each([
    { taskTerms: [" "], excludedTaskTerms: [], maxAgeDays: null },
    { taskTerms: [], excludedTaskTerms: [], maxAgeDays: -1 },
    { taskTerms: [], excludedTaskTerms: [], maxAgeDays: null, verifiedAt: 0 },
  ])("rejects invalid model applicability %j", async (applicability) => {
    const { workspaceRoot, config, result } = await setup();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reviewed = await consolidateTaskReasoning(
      result.task,
      config,
      result,
      undefined,
      {
        modelAdapter: adapter({
          outcome: "failure",
          helpfulLessonIds: [],
          harmfulLessonIds: [],
          lessons: [
            {
              title: "Check generated bindings",
              description: "Check bindings when runtime schemas change.",
              content: "Regenerate contracts after schema edits to avoid stale types.",
              triggerTerms: ["schema"],
              applicability,
              confidence: 0.8,
            },
          ],
        }),
      },
    );
    expect(reviewed).toBe(result);
    expect(await createLocalReasoningBank(workspaceRoot).load()).toEqual([]);
  });

  it("is enabled by default and can be disabled in workspace config", async () => {
    const { workspaceRoot, config, result } = await setup();
    const modelAdapter = adapter({
      outcome: "uncertain",
      helpfulLessonIds: [],
      harmfulLessonIds: [],
      lessons: [],
    });
    await consolidateTaskReasoning(result.task, config, result, undefined, {
      modelAdapter,
    });
    expect(modelAdapter.startTurn).toHaveBeenCalledOnce();

    await mkdir(join(workspaceRoot, ".machdoch"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".machdoch", "config.json"),
      JSON.stringify({ reasoningBankEnabled: false }),
    );
    await consolidateTaskReasoning(result.task, config, result, undefined, {
      modelAdapter,
    });
    expect(modelAdapter.startTurn).toHaveBeenCalledOnce();
  });

  it("does not capture lessons when the conversation has no selected workspace", async () => {
    const { config, result } = await setup();
    const modelAdapter = adapter({
      outcome: "failure",
      helpfulLessonIds: [],
      harmfulLessonIds: [],
      lessons: [],
    });

    await consolidateTaskReasoning(
      result.task,
      config,
      result,
      { history: [] },
      { modelAdapter },
    );
    expect(modelAdapter.startTurn).not.toHaveBeenCalled();
  });

  it("ignores contradictory feedback for the same retrieved lesson", async () => {
    const { workspaceRoot, config, result } = await setup();
    const bank = createLocalReasoningBank(workspaceRoot);
    const [retrieved] = await bank.consolidate([
      {
        title: "Check generated bindings",
        description: "Check bindings when runtime schemas change.",
        content:
          "Regenerate contracts after schema edits to avoid stale types.",
        triggerTerms: ["schema"],
        outcome: "success",
        confidence: 0.8,
      },
    ]);

    await consolidateTaskReasoning(
      result.task,
      config,
      {
        ...result,
        metadata: { reasoningBankRetrievedIds: [retrieved!.id] },
      },
      undefined,
      {
        modelAdapter: adapter({
          outcome: "failure",
          helpfulLessonIds: [retrieved!.id],
          harmfulLessonIds: [retrieved!.id],
          lessons: [],
        }),
      },
    );

    expect((await bank.load())[0]).toMatchObject({
      helpfulCount: 0,
      harmfulCount: 0,
    });
  });

  it("rejects secret-bearing and low-confidence lessons", async () => {
    const { workspaceRoot, config, result } = await setup();
    await consolidateTaskReasoning(result.task, config, result, undefined, {
      modelAdapter: adapter({
        outcome: "failure",
        helpfulLessonIds: [],
        harmfulLessonIds: [],
        lessons: [
          {
            title: "Avoid exposing credentials",
            description: "When diagnosing a request, avoid logging tokens.",
            content:
              "Never use access_token=supersecretvalue when diagnosing a failed request.",
            triggerTerms: ["credential"],
            applicability: {
              taskTerms: [],
              excludedTaskTerms: [],
              maxAgeDays: null,
            },
            confidence: 0.9,
          },
          {
            title: "Speculative workaround",
            description: "This may help with some unrelated build failures.",
            content: "Try changing the compiler setting without evidence.",
            triggerTerms: ["compiler"],
            applicability: {
              taskTerms: [],
              excludedTaskTerms: [],
              maxAgeDays: null,
            },
            confidence: 0.2,
          },
          {
            title: "       ",
            description: "                    ",
            content: "                                ",
            triggerTerms: ["schema"],
            applicability: {
              taskTerms: [],
              excludedTaskTerms: [],
              maxAgeDays: null,
            },
            confidence: 0.9,
          },
        ],
      }),
    });
    expect(await createLocalReasoningBank(workspaceRoot).load()).toEqual([]);
  });
});
