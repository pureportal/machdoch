import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createInstructionResolutionFixture } from "../__test__/instruction-test-helpers.js";
import { createInstructionDeliveryPlan } from "../instruction-system/index.js";
import type { TaskExecutionTimelineEvent } from "../types.js";
import { maybeExecuteExternalAgentProviderTask } from "./external-agent-provider.js";
import {
  createParallelAgentSessionTool,
  type ParallelAgentSessionOptions,
} from "./parallel-agent-sessions.js";
import {
  TASK_EXECUTION_IDLE_TIMEOUT_MS,
  createManagedTaskExecutionTimeout,
  resolveTaskExecutionTimeouts,
} from "./task-execution-timeouts.js";

vi.mock("./external-agent-provider.js", () => ({
  maybeExecuteExternalAgentProviderTask: vi.fn(),
}));

type ExternalAgentParams = Parameters<
  typeof maybeExecuteExternalAgentProviderTask
>[0];

const workspaces: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.mocked(maybeExecuteExternalAgentProviderTask).mockReset();
  await Promise.all(
    workspaces
      .splice(0)
      .map((workspace) => rm(workspace, { recursive: true, force: true })),
  );
});

const createOptions = async (
  provider: "codex-cli" | "claude-cli" | "copilot-cli" = "codex-cli",
): Promise<ParallelAgentSessionOptions> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-cli-timeouts-"));
  workspaces.push(workspaceRoot);
  await writeFile(join(workspaceRoot, "notes.txt"), "Investigation notes");
  const model = "test-model";
  const instructionResolution = createInstructionResolutionFixture({
    providerId: provider,
    surface: "cli",
    model,
  });
  return {
    config: {
      workspaceRoot,
      mode: "machdoch",
      provider,
      model,
      reasoning: "default",
      contextWindow: "default",
      offline: false,
      compatibility: { discoverGithubCustomizations: false },
      providerAvailability: [{ provider, configured: true }],
      webSearch: { activeProvider: "none", providerAvailability: [] },
      reviewModel: { mode: "base" },
      internalTaskModel: { provider, model, reasoning: "default" },
    },
    task: "Investigate the workspace",
    taskContext: {
      task: "Investigate the workspace",
      effectiveTask: "Investigate the workspace",
      taskContextText: "",
      workspacePaths: [],
      suggestedTools: [],
      executionRole: "executor",
      applicableInstructions: [],
      instructionResolution,
    },
    instructionDeliveryPlan: createInstructionDeliveryPlan(
      instructionResolution,
    ),
    preparedConversationContext: {
      wasQueued: false,
      workspace: { selection: "selected", root: workspaceRoot },
      sections: [],
      memory: {
        sessionEnabled: false,
        sessionEntries: [],
        globalEnabled: false,
        globalEntries: [],
      },
      uiControlEnabled: false,
    },
    mode: "read-only",
  };
};

const completedResult = (params: ExternalAgentParams) => ({
  task: params.task,
  mode: params.config.mode,
  status: "executed" as const,
  summary: "Investigation complete",
  executedTools: [],
  outputSections: [],
});

const execute = (tool: ReturnType<typeof createParallelAgentSessionTool>) =>
  tool.definition.execute(
    {
      workers: ["first", "second"].map((id) => ({
        id,
        objective: `Investigate ${id}`,
        access: "read-only",
        readPaths: ["notes.txt"],
        writePaths: [],
      })),
    },
    {
      workspaceRoot: "unused",
      memory: {
        sessionEnabled: false,
        sessionEntries: [],
        globalEnabled: false,
        globalEntries: [],
      },
    },
  );

it.each(["codex-cli", "claude-cli", "copilot-cli"] as const)(
  "lets %s finish after five minutes of quiet reasoning",
  async (provider) => {
    const options = await createOptions(provider);
    vi.useFakeTimers();
    vi.mocked(maybeExecuteExternalAgentProviderTask).mockImplementation(
      async (params) => {
        await new Promise((resolve) => setTimeout(resolve, 5 * 60_000));
        return completedResult(params);
      },
    );
    const tool = createParallelAgentSessionTool(options);
    const pending = execute(tool);
    await vi.waitFor(() =>
      expect(maybeExecuteExternalAgentProviderTask).toHaveBeenCalledTimes(2),
    );

    await vi.advanceTimersByTimeAsync(180_000);
    const calls = vi.mocked(maybeExecuteExternalAgentProviderTask).mock.calls;
    expect(calls.every(([params]) => !params.signal?.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(2 * 60_000);

    const result = await pending;
    expect(result.toolResult.isError, result.toolResult.output).toBe(false);
    expect(tool.hasWorkerFailure()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(["stdout", "stderr", "mcp", "scoped-tool"] as const)(
  "keeps the worker and parent active through %s progress",
  async (activity) => {
    const options = await createOptions();
    vi.useFakeTimers();
    const parentTimeout = createManagedTaskExecutionTimeout(
      undefined,
      resolveTaskExecutionTimeouts({}),
    );
    const events: TaskExecutionTimelineEvent[] = [];
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    vi.mocked(maybeExecuteExternalAgentProviderTask).mockImplementation(
      async (params) => {
        if (params.task.includes("Investigate first")) await finished;
        return completedResult(params);
      },
    );
    const tool = createParallelAgentSessionTool({
      ...options,
      signal: parentTimeout.signal,
      onStreamActivity: parentTimeout.markActivity,
      onProgress: (event) => {
        events.push(event);
      },
    });
    const pending = execute(tool);
    await vi.waitFor(() =>
      expect(maybeExecuteExternalAgentProviderTask).toHaveBeenCalledTimes(2),
    );
    const params = vi.mocked(maybeExecuteExternalAgentProviderTask).mock
      .calls[0]![0];
    try {
      for (let step = 0; step < 3; step += 1) {
        await vi.advanceTimersByTimeAsync(15 * 60_000);
        if (activity === "mcp") {
          params.onStreamActivity?.();
        } else if (activity === "scoped-tool") {
          const read = params.scopedWorkerToolDefinitions!.find(
            (definition) => definition.spec.name === "read_file",
          )!;
          await read.execute(
            { path: "notes.txt", startLine: 1, endLine: 1 },
            {
              workspaceRoot: options.config.workspaceRoot,
              memory: params.preparedConversationContext.memory,
              signal: params.signal!,
            },
          );
        } else {
          await params.onActionOutput?.({
            toolName: "shell",
            stream: activity,
            chunk: "Investigating the failure\n",
          });
        }
        expect(params.signal?.aborted).toBe(false);
        expect(parentTimeout.signal.aborted).toBe(false);
      }
      finish();
      const result = await pending;
      expect(result.toolResult.isError, result.toolResult.output).toBe(false);
      if (activity === "scoped-tool") {
        expect(
          events
            .filter((event) => event.kind === "tool-call")
            .map((event) => event.phase),
        ).toEqual([
          "started",
          "completed",
          "started",
          "completed",
          "started",
          "completed",
        ]);
      }
    } finally {
      finish();
      await pending;
      parentTimeout.cleanup();
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("stops a silent CLI worker without replaying it and preserves completed siblings", async () => {
  const options = await createOptions();
  vi.useFakeTimers();
  vi.mocked(maybeExecuteExternalAgentProviderTask).mockImplementation(
    async (params) => {
      if (params.task.includes("Investigate first")) {
        await new Promise<never>((_resolve, reject) => {
          params.signal?.addEventListener(
            "abort",
            () => reject(params.signal!.reason),
            {
              once: true,
            },
          );
        });
      }
      return completedResult(params);
    },
  );
  const pending = execute(createParallelAgentSessionTool(options));
  await vi.waitFor(() =>
    expect(maybeExecuteExternalAgentProviderTask).toHaveBeenCalledTimes(2),
  );
  await vi.advanceTimersByTimeAsync(TASK_EXECUTION_IDLE_TIMEOUT_MS);

  const result = await pending;
  expect(JSON.parse(result.toolResult.output)).toMatchObject([
    {
      id: "first",
      status: "failed",
      answer: expect.stringContaining("without meaningful progress"),
    },
    { id: "second", status: "completed" },
  ]);
  expect(maybeExecuteExternalAgentProviderTask).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
