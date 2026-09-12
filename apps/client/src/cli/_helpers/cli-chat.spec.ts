import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../../core/runtime-contract.generated.js";
import type { TaskExecutionResult } from "../../core/types.js";
import { loadRuntimeConfig } from "../../core/config.js";
import { runInteractiveChat } from "./cli-chat.js";
import type { ChatInput, ChatLine } from "./cli-chat-input.js";
import { parseCliArgs } from "./cli-args.js";
import * as chatSessions from "./cli-chat-sessions.js";
import {
  createChatSession,
  listChatSessions,
  loadChatSession,
  parseConversationContext,
  saveChatSession,
} from "./cli-chat-sessions.js";
import type { printTaskPreview } from "./cli-task-run.js";
import { resolveConversationContext } from "./cli-task-run.js";
import {
  rememberWorkspaceMemory,
  loadWorkspaceMemory,
} from "../../core/workspace-memory.js";
import {
  rememberUserGlobalMemory,
  loadUserMemorySettings,
} from "../../core/env.js";
import { printMemorySummary } from "./cli-summary-commands.js";

vi.mock("../../core/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/config.js")>()),
  loadRuntimeConfig: vi.fn(),
}));

const menuMocks = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("./cli-prompter.js", () => ({
  createTerminalPrompter: () => ({
    select: menuMocks.select,
    input: vi.fn(),
    status: vi.fn(),
    close: vi.fn(),
  }),
}));

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "machdoch-chat-tests-"));
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", join(workspace, "config"));
  menuMocks.select.mockReset();
  vi.mocked(loadRuntimeConfig).mockImplementation(
    async (root, mode, model, provider, _limits, reasoning) => {
      if (model === "bad-model") throw new Error("Model is unavailable.");
      return {
        workspaceRoot: root,
        mode: mode ?? "machdoch",
        provider: provider ?? "openai",
        model: model ?? "gpt-5.5",
        reasoning: reasoning ?? "default",
        providerAvailability: [{ provider: "openai", configured: true }],
      } as unknown as RuntimeConfig;
    },
  );
});
afterEach(async () => {
  process.exitCode = 0;
  await rm(workspace, { recursive: true, force: true });
});

const result = (task: string): { execution: TaskExecutionResult } => ({
  execution: {
    task,
    mode: "machdoch",
    status: "executed",
    summary: `Done: ${task}`,
    outputSections: [],
    executedTools: [],
  },
});

const runChat = async (
  commands: (string | ChatLine)[],
  executeTask: typeof printTaskPreview = vi.fn(async (args) =>
    result(args.task!),
  ),
  initialArgs: string[] = [],
) => {
  const input: ChatInput = {
    readLine: vi.fn(async () => {
      const line = commands.shift();
      return typeof line === "string" ? { text: line } : line;
    }),
    setBusy: vi.fn(),
    suspend: async (action) => await action(),
    close: vi.fn(),
  };
  const lines: string[] = [];
  await runInteractiveChat(
    parseCliArgs(["chat", ...initialArgs], {
      currentWorkingDirectory: workspace,
    }),
    { input, executeTask, write: (line) => lines.push(line) },
  );
  return { input, lines, executeTask };
};

describe("interactive chat workflows", () => {
  it("rejects unknown commands, changes runtime controls, and continues after task errors", async () => {
    const executeTask = vi
      .fn<typeof printTaskPreview>()
      .mockRejectedValueOnce(new Error("Connection failed."))
      .mockImplementation(async (args) => result(args.task!));
    const { lines, input } = await runChat(
      [
        "/missing",
        "/mode ask",
        "/model bad-model",
        "Try this",
        "/model openai gpt-5.5",
        "/retry",
        "/status",
        "/exit",
      ],
      executeTask,
    );
    expect(executeTask).toHaveBeenCalledTimes(2);
    expect(executeTask.mock.calls[1]?.[0]).toMatchObject({
      task: "Try this",
      mode: "ask",
      model: "gpt-5.5",
      runtimeProvider: "openai",
    });
    expect(lines.join("\n")).toContain("Unknown command /missing");
    expect(lines.join("\n")).toContain("Model is unavailable.");
    expect(lines.join("\n")).toContain("Connection failed.");
    expect(input.close).toHaveBeenCalledOnce();
    const { sessions } = await listChatSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.context.history).toHaveLength(2);
    expect(sessions[0]?.context.sessionId).toBe(sessions[0]?.id);
  });

  it("consumes attachments after success and restores them for explicit retry", async () => {
    await writeFile(join(workspace, "file one.txt"), "context");
    const executeTask = vi.fn<typeof printTaskPreview>(async (args) =>
      result(args.task!),
    );
    await runChat(
      [
        ' /attach "file one.txt"',
        "First task",
        "Second task",
        "/attach missing.txt",
        "/attach file-one-does-not-exist",
        "/exit",
      ],
      executeTask,
    );
    expect(executeTask.mock.calls[0]?.[0].contextPaths).toEqual([
      join(workspace, "file one.txt"),
    ]);
    expect(executeTask.mock.calls[1]?.[0].contextPaths).toBeUndefined();
    expect(executeTask).toHaveBeenCalledTimes(2);
    const retryTask = vi.fn<typeof printTaskPreview>(async (args) =>
      result(args.task!),
    );
    await runChat(
      ['/attach "file one.txt"', "First", "/retry", "/exit"],
      retryTask,
    );
    expect(retryTask.mock.calls[1]?.[0].contextPaths).toEqual([
      join(workspace, "file one.txt"),
    ]);
  });

  it("keeps memory overrides and resets conversation context for a new session", async () => {
    const executeTask = vi.fn<typeof printTaskPreview>(async (args) =>
      result(args.task!),
    );
    await runChat(
      [
        "/memory workspace off",
        "/memory global on",
        "Remember",
        "/new",
        "New task",
        "/exit",
      ],
      executeTask,
    );
    expect(executeTask.mock.calls[0]?.[1]?.conversationContext).toMatchObject({
      workspaceMemoryEnabled: false,
      globalMemoryEnabled: true,
    });
    expect(
      executeTask.mock.calls[1]?.[1]?.conversationContext?.history,
    ).toEqual([]);
    expect(
      executeTask.mock.calls[1]?.[1]?.conversationContext
        ?.workspaceMemoryEnabled,
    ).toBeUndefined();
    expect((await listChatSessions()).sessions).toHaveLength(2);
  });

  it("reads multiline tasks, cancels paste, and sends escaped slash text literally", async () => {
    const executeTask = vi.fn<typeof printTaskPreview>(async (args) =>
      result(args.task!),
    );
    await runChat(
      [
        "/paste ask",
        "line one",
        "",
        "line two",
        "/end",
        "/paste",
        "discard this",
        "/cancel",
        "//etc/path",
        { text: "/exit\nmore task text", pasted: true },
        "/exit",
      ],
      executeTask,
    );
    expect(executeTask.mock.calls.map(([args]) => args.task)).toEqual([
      "line one\n\nline two",
      "/etc/path",
      "/exit\nmore task text",
    ]);
    expect(executeTask.mock.calls[0]?.[0].mode).toBe("ask");
  });

  it("exports resumable context without overwriting an existing file", async () => {
    const { lines } = await runChat([
      "Task",
      "/export conversation.json",
      "/export conversation.json",
      "/history Task",
      "/exit",
    ]);
    const exported: unknown = JSON.parse(
      await readFile(join(workspace, "conversation.json"), "utf8"),
    );
    expect(parseConversationContext(exported).history).toHaveLength(2);
    expect(lines.some((line) => line.includes("Choose another filename"))).toBe(
      true,
    );
    const context = await resolveConversationContext({
      conversationContextFile: join(workspace, "conversation.json"),
    });
    expect(context?.sessionId).toBeTruthy();
    expect(context?.history).toHaveLength(2);
    const { sessions } = await listChatSessions();
    expect(await loadChatSession(sessions[0]!.id)).toEqual(sessions[0]);
  });

  it("does not leave a cancellation exit code on an interactive session", async () => {
    const executeTask = vi.fn<typeof printTaskPreview>(async (args) => {
      process.exitCode = 130;
      return {
        execution: { ...result(args.task!).execution, status: "cancelled" },
      };
    });
    process.exitCode = 0;
    await runChat(["Task", "/status", "/exit"], executeTask);
    expect(process.exitCode).toBe(0);
  });

  it("validates imported context before starting a conversation", async () => {
    await writeFile(
      join(workspace, "invalid.json"),
      JSON.stringify({ history: "wrong" }),
    );
    await expect(
      resolveConversationContext({
        conversationContextFile: join(workspace, "invalid.json"),
      }),
    ).rejects.toThrow("history array");
    expect(() =>
      parseConversationContext({
        history: [],
        workspaceMemoryEnabled: "false",
      }),
    ).toThrow("must be a boolean");
    await expect(loadChatSession("../user-config")).rejects.toThrow(
      "Invalid CLI session id",
    );
  });

  it("resumes a selected conversation with its history, model, mode, and memory", async () => {
    await runChat(
      [
        "/model openai gpt-5.5",
        "/mode ask",
        "/memory global off",
        "Original task",
        "/exit",
      ],
      undefined,
      ["--executor-turns", "3"],
    );
    menuMocks.select.mockImplementation(
      async (_title, choices) => choices[0].value,
    );
    const executeTask = vi.fn<typeof printTaskPreview>(async (args) =>
      result(args.task!),
    );
    await runChat(["/sessions Original", "Continue", "/exit"], executeTask);
    expect(executeTask.mock.calls[0]?.[0]).toMatchObject({
      mode: "ask",
      model: "gpt-5.5",
      agentLimits: { executorTurns: 3 },
    });
    expect(executeTask.mock.calls[0]?.[1]?.conversationContext).toMatchObject({
      globalMemoryEnabled: false,
    });
    expect(
      executeTask.mock.calls[0]?.[1]?.conversationContext?.history,
    ).toHaveLength(2);
    expect((await listChatSessions()).sessions).toHaveLength(1);
  });

  it("preserves a conversation in memory and offers export when saving fails", async () => {
    vi.spyOn(chatSessions, "saveChatSession").mockRejectedValue(
      new Error("Disk full"),
    );
    const { lines } = await runChat(["Task", "/export rescued.json"]);
    expect(lines.join("\n")).toContain("Use /export <file> before leaving");
    expect(
      JSON.parse(await readFile(join(workspace, "rescued.json"), "utf8"))
        .history,
    ).toHaveLength(2);
    expect(process.exitCode).not.toBe(1);
  });

  it("reports unsaved changes on EOF when recovery was not exported", async () => {
    vi.spyOn(chatSessions, "saveChatSession").mockRejectedValue(
      new Error("Disk full"),
    );
    const { lines } = await runChat(["Task"]);
    expect(lines).toContain("Conversation has unsaved changes.");
    expect(process.exitCode).toBe(1);
  });

  it("removes durable memory through chat and one-shot commands without hiding other facts", async () => {
    const first = await rememberUserGlobalMemory("First fact");
    await rememberUserGlobalMemory("Second fact");
    const { lines } = await runChat([
      `/forget global ${first.id}`,
      "/memory global",
      "/exit",
    ]);
    expect(lines.some((line) => line.includes("Second fact"))).toBe(true);
    expect((await loadUserMemorySettings()).entries).toHaveLength(1);
    const entry = await rememberWorkspaceMemory(workspace, "Workspace fact");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const args = parseCliArgs(
      ["memory", "forget", "workspace", entry.id, "--json"],
      { currentWorkingDirectory: workspace },
    );
    await printMemorySummary(args);
    expect(await loadWorkspaceMemory(workspace)).toEqual([]);
    await expect(printMemorySummary(args)).rejects.toThrow(
      "Memory fact not found",
    );
  });

  it("rejects conflicting session writes and lists other sessions despite a corrupt file", async () => {
    const session = createChatSession(workspace, {
      history: [{ role: "user", content: "First" }],
    });
    await saveChatSession(session);
    const stale = await loadChatSession(session.id);
    await saveChatSession(session);
    await expect(saveChatSession(stale)).rejects.toThrow(
      "changed in another terminal",
    );
    expect((await loadChatSession(session.id)).revision).toBe(2);
    await writeFile(
      join(workspace, "config", "cli-sessions", "broken.json"),
      "broken",
    );
    const listing = await listChatSessions();
    expect(listing.sessions).toHaveLength(1);
    expect(listing.errors).toHaveLength(1);
  });
});
