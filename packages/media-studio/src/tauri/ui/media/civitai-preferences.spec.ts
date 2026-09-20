import { describe, expect, it } from "vitest";
import { normalizeCivitaiPreferences } from "./civitai-preferences";
import { CIVITAI_DEFAULT_SEARCH } from "../../../core/media/civitai.js";

describe("Civitai preferences", () => {
  it("restores filters without restoring a pagination cursor or credentials", () => {
    const saved = {
      ...CIVITAI_DEFAULT_SEARCH,
      query: "Age",
      modelType: "LORA",
      baseModel: "SDXL 1.0",
      nsfw: true,
      favorites: true,
      period: "Year",
      tag: "style",
      username: "artist",
    };
    expect(
      normalizeCivitaiPreferences({
        ...saved,
        cursor: "page-3",
        apiKey: "secret",
      }),
    ).toEqual(saved);
  });

  it("rejects malformed values and unknown sort and period choices", () => {
    expect(normalizeCivitaiPreferences(null)).toEqual(CIVITAI_DEFAULT_SEARCH);
    expect(
      normalizeCivitaiPreferences({
        nsfw: "false",
        favorites: 1,
        query: {},
        sort: "invalid",
        period: "invalid",
      }),
    ).toEqual(CIVITAI_DEFAULT_SEARCH);
  });
});
