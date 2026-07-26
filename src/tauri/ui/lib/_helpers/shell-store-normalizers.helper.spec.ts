import { describe, expect, it } from "vitest";
import {
  DEFAULT_MCP_MARKETPLACE_STATE,
  DEFAULT_RALPH_SETTINGS,
  normalizeMcpMarketplaceState,
  normalizeRalphSettings,
} from "./shell-store-normalizers.helper";

describe("Ralph and marketplace store normalizers", () => {
  it("returns shared defaults for invalid persisted records", () => {
    expect(normalizeMcpMarketplaceState(undefined)).toBe(
      DEFAULT_MCP_MARKETPLACE_STATE,
    );
    expect(normalizeRalphSettings("invalid")).toBe(DEFAULT_RALPH_SETTINGS);
  });

  it("trims valid Ralph string fields and preserves allowed modes", () => {
    expect(
      normalizeRalphSettings({
        workspaceRoot: " C:\\Project ",
        flowLibraryMode: "all",
        generationProvider: "anthropic",
        generationModel: " claude-custom ",
        generationReasoning: "high",
        runProvider: "google",
        runModel: " gemini-custom ",
        runReasoning: "low",
      }),
    ).toMatchObject({
      version: 1,
      workspaceRoot: "C:\\Project",
      flowLibraryMode: "all",
      generationProvider: "anthropic",
      generationModel: "claude-custom",
      generationReasoning: "high",
      runProvider: "google",
      runModel: "gemini-custom",
      runReasoning: "low",
      generationPromptHistory: [],
    });
  });

  it("falls back invalid Ralph unions and models to provider defaults", () => {
    const normalized = normalizeRalphSettings({
      workspaceRoot: "   ",
      flowLibraryMode: "invalid",
      generationProvider: "invalid",
      generationModel: " ",
      generationReasoning: "invalid",
      runProvider: "invalid",
      runModel: null,
      runReasoning: "invalid",
    });

    expect(normalized).toEqual({
      ...DEFAULT_RALPH_SETTINGS,
      generationPromptHistory: [],
    });
    expect(normalized.generationReasoning).toBeUndefined();
    expect(normalized.runReasoning).toBeUndefined();
  });

  it("keeps the latest 40 trimmed Ralph generation prompts", () => {
    const promptHistory = Array.from(
      { length: 42 },
      (_, index) => ` prompt-${index + 1} `,
    );

    const normalized = normalizeRalphSettings({
      generationPromptHistory: [
        7,
        "",
        "   ",
        ...promptHistory,
      ],
    });

    expect(normalized.generationPromptHistory).toHaveLength(40);
    expect(normalized.generationPromptHistory?.[0]).toBe("prompt-3");
    expect(normalized.generationPromptHistory?.at(-1)).toBe("prompt-42");
  });

  it("floors positive defaultMaxTransitions and omits invalid values", () => {
    expect(
      normalizeRalphSettings({ defaultMaxTransitions: 5.9 }),
    ).toMatchObject({
      defaultMaxTransitions: 5,
    });

    expect(
      normalizeRalphSettings({ defaultMaxTransitions: 0 }),
    ).not.toHaveProperty("defaultMaxTransitions");
    expect(
      normalizeRalphSettings({ defaultMaxTransitions: Number.POSITIVE_INFINITY }),
    ).not.toHaveProperty("defaultMaxTransitions");
  });

  it("filters marketplace registries while trimming required fields", () => {
    expect(
      normalizeMcpMarketplaceState({
        registries: [
          null,
          {
            id: " official ",
            title: " Official ",
            baseUrl: " https://registry.example.test ",
            enabled: false,
          },
          {
            id: "missing-title",
            title: "",
            baseUrl: "https://registry.example.test",
          },
        ],
      }),
    ).toEqual({
      version: 1,
      registries: [
        {
          id: "official",
          title: "Official",
          baseUrl: "https://registry.example.test",
          enabled: false,
        },
      ],
    });
  });

});
