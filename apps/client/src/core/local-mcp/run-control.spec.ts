import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeConfig } from "../__test__/ralph-test-helpers.js";
import {
  createToolDefinitions,
  executeToolCall,
} from "../_helpers/agent-tools.js";
import { createLocalToolRuntime } from "./runtime.js";
import { createLocalMcpServer } from "./server.js";

afterEach(() => vi.unstubAllEnvs());

describe("workspace run control parity", () => {
  it("uses the same workspace and desktop token for status, start, stop, and restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-run-parity-"));
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", join(root, "user"));
    const requests: Record<string, unknown>[] = [];
    const desktop = createServer((socket) => {
      socket.setEncoding("utf8");
      let input = "";
      socket.on("data", (chunk: string) => {
        input += chunk;
        if (!input.includes("\n")) return;
        const request = JSON.parse(input.slice(0, input.indexOf("\n")));
        requests.push(request);
        socket.end(
          `${JSON.stringify(request.token === "fixture-token" && request.workspaceRoot === root ? { ok: true, result: { action: request.action, workspaceRoot: root, configurationId: request.configurationId ?? null } } : { ok: false, error: "Access denied" })}\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      desktop.once("error", reject);
      desktop.listen(0, "127.0.0.1", resolve);
    });
    const address = desktop.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture endpoint.");
    vi.stubEnv("MACHDOCH_RUN_CONTROL_ADDRESS", `127.0.0.1:${address.port}`);
    vi.stubEnv("MACHDOCH_RUN_CONTROL_TOKEN", "fixture-token");
    const config = { ...runtimeConfig, workspaceRoot: root };
    const memory = {
      sessionEnabled: false,
      sessionEntries: [],
      globalEnabled: false,
      globalEntries: [],
    };
    const definitions = createToolDefinitions(config, memory);
    const apiTools = new Map(definitions.map((tool) => [tool.spec.name, tool]));
    const server = createLocalMcpServer(
      createLocalToolRuntime({ config, memory }),
    );
    const client = new Client({ name: "run-control-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const operations = [
        "get_workspace_run_status",
        "start_workspace_run",
        "stop_workspace_run",
        "restart_workspace_run",
      ];
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(operations),
      );
      for (const name of operations) {
        const args =
          name === "get_workspace_run_status"
            ? {}
            : { configurationId: "fixture" };
        const api = await executeToolCall(config, memory, undefined, apiTools, {
          id: "api",
          name,
          arguments: args,
        });
        const mcp = CallToolResultSchema.parse(
          await client.callTool({ name, arguments: args }),
        );
        expect(mcp.isError).not.toBe(true);
        expect(mcp.content).toEqual([
          { type: "text", text: api.result?.toolResult.output },
        ]);
      }
      expect(requests).toHaveLength(8);
      expect(
        requests.every(
          (request) =>
            request.workspaceRoot === root && request.token === "fixture-token",
        ),
      ).toBe(true);
      const ask = createToolDefinitions({ ...config, mode: "ask" }, memory).map(
        (tool) => tool.spec.name,
      );
      expect(ask).toContain("get_workspace_run_status");
      expect(ask).not.toContain("start_workspace_run");
      vi.stubEnv("MACHDOCH_RUN_CONTROL_TOKEN", "invalid-token");
      expect(
        (
          await client.callTool({
            name: "get_workspace_run_status",
            arguments: {},
          })
        ).isError,
      ).toBe(true);
    } finally {
      await client.close();
      await server.close();
      await new Promise<void>((resolve, reject) =>
        desktop.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    }
  });
});
