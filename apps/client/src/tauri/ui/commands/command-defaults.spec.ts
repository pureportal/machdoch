import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMMAND_SHORTCUTS,
  type DefaultCommandShortcutId,
} from "./command-defaults";
import { canonicalShortcut } from "./shortcut";
import type { CommandPlatform } from "./command-types";

const INTENTIONAL_SHARED_BINDINGS = [
  [
    "chat.session.new",
    "instructions.file.new",
    "media.activity.recipe.new",
    "ralph.flow.new",
    "workspaces.add",
  ],
  [
    "instructions.file.save",
    "media.flow.save",
    "ralph.flow.save",
    "workspaces.settings.save",
  ],
  ["media.flow.undo", "ralph.flow.undo"],
  ["media.flow.redo", "ralph.flow.redo"],
  ["media.flow.redo-alternate", "ralph.flow.redo-alternate"],
  ["media.create.generate", "media.flow.run", "ralph.flow.run"],
  ["media.selection.delete", "ralph.selection.delete"],
  ["media.selection.delete-backspace", "ralph.selection.delete-backspace"],
  ["marketplace.view.discover", "media.section.create"],
  ["marketplace.view.installed", "media.section.assets"],
  ["marketplace.view.registries", "media.section.graph"],
  ["marketplace.view.advanced", "media.section.activity"],
  ["quick-chat.hide", "quick-voice.hide", "tray.hide"],
] as const satisfies readonly (readonly DefaultCommandShortcutId[])[];

const sharedBindings = (platform: CommandPlatform): string[][] => {
  const byChord = new Map<string, string[]>();
  for (const [id, shortcut] of Object.entries(DEFAULT_COMMAND_SHORTCUTS)) {
    const chord = canonicalShortcut(shortcut, platform);
    const ids = byChord.get(chord) ?? [];
    ids.push(id);
    byChord.set(chord, ids);
  }
  return [...byChord.values()]
    .filter((ids) => ids.length > 1)
    .map((ids) => ids.sort())
    .sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
};

describe("default command shortcuts", () => {
  it.each(["macos", "windows", "linux"] as const)(
    "contains only the audited shared bindings on %s",
    (platform) => {
      const expected = INTENTIONAL_SHARED_BINDINGS.map((ids) =>
        [...ids].sort(),
      ).sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
      expect(sharedBindings(platform)).toEqual(expected);
    },
  );

  it("keeps every shortcut canonicalizable on every platform", () => {
    for (const platform of ["macos", "windows", "linux"] as const) {
      for (const shortcut of Object.values(DEFAULT_COMMAND_SHORTCUTS)) {
        expect(() => canonicalShortcut(shortcut, platform)).not.toThrow();
      }
    }
  });
});
