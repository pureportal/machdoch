import {
  compareMcpDiscoveries,
  createMcpMetadataHash,
  enrichMcpDiscoveryMetadata,
} from "./discovery-metadata.ts";
import type { McpServerDiscovery } from "./types.ts";

describe("MCP discovery metadata", () => {
  it("creates stable hashes independent of object key order", () => {
    expect(createMcpMetadataHash({ b: 2, a: { d: 4, c: 3 } })).toBe(
      createMcpMetadataHash({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  it("adds catalog, capability, and item definition hashes", () => {
    const discovery: McpServerDiscovery = {
      serverId: "github",
      discoveredAt: "2026-06-13T00:00:00.000Z",
      transportType: "streamable-http",
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      tools: [
        {
          name: "create_issue",
          description: "Create an issue.",
          inputSchema: {
            type: "object",
            properties: {
              title: { type: "string" },
            },
          },
        },
      ],
      resources: [
        {
          uri: "repo://machdoch/readme",
          name: "README",
        },
      ],
      resourceTemplates: [
        {
          uriTemplate: "repo://machdoch/{path}",
          name: "Repository file",
        },
      ],
      prompts: [
        {
          name: "summarize_issue",
          description: "Summarize an issue.",
        },
      ],
    };

    expect(enrichMcpDiscoveryMetadata(discovery)).toMatchObject({
      capabilitiesHash: expect.stringMatching(/^sha256:/u),
      catalogHash: expect.stringMatching(/^sha256:/u),
      toolCatalogHash: expect.stringMatching(/^sha256:/u),
      resourceCatalogHash: expect.stringMatching(/^sha256:/u),
      promptCatalogHash: expect.stringMatching(/^sha256:/u),
      tools: [
        {
          inputSchemaHash: expect.stringMatching(/^sha256:/u),
          descriptionHash: expect.stringMatching(/^sha256:/u),
          definitionHash: expect.stringMatching(/^sha256:/u),
        },
      ],
      resources: [{ definitionHash: expect.stringMatching(/^sha256:/u) }],
      resourceTemplates: [{ definitionHash: expect.stringMatching(/^sha256:/u) }],
      prompts: [
        {
          descriptionHash: expect.stringMatching(/^sha256:/u),
          definitionHash: expect.stringMatching(/^sha256:/u),
        },
      ],
    });
  });

  it("reports added, removed, and changed catalog entries", () => {
    const previous = enrichMcpDiscoveryMetadata({
      serverId: "github",
      discoveredAt: "2026-06-13T00:00:00.000Z",
      transportType: "streamable-http",
      capabilities: { tools: {} },
      tools: [
        {
          name: "search",
          description: "Search repositories.",
          inputSchema: { type: "object" },
        },
        {
          name: "create_issue",
          inputSchema: { type: "object" },
        },
      ],
      resources: [],
      resourceTemplates: [],
      prompts: [{ name: "old_prompt" }],
    });
    const next: McpServerDiscovery = {
      serverId: "github",
      discoveredAt: "2026-06-13T00:01:00.000Z",
      transportType: "streamable-http",
      capabilities: { tools: {}, prompts: {} },
      tools: [
        {
          name: "search",
          description: "Search repositories and code.",
          inputSchema: { type: "object" },
        },
        {
          name: "close_issue",
          inputSchema: { type: "object" },
        },
      ],
      resources: [],
      resourceTemplates: [],
      prompts: [],
    };

    expect(compareMcpDiscoveries(previous, next)).toMatchObject({
      changed: true,
      previousCatalogHash: expect.stringMatching(/^sha256:/u),
      nextCatalogHash: expect.stringMatching(/^sha256:/u),
      changes: expect.arrayContaining([
        expect.objectContaining({
          category: "capabilities",
          type: "changed",
          name: "server",
        }),
        expect.objectContaining({
          category: "tool",
          type: "added",
          name: "close_issue",
        }),
        expect.objectContaining({
          category: "tool",
          type: "changed",
          name: "search",
        }),
        expect.objectContaining({
          category: "tool",
          type: "removed",
          name: "create_issue",
        }),
        expect.objectContaining({
          category: "prompt",
          type: "removed",
          name: "old_prompt",
        }),
      ]),
    });
  });
});
