import { describe, expect, it, vi } from "vitest";
import type {
  WorkspaceRunConfigurationStatus,
  WorkspaceRunSnapshot,
} from "../../shared/workspace-run.js";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import {
  prepareConversationPromptContext,
  serializeWorkspaceRunContext,
} from "./conversation-prompt-context.js";

const providerAdapters = vi.hoisted(() => ({
  createProviderAdapter: vi.fn(),
}));

vi.mock("./provider-adapters.js", () => providerAdapters);
vi.mock("../env.js", () => ({
  loadUserMemorySettings: vi.fn(async () => ({
    globalEnabled: false,
    entries: [],
  })),
}));

const runtimeConfig: RuntimeConfig = {
  workspaceRoot: "C:/workspace",
  mode: "machdoch",
  provider: "openai",
  model: "gpt-primary",
  reasoning: "default",
  offline: false,
  compatibility: { discoverGithubCustomizations: false },
  providerAvailability: [
    { provider: "openai", configured: true },
    { provider: "anthropic", configured: true },
  ],
  webSearch: { activeProvider: "none", providerAvailability: [] },
  reviewModel: { mode: "base" },
  internalTaskModel: {
    provider: "anthropic",
    model: "claude-internal",
  },
};

const taskStatus = (
  id: string,
  command = "pnpm run dev",
): WorkspaceRunConfigurationStatus => ({
  configuration: {
    id,
    name: id,
    kind: "task",
    command,
    workingDirectory: ".",
    environment: { API_TOKEN: "secret-value" },
    hotReload: true,
    ports: [5173],
    urls: ["http://localhost:5173"],
    restartPolicy: {
      onCrash: true,
      maxRestarts: 5,
      windowMs: 60_000,
      backoffMs: 1_000,
      maxBackoffMs: 30_000,
    },
  },
  state: "running",
  pid: 42,
  startedAt: 1,
  stoppedAt: null,
  exitCode: null,
  restartCount: 0,
  health: {
    state: "failed",
    checkedAt: 1,
    consecutiveFailures: 1,
    message: "request used secret-value",
  },
  recentFailures: [
    { at: 1, kind: "launch", message: "failed with secret-value" },
  ],
  logs: [
    {
      sequence: 1,
      at: 1,
      stream: "stderr",
      line: "server printed secret-value",
    },
  ],
  children: [],
});

describe("workspace run prompt context", () => {
  it("redacts environment values while preserving structured state", () => {
    const serialized = serializeWorkspaceRunContext({
      workspaceRoot: "C:/workspace",
      primaryConfigurationId: "application",
      configurations: [taskStatus("application", "run secret-value")],
    });

    expect(JSON.parse(serialized)).toMatchObject({
      primaryConfigurationId: "application",
      configurations: [
        {
          configuration: {
            id: "application",
            environment: { API_TOKEN: "<redacted>" },
          },
          state: "running",
        },
      ],
    });
    expect(serialized).not.toContain("secret-value");
  });

  it("keeps oversized snapshots bounded and valid JSON", () => {
    const snapshot: WorkspaceRunSnapshot = {
      workspaceRoot: "C:/workspace",
      primaryConfigurationId: "application-0",
      configurations: Array.from({ length: 64 }, (_, index) =>
        taskStatus(`application-${index}`, "x".repeat(8_192)),
      ),
    };

    const serialized = serializeWorkspaceRunContext(snapshot);

    expect(serialized.length).toBeLessThanOrEqual(12_000);
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(serialized).not.toContain("secret-value");
  });
});

describe("conversation summary model", () => {
  it("uses the internal task selection instead of the primary task model", async () => {
    const startTurn = vi.fn(async () => ({
      text: "- Earlier requirement",
      toolCalls: [],
    }));
    providerAdapters.createProviderAdapter.mockResolvedValue({
      startTurn,
      continueTurn: vi.fn(),
    });

    const context = await prepareConversationPromptContext(
      "Continue the implementation",
      runtimeConfig,
      {
        history: Array.from({ length: 10 }, (_, index) => ({
          role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
          content: `Conversation message ${index + 1}`,
        })),
        globalMemoryEnabled: false,
      },
    );

    expect(providerAdapters.createProviderAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-internal",
      }),
      [],
      undefined,
    );
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-internal" }),
    );
    expect(context.promptBlock).toContain("- Earlier requirement");
  });
});
