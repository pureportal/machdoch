import { describe, expect, it } from "vitest";
import {
  filterMarketplaceResults,
  getMarketplaceResultCountLabel,
  mergeMarketplaceResults,
  parseMarketplaceRegistryResponse,
  redactMcpConfigRaw,
  sortMarketplaceResults,
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

describe("sortMarketplaceResults", () => {
  const createResult = (
    title: string,
    overrides: Partial<MarketplaceResult> = {},
  ): MarketplaceResult => ({
    key: title,
    entry: {
      server: {
        name: `io.github/${title.toLowerCase()}`,
        title,
        description: `${title} server`,
        version: "1.0.0",
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
    ...overrides,
  });

  it("sorts by updated date descending", () => {
    const sorted = sortMarketplaceResults(
      [
        createResult("Old", { updatedAtMs: 100 }),
        createResult("New", { updatedAtMs: 200 }),
      ],
      "updated",
    );

    expect(sorted.map((result) => result.title)).toEqual(["New", "Old"]);
  });

  it("prioritizes featured and high install score in recommended mode", () => {
    const sorted = sortMarketplaceResults(
      [
        createResult("Plain", { installScore: 100 }),
        createResult("Featured", {
          categories: ["featured"],
          installScore: 80,
        }),
      ],
      "recommended",
    );

    expect(sorted.map((result) => result.title)).toEqual(["Featured", "Plain"]);
  });

  it("prioritizes curated recommendations before keyword featured entries", () => {
    const sorted = sortMarketplaceResults(
      [
        createResult("Featured", {
          categories: ["featured"],
          installScore: 100,
        }),
        createResult("Curated", {
          recommendation: {
            label: "Recommended",
            reason: "Curated test recommendation.",
          },
          recommended: true,
          installScore: 0,
        }),
      ],
      "recommended",
    );

    expect(sorted.map((result) => result.title)).toEqual([
      "Curated",
      "Featured",
    ]);
  });

  it("sorts by registry-provided popularity metrics", () => {
    const sorted = sortMarketplaceResults(
      [
        createResult("Quiet", { metrics: { stars: 1, downloads: 10 } }),
        createResult("Popular", { metrics: { stars: 100, downloads: 5000 } }),
      ],
      "popularity",
    );

    expect(sorted.map((result) => result.title)).toEqual(["Popular", "Quiet"]);
  });

  it("ranks deprecated entries below active entries in recommended mode", () => {
    const sorted = sortMarketplaceResults(
      [
        createResult("Deprecated", {
          categories: ["featured"],
          status: "deprecated",
          installScore: 100,
        }),
        createResult("Active", {
          installScore: 0,
          status: "active",
        }),
      ],
      "recommended",
    );

    expect(sorted.map((result) => result.title)).toEqual([
      "Active",
      "Deprecated",
    ]);
  });
});

describe("filterMarketplaceResults", () => {
  it("filters by category and keeps all mode unfiltered", () => {
    const results = [
      { key: "a", categories: ["featured"] },
      { key: "b", categories: ["developer-tools"] },
    ] as MarketplaceResult[];

    expect(filterMarketplaceResults(results, "featured").map((result) => result.key)).toEqual(["a"]);
    expect(filterMarketplaceResults(results, "all")).toHaveLength(2);
  });

  it("filters by loaded text search and install kind", () => {
    const results = [
      {
        key: "remote",
        categories: [],
        installKind: "remote",
        authRequired: false,
        searchText: "github repository search",
      },
      {
        key: "auth",
        categories: [],
        installKind: "npm",
        authRequired: true,
        searchText: "private api",
      },
    ] as MarketplaceResult[];

    expect(filterMarketplaceResults(results, "all", "github").map((result) => result.key)).toEqual(["remote"]);
    expect(filterMarketplaceResults(results, "all", "", "auth-required").map((result) => result.key)).toEqual(["auth"]);
  });
});

describe("getMarketplaceResultCountLabel", () => {
  it("does not present paginated registry counts as a total", () => {
    expect(
      getMarketplaceResultCountLabel({
        visibleCount: 9,
        loadedCount: 100,
        hasMoreResults: true,
      }),
    ).toBe("9 visible, 100 loaded, more available");
  });

  it("omits the pagination hint when all pages are loaded", () => {
    expect(
      getMarketplaceResultCountLabel({
        visibleCount: 42,
        loadedCount: 42,
        hasMoreResults: false,
      }),
    ).toBe("42 visible, 42 loaded");
  });
});

describe("redactMcpConfigRaw", () => {
  it("redacts obvious inline secrets and keeps env references visible", () => {
    expect(
      redactMcpConfigRaw(
        JSON.stringify({
          servers: [
            {
              transport: {
                headers: {
                  Authorization: "Bearer secret",
                  "X-API-Key": "${env:API_KEY}",
                },
                env: {
                  API_TOKEN: "secret",
                },
              },
            },
          ],
        }),
      ),
    ).toContain("[redacted]");
    expect(redactMcpConfigRaw('{"token":"${env:TOKEN}"}')).toContain(
      "${env:TOKEN}",
    );
  });
});
