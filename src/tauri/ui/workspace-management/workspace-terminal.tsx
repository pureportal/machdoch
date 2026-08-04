import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  ChevronDown,
  ChevronUp,
  Eraser,
  ExternalLink,
  LoaderCircle,
  Play,
  RotateCw,
  Square,
  TerminalSquare,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { cn } from "../lib/utils";
import {
  discoverWorkspaceShells,
  openWorkspaceTerminalHost,
  resizeWorkspaceTerminal,
  startWorkspaceTerminal,
  stopWorkspaceTerminal,
  writeWorkspaceTerminal,
  type WorkspaceShellDiscovery,
  type WorkspaceTerminalEvent,
} from "../runtime";

type TerminalStatus = "loading" | "starting" | "running" | "exited" | "error";

const decodeTerminalOutput = (value: string): Uint8Array => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const terminalStatusLabel = (status: TerminalStatus): string => {
  switch (status) {
    case "loading":
      return "Discovering";
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

export const WorkspaceTerminal = ({
  workspaceRoot,
  open,
  onToggle,
}: {
  workspaceRoot: string;
  open: boolean;
  onToggle: () => void;
}): JSX.Element => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const resizeTimerRef = useRef<number | null>(null);
  const autoStartedRef = useRef(false);
  const openRef = useRef(open);
  const mountedRef = useRef(true);
  const transitionPendingRef = useRef(false);
  const transitionIdRef = useRef(0);
  const [ready, setReady] = useState(false);
  const [discovery, setDiscovery] = useState<WorkspaceShellDiscovery | null>(
    null,
  );
  const [shellId, setShellId] = useState("");
  const [status, setStatus] = useState<TerminalStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [sessionActive, setSessionActive] = useState(false);
  const [transitioning, setTransitioning] = useState(false);

  openRef.current = open;

  const setTerminalError = (failure: unknown): void => {
    setError(failure instanceof Error ? failure.message : String(failure));
    setStatus("error");
  };

  useEffect(() => {
    mountedRef.current = true;
    transitionPendingRef.current = false;
    const container = containerRef.current;
    if (!container) return;
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      drawBoldTextInBrightColors: true,
      fontFamily:
        '"Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      minimumContrastRatio: 4.5,
      rightClickSelectsWord: true,
      screenReaderMode: true,
      scrollback: 5000,
      theme: {
        background: "#050910",
        foreground: "#cbd5e1",
        cursor: "#7dd3fc",
        cursorAccent: "#050910",
        selectionBackground: "#0c4a6e99",
        black: "#0f172a",
        red: "#f87171",
        green: "#86efac",
        yellow: "#fde68a",
        blue: "#7dd3fc",
        magenta: "#c4b5fd",
        cyan: "#67e8f9",
        white: "#e2e8f0",
        brightBlack: "#64748b",
        brightRed: "#fca5a5",
        brightGreen: "#bbf7d0",
        brightYellow: "#fef3c7",
        brightBlue: "#bae6fd",
        brightMagenta: "#ddd6fe",
        brightCyan: "#a5f3fc",
        brightWhite: "#f8fafc",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || !event.ctrlKey || !event.shiftKey) {
        return true;
      }
      if (event.key.toLowerCase() === "c" && terminal.hasSelection()) {
        void navigator.clipboard.writeText(terminal.getSelection());
        return false;
      }
      if (event.key.toLowerCase() === "v") {
        void navigator.clipboard
          .readText()
          .then((text) => terminal.paste(text))
          .catch(() => {});
        return false;
      }
      return true;
    });

    const inputDisposable = terminal.onData((data) => {
      const sessionId = sessionIdRef.current;
      const generation = generationRef.current;
      if (!sessionId) return;
      writeQueueRef.current = writeQueueRef.current
        .then(async () => {
          if (
            sessionIdRef.current === sessionId &&
            generationRef.current === generation
          ) {
            await writeWorkspaceTerminal(sessionId, data);
          }
        })
        .catch((failure: unknown) => {
          if (
            sessionIdRef.current === sessionId &&
            generationRef.current === generation
          ) {
            setTerminalError(failure);
          }
        });
    });

    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
      }
      resizeTimerRef.current = window.setTimeout(() => {
        const generation = generationRef.current;
        if (sessionIdRef.current !== sessionId) return;
        void resizeWorkspaceTerminal(sessionId, cols, rows).catch(
          (failure: unknown) => {
            if (
              sessionIdRef.current === sessionId &&
              generationRef.current === generation
            ) {
              setTerminalError(failure);
            }
          },
        );
      }, 80);
    });

    const observer = new ResizeObserver(() => {
      if (!openRef.current) return;
      window.requestAnimationFrame(() => {
        try {
          fitAddon.fit();
        } catch {
          // The pane may be between layout states; the next resize retries.
        }
      });
    });
    observer.observe(container);
    window.requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch {
        // Initial layout can finish after this frame; ResizeObserver retries.
      }
      setReady(true);
    });

    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      const sessionId = sessionIdRef.current;
      sessionIdRef.current = null;
      if (sessionId) void stopWorkspaceTerminal(sessionId).catch(() => {});
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
      }
      observer.disconnect();
      inputDisposable.dispose();
      resizeDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    let active = true;
    generationRef.current += 1;
    transitionIdRef.current += 1;
    transitionPendingRef.current = false;
    setTransitioning(false);
    const previousSession = sessionIdRef.current;
    sessionIdRef.current = null;
    setSessionActive(false);
    if (resizeTimerRef.current !== null) {
      window.clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = null;
    }
    if (previousSession) {
      void stopWorkspaceTerminal(previousSession).catch(() => {});
    }
    autoStartedRef.current = false;
    setDiscovery(null);
    setShellId("");
    setStatus("loading");
    setError(null);
    void discoverWorkspaceShells()
      .then((result) => {
        if (!active) return;
        setDiscovery(result);
        setShellId(result.defaultShellId ?? result.shells[0]?.id ?? "");
        setStatus(result.shells.length > 0 ? "exited" : "error");
      })
      .catch((failure: unknown) => {
        if (active) setTerminalError(failure);
      });
    return () => {
      active = false;
    };
  }, [workspaceRoot]);

  useEffect(() => {
    if (!open) return;
    window.requestAnimationFrame(() => {
      try {
        fitAddonRef.current?.fit();
        terminalRef.current?.focus();
      } catch {
        // ResizeObserver will retry after the pane becomes measurable.
      }
    });
  }, [open]);

  const startTerminal = useCallback(
    async (nextShellId = shellId): Promise<void> => {
      const terminal = terminalRef.current;
      const fitAddon = fitAddonRef.current;
      if (
        !terminal ||
        !fitAddon ||
        !nextShellId ||
        transitionPendingRef.current
      ) {
        return;
      }
      transitionPendingRef.current = true;
      const transitionId = ++transitionIdRef.current;
      setTransitioning(true);
      const generation = ++generationRef.current;
      const previousSession = sessionIdRef.current;
      sessionIdRef.current = null;
      setSessionActive(false);
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      setError(null);
      setStatus("starting");
      terminal.reset();
      if (previousSession) {
        await stopWorkspaceTerminal(previousSession).catch(() => {});
      }
      if (generationRef.current !== generation) {
        if (transitionIdRef.current === transitionId && mountedRef.current) {
          transitionPendingRef.current = false;
          setTransitioning(false);
        }
        return;
      }
      try {
        fitAddon.fit();
        let exitedBeforeStartResolved = false;
        let failedBeforeStartResolved = false;
        const handleEvent = (event: WorkspaceTerminalEvent): void => {
          if (generationRef.current !== generation) return;
          switch (event.type) {
            case "output":
              try {
                terminal.write(decodeTerminalOutput(event.data));
              } catch (failure) {
                failedBeforeStartResolved = true;
                setTerminalError(failure);
              }
              break;
            case "error":
              failedBeforeStartResolved = true;
              setError(event.message);
              setStatus("error");
              break;
            case "exit":
              exitedBeforeStartResolved = true;
              sessionIdRef.current = null;
              setSessionActive(false);
              setStatus("exited");
              terminal.write(
                `\r\n\x1b[90m[Process exited${
                  event.exitCode === null ? "" : ` with code ${event.exitCode}`
                }]\x1b[0m\r\n`,
              );
              break;
          }
        };
        const started = await startWorkspaceTerminal(
          workspaceRoot,
          nextShellId,
          Math.max(2, terminal.cols),
          Math.max(1, terminal.rows),
          handleEvent,
        );
        if (generationRef.current !== generation) {
          await stopWorkspaceTerminal(started.sessionId).catch(() => {});
          return;
        }
        if (!exitedBeforeStartResolved) {
          sessionIdRef.current = started.sessionId;
          setSessionActive(true);
          setStatus(failedBeforeStartResolved ? "error" : "running");
          terminal.focus();
        }
      } catch (failure) {
        if (generationRef.current === generation) setTerminalError(failure);
      } finally {
        if (transitionIdRef.current === transitionId && mountedRef.current) {
          transitionPendingRef.current = false;
          setTransitioning(false);
        }
      }
    },
    [shellId, workspaceRoot],
  );

  useEffect(() => {
    if (
      ready &&
      shellId &&
      discovery?.shells.length &&
      !autoStartedRef.current
    ) {
      autoStartedRef.current = true;
      void startTerminal(shellId);
    }
  }, [discovery?.shells.length, ready, shellId, startTerminal]);

  const stopTerminal = async (): Promise<void> => {
    generationRef.current += 1;
    transitionIdRef.current += 1;
    transitionPendingRef.current = false;
    setTransitioning(false);
    if (resizeTimerRef.current !== null) {
      window.clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = null;
    }
    const sessionId = sessionIdRef.current;
    sessionIdRef.current = null;
    setSessionActive(false);
    setStatus("exited");
    if (!sessionId) return;
    try {
      await stopWorkspaceTerminal(sessionId);
    } catch (failure) {
      setTerminalError(failure);
    }
  };

  const canStop = sessionActive || status === "starting";

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#050910]">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-slate-800/80 px-2.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-xs font-medium text-slate-300 outline-none hover:bg-slate-900 focus-visible:ring-1 focus-visible:ring-sky-400"
        >
          <TerminalSquare className="size-3.5 text-sky-400" />
          Terminal
          {open ? (
            <ChevronDown className="size-3 text-slate-600" />
          ) : (
            <ChevronUp className="size-3 text-slate-600" />
          )}
        </button>
        <span
          className={cn(
            "size-1.5 rounded-full",
            status === "running"
              ? "bg-emerald-400"
              : status === "starting" || status === "loading"
                ? "animate-pulse bg-sky-400"
                : status === "error"
                  ? "bg-red-400"
                  : "bg-slate-600",
          )}
          aria-hidden="true"
        />
        <span role="status" className="text-[10px] text-slate-600">
          {terminalStatusLabel(status)}
        </span>
        <div className="min-w-0 flex-1" />
        {discovery?.shells.length ? (
          <select
            value={shellId}
            aria-label="Terminal shell"
            disabled={status === "loading" || transitioning}
            className="h-7 max-w-40 rounded-md border border-slate-800 bg-slate-950 px-2 text-[11px] text-slate-300 outline-none focus:border-sky-500/60"
            onChange={(event) => {
              const nextShell = event.target.value;
              setShellId(nextShell);
              void startTerminal(nextShell);
            }}
          >
            {discovery.shells.map((shell) => (
              <option key={shell.id} value={shell.id}>
                {shell.label}
              </option>
            ))}
          </select>
        ) : null}
        {discovery?.externalTerminal ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={`Open in ${discovery.externalTerminal.label}`}
            onClick={() => {
              const external = discovery.externalTerminal;
              if (!external) return;
              void openWorkspaceTerminalHost(workspaceRoot, external.id).catch(
                (failure: unknown) => setTerminalError(failure),
              );
            }}
          >
            <ExternalLink className="size-3.5" />
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-[11px]"
          disabled={!shellId || transitioning}
          onClick={() => void startTerminal()}
        >
          {transitioning ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : sessionActive ? (
            <RotateCw className="size-3.5" />
          ) : (
            <Play className="size-3.5" />
          )}
          {status === "starting"
            ? "Starting"
            : sessionActive
              ? "Restart"
              : "Start"}
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Clear terminal"
          onClick={() => terminalRef.current?.clear()}
        >
          <Eraser className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Stop terminal"
          disabled={!canStop}
          onClick={() => void stopTerminal()}
        >
          <Square className="size-3 fill-current" />
        </Button>
      </header>

      {error && open ? (
        <button
          type="button"
          role="alert"
          className="shrink-0 border-b border-red-950 bg-red-950/25 px-3 py-1.5 text-left text-xs text-red-200"
          onClick={() => setError(null)}
        >
          {error}
        </button>
      ) : null}

      <div className={cn("min-h-0 flex-1", !open && "hidden")}>
        {discovery && discovery.shells.length === 0 ? (
          <div className="grid h-full place-items-center p-4">
            <EmptyState
              icon={TerminalSquare}
              title="No shells available"
              size="compact"
            />
          </div>
        ) : (
          <div
            ref={containerRef}
            className="h-full w-full overflow-hidden px-2 py-1.5 [&_.xterm]:h-full [&_.xterm-viewport]:!overflow-y-auto"
            onMouseDown={() => terminalRef.current?.focus()}
          />
        )}
      </div>
    </section>
  );
};
