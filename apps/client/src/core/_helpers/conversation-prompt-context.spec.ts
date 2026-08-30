import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  WorkspaceRunConfigurationStatus,
  WorkspaceRunSnapshot,
} from "../../shared/workspace-run.js";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import type { ConversationMemoryEntry } from "../types.js";
import { rememberWorkspaceMemory } from "../workspace-memory.js";
import {
  prepareConversationPromptContext,
  serializeWorkspaceRunContext,
} from "./conversation-prompt-context.js";

const providerAdapters = vi.hoisted(() => ({
  createProviderAdapter: vi.fn(),
}));
const memorySettings = vi.hoisted(() => ({
  globalEnabled: false,
  entries: [] as ConversationMemoryEntry[],
}));

vi.mock("./provider-adapters.js", () => providerAdapters);
vi.mock("../env.js", () => ({
  loadUserMemorySettings: vi.fn(async () => memorySettings),
}));

const workspaceRoots: string[] = [];

afterEach(async () => {
  memorySettings.globalEnabled = false;
  memorySettings.entries = [];
  providerAdapters.createProviderAdapter.mockReset();
  await Promise.all(
    workspaceRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

const runtimeConfig: RuntimeConfig = {
  workspaceRoot: "C:/workspace",
  mode: "machdoch",
  provider: "openai",
  model: "gpt-primary",
  reasoning: "default",
  contextWindow: "default",
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
    reasoning: "default",
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
    primary: true,
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

describe("conversation memory prompt context", () => {
  it("injects only relevant facts while retaining the full stores for updates", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "machdoch-prompt-memory-"),
    );
    workspaceRoots.push(workspaceRoot);
    await rememberWorkspaceMemory(
      workspaceRoot,
      "The release build uses pnpm package",
      { key: "release-build-command", kind: "constraint", importance: 4 },
    );
    await rememberWorkspaceMemory(
      workspaceRoot,
      "Gallery thumbnails use a 4:3 aspect ratio",
      { key: "gallery-thumbnail-ratio", kind: "decision" },
    );
    memorySettings.globalEnabled = true;
    memorySettings.entries = [
      {
        id: "global-1",
        scope: "global",
        key: "verification-output-style",
        kind: "preference",
        content: "Prefers compact verification output",
        searchTerms: [],
        importance: 4,
        confidence: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    const context = await prepareConversationPromptContext(
      "Create the release build and summarize verification",
      { ...runtimeConfig, workspaceRoot },
      {
        history: [],
        workspace: { selection: "selected", root: workspaceRoot },
        sessionMemory: [
          {
            id: "session-1",
            scope: "session",
            key: "unrelated-database",
            kind: "fact",
            content: "The test database is PostgreSQL",
            searchTerms: [],
            importance: 3,
            confidence: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
        globalMemoryEnabled: true,
      },
    );

    expect(context.promptBlock).toContain("<workspace_memory>");
    expect(context.promptBlock).toContain(
      "The release build uses pnpm package",
    );
    expect(context.promptBlock).toContain("<global_memory>");
    expect(context.promptBlock).toContain(
      "Prefers compact verification output",
    );
    expect(context.promptBlock).not.toContain("Gallery thumbnails");
    expect(context.promptBlock).not.toContain("PostgreSQL");
    expect(context.memory.workspaceEntries).toHaveLength(2);
    expect(context.memory.sessionEntries).toHaveLength(1);
    expect(context.memory.globalEntries).toHaveLength(1);
    expect(context.memoryRetrieval).toMatchObject({
      candidateCount: 4,
      selectedByScope: { session: 0, workspace: 1, global: 1 },
      workspaceLoadFailed: false,
    });
  });

  it("does not load workspace memory when no workspace is selected", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "machdoch-prompt-memory-"),
    );
    workspaceRoots.push(workspaceRoot);
    await rememberWorkspaceMemory(workspaceRoot, "Use pnpm package", {
      key: "package-command",
    });

    const context = await prepareConversationPromptContext(
      "Run the package command",
      { ...runtimeConfig, workspaceRoot },
      {
        history: [],
        workspace: { selection: "not-set" },
        globalMemoryEnabled: false,
      },
    );

    expect(context.promptBlock).toBeUndefined();
    expect(context.memory.workspaceEnabled).toBe(false);
    expect(context.memory.workspaceEntries).toEqual([]);
    expect(context.memoryRetrieval?.candidateCount).toBe(0);
  });
});
