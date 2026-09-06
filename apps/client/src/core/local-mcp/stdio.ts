import { realpath } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { RunMode } from "../runtime-contract.generated.js";
import { resolveWorkspaceMemoryEnabled } from "../memory.js";

const connectStdio = async (
  server: Server,
  cleanup: () => Promise<void>,
): Promise<void> => {
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void server.close();
  };
  process.stdin.once("end", close);
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  server.onclose = () => {
    process.stdin.removeListener("end", close);
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
    void cleanup().catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
  };
  await server.connect(new StdioServerTransport());
};

export const runLocalMcpStdioServer = async (
  workspaceRoot: string,
  mode?: RunMode,
): Promise<void> => {
  const [
    { loadRuntimeConfig, loadWorkspaceConfigFile },
    { loadUserMemorySettings },
    { loadWorkspaceMemory },
    { mcpClientManager },
    { createLocalToolRuntime },
    { createLocalMcpServer },
  ] = await Promise.all([
    import("../config.js"),
    import("../env.js"),
    import("../workspace-memory.js"),
    import("../mcp/client.js"),
    import("./runtime.js"),
    import("./server.js"),
  ]);
  const root = await realpath(workspaceRoot);
  const [config, globalMemory, workspaceConfig] = await Promise.all([
    loadRuntimeConfig(root, mode),
    loadUserMemorySettings(),
    loadWorkspaceConfigFile(root),
  ]);
  const workspaceEnabled = resolveWorkspaceMemoryEnabled(
    globalMemory.workspaceDefaultEnabled,
    workspaceConfig.config.workspaceMemoryEnabled,
  );
  const workspaceEntries = workspaceEnabled
    ? await loadWorkspaceMemory(root)
    : [];
  const lifetime = new AbortController();
  const runtime = createLocalToolRuntime({
    config,
    signal: lifetime.signal,
    memory: {
      sessionEnabled: false,
      sessionEntries: [],
      workspaceEnabled,
      workspaceEntries,
      globalEnabled: globalMemory.globalEnabled,
      globalEntries: globalMemory.globalEnabled ? globalMemory.entries : [],
    },
  });
  await connectStdio(createLocalMcpServer(runtime), async () => {
    lifetime.abort();
    await runtime.waitForIdle();
    await mcpClientManager.closeAll();
  });
};

export const runLocalMcpStdioConnection = async (): Promise<void> => {
  const address = process.env.MACHDOCH_LOCAL_MCP_URL;
  const token = process.env.MACHDOCH_LOCAL_MCP_TOKEN;
  if (!address || !token) {
    throw new Error("The Machdoch run MCP endpoint is missing or invalid.");
  }
  const url = new URL(address);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/mcp" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("The Machdoch run MCP endpoint is missing or invalid.");
  }
  const client = new Client({ name: "machdoch-cli", version: "1.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }) as unknown as Transport,
    );
    const server = new Server(
      { name: "machdoch", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async (request, extra) =>
      client.listTools(request.params, { signal: extra.signal }),
    );
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
      client.callTool(request.params, CallToolResultSchema, {
        signal: extra.signal,
        timeout: 3_600_000,
      }),
    );
    await connectStdio(server, () => client.close());
  } catch (error) {
    await client.close();
    throw error;
  }
};
