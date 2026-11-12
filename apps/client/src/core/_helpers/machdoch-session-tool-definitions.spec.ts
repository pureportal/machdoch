import { createServer, type Server as NetServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeConfig } from "../__test__/ralph-test-helpers.js";
import { createLocalToolRuntime } from "../local-mcp/runtime.js";
import { createLocalMcpServer } from "../local-mcp/server.js";
import type { ConversationMemoryRuntime } from "./agent-tools-shared.js";
import { createToolDefinitions, executeToolCall } from "./agent-tools.js";
import {
  isChatSessionIdle,
  MACHDOCH_AGENT_SESSION_GUIDANCE,
} from "./machdoch-session-tool-definitions.js";

const WRITE_TOOLS = [
  "start_agent_session",
  "send_chat_message",
  "cancel_agent_task",
  "rename_chat_session",
  "archive_chat_session",
];

const memory: ConversationMemoryRuntime = {
  sourceSessionId: "current-chat",
  sessionEnabled: false,
  sessionEntries: [],
  globalEnabled: false,
  globalEntries: [],
};

let root: string;
let desktop: NetServer;
let requests: Record<string, unknown>[];
let respond: (request: Record<string, unknown>) => unknown;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "machdoch-session-tools-"));
  requests = [];
  respond = () => ({ ok: true, result: { result: { accepted: true } } });
  desktop = createServer((socket) => {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.slice(0, input.indexOf("\n")));
      requests.push(request);
      socket.end(`${JSON.stringify(respond(request))}\n`);
    });
  });
  await new Promise<void>((resolve) =>
    desktop.listen(0, "127.0.0.1", resolve),
  );
  const address = desktop.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture endpoint.");
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", join(root, "user"));
  vi.stubEnv("MACHDOCH_RUN_CONTROL_ADDRESS", `127.0.0.1:${address.port}`);
  vi.stubEnv("MACHDOCH_RUN_CONTROL_TOKEN", "fixture-token");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => desktop.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

const setup = (mode: "ask" | "machdoch" = "machdoch") => {
  const config = { ...runtimeConfig, workspaceRoot: root, mode };
  const definitions = createToolDefinitions(config, memory);
  const tools = new Map(definitions.map((tool) => [tool.spec.name, tool]));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const { result } = await executeToolCall(config, memory, undefined, tools, {
      id: "call",
      name,
      arguments: args,
    });
    if (!result) throw new Error("Missing tool result.");
    return result.toolResult;
  };
  return { config, definitions, call };
};

const chatState = (
  session: Record<string, unknown>,
  kind = "execution",
): unknown => ({
  ok: true,
  result: {
    session: { id: "other-chat", ...session },
    messages: [{ index: 0, role: "agent", kind, content: "Done." }],
    queuedMessages: [],
  },
});

describe("Machdoch agent session tools", () => {
  it("registers write tools only in Machdoch mode with the desktop bridge", () => {
    const names = setup().definitions.map((tool) => tool.spec.name);
    expect(names).toEqual(
      expect.arrayContaining([...WRITE_TOOLS, "wait_for_chat_session"]),
    );
    const askNames = setup("ask").definitions.map((tool) => tool.spec.name);
    expect(askNames).toContain("wait_for_chat_session");
    for (const name of WRITE_TOOLS) expect(askNames).not.toContain(name);
    vi.stubEnv("MACHDOCH_RUN_CONTROL_TOKEN", "");
    const unavailable = setup().definitions.map((tool) => tool.spec.name);
    for (const name of [...WRITE_TOOLS, "wait_for_chat_session"])
      expect(unavailable).not.toContain(name);
  });

  it("starts a background chat in this workspace through app control", async () => {
    respond = () => ({
      ok: true,
      result: {
        result: { sessionId: "new-chat", taskId: "task-1" },
        location: [],
      },
    });
    const result = await setup().call("start_agent_session", {
      prompt: "Run the tests.",
      title: "Tests",
      mode: "ask",
    });
    expect(result.isError, result.output).not.toBe(true);
    expect(JSON.parse(result.output)).toEqual({
      sessionId: "new-chat",
      taskId: "task-1",
    });
    expect(requests).toEqual([
      {
        token: "fixture-token",
        action: "appControl",
        workspaceRoot: root,
        appControl: {
          kind: "run",
          actionId: "agents.start_session",
          input: {
            workspace: root,
            prompt: "Run the tests.",
            title: "Tests",
            mode: "ask",
          },
          mode: "machdoch",
        },
      },
    ]);
  });

  it("forwards messages, cancellation, renaming, and archiving to other chats", async () => {
    const { call } = setup();
    for (const [name, args, actionId, input] of [
      [
        "send_chat_message",
        { sessionId: "other-chat", message: "Continue.", whenBusy: "steer" },
        "agents.send_message",
        { sessionId: "other-chat", prompt: "Continue.", whenBusy: "steer" },
      ],
      [
        "cancel_agent_task",
        { sessionId: "other-chat" },
        "agents.cancel_task",
        { sessionId: "other-chat" },
      ],
      [
        "rename_chat_session",
        { sessionId: "other-chat", title: "Renamed" },
        "agents.rename_session",
        { sessionId: "other-chat", title: "Renamed" },
      ],
      [
        "archive_chat_session",
        { sessionId: "other-chat" },
        "agents.archive_session",
        { sessionId: "other-chat" },
      ],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError, result.output).not.toBe(true);
      expect(JSON.parse(result.output)).toEqual({ accepted: true });
      expect(requests.at(-1)?.appControl).toEqual({
        kind: "run",
        actionId,
        input,
        mode: "machdoch",
      });
    }
  });

  it("refuses to steer, wait for, cancel, or archive the current chat", async () => {
    const { call } = setup();
    for (const [name, args] of [
      ["send_chat_message", { sessionId: "current-chat", message: "Hi." }],
      ["wait_for_chat_session", { sessionId: "current-chat" }],
      ["cancel_agent_task", { sessionId: "current-chat" }],
      ["archive_chat_session", { sessionId: "current-chat" }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError).toBe(true);
      expect(result.output).toContain("This is the current chat.");
    }
    expect(requests).toEqual([]);
  });

  it("reports desktop errors as tool errors", async () => {
    respond = () => ({
      ok: false,
      error: "The Machdoch window is not open yet. Retry in a moment.",
    });
    const result = await setup().call("start_agent_session", {
      prompt: "Go.",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("The Machdoch window is not open yet.");
  });

  it("waits until another chat is idle", async () => {
    let reads = 0;
    respond = () =>
      ++reads === 1
        ? chatState({ activeTaskIds: ["task-1"] }, "thinking")
        : chatState({});
    const result = await setup("ask").call("wait_for_chat_session", {
      sessionId: "other-chat",
      timeoutSeconds: 30,
    });
    expect(result.isError, result.output).not.toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({
      idle: true,
      session: { id: "other-chat" },
      messages: [{ content: "Done." }],
    });
    expect(requests.at(-1)).toMatchObject({
      action: "readState",
      query: { kind: "readChatSession", sessionId: "other-chat", limit: 3 },
    });
  });

  it("returns the latest state when the wait times out", async () => {
    respond = () => chatState({ queuedMessageCount: 1 });
    const result = await setup().call("wait_for_chat_session", {
      sessionId: "other-chat",
      timeoutSeconds: 1,
    });
    expect(result.isError, result.output).not.toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({
      idle: false,
      session: { queuedMessageCount: 1 },
    });
  });

  it("detects idle chats from tasks, queued messages, and placeholders", () => {
    const state = (session: Record<string, unknown>, kind?: string) => ({
      session,
      messages: kind ? [{ kind }] : [],
    });
    expect(isChatSessionIdle(state({}))).toBe(true);
    expect(isChatSessionIdle(state({}, "execution"))).toBe(true);
    expect(isChatSessionIdle(state({ activeTaskIds: ["task"] }))).toBe(false);
    expect(isChatSessionIdle(state({ queuedMessageCount: 2 }))).toBe(false);
    expect(isChatSessionIdle(state({}, "thinking"))).toBe(false);
    expect(isChatSessionIdle({ messages: [] })).toBe(false);
    expect(isChatSessionIdle(null)).toBe(false);
  });

  it("describes delegation in the MCP instructions only when it is available", async () => {
    const connect = async (mode: "ask" | "machdoch") => {
      const runtime = createLocalToolRuntime({
        config: { ...runtimeConfig, workspaceRoot: root, mode },
        memory,
      });
      const server = createLocalMcpServer(runtime);
      const client = new Client({ name: "session-tools-test", version: "1" });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const instructions = client.getInstructions();
      await client.close();
      await server.close();
      return instructions;
    };
    expect(await connect("machdoch")).toContain(
      MACHDOCH_AGENT_SESSION_GUIDANCE,
    );
    expect(await connect("ask")).not.toContain(
      MACHDOCH_AGENT_SESSION_GUIDANCE,
    );
  });
});
