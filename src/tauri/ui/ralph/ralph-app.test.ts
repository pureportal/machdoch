import { describe, expect, it } from "vitest";
import { DEFAULT_RALPH_SETTINGS, type RalphSettings } from "../lib/shell-store";
import type { RuntimeProviderAvailability } from "../runtime";
import {
  getConnectedRalphProviderChoices,
  getRalphProviderChoices,
  normalizeRalphRuntimeSettings,
} from "./ralph-app";

describe("Ralph provider choices", () => {
  it("keeps only connected runnable providers in Ralph provider selectors", () => {
    const availability = [
      { provider: "openai", configured: false },
      { provider: "anthropic", configured: true },
      { provider: "google", configured: false },
      { provider: "codex-cli", configured: true },
      { provider: "claude-cli", configured: true },
      { provider: "copilot-cli", configured: true },
    ] satisfies RuntimeProviderAvailability[];

    expect(getConnectedRalphProviderChoices(availability)).toEqual([
      "anthropic",
      "codex-cli",
      "claude-cli",
      "copilot-cli",
    ]);
    expect(getRalphProviderChoices(availability)).toEqual([
      "anthropic",
      "codex-cli",
      "claude-cli",
      "copilot-cli",
    ]);
  });

  it("keeps the existing no-provider fallback when nothing runnable is connected", () => {
    const availability = [
      { provider: "openai", configured: false },
      { provider: "anthropic", configured: false },
      { provider: "google", configured: false },
      { provider: "codex-cli", configured: false },
    ] satisfies RuntimeProviderAvailability[];

    expect(getRalphProviderChoices(availability)).toEqual([
      "openai",
      "anthropic",
      "google",
      "codex-cli",
      "claude-cli",
      "copilot-cli",
    ]);
  });

  it("keeps Codex CLI when model catalog discovery reports it available", () => {
    const availability = [
      { provider: "openai", configured: false },
      { provider: "anthropic", configured: false },
      { provider: "google", configured: false },
      { provider: "codex-cli", configured: false },
    ] satisfies RuntimeProviderAvailability[];

    expect(
      getRalphProviderChoices(availability, {
        generatedAt: 0,
        providers: [
          {
            provider: "codex-cli",
            available: true,
            models: [{ id: "gpt-5.5", label: "GPT-5.5" }],
          },
        ],
      }),
    ).toEqual(["codex-cli"]);
  });

  it("normalizes stale saved Ralph selections to a connected provider", () => {
    const settings = {
      ...DEFAULT_RALPH_SETTINGS,
      generationProvider: "anthropic",
      generationModel: "claude-opus-4-1",
      generationReasoning: "high",
      runProvider: "openai",
      runModel: "gpt-5.4",
      runReasoning: "low",
    } satisfies RalphSettings;

    const normalized = normalizeRalphRuntimeSettings(settings, ["codex-cli"]);

    expect(normalized).toMatchObject({
      generationProvider: "codex-cli",
      generationModel: "gpt-5.5",
      runProvider: "codex-cli",
      runModel: "gpt-5.5",
    });
    expect(normalized.generationReasoning).toBeUndefined();
    expect(normalized.runReasoning).toBeUndefined();
  });
});
