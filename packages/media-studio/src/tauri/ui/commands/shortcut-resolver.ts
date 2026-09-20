import type {
  CommandAvailability,
  CommandContextSnapshot,
  CommandDefinition,
  CommandFocusKind,
  CommandPlatform,
  CommandRuntime,
  ShortcutSpec,
} from "./command-types";
import {
  eventMatchesShortcut,
  isCharacterOnlyShortcut,
  parseShortcut,
} from "./shortcut";

export type ShortcutResolution =
  | { type: "none" }
  | {
      type: "command";
      command: CommandDefinition;
      shortcut: ShortcutSpec;
      availability: CommandAvailability;
      preventDefault: boolean;
    }
  | { type: "conflict"; commandIds: readonly string[]; preventDefault: false };

interface Candidate {
  command: CommandDefinition;
  shortcut: ShortcutSpec;
  availability: CommandAvailability;
  precedence: number;
  ownerDepth: number;
}

const SCOPE_PRECEDENCE: Readonly<
  Record<CommandDefinition["scope"]["kind"], number>
> = {
  global: 0,
  view: 1,
  entity: 2,
  component: 3,
  overlay: 4,
};

export const isCommandScopeActive = (
  command: CommandDefinition,
  context: CommandContextSnapshot,
): boolean => {
  const { scope } = command;
  if (scope.kind === "global") return true;
  if (scope.viewId && context.activeView !== scope.viewId) return false;
  if (scope.kind === "view") {
    return context.activeView === (scope.viewId ?? scope.ownerId);
  }
  if (scope.kind === "overlay") {
    return context.overlays.some((overlay) => overlay.id === scope.ownerId);
  }
  return context.focus.ownerPath.includes(scope.ownerId);
};

export const isCommandAllowedByOverlay = (
  command: CommandDefinition,
  context: CommandContextSnapshot,
): boolean => {
  const top = context.overlays[context.overlays.length - 1];
  if (!top) return true;
  if (command.scope.kind === "overlay" && command.scope.ownerId === top.id)
    return true;
  if (top.allowGlobalCommands.includes(command.id)) return true;
  if (top.kind === "modal") return false;
  return command.overlayPolicy === "replace-non-modal";
};

const DEFAULT_MODIFIED_FOCUS: readonly CommandFocusKind[] = [
  "document",
  "text-entry",
  "interactive-control",
  "command-surface",
];

const isAllowedInFocus = (
  shortcut: ShortcutSpec,
  context: CommandContextSnapshot,
  command: CommandDefinition,
): boolean => {
  const parsed = parseShortcut(shortcut);
  if (isCharacterOnlyShortcut(parsed) && !context.singleKeyShortcutsEnabled)
    return false;
  if (shortcut.allowIn) return shortcut.allowIn.includes(context.focus.kind);
  const modified = parsed.mod || parsed.control || parsed.meta || parsed.alt;
  return modified
    ? command.scope.kind === "global"
      ? DEFAULT_MODIFIED_FOCUS.includes(context.focus.kind)
      : ["document", "interactive-control"].includes(context.focus.kind)
    : context.focus.kind === "document";
};

export const getCommandAvailability = (
  command: CommandDefinition,
  context: CommandContextSnapshot,
): CommandAvailability => {
  if (context.busyCommands.has(command.id)) {
    return { state: "disabled", reason: "Command is already running" };
  }
  return command.availability?.(context) ?? { state: "enabled" };
};

const hasOverrideCycle = (
  start: Candidate,
  candidates: readonly Candidate[],
): boolean => {
  const byId = new Map(
    candidates.map((candidate) => [candidate.command.id, candidate]),
  );
  const seen = new Set<string>();
  let current: Candidate | undefined = start;
  while (current?.command.overrideOf) {
    if (seen.has(current.command.id)) return true;
    seen.add(current.command.id);
    current = byId.get(current.command.overrideOf);
  }
  return false;
};

const removeOverridden = (
  candidates: readonly Candidate[],
): readonly Candidate[] =>
  candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) =>
          other.command.id !== candidate.command.id &&
          other.command.overrideOf === candidate.command.id &&
          !hasOverrideCycle(other, candidates),
      ),
  );

export const resolveShortcut = (
  event: Pick<
    KeyboardEvent,
    | "key"
    | "code"
    | "ctrlKey"
    | "metaKey"
    | "altKey"
    | "shiftKey"
    | "repeat"
    | "isComposing"
    | "keyCode"
    | "getModifierState"
  >,
  commands: readonly CommandDefinition[],
  context: CommandContextSnapshot,
): ShortcutResolution => {
  const candidates: Candidate[] = [];
  for (const command of commands) {
    if (!command.shortcuts || command.shortcuts.length === 0) continue;
    if (
      !isCommandScopeActive(command, context) ||
      !isCommandAllowedByOverlay(command, context)
    )
      continue;
    if (command.when && !command.when(context)) continue;
    const availability = getCommandAvailability(command, context);
    if (availability.state === "hidden") continue;
    for (const shortcut of command.shortcuts) {
      if (!isAllowedInFocus(shortcut, context, command)) continue;
      if (
        eventMatchesShortcut(event, shortcut, context.platform, context.runtime)
      ) {
        candidates.push({
          command,
          shortcut,
          availability,
          precedence: SCOPE_PRECEDENCE[command.scope.kind],
          ownerDepth:
            command.scope.kind === "entity" ||
            command.scope.kind === "component"
              ? context.focus.ownerPath.indexOf(command.scope.ownerId)
              : 0,
        });
        break;
      }
    }
  }

  if (candidates.length === 0) return { type: "none" };
  const maxPrecedence = Math.max(
    ...candidates.map(({ precedence }) => precedence),
  );
  const winningScope = candidates.filter(
    ({ precedence }) => precedence === maxPrecedence,
  );
  const deepestOwner = Math.min(
    ...winningScope.map(({ ownerDepth }) => ownerDepth),
  );
  const winners = removeOverridden(
    winningScope.filter(({ ownerDepth }) => ownerDepth === deepestOwner),
  );
  if (winners.length !== 1) {
    return {
      type: "conflict",
      commandIds: [...new Set(winners.map(({ command }) => command.id))].sort(),
      preventDefault: false,
    };
  }

  const winner = winners[0];
  if (!winner) return { type: "none" };
  return {
    type: "command",
    command: winner.command,
    shortcut: winner.shortcut,
    availability: winner.availability,
    preventDefault: winner.availability.state === "enabled",
  };
};

export const createShortcutContext = (options: {
  platform: CommandPlatform;
  runtime: CommandRuntime;
  activeView?: string | null;
  focus?: CommandContextSnapshot["focus"];
  overlays?: CommandContextSnapshot["overlays"];
  singleKeyShortcutsEnabled?: boolean;
  busyCommands?: ReadonlySet<string>;
}): CommandContextSnapshot => ({
  windowKind: "main",
  platform: options.platform,
  runtime: options.runtime,
  activeView: options.activeView ?? null,
  focus: options.focus ?? { kind: "document", ownerPath: [] },
  overlays: options.overlays ?? [],
  singleKeyShortcutsEnabled: options.singleKeyShortcutsEnabled ?? false,
  busyCommands: options.busyCommands ?? new Set(),
});
