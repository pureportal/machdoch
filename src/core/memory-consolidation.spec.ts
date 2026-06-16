import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadUserMemorySettings,
  saveUserGlobalMemoryEnabled,
} from "./env.ts";
import {
  consolidateTaskExecutionMemory,
  extractTaskMemoryCandidates,
} from "./memory-consolidation.ts";
import type {
  AgentModelAdapter,
  TaskExecutionResult,
} from "./types.ts";
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
    activeProfile: "workspace",
    availableProfiles: [{ name: "workspace", description: "Default profile" }],
    mode: "machdoch",
    provider: "unconfigured",
    model: "gpt-5.5",
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

describe("extractTaskMemoryCandidates", () => {
  it("defaults explicit memory requests to session memory when session memory is enabled", () => {
    expect(
      extractTaskMemoryCandidates(
        "Remember that the user prefers concise implementation summaries.",
        {
          sessionEnabled: true,
          globalEnabled: true,
        },
      ),
    ).toEqual([
      {
        scope: "session",
        content: "the user prefers concise implementation summaries",
        confidence: "explicit",
      },
    ]);
  });

  it("uses global memory only for explicit durable memory requests", () => {
    expect(
      extractTaskMemoryCandidates(
        "Remember globally that the user prefers compact summaries.",
        {
          sessionEnabled: true,
          globalEnabled: true,
        },
      ),
    ).toEqual([
      {
        scope: "global",
        content: "the user prefers compact summaries",
        confidence: "explicit",
      },
    ]);
  });

  it("does not persist session-only requests when session memory is disabled", () => {
    expect(
      extractTaskMemoryCandidates(
        "Remember only in this chat that the user prefers verbose traces.",
        {
          sessionEnabled: false,
          globalEnabled: true,
        },
      ),
    ).toEqual([]);
  });

  it("infers durable user preferences from stable preference phrasing", () => {
    expect(
      extractTaskMemoryCandidates("From now on, use short verification notes.", {
        sessionEnabled: true,
        globalEnabled: true,
      }),
    ).toEqual([
      {
        scope: "global",
        content: "The user prefers: use short verification notes",
        confidence: "inferred",
      },
    ]);
  });

  it("does not save secret-looking content", () => {
    expect(
      extractTaskMemoryCandidates("Remember that my API key is sk-test-value.", {
        sessionEnabled: true,
        globalEnabled: true,
      }),
    ).toEqual([]);
  });
});

describe("consolidateTaskExecutionMemory", () => {
  it("saves model-decided session memory for useful task-local technical learnings", async () => {
    const workspaceRoot = await createWorkspace();
    const task = "Investigate why the health check fails after the UI tests.";
    const memoryFact =
      "The Vite health check can fail when another dev server already owns port 5173";
    const memoryAdapter: AgentModelAdapter = {
      startTurn: async (params) => {
        expect(params.model).toBe("gpt-5.5-mini");
        expect(params.systemPrompt).toContain("post-task memory manager");
        expect(params.systemPrompt).toContain("technical limitations");
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
                    content: memoryFact,
                    reason:
                      "This limitation can affect later verification in this session.",
                    confidence: "high",
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
          model: "gpt-5.5-mini",
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
        content: memoryFact,
      },
    });
    expect(
      result.outputSections.some(
        (section) =>
          section.title === "Memory consolidation" &&
          section.lines.includes(`fact: ${memoryFact}`),
      ),
    ).toBe(true);
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
                  content: globalMemory,
                  reason:
                    "This is a stable user workflow preference across sessions.",
                  confidence: "medium",
                },
                {
                  scope: "session",
                  content: "The user's API key is sk-test-value",
                  reason: "Sensitive data should be rejected by the runtime.",
                  confidence: "high",
                },
                {
                  scope: "session",
                  content: "The task finished successfully",
                  reason: "Transient status is not worth saving.",
                  confidence: "low",
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

    process.env.MACHDOCH_USER_CONFIG_DIR = join(
      workspaceRoot,
      ".user-config",
    );
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
        content: globalMemory,
      },
    });
    expect(settings.entries.map((entry) => entry.content)).toEqual([
      globalMemory,
    ]);
  });
});
