import { describe, expect, it } from "vitest";
import {
  applyMediaAssetMetadataToAddon,
  createEmptyMediaGenerationAssetMetadata,
  isMediaCivitaiSourceUrl,
  normalizeMediaCivitaiSampleImageUrl,
  normalizeMediaExternalLink,
  normalizeMediaTriggerWords,
  parseMediaTriggerWords,
} from "./asset-metadata.js";
import type { MediaModelAddonDescriptor } from "./contracts.js";

describe("media asset metadata links", () => {
  it("accepts credential-free HTTPS links", () => {
    expect(normalizeMediaExternalLink("https://example.com/model?id=4")).toBe(
      "https://example.com/model?id=4",
    );
    expect(normalizeMediaExternalLink("http://example.com/model")).toBeNull();
    expect(
      normalizeMediaExternalLink("https://user@example.com/model"),
    ).toBeNull();
  });

  it("accepts sample images only from Civitai image hosts", () => {
    expect(
      normalizeMediaCivitaiSampleImageUrl(
        "https://image.civitai.com/example.webp",
      ),
    ).toBe("https://image.civitai.com/example.webp");
    expect(
      normalizeMediaCivitaiSampleImageUrl("https://example.com/image.webp"),
    ).toBeNull();
  });

  it("recognizes both supported Civitai source domains", () => {
    expect(isMediaCivitaiSourceUrl("https://civitai.com/models/123")).toBe(
      true,
    );
    expect(isMediaCivitaiSourceUrl("https://civitai.red/models/123")).toBe(
      true,
    );
    expect(isMediaCivitaiSourceUrl("https://example.com/models/123")).toBe(
      false,
    );
  });
});

describe("media asset trigger words", () => {
  it("normalizes whitespace, line breaks, and case-insensitive duplicates", () => {
    const normalized = normalizeMediaTriggerWords(
      " hero pose,  cinematic   lighting\nHERO POSE,red dress ",
    );

    expect(normalized).toBe("hero pose, cinematic lighting, red dress");
    expect(parseMediaTriggerWords(normalized)).toEqual([
      "hero pose",
      "cinematic lighting",
      "red dress",
    ]);
  });

  it("applies edited trigger words to generation add-ons", () => {
    const addon = {
      kind: "lora",
      triggerWords: ["original"],
      defaultToken: null,
    } as MediaModelAddonDescriptor;
    const metadata = {
      ...createEmptyMediaGenerationAssetMetadata(),
      triggerWords: "edited phrase, Second Phrase",
    };

    expect(
      applyMediaAssetMetadataToAddon(addon, metadata).triggerWords,
    ).toEqual(["edited phrase", "Second Phrase"]);
  });
});
