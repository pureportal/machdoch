import { describe, expect, it } from "vitest";
import {
  getCatalogModelsForProvider,
  type ProviderModelCatalogSnapshot,
} from "./model-catalog";

describe("provider model catalog", () => {
  it("shows curated Codex CLI fallback models without Copilot CLI auto selection", () => {
    expect(
      getCatalogModelsForProvider("codex-cli").map((model) => model.id),
    ).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "gemini-3.1-pro-preview",
      "gemini-3.5-flash",
    ]);

    expect(
      getCatalogModelsForProvider("codex-cli").some(
        (model) => model.id === "auto",
      ),
    ).toBe(false);
    expect(
      getCatalogModelsForProvider("claude-cli").map((model) => model.id),
    ).toEqual([
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
    expect(
      getCatalogModelsForProvider("copilot-cli").map((model) => model.id),
    ).toEqual([
      "auto",
      "claude-sonnet-4.6",
      "gpt-5.4",
      "claude-haiku-4.5",
      "gpt-5.3-codex",
      "gemini-3.1-pro-preview",
      "gemini-3.5-flash",
    ]);
  });

  it("keeps live Codex CLI models while appending curated custom-provider options", () => {
    const snapshot = {
      generatedAt: 1,
      providers: [
        {
          provider: "codex-cli",
          source: "provider-probe",
          available: true,
          models: [
            { id: "gpt-5.5", label: "GPT-5.5" },
            { id: "gpt-5.4", label: "GPT-5.4" },
            { id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
          ],
        },
      ],
    } satisfies ProviderModelCatalogSnapshot;

    expect(
      getCatalogModelsForProvider("codex-cli", snapshot).map(
        (model) => model.id,
      ),
    ).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "gemini-3.1-pro-preview",
      "gemini-3.5-flash",
    ]);
  });

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

  it("caps Google live catalogs to the newest mainline Gemini models", () => {
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
      "gemini-2.5-pro",
      "gemini-2.5-flash",
    ]);
  });

  it("keeps Langdock OpenAI-compatible runtime chat models", () => {
    const snapshot = {
      generatedAt: 1,
      providers: [
        {
          provider: "langdock",
          source: "provider-api",
          available: true,
          models: [
            { id: "text-embedding-3-large" },
            { id: "gpt-5.5" },
            { id: "gpt-5.4" },
            { id: "gpt-5.4-mini" },
            { id: "gpt-5.2-pro" },
            { id: "o4-mini" },
            { id: "langdock-llama-3.3-70b-2" },
            { id: "langdock-image-generator" },
          ],
        },
      ],
    } satisfies ProviderModelCatalogSnapshot;

    expect(
      getCatalogModelsForProvider("langdock", snapshot).map((model) => model.id),
    ).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.2-pro",
      "langdock-llama-3.3-70b-2",
      "o4-mini",
    ]);
  });
});
