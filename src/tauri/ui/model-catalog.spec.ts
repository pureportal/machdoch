import { describe, expect, it } from "vitest";
import {
  getCatalogModelsForProvider,
  type ProviderModelCatalogSnapshot,
} from "./model-catalog";

describe("provider model catalog", () => {
  it("shows curated Codex CLI fallback models without cross-provider choices", () => {
    expect(
      getCatalogModelsForProvider("codex-cli").map((model) => model.id),
    ).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);

    expect(
      getCatalogModelsForProvider("codex-cli").some(
        (model) => model.id === "auto",
      ),
    ).toBe(false);
    expect(
      getCatalogModelsForProvider("claude-cli").map((model) => model.id),
    ).toEqual(["sonnet", "opus", "haiku", "fable"]);
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

  it("treats live Codex CLI models as authoritative", () => {
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
            { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
            { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
            { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
            { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
            { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
            { id: "gpt-5.2", label: "GPT-5.2" },
            {
              id: "gpt-5.1",
              label: "GPT-5.1",
              stage: "legacy-deprecated",
            },
            { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
            { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
          ],
        },
      ],
    } satisfies ProviderModelCatalogSnapshot;

    expect(
      getCatalogModelsForProvider("codex-cli", snapshot).map(
        (model) => model.id,
      ),
    ).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
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
            { id: "gpt-4.1" },
            { id: "gpt-5.6-sol", releaseDate: "2026-06-26" },
            { id: "gpt-5.6-terra", releaseDate: "2026-06-26" },
            { id: "gpt-5.6-luna", releaseDate: "2026-06-26" },
            { id: "o4-mini" },
          ],
        },
      ],
    } satisfies ProviderModelCatalogSnapshot;

    expect(
      getCatalogModelsForProvider("openai", snapshot).map((model) => model.id),
    ).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.4-mini",
    ]);
  });

  it("keeps current Anthropic runtime models including Claude 5 families", () => {
    const snapshot = {
      generatedAt: 1,
      providers: [
        {
          provider: "anthropic",
          source: "provider-api",
          available: true,
          models: [
            { id: "claude-3-7-sonnet-20250219" },
            { id: "claude-sonnet-5" },
            { id: "claude-fable-5" },
            { id: "claude-opus-4-8" },
            { id: "claude-haiku-4-5" },
            { id: "claude-sonnet-4-5-20250929" },
          ],
        },
      ],
    } satisfies ProviderModelCatalogSnapshot;

    expect(
      getCatalogModelsForProvider("anthropic", snapshot).map(
        (model) => model.id,
      ),
    ).toEqual([
      "claude-sonnet-5",
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-haiku-4-5",
      "claude-sonnet-4-5-20250929",
    ]);
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
            { id: "gemini-3.5-flash-preview-09-2025" },
            { id: "gemini-3.1-pro-preview" },
            { id: "gemini-3.1-flash-latest" },
            { id: "gemini-3.1-flash-lite" },
            { id: "gemini-3.5-flash" },
            { id: "gemini-flash-latest" },
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
      "gemini-3.5-flash-preview-09-2025",
      "gemini-3.1-flash-lite",
      "gemini-3.1-pro-preview",
      "gemini-3.1-flash-latest",
      "gemini-3-flash-preview",
      "gemini-2.5-flash-lite",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-flash-latest",
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
            { id: "gpt-4.1" },
            { id: "o4-mini" },
            { id: "langdock-llama-3.3-70b-2" },
            { id: "claude-3-7-sonnet-20250219" },
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
