import { describe, expect, it, vi } from "vitest";
import type { CommandDefinition } from "./command-types";
import { CommandRegistry } from "./command-registry";

const command = (id: string): CommandDefinition => ({
  id,
  title: id,
  group: "Test",
  scope: { kind: "global", ownerId: "app" },
});

describe("CommandRegistry", () => {
  it("registers, notifies, and removes commands", () => {
    const registry = new CommandRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    const dispose = registry.register([command("one"), command("two")]);
    expect(registry.getSnapshot().commands.map(({ id }) => id)).toEqual([
      "one",
      "two",
    ]);
    dispose();
    expect(registry.getSnapshot().commands).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("fails closed for duplicate IDs and recovers after cleanup", () => {
    const registry = new CommandRegistry();
    const disposeFirst = registry.register([command("same")]);
    const disposeSecond = registry.register([command("same")]);
    expect(registry.find("same")).toBeUndefined();
    expect(registry.getSnapshot().duplicateIds).toEqual(new Set(["same"]));
    disposeSecond();
    expect(registry.find("same")?.id).toBe("same");
    disposeFirst();
  });

  it("supports a Strict Mode-like register-dispose-register lifecycle", () => {
    const registry = new CommandRegistry();
    registry.register([command("strict")])();
    const dispose = registry.register([command("strict")]);
    expect(registry.getSnapshot().duplicateIds.size).toBe(0);
    expect(registry.find("strict")?.title).toBe("strict");
    dispose();
  });

  it("updates a registration atomically without a missing-command snapshot", () => {
    const registry = new CommandRegistry();
    const snapshots: string[][] = [];
    registry.subscribe(() => {
      snapshots.push(registry.getSnapshot().commands.map(({ id }) => id));
    });
    const registration = registry.register([command("first")]);
    registration.update([command("second")]);
    expect(snapshots).toEqual([["first"], ["second"]]);
    expect(registry.find("first")).toBeUndefined();
    expect(registry.find("second")?.id).toBe("second");
  });

  it("fails closed for invalid shortcut metadata", () => {
    const registry = new CommandRegistry();
    registry.register([
      { ...command("invalid"), shortcuts: [{ chord: "Mod+BananaKey" }] },
    ]);
    expect(registry.find("invalid")).toBeUndefined();
    expect(registry.getSnapshot().commands).toEqual([]);
    expect(registry.getSnapshot().invalidIds.get("invalid")).toMatch(
      /Unknown key/,
    );
  });
});
