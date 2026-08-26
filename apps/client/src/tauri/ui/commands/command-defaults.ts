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
  "chat.composer.focus": "Mod+Shift+M",
  "chat.session.new": "Mod+N",
  "instructions.file.new": "Mod+N",
  "media.activity.recipe.new": "Mod+N",
  "ralph.flow.new": "Mod+N",
  "workspaces.add": "Mod+N",
  "chat.sessions.search": "Mod+Shift+F",
  "chat.session.reasoning.select": "Alt+S",
  "chat.task.cancel": "Mod+.",
  "file-preview.search.focus": "Mod+F",
  "quick-chat.hide": "Escape",
  "quick-voice.hide": "Escape",
  "tray.hide": "Escape",
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
  "media.selection.select-all": "Mod+A",
  "media.selection.delete": "Delete",
  "media.selection.delete-backspace": "Backspace",
  "media.flow.paste": "Mod+V",
  "media.flow.save": "Mod+S",
  "media.section.create": "Alt+1",
  "media.section.assets": "Alt+2",
  "media.section.graph": "Alt+3",
  "media.section.activity": "Alt+4",
  "media.create.generate": "Mod+Enter",
  "media.flow.run": "Mod+Enter",
  "media.library.import": "Mod+O",
  "marketplace.view.discover": "Alt+1",
  "marketplace.view.installed": "Alt+2",
  "marketplace.view.registries": "Alt+3",
  "marketplace.view.advanced": "Alt+4",
  "instructions.file.save": "Mod+S",
  "workspaces.settings.save": "Mod+S",
  "workspaces.terminal.toggle": "Mod+J",
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
