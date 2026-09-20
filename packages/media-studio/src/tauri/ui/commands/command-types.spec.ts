import { describe, expect, it } from "vitest";
import { asPaletteCommands, type CommandDefinition } from "./command-types";

describe("asPaletteCommands", () => {
  it("marks a stable command table as palette-visible without mutating it", () => {
    const command = Object.freeze({
      id: "test.visible",
      title: "Visible action",
      group: "Test",
      scope: { kind: "view", ownerId: "chat" },
    } satisfies CommandDefinition);
    const commands = Object.freeze([command]);

    const visible = asPaletteCommands(commands);

    expect(visible).toEqual([{ ...command, palette: "visible" }]);
    expect(visible[0]).not.toBe(command);
    expect("palette" in command).toBe(false);
  });
});
