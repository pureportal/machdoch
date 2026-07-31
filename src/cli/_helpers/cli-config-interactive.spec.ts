import { vi } from "vitest";
import {
  moveMenuSelection,
  runInteractiveConfig,
} from "./cli-config-interactive.ts";
import { CLI_CONFIG_SETTING_DEFINITIONS } from "./cli-config-commands.ts";
import type { CliConfigEntry } from "./cli-config-commands.ts";
import type { InteractiveConfigPrompter } from "./cli-config-interactive.ts";

describe("moveMenuSelection", () => {
  it("wraps arrow navigation and supports home and end", () => {
    expect(moveMenuSelection(0, "up", 3)).toBe(2);
    expect(moveMenuSelection(2, "down", 3)).toBe(0);
    expect(moveMenuSelection(2, "home", 3)).toBe(0);
    expect(moveMenuSelection(0, "end", 3)).toBe(2);
    expect(moveMenuSelection(1, "x", 3)).toBe(1);
  });
});

describe("runInteractiveConfig", () => {
  it("navigates categories and persists a selected value", async () => {
    const selections = [
      "Workspace",
      "workspace.mode",
      "ask",
      "__back",
      "__done",
    ];
    const statuses: string[] = [];
    const prompter: InteractiveConfigPrompter = {
      select: vi.fn(async () => selections.shift()),
      input: vi.fn(async () => undefined),
      status: (message) => statuses.push(message),
      close: vi.fn(),
    };
    const definition = CLI_CONFIG_SETTING_DEFINITIONS.find(
      (entry) => entry.setting === "workspace.mode",
    );
    expect(definition).toBeDefined();
    const entry: CliConfigEntry = {
      ...definition!,
      value: "machdoch",
      source: "default",
    };
    const saveSetting = vi.fn(async () => ({
      setting: "workspace.mode",
      scope: "workspace" as const,
      configPath: "C:/workspace/.machdoch/config.json",
      status: "configured",
      value: "ask",
    }));

    await runInteractiveConfig("C:/workspace", {
      prompter,
      loadEntries: async () => [entry],
      saveSetting,
    });

    expect(saveSetting).toHaveBeenCalledWith(
      "C:/workspace",
      "workspace.mode",
      "ask",
    );
    expect(statuses).toEqual(["workspace.mode updated."]);
    expect(prompter.close).toHaveBeenCalledWith("Configuration complete.");
  });
});
