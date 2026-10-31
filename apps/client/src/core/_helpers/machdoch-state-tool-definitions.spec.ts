import { createServer, type Server as NetServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeConfig } from "../__test__/ralph-test-helpers.js";
import { cloudTaskToolPolicy } from "../cloud/tool-policy.js";
import { createLocalToolRuntime } from "../local-mcp/runtime.js";
import { createLocalMcpServer } from "../local-mcp/server.js";
import type { ConversationMemoryRuntime } from "./agent-tools-shared.js";
import { createToolDefinitions, executeToolCall } from "./agent-tools.js";

const STATE_TOOLS = [
  "get_machdoch_state",
  "list_chat_sessions",
  "read_chat_session",
  "read_chat_activity",
  "read_agent_activity",
  "read_terminal_output",
  "read_workspace_run_logs",
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
  root = await mkdtemp(join(tmpdir(), "machdoch-state-tools-"));
  requests = [];
  respond = (request) => ({ ok: true, result: { echoed: request.query } });
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
  vi.stubEnv("MACHDOCH_DESKTOP_TASK_ID", "task-7");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => desktop.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

const setup = (mode: "ask" | "machdoch" = "ask") => {
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

describe("Machdoch state tools", () => {
  it("registers read-only tools only when the desktop bridge is available", () => {
    expect(
      setup().definitions.map((tool) => tool.spec.name),
    ).toEqual(expect.arrayContaining(STATE_TOOLS));
    for (const tool of setup().definitions) {
      if (STATE_TOOLS.includes(tool.spec.name)) {
        expect(tool.effect).toBe("read");
        expect(cloudTaskToolPolicy(tool)).toBe(false);
      }
    }
    vi.stubEnv("MACHDOCH_RUN_CONTROL_TOKEN", "");
    const names = setup().definitions.map((tool) => tool.spec.name);
    for (const name of STATE_TOOLS) expect(names).not.toContain(name);
  });

  it("adds the current run to the overview", async () => {
    respond = () => ({
      ok: true,
      result: { activeAgents: [], workspaces: [], terminals: [] },
    });
    const { call } = setup();
    const result = await call("get_machdoch_state");
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.output)).toEqual({
      current: {
        workspaceRoot: root,
        taskId: "task-7",
        sessionId: "current-chat",
        mode: "ask",
      },
      activeAgents: [],
      workspaces: [],
      terminals: [],
    });
    expect(requests[0]).toEqual({
      token: "fixture-token",
      action: "readState",
      workspaceRoot: root,
      query: { kind: "overview" },
    });
  });

  it("sends strict query shapes and defaults chat reads to the current chat", async () => {
    const { call } = setup();
    const cases: [string, Record<string, unknown>, Record<string, unknown>][] =
      [
        [
          "list_chat_sessions",
          { workspaceRoot: "C:/Work", query: "login", includeArchived: true },
          {
            kind: "listChatSessions",
            workspaceRoot: "C:/Work",
            query: "login",
            includeArchived: true,
          },
        ],
        [
          "read_chat_session",
          { startIndex: 2, limit: 5, offset: 10 },
          {
            kind: "readChatSession",
            sessionId: "current-chat",
            startIndex: 2,
            limit: 5,
            offset: 10,
          },
        ],
        [
          "read_chat_session",
          { sessionId: "other-chat" },
          { kind: "readChatSession", sessionId: "other-chat" },
        ],
        [
          "read_chat_activity",
          { messageIndex: 3 },
          {
            kind: "readChatActivity",
            sessionId: "current-chat",
            messageIndex: 3,
          },
        ],
        [
          "read_agent_activity",
          { taskId: "task-9", since: 100, limit: 20 },
          { kind: "readAgentActivity", taskId: "task-9", since: 100, limit: 20 },
        ],
        [
          "read_terminal_output",
          { terminalId: "terminal-1", tailLines: 50 },
          {
            kind: "readTerminalOutput",
            terminalId: "terminal-1",
            tailLines: 50,
          },
        ],
        [
          "read_workspace_run_logs",
          { configurationId: "api", stream: "stderr", query: "error" },
          {
            kind: "readRunLogs",
            configurationId: "api",
            stream: "stderr",
            query: "error",
          },
        ],
      ];
    for (const [name, args, query] of cases) {
      const result = await call(name, args);
      expect(result.isError, result.output).not.toBe(true);
      expect(requests.at(-1)?.query).toEqual(query);
    }
  });

  it("rejects invalid arguments before reaching the desktop bridge", async () => {
    const { call } = setup();
    for (const [name, args] of [
      ["read_terminal_output", {}],
      ["read_chat_activity", {}],
      ["read_agent_activity", {}],
      ["read_agent_activity", { taskId: "task-9", limit: 201 }],
      ["read_chat_session", { limit: 51 }],
      ["read_workspace_run_logs", { stream: "secrets" }],
      ["get_machdoch_state", { sessionId: "x" }],
    ] as const) {
      expect((await call(name, args)).isError, name).toBe(true);
    }
    expect(requests).toEqual([]);
  });

  it("reports desktop failures as tool errors", async () => {
    respond = () => ({ ok: false, error: "This terminal is no longer running." });
    const result = await setup().call("read_terminal_output", {
      terminalId: "gone",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toBe("This terminal is no longer running.");
  });

  it("requires a session id outside a chat", async () => {
    const config = { ...runtimeConfig, workspaceRoot: root, mode: "ask" as const };
    const standalone = { ...memory };
    delete standalone.sourceSessionId;
    const tools = new Map(
      createToolDefinitions(config, standalone).map((tool) => [
        tool.spec.name,
        tool,
      ]),
    );
    const { result } = await executeToolCall(
      config,
      standalone,
      undefined,
      tools,
      { id: "call", name: "read_chat_session", arguments: {} },
    );
    expect(result?.toolResult.isError).toBe(true);
    expect(requests).toEqual([]);
  });

  it("publishes guidance and accurate annotations through MCP", async () => {
    const { config } = setup("machdoch");
    const server = createLocalMcpServer(
      createLocalToolRuntime({ config, memory }),
    );
    const client = new Client({ name: "state-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expect(client.getInstructions()).toContain("get_machdoch_state");
      const catalog = (await client.listTools()).tools;
      const state = catalog.find((tool) => tool.name === "get_machdoch_state");
      expect(state?.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(state).not.toHaveProperty("strict");
      const write = catalog.find((tool) => tool.name === "create_file");
      expect(write?.annotations?.readOnlyHint).toBe(false);
      expect(write?.annotations).not.toHaveProperty("destructiveHint");
      const called = CallToolResultSchema.parse(
        await client.callTool({
          name: "read_terminal_output",
          arguments: { terminalId: "terminal-1" },
        }),
      );
      expect(called.isError).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
