import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentModelToolSpec } from "@machdoch/model-runtime/types";
import { connectorToolName } from "../../../lib/agent-personalization";

export const maximumConnectorToolBytes = 32_000;
const requestTimeoutMs = 15_000;
const callTimeoutMs = 60_000;
const maximumOutputCharacters = 12_000;
const maximumDescriptionCharacters = 1_000;

const privateRanges = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const)
  privateRanges.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 127],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  privateRanges.addSubnet(network, prefix, "ipv6");

export function publicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(address);
  if (mapped) return publicAddress(mapped[1]!);
  const family = isIP(address);
  if (!family) return false;
  return !privateRanges.check(address, family === 4 ? "ipv4" : "ipv6");
}

export interface McpConnectorTarget {
  name: string;
  url: string;
  token: string | null;
}

export type McpConnect = (connector: McpConnectorTarget) => Promise<Client>;

export async function connectMcp(
  connector: McpConnectorTarget,
): Promise<Client> {
  const url = new URL(connector.url);
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/gu, ""), {
    all: true,
  });
  if (
    !addresses.length ||
    addresses.some((entry) => !publicAddress(entry.address))
  )
    throw new Error(`${url.hostname} does not resolve to a public address.`);
  const client = new Client({ name: "machdoch-cloud", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: {
        redirect: "error",
        headers: connector.token
          ? { authorization: `Bearer ${connector.token}` }
          : {},
      },
    }),
    { timeout: requestTimeoutMs },
  );
  return client;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function toolOutput(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const parts = content.map((item: { type: string; text?: unknown }) =>
    item.type === "text" && typeof item.text === "string"
      ? item.text
      : `[${item.type}]`,
  );
  const text =
    parts.length || result.structuredContent === undefined
      ? parts.join("\n")
      : JSON.stringify(result.structuredContent);
  return text.length > maximumOutputCharacters
    ? `${text.slice(0, maximumOutputCharacters)}… (truncated)`
    : text;
}

interface ConnectorRoute {
  client: Client;
  connector: string;
  tool: string;
}

export class AgentConnectorTools {
  private constructor(
    readonly specs: AgentModelToolSpec[],
    private readonly routes: Map<string, ConnectorRoute>,
    private readonly clients: Client[],
  ) {}

  static async open(
    connectors: McpConnectorTarget[],
    connect: McpConnect,
  ): Promise<AgentConnectorTools> {
    const specs: AgentModelToolSpec[] = [];
    const routes = new Map<string, ConnectorRoute>();
    const clients: Client[] = [];
    let bytes = 0;
    for (const connector of connectors) {
      let client: Client | undefined;
      let tools: Awaited<ReturnType<Client["listTools"]>>["tools"];
      try {
        client = await connect(connector);
        tools = (
          await client.listTools(undefined, { timeout: requestTimeoutMs })
        ).tools;
      } catch (error) {
        await client?.close();
        console.error(
          `MCP connector ${connector.name} is unavailable`,
          errorText(error),
        );
        continue;
      }
      clients.push(client);
      for (const tool of tools) {
        const name = connectorToolName(connector.name, tool.name);
        if (!name || routes.has(name)) continue;
        const spec: AgentModelToolSpec = {
          name,
          description: `${(tool.description ?? tool.title ?? tool.name).slice(0, maximumDescriptionCharacters)} (MCP connector ${connector.name})`,
          inputSchema: tool.inputSchema as Record<string, unknown>,
        };
        const size = Buffer.byteLength(JSON.stringify(spec), "utf8");
        if (bytes + size > maximumConnectorToolBytes) continue;
        bytes += size;
        specs.push(spec);
        routes.set(name, {
          client,
          connector: connector.name,
          tool: tool.name,
        });
      }
    }
    return new AgentConnectorTools(specs, routes, clients);
  }

  has(name: string): boolean {
    return this.routes.has(name);
  }

  async call(
    name: string,
    input: unknown,
  ): Promise<{ output: string; isError: boolean; label: string }> {
    const route = this.routes.get(name)!;
    try {
      const result = await route.client.callTool(
        {
          name: route.tool,
          arguments:
            input && typeof input === "object"
              ? (input as Record<string, unknown>)
              : {},
        },
        undefined,
        { timeout: callTimeoutMs },
      );
      const failed = result.isError === true;
      return {
        output: toolOutput(result),
        isError: failed,
        label: `${failed ? "Failed" : "Used"} ${route.connector} ${route.tool}`,
      };
    } catch (error) {
      return {
        output: JSON.stringify({ error: errorText(error) }),
        isError: true,
        label: `${route.connector} ${route.tool} failed`,
      };
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.clients.map((client) => client.close()));
  }
}
