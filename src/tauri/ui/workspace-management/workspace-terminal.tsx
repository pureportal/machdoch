import "@xterm/xterm/css/xterm.css";
import {
  ChevronDown,
  ChevronUp,
  Eraser,
  ExternalLink,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { EmptyState } from "../components/ui/empty-state";
import { cn } from "../lib/utils";
import { openWorkspaceTerminalHost } from "../runtime";
import {
  getWorkspaceTerminalStore,
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
    const observer = new ResizeObserver(() => {
      if (!open) return;
      window.requestAnimationFrame(() => store.fitActiveTerminal(false));
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, [open, store]);

  useEffect(() => {
    if (!open || !snapshot.activeTerminalId) return;
    window.requestAnimationFrame(() => store.fitActiveTerminal(true));
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

        {snapshot.discovery?.shells.length ? (
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
              {snapshot.discovery.shells.map((shell) => (
                <DropdownMenuItem
                  key={shell.id}
                  onSelect={() => void store.createTerminal(shell.id)}
                >
                  <TerminalSquare className="size-3.5" />
                  {shell.label}
                </DropdownMenuItem>
              ))}
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
            onClick={() => {
              const external = snapshot.discovery?.externalTerminal;
              if (!external) return;
              void openWorkspaceTerminalHost(workspaceRoot, external.id).catch(
                (failure: unknown) => store.reportError(failure),
              );
            }}
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
            <div
              key={terminal.id}
              data-command-focus="terminal"
              role="tabpanel"
              aria-label={terminal.label}
              hidden={terminal.id !== snapshot.activeTerminalId}
              ref={(container) => {
                if (container) store.mountTerminal(terminal.id, container);
              }}
              className="h-full w-full overflow-hidden px-2 py-1.5 [&_.xterm]:h-full [&_.xterm-viewport]:!overflow-y-auto"
              onMouseDown={() => store.fitActiveTerminal(true)}
            />
          ))
        )}
      </div>
    </section>
  );
};
