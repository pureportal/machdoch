import { describe, expect, it } from "vitest";
import { findDefaultShortcutConflict } from "./command-defaults";
import {
  canonicalShortcut,
  eventMatchesShortcut,
  formatShortcut,
  parseShortcut,
  shortcutToAriaKeyShortcuts,
} from "./shortcut";

const keyboardEvent = (
  overrides: Partial<KeyboardEvent> = {},
): Parameters<typeof eventMatchesShortcut>[0] => ({
  key: "k",
  code: "KeyK",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
  keyCode: 0,
  getModifierState: () => false,
  ...overrides,
});

describe("shortcut parsing and matching", () => {
  it("normalizes native and application modifier aliases", () => {
    expect(parseShortcut("CommandOrControl+Alt+V")).toMatchObject({
      mod: true,
      alt: true,
      key: "v",
    });
    expect(canonicalShortcut("CmdOrCtrl+K", "macos")).toBe("meta+k");
    expect(canonicalShortcut("CommandOrCtrl+KeyK", "windows")).toBe(
      "control+k",
    );
    expect(canonicalShortcut("CmdOrControl+Digit1", "windows")).toBe(
      "control+1",
    );
    expect(canonicalShortcut("Super+K", "macos")).toBe("meta+k");
    expect(canonicalShortcut("Mod+K", "windows")).toBe("control+k");
  });

  it("rejects incomplete, repeated, and multi-key chords", () => {
    expect(() => parseShortcut("Mod")).toThrow(/non-modifier/);
    expect(() => parseShortcut("Mod+Mod+K")).toThrow(/Duplicate/);
    expect(() => parseShortcut("Mod+K+P")).toThrow(/exactly one key/);
    expect(() => parseShortcut("Mod+BananaKey")).toThrow(/Unknown key/);
    expect(() =>
      parseShortcut({ chord: "Mod+BananaCode", match: "code" }),
    ).toThrow(/Unknown key/);
  });

  it("expands Mod strictly for each platform and requires exact modifiers", () => {
    expect(
      eventMatchesShortcut(
        keyboardEvent({ ctrlKey: true }),
        { chord: "Mod+K" },
        "windows",
        "tauri",
      ),
    ).toBe(true);
    expect(
      eventMatchesShortcut(
        keyboardEvent({ metaKey: true }),
        { chord: "Mod+K" },
        "macos",
        "tauri",
      ),
    ).toBe(true);
    expect(
      eventMatchesShortcut(
        keyboardEvent({ ctrlKey: true, shiftKey: true }),
        { chord: "Mod+K" },
        "windows",
        "tauri",
      ),
    ).toBe(false);
  });

  it("supports semantic key and explicit physical-code matching", () => {
    const event = keyboardEvent({
      key: "z",
      code: "KeyY",
      ctrlKey: true,
    });
    expect(
      eventMatchesShortcut(event, { chord: "Mod+Z" }, "windows", "tauri"),
    ).toBe(true);
    expect(
      eventMatchesShortcut(
        event,
        { chord: "Mod+KeyY", match: "code" },
        "windows",
        "tauri",
      ),
    ).toBe(true);
  });

  it("ignores composition, dead keys, AltGraph, and repeats by default", () => {
    const spec = { chord: "Mod+K" } as const;
    for (const event of [
      keyboardEvent({ ctrlKey: true, isComposing: true }),
      keyboardEvent({ ctrlKey: true, keyCode: 229 }),
      keyboardEvent({ ctrlKey: true, key: "Dead" }),
      keyboardEvent({ ctrlKey: true, key: "Process" }),
      keyboardEvent({ ctrlKey: true, repeat: true }),
      keyboardEvent({
        ctrlKey: true,
        getModifierState: (key) => key === "AltGraph",
      }),
    ]) {
      expect(eventMatchesShortcut(event, spec, "windows", "tauri")).toBe(false);
    }
    expect(
      eventMatchesShortcut(
        keyboardEvent({ ctrlKey: true, repeat: true }),
        { chord: "Mod+K", allowRepeat: true },
        "windows",
        "tauri",
      ),
    ).toBe(true);
  });

  it("formats visual and assistive-technology shortcut labels per platform", () => {
    expect(formatShortcut("Mod+Shift+Z", "macos")).toBe("⇧⌘Z");
    expect(formatShortcut("Mod+Shift+Z", "windows")).toBe("Ctrl+Shift+Z");
    expect(shortcutToAriaKeyShortcuts("Mod+,", "macos")).toBe("Meta+,");
  });

  it("detects exact native-global collisions without replacing native parsing", () => {
    expect(findDefaultShortcutConflict("CommandOrControl+K", "windows")).toBe(
      "app.palette.toggle",
    );
    expect(findDefaultShortcutConflict("CmdOrControl+KeyK", "windows")).toBe(
      "app.palette.toggle",
    );
    expect(findDefaultShortcutConflict("Super+KeyK", "macos")).toBe(
      "app.palette.toggle",
    );
    expect(findDefaultShortcutConflict("Ctrl+Alt+Q", "windows")).toBeNull();
    expect(
      findDefaultShortcutConflict("not a native accelerator", "windows"),
    ).toBeNull();
  });
});
