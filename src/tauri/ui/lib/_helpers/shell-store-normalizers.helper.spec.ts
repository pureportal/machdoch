import { describe, expect, it } from "vitest";
import {
  DEFAULT_MCP_MARKETPLACE_STATE,
  DEFAULT_RALPH_SETTINGS,
  DEFAULT_TERMINAL_PROFILE_SETTINGS,
  normalizeMcpMarketplaceState,
  normalizeRalphSettings,
  normalizeTerminalProfileSettings,
} from "./shell-store-normalizers.helper";

describe("Shell store normalizers", () => {
  it("returns shared defaults for invalid persisted records", () => {
    expect(normalizeMcpMarketplaceState(undefined)).toBe(
      DEFAULT_MCP_MARKETPLACE_STATE,
    );
    expect(normalizeRalphSettings("invalid")).toBe(DEFAULT_RALPH_SETTINGS);
    expect(normalizeMcpMarketplaceState({ registries: [] })).toBe(
      DEFAULT_MCP_MARKETPLACE_STATE,
    );
    expect(normalizeRalphSettings({ workspaceRoot: "C:\\Project" })).toBe(
      DEFAULT_RALPH_SETTINGS,
    );
  });

  it("trims valid Ralph string fields and preserves allowed modes", () => {
    expect(
      normalizeRalphSettings({
        version: 1,
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
      version: 1,
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
      version: 1,
      generationPromptHistory: [7, "", "   ", ...promptHistory],
    });

    expect(normalized.generationPromptHistory).toHaveLength(40);
    expect(normalized.generationPromptHistory?.[0]).toBe("prompt-3");
    expect(normalized.generationPromptHistory?.at(-1)).toBe("prompt-42");
  });

  it("floors positive defaultMaxTransitions and omits invalid values", () => {
    expect(
      normalizeRalphSettings({ version: 1, defaultMaxTransitions: 5.9 }),
    ).toMatchObject({
      defaultMaxTransitions: 5,
    });

    expect(
      normalizeRalphSettings({ version: 1, defaultMaxTransitions: 0 }),
    ).not.toHaveProperty("defaultMaxTransitions");
    expect(
      normalizeRalphSettings({
        version: 1,
        defaultMaxTransitions: Number.POSITIVE_INFINITY,
      }),
    ).not.toHaveProperty("defaultMaxTransitions");
  });

  it("filters marketplace registries while trimming required fields", () => {
    expect(
      normalizeMcpMarketplaceState({
        version: 1,
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

  it("normalizes terminal profile identifiers", () => {
    expect(
      normalizeTerminalProfileSettings({
        version: 1,
        visibleShellIds: [" pwsh ", "windows-powershell", "pwsh", " ", 7],
        defaultShellId: " windows-powershell ",
      }),
    ).toEqual({
      version: 1,
      visibleShellIds: ["pwsh", "windows-powershell"],
      defaultShellId: "windows-powershell",
    });
  });

  it("falls back invalid terminal profile settings", () => {
    expect(normalizeTerminalProfileSettings(undefined)).toBe(
      DEFAULT_TERMINAL_PROFILE_SETTINGS,
    );
    expect(
      normalizeTerminalProfileSettings({
        version: 1,
        visibleShellIds: "pwsh",
        defaultShellId: " ",
      }),
    ).toEqual(DEFAULT_TERMINAL_PROFILE_SETTINGS);
  });
});
