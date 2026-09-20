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
      contentMode: "all",
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

  it.each(["normal", "all", "mature"] as const)(
    "restores %s content",
    (contentMode) => {
      expect(normalizeCivitaiPreferences({ contentMode }).contentMode).toBe(
        contentMode,
      );
    },
  );

  it("rejects malformed values and unknown sort and period choices", () => {
    expect(normalizeCivitaiPreferences(null)).toEqual(CIVITAI_DEFAULT_SEARCH);
    expect(
      normalizeCivitaiPreferences({
        contentMode: "invalid",
        favorites: 1,
        query: {},
        sort: "invalid",
        period: "invalid",
      }),
    ).toEqual(CIVITAI_DEFAULT_SEARCH);
  });
});
