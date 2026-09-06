import { describe, expect, it } from "vitest";
import { SETTINGS_SECTIONS } from "./session-shell";
import { matchesSettingsSearch } from "./settings-search";

describe("Settings search", () => {
  it.each([
    ["speech rate", "voice"],
    ["startup delay", "workspace-run"],
    ["health-check threshold", "workspace-run"],
    ["  ACCENT   color ", "appearance"],
    ["retention", "desktop"],
    ["quick chat shortcut", "desktop"],
    ["Recraft key", "providers"],
  ])("finds %s", (query, expected) => {
    const results = SETTINGS_SECTIONS.filter((section) =>
      matchesSettingsSearch(
        [section.label, section.description, ...section.keywords].join(" "),
        query,
      ),
    );
    expect(results.map((section) => section.id)).toEqual([expected]);
  });

  it("requires all search terms", () => {
    expect(
      matchesSettingsSearch("Theme density accent", "accent microphone"),
    ).toBe(false);
  });
});
