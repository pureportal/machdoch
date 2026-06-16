import { describe, expect, it } from "vitest";
import {
  coerceMcpRegistryServerEntry,
  createMcpConfigRawWithServerEnabled,
  createMcpConfigRawWithMarketplaceServer,
  createMcpConfigRawWithoutServer,
  createMcpMarketplaceInstallPlan,
  createMcpMarketplaceServersUrl,
  getMcpMarketplaceCategoriesForServer,
  getMcpMarketplaceRecommendationForServer,
  getMcpRegistryServerId,
  type McpRegistryServerEntry,
} from "./marketplace.js";

const createRemoteEntry = (): McpRegistryServerEntry => ({
  server: {
    name: "ai.smithery/example",
    title: "Smithery Example",
    description: "Example remote MCP server.",
    version: "1.0.0",
    remotes: [
      {
        type: "streamable-http",
        url: "https://example.test/mcp",
        headers: [
          {
            name: "Authorization",
            value: "Bearer {smithery_api_key}",
            isRequired: true,
            isSecret: true,
          },
        ],
      },
    ],
  },
});

describe("createMcpMarketplaceServersUrl", () => {
  it("includes RFC 3339 delta filters when requested", () => {
    const url = new URL(
      createMcpMarketplaceServersUrl(
        {
          baseUrl: "https://registry.modelcontextprotocol.io/v0.1",
        },
        {
          updatedSince: "2026-06-16T00:00:00.000Z",
        },
      ),
    );

    expect(url.searchParams.get("updated_since")).toBe(
      "2026-06-16T00:00:00.000Z",
    );
    expect(url.searchParams.get("version")).toBe("latest");
  });
});

describe("createMcpMarketplaceInstallPlan", () => {
  it("creates a remote HTTP plan with resolved credential headers", () => {
    const plan = createMcpMarketplaceInstallPlan(createRemoteEntry(), {
      credentials: {
        "header:smithery_api_key": "SMITHERY_API_KEY",
      },
    });

    expect(plan.kind).toBe("remote");
    expect(plan.missingCredentialFields).toEqual([]);
    expect(plan.blockedReasons).toEqual([]);
    expect(plan.credentialFields[0]).toMatchObject({
      id: "header:smithery_api_key",
      required: true,
      secret: true,
    });
    expect(plan.server.transport).toMatchObject({
      type: "streamable-http",
      url: "https://example.test/mcp",
      headers: {
        Authorization: "Bearer ${env:SMITHERY_API_KEY}",
      },
    });
  });

  it("blocks raw secret values so they are not written to config", () => {
    const plan = createMcpMarketplaceInstallPlan(createRemoteEntry(), {
      credentials: {
        "header:smithery_api_key": "raw secret value",
      },
    });

    expect(plan.blockedReasons).toContain(
      "Secret fields must contain environment variable names, not raw secret values.",
    );
    expect(JSON.stringify(plan.server.transport)).not.toContain("raw secret value");
  });

  it("creates an npm stdio plan with runtime args, package args, and env", () => {
    const entry: McpRegistryServerEntry = {
      server: {
        name: "io.github.owner/filesystem",
        description: "Filesystem MCP server.",
        version: "2.1.0",
        packages: [
          {
            registryType: "npm",
            identifier: "@owner/filesystem-mcp",
            version: "2.1.0",
            runtimeHint: "npx",
            runtimeArguments: [{ type: "positional", value: "-y" }],
            packageArguments: [
              {
                type: "named",
                name: "allowed-directories",
                isRequired: true,
              },
            ],
            environmentVariables: [
              {
                name: "API_TOKEN",
                isRequired: true,
                isSecret: true,
              },
            ],
            transport: {
              type: "stdio",
            },
          },
        ],
      },
    };

    const plan = createMcpMarketplaceInstallPlan(entry, {
      credentials: {
        "argument:allowed-directories": "C:/Development",
        "environment:API_TOKEN": "API_TOKEN",
      },
    });

    expect(plan.kind).toBe("npm");
    expect(plan.generatedCommand).toEqual({
      command: "npx",
      args: [
        "-y",
        "@owner/filesystem-mcp@2.1.0",
        "--allowed-directories",
        "C:/Development",
      ],
    });
    expect(plan.server.transport).toMatchObject({
      type: "stdio",
      command: "npx",
      args: [
        "-y",
        "@owner/filesystem-mcp@2.1.0",
        "--allowed-directories",
        "C:/Development",
      ],
      env: {
        API_TOKEN: "${env:API_TOKEN}",
      },
    });
  });

  it("blocks one-click installs for MCPB packages until hash verification exists", () => {
    const plan = createMcpMarketplaceInstallPlan({
      server: {
        name: "io.github.owner/image",
        description: "Image MCP server.",
        version: "1.0.0",
        packages: [
          {
            registryType: "mcpb",
            identifier: "https://github.com/owner/image/releases/download/v1.0.0/image.mcpb",
            fileSha256: "a".repeat(64),
            transport: {
              type: "stdio",
            },
          },
        ],
      },
    });

    expect(plan.blockedReasons).toContain(
      "MCPB one-click install is disabled until artifact download and SHA-256 verification are implemented.",
    );
  });
});

describe("coerceMcpRegistryServerEntry", () => {
  it("normalizes registry records from unknown JSON", () => {
    const entry = coerceMcpRegistryServerEntry({
      server: {
        name: "io.github.owner/tool",
        description: "Tool MCP server.",
        version: "1.0.0",
        icons: [
          {
            src: "https://example.test/icon.png",
            mimeType: "image/png",
            sizes: ["128x128", ""],
            theme: "dark",
          },
          {
            src: "",
          },
        ],
        packages: [
          {
            registryType: "npm",
            identifier: "tool-mcp",
            transport: { type: "stdio" },
          },
        ],
      },
    });

    expect(entry?.server.packages?.[0]?.identifier).toBe("tool-mcp");
    expect(entry?.server.icons).toEqual([
      {
        src: "https://example.test/icon.png",
        mimeType: "image/png",
        sizes: ["128x128"],
        theme: "dark",
      },
    ]);
  });
});

describe("getMcpMarketplaceCategoriesForServer", () => {
  it("does not mark every uncategorized server as featured", () => {
    expect(
      getMcpMarketplaceCategoriesForServer({
        name: "com.example/unknown",
        description: "A very specific integration without category keywords.",
      }),
    ).toEqual([]);
  });
});

describe("getMcpMarketplaceRecommendationForServer", () => {
  it("matches curated servers by registry name", () => {
    expect(
      getMcpMarketplaceRecommendationForServer({
        name: "io.github.microsoft/playwright-mcp",
        repository: {
          url: "https://github.com/microsoft/playwright-mcp",
        },
      }),
    ).toMatchObject({
      label: "Recommended",
    });
  });

  it("matches curated servers by GitHub repository path", () => {
    expect(
      getMcpMarketplaceRecommendationForServer({
        name: "custom/playwright",
        repository: {
          url: "https://github.com/microsoft/playwright-mcp.git",
        },
      }),
    ).toMatchObject({
      label: "Recommended",
    });
  });

  it("does not recommend unrelated servers", () => {
    expect(
      getMcpMarketplaceRecommendationForServer({
        name: "com.example/unknown",
        repository: {
          url: "https://github.com/example/unknown",
        },
      }),
    ).toBeNull();
  });
});

describe("createMcpConfigRawWithMarketplaceServer", () => {
  it("uses full registry names for generated ids to avoid common suffix collisions", () => {
    expect(
      getMcpRegistryServerId({
        name: "ac.inference.sh/mcp",
        title: "inference.sh",
      }),
    ).toBe("ac-inference-sh-mcp");
    expect(
      getMcpRegistryServerId({
        name: "ai.autorfp/mcp",
        title: "AutoRFP.ai",
      }),
    ).toBe("ai-autorfp-mcp");
  });

  it("inserts and replaces marketplace servers by normalized id", () => {
    const plan = createMcpMarketplaceInstallPlan(createRemoteEntry(), {
      serverId: "Smithery Example",
      credentials: {
        "header:smithery_api_key": "SMITHERY_API_KEY",
      },
    });
    const first = createMcpConfigRawWithMarketplaceServer(
      '{"schemaVersion":1,"servers":[]}',
      plan.server,
    );
    const second = createMcpConfigRawWithMarketplaceServer(first, {
      ...plan.server,
      title: "Updated",
    });
    const parsed = JSON.parse(second) as { servers: Array<{ title: string }> };

    expect(parsed.servers).toHaveLength(1);
    expect(parsed.servers[0]?.title).toBe("Updated");
  });

  it("preserves unrelated top-level config fields when inserting servers", () => {
    const plan = createMcpMarketplaceInstallPlan(createRemoteEntry(), {
      credentials: {
        "header:smithery_api_key": "SMITHERY_API_KEY",
      },
    });
    const raw = createMcpConfigRawWithMarketplaceServer(
      '{"schemaVersion":1,"custom":{"keep":true},"servers":[]}',
      plan.server,
    );
    const parsed = JSON.parse(raw) as { custom?: { keep?: boolean } };

    expect(parsed.custom?.keep).toBe(true);
  });

  it("enables, disables, and removes installed servers", () => {
    const plan = createMcpMarketplaceInstallPlan(createRemoteEntry(), {
      serverId: "Smithery Example",
      credentials: {
        "header:smithery_api_key": "SMITHERY_API_KEY",
      },
    });
    const raw = createMcpConfigRawWithMarketplaceServer(
      '{"schemaVersion":1,"servers":[]}',
      plan.server,
    );
    const disabled = createMcpConfigRawWithServerEnabled(raw, plan.server.id, false);
    const disabledParsed = JSON.parse(disabled) as {
      servers: Array<{ enabled: boolean }>;
    };

    expect(disabledParsed.servers[0]?.enabled).toBe(false);

    const removed = createMcpConfigRawWithoutServer(disabled, plan.server.id);
    const removedParsed = JSON.parse(removed) as { servers: unknown[] };

    expect(removedParsed.servers).toHaveLength(0);
  });
});
