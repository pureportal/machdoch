import "@xterm/xterm/css/xterm.css";
import {
  CircleDot,
  ChevronDown,
  ChevronUp,
  Eraser,
  ExternalLink,
  ListFilter,
  LoaderCircle,
  Play,
  Plus,
  RotateCw,
  Square,
  TerminalSquare,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type JSX,
} from "react";
import { Button } from "../components/ui/button";
import { useOptionalRegisterCommands } from "../commands/command-context";
import {
  asPaletteCommands,
  type CommandDefinition,
} from "../commands/command-types";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { EmptyState } from "../components/ui/empty-state";
import { cn } from "../lib/utils";
import { openWorkspaceTerminalHost } from "../runtime";
import {
  getWorkspaceTerminalStore,
  type WorkspaceTerminalStore,
  type WorkspaceTerminalSessionView,
  type WorkspaceTerminalStatus,
} from "./workspace-terminal-store";

const terminalStatusLabel = (status: WorkspaceTerminalStatus): string => {
  switch (status) {
    case "loading":
      return "Loading";
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "exited":
      return "Exited";
    case "error":
      return "Unavailable";
  }
};

const TerminalStatusDot = ({
  terminal,
}: {
  terminal: WorkspaceTerminalSessionView;
}): JSX.Element => (
  <span
    role="status"
    aria-label={`${terminal.label}: ${terminalStatusLabel(terminal.status)}`}
    title={terminalStatusLabel(terminal.status)}
    className={cn(
      "size-1.5 shrink-0 rounded-full",
      terminal.status === "running"
        ? "bg-emerald-400"
        : terminal.status === "starting" || terminal.status === "loading"
          ? "animate-pulse bg-sky-400"
          : terminal.status === "error"
            ? "bg-red-400"
            : "bg-slate-600",
    )}
  />
);

const WorkspaceTerminalViewport = ({
  store,
  terminal,
  active,
}: {
  store: WorkspaceTerminalStore;
  terminal: WorkspaceTerminalSessionView;
  active: boolean;
}): JSX.Element => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    store.mountTerminal(terminal.id, container);
    return () => store.unmountTerminal(terminal.id);
  }, [store, terminal.id]);

  return (
    <div
      data-command-focus="terminal"
      role="tabpanel"
      aria-label={terminal.label}
      hidden={!active}
      ref={containerRef}
      className="h-full w-full overflow-hidden px-2 py-1.5 [&_.xterm]:h-full [&_.xterm-viewport]:!overflow-y-auto"
      onMouseDown={() => store.fitActiveTerminal(true)}
    />
  );
};

export const WorkspaceTerminal = ({
  workspaceRoot,
  open,
  onToggle,
}: {
  workspaceRoot: string;
  open: boolean;
  onToggle: () => void;
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
  const terminalAreaRef = useRef<HTMLDivElement | null>(null);
  const activeTerminal =
    snapshot.terminals.find(
      (terminal) => terminal.id === snapshot.activeTerminalId,
    ) ?? null;
  const error = activeTerminal?.error ?? snapshot.discoveryError;

  useEffect(() => {
    void store.initialize();
  }, [store]);

  useEffect(() => {
    const area = terminalAreaRef.current;
    if (!area) return;
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (!open) return;
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        store.fitActiveTerminal(false);
      });
    });
    observer.observe(area);
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [open, store]);

  useEffect(() => {
    if (!open || !snapshot.activeTerminalId) return;
    const frame = window.requestAnimationFrame(() =>
      store.fitActiveTerminal(true),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [open, snapshot.activeTerminalId, store]);

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

  const terminalCommandStateRef = useRef({
    snapshot,
    activeTerminal,
    store,
    closeTerminal,
    openExternalTerminal,
  });
  terminalCommandStateRef.current = {
    snapshot,
    activeTerminal,
    store,
    closeTerminal,
    openExternalTerminal,
  };
  const terminalCommands = useMemo<readonly CommandDefinition[]>(() => {
    const scope = {
      kind: "view" as const,
      ownerId: "workspaces",
      viewId: "workspaces",
    };
    const state = () => terminalCommandStateRef.current;
    return asPaletteCommands([
      {
        id: "workspaces.terminal.select",
        title: "Select workspace terminal",
        group: "Workspace terminal",
        scope,
        availability: () =>
          state().snapshot.terminals.length
            ? { state: "enabled" }
            : { state: "hidden" },
        children: () => ({
          id: "workspaces.terminal.select.page",
          title: "Select workspace terminal",
          searchPlaceholder: "Search terminals",
          groups: [
            {
              id: "terminals",
              items: state().snapshot.terminals.map((terminal) => ({
                id: terminal.id,
                title: terminal.label,
                keywords: [
                  terminal.title ?? "",
                  terminalStatusLabel(terminal.status),
                ],
                current: terminal.id === state().snapshot.activeTerminalId,
                execute: () => state().store.selectTerminal(terminal.id),
              })),
            },
          ],
        }),
      },
      {
        id: "workspaces.terminal.new",
        title: "New workspace terminal",
        group: "Workspace terminal",
        scope,
        availability: () =>
          (state().snapshot.profiles?.visibleShells.length ?? 0) > 0
            ? { state: "enabled" }
            : { state: "disabled", reason: "No shells are available." },
        children: () => ({
          id: "workspaces.terminal.new.page",
          title: "New workspace terminal",
          searchPlaceholder: "Search shells",
          groups: [
            {
              id: "shells",
              items: (state().snapshot.profiles?.visibleShells ?? []).map(
                (shell) => ({
                  id: shell.id,
                  title: shell.label,
                  execute: () => void state().store.createTerminal(shell.id),
                }),
              ),
            },
          ],
        }),
      },
      {
        id: "workspaces.terminal.start",
        title: "Start or restart workspace terminal",
        group: "Workspace terminal",
        scope,
        availability: () =>
          !state().activeTerminal
            ? { state: "hidden" }
            : state().activeTerminal?.transitioning
              ? { state: "disabled", reason: "Terminal is starting." }
              : { state: "enabled" },
        execute: () => void state().store.startActiveTerminal(),
      },
      {
        id: "workspaces.terminal.stop",
        title: "Stop workspace terminal",
        group: "Workspace terminal",
        scope,
        availability: () => {
          const terminal = state().activeTerminal;
          if (!terminal) return { state: "hidden" };
          return terminal.sessionActive || terminal.status === "starting"
            ? { state: "enabled" }
            : { state: "disabled", reason: "Terminal is not running." };
        },
        execute: () => void state().store.stopActiveTerminal(),
      },
      {
        id: "workspaces.terminal.clear",
        title: "Clear workspace terminal",
        group: "Workspace terminal",
        scope,
        availability: () =>
          state().activeTerminal ? { state: "enabled" } : { state: "hidden" },
        execute: () => state().store.clearActiveTerminal(),
      },
      {
        id: "workspaces.terminal.close",
        title: "Close workspace terminal",
        group: "Workspace terminal",
        scope,
        availability: () =>
          state().snapshot.terminals.length
            ? { state: "enabled" }
            : { state: "hidden" },
        children: () => ({
          id: "workspaces.terminal.close.page",
          title: "Close workspace terminal",
          searchPlaceholder: "Search terminals",
          groups: [
            {
              id: "terminals",
              items: state().snapshot.terminals.map((terminal) => ({
                id: terminal.id,
                title: terminal.label,
                keywords: [
                  terminal.title ?? "",
                  terminalStatusLabel(terminal.status),
                ],
                current: terminal.id === state().snapshot.activeTerminalId,
                execute: () => state().closeTerminal(terminal),
              })),
            },
          ],
        }),
      },
      {
        id: "workspaces.terminal.open-external",
        title: "Open workspace in external terminal",
        group: "Workspace terminal",
        scope,
        availability: () =>
          state().snapshot.discovery?.externalTerminal
            ? { state: "enabled" }
            : { state: "hidden" },
        execute: () => state().openExternalTerminal(),
      },
    ]);
  }, []);
  useOptionalRegisterCommands(terminalCommands);

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#050910]">
      <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-slate-800/80 px-2.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex min-w-0 shrink-0 items-center gap-2 rounded-md px-1.5 py-1 text-xs font-medium text-slate-300 outline-none hover:bg-slate-900 focus-visible:ring-1 focus-visible:ring-sky-400"
        >
          <TerminalSquare className="size-3.5 text-sky-400" />
          Terminal
          {open ? (
            <ChevronDown className="size-3 text-slate-600" />
          ) : (
            <ChevronUp className="size-3 text-slate-600" />
          )}
        </button>

        <div
          role="tablist"
          aria-label="Workspace terminals"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1 [scrollbar-width:none]"
        >
          {snapshot.terminals.map((terminal) => {
            const active = terminal.id === snapshot.activeTerminalId;
            return (
              <div
                key={terminal.id}
                className={cn(
                  "group flex h-7 max-w-48 shrink-0 items-center rounded-md border",
                  active
                    ? "border-slate-700 bg-slate-900 text-slate-200"
                    : "border-transparent text-slate-500 hover:bg-slate-900/60 hover:text-slate-300",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title={terminal.title ?? terminal.label}
                  onClick={() => store.selectTerminal(terminal.id)}
                  className="flex min-w-0 items-center gap-1.5 py-1 pl-2 text-[11px] outline-none focus-visible:text-sky-300"
                >
                  <TerminalStatusDot terminal={terminal} />
                  <span className="truncate">{terminal.label}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Close ${terminal.label}`}
                  onClick={() => closeTerminal(terminal)}
                  className={cn(
                    "mx-1 grid size-4 shrink-0 place-items-center rounded-sm text-slate-600 outline-none hover:bg-slate-800 hover:text-slate-300 focus-visible:ring-1 focus-visible:ring-sky-400",
                    !active &&
                      "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
                  )}
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
        </div>

        {snapshot.profiles?.availableShells.length ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7 shrink-0"
                aria-label="New terminal"
              >
                <Plus className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              {snapshot.profiles.visibleShells.map((shell) => (
                <DropdownMenuItem
                  key={shell.id}
                  onSelect={() => void store.createTerminal(shell.id)}
                >
                  <TerminalSquare className="size-3.5" />
                  {shell.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <ListFilter className="size-3.5" />
                  Profiles
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-48">
                  {snapshot.profiles.availableShells.map((shell) => {
                    const visible = snapshot.profiles?.visibleShells.some(
                      (candidate) => candidate.id === shell.id,
                    );
                    return (
                      <DropdownMenuCheckboxItem
                        key={shell.id}
                        checked={visible}
                        disabled={
                          visible &&
                          snapshot.profiles?.visibleShells.length === 1
                        }
                        onSelect={(event) => event.preventDefault()}
                        onCheckedChange={(checked) => {
                          if (typeof checked === "boolean") {
                            void store.setShellVisibility(shell.id, checked);
                          }
                        }}
                      >
                        {shell.label}
                      </DropdownMenuCheckboxItem>
                    );
                  })}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <CircleDot className="size-3.5" />
                  Default
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-48">
                  <DropdownMenuRadioGroup
                    value={snapshot.profiles.defaultShellId ?? undefined}
                    onValueChange={(shellId) => {
                      void store.setDefaultShell(shellId);
                    }}
                  >
                    {snapshot.profiles.visibleShells.map((shell) => (
                      <DropdownMenuRadioItem key={shell.id} value={shell.id}>
                        {shell.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : snapshot.discovery === null && !snapshot.discoveryError ? (
          <LoaderCircle className="mx-1 size-3.5 animate-spin text-slate-600" />
        ) : null}

        {snapshot.discovery?.externalTerminal ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 shrink-0"
            aria-label={`Open in ${snapshot.discovery.externalTerminal.label}`}
            onClick={openExternalTerminal}
          >
            <ExternalLink className="size-3.5" />
          </Button>
        ) : null}

        {activeTerminal ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 shrink-0 px-2 text-[11px]"
              disabled={activeTerminal.transitioning}
              onClick={() => void store.startActiveTerminal()}
            >
              {activeTerminal.transitioning ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : activeTerminal.sessionActive ? (
                <RotateCw className="size-3.5" />
              ) : (
                <Play className="size-3.5" />
              )}
              {activeTerminal.transitioning
                ? "Starting"
                : activeTerminal.sessionActive
                  ? "Restart"
                  : "Start"}
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 shrink-0"
              aria-label="Clear terminal"
              onClick={() => store.clearActiveTerminal()}
            >
              <Eraser className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 shrink-0"
              aria-label="Stop terminal"
              disabled={
                !activeTerminal.sessionActive &&
                activeTerminal.status !== "starting"
              }
              onClick={() => void store.stopActiveTerminal()}
            >
              <Square className="size-3 fill-current" />
            </Button>
          </>
        ) : null}
      </header>

      {error && open ? (
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
        ref={terminalAreaRef}
        className={cn("relative min-h-0 flex-1", !open && "hidden")}
      >
        {snapshot.discovery && snapshot.discovery.shells.length === 0 ? (
          <div className="grid h-full place-items-center p-4">
            <EmptyState
              icon={TerminalSquare}
              title="No shells available"
              size="compact"
            />
          </div>
        ) : snapshot.discovery && snapshot.terminals.length === 0 ? (
          <div className="grid h-full place-items-center p-4">
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
              active={terminal.id === snapshot.activeTerminalId}
            />
          ))
        )}
      </div>
    </section>
  );
};
