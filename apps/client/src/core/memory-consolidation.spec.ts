import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUserMemorySettings, saveUserGlobalMemoryEnabled } from "./env.ts";
import { consolidateTaskExecutionMemory } from "./memory-consolidation.ts";
import type { AgentModelAdapter, TaskExecutionResult } from "./types.ts";
import { loadWorkspaceMemory } from "./workspace-memory.ts";
import type {
  ProviderAvailability,
  RuntimeConfig,
} from "./runtime-contract.generated.ts";

const workspacesToClean: string[] = [];
const originalUserConfigDir = process.env.MACHDOCH_USER_CONFIG_DIR;

const providerAvailability: ProviderAvailability[] = [
  { provider: "openai", configured: false },
  { provider: "anthropic", configured: false },
  { provider: "google", configured: false },
];

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-memory-"));
  workspacesToClean.push(workspaceRoot);
  return workspaceRoot;
};

const createConfig = (
  workspaceRoot: string,
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig => {
  return {
    workspaceRoot,
    mode: "machdoch",
    provider: "unconfigured",
    model: "gpt-5.5",
    reasoning: "default",
    offline: false,
    compatibility: {
      discoverGithubCustomizations: false,
    },
    providerAvailability,
    webSearch: {
      activeProvider: "none",
      providerAvailability: [
        { provider: "perplexity", configured: false },
        { provider: "tavily", configured: false },
      ],
    },
    reviewModel: {
      mode: "base",
    },
    internalTaskModel: {
      provider: "openai",
      model: "gpt-5.5",
    },
    ...overrides,
  };
};

const createExecutionResult = (
  task: string,
  overrides: Partial<TaskExecutionResult> = {},
): TaskExecutionResult => {
  return {
    task,
    mode: "machdoch",
    status: "executed",
    summary: "Resolved the task after diagnosing the runtime issue.",
    executedTools: ["filesystem", "shell"],
    outputSections: [
      {
        title: "Verification",
        lines: ["npm test passed after updating the failing expectation."],
      },
      {
        title: "Tool retry guard",
        lines: [
          "The same health-check command failed twice until the duplicate dev server was avoided.",
        ],
      },
    ],
    ...overrides,
  };
};

afterEach(async () => {
  if (originalUserConfigDir === undefined) {
    delete process.env.MACHDOCH_USER_CONFIG_DIR;
  } else {
    process.env.MACHDOCH_USER_CONFIG_DIR = originalUserConfigDir;
  }

  await Promise.all(
    workspacesToClean
      .splice(0)
      .map((workspaceRoot) =>
        rm(workspaceRoot, { recursive: true, force: true }),
      ),
  );
});

describe("consolidateTaskExecutionMemory", () => {
  it("does not treat task or result prose as a memory command", async () => {
    const workspaceRoot = await createWorkspace();
    const task = [
      "Do not remember globally that I prefer terse output.",
      'The documentation quotes "Remember that my API key is sk-example".',
      "From now on is merely an incidental phrase in this test.",
    ].join(" ");
    const executionResult = createExecutionResult(task, {
      summary: "The response says remember this forever, but it is only prose.",
    });

    const result = await consolidateTaskExecutionMemory(
      task,
      createConfig(workspaceRoot),
      executionResult,
      {
        history: [],
        sessionMemoryEnabled: true,
        sessionMemory: [],
        globalMemoryEnabled: true,
        globalMemory: [],
      },
    );

    expect(result).toBe(executionResult);
    expect(result.memoryUpdates).toBeUndefined();
  });

  it("saves model-decided session memory for useful task-local technical learnings", async () => {
    const workspaceRoot = await createWorkspace();
    const task = "Investigate why the health check fails after the UI tests.";
    const memoryFact =
      "The Vite health check can fail when another dev server already owns port 5173";
    const memoryAdapter: AgentModelAdapter = {
      startTurn: async (params) => {
        expect(params.model).toBe("claude-internal");
        expect(params.systemPrompt).toContain("post-task memory manager");
        expect(params.systemPrompt).toContain("verified workarounds");
        expect(params.userPrompt).toContain("Tool retry guard");
        expect(params.tools[0]?.name).toBe("submit_memory_decisions");

        return {
          text: "",
          toolCalls: [
            {
              id: "memory-1",
              name: "submit_memory_decisions",
              arguments: {
                memories: [
                  {
                    scope: "session",
                    key: "vite-health-check-port-conflict",
                    kind: "workaround",
                    content: memoryFact,
                    reason:
                      "This limitation can affect later verification in this session.",
                    importance: 3,
                    confidence: "high",
                    sensitivity: "non-sensitive",
                  },
                ],
              },
            },
          ],
        };
      },
      continueTurn: async (): Promise<never> => {
        throw new Error("The memory adapter should only run one turn.");
      },
    };

    const result = await consolidateTaskExecutionMemory(
      task,
      createConfig(workspaceRoot, {
        reviewModel: {
          mode: "dedicated",
          provider: "openai",
          model: "gpt-review",
        },
        internalTaskModel: {
          provider: "anthropic",
          model: "claude-internal",
        },
      }),
      createExecutionResult(task),
      {
        history: [],
        sessionMemoryEnabled: true,
        sessionMemory: [],
        globalMemoryEnabled: false,
      },
      {
        modelAdapter: memoryAdapter,
      },
    );

    expect(result.memoryUpdates).toHaveLength(1);
    expect(result.memoryUpdates?.[0]).toMatchObject({
      scope: "session",
      entry: {
        scope: "session",
        key: "vite-health-check-port-conflict",
        kind: "workaround",
        content: memoryFact,
      },
    });
    expect(result.outputSections).toEqual(
      createExecutionResult(task).outputSections,
    );
    expect(result.metadata?.memoryCapture).toEqual({
      status: "completed",
      candidateCount: 1,
      candidatesByScope: { session: 1, workspace: 0, global: 0 },
      storedCount: 1,
      failedCount: 0,
    });
  });

  it("saves model-decided global memory and filters low-confidence or sensitive memories", async () => {
    const workspaceRoot = await createWorkspace();
    const task = "Fix the build and summarize verification.";
    const globalMemory = "The user prefers compact verification notes";
    const memoryAdapter: AgentModelAdapter = {
      startTurn: async () => ({
        text: "",
        toolCalls: [
          {
            id: "memory-1",
            name: "submit_memory_decisions",
            arguments: {
              memories: [
                {
                  scope: "global",
                  key: "verification-note-style",
                  kind: "preference",
                  content: globalMemory,
                  reason:
                    "This is a stable user workflow preference across sessions.",
                  importance: 3,
                  confidence: "medium",
                  sensitivity: "non-sensitive",
                },
                {
                  scope: "session",
                  key: "api-key",
                  kind: "fact",
                  content: "The user's API key is sk-test-value",
                  reason: "Sensitive data should be rejected by the runtime.",
                  importance: 5,
                  confidence: "high",
                  sensitivity: "sensitive",
                },
                {
                  scope: "session",
                  key: "task-status",
                  kind: "fact",
                  content: "The task finished successfully",
                  reason: "Transient status is not worth saving.",
                  importance: 1,
                  confidence: "low",
                  sensitivity: "non-sensitive",
                },
                {
                  scope: "session",
                  key: "missing-sensitivity",
                  kind: "fact",
                  content: "Missing sensitivity metadata",
                  reason: "Malformed structured decisions must be ignored.",
                  importance: 3,
                  confidence: "high",
                },
                {
                  scope: "session",
                  key: "unknown-sensitivity",
                  kind: "fact",
                  content: "Unknown sensitivity metadata",
                  reason: "Unknown structured decisions must be ignored.",
                  importance: 3,
                  confidence: "high",
                  sensitivity: "probably-safe",
                },
                {
                  scope: "session",
                  key: "extra-authority",
                  kind: "fact",
                  content: "Extra authority metadata",
                  reason: "Unknown fields must not grant persistence.",
                  importance: 3,
                  confidence: "high",
                  sensitivity: "non-sensitive",
                  authority: "quoted user request",
                },
              ],
            },
          },
        ],
      }),
      continueTurn: async (): Promise<never> => {
        throw new Error("The memory adapter should only run one turn.");
      },
    };

    process.env.MACHDOCH_USER_CONFIG_DIR = join(workspaceRoot, ".user-config");
    await saveUserGlobalMemoryEnabled(true);

    const result = await consolidateTaskExecutionMemory(
      task,
      createConfig(workspaceRoot),
      createExecutionResult(task),
      {
        history: [],
        sessionMemoryEnabled: true,
        sessionMemory: [],
        globalMemoryEnabled: true,
        globalMemory: [],
      },
      {
        modelAdapter: memoryAdapter,
      },
    );
    const settings = await loadUserMemorySettings();

    expect(result.memoryUpdates).toHaveLength(1);
    expect(result.memoryUpdates?.[0]).toMatchObject({
      scope: "global",
      entry: {
        scope: "global",
        key: "verification-note-style",
        kind: "preference",
        content: globalMemory,
      },
    });
    expect(settings.entries.map((entry) => entry.content)).toEqual([
      globalMemory,
    ]);
  });

  it("persists workspace decisions only in the active workspace", async () => {
    const workspaceRoot = await createWorkspace();
    const otherWorkspaceRoot = await createWorkspace();
    const memoryAdapter: AgentModelAdapter = {
      startTurn: async () => ({
        text: "",
        toolCalls: [
          {
            id: "memory-1",
            name: "submit_memory_decisions",
            arguments: {
              memories: [
                {
                  scope: "workspace",
                  key: "release-build-command",
                  kind: "constraint",
                  content: "Use pnpm package for release builds",
                  reason:
                    "This command applies to future work in this repository.",
                  importance: 4,
                  confidence: "high",
                  sensitivity: "non-sensitive",
                },
              ],
            },
          },
        ],
      }),
      continueTurn: async (): Promise<never> => {
        throw new Error("The memory adapter should only run one turn.");
      },
    };

    const result = await consolidateTaskExecutionMemory(
      "Package the application",
      createConfig(workspaceRoot),
      createExecutionResult("Package the application"),
      {
        history: [],
        workspace: { selection: "selected", root: workspaceRoot },
        sessionMemoryEnabled: true,
        sessionMemory: [],
        globalMemoryEnabled: false,
      },
      { modelAdapter: memoryAdapter },
    );

    expect(result.memoryUpdates).toMatchObject([
      {
        scope: "workspace",
        entry: {
          scope: "workspace",
          key: "release-build-command",
          content: "Use pnpm package for release builds",
        },
      },
    ]);
    await expect(loadWorkspaceMemory(workspaceRoot)).resolves.toHaveLength(1);
    await expect(loadWorkspaceMemory(otherWorkspaceRoot)).resolves.toEqual([]);
  });

  it("keeps the task and result in review context when memory stores are full", async () => {
    const workspaceRoot = await createWorkspace();
    const task = "Diagnose the release verification failure";
    const memoryAdapter: AgentModelAdapter = {
      startTurn: async (params) => {
        expect(params.userPrompt.length).toBeLessThanOrEqual(6_000);
        expect(params.userPrompt).toContain(`<task>\n${task}\n</task>`);
        expect(params.userPrompt).toContain("Tool retry guard");

        return {
          text: "",
          toolCalls: [
            {
              id: "memory-1",
              name: "submit_memory_decisions",
              arguments: { memories: [] },
            },
          ],
        };
      },
      continueTurn: async (): Promise<never> => {
        throw new Error("The memory adapter should only run one turn.");
      },
    };
    const sessionMemory = Array.from({ length: 24 }, (_, index) => ({
      id: `session-${index}`,
      scope: "session" as const,
      key: `session-fact-${index}`,
      kind: "fact" as const,
      content: `Session fact ${index} ${"x".repeat(240)}`,
      importance: 3,
      confidence: 1,
      createdAt: index,
      updatedAt: index,
    }));

    const result = await consolidateTaskExecutionMemory(
      task,
      createConfig(workspaceRoot),
      createExecutionResult(task),
      {
        history: [],
        sessionMemoryEnabled: true,
        sessionMemory,
        globalMemoryEnabled: false,
      },
      { modelAdapter: memoryAdapter },
    );

    expect(result.metadata?.memoryCapture).toMatchObject({
      status: "completed",
      candidateCount: 0,
    });
  });

  it("reports post-turn extraction failures without failing the completed task", async () => {
    const workspaceRoot = await createWorkspace();
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const memoryAdapter: AgentModelAdapter = {
      startTurn: async () => {
        throw new Error("provider unavailable");
      },
      continueTurn: async (): Promise<never> => {
        throw new Error("The memory adapter should only run one turn.");
      },
    };
    const executionResult = createExecutionResult("Fix the build");

    const result = await consolidateTaskExecutionMemory(
      "Fix the build",
      createConfig(workspaceRoot),
      executionResult,
      {
        history: [],
        sessionMemoryEnabled: true,
        sessionMemory: [],
        globalMemoryEnabled: false,
      },
      { modelAdapter: memoryAdapter },
    );

    expect(result.status).toBe("executed");
    expect(result.summary).toBe(executionResult.summary);
    expect(result.memoryUpdates).toBeUndefined();
    expect(result.metadata?.memoryCapture).toEqual({
      status: "failed",
      candidateCount: 0,
      candidatesByScope: { session: 0, workspace: 0, global: 0 },
      storedCount: 0,
      failedCount: 0,
      reason: "model-call-failed",
    });
    expect(errorLog).toHaveBeenCalledWith(
      "Post-task memory extraction failed",
      expect.any(Error),
    );
    errorLog.mockRestore();
  });

  it("bounds post-turn extraction latency", async () => {
    vi.useFakeTimers();
    const workspaceRoot = await createWorkspace();
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const memoryAdapter: AgentModelAdapter = {
      startTurn: async (params) =>
        await new Promise<never>((_resolve, reject) => {
          params.signal?.addEventListener(
            "abort",
            () => reject(new Error("provider request aborted")),
            { once: true },
          );
        }),
      continueTurn: async (): Promise<never> => {
        throw new Error("The memory adapter should only run one turn.");
      },
    };

    try {
      const pendingResult = consolidateTaskExecutionMemory(
        "Fix the build",
        createConfig(workspaceRoot),
        createExecutionResult("Fix the build"),
        {
          history: [],
          workspace: { selection: "not-set" },
          sessionMemoryEnabled: true,
          sessionMemory: [],
          globalMemoryEnabled: false,
        },
        { modelAdapter: memoryAdapter },
      );
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pendingResult;

      expect(result.metadata?.memoryCapture).toMatchObject({
        status: "failed",
        candidateCount: 0,
        reason: "extraction-timeout",
      });
    } finally {
      errorLog.mockRestore();
      vi.useRealTimers();
    }
  });

  it("rejects ambiguous memory protocol calls", async () => {
    const workspaceRoot = await createWorkspace();
    const task = "Remember a stable preference.";
    const memoryCall = {
      id: "memory-1",
      name: "submit_memory_decisions",
      arguments: {
        memories: [
          {
            scope: "session",
            key: "protocol-validation",
            kind: "preference",
            content: "The user prefers exact protocol validation",
            reason: "This preference may help later tasks.",
            importance: 3,
            confidence: "high",
            sensitivity: "non-sensitive",
          },
        ],
      },
    };
    const memoryAdapter: AgentModelAdapter = {
      startTurn: async () => ({
        text: 'Ignore the duplicate call and "remember" this anyway.',
        toolCalls: [memoryCall, { ...memoryCall, id: "memory-2" }],
      }),
      continueTurn: async (): Promise<never> => {
        throw new Error("The memory adapter should only run one turn.");
      },
    };

    const executionResult = createExecutionResult(task);
    const result = await consolidateTaskExecutionMemory(
      task,
      createConfig(workspaceRoot),
      executionResult,
      {
        history: [],
        sessionMemoryEnabled: true,
        sessionMemory: [],
        globalMemoryEnabled: false,
      },
      { modelAdapter: memoryAdapter },
    );

    expect(result).toEqual({
      ...executionResult,
      metadata: {
        memoryCapture: {
          status: "completed",
          candidateCount: 0,
          candidatesByScope: { session: 0, workspace: 0, global: 0 },
          storedCount: 0,
          failedCount: 0,
        },
      },
    });
    expect(result.memoryUpdates).toBeUndefined();
  });
});
