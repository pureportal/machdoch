import { describe, expect, it } from "vitest";
import type { MediaImageMask } from "./contracts.js";
import {
  hasMediaImageMaskContent,
  isMediaImageMask,
  normalizeMediaImageMask,
} from "./image-mask.js";

const mask: MediaImageMask = {
  schemaVersion: 1,
  sourceAssetId: "asset:base",
  inverted: false,
  strokes: [
    {
      mode: "paint",
      size: 0.1,
      points: [
        { x: 0.2, y: 0.3 },
        { x: 0.7, y: 0.8 },
      ],
    },
  ],
};

describe("media image masks", () => {
  it("accepts a bounded normalized mask", () => {
    expect(isMediaImageMask(mask)).toBe(true);
    expect(normalizeMediaImageMask(mask)).toEqual(mask);
    expect(hasMediaImageMaskContent(mask)).toBe(true);
  });

  it("rejects masks with stale or out-of-bounds data", () => {
    expect(
      normalizeMediaImageMask({ ...mask, sourceAssetId: " asset:base" }),
    ).toBeNull();
    expect(
      isMediaImageMask({
        ...mask,
        strokes: [{ ...mask.strokes[0], points: [{ x: 1.1, y: 0.5 }] }],
      }),
    ).toBe(false);
    expect(isMediaImageMask({ ...mask, internalPreview: true })).toBe(false);
  });

  it("distinguishes a valid empty mask from an active one", () => {
    const empty = { ...mask, strokes: [] };
    expect(isMediaImageMask(empty)).toBe(true);
    expect(hasMediaImageMaskContent(empty)).toBe(false);
  });
});
