import { ContextActionMenu } from "@machdoch/media-studio/tauri/ui/components/ui/context-action-menu.js";
import { copyText } from "@machdoch/media-studio/tauri/ui/lib/clipboard.js";
import "@xterm/xterm/css/xterm.css";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  ClipboardPaste,
  Columns2,
  Copy,
  Eraser,
  ExternalLink,
  LoaderCircle,
  MessageSquarePlus,
  MoreHorizontal,
  PanelBottom,
  PanelRight,
  Play,
  RotateCw,
  Search,
  Square,
  SquareArrowOutUpRight,
  SquareTerminal,
  TerminalSquare,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
} from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { EmptyState } from "@machdoch/media-studio/tauri/ui/components/ui/empty-state.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@machdoch/client-ui/dropdown-menu";
import { openWorkspaceTerminalHost } from "../runtime";
import { useWorkspaceDock, workspaceDockStore } from "./workspace-dock-store";
import {
  DEFAULT_TERMINAL_LAYOUT,
  type TerminalDock,
} from "./workspace-terminal-layout";
import { WorkspaceTerminalNewMenu } from "./workspace-terminal-new-menu";
import { WorkspaceTerminalPalette } from "./workspace-terminal-palette";
import { WorkspaceTerminalSearch } from "./workspace-terminal-search";
import {
  getWorkspaceTerminalStore,
  type WorkspaceTerminalSessionView,
  type WorkspaceTerminalStore,
} from "./workspace-terminal-store";
import {
  WorkspaceTerminalTabs,
  type TerminalTabActions,
} from "./workspace-terminal-tabs";
import { useWorkspaceTerminalCommands } from "./use-workspace-terminal-commands";
import { openWorkspaceToolWindow } from "./workspace-tools-runtime";

export interface WorkspaceTerminalChatBridge {
  addText: (text: string) => void;
}

const SCROLLBACK_OPTIONS = [1_000, 10_000, 50_000, 100_000] as const;

const WorkspaceTerminalViewport = ({
  store,
  terminal,
  visible,
  focused,
  chat,
}: {
  store: WorkspaceTerminalStore;
  terminal: WorkspaceTerminalSessionView;
  visible: boolean;
  focused: boolean;
  chat?: WorkspaceTerminalChatBridge;
}): JSX.Element => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    store.mountTerminal(terminal.id, container);
    return () => store.unmountTerminal(terminal.id);
  }, [store, terminal.id]);

  return (
    <ContextActionMenu
      label="Terminal actions"
      preserveEditing={false}
      actions={() => {
        const selection = store.getTerminalSelection(terminal.id);
        const output = chat ? store.lastCommandOutput(terminal.id) : null;
        return [
          {
            label: "Copy selection",
            icon: Copy,
            disabled: !selection,
            onSelect: () => copyText(selection),
          },
          {
            label: "Paste",
            icon: ClipboardPaste,
            onSelect: () => store.pasteToTerminal(terminal.id),
          },
          ...(chat
            ? [
                {
                  label: "Send selection to chat",
                  icon: MessageSquarePlus,
                  disabled: !selection,
                  onSelect: () => chat.addText(selection),
                },
                {
                  label: "Send last output to chat",
                  icon: MessageSquarePlus,
                  disabled: !output,
                  onSelect: () => {
                    if (output) chat.addText(output);
                  },
                },
              ]
            : []),
        ];
      }}
    >
      <div
        data-command-focus="terminal"
        role="tabpanel"
        aria-label={terminal.label}
        hidden={!visible}
        className={cn(
          "h-full min-h-0 min-w-0 flex-1 px-2 py-1.5",
          focused && "ring-1 ring-inset ring-slate-800",
        )}
        onMouseDown={(event) => {
          if (event.button !== 0) return;
          store.selectTerminal(terminal.id);
          store.fitTerminal(terminal.id, true);
        }}
      >
        <div
          ref={containerRef}
          className="h-full w-full overflow-hidden [&_.xterm]:h-full [&_.xterm-viewport]:!overflow-y-auto [&_.xterm-viewport]:!bg-transparent"
        />
      </div>
    </ContextActionMenu>
  );
};

export const WorkspaceTerminalPanel = ({
  workspaceRoot,
  chat,
  standalone = false,
  onClose,
}: {
  workspaceRoot: string;
  chat?: WorkspaceTerminalChatBridge;
  standalone?: boolean;
  onClose?: () => void;
}): JSX.Element => {
  const store = useMemo(
    () => getWorkspaceTerminalStore(workspaceRoot),
    [workspaceRoot],
  );
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const dock = useWorkspaceDock(workspaceRoot);
  const layout = dock?.terminal ?? DEFAULT_TERMINAL_LAYOUT;
  const [searching, setSearching] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const areaRef = useRef<HTMLDivElement | null>(null);
  const activeTerminal =
    snapshot.terminals.find(
      (terminal) => terminal.id === snapshot.activeTerminalId,
    ) ?? null;
  const splitTerminal =
    layout.split && layout.split.tabId !== snapshot.activeTerminalId
      ? (snapshot.terminals.find(
          (terminal) => terminal.id === layout.split?.tabId,
        ) ?? null)
      : null;
  const visibleIds = [activeTerminal?.id, splitTerminal?.id].filter(Boolean);
  const error = activeTerminal?.error ?? snapshot.discoveryError;

  useEffect(() => {
    void store.initialize();
  }, [store]);

  const visibleKey = visibleIds.join("|");
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    let frame: number | null = null;
    const fit = (focus: boolean) => {
      for (const id of visibleKey.split("|")) {
        if (id)
          store.fitTerminal(
            id,
            focus && id === store.getSnapshot().activeTerminalId,
          );
      }
    };
    const observer = new ResizeObserver(() => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        fit(false);
      });
    });
    observer.observe(area);
    frame = window.requestAnimationFrame(() => {
      frame = null;
      fit(true);
    });
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [store, visibleKey, layout.split?.direction]);

  const closeTerminal = (terminal: WorkspaceTerminalSessionView): void => {
    if (
      (terminal.sessionActive || terminal.status === "starting") &&
      !window.confirm(
        `Close ${terminal.label}? Its running process will be terminated.`,
      )
    ) {
      return;
    }
    void store.closeTerminal(terminal.id);
  };

  const openExternalTerminal = (): void => {
    const external = snapshot.discovery?.externalTerminal;
    if (!external) return;
    void openWorkspaceTerminalHost(workspaceRoot, external.id).catch(
      (failure: unknown) => store.reportError(failure),
    );
  };

  const setDock = (value: TerminalDock): void => {
    if (value === "window") {
      void openWorkspaceToolWindow(workspaceRoot, "terminal")
        .then(() =>
          workspaceDockStore.updateLayout(workspaceRoot, (current) => ({
            ...current,
            terminalOpen: false,
          })),
        )
        .catch((failure: unknown) => store.reportError(failure));
      return;
    }
    workspaceDockStore.updateTerminal(workspaceRoot, (current) => ({
      ...current,
      dock: value,
    }));
  };

  const tabActions: TerminalTabActions = {
    select: (terminalId) => store.selectTerminal(terminalId),
    rename: (terminalId, name) => store.renameTerminal(terminalId, name),
    color: (terminalId, color) => store.colorTerminal(terminalId, color),
    split: (terminalId, direction) => {
      if (terminalId === snapshot.activeTerminalId) {
        void store.splitActiveTerminal(direction);
      } else {
        workspaceDockStore.updateTerminal(workspaceRoot, (current) => ({
          ...current,
          split: { tabId: terminalId, direction },
        }));
      }
    },
    close: closeTerminal,
  };

  useWorkspaceTerminalCommands({
    store,
    snapshot,
    activeTerminal,
    chat,
    closeTerminal,
    openExternalTerminal,
    openSearch: () => setSearching(true),
    openPalette: () => setPaletteOpen(true),
  });

  const activeId = activeTerminal?.id ?? null;

  return (
    <section
      aria-label="Terminal"
      className="flex h-full min-h-0 flex-col bg-[#050910]"
      onKeyDown={(event) => {
        const mod = event.ctrlKey || event.metaKey;
        if (mod && event.shiftKey && event.key.toLowerCase() === "f") {
          event.preventDefault();
          setSearching(true);
        } else if (mod && event.key === "ArrowUp" && activeId) {
          event.preventDefault();
          store.jumpToCommand(activeId, "previous");
        } else if (mod && event.key === "ArrowDown" && activeId) {
          event.preventDefault();
          store.jumpToCommand(activeId, "next");
        }
      }}
    >
      <header className="flex min-h-10 shrink-0 items-center gap-1 border-b border-slate-800/80 px-2">
        <SquareTerminal className="mx-1 size-3.5 shrink-0 text-sky-400" />
        <WorkspaceTerminalTabs
          terminals={snapshot.terminals}
          layout={layout}
          activeTerminalId={snapshot.activeTerminalId}
          actions={tabActions}
        />
        {snapshot.profiles?.availableShells.length ? (
          <WorkspaceTerminalNewMenu
            store={store}
            profiles={snapshot.profiles}
          />
        ) : snapshot.discovery === null && !snapshot.discoveryError ? (
          <LoaderCircle className="mx-1 size-3.5 animate-spin text-slate-600" />
        ) : null}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7 shrink-0"
          aria-label="Find"
          tooltip="Find"
          disabled={!activeId}
          onClick={() => setSearching((value) => !value)}
        >
          <Search className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7 shrink-0"
          aria-label="Run command"
          tooltip="Run command"
          disabled={!activeId}
          onClick={() => setPaletteOpen(true)}
        >
          <Play className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7 shrink-0"
          aria-label={splitTerminal ? "Unsplit" : "Split"}
          tooltip={splitTerminal ? "Unsplit" : "Split"}
          disabled={!activeId}
          onClick={() =>
            splitTerminal
              ? store.unsplit()
              : void store.splitActiveTerminal("vertical")
          }
        >
          <Columns2 className="size-3.5" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 shrink-0"
              aria-label="More terminal actions"
              tooltip="More"
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            {activeTerminal ? (
              <>
                <DropdownMenuItem
                  disabled={!activeTerminal.hasCommands}
                  onSelect={() => store.rerunLastCommand(activeTerminal.id)}
                >
                  <RotateCw className="size-3.5" />
                  Rerun last command
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!activeTerminal.hasCommands}
                  onSelect={() =>
                    store.jumpToCommand(activeTerminal.id, "previous")
                  }
                >
                  <ArrowUpToLine className="size-3.5" />
                  Previous command
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!activeTerminal.hasCommands}
                  onSelect={() =>
                    store.jumpToCommand(activeTerminal.id, "next")
                  }
                >
                  <ArrowDownToLine className="size-3.5" />
                  Next command
                </DropdownMenuItem>
                {chat ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => {
                        const selection = store.getTerminalSelection(
                          activeTerminal.id,
                        );
                        if (selection) chat.addText(selection);
                        else
                          store.reportError(
                            new Error("Select terminal text first."),
                          );
                      }}
                    >
                      <MessageSquarePlus className="size-3.5" />
                      Send selection to chat
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!activeTerminal.hasCommands}
                      onSelect={() => {
                        const output = store.lastCommandOutput(
                          activeTerminal.id,
                        );
                        if (output) chat.addText(output);
                        else
                          store.reportError(
                            new Error("The last command printed no output."),
                          );
                      }}
                    >
                      <MessageSquarePlus className="size-3.5" />
                      Send last output to chat
                    </DropdownMenuItem>
                  </>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={activeTerminal.transitioning}
                  onSelect={() => void store.startActiveTerminal()}
                >
                  {activeTerminal.sessionActive ? (
                    <RotateCw className="size-3.5" />
                  ) : (
                    <Play className="size-3.5" />
                  )}
                  {activeTerminal.sessionActive ? "Restart" : "Start"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={
                    !activeTerminal.sessionActive &&
                    activeTerminal.status !== "starting"
                  }
                  onSelect={() => void store.stopActiveTerminal()}
                >
                  <Square className="size-3.5" />
                  Stop
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => store.clearActiveTerminal()}>
                  <Eraser className="size-3.5" />
                  Clear
                </DropdownMenuItem>
              </>
            ) : null}
            {snapshot.discovery?.externalTerminal ? (
              <DropdownMenuItem onSelect={openExternalTerminal}>
                <ExternalLink className="size-3.5" />
                Open in {snapshot.discovery.externalTerminal.label}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <TerminalSquare className="size-3.5" />
                Scrollback
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={String(layout.scrollbackLines)}
                  onValueChange={(value) =>
                    store.setScrollbackLines(Number(value))
                  }
                >
                  {SCROLLBACK_OPTIONS.map((lines) => (
                    <DropdownMenuRadioItem key={lines} value={String(lines)}>
                      {lines.toLocaleString()} lines
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {!standalone ? (
              <>
                <DropdownMenuItem onSelect={() => setDock("bottom")}>
                  <PanelBottom className="size-3.5" />
                  Dock at bottom
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDock("side")}>
                  <PanelRight className="size-3.5" />
                  Dock at side
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDock("window")}>
                  <SquareArrowOutUpRight className="size-3.5" />
                  Open in new window
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        {onClose ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 shrink-0"
            aria-label="Close terminal panel"
            tooltip="Close"
            onClick={onClose}
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
      </header>

      {searching && activeId ? (
        <WorkspaceTerminalSearch
          key={activeId}
          search={store.searchTerminal(activeId)}
          onClose={() => {
            setSearching(false);
            store.fitTerminal(activeId, true);
          }}
        />
      ) : null}

      {error ? (
        <button
          type="button"
          role="alert"
          className="shrink-0 border-b border-red-950 bg-red-950/25 px-3 py-1.5 text-left text-xs text-red-200"
          onClick={() => store.dismissActiveError()}
        >
          {error}
        </button>
      ) : null}

      <div
        ref={areaRef}
        className={cn(
          "relative flex min-h-0 flex-1",
          layout.split?.direction === "horizontal" ? "flex-col" : "flex-row",
        )}
      >
        {snapshot.discovery && snapshot.discovery.shells.length === 0 ? (
          <div className="grid h-full w-full place-items-center p-4">
            <EmptyState
              icon={TerminalSquare}
              title="No shells available"
              size="compact"
            />
          </div>
        ) : snapshot.discovery && snapshot.terminals.length === 0 ? (
          <div className="grid h-full w-full place-items-center p-4">
            <EmptyState
              icon={TerminalSquare}
              title="No terminals"
              size="compact"
            />
          </div>
        ) : (
          snapshot.terminals.map((terminal) => (
            <WorkspaceTerminalViewport
              key={terminal.id}
              store={store}
              terminal={terminal}
              visible={visibleIds.includes(terminal.id)}
              focused={splitTerminal !== null && terminal.id === activeId}
              chat={chat}
            />
          ))
        )}
      </div>

      <WorkspaceTerminalPalette
        workspaceRoot={workspaceRoot}
        open={paletteOpen}
        history={dock?.commandHistory ?? []}
        onOpenChange={setPaletteOpen}
        onRunCommand={(command) => {
          if (activeId) store.runCommand(activeId, command);
        }}
        onRunConfiguration={(run, runSnapshot) =>
          void store.runConfiguration(run, runSnapshot.inputs)
        }
      />
    </section>
  );
};
