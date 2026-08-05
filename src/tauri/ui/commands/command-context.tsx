import { isTauri } from "@tauri-apps/api/core";
import * as React from "react";
import { CommandPalette } from "./command-palette";
import { CommandRegistry, type CommandRegistration } from "./command-registry";
import { commandOverlayStore } from "./command-overlay-store";
import { getDefaultCommandShortcut } from "./command-defaults";
import {
  getActiveFocusSnapshot,
  getElementFocusSnapshot,
  getFocusSnapshot,
} from "./focus";
import {
  getCommandAvailability,
  isCommandScopeActive,
  resolveShortcut,
} from "./shortcut-resolver";
import {
  formatShortcut,
  shortcutApplies,
  shortcutToAriaKeyShortcuts,
} from "./shortcut";
import type {
  CommandAction,
  CommandContextSnapshot,
  CommandDefinition,
  CommandPage,
  CommandPageItem,
  CommandPlatform,
  CommandPresentation,
  CommandRuntime,
  ShortcutSpec,
} from "./command-types";

interface AnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface CommandSurfaceState {
  open: boolean;
  presentation: CommandPresentation;
  pages: readonly CommandPage[];
  anchor: AnchorRect | null;
}

export interface OpenCommandPageOptions {
  presentation?: CommandPresentation;
  anchor?: Element | DOMRect | null;
}

interface CommandContextValue {
  registry: CommandRegistry;
  platform: CommandPlatform;
  runtime: CommandRuntime;
  getContextSnapshot: (event?: Event) => CommandContextSnapshot;
  executeCommand: (
    command: CommandDefinition,
    fromPalette: boolean,
    context?: CommandContextSnapshot,
  ) => Promise<void>;
  executePageItem: (item: CommandPageItem) => Promise<void>;
  openPage: (page: CommandPage, options?: OpenCommandPageOptions) => void;
  closePalette: () => void;
}

const CommandContext = React.createContext<CommandContextValue | null>(null);
const EMPTY_REGISTRY_SNAPSHOT = {
  commands: [],
  duplicateIds: new Set<string>(),
  invalidIds: new Map<string, string>(),
  revision: 0,
} as const;
const EMPTY_COMMANDS: readonly CommandDefinition[] = [];

export interface CommandProviderProps {
  activeView: string | null;
  children: React.ReactNode;
  commands?: readonly CommandDefinition[];
  windowKind?: CommandContextSnapshot["windowKind"];
  platform?: CommandPlatform;
  runtime?: CommandRuntime;
}

export const detectCommandPlatform = (): CommandPlatform => {
  if (typeof navigator === "undefined") return "linux";
  const platform = navigator.platform || navigator.userAgent;
  if (/mac|iphone|ipad|ipod/i.test(platform)) return "macos";
  if (/win/i.test(platform)) return "windows";
  return "linux";
};

const toAnchorRect = (
  anchor: Element | DOMRect | null | undefined,
): AnchorRect | null => {
  if (!anchor) return null;
  const rect =
    anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
};

const CLOSED_SURFACE: CommandSurfaceState = {
  open: false,
  presentation: "dialog",
  pages: [],
  anchor: null,
};

const useRegistryCommands = (
  registry: CommandRegistry | null,
  commands: readonly CommandDefinition[],
): void => {
  const registrationRef = React.useRef<CommandRegistration | null>(null);
  const commandsRef = React.useRef(commands);
  commandsRef.current = commands;
  React.useLayoutEffect(() => {
    if (!registry) {
      registrationRef.current = null;
      return;
    }
    const registration = registry.register(commandsRef.current);
    registrationRef.current = registration;
    return () => {
      if (registrationRef.current === registration) {
        registrationRef.current = null;
      }
      registration();
    };
  }, [registry]);
  React.useLayoutEffect(() => {
    registrationRef.current?.update(commands);
  }, [commands]);
};

export const CommandProvider = ({
  activeView,
  children,
  commands = EMPTY_COMMANDS,
  windowKind = "main",
  platform: platformProp,
  runtime: runtimeProp,
}: CommandProviderProps): React.JSX.Element => {
  const [registry] = React.useState(() => new CommandRegistry());
  const registrySnapshot = React.useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
  );
  const overlaySnapshot = React.useSyncExternalStore(
    commandOverlayStore.subscribe,
    commandOverlayStore.getSnapshot,
  );
  const platform = platformProp ?? detectCommandPlatform();
  const runtime = runtimeProp ?? (isTauri() ? "tauri" : "browser");
  const [surface, setSurface] =
    React.useState<CommandSurfaceState>(CLOSED_SURFACE);
  const surfaceRef = React.useRef(surface);
  surfaceRef.current = surface;
  const [busyCommands, setBusyCommands] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const busyCommandsRef = React.useRef(busyCommands);
  busyCommandsRef.current = busyCommands;
  const [paletteError, setPaletteError] = React.useState<string | null>(null);
  const activeViewRef = React.useRef(activeView);
  activeViewRef.current = activeView;
  const invokerRef = React.useRef<HTMLElement | null>(null);
  const invocationFocusRef = React.useRef<CommandContextSnapshot["focus"]>({
    kind: "document",
    ownerPath: [],
  });
  const surfaceRevisionRef = React.useRef(0);
  const activeControllersRef = React.useRef(
    new Map<string, { controller: AbortController; fromPalette: boolean }>(),
  );
  const duplicateSignature = [...registrySnapshot.duplicateIds]
    .sort()
    .join("\u0000");
  React.useEffect(() => {
    if (duplicateSignature) {
      console.error(
        `Duplicate command IDs were disabled: ${duplicateSignature.split("\u0000").join(", ")}`,
      );
    }
  }, [duplicateSignature]);
  const invalidSignature = [...registrySnapshot.invalidIds]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, reason]) => `${id}: ${reason}`)
    .join("\u0000");
  React.useEffect(() => {
    if (invalidSignature) {
      console.error(
        `Invalid commands were disabled: ${invalidSignature.split("\u0000").join(", ")}`,
      );
    }
  }, [invalidSignature]);

  const getContextSnapshot = React.useCallback(
    (event?: Event): CommandContextSnapshot => ({
      windowKind,
      platform,
      runtime,
      activeView: activeViewRef.current,
      focus: event ? getFocusSnapshot(event) : getActiveFocusSnapshot(),
      overlays: commandOverlayStore.getSnapshot(),
      singleKeyShortcutsEnabled: false,
      busyCommands: busyCommandsRef.current,
    }),
    [platform, runtime, windowKind],
  );

  const closePalette = React.useCallback(() => {
    surfaceRevisionRef.current += 1;
    for (const {
      controller,
      fromPalette,
    } of activeControllersRef.current.values()) {
      if (fromPalette) controller.abort();
    }
    setSurface(CLOSED_SURFACE);
    setPaletteError(null);
    window.requestAnimationFrame(() => {
      if (commandOverlayStore.getSnapshot().length === 0) {
        const fallback = document.querySelector<HTMLElement>(
          "button[aria-current='page']",
        );
        const invoker = invokerRef.current;
        const invokerUnavailable =
          !invoker?.isConnected ||
          invoker.matches(":disabled, [hidden], [inert]") ||
          invoker.closest("[hidden], [inert], [aria-hidden='true']") !== null ||
          ["hidden", "collapse"].includes(
            window.getComputedStyle(invoker).visibility,
          ) ||
          window.getComputedStyle(invoker).display === "none";
        const target = invokerUnavailable ? fallback : invoker;
        target?.focus({ preventScroll: true });
      }
      invokerRef.current = null;
    });
  }, []);

  const openPage = React.useCallback(
    (page: CommandPage, options: OpenCommandPageOptions = {}) => {
      surfaceRevisionRef.current += 1;
      const activeElement = document.activeElement;
      invokerRef.current =
        activeElement instanceof HTMLElement ? activeElement : null;
      invocationFocusRef.current =
        options.anchor instanceof Element
          ? getElementFocusSnapshot(options.anchor)
          : getActiveFocusSnapshot();
      setPaletteError(null);
      setSurface({
        open: true,
        presentation: options.presentation ?? "dialog",
        pages: [page],
        anchor: toAnchorRect(options.anchor),
      });
    },
    [],
  );

  const openRootPalette = React.useCallback(
    (invocationFocus: CommandContextSnapshot["focus"]) => {
      if (surfaceRef.current.open) {
        closePalette();
        return;
      }
      surfaceRevisionRef.current += 1;
      const activeElement = document.activeElement;
      invokerRef.current =
        activeElement instanceof HTMLElement ? activeElement : null;
      invocationFocusRef.current = invocationFocus;
      setPaletteError(null);
      setSurface({
        open: true,
        presentation: "dialog",
        pages: [],
        anchor: null,
      });
    },
    [closePalette],
  );

  const pushPage = React.useCallback((page: CommandPage) => {
    surfaceRevisionRef.current += 1;
    setSurface((current) => ({
      ...current,
      open: true,
      pages: [...current.pages, page],
    }));
  }, []);

  const popPage = React.useCallback(() => {
    surfaceRevisionRef.current += 1;
    setPaletteError(null);
    setSurface((current) => ({
      ...current,
      pages: current.pages.slice(0, -1),
    }));
  }, []);

  const executeAction = React.useCallback(
    async (
      id: string,
      action: CommandAction | undefined,
      childrenFactory: CommandDefinition["children"] | undefined,
      fromPalette: boolean,
      executionContext?: CommandContextSnapshot,
    ): Promise<void> => {
      if (busyCommandsRef.current.has(id)) return;
      const nextBusy = new Set(busyCommandsRef.current);
      nextBusy.add(id);
      busyCommandsRef.current = nextBusy;
      setBusyCommands(nextBusy);
      setPaletteError(null);
      const controller = new AbortController();
      const context = executionContext ?? getContextSnapshot();
      if (childrenFactory) {
        surfaceRevisionRef.current += 1;
        if (!surfaceRef.current.open) {
          const activeElement = document.activeElement;
          invokerRef.current =
            activeElement instanceof HTMLElement ? activeElement : null;
          invocationFocusRef.current = context.focus;
        }
      }
      const startingRevision = surfaceRevisionRef.current;
      const startingView = activeViewRef.current;
      activeControllersRef.current.set(id, { controller, fromPalette });
      try {
        if (childrenFactory) {
          const page = await childrenFactory(context, controller.signal);
          if (
            !controller.signal.aborted &&
            startingRevision === surfaceRevisionRef.current &&
            startingView === activeViewRef.current
          ) {
            pushPage(page);
          }
          return;
        }
        const result = await action?.(context, controller.signal);
        if (
          controller.signal.aborted ||
          (fromPalette && startingRevision !== surfaceRevisionRef.current)
        ) {
          return;
        }
        if (result?.type === "push-page") {
          if (
            startingRevision !== surfaceRevisionRef.current ||
            startingView !== activeViewRef.current
          ) {
            return;
          }
          pushPage(result.page);
        } else if (
          fromPalette &&
          result?.type !== "stay-open" &&
          result?.type !== "cancelled"
        ) {
          closePalette();
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        if (fromPalette || surfaceRef.current.open) setPaletteError(message);
        else console.error(`Command ${id} failed`, error);
      } finally {
        activeControllersRef.current.delete(id);
        const remaining = new Set(busyCommandsRef.current);
        remaining.delete(id);
        busyCommandsRef.current = remaining;
        setBusyCommands(remaining);
      }
    },
    [closePalette, getContextSnapshot, pushPage],
  );

  const executeCommand = React.useCallback(
    async (
      command: CommandDefinition,
      fromPalette: boolean,
      executionContext?: CommandContextSnapshot,
    ) => {
      const context = executionContext ?? getContextSnapshot();
      const availability = getCommandAvailability(command, context);
      if (
        !isCommandScopeActive(command, context) ||
        (command.when && !command.when(context)) ||
        availability.state !== "enabled"
      ) {
        if (fromPalette && availability.state === "disabled") {
          setPaletteError(availability.reason);
        }
        return;
      }
      const topOverlay = context.overlays[context.overlays.length - 1];
      if (
        command.overlayPolicy === "replace-non-modal" &&
        topOverlay?.kind === "non-modal"
      ) {
        try {
          if (!(await commandOverlayStore.dismissTopNonModal())) return;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (fromPalette) setPaletteError(message);
          else
            console.error(
              `Command ${command.id} could not dismiss overlay`,
              error,
            );
          return;
        }
      }
      await executeAction(
        command.id,
        command.execute,
        command.children,
        fromPalette,
        context,
      );
    },
    [executeAction, getContextSnapshot],
  );

  const executePageItem = React.useCallback(
    (item: CommandPageItem) => {
      if (item.availability?.state === "disabled") {
        setPaletteError(item.availability.reason);
        return Promise.resolve();
      }
      if (item.availability?.state === "hidden") return Promise.resolve();
      return executeAction(`page:${item.id}`, item.execute, undefined, true, {
        ...getContextSnapshot(),
        focus: invocationFocusRef.current,
      });
    },
    [executeAction, getContextSnapshot],
  );

  const paletteCommand = React.useMemo<CommandDefinition>(
    () => ({
      id: "app.palette.toggle",
      title: "Open command palette",
      group: "Navigation",
      scope: { kind: "global", ownerId: "app" },
      shortcuts: [{ chord: getDefaultCommandShortcut("app.palette.toggle") }],
      palette: "hidden",
      overlayPolicy: "replace-non-modal",
      execute: (context) => {
        openRootPalette(context.focus);
        return { type: "stay-open" };
      },
    }),
    [openRootPalette],
  );
  const providerCommands = React.useMemo(
    () => [paletteCommand, ...commands],
    [commands, paletteCommand],
  );
  useRegistryCommands(registry, providerCommands);

  const previousActiveViewRef = React.useRef(activeView);
  React.useLayoutEffect(() => {
    if (previousActiveViewRef.current !== activeView) {
      previousActiveViewRef.current = activeView;
      if (surfaceRef.current.open) closePalette();
    }
  }, [activeView, closePalette]);

  const paletteContext = {
    ...getContextSnapshot(),
    overlays: overlaySnapshot,
    focus: invocationFocusRef.current,
  };
  const executePaletteCommand = React.useCallback(
    (command: CommandDefinition, fromPalette: boolean) =>
      executeCommand(command, fromPalette, {
        ...getContextSnapshot(),
        focus: invocationFocusRef.current,
      }),
    [executeCommand, getContextSnapshot],
  );

  React.useEffect(() => {
    let composing = false;
    const onCompositionStart = (): void => {
      composing = true;
    };
    const onCompositionEnd = (): void => {
      composing = false;
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || composing || event.isComposing) return;
      const context = getContextSnapshot(event);
      const resolution = resolveShortcut(
        event,
        registry.getSnapshot().commands,
        context,
      );
      if (resolution.type === "conflict") {
        console.error(
          `Keyboard shortcut conflict: ${resolution.commandIds.join(", ")}`,
        );
        return;
      }
      if (
        resolution.type !== "command" ||
        resolution.availability.state !== "enabled"
      ) {
        return;
      }
      if (resolution.preventDefault) event.preventDefault();
      void executeCommand(resolution.command, false, context);
    };
    document.addEventListener("compositionstart", onCompositionStart);
    document.addEventListener("compositionend", onCompositionEnd);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("compositionstart", onCompositionStart);
      document.removeEventListener("compositionend", onCompositionEnd);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [executeCommand, getContextSnapshot, registry]);

  React.useEffect(
    () => () => {
      for (const { controller } of activeControllersRef.current.values()) {
        controller.abort();
      }
      activeControllersRef.current.clear();
    },
    [],
  );

  const value = React.useMemo<CommandContextValue>(
    () => ({
      registry,
      platform,
      runtime,
      getContextSnapshot,
      executeCommand,
      executePageItem,
      openPage,
      closePalette,
    }),
    [
      closePalette,
      executeCommand,
      executePageItem,
      getContextSnapshot,
      openPage,
      platform,
      registry,
      runtime,
    ],
  );

  return (
    <CommandContext.Provider value={value}>
      {children}
      <CommandPalette
        open={surface.open}
        presentation={surface.presentation}
        pages={surface.pages}
        anchor={surface.anchor}
        error={paletteError}
        context={paletteContext}
        registry={registry}
        onExecuteCommand={executePaletteCommand}
        onExecutePageItem={executePageItem}
        onClose={closePalette}
        onPopPage={popPage}
      />
    </CommandContext.Provider>
  );
};

const useCommandContext = (): CommandContextValue => {
  const context = React.useContext(CommandContext);
  if (!context) throw new Error("Command hooks require CommandProvider");
  return context;
};

export const useRegisterCommands = (
  commands: readonly CommandDefinition[],
): void => {
  const { registry } = useCommandContext();
  useRegistryCommands(registry, commands);
};

export const useOptionalRegisterCommands = (
  commands: readonly CommandDefinition[],
): void => {
  const context = React.useContext(CommandContext);
  useRegistryCommands(context?.registry ?? null, commands);
};

export const useCommandPageLauncher = (): CommandContextValue["openPage"] =>
  useCommandContext().openPage;

export const useOptionalCommandPageLauncher = ():
  | CommandContextValue["openPage"]
  | null => React.useContext(CommandContext)?.openPage ?? null;

export interface CommandShortcutHint {
  label: string;
  ariaKeyShortcuts: string;
  spec: ShortcutSpec;
}

export const useCommandShortcut = (id: string): CommandShortcutHint | null => {
  const { registry, platform, runtime } = useCommandContext();
  React.useSyncExternalStore(registry.subscribe, registry.getSnapshot);
  const command = registry.find(id);
  const spec = command?.shortcuts?.find((candidate) =>
    shortcutApplies(candidate, platform, runtime),
  );
  return spec
    ? {
        label: formatShortcut(spec, platform),
        ariaKeyShortcuts: shortcutToAriaKeyShortcuts(spec, platform),
        spec,
      }
    : null;
};

export const useOptionalCommandShortcut = (
  id: string,
): CommandShortcutHint | null => {
  const context = React.useContext(CommandContext);
  const emptySubscribe = React.useCallback(() => () => undefined, []);
  const emptySnapshot = React.useCallback(() => EMPTY_REGISTRY_SNAPSHOT, []);
  React.useSyncExternalStore(
    context?.registry.subscribe ?? emptySubscribe,
    context?.registry.getSnapshot ?? emptySnapshot,
  );
  if (!context) return null;
  const command = context.registry.find(id);
  const spec = command?.shortcuts?.find((candidate) =>
    shortcutApplies(candidate, context.platform, context.runtime),
  );
  return spec
    ? {
        label: formatShortcut(spec, context.platform),
        ariaKeyShortcuts: shortcutToAriaKeyShortcuts(spec, context.platform),
        spec,
      }
    : null;
};
