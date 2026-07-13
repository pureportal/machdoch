import { describe, expect, it } from "vitest";
import {
  getCatalogModelsForProvider,
  type ProviderModelCatalogSnapshot,
} from "./model-catalog";

describe("provider model catalog", () => {
  it("returns no models without a successful provider model-list response", () => {
    expect(getCatalogModelsForProvider("codex-cli")).toEqual([]);
    expect(getCatalogModelsForProvider("claude-cli")).toEqual([]);
    expect(getCatalogModelsForProvider("copilot-cli")).toEqual([]);

    const unavailableSnapshot = {
      generatedAt: 1,
      providers: [
        {
          provider: "openai",
          source: "provider-api",
          available: false,
          error: "OPENAI_API_KEY is not configured.",
          models: [{ id: "gpt-5.5", label: "GPT-5.5" }],
        },
      ],
    } satisfies ProviderModelCatalogSnapshot;

    expect(
      getCatalogModelsForProvider("openai", unavailableSnapshot),
    ).toEqual([]);
  });

  it("keeps Auto first while treating the live Copilot catalog as authoritative", () => {
    const snapshot = {
      generatedAt: 1,
      providers: [
        {
          provider: "copilot-cli",
          source: "provider-sdk",
          available: true,
          models: [
            { id: "gpt-5.5", label: "GPT-5.5" },
            { id: "auto", label: "Auto" },
            { id: "mai-code-1-flash", label: "MAI-Code-1-Flash" },
            { id: "kimi-k2.7-code", label: "Kimi K2.7 Code" },
          ],
        },
      ],
    } satisfies ProviderModelCatalogSnapshot;

    expect(getCatalogModelsForProvider("copilot-cli", snapshot)).toEqual([
      { id: "auto", label: "Auto" },
      { id: "gpt-5.5", label: "GPT-5.5" },
      { id: "mai-code-1-flash", label: "MAI-Code-1-Flash" },
      { id: "kimi-k2.7-code", label: "Kimi K2.7 Code" },
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

  it("title-cases named GPT-5.6 tiers from label-less live catalogs", () => {
    const snapshot = {
      generatedAt: 1,
      providers: [
        {
          provider: "codex-cli",
          source: "provider-probe",
          available: true,
          models: [
            { id: "gpt-5.6-sol" },
            { id: "gpt-5.6-terra" },
            { id: "gpt-5.6-luna" },
          ],
        },
      ],
    } satisfies ProviderModelCatalogSnapshot;

    expect(getCatalogModelsForProvider("codex-cli", snapshot)).toEqual([
      { id: "gpt-5.6-sol", label: "GPT 5.6 Sol" },
      { id: "gpt-5.6-terra", label: "GPT 5.6 Terra" },
      { id: "gpt-5.6-luna", label: "GPT 5.6 Luna" },
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
