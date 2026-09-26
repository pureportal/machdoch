import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consolidateTaskReasoning } from "./reasoning-bank-consolidation.js";
import { createLocalReasoningBank } from "./reasoning-bank.js";
import type { RuntimeConfig } from "./runtime-contract.generated.js";
import type { AgentModelAdapter, TaskExecutionResult } from "./types.js";

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
    expect(lessons.find((entry) => entry.id !== retrieved!.id)?.outcome).toBe(
      "failure",
    );
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
            confidence: 0.9,
          },
          {
            title: "Speculative workaround",
            description: "This may help with some unrelated build failures.",
            content: "Try changing the compiler setting without evidence.",
            triggerTerms: ["compiler"],
            confidence: 0.2,
          },
          {
            title: "       ",
            description: "                    ",
            content: "                                ",
            triggerTerms: ["schema"],
            confidence: 0.9,
          },
        ],
      }),
    });
    expect(await createLocalReasoningBank(workspaceRoot).load()).toEqual([]);
  });
});
