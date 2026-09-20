import { describe, expect, it } from "vitest";
import {
  inferMediaAssetImportType,
  listCompatibleMediaAssetImportTypes,
  parseMediaAssetImportFilename,
  type MediaAssetFolderTypeRule,
} from "./asset-import.js";

describe("media asset import types", () => {
  it("restricts each file extension to compatible asset types", () => {
    expect(listCompatibleMediaAssetImportTypes("cat.PNG")).toEqual(["image"]);
    expect(listCompatibleMediaAssetImportTypes("clip.webm")).toEqual(["video"]);
    expect(
      listCompatibleMediaAssetImportTypes("checkpoint.safetensors"),
    ).toEqual(["model", "lora", "embedding"]);
  });

  it.each([
    ["C:\\library\\models\\base\\nova.safetensors", "model"],
    ["C:\\library\\checkpoints\\nova.safetensors", "model"],
    ["/library/loras/characters/nova.safetensors", "lora"],
    ["/library/embeddings/nova.safetensors", "embedding"],
    ["/library/images/nova.webp", "image"],
  ] as const)("infers %s as %s", (path, expected) => {
    expect(inferMediaAssetImportType(path)).toBe(expected);
  });

  it("uses the closest matching containing folder", () => {
    expect(
      inferMediaAssetImportType(
        "C:\\models\\collection\\loras\\subject.safetensors",
      ),
    ).toBe("lora");
  });

  it("supports adding future folder mappings without changing inference", () => {
    const rules: readonly MediaAssetFolderTypeRule[] = [
      { type: "lora", folders: ["dora", "doras"] },
    ];
    expect(
      inferMediaAssetImportType("C:\\assets\\dora\\style.safetensors", rules),
    ).toBe("lora");
  });

  it.each([
    [
      "moodyKrea2Mix_v50.safetensors",
      {
        displayName: "Moody Krea 2 Mix v50",
        importType: "model",
        architecture: "krea-2",
      },
    ],
    [
      "cinematic_portrait-SDXL-v2_lora.safetensors",
      {
        displayName: "Cinematic Portrait SDXL v2 LoRA",
        importType: "lora",
        architecture: "stable-diffusion-xl",
      },
    ],
    [
      "paper-cut_textual-inversion_sd1.5.safetensors",
      {
        displayName: "Paper Cut Textual Inversion SD 1.5",
        importType: "embedding",
        architecture: "stable-diffusion-1",
      },
    ],
  ] as const)("prefills import fields from %s", (path, expected) => {
    expect(parseMediaAssetImportFilename(path)).toEqual(expected);
  });
});
