import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInstructionResolutionFixture } from "../__test__/instruction-test-helpers.js";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import type {
  AgentModelAdapter,
  AgentModelToolCall,
  ParallelAgentMode,
  ResolvedTaskContext,
  TaskExecutionTimelineEvent,
} from "../types.js";
import {
  createParallelAgentSessionTool,
  type ParallelWorkerPlan,
} from "./parallel-agent-sessions.js";

const workspaces: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    workspaces
      .splice(0)
      .map((workspace) => rm(workspace, { recursive: true, force: true })),
  );
});

const createOptions = async (mode: ParallelAgentMode = "read-only") => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-parallel-"));
  workspaces.push(workspaceRoot);
  const config: RuntimeConfig = {
    workspaceRoot,
    mode: "machdoch",
    provider: "openai",
    model: "test-model",
    reasoning: "default",
    contextWindow: "default",
    offline: false,
    compatibility: { discoverGithubCustomizations: false },
    providerAvailability: [{ provider: "openai", configured: true }],
    webSearch: { activeProvider: "none", providerAvailability: [] },
    reviewModel: { mode: "base" },
    internalTaskModel: {
      provider: "openai",
      model: "test-model",
      reasoning: "default",
    },
  };
  const taskContext: ResolvedTaskContext = {
    task: "Inspect the workspace",
    effectiveTask: "Inspect the workspace",
    taskContextText: "",
    workspacePaths: [],
    suggestedTools: [],
    executionRole: "executor",
    applicableInstructions: [],
    instructionResolution: createInstructionResolutionFixture(),
  };
  return { config, task: "Inspect the workspace", taskContext, mode };
};

const worker = (
  id: string,
  overrides: Partial<ParallelWorkerPlan> = {},
): ParallelWorkerPlan => ({
  id,
  objective: `Inspect ${id}`,
  access: "read-only",
  readPaths: [],
  writePaths: [],
  ...overrides,
});

const execute = async (
  tool: ReturnType<typeof createParallelAgentSessionTool>,
  workers: ParallelWorkerPlan[],
) =>
  tool.definition.execute(
    { workers },
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

describe("parallel agent sessions", () => {
  it("reports each worker's model, tool, and completion activity", async () => {
    const options = await createOptions();
    await writeFile(
      join(options.config.workspaceRoot, "notes.txt"),
      "notes",
      "utf8",
    );
    const events: TaskExecutionTimelineEvent[] = [];
    const tool = createParallelAgentSessionTool({
      ...options,
      onProgress: (event) => {
        events.push(event);
      },
      createWorkerAdapter: async (): Promise<AgentModelAdapter> => ({
        startTurn: async ({ userPrompt }) =>
          userPrompt.includes("Inspect first")
            ? {
                text: "",
                toolCalls: [
                  {
                    id: "read",
                    name: "read_file",
                    arguments: { path: "notes.txt", startLine: 1, endLine: 1 },
                  },
                ],
              }
            : { text: "Second finding", toolCalls: [] },
        continueTurn: async () => ({ text: "First finding", toolCalls: [] }),
      }),
    });

    const result = await execute(tool, [worker("first"), worker("second")]);

    expect(result.toolResult.isError, result.toolResult.output).toBe(false);
    expect(
      events.filter(
        (event) => event.kind === "agent" && event.label === "Agent first",
      ),
    ).toMatchObject([
      { phase: "started", detail: "Inspect first" },
      { phase: "completed" },
    ]);
    expect(
      events.filter(
        (event) => event.kind === "agent" && event.label === "Agent second",
      ),
    ).toMatchObject([
      { phase: "started", detail: "Inspect second" },
      { phase: "completed" },
    ]);
    expect(
      events
        .filter((event) => event.label === "Agent first · AI pass 1")
        .map((event) => event.phase),
    ).toEqual(["started", "completed"]);
    expect(
      events.filter((event) => event.callId === "first:read"),
    ).toMatchObject([
      { phase: "started", detail: "notes.txt", toolName: "read_file" },
      { phase: "completed", detail: "notes.txt", toolName: "read_file" },
    ]);
    expect(
      events.some((event) => event.detail?.includes("First finding")),
    ).toBe(false);
  });

  it("reports provider failure on the affected worker", async () => {
    const options = await createOptions();
    const events: TaskExecutionTimelineEvent[] = [];
    const tool = createParallelAgentSessionTool({
      ...options,
      onProgress: (event) => {
        events.push(event);
      },
      createWorkerAdapter: async (): Promise<AgentModelAdapter> => ({
        startTurn: async ({ userPrompt }) => {
          if (userPrompt.includes("Inspect first"))
            throw new Error("Provider failed");
          return { text: "Second finding", toolCalls: [] };
        },
        continueTurn: async () => ({ text: "", toolCalls: [] }),
      }),
    });

    const result = await execute(tool, [worker("first"), worker("second")]);

    expect(result.toolResult.isError).toBe(true);
    expect(result.traceLines).toEqual([
      "parallel agents: first failed, second completed",
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "model-call",
        phase: "failed",
        label: "Agent first · AI pass 1",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "agent",
        phase: "failed",
        label: "Agent first",
        detail: "Provider failed",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "agent",
        phase: "completed",
        label: "Agent second",
      }),
    );
  });

  it("does not wait for a stalled progress listener", async () => {
    const options = await createOptions();
    const tool = createParallelAgentSessionTool({
      ...options,
      onProgress: () => new Promise<void>(() => undefined),
      createWorkerAdapter: async (): Promise<AgentModelAdapter> => ({
        startTurn: async () => ({ text: "Finding", toolCalls: [] }),
        continueTurn: async () => ({ text: "", toolCalls: [] }),
      }),
    });

    const result = await execute(tool, [worker("first"), worker("second")]);

    expect(result.toolResult.isError).toBe(false);
  });

  it("does not start a model request after progress reporting cancels the parent", async () => {
    const options = await createOptions();
    const controller = new AbortController();
    let modelRequests = 0;
    const tool = createParallelAgentSessionTool({
      ...options,
      signal: controller.signal,
      onProgress: (event) => {
        if (event.kind === "model-call" && event.phase === "started")
          controller.abort();
      },
      createWorkerAdapter: async (): Promise<AgentModelAdapter> => ({
        startTurn: async () => {
          modelRequests += 1;
          return { text: "Unexpected", toolCalls: [] };
        },
        continueTurn: async () => ({ text: "", toolCalls: [] }),
      }),
    });

    const result = await execute(tool, [worker("first"), worker("second")]);

    expect(result.toolResult.isError).toBe(true);
    expect(modelRequests).toBe(0);
  });

  it("applies the request's worker cap", async () => {
    const options = await createOptions();
    const tool = createParallelAgentSessionTool({ ...options, maxWorkers: 2 });
    const schema = tool.definition.spec.inputSchema.properties as Record<
      string,
      { maxItems?: number }
    >;
    expect(schema.workers?.maxItems).toBe(2);
    const result = await execute(tool, [
      worker("first"),
      worker("second"),
      worker("third"),
    ]);
    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.output).toContain("two independent workers");
  });

  it("starts fresh sessions concurrently and returns results in plan order", async () => {
    const options = await createOptions();
    let active = 0;
    let peak = 0;
    let created = 0;
    const tool = createParallelAgentSessionTool({
      ...options,
      createWorkerAdapter: async (): Promise<AgentModelAdapter> => {
        const id = ++created;
        return {
          startTurn: async ({ systemPrompt, tools }) => {
            expect(systemPrompt).toContain(
              "Follow the frozen instruction fixture.",
            );
            expect(
              tools.some((entry) => entry.name === "run_parallel_agents"),
            ).toBe(false);
            expect(tools.some((entry) => entry.name === "create_file")).toBe(
              false,
            );
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) =>
              setTimeout(resolve, id === 1 ? 50 : 10),
            );
            active -= 1;
            return { text: `Result ${id}`, toolCalls: [] };
          },
          continueTurn: async () => {
            throw new Error("Unexpected continuation");
          },
        };
      },
    });
    const result = await execute(tool, [worker("first"), worker("second")]);
    expect(peak).toBe(2);
    expect(created).toBe(2);
    expect(result.toolResult.isError).toBe(false);
    expect(JSON.parse(result.toolResult.output)).toMatchObject([
      { id: "first", status: "completed", answer: "Result 1" },
      { id: "second", status: "completed", answer: "Result 2" },
    ]);
  });

  it("rejects write claims in Read Only mode before starting workers", async () => {
    const options = await createOptions();
    let started = 0;
    const events: TaskExecutionTimelineEvent[] = [];
    const tool = createParallelAgentSessionTool({
      ...options,
      onProgress: (event) => {
        events.push(event);
      },
      createWorkerAdapter: async () => {
        started += 1;
        throw new Error("Should not start");
      },
    });
    const result = await execute(tool, [
      worker("first", { access: "write", writePaths: ["a.txt"] }),
      worker("second"),
    ]);
    expect(result.toolResult.isError).toBe(true);
    expect(started).toBe(0);
    expect(events).toEqual([]);
    const schema = tool.definition.spec.inputSchema.properties as Record<
      string,
      {
        items: { properties: Record<string, { enum?: string[] }> };
      }
    >;
    expect(schema.workers?.items.properties.access?.enum).toEqual([
      "read-only",
    ]);
  });

  it("does not start workers after the parent was cancelled", async () => {
    const options = await createOptions();
    const controller = new AbortController();
    controller.abort();
    let created = 0;
    const tool = createParallelAgentSessionTool({
      ...options,
      signal: controller.signal,
      createWorkerAdapter: async () => {
        created += 1;
        throw new Error("Unexpected startup");
      },
    });
    const result = await execute(tool, [worker("first"), worker("second")]);
    expect(result.toolResult.isError).toBe(true);
    expect(created).toBe(0);
  });

  it("rejects overlapping write claims and aliases before starting workers", async () => {
    const options = await createOptions("machdoch");
    let started = 0;
    const tool = createParallelAgentSessionTool({
      ...options,
      createWorkerAdapter: async () => {
        started += 1;
        throw new Error("Should not start");
      },
    });
    const result = await execute(tool, [
      worker("first", { access: "write", writePaths: ["same.txt"] }),
      worker("second", { access: "write", writePaths: ["./same.txt"] }),
    ]);
    expect(result.toolResult.isError).toBe(true);
    expect(started).toBe(0);
  });

  it("allows disjoint scoped file writes and refuses an unclaimed file", async () => {
    const options = await createOptions("machdoch");
    await writeFile(
      join(options.config.workspaceRoot, "a.txt"),
      "before",
      "utf8",
    );
    await writeFile(
      join(options.config.workspaceRoot, "b.txt"),
      "before",
      "utf8",
    );
    let created = 0;
    const tool = createParallelAgentSessionTool({
      ...options,
      createWorkerAdapter: async (): Promise<AgentModelAdapter> => {
        const id = ++created;
        const path = id === 1 ? "a.txt" : "b.txt";
        let attempted = false;
        return {
          startTurn: async () => ({
            text: "",
            toolCalls: [
              {
                id: `edit-${id}`,
                name: "replace_in_file",
                arguments: {
                  path,
                  oldText: "before",
                  newText: `after-${id}`,
                  replaceAll: false,
                },
              },
            ],
          }),
          continueTurn: async ({ toolResults }) => {
            if (!attempted) {
              attempted = true;
              expect(toolResults[0]?.isError).toBeUndefined();
              return { text: `Edited ${path}`, toolCalls: [] };
            }
            throw new Error("Unexpected continuation");
          },
        };
      },
    });
    const result = await execute(tool, [
      worker("first", { access: "write", writePaths: ["a.txt"] }),
      worker("second", { access: "write", writePaths: ["b.txt"] }),
    ]);
    expect(result.toolResult.isError, result.toolResult.output).toBe(false);
    expect(
      await readFile(join(options.config.workspaceRoot, "a.txt"), "utf8"),
    ).toBe("after-1");
    expect(
      await readFile(join(options.config.workspaceRoot, "b.txt"), "utf8"),
    ).toBe("after-2");

    const escaped = createParallelAgentSessionTool({
      ...options,
      createWorkerAdapter: async (): Promise<AgentModelAdapter> => ({
        startTurn: async () => ({
          text: "",
          toolCalls: [
            {
              id: "escape",
              name: "create_file",
              arguments: { path: "outside.txt", content: "bad" },
            },
          ],
        }),
        continueTurn: async () => ({ text: "done", toolCalls: [] }),
      }),
    });
    const escapedResult = await execute(escaped, [
      worker("first", { access: "write", writePaths: ["a.txt"] }),
      worker("second", { access: "write", writePaths: ["b.txt"] }),
    ]);
    expect(escapedResult.toolResult.isError).toBe(true);
    expect(escaped.hasWorkerFailure()).toBe(true);
    await expect(
      readFile(join(options.config.workspaceRoot, "outside.txt"), "utf8"),
    ).rejects.toThrow();
  });

  it("settles successful siblings after a worker failure", async () => {
    const options = await createOptions();
    let created = 0;
    const tool = createParallelAgentSessionTool({
      ...options,
      createWorkerAdapter: async (): Promise<AgentModelAdapter> => {
        const id = ++created;
        return {
          startTurn: async () => {
            if (id === 1) throw new Error("Provider failed");
            await new Promise((resolve) => setTimeout(resolve, 15));
            return { text: "Useful finding", toolCalls: [] };
          },
          continueTurn: async () => ({ text: "", toolCalls: [] }),
        };
      },
    });
    const result = await execute(tool, [worker("first"), worker("second")]);
    expect(JSON.parse(result.toolResult.output)).toMatchObject([
      { id: "first", status: "failed" },
      { id: "second", status: "completed", answer: "Useful finding" },
    ]);
    expect(tool.hasWorkerFailure()).toBe(true);
  });

  it("cancels every running worker when the parent is cancelled", async () => {
    const options = await createOptions();
    const controller = new AbortController();
    let active = 0;
    let allStarted!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      allStarted = resolve;
    });
    const tool = createParallelAgentSessionTool({
      ...options,
      signal: controller.signal,
      createWorkerAdapter: async (): Promise<AgentModelAdapter> => ({
        startTurn: async ({ signal }) => {
          active += 1;
          if (active === 2) allStarted();
          try {
            await new Promise<void>((_resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () => reject(new Error("Cancelled")),
                { once: true },
              );
            });
            throw new Error("Unexpected completion");
          } finally {
            active -= 1;
          }
        },
        continueTurn: async () => ({ text: "", toolCalls: [] }),
      }),
    });
    const pending = execute(tool, [worker("first"), worker("second")]);
    await startedPromise;
    expect(active).toBe(2);
    controller.abort();
    const result = await pending;
    expect(result.toolResult.isError).toBe(true);
    expect(active).toBe(0);
  });

  it("settles cancellation while adapter creation is stalled", async () => {
    const options = await createOptions();
    const controller = new AbortController();
    let resolveCreation!: (adapter: AgentModelAdapter) => void;
    const stalledCreation = new Promise<AgentModelAdapter>((resolve) => {
      resolveCreation = resolve;
    });
    let allCreating!: () => void;
    const creatingPromise = new Promise<void>((resolve) => {
      allCreating = resolve;
    });
    let creating = 0;
    let started = 0;
    const tool = createParallelAgentSessionTool({
      ...options,
      signal: controller.signal,
      createWorkerAdapter: () => {
        creating += 1;
        if (creating === 2) allCreating();
        return stalledCreation;
      },
    });
    const pending = execute(tool, [worker("first"), worker("second")]);
    await creatingPromise;
    controller.abort();
    const result = await pending;
    expect(result.toolResult.isError).toBe(true);
    resolveCreation({
      startTurn: async () => {
        started += 1;
        return { text: "late", toolCalls: [] };
      },
      continueTurn: async () => ({ text: "late", toolCalls: [] }),
    });
    await Promise.resolve();
    expect(started).toBe(0);
  });

  it("ignores a late provider response after cancellation", async () => {
    const options = await createOptions("machdoch");
    const controller = new AbortController();
    let resolveTurn!: (turn: {
      text: string;
      toolCalls: AgentModelToolCall[];
    }) => void;
    const lateTurn = new Promise<{
      text: string;
      toolCalls: AgentModelToolCall[];
    }>((resolve) => {
      resolveTurn = resolve;
    });
    let started = 0;
    let allStarted!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      allStarted = resolve;
    });
    const tool = createParallelAgentSessionTool({
      ...options,
      signal: controller.signal,
      createWorkerAdapter: async () => ({
        startTurn: async () => {
          started += 1;
          if (started === 2) allStarted();
          return await lateTurn;
        },
        continueTurn: async () => ({ text: "unexpected", toolCalls: [] }),
      }),
    });
    const pending = execute(tool, [
      worker("first", { access: "write", writePaths: ["first.txt"] }),
      worker("second", { access: "write", writePaths: ["second.txt"] }),
    ]);
    await startedPromise;
    expect(started).toBe(2);
    controller.abort();
    const result = await pending;
    expect(result.toolResult.isError).toBe(true);
    resolveTurn({
      text: "",
      toolCalls: [
        {
          id: "late",
          name: "create_file",
          arguments: { path: "first.txt", content: "late" },
        },
      ],
    });
    await Promise.resolve();
    await expect(
      readFile(join(options.config.workspaceRoot, "first.txt"), "utf8"),
    ).rejects.toThrow();
  });

  it("times out a stalled worker without waiting for its provider", async () => {
    const options = await createOptions();
    vi.useFakeTimers();
    let started = 0;
    let allStarted!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      allStarted = resolve;
    });
    const tool = createParallelAgentSessionTool({
      ...options,
      createWorkerAdapter: async () => ({
        startTurn: async () => {
          started += 1;
          if (started === 2) allStarted();
          return await new Promise<never>(() => undefined);
        },
        continueTurn: async () => ({ text: "unexpected", toolCalls: [] }),
      }),
    });
    const pending = execute(tool, [worker("first"), worker("second")]);
    await startedPromise;
    await vi.advanceTimersByTimeAsync(180_000);
    const result = await pending;
    expect(result.toolResult.isError).toBe(true);
    expect(JSON.parse(result.toolResult.output)).toMatchObject([
      { id: "first", status: "failed", answer: "Worker first timed out." },
      { id: "second", status: "failed", answer: "Worker second timed out." },
    ]);
  });

  it("stops a stalled sibling when a worker crosses its file boundary", async () => {
    const options = await createOptions("machdoch");
    let created = 0;
    let siblingStarted!: () => void;
    const siblingReady = new Promise<void>((resolve) => {
      siblingStarted = resolve;
    });
    const tool = createParallelAgentSessionTool({
      ...options,
      createWorkerAdapter: async () => {
        const id = ++created;
        return {
          startTurn: async () => {
            if (id === 2) {
              siblingStarted();
              return await new Promise<never>(() => undefined);
            }
            await siblingReady;
            return {
              text: "",
              toolCalls: [
                {
                  id: "escape",
                  name: "create_file",
                  arguments: { path: "outside.txt", content: "bad" },
                },
              ],
            };
          },
          continueTurn: async () => ({ text: "unexpected", toolCalls: [] }),
        };
      },
    });
    const result = await execute(tool, [
      worker("first", { access: "write", writePaths: ["first.txt"] }),
      worker("second", { access: "write", writePaths: ["second.txt"] }),
    ]);
    expect(result.toolResult.isError).toBe(true);
    expect(JSON.parse(result.toolResult.output)).toMatchObject([
      { id: "first", status: "failed" },
      { id: "second", status: "failed" },
    ]);
    await expect(
      readFile(join(options.config.workspaceRoot, "outside.txt"), "utf8"),
    ).rejects.toThrow();
  });
});
