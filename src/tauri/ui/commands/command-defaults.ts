import type { CommandPlatform } from "./command-types";
import { canonicalShortcut } from "./shortcut";

export const DEFAULT_COMMAND_SHORTCUTS = {
  "app.palette.toggle": "Mod+K",
  "app.settings.open": "Mod+,",
  "app.view.chat": "Mod+1",
  "app.view.ralph": "Mod+2",
  "app.view.media": "Mod+3",
  "app.view.marketplace": "Mod+4",
  "app.view.instructions": "Mod+5",
  "app.view.workspaces": "Mod+6",
  "ralph.flow.save": "Mod+S",
  "ralph.flow.undo": "Mod+Z",
  "ralph.flow.redo": "Mod+Shift+Z",
  "ralph.flow.redo-alternate": "Mod+Y",
  "ralph.selection.duplicate": "Mod+D",
  "ralph.flow.clean-layout": "Mod+L",
  "ralph.flow.run": "Mod+Enter",
  "ralph.selection.delete": "Delete",
  "ralph.selection.delete-backspace": "Backspace",
  "media.flow.undo": "Mod+Z",
  "media.flow.redo": "Mod+Shift+Z",
  "media.flow.redo-alternate": "Mod+Y",
  "media.selection.copy": "Mod+C",
  "media.flow.paste": "Mod+V",
} as const;

export type DefaultCommandShortcutId = keyof typeof DEFAULT_COMMAND_SHORTCUTS;

export const getDefaultCommandShortcut = (
  id: DefaultCommandShortcutId,
): string => DEFAULT_COMMAND_SHORTCUTS[id];

export const findDefaultShortcutConflict = (
  chord: string,
  platform: CommandPlatform,
): DefaultCommandShortcutId | null => {
  let candidate: string;
  try {
    candidate = canonicalShortcut(chord, platform);
  } catch {
    return null;
  }
  for (const [id, shortcut] of Object.entries(DEFAULT_COMMAND_SHORTCUTS)) {
    if (canonicalShortcut(shortcut, platform) === candidate) {
      return id as DefaultCommandShortcutId;
    }
  }
  return null;
};
