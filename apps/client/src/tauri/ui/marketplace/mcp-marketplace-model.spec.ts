import { describe, expect, it } from "vitest";
import {
  mergeMarketplaceResults,
  parseMarketplaceRegistryResponse,
  redactMcpConfigRaw,
  type MarketplaceResult,
} from "./mcp-marketplace-model";

const registry = {
  id: "official",
  title: "Official MCP Registry",
  baseUrl: "https://registry.modelcontextprotocol.io/v0.1",
  enabled: true,
  official: true,
};

describe("parseMarketplaceRegistryResponse", () => {
  it("keeps registry pagination metadata with normalized entries", () => {
    const parsed = parseMarketplaceRegistryResponse(
      {
        servers: [
          {
            server: {
              name: "io.github/example",
              title: "Example",
              description: "Example MCP server.",
              version: "1.0.0",
              icons: [{ src: "https://example.test/icon.png" }],
              repository: {
                url: "https://github.com/example/example",
                source: "github",
              },
              remotes: [{ type: "streamable-http", url: "https://example.test/mcp" }],
              _meta: {
                "example.marketplace": {
                  stars: 42,
                  downloadsLastWeek: 1200,
                  qualityScore: 0.8,
                },
              },
            },
            _meta: {
              "io.modelcontextprotocol.registry/official": {
                status: "active",
                publishedAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-02T00:00:00Z",
                isLatest: true,
              },
            },
          },
        ],
        metadata: {
          nextCursor: "io.github/example:1.0.0",
          count: 1,
        },
      },
      registry,
    );

    expect(parsed.page).toMatchObject({
      registryId: "official",
      nextCursor: "io.github/example:1.0.0",
      count: 1,
    });
    expect(parsed.results[0]).toMatchObject({
      key: "official:io.github/example:1.0.0",
      title: "Example",
      installKind: "remote",
      logoUrl: "https://example.test/icon.png",
      metrics: {
        downloads: 1200,
        quality: 0.8,
        stars: 42,
      },
      repositoryUrl: "https://github.com/example/example",
    });
  });

  it("marks curated servers as recommended", () => {
    const parsed = parseMarketplaceRegistryResponse(
      {
        servers: [
          {
            server: {
              name: "io.github.microsoft/playwright-mcp",
              title: "Playwright Browser Automation",
              description: "Official Playwright MCP server.",
              version: "1.0.0",
              repository: {
                url: "https://github.com/microsoft/playwright-mcp",
              },
              remotes: [{ type: "streamable-http", url: "https://example.test/mcp" }],
            },
          },
        ],
      },
      registry,
    );

    expect(parsed.results[0]).toMatchObject({
      recommended: true,
      recommendation: {
        label: "Recommended",
      },
    });
  });

  it("drops deleted registry entries", () => {
    const parsed = parseMarketplaceRegistryResponse(
      {
        servers: [
          {
            server: {
              name: "io.github/deleted",
              description: "Deleted MCP server.",
              version: "1.0.0",
              remotes: [{ type: "streamable-http", url: "https://example.test/mcp" }],
            },
            _meta: {
              "io.modelcontextprotocol.registry/official": {
                status: "deleted",
              },
            },
          },
        ],
        metadata: {
          count: 1,
        },
      },
      registry,
    );

    expect(parsed.results).toHaveLength(0);
    expect(parsed.deletedServers).toEqual([
      {
        key: "official:io.github/deleted:1.0.0",
        name: "io.github/deleted",
        registryId: "official",
      },
    ]);
  });
});

describe("mergeMarketplaceResults", () => {
  const createResult = (
    name: string,
    version: string,
    title = `${name}@${version}`,
  ): MarketplaceResult => ({
    key: `${registry.id}:${name}:${version}`,
    entry: {
      server: {
        name,
        title,
        description: `${title} server`,
        version,
      },
    },
    registry,
    recommendation: null,
    recommended: false,
    categories: [],
    title,
    status: "active",
    installKind: "npm",
    installScore: 0,
    authRequired: false,
    logoUrl: null,
    metrics: {},
    packageRegistryTypes: [],
    repositoryUrl: null,
    searchText: title.toLowerCase(),
    publishedAtMs: 0,
    updatedAtMs: 0,
  });

  it("replaces cached versions for the same registry server", () => {
    const merged = mergeMarketplaceResults(
      [createResult("io.github/example", "1.0.0", "Old")],
      [createResult("io.github/example", "2.0.0", "New")],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.key).toBe("official:io.github/example:2.0.0");
    expect(merged[0]?.title).toBe("New");
  });

  it("removes cached servers when a registry delta reports them as deleted", () => {
    const merged = mergeMarketplaceResults(
      [
        createResult("io.github/deleted", "1.0.0"),
        createResult("io.github/kept", "1.0.0"),
      ],
      [],
      [
        {
          key: "official:io.github/deleted:1.0.0",
          name: "io.github/deleted",
          registryId: "official",
        },
      ],
    );

    expect(merged.map((result) => result.entry.server.name)).toEqual([
      "io.github/kept",
    ]);
  });
});

describe("redactMcpConfigRaw", () => {
  it("redacts only schema-declared secret locations", () => {
    const redacted = redactMcpConfigRaw(
      JSON.stringify({
        schemaVersion: 1,
        defaults: { enabled: true, token: "must-not-survive" },
        servers: [
          {
            id: "remote",
            notes: "A token budget is ordinary presentation text.",
            transport: {
              type: "streamable-http",
              url: "https://example.com/mcp",
              headers: {
                Authorization: "Bearer secret",
                "X-API-Key": "${env:API_KEY}",
                Mixed: "secret ${env:API_KEY}",
              },
            },
            auth: {
              type: "oauth",
              clientId: "public-client",
              clientSecret: "client-secret",
              accessToken: "access-secret",
              accessTokenEnv: "MCP_ACCESS_TOKEN",
            },
            token: "unknown-secret-field",
          },
        ],
      }),
    );

    expect(redacted).toContain("A token budget is ordinary presentation text.");
    expect(redacted).toContain("${env:API_KEY}");
    expect(redacted).toContain("MCP_ACCESS_TOKEN");
    expect(redacted).toContain("[redacted]");
    expect(redacted).not.toContain("Bearer secret");
    expect(redacted).not.toContain("secret ${env:API_KEY}");
    expect(redacted).not.toContain("client-secret");
    expect(redacted).not.toContain("access-secret");
    expect(redacted).not.toContain("unknown-secret-field");
    expect(redacted).not.toContain("must-not-survive");
  });

  it("omits malformed and unknown config states instead of exposing raw text", () => {
    expect(redactMcpConfigRaw('{"token":"literal-secret"}')).toBe(
      "[unrecognized MCP configuration omitted]",
    );
    expect(redactMcpConfigRaw('{"token":"literal-secret"')).toBe(
      "[invalid MCP configuration omitted]",
    );
  });
});
