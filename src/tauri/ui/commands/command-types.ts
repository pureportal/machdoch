export type CommandPlatform = "macos" | "windows" | "linux";

export type CommandRuntime = "tauri" | "browser";

export type CommandFocusKind =
  | "document"
  | "text-entry"
  | "editor"
  | "terminal"
  | "interactive-control"
  | "command-surface";

export type CommandScopeKind =
  | "global"
  | "view"
  | "entity"
  | "component"
  | "overlay";

export interface CommandScope {
  kind: CommandScopeKind;
  ownerId: string;
  viewId?: string;
}

export interface ShortcutSpec {
  chord: string;
  platforms?: readonly CommandPlatform[];
  runtimes?: readonly CommandRuntime[];
  match?: "key" | "code";
  allowRepeat?: boolean;
  allowIn?: readonly CommandFocusKind[];
}

export type CommandAvailability =
  | { state: "enabled" }
  | { state: "disabled"; reason: string }
  | { state: "hidden" };

export interface CommandFocusSnapshot {
  kind: CommandFocusKind;
  ownerPath: readonly string[];
}

export interface CommandOverlaySnapshot {
  id: string;
  kind: "modal" | "non-modal";
  openedAt: number;
  allowGlobalCommands: readonly string[];
  dismiss?: () => void | Promise<void>;
}

export interface CommandContextSnapshot {
  windowKind: "main" | "assistant" | "quick-voice" | "tray";
  platform: CommandPlatform;
  runtime: CommandRuntime;
  activeView: string | null;
  focus: CommandFocusSnapshot;
  overlays: readonly CommandOverlaySnapshot[];
  singleKeyShortcutsEnabled: boolean;
  busyCommands: ReadonlySet<string>;
}

export type CommandResult =
  | { type: "close" }
  | { type: "stay-open" }
  | { type: "push-page"; page: CommandPage }
  | { type: "cancelled" };

export type CommandAction = (
  context: CommandContextSnapshot,
  signal: AbortSignal,
) => CommandResult | void | Promise<CommandResult | void>;

export interface CommandPageItem {
  id: string;
  title: string;
  keywords?: readonly string[];
  current?: boolean;
  numericKey?: "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
  availability?: CommandAvailability;
  execute: CommandAction;
}

export interface CommandPageGroup {
  id: string;
  label?: string;
  items: readonly CommandPageItem[];
}

export interface CommandPage {
  id: string;
  title: string;
  searchPlaceholder: string;
  contextLabel?: string;
  groups: readonly CommandPageGroup[];
  numericSelection?: boolean;
}

export interface CommandDefinition {
  id: string;
  title: string;
  group: string;
  keywords?: readonly string[];
  scope: CommandScope;
  shortcuts?: readonly ShortcutSpec[];
  palette?: "visible" | "hidden";
  order?: number;
  when?: (context: CommandContextSnapshot) => boolean;
  current?: (context: CommandContextSnapshot) => boolean;
  availability?: (context: CommandContextSnapshot) => CommandAvailability;
  overlayPolicy?: "blocked" | "replace-non-modal";
  overrideOf?: string;
  execute?: CommandAction;
  children?: (
    context: CommandContextSnapshot,
    signal: AbortSignal,
  ) => CommandPage | Promise<CommandPage>;
}

export type CommandPresentation = "dialog" | "popover";

export const COMMAND_ENABLED = { state: "enabled" } as const;
export const COMMAND_HIDDEN = { state: "hidden" } as const;
