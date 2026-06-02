import { describe, expect, it } from "vitest";
import {
  getCatalogModelsForProvider,
  type ProviderModelCatalogSnapshot,
} from "./model-catalog";

describe("provider model catalog", () => {
  it("treats live provider catalogs as authoritative and filters OpenAI special-purpose models", () => {
    const snapshot = {
      generatedAt: 1,
      providers: [
        {
          provider: "openai",
          source: "provider-api",
          available: true,
          models: [
            { id: "gpt-5.4-mini" },
            { id: "gpt-4o-realtime-preview" },
            { id: "gpt-5.5-audio-preview" },
            { id: "computer-use-preview" },
            { id: "o4-mini" },
          ],
        },
      ],
    } satisfies ProviderModelCatalogSnapshot;

    expect(
      getCatalogModelsForProvider("openai", snapshot).map((model) => model.id),
    ).toEqual(["gpt-5.4-mini"]);
  });

  it("caps Google live catalogs to the newest five mainline Gemini models", () => {
    const snapshot = {
      generatedAt: 1,
      providers: [
        {
          provider: "google",
          source: "provider-api",
          available: true,
          models: [
            { id: "gemini-embedding-001" },
            { id: "gemini-2.5-pro" },
            { id: "gemini-2.5-flash" },
            { id: "gemini-2.5-flash-lite" },
            { id: "gemini-3-flash-preview" },
            { id: "gemini-3.1-pro-preview" },
            { id: "gemini-3.1-flash-lite" },
            { id: "gemini-3.5-flash" },
            { id: "gemini-3.5-flash-tts-preview" },
            { id: "gemini-live-2.5-flash-preview" },
          ],
        },
      ],
    } satisfies ProviderModelCatalogSnapshot;

    expect(
      getCatalogModelsForProvider("google", snapshot).map((model) => model.id),
    ).toEqual([
      "gemini-3.5-flash",
      "gemini-3.1-flash-lite",
      "gemini-3.1-pro-preview",
      "gemini-3-flash-preview",
      "gemini-2.5-flash-lite",
    ]);
  });
});
