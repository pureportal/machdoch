import { describe, expect, it } from "vitest";
import {
  getNpmPackageIdentifier,
  mergeMarketplaceEnrichmentMetrics,
  parseGitHubRepositoryPath,
  type MarketplaceEnrichmentSnapshot,
} from "./mcp-marketplace-enrichment";
import type { MarketplaceResult } from "./mcp-marketplace-model";

describe("parseGitHubRepositoryPath", () => {
  it("extracts normalized owner and repo from GitHub URLs", () => {
    expect(
      parseGitHubRepositoryPath("https://github.com/modelcontextprotocol/servers.git"),
    ).toBe("modelcontextprotocol/servers");
    expect(parseGitHubRepositoryPath("https://gitlab.com/example/repo")).toBeNull();
  });
});

describe("getNpmPackageIdentifier", () => {
  it("finds the npm package candidate", () => {
    expect(
      getNpmPackageIdentifier({
        entry: {
          server: {
            name: "io.github/example",
            description: "Example",
            version: "1.0.0",
            packages: [
              {
                registryType: "pypi",
                identifier: "example",
                transport: { type: "stdio" },
              },
              {
                registryType: "npm",
                identifier: "@example/mcp",
                transport: { type: "stdio" },
              },
            ],
          },
        },
      } as MarketplaceResult),
    ).toBe("@example/mcp");
  });
});

describe("mergeMarketplaceEnrichmentMetrics", () => {
  it("fills popularity metrics from local enrichment without overwriting registry values", () => {
    const enrichment: MarketplaceEnrichmentSnapshot = {
      fetchedAt: Date.now(),
      sources: ["GitHub", "npm"],
      downloads: 5000,
      stars: 250,
    };

    const merged = mergeMarketplaceEnrichmentMetrics(
      { popularity: 99, quality: 0.8 },
      enrichment,
    );

    expect(merged).toMatchObject({
      downloads: 5000,
      popularity: 99,
      quality: 0.8,
      stars: 250,
    });
  });

  it("keeps zero-value enrichment metrics as loaded values", () => {
    const enrichment: MarketplaceEnrichmentSnapshot = {
      fetchedAt: Date.now(),
      sources: ["GitHub"],
      downloads: 0,
      stars: 0,
    };

    const merged = mergeMarketplaceEnrichmentMetrics({}, enrichment);

    expect(merged).toMatchObject({
      downloads: 0,
      popularity: 0,
      stars: 0,
    });
  });
});
