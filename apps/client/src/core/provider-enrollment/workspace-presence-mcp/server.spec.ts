import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspacePresenceMcpServer } from "./server.js";

const originalAddress = process.env.MACHDOCH_RUN_CONTROL_ADDRESS;
const originalToken = process.env.MACHDOCH_WORKSPACE_PRESENCE_TOKEN;

afterEach(() => {
  if (originalAddress === undefined) {
    delete process.env.MACHDOCH_RUN_CONTROL_ADDRESS;
  } else {
    process.env.MACHDOCH_RUN_CONTROL_ADDRESS = originalAddress;
  }
  if (originalToken === undefined) {
    delete process.env.MACHDOCH_WORKSPACE_PRESENCE_TOKEN;
  } else {
    process.env.MACHDOCH_WORKSPACE_PRESENCE_TOKEN = originalToken;
  }
});

describe("workspace presence MCP server", () => {
  it("exposes a read-only query tool and reports an unavailable registry as unknown", async () => {
    delete process.env.MACHDOCH_RUN_CONTROL_ADDRESS;
    delete process.env.MACHDOCH_WORKSPACE_PRESENCE_TOKEN;
    const server = createWorkspacePresenceMcpServer("C:/workspace");
    const client = new Client({ name: "presence-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toEqual([
        expect.objectContaining({
          name: "get_active_workspace_agents",
          annotations: expect.objectContaining({
            readOnlyHint: true,
            destructiveHint: false,
          }),
        }),
      ]);

      const result = await client.callTool({
        name: "get_active_workspace_agents",
        arguments: {},
      });
      if (!("content" in result)) throw new Error("Expected MCP tool content.");
      expect(result.structuredContent).toEqual({ status: "unknown" });
      expect(result.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({ status: "unknown" }, null, 2),
        },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
