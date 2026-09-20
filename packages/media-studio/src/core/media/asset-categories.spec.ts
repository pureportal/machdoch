import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEDIA_ASSET_CATEGORIES,
  addMediaAssetCategory,
  matchesMediaAssetCategoryFilter,
  removeMediaAssetCategory,
  renameMediaAssetCategory,
} from "./asset-categories.js";
import { createEmptyMediaGenerationAssetMetadata } from "./asset-metadata.js";

describe("media asset categories", () => {
  it("seeds general-purpose and adult-content categories", () => {
    const names = DEFAULT_MEDIA_ASSET_CATEGORIES.map(
      (category) => category.name,
    );
    expect(names).toContain("Character");
    expect(names).toContain("Animation & Motion");
    expect(names).toContain("NSFW — Mature");
    expect(names).toContain("NSFW — Adult");
    expect(names).toContain("NSFW — Explicit");
  });

  it("rejects blank and case-insensitive duplicate names", () => {
    const categories = [{ id: "style", name: "Style" }];
    expect(() => addMediaAssetCategory(categories, "  ", "blank")).toThrow(
      "Enter a category name.",
    );
    expect(() =>
      addMediaAssetCategory(categories, "  sTyLe ", "duplicate"),
    ).toThrow("already exists");
  });

  it("renames categories without changing asset relationships", () => {
    const categories = [
      { id: "character", name: "Character" },
      { id: "style", name: "Style" },
    ];
    const renamed = renameMediaAssetCategory(
      categories,
      "character",
      "  Characters & People  ",
    );

    expect(renamed).toEqual([
      { id: "character", name: "Characters & People" },
      { id: "style", name: "Style" },
    ]);
  });

  it("removes deleted assignments while preserving other categories", () => {
    const metadata = {
      "asset:one": {
        ...createEmptyMediaGenerationAssetMetadata(),
        categoryIds: ["character", "style"],
      },
      "asset:two": {
        ...createEmptyMediaGenerationAssetMetadata(),
        categoryIds: ["style"],
      },
    };
    const result = removeMediaAssetCategory(
      [
        { id: "character", name: "Character" },
        { id: "style", name: "Style" },
      ],
      metadata,
      "character",
    );

    expect(result.categories).toEqual([{ id: "style", name: "Style" }]);
    expect(result.metadata["asset:one"]?.categoryIds).toEqual(["style"]);
    expect(result.metadata["asset:two"]?.categoryIds).toEqual(["style"]);
  });

  it("matches an asset when any selected category is assigned", () => {
    expect(matchesMediaAssetCategoryFilter(["style"], [])).toBe(true);
    expect(
      matchesMediaAssetCategoryFilter(
        ["style", "character"],
        ["vehicle", "character"],
      ),
    ).toBe(true);
    expect(matchesMediaAssetCategoryFilter(["style"], ["vehicle"])).toBe(false);
  });
});
