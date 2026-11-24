import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AgentConnectorTools,
  connectMcp,
  publicAddress,
  type McpConnectorTarget,
} from "./agent-connectors";
import { instructionsSection } from "./agent-instructions";

async function client(register: (server: McpServer) => void): Promise<Client> {
  const server = new McpServer({ name: "fixture", version: "1.0.0" });
  register(server);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const connected = new Client({ name: "test", version: "1.0.0" });
  await connected.connect(clientTransport);
  return connected;
}

describe("publicAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "64:ff9b::a00:1",
    "not-an-address",
  ])("rejects %s", (address) => {
    expect(publicAddress(address)).toBe(false);
  });

  it.each(["93.184.216.34", "2606:4700::1111", "::ffff:8.8.8.8"])(
    "accepts %s",
    (address) => {
      expect(publicAddress(address)).toBe(true);
    },
  );
});

describe("connectMcp", () => {
  it("refuses hosts that resolve to private addresses", async () => {
    await expect(
      connectMcp({ name: "local", url: "https://127.0.0.1/mcp", token: null }),
    ).rejects.toThrow("127.0.0.1 does not resolve to a public address.");
    await expect(
      connectMcp({ name: "local", url: "https://[::1]/mcp", token: null }),
    ).rejects.toThrow("does not resolve to a public address.");
  });
});

describe("AgentConnectorTools", () => {
  it("exposes prefixed tools, routes calls and skips unavailable connectors", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const targets: McpConnectorTarget[] = [
      { name: "broken", url: "https://broken.example.com", token: null },
      { name: "docs", url: "https://docs.example.com", token: "secret" },
    ];
    const tools = await AgentConnectorTools.open(targets, async (target) => {
      if (target.name === "broken") throw new Error("refused");
      return client((server) => {
        server.registerTool(
          "lookup",
          { description: "Find a page", inputSchema: { topic: z.string() } },
          async ({ topic }) => ({
            content: [{ type: "text", text: `Page ${topic}` }],
          }),
        );
        server.registerTool(
          "fail",
          { description: "Always fails" },
          async () => ({
            isError: true,
            content: [{ type: "text", text: "Nope" }],
          }),
        );
        server.registerTool("huge", { description: "Large" }, async () => ({
          content: [{ type: "text", text: "x".repeat(20_000) }],
        }));
      });
    });
    expect(error).toHaveBeenCalledWith(
      "MCP connector broken is unavailable",
      "refused",
    );
    error.mockRestore();
    expect(tools.specs.map((spec) => [spec.name, spec.description])).toEqual([
      ["mcp_docs_lookup", "Find a page (MCP connector docs)"],
      ["mcp_docs_fail", "Always fails (MCP connector docs)"],
      ["mcp_docs_huge", "Large (MCP connector docs)"],
    ]);
    expect(tools.has("mcp_broken_lookup")).toBe(false);
    expect(await tools.call("mcp_docs_lookup", { topic: "deploys" })).toEqual({
      output: "Page deploys",
      isError: false,
      label: "Used docs lookup",
    });
    expect(await tools.call("mcp_docs_fail", {})).toEqual({
      output: "Nope",
      isError: true,
      label: "Failed docs fail",
    });
    expect((await tools.call("mcp_docs_huge", {})).output).toBe(
      `${"x".repeat(12_000)}… (truncated)`,
    );
    expect((await tools.call("mcp_docs_lookup", {})).isError).toBe(true);
    await tools.close();
  });
});

describe("instructionsSection", () => {
  it("renders only filled instructions in order", () => {
    expect(instructionsSection([{ heading: "Workspace", text: "  " }])).toBe(
      "",
    );
    expect(
      instructionsSection([
        { heading: "Workspace", text: "" },
        { heading: "Team Platform", text: " Link runbooks. " },
        { heading: "Personal", text: "Be brief." },
      ]),
    ).toBe(
      "# Instructions\nFollow these instructions unless they conflict with the rules above.\n\n## Team Platform\nLink runbooks.\n\n## Personal\nBe brief.",
    );
  });
});
