import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { reconcileProviderSync } from "../provider-enrollment/sync-coordinator.js";
import { McpClientManager } from "./client.js";
import { loadMcpConfig, loadMcpDiscoveryCache } from "./config.js";
import { ManagedMcpStdioTransport } from "./stdio-transport.js";

let root: string;
const cleanup: Array<() => Promise<void>> = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "machdoch-transport-refresh-"));
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", join(root, "user"));
  vi.stubEnv("CODEX_HOME", join(root, "codex"));
  await mkdir(join(root, "user"));
  await writeFile(
    join(root, "user", "user-config.json"),
    JSON.stringify({
      agentCliPaths: { "codex-cli": process.execPath },
      providerEnrollment: {
        schemaVersion: 1,
        enabled: true,
        persistentSync: { enabled: true, watch: false, daemonAtLogin: false },
        providers: {
          "codex-cli": { enabled: true },
          "claude-cli": { enabled: false },
          "copilot-cli": { enabled: false },
        },
      },
    }),
  );
});

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const startHttpFixture = async (toolName: string) => {
  const servers = new Set<Server>();
  const errors: unknown[] = [];
  const http = createServer(async (request, response) => {
    const server = new Server(
      { name: toolName, version: "1" },
      { capabilities: { tools: {} } },
    );
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    servers.add(server);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: toolName, inputSchema: { type: "object" } }],
    }));
    try {
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      errors.push(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  cleanup.push(async () => {
    await Promise.all([...servers].map((server) => server.close()));
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      http.close((error) => (error ? reject(error) : resolve()));
    });
    expect(errors).toEqual([]);
  });
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("Expected a TCP address.");
  return `http://127.0.0.1:${address.port}/mcp`;
};

it("uses saved HTTP settings after sync, URL changes, reconnect, and a new runtime", async () => {
  const firstUrl = await startHttpFixture("first_endpoint");
  const secondUrl = await startHttpFixture("second_endpoint");
  const stdioStart = vi
    .spyOn(ManagedMcpStdioTransport.prototype, "start")
    .mockRejectedValue(new Error("Unexpected stdio launch"));
  const manager = new McpClientManager();
  cleanup.push(() => manager.closeAll());
  const configPath = join(root, "user", "mcp.json");
  const oldCommand = { command: "npx", args: ["mcp-add"] };
  const saveTransport = async (transport: Record<string, unknown>) => {
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        defaults: { idleShutdownMs: 0 },
        servers: [{ id: "blockbench", enabled: true, transport }],
      }),
    );
  };
  await saveTransport({ type: "stdio", ...oldCommand });
  await reconcileProviderSync(root);
  expect(await readFile(join(root, "codex", "config.toml"), "utf8")).toContain(
    "mcp-add",
  );

  await saveTransport({
    type: "streamable-http",
    url: firstUrl,
    ...oldCommand,
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const status = await reconcileProviderSync(root);
    expect(
      status.targets.filter((target) => target.provider === "codex-cli"),
    ).toEqual([
      expect.objectContaining({ scope: "user", state: "filesystem-current" }),
      expect.objectContaining({
        scope: "workspace",
        state: "filesystem-current",
      }),
    ]);
    const synced = await readFile(join(root, "codex", "config.toml"), "utf8");
    expect(synced).toContain(firstUrl);
    expect(synced).not.toContain("mcp-add");
    expect(synced).not.toContain("command =");
    expect(
      (await loadMcpConfig(root)).servers.find(
        (server) => server.id === "blockbench",
      )?.transport,
    ).toEqual({ type: "streamable-http", url: firstUrl });
  }
  const first = await manager.discoverServerById(root, "blockbench", {
    persist: true,
  });
  expect(first.discovery.transportType).toBe("streamable-http");
  expect(first.discovery.tools.map((tool) => tool.name)).toEqual([
    "first_endpoint",
  ]);

  await saveTransport({ type: "streamable-http", url: secondUrl });
  const second = await manager.discoverServerById(root, "blockbench", {
    persist: true,
  });
  expect(second.discovery.tools.map((tool) => tool.name)).toEqual([
    "second_endpoint",
  ]);
  await manager.closeServer(root, "blockbench");
  const reconnected = await manager.discoverServerById(root, "blockbench");
  expect(reconnected.discovery.transportType).toBe("streamable-http");
  expect(reconnected.discovery.tools.map((tool) => tool.name)).toEqual([
    "second_endpoint",
  ]);
  expect(manager.listConnections()).toEqual([
    expect.objectContaining({
      serverId: "blockbench",
      transportType: "streamable-http",
    }),
  ]);
  expect(
    (await loadMcpDiscoveryCache(root)).servers.blockbench?.tools.map(
      (tool) => tool.name,
    ),
  ).toEqual(["second_endpoint"]);

  const newRuntime = new McpClientManager();
  cleanup.push(() => newRuntime.closeAll());
  const fresh = await newRuntime.discoverServerById(root, "blockbench");
  expect(fresh.discovery.transportType).toBe("streamable-http");
  expect(fresh.discovery.tools.map((tool) => tool.name)).toEqual([
    "second_endpoint",
  ]);
  expect(stdioStart).not.toHaveBeenCalled();
});
