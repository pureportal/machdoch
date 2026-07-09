import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_APP_SHELL_STATE,
  DEFAULT_MCP_MARKETPLACE_STATE,
  DEFAULT_RALPH_SETTINGS,
  DEFAULT_RUNNING_TASK_MESSAGE_ACTION,
  normalizeAppearanceSettings,
  normalizeAppShellState,
  normalizeMcpMarketplaceState,
  normalizeRalphSettings,
  normalizeRunningTaskMessageAction,
} from "./shell-store-normalizers.helper";

describe("shell-store normalizers", () => {
  it("returns shared defaults for invalid persisted records", () => {
    expect(normalizeAppShellState(null)).toBe(DEFAULT_APP_SHELL_STATE);
    expect(normalizeMcpMarketplaceState(undefined)).toBe(
      DEFAULT_MCP_MARKETPLACE_STATE,
    );
    expect(normalizeRalphSettings("invalid")).toBe(DEFAULT_RALPH_SETTINGS);
    expect(normalizeAppearanceSettings(7)).toBe(
      DEFAULT_APPEARANCE_SETTINGS,
    );
    expect(normalizeRunningTaskMessageAction("invalid")).toBe(
      DEFAULT_RUNNING_TASK_MESSAGE_ACTION,
    );
  });

  it("normalizes app shell state with union fallbacks and numeric timestamps", () => {
    expect(
      normalizeAppShellState({
        activeApp: "marketplace",
        lastViewedAt: {
          chat: 10,
          ralph: "not-a-number",
          marketplace: 30,
        },
      }),
    ).toEqual({
      version: 1,
      activeApp: "marketplace",
      lastViewedAt: {
        chat: 10,
        ralph: DEFAULT_APP_SHELL_STATE.lastViewedAt.ralph,
        marketplace: 30,
      },
    });

    expect(normalizeAppShellState({ activeApp: "settings" }).activeApp).toBe(
      "chat",
    );
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

  it("normalizes appearance settings with allowed union fallbacks", () => {
    expect(
      normalizeAppearanceSettings({
        theme: "light",
        density: "compact",
        accent: "violet",
        quickChatBubbleStyle: "orbit",
      }),
    ).toEqual({
      version: 1,
      theme: "light",
      density: "compact",
      accent: "violet",
      quickChatBubbleStyle: "orbit",
    });

    expect(
      normalizeAppearanceSettings({
        theme: "system",
        density: "cozy",
        accent: "red",
        quickChatBubbleStyle: "unknown",
      }),
    ).toEqual(DEFAULT_APPEARANCE_SETTINGS);
  });
});
