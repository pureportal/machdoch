import { CheckIcon, ChevronLeftIcon, LoaderCircleIcon } from "lucide-react";
import * as React from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "../components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "../components/ui/popover";
import type { CommandRegistry } from "./command-registry";
import { rankCommandItems } from "./command-search";
import {
  getCommandAvailability,
  isCommandScopeActive,
} from "./shortcut-resolver";
import {
  formatShortcut,
  shortcutApplies,
  shortcutToAriaKeyShortcuts,
} from "./shortcut";
import type {
  CommandAvailability,
  CommandContextSnapshot,
  CommandDefinition,
  CommandPage,
  CommandPageItem,
  CommandPresentation,
} from "./command-types";

interface AnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CommandPaletteProps {
  open: boolean;
  presentation: CommandPresentation;
  pages: readonly CommandPage[];
  anchor: AnchorRect | null;
  error: string | null;
  context: CommandContextSnapshot;
  registry: CommandRegistry;
  onExecuteCommand: (
    command: CommandDefinition,
    fromPalette: boolean,
  ) => Promise<void>;
  onExecutePageItem: (item: CommandPageItem) => Promise<void>;
  onClose: () => void;
  onPopPage: () => void;
}

interface PaletteItem {
  id: string;
  title: string;
  group: string;
  keywords?: readonly string[];
  order?: number;
  current?: boolean;
  numericKey?: string;
  availability: CommandAvailability;
  shortcut?: string;
  ariaShortcut?: string;
  busy: boolean;
  execute: () => Promise<void>;
}

interface PaletteFrameState {
  search: string;
  selected: string;
}

const EMPTY_FRAME_STATE: PaletteFrameState = {
  search: "",
  selected: "",
};

const rootItems = (
  commands: readonly CommandDefinition[],
  context: CommandContextSnapshot,
  execute: CommandPaletteProps["onExecuteCommand"],
): readonly PaletteItem[] =>
  commands.flatMap((command) => {
    if (command.palette !== "visible") return [];
    if (!isCommandScopeActive(command, context)) return [];
    if (command.when && !command.when(context)) return [];
    const availability = getCommandAvailability(command, context);
    if (availability.state === "hidden") return [];
    const shortcut = command.shortcuts?.find((candidate) =>
      shortcutApplies(candidate, context.platform, context.runtime),
    );
    return [
      {
        id: command.id,
        title: command.title,
        group: command.group,
        keywords: command.keywords,
        order: command.order,
        current: command.current?.(context),
        availability,
        shortcut: shortcut
          ? formatShortcut(shortcut, context.platform)
          : undefined,
        ariaShortcut: shortcut
          ? shortcutToAriaKeyShortcuts(shortcut, context.platform)
          : undefined,
        busy: context.busyCommands.has(command.id),
        execute: () => execute(command, true),
      },
    ];
  });

const pageItems = (
  page: CommandPage,
  context: CommandContextSnapshot,
  execute: CommandPaletteProps["onExecutePageItem"],
): readonly PaletteItem[] =>
  page.groups.flatMap((group) =>
    group.items.flatMap((item) => {
      const busy = context.busyCommands.has(`page:${item.id}`);
      const availability = busy
        ? { state: "disabled" as const, reason: "Command is already running" }
        : (item.availability ?? { state: "enabled" as const });
      if (availability.state === "hidden") return [];
      return [
        {
          id: item.id,
          title: item.title,
          group: group.label ?? group.id,
          keywords: item.keywords,
          current: item.current,
          numericKey: item.numericKey,
          availability,
          shortcut: item.numericKey,
          ariaShortcut: item.numericKey,
          busy,
          execute: () => execute(item),
        },
      ];
    }),
  );

const PaletteBody = ({
  pages,
  error,
  context,
  registry,
  onExecuteCommand,
  onExecutePageItem,
  onPopPage,
}: Omit<
  CommandPaletteProps,
  "open" | "presentation" | "anchor"
>): React.JSX.Element => {
  const registrySnapshot = React.useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
  );
  const page = pages[pages.length - 1];
  const frameKey =
    pages.length === 0 ? "root" : pages.map(({ id }) => id).join("\u001f");
  const [frameStates, setFrameStates] = React.useState<
    Readonly<Record<string, PaletteFrameState>>
  >({});
  const frameState = frameStates[frameKey] ?? EMPTY_FRAME_STATE;
  const search = frameState.search;
  const selected = frameState.selected;
  const listRef = React.useRef<React.ElementRef<typeof CommandList>>(null);
  const scrollPositionsRef = React.useRef(new Map<string, number>());
  const setSearch = React.useCallback(
    (value: string) => {
      setFrameStates((current) => ({
        ...current,
        [frameKey]: {
          ...(current[frameKey] ?? EMPTY_FRAME_STATE),
          search: value,
        },
      }));
    },
    [frameKey],
  );
  const setSelected = React.useCallback(
    (value: string) => {
      setFrameStates((current) => ({
        ...current,
        [frameKey]: {
          ...(current[frameKey] ?? EMPTY_FRAME_STATE),
          selected: value,
        },
      }));
    },
    [frameKey],
  );
  React.useLayoutEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = scrollPositionsRef.current.get(frameKey) ?? 0;
    }
  }, [frameKey]);
  const items = React.useMemo(
    () =>
      page
        ? pageItems(page, context, onExecutePageItem)
        : rootItems(registrySnapshot.commands, context, onExecuteCommand),
    [
      context,
      onExecuteCommand,
      onExecutePageItem,
      page,
      registrySnapshot.commands,
    ],
  );
  const visibleItems = React.useMemo(
    () => rankCommandItems(items, search),
    [items, search],
  );
  const firstEnabled = visibleItems.find(
    ({ availability }) => availability.state === "enabled",
  );
  React.useEffect(() => {
    if (
      !visibleItems.some(
        (item) => item.id === selected && item.availability.state === "enabled",
      )
    ) {
      setSelected(firstEnabled?.id ?? "");
    }
  }, [firstEnabled?.id, selected, visibleItems]);

  const grouped = visibleItems.reduce<Map<string, PaletteItem[]>>(
    (groups, item) => {
      const group = groups.get(item.group) ?? [];
      group.push(item);
      groups.set(item.group, group);
      return groups;
    },
    new Map(),
  );
  const title = page?.title ?? "Commands";

  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      return;
    }
    if (
      (event.key === "Home" || event.key === "End") &&
      event.target instanceof HTMLInputElement &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      const input = event.target;
      const selectionStart = input.selectionStart ?? 0;
      const selectionEnd = input.selectionEnd ?? selectionStart;
      if (!event.shiftKey) {
        const caret = event.key === "Home" ? 0 : input.value.length;
        input.setSelectionRange(caret, caret);
        return;
      }
      const anchor =
        input.selectionDirection === "backward" ? selectionEnd : selectionStart;
      const focus = event.key === "Home" ? 0 : input.value.length;
      input.setSelectionRange(
        Math.min(anchor, focus),
        Math.max(anchor, focus),
        focus < anchor ? "backward" : "forward",
      );
      return;
    }
    if (event.key === "Escape" && page) {
      event.preventDefault();
      event.stopPropagation();
      onPopPage();
      return;
    }
    if (event.key === "Backspace" && page && search.length === 0) {
      event.preventDefault();
      onPopPage();
      return;
    }
    if (
      page?.numericSelection &&
      search.length === 0 &&
      !event.repeat &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.getModifierState("AltGraph") &&
      /^[0-9]$/.test(event.key)
    ) {
      const item = visibleItems.find(
        (candidate) =>
          candidate.numericKey === event.key &&
          candidate.availability.state === "enabled",
      );
      if (item) {
        event.preventDefault();
        void item.execute();
      }
    }
  };

  return (
    <Command
      label={title}
      shouldFilter={false}
      vimBindings={false}
      value={selected}
      onValueChange={setSelected}
      onKeyDown={handleKeyDown}
      data-command-owner="command-palette"
    >
      {page ? (
        <div className="flex h-10 items-center border-b border-slate-200 px-2 dark:border-slate-800">
          <button
            type="button"
            className="grid size-8 place-items-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 dark:hover:bg-slate-800 dark:hover:text-white"
            onClick={onPopPage}
            aria-label="Back to commands"
          >
            <ChevronLeftIcon className="size-4" />
          </button>
          <span className="truncate text-sm font-medium">{title}</span>
        </div>
      ) : null}
      <CommandInput
        autoFocus
        value={search}
        onValueChange={setSearch}
        placeholder={page?.searchPlaceholder ?? "Search commands…"}
        aria-label={page?.searchPlaceholder ?? "Search commands"}
      />
      <CommandList
        ref={listRef}
        onScroll={(event) =>
          scrollPositionsRef.current.set(
            frameKey,
            event.currentTarget.scrollTop,
          )
        }
      >
        <CommandEmpty>{page ? "No matches" : "No commands found"}</CommandEmpty>
        {[...grouped].map(([group, groupItems]) => (
          <CommandGroup key={group} heading={group}>
            {groupItems.map((item) => (
              <CommandItem
                key={item.id}
                value={item.id}
                keywords={item.keywords ? [...item.keywords] : undefined}
                disabled={item.availability.state !== "enabled"}
                aria-keyshortcuts={item.ariaShortcut}
                onSelect={() => void item.execute()}
                title={
                  item.availability.state === "disabled"
                    ? item.availability.reason
                    : undefined
                }
              >
                {item.busy ? (
                  <LoaderCircleIcon
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : item.current ? (
                  <CheckIcon className="size-4" aria-hidden="true" />
                ) : (
                  <span className="size-4" aria-hidden="true" />
                )}
                <span className="truncate">{item.title}</span>
                {item.current ? <span className="sr-only">Current</span> : null}
                {item.availability.state === "disabled" ? (
                  <span className="ml-auto max-w-48 truncate text-xs text-slate-500 dark:text-slate-400">
                    {item.availability.reason}
                  </span>
                ) : item.shortcut ? (
                  <CommandShortcut aria-hidden="true">
                    {item.shortcut}
                  </CommandShortcut>
                ) : null}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
      {error ? (
        <div
          className="border-t border-red-900/60 px-3 py-2 text-sm text-red-400"
          role="alert"
        >
          {error}
        </div>
      ) : null}
    </Command>
  );
};

export const CommandPalette = (
  props: CommandPaletteProps,
): React.JSX.Element => {
  const body = (
    <PaletteBody
      pages={props.pages}
      error={props.error}
      context={props.context}
      registry={props.registry}
      onExecuteCommand={props.onExecuteCommand}
      onExecutePageItem={props.onExecutePageItem}
      onClose={props.onClose}
      onPopPage={props.onPopPage}
    />
  );
  const title = props.pages[props.pages.length - 1]?.title ?? "Commands";
  if (props.presentation === "popover") {
    const anchor = props.anchor ?? { left: 24, top: 24, width: 0, height: 0 };
    return (
      <Popover
        open={props.open}
        onOpenChange={(open) => !open && props.onClose()}
        commandOverlayId="command-palette"
        commandOverlayAllowGlobalCommands={["app.palette.toggle"]}
      >
        <PopoverAnchor asChild>
          <span
            aria-hidden="true"
            className="pointer-events-none fixed"
            style={{
              left: anchor.left,
              top: anchor.top,
              width: anchor.width,
              height: anchor.height,
            }}
          />
        </PopoverAnchor>
        <PopoverContent
          align="start"
          side="bottom"
          className="w-[min(26rem,calc(100vw-2rem))] overflow-hidden p-0"
          aria-label={title}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            if (event.isComposing || event.keyCode === 229) {
              event.preventDefault();
              return;
            }
            if (props.pages.length > 0) {
              event.preventDefault();
              props.onPopPage();
            }
          }}
        >
          {body}
        </PopoverContent>
      </Popover>
    );
  }
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      commandOverlayId="command-palette"
      commandOverlayAllowGlobalCommands={["app.palette.toggle"]}
    >
      <DialogContent
        showCloseButton={false}
        className="overflow-hidden p-0 sm:max-w-xl"
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          if (event.isComposing || event.keyCode === 229) {
            event.preventDefault();
            return;
          }
          if (props.pages.length > 0) {
            event.preventDefault();
            props.onPopPage();
          }
        }}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {body}
      </DialogContent>
    </Dialog>
  );
};
