import { describe, expect, it } from "vitest";
import type { MediaAssetRecord } from "./contracts.js";
import {
  EMPTY_MEDIA_ASSET_FILTERS,
  matchesMediaAssetFilters,
  mediaAssetOrigin,
} from "./asset-discovery.js";

const asset: MediaAssetRecord = {
  id: "image:import",
  runId: "run:import",
  digest: "a".repeat(64),
  kind: "image",
  mimeType: "image/png",
  byteSize: 1024,
  width: 800,
  height: 600,
  createdAt: "2026-09-19T23:59:59",
  outputIndex: 0,
  fixture: false,
  operation: { kind: "local-import" },
  sourceAssetIds: [],
  tags: [],
};

describe("media asset filters", () => {
  it("separates imported originals from generated and edited outputs", () => {
    expect(mediaAssetOrigin(asset)).toBe("added");
    expect(mediaAssetOrigin({ ...asset, operation: null })).toBe("added");
    const generated: MediaAssetRecord = {
      ...asset,
      operation: {
        kind: "workflow",
        sourceNodeId: "image",
        iteration: 0,
        details: {},
      },
    };
    expect(mediaAssetOrigin(generated)).toBe("generated");
    expect(
      matchesMediaAssetFilters(generated, {
        ...EMPTY_MEDIA_ASSET_FILTERS,
        origin: "added",
      }),
    ).toBe(false);
    expect(
      matchesMediaAssetFilters(generated, {
        ...EMPTY_MEDIA_ASSET_FILTERS,
        origin: "generated",
      }),
    ).toBe(true);
  });

  it("combines format, orientation and source filters", () => {
    const filters = {
      ...EMPTY_MEDIA_ASSET_FILTERS,
      format: "image/png",
      orientation: "landscape" as const,
      origin: "added" as const,
    };
    expect(matchesMediaAssetFilters(asset, filters)).toBe(true);
    expect(
      matchesMediaAssetFilters({ ...asset, mimeType: "image/jpeg" }, filters),
    ).toBe(false);
    expect(matchesMediaAssetFilters({ ...asset, height: 900 }, filters)).toBe(
      false,
    );
    expect(
      matchesMediaAssetFilters(
        { ...asset, height: 800 },
        { ...filters, orientation: "square" },
      ),
    ).toBe(true);
    expect(
      matchesMediaAssetFilters(
        { ...asset, height: 900 },
        { ...filters, orientation: "portrait" },
      ),
    ).toBe(true);
    expect(
      matchesMediaAssetFilters(
        { ...asset, width: 0, height: 0 },
        { ...filters, orientation: "square" },
      ),
    ).toBe(false);
  });

  it("includes the entire chosen local date range", () => {
    const filters = {
      ...EMPTY_MEDIA_ASSET_FILTERS,
      dateFrom: "2026-09-19",
      dateTo: "2026-09-19",
    };
    expect(matchesMediaAssetFilters(asset, filters)).toBe(true);
    expect(
      matchesMediaAssetFilters(
        { ...asset, createdAt: "2026-09-19T00:00:00" },
        filters,
      ),
    ).toBe(true);
    expect(
      matchesMediaAssetFilters(
        { ...asset, createdAt: "2026-09-18T23:59:59" },
        filters,
      ),
    ).toBe(false);
    expect(
      matchesMediaAssetFilters(
        { ...asset, createdAt: "2026-09-20T00:00:00" },
        filters,
      ),
    ).toBe(false);
  });
});
