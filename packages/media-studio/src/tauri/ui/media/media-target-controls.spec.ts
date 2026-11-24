import { describe, expect, it } from "vitest";
import { DEFAULT_MEDIA_STUDIO_STATE } from "./media-studio-store";
import {
  applyMediaTargetOptions,
  describeMediaTargetOptions,
  findMediaTargetControl,
  mediaTargetOptionSchema,
} from "./media-target-controls";

const mesh = findMediaTargetControl("mesh")!;

describe("media target controls", () => {
  it("describes every mesh option with ranges and grouping", () => {
    const options = describeMediaTargetOptions(mesh, DEFAULT_MEDIA_STUDIO_STATE);
    expect(options.map(({ id, group }) => [id, group])).toEqual([
      ["removeBackground", "basic"],
      ["numInferenceSteps", "basic"],
      ["octreeResolution", "basic"],
      ["maxFaceCount", "basic"],
      ["voxelize", "basic"],
      ["voxelResolution", "basic"],
      ["guidanceScale", "more-options"],
      ["removeFloaters", "more-options"],
      ["voxelFill", "more-options"],
      ["numChunks", "more-options"],
      ["seed", "more-options"],
    ]);
    expect(options.find(({ id }) => id === "octreeResolution")).toMatchObject({
      min: 64,
      max: 512,
      recommended: { min: 256, max: 384 },
    });
    expect(mediaTargetOptionSchema(mesh).maxFaceCount).toMatchObject({
      type: "integer",
      minimum: -1,
    });
  });

  it("applies options, clears optional numbers, and rejects out-of-range values", () => {
    const next = applyMediaTargetOptions(mesh, DEFAULT_MEDIA_STUDIO_STATE, {
      numInferenceSteps: 5,
      maxFaceCount: -1,
      removeFloaters: false,
      voxelize: true,
      voxelResolution: 48,
    });
    expect(next.meshRecipe).toMatchObject({
      numInferenceSteps: 5,
      maxFaceCount: null,
      removeFloaters: false,
      voxelize: true,
      voxelResolution: 48,
    });
    expect(() =>
      applyMediaTargetOptions(mesh, DEFAULT_MEDIA_STUDIO_STATE, { octreeResolution: 9_000 }),
    ).toThrow("Resolution must be between 64 and 512.");
    expect(() =>
      applyMediaTargetOptions(mesh, DEFAULT_MEDIA_STUDIO_STATE, { prompt: "x" }),
    ).toThrow("prompt is not an option for mesh.");
  });

  it("writes mesh view images by slot", () => {
    const withFront = mesh.writeImages(DEFAULT_MEDIA_STUDIO_STATE, { front: "asset-1", back: "asset-2" });
    const cleared = mesh.writeImages(withFront, { back: null });
    expect(mesh.readImages(cleared)).toEqual({
      front: "asset-1",
      left: null,
      back: null,
      right: null,
    });
  });
});
