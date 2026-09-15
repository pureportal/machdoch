import { describe, expect, it } from "vitest";
import { createMediaModelCatalogSnapshot } from "./catalog.js";
import { createEmptyMediaGenerationAssetMetadata } from "./asset-metadata.js";
import type { MediaAssetRecord } from "./contracts.js";
import {
  discoverMediaResources,
  listMediaResourceTags,
  matchesMediaResourceQuery,
} from "./resource-discovery.js";

const model = createMediaModelCatalogSnapshot({
  isOpenAiConfigured: false,
  isLocalFluxInstalled: true,
}).models[0]!;
const metadata = {
  ...createEmptyMediaGenerationAssetMetadata(),
  tags: ["anime", "ink"],
  categoryIds: ["category:opaque"],
};
const categories = [{ id: "category:opaque", name: "Illustration" }];
const filters = {
  query: "",
  categoryId: "all",
  tag: "all",
  sort: "name" as const,
};

describe("resource discovery", () => {
  it("treats differences in tag capitalisation as one filter", () => {
    const other = { ...model, id: "model:other" };
    const metadataById = {
      [model.id]: metadata,
      [other.id]: { ...metadata, tags: ["Anime"] },
    };
    expect(listMediaResourceTags([model, other], metadataById)).toEqual([
      "Anime",
      "ink",
    ]);
    expect(
      discoverMediaResources([model, other], metadataById, categories, {
        ...filters,
        tag: "ANIME",
      }),
    ).toHaveLength(2);
  });
  it("finds models by metadata and a category's display name", () => {
    expect(
      matchesMediaResourceQuery(
        model,
        metadata,
        categories,
        "ANIME illustration",
      ),
    ).toBe(true);
    expect(
      matchesMediaResourceQuery(model, metadata, categories, "opaque"),
    ).toBe(false);
    expect(
      discoverMediaResources([model], { [model.id]: metadata }, categories, {
        ...filters,
        tag: "ink",
        categoryId: "category:opaque",
      }),
    ).toEqual([model]);
    expect(
      discoverMediaResources([model], { [model.id]: metadata }, categories, {
        ...filters,
        categoryId: "uncategorized",
      }),
    ).toEqual([]);
  });

  it("searches native asset tags and names alongside organised metadata", () => {
    const asset: MediaAssetRecord = {
      id: "image:abc",
      runId: "run:1",
      digest: "a".repeat(64),
      kind: "image",
      mimeType: "image/png",
      byteSize: 100,
      width: 512,
      height: 768,
      createdAt: "2026-09-15T00:00:00Z",
      outputIndex: 0,
      fixture: false,
      operation: { kind: "local-import", sourceFileName: "Garden.png" },
      sourceAssetIds: [],
      tags: [
        {
          value: "outdoors",
          label: "Outdoors",
          source: "user",
          confidence: null,
          createdAt: "2026-09-15T00:00:00Z",
        },
      ],
    };
    expect(
      matchesMediaResourceQuery(
        asset,
        metadata,
        categories,
        "garden outdoors 512x768 anime",
      ),
    ).toBe(true);
    const older = {
      ...asset,
      id: "image:older",
      createdAt: "2026-09-01T00:00:00Z",
    };
    expect(
      discoverMediaResources([older, asset], {}, [], {
        ...filters,
        sort: "newest",
        tag: "Outdoors",
      }).map((item) => item.id),
    ).toEqual([asset.id, older.id]);
  });
});
