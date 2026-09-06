import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeConfig } from "../__test__/ralph-test-helpers.js";
import type {
  AgentToolDefinition,
  ConversationMemoryRuntime,
} from "../_helpers/agent-tools-shared.js";
import { startLocalMcpHost } from "./http.js";

let root: string;
const cleanup: Array<() => Promise<void>> = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "machdoch-mcp-http-"));
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", join(root, "user"));
  vi.stubEnv("MACHDOCH_RUN_CONTROL_TOKEN", "");
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const start = async (additionalToolDefinitions: AgentToolDefinition[] = []) => {
  const memory: ConversationMemoryRuntime = {
    sessionEnabled: true,
    sessionEntries: [],
    globalEnabled: false,
    globalEntries: [],
  };
  const onResult = vi.fn();
  const host = await startLocalMcpHost({
    config: { ...runtimeConfig, workspaceRoot: root },
    memory,
    additionalToolDefinitions,
    onResult,
  });
  cleanup.push(host.close);
  const client = new Client({ name: "http-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(host.endpoint.url), {
      requestInit: {
        headers: { Authorization: `Bearer ${host.endpoint.token}` },
      },
    }) as unknown as Transport,
  );
  cleanup.push(() => client.close());
  return { host, client, memory, onResult };
};

describe("Machdoch run MCP endpoint", () => {
  it("requires its run token and rejects browser origins and foreign hosts", async () => {
    const { host, client } = await start();
    expect((await fetch(host.endpoint.url)).status).toBe(401);
    expect(
      (
        await fetch(host.endpoint.url, {
          headers: { Authorization: "Bearer invalid" },
        })
      ).status,
    ).toBe(401);
    const headers = { Authorization: `Bearer ${host.endpoint.token}` };
    expect(
      (
        await fetch(host.endpoint.url, {
          headers: { ...headers, Origin: "http://example.com" },
        })
      ).status,
    ).toBe(403);
    const foreignHostStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        get(
          host.endpoint.url,
          { headers: { ...headers, Host: "example.com" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        ).on("error", reject);
      },
    );
    expect(foreignHostStatus).toBe(403);
    expect(
      (await fetch(host.endpoint.url.replace("/mcp", "/other"), { headers }))
        .status,
    ).toBe(404);
    expect(
      (await client.listTools()).tools.some(
        (tool) => tool.name === "list_workflows",
      ),
    ).toBe(true);
    const result = await client.callTool({
      name: "remember_session_memory",
      arguments: {
        fact: "Use focused checks.",
        memory_key: "checks",
        kind: "preference",
        search_terms: [],
        importance: 3,
        sensitivity: "non-sensitive",
      },
    });
    expect(result.isError).not.toBe(true);
    const search = await client.callTool({
      name: "search_memory",
      arguments: { scope: "session" },
    });
    expect(JSON.stringify(search)).toContain("Use focused checks.");
  });

  it("returns parent memory updates and image content without losing their types", async () => {
    const imageTool: AgentToolDefinition = {
      spec: {
        name: "fixture_image",
        description: "Test image",
        inputSchema: { type: "object", additionalProperties: false },
      },
      backingTool: "browser",
      effect: "read",
      riskLevel: "low",
      execute: async () => ({
        toolResult: {
          callId: "",
          name: "fixture_image",
          output: "Image",
          content: [
            { type: "text", text: "Image" },
            { type: "image", mediaType: "image/png", data: "aW1hZ2U=" },
          ],
        },
        sections: [],
        traceLines: [],
      }),
    };
    const { client, memory, onResult } = await start([imageTool]);
    await client.callTool({
      name: "remember_session_memory",
      arguments: {
        fact: "Use focused checks.",
        memory_key: "checks",
        kind: "preference",
        search_terms: [],
        importance: 3,
        sensitivity: "non-sensitive",
      },
    });
    expect(memory.sessionEntries).toHaveLength(1);
    expect(onResult.mock.calls[0]?.[1].memoryUpdate).toMatchObject({
      scope: "session",
      entry: { key: "checks" },
    });
    const result = await client.callTool({
      name: "fixture_image",
      arguments: {},
    });
    expect(result.content).toEqual([
      { type: "text", text: "Image" },
      { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
    ]);
  });

  it("cancels an active tool when its MCP request is cancelled", async () => {
    let entered = false;
    let cancelled = false;
    const waiting: AgentToolDefinition = {
      spec: {
        name: "fixture_wait",
        description: "Wait",
        inputSchema: { type: "object" },
      },
      backingTool: "utilities",
      effect: "read",
      riskLevel: "low",
      execute: async (_args, context) => {
        entered = true;
        return new Promise((_resolve, reject) =>
          context.signal?.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(new Error("Cancelled"));
            },
            { once: true },
          ),
        );
      },
    };
    const { client } = await start([waiting]);
    const controller = new AbortController();
    const call = client.callTool(
      { name: "fixture_wait", arguments: {} },
      undefined,
      { signal: controller.signal },
    );
    const rejection = expect(call).rejects.toThrow();
    await vi.waitFor(() => expect(entered).toBe(true));
    controller.abort();
    await rejection;
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });
});
