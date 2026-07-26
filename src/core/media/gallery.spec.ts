import { describe, expect, it } from "vitest";
import {
  isMediaGalleryAssetKind,
  paginateMediaItems,
  stepMediaGalleryAssetId,
} from "./gallery.js";

describe("media gallery navigation", () => {
  it("includes playable videos alongside images and vectors", () => {
    expect(isMediaGalleryAssetKind("image")).toBe(true);
    expect(isMediaGalleryAssetKind("vector")).toBe(true);
    expect(isMediaGalleryAssetKind("video")).toBe(true);
    expect(isMediaGalleryAssetKind("audio")).toBe(false);
    expect(isMediaGalleryAssetKind("alpha-matte")).toBe(false);
    expect(isMediaGalleryAssetKind("report")).toBe(false);
  });

  it("wraps in both directions and recovers from a stale selection", () => {
    const ids = ["image:one", "video:two", "vector:three"];

    expect(stepMediaGalleryAssetId(ids, "vector:three", 1)).toBe("image:one");
    expect(stepMediaGalleryAssetId(ids, "image:one", -1)).toBe("vector:three");
    expect(stepMediaGalleryAssetId(ids, "missing", 1)).toBe("image:one");
    expect(stepMediaGalleryAssetId(ids, "missing", -1)).toBe("vector:three");
    expect(stepMediaGalleryAssetId([], null, 1)).toBeNull();
  });

  it("pages large collections without hiding the final partial page", () => {
    const values = Array.from({ length: 53 }, (_, index) => `asset:${index + 1}`);

    expect(paginateMediaItems(values, 2, 24)).toMatchObject({
      items: values.slice(24, 48),
      page: 2,
      pageCount: 3,
      totalItems: 53,
      startIndex: 24,
      endIndex: 48,
      firstItemNumber: 25,
      lastItemNumber: 48,
    });
    expect(paginateMediaItems(values, 999, 24)).toMatchObject({
      items: values.slice(48),
      page: 3,
      firstItemNumber: 49,
      lastItemNumber: 53,
    });
  });

  it("normalizes empty and invalid requested pages while rejecting invalid sizes", () => {
    expect(paginateMediaItems([], 9, 24)).toEqual({
      items: [],
      page: 0,
      pageCount: 0,
      pageSize: 24,
      totalItems: 0,
      startIndex: 0,
      endIndex: 0,
      firstItemNumber: 0,
      lastItemNumber: 0,
    });
    expect(paginateMediaItems(["one", "two"], Number.NaN, 1).page).toBe(1);
    expect(paginateMediaItems(["one", "two"], -4, 1).page).toBe(1);
    expect(() => paginateMediaItems(["one"], 1, 0)).toThrow(RangeError);
  });
});
