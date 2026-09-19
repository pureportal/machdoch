import { describe, expect, it } from "vitest";
import {
  civitaiFileSize,
  civitaiImportArchitecture,
  civitaiModelUrl,
  civitaiRequestedVersion,
  civitaiVisibleImages,
  isCivitaiLookup,
  type CivitaiModel,
  type CivitaiVersion,
} from "./civitai.js";

describe("Civitai resource selection", () => {
  it("keeps Pony separate from SDXL when the file shares SDXL tensors", () => {
    expect(civitaiImportArchitecture("stable-diffusion-xl", "pony")).toBe(
      "pony",
    );
    expect(
      civitaiImportArchitecture("stable-diffusion-xl", "stable-diffusion-xl"),
    ).toBe("stable-diffusion-xl");
    expect(civitaiImportArchitecture(null, "krea-2")).toBe("krea-2");
    expect(() => civitaiImportArchitecture("flux-1", "pony")).toThrow(
      "does not match",
    );
  });
  it("preserves versions in red, API, download, and AIR links", () => {
    for (const source of [
      "https://civitai.red/models/12/name?modelVersionId=34",
      "https://civitai.com/api/download/models/34",
      "https://civitai.com/api/v1/model-versions/34",
      "https://civitai.com/models/12/versions/34",
      "urn:air:sdxl:lora:civitai:12@34",
      "12@34",
    ]) {
      expect(civitaiRequestedVersion(source)).toBe(34);
      expect(isCivitaiLookup(source)).toBe(true);
    }
    expect(civitaiRequestedVersion("watercolors")).toBeNull();
    expect(isCivitaiLookup("watercolors")).toBe(false);
    expect(isCivitaiLookup("b".repeat(64))).toBe(true);
  });

  it("links mature resources to red without exposing download credentials", () => {
    expect(civitaiModelUrl({ id: 12, nsfw: true }, 34)).toBe(
      "https://civitai.red/models/12?modelVersionId=34",
    );
    expect(civitaiModelUrl({ id: 12, nsfw: false })).toBe(
      "https://civitai.com/models/12",
    );
  });

  it("filters mature previews at image and model level, and rejects non-image URLs", () => {
    const model: CivitaiModel = {
      id: 1,
      name: "Test",
      type: "LORA",
      nsfw: false,
      description: null,
      matchedVersionId: null,
      tags: [],
      creator: null,
      stats: null,
      modelVersions: [],
    };
    const version: CivitaiVersion = {
      id: 2,
      name: "v1",
      baseModel: "SDXL 1.0",
      publishedAt: null,
      trainedWords: [],
      files: [],
      images: [
        {
          url: "https://image.civitai.com/safe.jpeg",
          width: 800,
          height: 600,
          nsfw: false,
          nsfwLevel: 1,
          type: "image",
          meta: null,
        },
        {
          url: "https://image.civitai.com/mature.jpeg",
          width: 800,
          height: 600,
          nsfw: false,
          nsfwLevel: 4,
          type: "image",
          meta: null,
        },
        {
          url: "https://image.civitai.com/video.mp4",
          width: 800,
          height: 600,
          nsfw: false,
          nsfwLevel: 1,
          type: "video",
          meta: null,
        },
        {
          url: "https://example.com/image.jpeg",
          width: 800,
          height: 600,
          nsfw: false,
          nsfwLevel: 1,
          type: "image",
          meta: null,
        },
      ],
    };
    expect(
      civitaiVisibleImages(model, version, false).map((image) => image.url),
    ).toEqual(["https://image.civitai.com/safe.jpeg"]);
    expect(civitaiVisibleImages(model, version, true)).toHaveLength(2);
    expect(
      civitaiVisibleImages({ ...model, nsfw: true }, version, false),
    ).toEqual([]);
  });

  it("shows useful download sizes for embeddings and checkpoints", () => {
    expect(civitaiFileSize(2 * 1024 ** 2)).toBe("2 MB");
    expect(civitaiFileSize(6 * 1024 ** 3)).toBe("6 GB");
  });
});
